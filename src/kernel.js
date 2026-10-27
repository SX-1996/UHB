'use strict';
// ── kernel.js（UHB）—— 透传直通 + 健康守护，**不做协议转换** ────────────────
// 定位：坐在 magpie 之后。进来的已经是 OpenAI chat/completions 或 responses，
// 因此这里只做「字节外科手术 + 流量守护」，绝不做 Anthropic⇄OpenAI 翻译。
//
// 流水线（顺序固定，零决策）：
//   ① 入口协议必须等于上游协议（否则明确 400，绝不猜）
//   ② 读体（超限 413）
//   ③ 配额闸（429 窗口内本地拒绝，0 字节上传）
//   ④ 大 body 熔断闸（502 + retry-after，本地拒绝）
//   ⑤ 体积感知准入（small8 / mid2 / large1 + 前缀亲和排队）
//   ⑥ 字节外科手术：model 别名、max_tokens 地板/天花板
//   ⑦ 图片入口裁剪（超阈值图才压，压过恒定）
//   ⑧ 上行体两份轮转 + 四针/断崖存证
//   ⑨ 转发（新 TCP；体积分级重试 + 0-token 探活 + 502 熔断）
//   ⑩ usage 归一
const http = require('node:http');
const { Quota, Archive, Suspect, Metrics } = require('./modules/runtime');
const byteops = require('./modules/byteops');
const images = require('./modules/images');
const oa = require('./protocols/openai-lite');
const { Router, protoOfPath } = require('./router');
const { resolvePath } = require('./config');
const { Admission, prefixHash } = require('./admission');
const { RetryGuard } = require('./retry-guard');

const VERSION = 'uhb/1.0.0';

function ceilingFor(route, model) {
  const lim = (route.limits && route.limits.maxTokens) || {};
  const m = String(model || '').toLowerCase();
  for (const [needle, v] of Object.entries(lim.ceilings || {})) {
    if (needle && m.includes(String(needle).toLowerCase()) && Number(v) > 0) return Number(v);
  }
  return Number(lim.ceilingDefault || 131072);
}

