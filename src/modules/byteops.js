'use strict';
// ── byteops.js —— 字节外科手术 ────────────────────────────────────────────
// 唯一允许"改字节"的地方。规则：
//   1) 只改【顶层】某个 key 的值，其余字节一个不动（前缀 token 序列因此不变 → 不毁缓存）
//   2) 值长度变化只影响该值自身，不重排、不重新序列化整份 JSON
//   3) 定位必须在原始文本里逐字符扫描（跳过字符串内部的同名 key）
// 这三条是"运行期零决策"的物理基础：同样的输入永远得到同样的输出。

// 在原始 JSON 文本里定位【顶层】 key 的值区间。kind: 'string' | 'number'
function topLevelSpan(text, key, kind) {
  const n = text.length;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '"') break;
        j++;
      }
      if (depth === 1) {
        let k = j + 1;
        while (k < n && /\s/.test(text[k])) k++;
        if (text[k] === ':' && text.slice(i, j + 1) === '"' + key + '"') {
          let v = k + 1;
          while (v < n && /\s/.test(text[v])) v++;
          if (kind === 'number') {
            let w = v;
            while (w < n && /[-+0-9.eE]/.test(text[w])) w++;
            if (w > v) return [v, w];
          } else if (text[v] === '"') {
            let w = v + 1;
            while (w < n) {
              if (text[w] === '\\') { w += 2; continue; }
              if (text[w] === '"') break;
              w++;
            }
            return [v + 1, w];
          }
        }
      }
      i = j + 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    i++;
  }
  return null;
}

// 顶层字符串替换；返回 { buf, changed, from, to }。找不到就原样返回（绝不猜）
function replaceTopLevelString(buf, key, next) {
  const raw = buf.toString('utf8');
  const span = topLevelSpan(raw, key, 'string');
  if (!span) return { buf, changed: false, from: null, to: next };
  const cur = raw.slice(span[0], span[1]);
  if (cur === next) return { buf, changed: false, from: cur, to: next };
  const out = raw.slice(0, span[0]) + next + raw.slice(span[1]);
  return { buf: Buffer.from(out, 'utf8'), changed: true, from: cur, to: next };
}

function readTopLevelNumber(buf, key) {
  const raw = buf.toString('utf8');
  const span = topLevelSpan(raw, key, 'number');
  if (!span) return null;
  const v = Number(raw.slice(span[0], span[1]));
  return Number.isFinite(v) ? v : null;
}

function replaceTopLevelNumber(buf, key, next) {
  const raw = buf.toString('utf8');
  const span = topLevelSpan(raw, key, 'number');
  if (!span) return { buf, changed: false, from: null, to: next };
  const cur = Number(raw.slice(span[0], span[1]));
  if (cur === next) return { buf, changed: false, from: cur, to: next };
  const out = raw.slice(0, span[0]) + String(next) + raw.slice(span[1]);
  return { buf: Buffer.from(out, 'utf8'), changed: true, from: cur, to: next };
}

// 字面量整体替换（用于 base64 图片这类超长值）：先确认唯一再换，避免误伤
function replaceLiteral(buf, from, to) {
  const raw = buf.toString('utf8');
  const at = raw.indexOf(from);
  if (at < 0) return { buf, changed: false, hits: 0 };
  let hits = 0;
  let i = 0;
  while ((i = raw.indexOf(from, i)) >= 0) { hits++; i += from.length; }
  return { buf: Buffer.from(raw.split(from).join(to), 'utf8'), changed: true, hits };
}

module.exports = { topLevelSpan, replaceTopLevelString, readTopLevelNumber, replaceTopLevelNumber, replaceLiteral };
