'use strict';
// ── images.js —— 图片「入口裁剪」（clip-on-arrival）────────────────────────
// 铁律：图片第一次进来就裁，此后永不再改。
//   裁剪结果 = f(原图字节, 固定参数)（纯函数）→ 同一张图每轮裁出来的 base64 逐字节相同
//   → 上行体对每张图是"只追加、不改写" → **零缓存代价**。
// 绝不按"保留最近 N 张、越界裁旧图"做：那会每插一张新图就改动前文字节，等于每轮自毁缓存。
const crypto = require('node:crypto');

let sharpLib = null;
// sharp 为可选依赖：优先 SHARP_PATH，其次项目默认 require('sharp')，最后 SHARP_PATH_CANDIDATES（逗号分隔）。
// 这里不内置任何本机绝对路径，避免把开发机目录结构带进发布物。
function loadSharp() {
  const cands = [];
  if (process.env.SHARP_PATH) cands.push(process.env.SHARP_PATH);
  cands.push('sharp');
  for (const p of String(process.env.SHARP_PATH_CANDIDATES || '').split(',')) {
    if (p && p.trim()) cands.push(p.trim());
  }
  for (const c of cands) {
    try { const m = require(c); if (m) return m; } catch { /* 下一个 */ }
  }
  return null;
}

const CACHE = new Map();   // sha256(原 base64) -> { url, before, after }
const MAXCACHE = 96;

function dataUrlParts(s) {
  const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([\s\S]+)$/.exec(s || '');
  return m ? { mime: m[1].toLowerCase(), b64: m[2].replace(/\s+/g, '') } : null;
}

function pickUrl(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.image_url === 'string') return p.image_url;
  if (p.image_url && typeof p.image_url.url === 'string') return p.image_url.url;
  if (typeof p.image === 'string') return p.image;
  if (p.source && p.source.type === 'base64' && typeof p.source.data === 'string') {
    return 'data:' + (p.source.media_type || 'image/png') + ';base64,' + p.source.data;
  }
  return null;
}

function collectImageUrls(chatBody) {
  const out = [];
  const msgs = Array.isArray(chatBody && chatBody.messages) ? chatBody.messages : [];
  for (const m of msgs) {
    const c = m && m.content;
    if (!Array.isArray(c)) continue;
    for (const p of c) {
      const u = pickUrl(p);
      if (u && u.indexOf('data:image/') === 0) out.push(u);
    }
  }
  return out;
}

async function clipOne(sharp, orig, mime, cfg) {
  let dim = cfg.maxDim, q = cfg.quality;
  for (let i = 0; i < 5; i++) {
    const pipe = sharp(orig).rotate().resize({ width: dim, height: dim, fit: 'inside', withoutEnlargement: true });
    let out, outMime;
    try {
      if (mime === 'image/png') { out = await pipe.png({ compressionLevel: 9, palette: true, quality: q }).toBuffer(); outMime = 'image/png'; }
      else if (mime === 'image/webp') { out = await pipe.webp({ quality: q }).toBuffer(); outMime = 'image/webp'; }
      else { out = await pipe.jpeg({ quality: q, mozjpeg: true }).toBuffer(); outMime = 'image/jpeg'; }
    } catch { return null; }
    if (out.length <= cfg.maxBytes) return { buf: out, mime: outMime };
    dim = Math.round(dim * 0.82);
    q = Math.max(60, q - 6);
  }
  return null;
}

// 返回 { changed, buf, count, savedKB, error? }；未改动时 changed=false 且 buf 原样
async function clipImages(buf, chatBody, cfg) {
  if (!cfg || cfg.on === false) return { changed: false, buf, count: 0, savedKB: 0 };
  const urls = collectImageUrls(chatBody);
  if (!urls.length) return { changed: false, buf, count: 0, savedKB: 0 };

  let str = null, count = 0, saved = 0;
  for (const u of urls) {
    const parts = dataUrlParts(u);
    if (!parts) continue;
    const size = Math.floor(parts.b64.length * 3 / 4);
    if (size <= cfg.maxBytes) continue;                 // 小图一律不碰
    const key = crypto.createHash('sha256').update(parts.b64).digest('hex');
    let hit = CACHE.get(key);
    if (!hit) {
      if (!sharpLib) sharpLib = loadSharp();
      if (!sharpLib) return { changed: false, buf, count: 0, savedKB: 0, error: 'sharp 不可用' };
      const r = await clipOne(sharpLib, Buffer.from(parts.b64, 'base64'), parts.mime, cfg);
      if (!r) continue;
      hit = { url: 'data:' + r.mime + ';base64,' + r.buf.toString('base64'), before: size, after: r.buf.length };
      if (CACHE.size >= MAXCACHE) CACHE.delete(CACHE.keys().next().value);
      CACHE.set(key, hit);
    }
    if (hit.after >= size) continue;                    // 压了更大：不换
    if (str === null) str = buf.toString('utf8');
    if (str.indexOf(u) < 0) continue;                   // 字节里对不上：不冒险
    str = str.split(u).join(hit.url);
    count++; saved += (size - hit.after);
  }
  if (!count || str === null) return { changed: false, buf, count: 0, savedKB: 0 };
  return { changed: true, buf: Buffer.from(str, 'utf8'), count, savedKB: Math.round(saved / 1024) };
}

module.exports = { clipImages, collectImageUrls, dataUrlParts };
