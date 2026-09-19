# ADR 0020：会话级互斥 + 插话 + Run 快照恢复

- 状态：Accepted
- 引入：M3
- 相关：[design.md §5](../design.md)、[api.md §4](../api.md)、ADR 10、ADR 12、ADR 2

## 背景

v1 允许同会话并发多个 Run（用户运行中再发消息会新建 Run）：两个 Run 同时读同一份历史、各自写入消息，上下文互相污染，消息顺序混乱。此外进程崩溃后进行中的 Run 信息丢失。

## 决策

**同会话永远只有一个活跃 Run**（`engine.sessionRuns: Map<sessionId, runId>`）：

- 运行中再发送 = **插话**：写入 `runs.pending_user_messages`，引擎在**每回合结束边界**消费，作为下一回合的额外 user 消息注入（不占回合计数），并 emit `user:message` 事件；
- 运行中不允许编辑 / 删除消息 / fork（`400` 护栏）；
- **Run 状态落盘**：状态变更写 `runs` 表；进程重启时 `state='running'` 的 Run 标记为 `interrupted`，`streaming` 消息改写为 `stopped`（半截内容保留）；会话内提供「从断点继续」（`POST /api/sessions/:id/resume`，复用队列 + 已产出消息启动新 Run）；
- 交还语义不变：`handoff(target='user')` 或行首 `@用户`（ADR 4）。

## 理由

- 上下文污染是结构性缺陷：互斥从引擎层消除竞态，任何 API 调用组合都不会产生双 Run；
- 插话贴合真实协作（「等等，需求改了」），且回合边界注入保证模型看到的是完整插话而非半截流入；
- 快照恢复把「崩溃 = 全丢」变成「崩溃 = 续跑」：队列、已发言者、回合序号都是可序列化状态。

## 被否决的方案

- **同会话排队新建 Run**：第二个 Run 从旧历史快照启动，看不到第一个 Run 的产出，必然重复劳动；
- **运行中直接拒绝发送**：体验差，且用户真实需求是「补充信息」。

## 影响

- 前端 `POST messages` 返回 `injected: true` 时展示「将插话」提示（ADR 10）；
- `GET /api/sessions/:id` 附 `latestRun` 快照供「从断点继续」按钮；
- 引擎新增回合边界的插话消费钩子与 `user:message` 事件类型。
