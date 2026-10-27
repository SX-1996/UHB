// UHB 离线单测（不联网、不监听）：准入分档 / 前缀亲和 / guard 决策 / 配置校验
const assert = require('node:assert');
const path = require('node:path');
const { Admission, tierOf, prefixHash } = require('../src/admission');
const { RetryGuard } = require('../src/retry-guard');
const config = require('../src/config');

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log('  [ok]   ' + n); } catch (e) { fail++; console.log('  [FAIL] ' + n + ' → ' + e.message); } };
const KB = 1024, MB = 1024 * 1024;

console.log('\n== 准入分档 ==');
t('三档边界正确', () => {
  assert.strictEqual(tierOf(100 * KB, 200 * KB, 1 * MB), 'small');
  assert.strictEqual(tierOf(300 * KB, 200 * KB, 1 * MB), 'mid');
  assert.strictEqual(tierOf(2 * MB, 200 * KB, 1 * MB), 'large');
});
t('前缀指纹稳定，且只看前 64KB（之后的差异不算）', () => {
  const a = Buffer.from('P'.repeat(100000));
  const diffEarly = Buffer.concat([Buffer.from('Q'), Buffer.from('P'.repeat(99999))]);      // 首字节不同 → 指纹变
  const diffLate = Buffer.concat([Buffer.from('P'.repeat(90000)), Buffer.from('Q'.repeat(10000))]); // 64KB 之后不同 → 指纹相同
  assert.strictEqual(prefixHash(a), prefixHash(a));
  assert.notStrictEqual(prefixHash(a), prefixHash(diffEarly));
  assert.strictEqual(prefixHash(a), prefixHash(diffLate));
});

console.log('\n== 并发槽位 ==');
t('small 槽位可并发到上限', async () => {
  const A = new Admission({ slots: { small: 2, mid: 1, large: 1 }, slotMaxWaitMs: 500, pollMs: 20 });
  const r1 = await A.acquire(10 * KB, null);
  const r2 = await A.acquire(10 * KB, null);
  assert.ok(r1.ok && r2.ok);
  assert.strictEqual(A.running.small, 2);
  r1.release(); r2.release();
  assert.strictEqual(A.running.small, 0);
});
t('large 档同前缀串行（第二发排队）', async () => {
  const A = new Admission({ slots: { small: 4, mid: 1, large: 1 }, slotMaxWaitMs: 300, pollMs: 20 });
  const h = 'abc123';
  const r1 = await A.acquire(2 * MB, h);
  assert.ok(r1.ok);
  const p2 = A.acquire(2 * MB, h);
  let done = false;
  p2.then((r) => { done = true; r.release(); });
  await new Promise((r) => setTimeout(r, 120));
  assert.strictEqual(done, false, '同前缀第二个应仍在排队');
  r1.release();
  const r2 = await p2;
  assert.ok(r2.ok, '第一个释放后第二个应拿到槽位');
});
t('排队超时返回 slot-timeout', async () => {
  const A = new Admission({ slots: { small: 1, mid: 1, large: 1 }, slotMaxWaitMs: 120, pollMs: 20 });
  const r1 = await A.acquire(10 * KB, null);
  const r2 = await A.acquire(10 * KB, null);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'slot-timeout');
  r1.release();
});

console.log('\n== retry-guard 决策 ==');
t('大 body 尝试上限 = 1，中 = 3，小 = 6', () => {
  const g = new RetryGuard({ probeUrl: null, largeAttempts: 1, midAttempts: 3, smallAttempts: 6 });
  assert.strictEqual(g.decide(2 * MB, 1, 6).retry, false);
  assert.strictEqual(g.decide(2 * MB, 0, 6).retry, true);
  assert.strictEqual(g.decide(300 * KB, 3, 6).retry, false);
  assert.strictEqual(g.decide(10 * KB, 5, 6).retry, true);
});
t('大 body 熔断 arm / 阻隔 / 小请求解冻', () => {
  const g = new RetryGuard({ probeUrl: null, breakerMs: 1000 });
  g.arm('test');
  assert.strictEqual(g.blocked(2 * MB), true);
  assert.strictEqual(g.blocked(10 * KB), false, '小请求不受大 body 熔断影响');
  g.noteSuccess(10 * KB);
  assert.strictEqual(g.blocked(2 * MB), false, '小请求成功应解冻');
});
t('连续失效升级为长熔断', () => {
  const g = new RetryGuard({ probeUrl: null, breakerMs: 1000, escalateMs: 99 * 1000, escalateAfter: 2 });
  g.arm('1'); g.arm('2');
  assert.strictEqual(g.stats.escalated, 1);
});

console.log('\n== 配置校验 ==');
t('UHB 出厂配置可加载，且无协议转换', () => {
  const cfg = config.load(path.join(__dirname, '..', 'config.uhb.json'));
  assert.ok(cfg.routes.length >= 3);
  for (const r of cfg.routes) assert.strictEqual(r.inProto, r.upProto, r.id + ' 不应做协议转换');
});
t('未知 transform 被拒绝', () => {
  assert.throws(() => config.validate({ routes: [{ id: 'x', harness: 'p', inProto: 'openai-chat', upProto: 'openai-chat', upstream: { url: 'http://x' }, transforms: ['magic'] }] }), /未知 transform/);
});

console.log('\n--------------------------------------------------------------');
console.log(' 结果: ' + pass + ' 通过 / ' + fail + ' 失败');
console.log('--------------------------------------------------------------');
if (fail) process.exitCode = 1;
