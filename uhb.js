#!/usr/bin/env node
'use strict';
// ── uhb.js —— 通用健康桥（UHB）命令行 ──────────────────────────────────────
// 命令：
//   node uhb.js doctor [--config config.uhb.json]     离线体检（不监听）
//   node uhb.js run    [--config …] [--port 8990]     启动（唯一会监听）
//   node uhb.js status [--port 8990]                  读 /__stats 摘要
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const flag = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const line = (s) => process.stdout.write(s + '\n');

function loadCfg(file) {
  const { load } = require('./src/config');
  return load(path.resolve(path.dirname(__filename), file));
}

if (cmd === 'doctor') {
  const file = flag('config', 'config.uhb.json');
  try {
    const cfg = loadCfg(file);
    line('配置校验通过: ' + cfg.__file);
    line('监听: ' + cfg.listen.host + ':' + cfg.listen.port);
    for (const r of cfg.routes) {
      line('  ' + r.id + '  ' + r.inProto + ' → ' + r.upProto + '  ' + r.upstream.url + '  transforms=' + (r.transforms || []).join(','));
      if (r.inProto !== r.upProto) line('    ✗ 入口与上游协议不一致（UHB 不做协议转换）');
    }
    const { createUhb } = require('./src/kernel');
    const b = createUhb(cfg, { quiet: true });
    line('内核构造 OK（未监听）  version=' + b.version);
    line('准入档位: small=' + (cfg.routes[0].slotsSmall || 8) + ' mid=' + (cfg.routes[0].slotsMid || 2) + ' large=' + (cfg.routes[0].slotsLarge || 1));
    line('分区: mid≥' + Math.round((cfg.routes[0].midBodyBytes || 204800) / 1024) + 'KB  large≥' + Math.round((cfg.routes[0].largeBodyBytes || 1048576) / 1024) + 'KB');
  } catch (e) {
    line('✗ ' + e.message);
    process.exitCode = 1;
  }
} else if (cmd === 'run') {
  const file = flag('config', 'config.uhb.json');
  const cfg = loadCfg(file);
  const host = flag('host', cfg.listen.host || '127.0.0.1');
  const port = Number(flag('port', cfg.listen.port || 8990));
  const { createUhb } = require('./src/kernel');
  const pinFile = path.resolve(path.dirname(__filename), flag('pin', '_pins.json'));
  const b = createUhb(cfg, { pinFile });
  b.server.listen(port, host, () => {
    line('UHB ' + b.version + ' 监听 http://' + host + ':' + port + '  （guard-only：不做协议转换）');
    for (const r of cfg.routes) line('  route ' + r.id + ': ' + r.inProto + ' → ' + r.upstream.url);
    line('统计: GET /__stats');
  });
} else if (cmd === 'status') {
  const port = Number(flag('port', 8990));
  http.get({ host: '127.0.0.1', port, path: '/__stats', timeout: 5000 }, (res) => {
    let d = '';
    res.setEncoding('utf8');
    res.on('data', (c) => { d += c; });
    res.on('end', () => {
      try {
        const j = JSON.parse(d);
        line('version=' + j.version + '  请求=' + j.requests + '  命中率(60s/10m/全)=' + j.hitRate60s.hitRate + '%/' + j.hitRate10m.hitRate + '%/' + j.hitRateAll + '%');
        for (const [id, v] of Object.entries(j.per || {})) {
          line('  ' + id + '  running=' + JSON.stringify(v.admission.running) + '  queued=' + JSON.stringify(v.admission.queued) + '  配额=' + (v.quota.active ? '熔断' : '正常') + '  大body熔断=' + (v.guard.breaker.active ? (v.guard.breaker.retryAfterS + 's') : '无'));
        }
      } catch (e) { line('解析失败: ' + d.slice(0, 200)); }
    });
  }).on('error', (e) => line('连不上 UHB(' + port + '): ' + e.message));
} else {
  line('UHB —— 通用健康桥（guard-only，不做协议转换）');
  line('  node uhb.js doctor [--config config.uhb.json]');
  line('  node uhb.js run    [--config config.uhb.json] [--port 8990]');
  line('  node uhb.js status [--port 8990]');
}
