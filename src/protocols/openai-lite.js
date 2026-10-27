'use strict';
// ── protocols/openai.js —— OpenAI 协议（chat / responses）直通辅助 ──────────
// 这一层刻意"什么都不做"：不改字节、不重排、不注入。它只负责
//   ① 拼上游地址 ② 决定鉴权头 ③ 从响应尾巴里抠 usage（不动数据本身）
const http = require('node:http');
const https = require('node:https');

const FATAL_ENV = new Set(['host', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade']);

function joinUpstream(baseUrl, reqPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  let p = String(reqPath || '/');
  // 上游已带 /v1 且请求路径也以 /v1 开头时避免 /v1/v1
  if (/\/v1$/i.test(base) && /^\/v1\//i.test(p)) p = p.slice(3);
  return base + p;
}

function buildHeaders(reqHeaders, route) {
  const up = route.upstream || {};
  const h = {};
  for (const [k, v] of Object.entries(reqHeaders || {})) {
    if (FATAL_ENV.has(String(k).toLowerCase())) continue;
    h[k] = v;
  }
  const key = up.apiKeyEnv ? process.env[up.apiKeyEnv] : (up.apiKey || null);
  if (key) {
    const mode = up.auth || 'bearer';           // bearer | x-api-key
    if (mode === 'x-api-key') { h['x-api-key'] = key; delete h.authorization; }
    else { h.authorization = /^Bearer\s/i.test(key) ? key : 'Bearer ' + key; delete h['x-api-key']; }
  }
  for (const [k, v] of Object.entries(up.headers || {})) h[k] = v;
  h.connection = 'close';                       // 每次新建 TCP：重试的字节才可复现
  return h;
}

function requestModule(url) { return /^https:/i.test(url) ? https : http; }

// 从任意一段文本（JSON 或 SSE 尾片）里取 usage；兼容多种命名
function extractUsage(text) {
  if (!text) return null;
  const i = text.lastIndexOf('"usage"');
  if (i < 0) return null;
  const start = text.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, end = -1, inStr = false, esc = false;
  for (let p = start; p < text.length && p < start + 4000; p++) {
    const c = text[p];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { end = p + 1; break; } }
  }
  if (end < 0) return null;
  let j;
  try { j = JSON.parse(text.slice(start, end)); } catch { return null; }
  const cached = Number(j.prompt_cache_hit_tokens
    || (j.prompt_tokens_details && j.prompt_tokens_details.cached_tokens)
    || (j.input_tokens_details && j.input_tokens_details.cached_tokens) || 0);
  const prompt = Number(j.prompt_tokens || j.input_tokens || 0);
  const outTok = Number(j.completion_tokens || j.output_tokens || 0);
  if (!(prompt > 0) && !(outTok > 0)) return null;
  return { prompt, cached, output: outTok };
}

// 解析 retry_after：header 与 JSON body 两处都认；>7200s 视为不合法
function parseRetryAfter(headerVal, bodyText) {
  let ra = Number(headerVal);
  if (!(ra > 0) && bodyText) {
    try {
      const j = JSON.parse(bodyText);
      ra = Number(j.retry_after ?? j.retryAfter ?? (j.error && j.error.retry_after));
    } catch { /* 不是 JSON */ }
  }
  return ra > 0 && ra <= 7200 ? Math.round(ra * 1000) : 0;
}

module.exports = { joinUpstream, buildHeaders, requestModule, extractUsage, parseRetryAfter, FATAL_ENV };
