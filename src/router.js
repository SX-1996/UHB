'use strict';
// ── router.js —— 静态路由表 + 会话粘性 ────────────────────────────────────
// 运行期零决策的落地：
//   · 路由只按 (harness, inProto, path) 查表；查不到 → 明确 400，绝不"猜一个"
//   · 一旦某会话被钉到某条 route，本会话后续请求永远走它（换桥 = 断崖）
//   · pin 记录可持久化，进程重启后粘性不丢
const fs = require('node:fs');
const path = require('node:path');

const PATH_TO_PROTO = [
  { re: /^\/v1\/messages(\/count_tokens)?$/i, proto: 'anthropic' },
  { re: /^\/v1\/chat\/completions$/i, proto: 'openai-chat' },
  { re: /^\/v1\/responses$/i, proto: 'openai-responses' },
];

function protoOfPath(p) {
  const pathOnly = String(p || '').split('?')[0];
  for (const it of PATH_TO_PROTO) if (it.re.test(pathOnly)) return it.proto;
  return null;
}

class Router {
  constructor(cfg, opts) {
    this.cfg = cfg;
    this.routes = cfg.routes.slice();
    this.pins = new Map();
    this.pinFile = (opts && opts.pinFile) || null;
    this.pinned = 0;
    this.loadPins();
  }
  loadPins() {
    if (!this.pinFile) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.pinFile, 'utf8'));
      for (const [k, v] of Object.entries(j || {})) this.pins.set(k, v);
    } catch { /* 首次没有 pin 文件 */ }
  }
  savePins() {
    if (!this.pinFile) return;
    try {
      const obj = {};
      for (const [k, v] of this.pins) obj[k] = v;
      const tmp = this.pinFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
      fs.renameSync(tmp, this.pinFile);
    } catch { /* 落盘失败不影响路由 */ }
  }
  candidates(harness, inProto) {
    return this.routes.filter((r) => r.inProto === inProto && (!harness || r.harness === harness));
  }
  // 返回 { route, reason } 或 { error }
  resolve(ctx) {
    const harness = ctx.harness || null;
    const inProto = ctx.inProto || protoOfPath(ctx.path);
    if (!inProto) return { error: 'unknown in-protocol for path ' + ctx.path };
    const sid = ctx.sessionId || null;

    if (sid && this.pins.has(sid)) {
      const id = this.pins.get(sid);
      const pinned = this.routes.find((r) => r.id === id);
      if (pinned && pinned.inProto === inProto) return { route: pinned, reason: 'session-pin' };
    }
    const list = this.candidates(harness, inProto);
    if (!list.length) return { error: 'no route for harness=' + (harness || '*') + ' inProto=' + inProto };
    if (list.length > 1 && !harness) {
      return { error: 'ambiguous routes for inProto=' + inProto + '（缺 harness 标识，禁止其猜）' };
    }
    const route = list[0];
    if (sid) { this.pins.set(sid, route.id); this.pinned++; this.savePins(); }
    return { route, reason: sid ? 'first-pin' : 'table' };
  }
  describe() {
    return this.routes.map((r) => ({ id: r.id, harness: r.harness, inProto: r.inProto, upProto: r.upProto, upstream: r.upstream.url, transforms: r.transforms }));
  }
}

module.exports = { Router, protoOfPath };
