# UHB · 通用健康桥（Universal Health Bridge）

> **定位：坐在 magpie 之后，只做「字节外科手术 + 流量守护」，不做协议转换。**
> 8060 之外的任何翻译（Anthropic ⇄ OpenAI）都由 magpie 负责；UHB 不碰。

```
agent(ccui / pi / DSH)
   → magpie :3425        （协议翻译，不动）
   → UHB :8990           （本桥：直通 + 守护）
   → pro 桥 :8899        （现有字节层，可保留）
   → 网关 <gateway-host>:8000
```

## 一、为什么需要它（以及为什么需要看门狗）

| 问题 | UHB 怎么解 |
|---|---|
| 大 body（1.9MB / ≈50 万 token）被 502 后反复重试，每次都是全额冷 prefill | 体积分级重试：大 body 只给 **1 次**；重试前先 **0-token 探活**（GET /v1/models） |
| 网关坏窗口内持续被撞，未缓存 token 飙升 | **大 body 熔断**：失败后 60s 内本地直接拒（502 + retry-after），不传一个字节；连续 3 次升级到 10 分钟；**小请求成功即解冻** |
| 并发大请求互相把对方刚写进缓存的条目挤掉 | **体积感知准入**：small=8 / mid=2 / large=1 并发；大 body 同前缀哈希**串行排队** |
| 崩溃时没人拉起来 | **看门狗**（必须）：单实例互斥 + 10s 探活（TCP + /__stats）+ 自动重启 + 日志轮转 |

> 看门狗是**必需项**：UHB 在流量路径上，崩了就等于全链路中断；而它自身是单点，所以必须有外部拉起机制。

## 二、目录

```
UHB/
  uhb.js                      CLI（doctor / run / status）
  config.uhb.json             出厂配置（3 条 guard-only 路由）
  src/
    kernel.js                 流水线：协议校验→限额→配额闸→大body闸→准入→字节手术→图片→取证→转发
    admission.js              体积感知准入 + 前缀亲和（本桥核心之一）
    retry-guard.js            体积分级重试 + 0-token 探活 + 502 熔断/升级/解冻
    modules/byteops.js        字节外科手术（只改顶层单键）
    modules/images.js         图片入口裁剪（裁一次后恒定）
    modules/runtime.js        配额熔断(持久化)/两份取证/断崖证据包/指标
    protocols/openai-lite.js  直通辅助（拼地址/鉴权头/usage/retry_after）
    config.js / router.js     配置校验 + 静态路由（含会话粘性）
  scripts/
    uhb-watchdog.ps1          看门狗
    uhb-autostart.vbs         隐藏启动器
    install-autostart.ps1     写 HKCU Run（含立即启动，可 -Remove）
    install-autostart.cmd     双击安装
    uninstall-autostart.cmd   双击卸载
    stop-uhb.cmd              停 UHB + 看门狗（不删自启）
    status.cmd                状态面板
  logs/                       watchdog.log / uhb-stdout.log / uhb-stderr.log
```

## 三、三条路由（guard-only）

| route | 入口 | 上游 | transforms |
|---|---|---|---|
| `chat-guard` | openai-chat | `127.0.0.1:8899` | model 别名、max_tokens 地板/天花板、图片入口裁剪、取证、四针 |
| `responses-guard` | openai-responses | `127.0.0.1:8899` | 取证、四针（不做 reasoning 回灌/聚合） |
| `anthropic-guard` | anthropic | `127.0.0.1:3425`（magpie） | 取证、四针 |

**入口协议必须等于上游协议**，否则直接 400（`UHB 不做协议转换`）。

## 四、常用命令

```bash
node uhb.js doctor            # 离线体检（不监听）
node uhb.js run               # 前台启动（调试用）
node uhb.js status            # 读 /__stats 摘要
curl http://127.0.0.1:8990/__stats
```

双击脚本：

- `scripts\install-autostart.cmd` —— 装开机自启（HKCU Run → `UHB-watchdog`）并立即拉起
- `scripts\status.cmd` —— 端口/看门狗/命中率/准入/熔断一览
- `scripts\stop-uhb.cmd` —— 停 UHB + 看门狗（保留自启项）
- `scripts\uninstall-autostart.cmd` —— 删自启项

## 五、关键开关（改 config.uhb.json 的 route 字段）

| 字段 | 默认 | 含义 |
|---|---|---|
| `slotsSmall / slotsMid / slotsLarge` | 8 / 2 / 1 | 三档并发 |
| `midBodyBytes / largeBodyBytes` | 204800 / 1048576 | 分档阈值 |
| `slotMaxWaitMs` | 300000 | 排队上限，超时回 429 |
| `retryBySize / retryProbe / breaker502` | 全 true | 体积分级 / 探活 / 502 熔断 |
| `largeAttempts / midAttempts` | 1 / 3 | 大/中 body 的尝试次数 |
| `breakerMs / breakerEscalateMs / breakerEscalateAfter` | 60000 / 600000 / 3 | 短熔断 / 升级 / 连续几次升级 |
| `quota.sleepMaxMs` | 60000 | 429 长窗口阈值（超过不睡，直接回 429） |
| `limits.maxTokens.floor / ceilings` | 131072 / deepseek 393216、glm 131072 | 输出上限地板与天花板 |

## 六、验收（已实测）

| 项 | 结果 |
|---|---|
| doctor 配置校验 | ✅ 3 条路由，协议一致 |
| 全量 `node --check` | ✅ 无语法错误 |
| chat 直通 | ✅ 200（0.76s） |
| 1.9MB 大 body | ✅ 200（3.3s），`admission.served = {small:1, mid:0, large:1}` → **正确进 large 档** |
| anthropic 直通（→ magpie） | ✅ 200，thinking 正常返回 |
| 开机自启 | ✅ `HKCU\...\Run → UHB-watchdog` |
| 看门狗 | ✅ 已拉起并托管（`logs\watchdog.log`） |

## 七、回滚

```cmd
scripts\stop-uhb.cmd                 :: 先停
scripts\uninstall-autostart.cmd      :: 再删自启
```
UHB 只新增了一个端口与一条自启项；**不改 magpie 的 providers.json，不改任何既有桥**，删掉即完全恢复。

## 八、下一步（要切流量时）

1. 把 magpie 的 provider 上游从 `8899` 改到 `8990`（或把 ccui 的 `ANTHROPIC_BASE_URL` 指到 `8990`）
2. 先跑影子：用 `x-harness` 头区分来源，观察 `/__stats` 的 `hitRate60s/10m`、`retryWastedTokens`、`admission.queued`
3. 达标（命中率不掉、`retryWastedTokens` 降 ≥70%、回合失败率不升）再正式切
