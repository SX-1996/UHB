// 发布前清理 + 脱敏门：删掉含本机路径的临时脚本，补 .gitignore，跑扫描
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

// 1) 删掉含本机路径的临时诊断脚本（保留 offline.test.js）
for (const f of ['.build-copy.js', 'test/probe-magpie-live.js', 'test/analyze-gohttp.js']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) { fs.unlinkSync(p); console.log('removed ' + f); }
}

// 2) .gitignore（运行期产物 + 日志）
const gi = [
  '# runtime artifacts',
  'logs/',
  '_pins.json', '_pins.json.tmp',
  '_quota-*.json', '_quota-*.json.tmp',
  '_lastmain.req.json', '_prev.req.json',
  '_lastside.req.json', '_prevside.req.json',
  '_faildump.json',
  '.evidence/',
  'node_modules/',
  'scripts/node-path.txt',
  '',
].join('\n');
fs.writeFileSync(path.join(ROOT, '.gitignore'), gi, 'utf8');
console.log('wrote .gitignore');

// 3) 敏感信息扫描（规则用拼接构造，避免自匹配）
const SELF = path.resolve(__filename);
const PATTERNS = [
  { name: 'API Key(网关)', re: new RegExp('\\b' + 'is' + 't_[A-Za-z0-9]{8,}', 'g') },
  { name: 'API Key(github)', re: new RegExp('\\bgh' + '[pousr]_[A-Za-z0-9]{10,}', 'g') },
  { name: '内网 IP(10.x)', re: /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g },
  { name: '内网 IP(172.16-31)', re: /\b172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/g },
  { name: '内网 IP(192.168)', re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/g },
  { name: '内部品牌标记', re: new RegExp('\\b' + 'is' + 'tar[a-z-]*\\b', 'gi') },
  { name: '本机用户名', re: new RegExp('e-' + 'shuai|' + 'xing' + 'shuai\\w*', 'gi') },
  { name: '本机账号', re: new RegExp('SX' + '-1996', 'g') },
  { name: '邮箱', re: /[\w.+-]+@[\w-]+\.[\w.]{2,}/g },
  { name: '本机绝对路径', re: new RegExp('[A-Za-z]:[\\\\/](?:' + 'Users|xs' + 'agent|OD' + '24|claude' + 'codeui|dsh-' + 'harness)[^\\s"\'`)]*', 'g') },
];

const IGNORED = ['node_modules', '.git', 'logs', 'scripts/node-path.txt', '.evidence'];
function ignored(rel) {
  const p = rel.split(path.sep).join('/');
  return IGNORED.some((x) => p === x || p.startsWith(x + '/'));
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'logs' || e.name === '.evidence') continue;
    const p = path.join(dir, e.name);
    const rel = path.relative(ROOT, p);
    if (ignored(rel)) continue;
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|json|md|cmd|ps1|vbs|txt)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT, []).filter((f) => path.resolve(f) !== SELF);
let hits = 0;
for (const f of files) {
  let t;
  try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  t.split(/\r?\n/).forEach((line, i) => {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line)) !== null) {
        hits++;
        console.log('  ' + path.relative(ROOT, f) + ':' + (i + 1) + '  [' + p.name + ']  ' + m[0].slice(0, 6) + '***');
        if (p.re.lastIndex === m.index) p.re.lastIndex++;
      }
    }
  });
}
console.log('\n扫描文件 ' + files.length + ' 个，命中 ' + hits + ' 处');
if (hits) { console.log('结果: FAIL'); process.exitCode = 1; } else console.log('结果: PASS');
