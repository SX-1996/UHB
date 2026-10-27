// 发布 UHB 到 GitHub（HTTPS + 本机凭据；token 只在内存用，不打印、不写入 .git/config）
// 用法: node test/publish.js [repoName]     默认 UHB
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..');
const REPO = process.argv[2] || 'UHB';
const line = (s) => console.log(s);
const sh = (cmd, args, opts) => cp.spawnSync(cmd, args, Object.assign({ cwd: DIR, encoding: 'utf8', timeout: 180000 }, opts || {}));

// 1) 扫描门
line('== 1) 脱敏门 ==');
const gate = sh(process.execPath, [path.join(DIR, 'test', 'prep-publish.js')]);
process.stdout.write((gate.stdout || '').slice(-260));
if (gate.status !== 0) { line('✗ 扫描未通过，中止'); process.exit(1); }

// 2) git
line('\n== 2) 提交 ==');
if (!fs.existsSync(path.join(DIR, '.git'))) {
  if (sh('git', ['init', '-b', 'main']).status !== 0) { line('✗ git init 失败'); process.exit(1); }
  line('  git init -b main ✓');
}
sh('git', ['add', '.']);
const staged = sh('git', ['diff', '--cached', '--name-only']).stdout.trim().split(/\r?\n/).filter(Boolean);
line('  待提交 ' + staged.length + ' 个文件');
const bad = staged.filter((f) => /(^|\/)(logs\/|_pins|_quota-|_lastmain|_prev\.req|_faildump|\.evidence\/|node_modules\/|node-path\.txt)/.test(f));
if (bad.length) { line('✗ 运行期产物混入: ' + bad.join(', ')); process.exit(1); }
line('  运行期产物检查 ✓');
for (const f of staged) line('    ' + f);
const c = sh('git', ['commit', '-m', 'UHB v1.0.0: 通用健康桥（guard-only，magpie 之后；体积感知准入 + 429/502 双熔断 + 0-token 探活 + 取证 + 看门狗/自启）']);
if (c.status !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) { line('✗ commit 失败: ' + (c.stderr || '').slice(0, 300)); process.exit(1); }
line('  commit ✓');

// 3) 凭据
line('\n== 3) 读取本机凭据 ==');
const cred = cp.spawnSync('git', ['credential', 'fill'], { cwd: DIR, encoding: 'utf8', input: 'protocol=https\nhost=github.com\n\n' });
const token = (cred.stdout || '').split(/\r?\n/).find((l) => l.startsWith('password='))?.slice(9) || '';
if (!token) { line('✗ 未取到凭据'); process.exit(1); }
line('  token=' + token.slice(0, 4) + '…' + token.slice(-4) + '（长度 ' + token.length + '，仅内存）');

const api = async (p, method, body) => {
  const r = await fetch('https://api.github.com' + p, {
    method: method || 'GET',
    headers: { authorization: 'token ' + token, accept: 'application/vnd.github+json', 'user-agent': 'uhb-publish', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { }
  return { status: r.status, json: j, text: t.slice(0, 300) };
};

(async () => {
  line('\n== 4) 仓库 ==');
  const me = await api('/user');
  if (me.status !== 200) { line('✗ token 无效'); process.exit(1); }
  const owner = me.json.login;
  line('  账号: ' + owner);
  const full = owner + '/' + REPO;
  const remoteUrl = 'https://github.com/' + full + '.git';

  const exists = await api('/repos/' + full);
  if (exists.status === 200) {
    line('  已存在: ' + exists.json.full_name + '  private=' + exists.json.private + '  size=' + exists.json.size + 'KB');
  } else if (exists.status === 404) {
    const mk = await api('/user/repos', 'POST', { name: REPO, private: true, description: 'UHB 通用健康桥：magpie 之后的字节层 + 流量守护（不做协议转换）', auto_init: false });
    if (mk.status === 201) line('  已创建（private）: ' + mk.json.full_name);
    else { line('✗ 建库失败 ' + mk.status + ' ' + (mk.json && mk.json.message || mk.text)); process.exit(1); }
  } else {
    line('✗ 查询失败 ' + exists.status + ' ' + exists.text); process.exit(1);
  }

  line('\n== 5) 推送 ==');
  sh('git', ['remote', 'remove', 'origin']);
  sh('git', ['remote', 'add', 'origin', remoteUrl]);
  line('  origin = ' + remoteUrl);
  const push = sh('git', ['push', '-u', 'origin', 'main'], { env: Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0' }) });
  if (push.status !== 0) { line('✗ 推送失败:\n' + (push.stderr || push.stdout || '').slice(0, 600)); process.exit(1); }
  line('  推送成功');

  line('\n== 6) 验证 ==');
  line('  ' + (sh('git', ['ls-remote', '--heads', 'origin']).stdout || '').trim());
  line('  本地 HEAD: ' + (sh('git', ['log', '-1', '--format=%h %s']).stdout || '').trim());

  const after = await api('/repos/' + full);
  line('  仓库: ' + (after.json && after.json.html_url) + '  private=' + (after.json && after.json.private));
  const tree = await api('/repos/' + full + '/git/trees/main?recursive=1');
  if (tree.json && tree.json.tree) {
    const files = tree.json.tree.filter((x) => x.type === 'blob').map((x) => x.path).sort();
    line('  远端文件 ' + files.length + ' 个:');
    for (const f of files) line('    ' + f);
    const leak = files.filter((f) => /(^|\/)(logs\/|_pins|_quota-|_lastmain|_prev\.req|_faildump|\.evidence\/|node-path\.txt)/.test(f));
    line('  远端产物泄漏: ' + (leak.length ? '✗ ' + leak.join(',') : '✓ 无'));
  }
})();