function createUhb(cfg, opts) {
  const o = opts || {};
  const log = o.log || ((...a) => { if (!o.quiet) console.log(new Date().toISOString(), ...a); });
  const metrics = new Metrics(VERSION);
  const router = new Router(cfg, { pinFile: o.pinFile || null });

  const routeState = new Map();
  for (const r of cfg.routes) {
    const lim = r.limits || {};
    routeState.set(r.id, {
      route: r,
      quota: new Quota(Object.assign({}, r.quota || {}, {
        stateFile: resolvePath(cfg, (r.quota && r.quota.stateFile), '_quota-' + r.id + '.json'),
      })),
      archive: new Archive(Object.assign({}, r.archive || {}, {
        main: resolvePath(cfg, (r.archive && r.archive.main), '_lastmain.req.json'),
        prev: resolvePath(cfg, (r.archive && r.archive.prev), '_prev.req.json'),
      })),
      suspect: new Suspect(Object.assign({}, r.suspect || {}, {
        evidenceDir: resolvePath(cfg, (r.suspect && r.suspect.evidenceDir), '.evidence'),
      })),
      admission: new Admission({
        log,
        midBytes: Number(r.midBodyBytes || 204800),
        largeBytes: Number(r.largeBodyBytes || 1048576),
        slots: { small: Number(r.slotsSmall || 8), mid: Number(r.slotsMid || 2), large: Number(r.slotsLarge || 1) },
        slotMaxWaitMs: Number(r.slotMaxWaitMs || 300000),
      }),
      guard: new RetryGuard({
        log,
        bySize: r.retryBySize !== false,
        probe: r.retryProbe !== false,
        breaker: r.breaker502 !== false,
        probeUrl: String(r.upstream.url || '').replace(/\/+$/, '') + '/v1/models',
        largeBytes: Number(r.largeBodyBytes || 1048576),
        midBytes: Number(r.midBodyBytes || 204800),
        smallAttempts: Number(r.retryLimit || 6),
        midAttempts: Number(r.midAttempts || 3),
        largeAttempts: Number(r.largeAttempts || 1),
        breakerMs: Number(r.breakerMs || 60000),
        escalateMs: Number(r.breakerEscalateMs || 600000),
        escalateAfter: Number(r.breakerEscalateAfter || 3),
      }),
      inflight: 0,
    });
  }

  function sessionIdOf(req) {
    const h = req.headers['x-session-id'] || req.headers['x-conversation-id'];
    return h ? String(h) : null;
  }

  const server = http.createServer((req, res) => {
    const pathOnly = String(req.url || '/').split('?')[0];
    if (req.method === 'GET' && (pathOnly === '/__stats' || pathOnly === '/healthz')) {
      const per = {};
      for (const [id, st] of routeState) {
        per[id] = { quota: st.quota.snapshot(), admission: st.admission.snapshot(), guard: st.guard.snapshot(), inflight: st.inflight };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Object.assign(metrics.snapshot(), { routes: router.describe(), per }), null, 2));
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'UHB 只代理 POST；GET /__stats 看指标' } }));
      return;
    }

    const chunks = [];
    let size = 0, oversize = false;
    const maxMB = Number((cfg.defaults && cfg.defaults.maxBodyMB) || 64);
    req.on('data', (c) => {
      size += c.length;
      if (size > maxMB * 1024 * 1024) {
        if (!oversize) { oversize = true; metrics.tooLarge++; }
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (oversize) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'request body exceeds ' + maxMB + 'MB', type: 'request_too_large' } }));
        return;
      }
      handle(req, res, Buffer.concat(chunks)).catch((e) => {
        metrics.errors++;
        log('[err] ' + (e && e.message));
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'uhb error: ' + (e && e.message) } }));
        } else { try { res.end(); } catch { } }
      });
    });
    req.on('error', () => { metrics.errors++; });
  });

  async function handle(req, res, buf) {
    const inProto = protoOfPath(req.url);
    if (!inProto) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unsupported path: ' + req.url } }));
      return;
    }
    let body = null;
    try { body = JSON.parse(buf.toString('utf8')); } catch { body = null; }

    const harness = req.headers['x-harness'] ? String(req.headers['x-harness']) : null;
    const picked = router.resolve({ harness, inProto, sessionId: sessionIdOf(req), path: req.url });
    if (picked.error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'route not resolved: ' + picked.error, type: 'invalid_request_error' } }));
      return;
    }
    const route = picked.route;
    const st = routeState.get(route.id);
    metrics.hit(route.id);

    // ① UHB 不做协议转换：入口协议必须与上游一致
    if (route.inProto !== route.upProto) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'UHB 不做协议转换：' + route.inProto + ' → ' + route.upProto + '（翻译请交给 magpie）', type: 'invalid_request_error' } }));
      return;
    }

    // ③ 429 配额闸
    if (st.quota.active()) {
      st.quota.rejected++;
      const raS = Math.max(1, Math.ceil(st.quota.remainMs() / 1000));
      log('[quota] 本地拒绝 ' + route.id + '（还有 ' + raS + 's）');
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(raS) });
      res.end(JSON.stringify({ error: { message: 'quota window: retry in ' + raS + 's (local reject, nothing sent)', type: 'rate_limit_error', retry_after: raS } }));
      return;
    }

    // ④ 大 body 熔断闸
    if (st.guard.blocked(buf.length)) {
      st.guard.stats.rejectedLarge++;
      const raS = st.guard.retryAfterS();
      log('[guard] 大 body 熔断中（还有 ' + raS + 's）→ 本地拒绝 ' + Math.round(buf.length / 1024) + 'KB');
      res.writeHead(502, { 'content-type': 'application/json', 'retry-after': String(raS) });
      res.end(JSON.stringify({ error: { message: 'large-body breaker active: retry in ' + raS + 's (local reject, nothing sent)', type: 'upstream_error', retry_after: raS } }));
      return;
    }

    // ⑤ 体积感知准入（前缀亲和）
    const adm = await st.admission.acquire(buf.length, prefixHash(buf));
    if (!adm.ok) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({ error: { message: 'UHB busy（' + adm.tier + ' 档排队超时）', type: 'rate_limit_error', retry_after: 5 } }));
      return;
    }
    res.on('close', () => adm.release());
    st.inflight = st.admission.running.small + st.admission.running.mid + st.admission.running.large;

    const tr = route.transforms || [];
    const has = (t) => tr.includes(t);
    let outBuf = buf;
    const model = body && typeof body.model === 'string' ? body.model : '(unknown)';

    // ⑥ 字节外科手术
    if (body && has('model:alias')) {
      const alias = (route.models && route.models.alias) || {};
      const cur = body.model;
      if (alias[cur] && alias[cur] !== cur) {
        const r = byteops.replaceTopLevelString(outBuf, 'model', alias[cur]);
        if (r.changed) { outBuf = r.buf; body.model = alias[cur]; log('[alias] ' + cur + ' → ' + alias[cur]); }
      }
    }
    if (body && has('maxTokens:floor')) {
      const lim = (route.limits && route.limits.maxTokens) || {};
      const floor = Number(lim.floor || 131072);
      const ceil = ceilingFor(route, body.model);
      const cur = byteops.readTopLevelNumber(outBuf, 'max_tokens');
      if (cur !== null) {
        const want = (cur <= 0 || cur < floor) ? Math.min(floor, ceil) : (cur > ceil ? ceil : cur);
        if (want !== cur) {
          const r = byteops.replaceTopLevelNumber(outBuf, 'max_tokens', want);
          if (r.changed) { outBuf = r.buf; body.max_tokens = want; log('[maxtok] ' + cur + ' → ' + want + '（floor ' + floor + ', ceil ' + ceil + '）'); }
        }
      }
    }

    // ⑦ 图片入口裁剪
    if (body && has('images:clip') && Array.isArray(body.messages)) {
      const r = await images.clipImages(outBuf, body, { on: true, maxBytes: Number((route.images && route.images.maxKB) || 800) * 1024, maxDim: Number((route.images && route.images.maxDim) || 1568), quality: Number((route.images && route.images.quality) || 82) });
      if (r.changed) { outBuf = r.buf; log('[img] 裁剪 ' + r.count + ' 张，省 ' + r.savedKB + 'KB → ' + outBuf.length + 'B'); }
      else if (r.error) log('[img] ' + r.error + ' → 原样');
    }

    // ⑧ 取证 + 四针
    if (has('archive:rotate')) st.archive.write(outBuf);
    if (has('diagnose:4p')) {
      const d = st.suspect.check(body ? (body.model || model) : model, outBuf, new Date().toISOString());
      if (d.suspect) log('[SUSPECT] 失配 ' + d.lost + 'B（首异@' + d.firstDiff + '）→ 证据包已落盘');
    }

    // ⑨ 转发
    const upstreamUrl = oa.joinUpstream(route.upstream.url, req.url);
    const headers = oa.buildHeaders(req.headers, route);
    headers['content-type'] = 'application/json';
    headers['content-length'] = Buffer.byteLength(outBuf);
    const mod = oa.requestModule(upstreamUrl);
    const retryLimit = Number(route.retryLimit || (cfg.defaults && cfg.defaults.retryLimit) || 6);
    const retry429Limit = Number(route.retry429Limit || 2);
    const backoffMax = Number(route.backoffMaxMs || 12000);
    const upIdle = Number(route.upIdleMs || 300000);

    let attempt = 0;
    const send = () => {
      attempt++;
      const preq = mod.request(upstreamUrl, { method: 'POST', headers, agent: false }, (pres) => {
        const status = pres.statusCode || 0;
        const retryable = status === 429 || status === 408 || status >= 500;
        const rawLimit = status === 429 ? retry429Limit : retryLimit;
        const decision = st.guard.decide(outBuf.length, attempt, rawLimit);
        const limit = Math.min(rawLimit, decision.limit);

        if (retryable && attempt <= limit && decision.retry) {
          if (decision.probe) {
            st.guard.probe().then((alive) => {
              if (!alive) {
                if (st.guard.isLarge(outBuf.length)) st.guard.arm('探活失败 + ' + status);
                if (!res.headersSent) {
                  res.writeHead(502, { 'content-type': 'application/json', 'retry-after': '60' });
                  res.end(JSON.stringify({ error: { message: 'upstream probe failed after ' + status, type: 'upstream_error' } }));
                }
                return;
              }
              setTimeout(send, Math.min(backoffMax, 800 * Math.pow(2, attempt - 1)));
            });
            return;
          }
          pres.resume();
          const wait = Math.min(backoffMax, 800 * Math.pow(2, attempt - 1));
          metrics.upstreamErrors++;
          log('[~] 上游 ' + status + ' → 等 ' + wait + 'ms 重发同一份字节（第 ' + attempt + '/' + limit + '）');
          setTimeout(send, wait);
          return;
        }

        const h = {};
        for (const [k, v] of Object.entries(pres.headers)) {
          const lk = String(k).toLowerCase();
          if (lk === 'connection' || lk === 'transfer-encoding' || lk === 'content-length') continue;
          h[k] = v;
        }
        res.writeHead(status, h);
        let tail = '';
        pres.on('data', (c) => {
          if (c.length) { tail += c.toString('utf8'); if (tail.length > 131072) tail = tail.slice(-65536); }
          res.write(c);
        });
        pres.on('end', () => {
          res.end();
          if (status >= 200 && status < 300) { st.guard.noteSuccess(outBuf.length); }
          else { metrics.upstreamErrors++; if (retryable && st.guard.isLarge(outBuf.length)) st.guard.arm('上游 ' + status); }
          const u = oa.extractUsage(tail);
          if (u) metrics.usage(u.prompt, u.cached);
          log('[out] ' + route.id + ' ' + status + ' ' + Math.round(outBuf.length / 1024) + 'KB');
        });
      });

      preq.setTimeout(upIdle, () => preq.destroy(new Error('upstream idle ' + Math.round(upIdle / 1000) + 's')));
      preq.on('error', (e) => {
        if (attempt <= retryLimit) {
          const wait = Math.min(backoffMax, 800 * Math.pow(2, attempt - 1));
          log('[~] 拨号失败 ' + e.message + ' → ' + wait + 'ms 后重试（第 ' + attempt + '/' + retryLimit + '）');
          setTimeout(send, wait);
          return;
        }
        metrics.errors++;
        if (st.guard.isLarge(outBuf.length)) st.guard.arm('拨号失败');
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'upstream unreachable after ' + attempt + ' attempts: ' + e.message, type: 'upstream_error' } }));
        } else { try { res.end(); } catch { } }
      });
      preq.end(outBuf);
    };
    send();
  }

  return { server, state: { metrics, router, routeState }, version: VERSION };
}

module.exports = { createUhb, VERSION };
