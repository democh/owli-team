# ADR 0190：实时通道背压与连接治理（M79-A）

- 状态：Accepted
- 引入：M79-A（2026-09-20）
- 相关：[docs/social-collab-design.md §9.5](../social-collab-design.md)、[server/src/ws.ts](../../server/src/ws.ts)、[server/src/config.ts](../../server/src/config.ts)、[client/src/lib/ws.ts](../../client/src/lib/ws.ts)

## 背景

- 通知通道 `publish` 直接 `send`：慢客户端积压无界；无每用户连接数限制（标签页泄漏）；客户端不做 seq 缺口检测（断线后可能静默丢事件）。

## 决策

1. **背压**：单连接待写队列上限 `WS_SEND_QUEUE_MAX=256`（send 回调递减；按帧计数）→ 超限发 `resync` 帧后主动断开（客户端退避重连 + REST 补齐，**不丢事件**）；
2. **连接上限**：`WS_MAX_CONNS_PER_USER=8`——超限踢最旧连接（`error code=conn_evicted` 提示先于 terminate）；
3. **重连韧性**：客户端退避**向下抖动 0.8–1.0×**（错峰重连；首跳 ≤ 基准保持既有测试口径）；60s 无帧主动探活（`ping`）；`visibilitychange` 转前台且未 OPEN → 立即重连（绕过退避）；
4. **ACL 撤销即时化**：`revokeSession`（移出会话）/ `kickUser`（账号变更）主动退订 + `error code=acl-changed`；保留期清理（`INBOX_RETENTION_DAYS=30`）启动 + 每日一轮（仅删已读）；
5. **观测**：`GET /api/ws/stats`（admin）：连接数 / 活跃用户 / 队列水位 / 踢出与 resync 计数。

## 被否决的方案

- **背压丢帧**：通知语义不可丢（个人事件 → 转 REST 补齐而非丢弃）；
- **重连无抖动**：多端同时重连风暴；
- **每用户连接不限**：标签页泄漏导致长尾堆积与投递放大。
