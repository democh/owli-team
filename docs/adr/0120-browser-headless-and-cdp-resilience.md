# ADR 0120：浏览器启动形态可配置（默认无头）与 CDP 连接韧性——保活探测 · 断线自动重连 · 帧写库节流（M22 韧性增强批）

- 状态：Accepted
- 引入：M22（韧性增强批）
- 相关：ADR 0042（连接中心与 CDP 浏览器接入）、ADR 0051（多标签页感知与激活页跟随）、[server/src/browser/cdp.ts](../../server/src/browser/cdp.ts)、[server/src/browser/session.ts](../../server/src/browser/session.ts)、[server/src/browser/runtime.ts](../../server/src/browser/runtime.ts)、[server/src/browser/launcher.ts](../../server/src/browser/launcher.ts)、[client/src/components/panels/BrowserPanel.tsx](../../client/src/components/panels/BrowserPanel.tsx)、[client/src/components/console/ConnectionsConsole.tsx](../../client/src/components/console/ConnectionsConsole.tsx)

## 背景

- 用户需求两条：① 浏览器启动形态可配置（无头 / 打开窗口），且默认无头；② 甄别并修复「连接一段时间后断连」；
- 现状（改造前）的启动形态决策：`managed` 恒无头、`local` 默认可见，仅连接 `config.headless` 可覆盖——语义隐式分裂（managed 下无法开窗调试），无全局配置与任何 UI 入口；
- 断连根因分析（实测 + 代码审查，逐条甄别）：
  1. **CDP WebSocket 无保活（真实缺陷）**：`ws` 客户端不检测半开连接——睡眠唤醒 / 远程端点 NAT 静默丢包（TCP 层无 FIN/RST）后连接僵尸化：命令全部 15s 超时且永远不触发 `close`，会话卡死无自愈；
  2. **断线即死（真实缺陷）**：`onUnexpectedClose` 直接置 closed + onClosed，无任何重连——浏览器崩溃重启 / 远程端点抖动一次即终止会话；
  3. 每帧一次 SQLite UPDATE（`last_frame_at`）：高频写放大（性能问题，非断连根因）；
  4. 客户端 watch token TTL 5 分钟：重连后过期已有恢复路径（`token_invalid` → 换发 watch token 重订），无需改动；
- 关键实证：Chrome 对 CDP WebSocket 的协议层 ping 自动回 pong（本地探针验证）——应用层保活方案成立且零成本。

## 决策

1. **启动形态三源决策链**：`opts.headless → 连接 config.headless → 全局 BROWSER_HEADLESS（默认 true = 无头）`；删除「managed 恒无头 / local 默认可见」的隐式特例（两后端对 headless 语义完全一致）；`remote` 不参与启动（形态由对方浏览器决定），UI 不提供切换；
2. **UI 双入口**：面板空态「无头 / 打开窗口」启动前一次性切换（随启动请求透传）；连接表单「无头模式」复选（持久到连接 config，缺省勾选）；会话信息面新增 `headless` 徽章（remote 不展示）；`BrowserSessionInfo.headless` 可选字段随 shared 类型发布；
3. **CDP 保活探测**（CdpClient 内置，默认周期 15s）：静默期发协议 ping；ping 后一整周期无任何入站（消息 / pong）即判定半开 → `terminate()` 触发 close → 交会话层重连。覆盖睡眠唤醒与远程静默丢包；
4. **断线自愈**（BrowserSession）：`onUnexpectedClose` → 退避重连（300ms / 1s / 2.5s，单次连接超时 6s）——新连接重挂原管理页（`preferTargetId` 命中时；否则按初始 URL 选择 / 新建）并恢复域启用 / 事件订阅 / 帧流 / 地址对齐；步骤留痕 `reconnect`；**重试耗尽才落 error + onClosed**。同一时刻仅一个重连任务；重连期间动作入口（`runExclusive` / `evaluateRaw` / 人工输入）等待恢复结果，恢复后在新连接上执行；
5. **帧写库节流**：`last_frame_at` 每 ≥5s 落一次（帧分发自身上不节流——StreamHub 已有客户端级节流与覆盖槽）；
6. **重连状态语义**：`BrowserState` 新增 `reconnecting`（断线自动重连中，区别于首次启动的 `launching`）——面板文案「重连中」，用户与 Agent 可区分「启动新会话」与「恢复既有连接」；
7. **复用实例信息面**：`BrowserSessionInfo.external` 暴露「复用了已运行实例」；面板显示「复用实例」徽章（title 说明形态由该实例决定），`browser_open` 详情同步标注；local 空态「打开窗口」附提示「本机已有实例运行时将沿用它」（Chrome 同 Profile 单实例约束：形态由首个存活实例决定，切换形态需先退出它）；
8. **保活周期配置化**：`BROWSER_KEEPALIVE_MS`（默认 15000，范围 5000–300000）——企业网络 / 高延迟远程端点可调小以更快判定半开。

