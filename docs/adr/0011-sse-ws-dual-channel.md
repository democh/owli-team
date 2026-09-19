# ADR 0011：异步通知通道——SSE + WS 双通道

- 状态：Accepted
- 引入：v1
- 相关：[design.md §18](../design.md)、ADR 5、ADR 12

## 背景

系统有两类下行数据：运行时的细粒度流（逐字增量 / 回合事件），与生命周期级的通知（Run 完成 / 交还用户 / 出错 / 审批请求）。前者已由 SSE 承载（ADR 5），后者是否复用同一通道？

## 决策

**双通道分工**：

- **SSE**（`GET /api/runs/:runId/stream`）：单 Run 的运行流，短连接生命周期，重附着即重放；
- **WebSocket**（`/ws`）：`NotifyEvent` 通知总线（跨会话，`notify:*` 系列），长连接、心跳（`WS_HEARTBEAT_MS`）、环形重放缓冲（`WS_REPLAY_BUFFER`）、断线按 `since` 补发；
- WS 不可用时自动降级为 `GET /api/notifications?since=` 轮询（间隔由 `/api/health` 下发 `notifyPollMs`）。

## 理由

- 职责不同：SSE 面向「当前正在看的 Run」，WS 面向「所有会话的全局动态」（未读角标 / 系统通知）；
- 页面关闭后重开需要知道「关闭期间发生了什么」——WS 的补发机制天然胜任；SSE 重附着只覆盖单个 Run；
- 降级轮询保证受限网络（WS 被代理阻断）下通知不丢。

## 被否决的方案

- **只用 SSE**：跨会话通知需要为每个活跃 Run 开一条 SSE，连接数不可控，且关闭页面期间的事件无处接收；
- **只用 WS**：运行流的重放语义、curl 可调试性都劣于 SSE。

## 影响

- 前端 `ws-store` 管理 WS 生命周期与降级切换；`run-store` 独立管理 SSE；
- 两个通道共享同一 `NotificationCenter` 服务端真源（v1.1 语义），状态一致。
