'use strict';
// ── runtime.js —— 配额熔断 / 上行体取证 / 指标 / 断崖存证 ──────────────────
// 全部是"运行期可执行的确定动作"：读写本地文件 + 整数比较，不做任何语义判断。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256hex(buf, n) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, n || 16);
}

// ── 配额熔断（持久化）────────────────────────────────────────────────────
class Quota {
  constructor(opts) {
    this.on = !(opts && opts.on === false);
    this.file = opts && opts.stateFile;
    this.sleepMaxMs = Number((opts && opts.sleepMaxMs) || 60000);
    this.until = 0;
    this.reason = '';
    this.setAt = 0;
    this.rejected = 0;
    this.surfaced = 0;
    this.load();
  }
  load() {
    if (!this.on || !this.file) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (j && Number(j.until) > 0) { this.until = Number(j.until); this.reason = String(j.reason || ''); this.setAt = Number(j.setAt || 0); }
    } catch { /* 首次没有状态文件 */ }
  }
  save() {
    if (!this.on || !this.file) return;
    try {
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ until: this.until, reason: this.reason, setAt: this.setAt }));
      fs.renameSync(tmp, this.file);
    } catch { /* 落盘失败不影响主流程 */ }
  }
  arm(raMs, why) {
    if (!this.on || !(raMs > 0)) return false;
    const until = Date.now() + raMs + 250;
    if (until <= this.until) return false;
    this.until = until; this.setAt = Date.now(); this.reason = why || 'retry_after';
    this.save();
    return true;
  }
  active() { return this.on && this.until > Date.now(); }
  remainMs() { return Math.max(0, this.until - Date.now()); }
  snapshot() {
    return {
      on: this.on, active: this.active(),
      untilIso: this.until ? new Date(this.until).toISOString() : null,
      reason: this.reason, rejected: this.rejected, surfaced429: this.surfaced, sleepMaxMs: this.sleepMaxMs,
    };
  }
}

// ── 上行体两份轮转（可 diff / 可回放）─────────────────────────────────────
class Archive {
  constructor(opts) {
    this.on = !(opts && opts.on === false);
    this.main = opts && opts.main;
    this.prev = opts && opts.prev;
    this.count = 0;
  }
  write(buf) {
    if (!this.on || !this.main || !buf || !buf.length) return false;
    try {
      const tmp = this.main + '.tmp';
      fs.writeFileSync(tmp, buf);
      try { fs.renameSync(this.main, this.prev); } catch { /* 第一份 */ }
      fs.renameSync(tmp, this.main);
      this.count++;
      return true;
    } catch { return false; }
  }
}

// ── 断崖存证（失配字节数超阈值就落两份上行体 + diff 摘要）──────────────────
function firstDiffByte(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}
class Suspect {
  constructor(opts) {
    this.on = !(opts && opts.on === false);
    this.minLostBytes = Number((opts && opts.minLostBytes) || 8192);
    this.dir = (opts && opts.evidenceDir) || null;
    this.prevByModel = Object.create(null);
    this.count = 0;
  }
  // 返回诊断结果；必要时落证据包
  check(model, buf, nowIso) {
    const prev = this.prevByModel[model];
    const info = { model, firstDiff: 0, lost: 0, suspect: false };
    if (prev) {
      const at = firstDiffByte(prev, buf);
      info.firstDiff = at;
      info.lost = Math.max(0, prev.length - at);
      if (this.on && info.lost >= this.minLostBytes) {
        info.suspect = true;
        this.count++;
        if (this.dir) {
          try {
            const d = path.join(this.dir, String(nowIso || Date.now()).replace(/[:.]/g, '-'));
            fs.mkdirSync(d, { recursive: true });
            fs.writeFileSync(path.join(d, 'prev.req.json'), prev);
            fs.writeFileSync(path.join(d, 'cur.req.json'), buf);
            fs.writeFileSync(path.join(d, 'diff.txt'),
              'model=' + model + '\nfirstDiffByte=' + at + '\nprevLen=' + prev.length + '\ncurLen=' + buf.length + '\nlostBytes=' + info.lost + '\n');
          } catch { /* 存证失败不阻塞 */ }
        }
      }
    }
    this.prevByModel[model] = buf;
    return info;
  }
}

// ── 指标 ────────────────────────────────────────────────────────────────
class Metrics {
  constructor(version) {
    this.version = version;
    this.startedAt = new Date().toISOString();
    this.requests = 0; this.transformed = 0; this.passthrough = 0;
    this.errors = 0; this.upstreamErrors = 0; this.tooLarge = 0;
    this.byRoute = Object.create(null);
    this.samples = [];   // {t, prompt, cached}
  }
  hit(routeId) {
    this.requests++;
    const b = this.byRoute[routeId] || (this.byRoute[routeId] = { requests: 0, transformed: 0, passthrough: 0, prompt: 0, cached: 0 });
    b.requests++;
    return b;
  }
  usage(prompt, cached) {
    if (!(prompt > 0)) return;
    this.samples.push({ t: Date.now(), prompt, cached });
    const cut = Date.now() - 600000;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
  }
  snapshot() {
    const now = Date.now();
    const win = (ms) => {
      let p = 0, c = 0;
      for (const s of this.samples) if (now - s.t <= ms) { p += s.prompt; c += s.cached; }
      return { prompt: p, cached: c, hitRate: p > 0 ? Number((c / p * 100).toFixed(1)) : 0 };
    };
    const all = this.samples.reduce((a, s) => ({ p: a.p + s.prompt, c: a.c + s.cached }), { p: 0, c: 0 });
    return {
      version: this.version, startedAt: this.startedAt,
      requests: this.requests, transformed: this.transformed, passthrough: this.passthrough,
      errors: this.errors, upstreamErrors: this.upstreamErrors, tooLarge: this.tooLarge,
      byRoute: this.byRoute,
      hitRate60s: win(60000), hitRate10m: win(600000),
      hitRateAll: all.p > 0 ? Number((all.c / all.p * 100).toFixed(1)) : 0,
    };
  }
}

module.exports = { Quota, Archive, Suspect, Metrics, sha256hex, firstDiffByte };