## 理由

- **决策链单一化**：原「managed 恒无头」是无法绕过的隐式特例（想开窗调试 managed 必须改代码）；统一三源链让「默认无头」与「可配置」同时成立，且与 `BROWSER_HEADLESS=false` 的全局回退口径一致；
- **保活必要性**：半开连接无任何内核事件可依赖，唯有应用层探测能在「命令全超时」前甄别；Chrome 对协议 ping 默认回 pong（实测），探测无命令层成本（不污染 sent / 日志）；
- **自愈优于报错**：浏览器崩溃重启 / 远程端点重启是运维常态，重连到原页面比重启会话便宜得多；重试有界（最坏 ~3×2.5s + 3×6s ≈ 25s）覆盖「秒级重启」又不过度拖长调用方等待；
- **动作等待而非失败**：重连窗口内动作排队等待比立即失败更符合「连接自愈」心智（等待上限即重试预算）；重试耗尽后以「浏览器会话已关闭」明确失败，语义无歧义；
- **节流到展示粒度**：`last_frame_at` 仅信息面展示用，5s 粒度足够；SQLite 写本身微秒级，批量 / 队列化纯属过度设计。

## 被否决的方案

- **保活发应用层命令**（`Runtime.evaluate` / `Target.getTargets`）代替协议 ping：污染调用记录与页面执行上下文、成本更高；协议 ping 已实证可用；
- **保活周期 5s / 60s**：5s 对空闲页面纯浪费；60s 则睡眠唤醒后最长两分钟才判定死连接（动作白白超时一轮）；15s 与命令级超时同量级，僵尸窗口 ≤ 2 个周期；
- **重连无限重试 / 指数退避到分钟级**：会话长期挂 `launching` 让 UI 语义含混；有界三击 + error 收口简单可预期，长时恢复需求走用户显式重启；
- **复用旧 CdpClient 实例重连**：旧实例的 pending / listeners / 保活状态已污染；新建实例 + 重挂订阅是更干净的边界（沿用「一个实例只连一个端点」契约）；
- **断线时自动 kill 重启浏览器进程**：仅对 managed（本进程 spawn）成立；local 复用实例 / remote 无进程可管；且崩溃重启后调试端口变化，自动重启无法复用原端点——统一走同端点重连；
- **重连期间动作直接快速失败**：把「秒级可恢复」场景变成 Agent 侧重试负担；
- **local 形态与请求不符即新开实例**：Chrome 对同一 `user-data-dir` 是单实例（重复启动仅把请求转给已有实例），分 Profile（如 local-headless / local-visible）会分裂登录态——「提示并沿用」是平台约束下的最优解。

## 适用与失效条件

- 适用：保活探测对全部 backend 生效（remote 最受益——NAT 静默丢包多见于远程端点）；断线自愈仅作用于活跃会话（主动 close 经 `closedByUser` 抑制，不触发重连）；headless 三源决策链由 runtime / 路由 / 面板 / 连接表单 / 工具（不显式传参即走配置）共用；
- 失效条件：Chrome 若停用协议层 ping 响应（当前实测 pong）须换应用层探测并重评成本；「一个 CdpClient 只连一个端点」契约若调整，须复核重连是否改为复用实例；`local` 复用语义（优先复用已运行实例、不按 headless 重开——见「被否决的方案」）若改变，须复核面板提示与 `external` 徽章的交互；重连退避序列若放宽，须同步评估工具侧超时预算（默认 60s）与动作等待上限；保活周期若调整（`BROWSER_KEEPALIVE_MS`），须复核 `terminate` 判定窗口与日志噪音。
