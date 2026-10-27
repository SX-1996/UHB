'use strict';
// ── retry-guard.js —— 大 body 重试治理 + 502 短熔断（2026-10-27）─────────────
// 要解决的问题：一份 1MB+ 的请求体（≈25 万 token）每次重试都等于一次冷 prefill，
// 而 502 往往只是网关瞬时抖动。盲目重试 6 次 = 6 次全价浪费，还把未缓存 token 抬高。
//
// 本模块只做四件确定的事（无任何语义猜测）：
//   ① 体积分级重试：小/中/大 body 各有自己的尝试上限（大 body 只 1 次）
//   ② 重试前 0-token 探活：打一发 GET /v1/models，拿到任何 HTTP 响应即视为"活着"
//   ③ 大 body 专用短熔断：失败后 60s 内大 body 本地直接拒（回 502 + retry-after），不上传
//   ④ 自动解冻 + 升级：小请求成功即解冻；连续 3 次失效升级为长熔断（10 分钟）
//
// 刻意不做：不改请求字节、不裁剪历史、不换上游、不换模型（那都会毁前缀缓存）。
const http = require('node:http');
const https = require('node:https');

const MB = 1024 * 1024;

class RetryGuard {
  constructor(opts) {
    const o = opts || {};
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.on = o.bySize !== false;            // 体积分级重试
    this.probeOn = o.probe !== false;        // 重试前探活
    this.breakerOn = o.breaker !== false;    // 大 body 熔断
    this.probeUrl = o.probeUrl || null;
    this.probeHeaders = o.probeHeaders || {};
    this.probeTimeoutMs = Number(o.probeTimeoutMs || 8000);

    this.largeBytes = Number(o.largeBytes || 1 * MB);
    this.midBytes = Number(o.midBytes || 200 * 1024);
    this.largeAttempts = Number(o.largeAttempts || 1);
    this.midAttempts = Number(o.midAttempts || 3);
    this.smallAttempts = Number(o.smallAttempts || 6);

    this.breakerMs = Number(o.breakerMs || 60000);
    this.escalateMs = Number(o.escalateMs || 600000);
    this.escalateAfter = Number(o.escalateAfter || 3);

    this.untilLarge = 0;
    this.armStreak = 0;
    this.stats = { probeOk: 0, probeDead: 0, breakerArmed: 0, escalated: 0, rejectedLarge: 0, retryDenied: 0, thawed: 0 };
  }

  isLarge(bytes) { return bytes >= this.largeBytes; }

  limitFor(bytes) {
    if (!this.on) return Infinity;
    if (bytes >= this.largeBytes) return this.largeAttempts;
    if (bytes >= this.midBytes) return this.midAttempts;
    return this.smallAttempts;
  }

  // 大 body 熔断是否生效（生效时调用方应本地拒绝，不上传）
  blocked(bytes) { return this.breakerOn && this.isLarge(bytes) && this.untilLarge > Date.now(); }
  retryAfterS() { return Math.max(1, Math.ceil((this.untilLarge - Date.now()) / 1000)); }

  // 任何成功（2xx）都要回报：小请求成功 = 网关活着 = 解除大 body 熔断
  noteSuccess(bytes) {
    if (!this.untilLarge) return;
    if (this.isLarge(bytes || 0)) { this.armStreak = 0; return; }
    this.untilLarge = 0;
    this.armStreak = 0;
    this.stats.thawed++;
    this.log('[guard] 小请求成功 → 解除大 body 熔断');
  }

  arm(reason) {
    if (!this.breakerOn) return 0;
    this.armStreak++;
    const ms = this.armStreak >= this.escalateAfter ? this.escalateMs : this.breakerMs;
    this.untilLarge = Date.now() + ms;
    this.stats.breakerArmed++;
    if (ms === this.escalateMs) this.stats.escalated++;
    this.log('[guard] 大 body 熔断 ' + Math.round(ms / 1000) + 's（连续第 ' + this.armStreak + ' 次，' + (reason || '') + '）');
    return ms;
  }

  // 0-token 探活：拿到任何 HTTP 状态码即视为活着（401/403/400 也算活）
  probe() {
    if (!this.probeOn || !this.probeUrl) return Promise.resolve(true);
    return new Promise((resolve) => {
      let u;
      try { u = new URL(this.probeUrl); } catch { resolve(true); return; }
      const mod = /^https:/i.test(this.probeUrl) ? https : http;
      const req = mod.request(u, { method: 'GET', headers: Object.assign({ connection: 'close' }, this.probeHeaders), agent: false }, (res) => {
        res.resume();
        this.stats.probeOk++;
        this.log('[guard] 探活 OK（HTTP ' + res.statusCode + '）→ 允许重试大 body');
        resolve(true);
      });
      req.setTimeout(this.probeTimeoutMs, () => { try { req.destroy(new Error('probe timeout')); } catch { } });
      req.on('error', (e) => {
        this.stats.probeDead++;
        this.log('[guard] 探活失败（' + e.message + '）→ 不再重试大 body');
        resolve(false);
      });
      req.end();
    });
  }

  // 该不该重试：返回 { retry, limit, probe }
  decide(bytes, attempt, defaultLimit) {
    const lim = Number.isFinite(defaultLimit) ? defaultLimit : 6;
    const cap = this.on ? Math.min(lim, this.limitFor(bytes)) : lim;
    if (attempt >= cap) {
      if (attempt >= 2) this.stats.retryDenied++;
      return { retry: false, limit: cap, reason: 'attempt-cap' };
    }
    const probe = this.isLarge(bytes) && this.probeOn && !!this.probeUrl;
    return { retry: true, limit: cap, probe };
  }

  snapshot() {
    return {
      on: this.on, probeOn: this.probeOn, breakerOn: this.breakerOn,
      largeBytes: this.largeBytes, midBytes: this.midBytes,
      attempts: { small: this.smallAttempts, mid: this.midAttempts, large: this.largeAttempts },
      breaker: {
        active: this.untilLarge > Date.now(),
        untilIso: this.untilLarge ? new Date(this.untilLarge).toISOString() : null,
        retryAfterS: this.untilLarge > Date.now() ? this.retryAfterS() : 0,
        armStreak: this.armStreak, breakerMs: this.breakerMs, escalateMs: this.escalateMs,
      },
      stats: this.stats,
    };
  }
}

module.exports = { RetryGuard, MB };
