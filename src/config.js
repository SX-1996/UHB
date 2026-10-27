'use strict';
// ── config.js —— 静态配置加载与校验 ────────────────────────────────────────
// 设计：配置期（扫描 + 用户点击）产出一份 bridge.config.json；运行期只读它。
// 任何"猜"都在这里被拒绝：缺字段/冲突路由 → 直接抛错，绝不带着含糊配置起服务。
const fs = require('node:fs');
const path = require('node:path');

const PROTOCOLS = new Set(['anthropic', 'openai-chat', 'openai-responses']);
const KNOWN_TRANSFORMS = new Set([
  'model:alias', 'maxTokens:floor', 'images:clip', 'archive:rotate', 'diagnose:4p',
  'reasoning:effort', 'reasoning:replay', 'usage:normalize',
]);

function deepMerge(base, over) {
  if (over === undefined) return base;
  if (base === null || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = Object.assign({}, base);
  for (const [k, v] of Object.entries(over || {})) out[k] = deepMerge(base[k], v);
  return out;
}

function fail(msg) { throw new Error('[config] ' + msg); }

function validate(cfg) {
  if (!cfg || typeof cfg !== 'object') fail('配置必须是 JSON 对象');
  if (!Array.isArray(cfg.routes) || !cfg.routes.length) fail('缺少 routes[]');
  const ids = new Set();
  for (const r of cfg.routes) {
    if (!r.id) fail('route 缺 id');
    if (ids.has(r.id)) fail('route id 重复: ' + r.id);
    ids.add(r.id);
    if (!PROTOCOLS.has(r.inProto)) fail(r.id + ': inProto 非法 → ' + r.inProto);
    if (!PROTOCOLS.has(r.upProto)) fail(r.id + ': upProto 非法 → ' + r.upProto);
    if (!r.upstream || !/^https?:\/\//.test(r.upstream.url || '')) fail(r.id + ': upstream.url 非法');
    for (const t of r.transforms || []) {
      if (!KNOWN_TRANSFORMS.has(t)) fail(r.id + ': 未知 transform → ' + t + '（写入未知变换等于运行期决策，禁止）');
    }
    if (!r.harness) fail(r.id + ': 缺 harness（路由必须能静态判定）');
  }
  return cfg;
}

function load(file) {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs, 'utf8');
  const cfg = JSON.parse(raw);
  cfg.__file = abs;
  cfg.__dir = path.dirname(abs);
  const defaults = cfg.defaults || {};
  // 把 defaults 铺到每条 route 上，运行期不再做任何"缺省推断"
  cfg.routes = cfg.routes.map((r) => {
    const merged = deepMerge(defaults, r);
    merged.limits = deepMerge(defaults.limits || {}, r.limits || {});
    merged.upstream = Object.assign({ headers: {} }, r.upstream);
    return merged;
  });
  return validate(cfg);
}

function resolvePath(cfg, p, fallbackName) {
  const v = p || ('./' + fallbackName);
  return path.isAbsolute(v) ? v : path.join(cfg.__dir, v);
}

module.exports = { load, validate, resolvePath, deepMerge, PROTOCOLS, KNOWN_TRANSFORMS };
