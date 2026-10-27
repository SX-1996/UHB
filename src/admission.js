'use strict';
// ── admission.js —— 体积感知准入 + 前缀亲和排队（UHB 核心之一）──────────────
// 为什么需要：并发大请求会互相把对方刚写进网关缓存的条目挤掉（逐出损失 99% 发生在
// 同一轮内连续 step 之间）。并发数是我们在这层唯一能控制的变量。
//
// 规则（三档，全部确定，不做语义判断）：
//   small  (< midBytes)  并发 S（默认 8）—— 便宜、可全并行
//   mid    (< largeBytes) 并发 M（默认 2）
//   large  (>= largeBytes) 并发 L（默认 1）且 **同前缀哈希已在飞时排队其后**
// 排队上限 slotMaxWaitMs，超时由调用方回 429（绝不无限等）。
const crypto = require('node:crypto');

function tierOf(bytes, midBytes, largeBytes) {
  if (bytes >= largeBytes) return 'large';
  if (bytes >= midBytes) return 'mid';
  return 'small';
}

function prefixHash(buf) {
  // 用前 64KB 作为"前缀指纹"：够稳定，能反映同一会话/同一提示词前缀
  const n = Math.min(buf.length, 65536);
  return crypto.createHash('sha256').update(buf.subarray(0, n)).digest('hex').slice(0, 16);
}

class Admission {
  constructor(opts) {
    const o = opts || {};
    this.midBytes = Number(o.midBytes || 204800);
    this.largeBytes = Number(o.largeBytes || 1048576);
    this.slots = Object.assign({ small: 8, mid: 2, large: 1 }, o.slots || {});
    this.slotMaxWaitMs = Number(o.slotMaxWaitMs || 300000);
    this.pollMs = Number(o.pollMs || 120);
    this.log = typeof o.log === 'function' ? o.log : () => {};
    this.running = { small: 0, mid: 0, large: 0 };
    this.queued = { small: 0, mid: 0, large: 0 };
    this.prefixInFlight = new Map();   // hash -> count（仅 large 档统计）
    this.stats = { served: { small: 0, mid: 0, large: 0 }, queuedTotal: 0, timeouts: 0, prefixSerialized: 0 };
  }

  tier(bytes) { return tierOf(bytes, this.midBytes, this.largeBytes); }

  _canRun(tier, hash) {
    if (this.running[tier] >= this.slots[tier]) return false;
    if (tier === 'large' && hash && this.prefixInFlight.get(hash)) return false;  // 同前缀大请求串行
    return true;
  }

  // 返回 { ok:true, tier, release() } 或 { ok:false, reason, tier }
  async acquire(bytes, hash) {
    const tier = this.tier(bytes);
    const deadline = Date.now() + this.slotMaxWaitMs;
    let waited = false;
    for (;;) {
      if (this._canRun(tier, hash)) {
        this.running[tier]++;
        if (tier === 'large' && hash) {
          const c = (this.prefixInFlight.get(hash) || 0) + 1;
          this.prefixInFlight.set(hash, c);
          if (c > 1) this.stats.prefixSerialized++;
        }
        this.stats.served[tier]++;
        if (waited) this.stats.queuedTotal++;
        let done = false;
        return {
          ok: true, tier,
          release: () => {
            if (done) return;
            done = true;
            this.running[tier] = Math.max(0, this.running[tier] - 1);
            if (tier === 'large' && hash) {
              const c = (this.prefixInFlight.get(hash) || 0) - 1;
              if (c <= 0) this.prefixInFlight.delete(hash); else this.prefixInFlight.set(hash, c);
            }
          },
        };
      }
      if (!waited) {
        waited = true;
        this.queued[tier]++;
        this.log('[admit] ' + tier + ' 档已满（' + this.running[tier] + '/' + this.slots[tier] + '）→ 排队等待空位');
      }
      if (Date.now() >= deadline) {
        this.queued[tier] = Math.max(0, this.queued[tier] - 1);
        this.stats.timeouts++;
        return { ok: false, reason: 'slot-timeout', tier };
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  snapshot() {
    return {
      slots: this.slots, midBytes: this.midBytes, largeBytes: this.largeBytes,
      running: Object.assign({}, this.running), queued: Object.assign({}, this.queued),
      prefixInFlight: this.prefixInFlight.size, stats: this.stats,
    };
  }
}

module.exports = { Admission, tierOf, prefixHash };
