# ADR 0005：流式通道——SSE

- 状态：Accepted
- 引入：v1
- 相关：[design.md §6](../design.md)、ADR 11、ADR 12

## 背景

Agent 输出需要逐字流式呈现，还需要承载回合事件（`turn:start` / `tool:call` / `artifact:updated` 等）。备选：轮询、WebSocket、SSE（Server-Sent Events）。

## 决策

**运行流采用 SSE**（`GET /api/runs/:runId/stream`）：单向下行、文本协议、事件类型化（`data: {type,...}`）；连接建立时**先快照重放（Run 至今的全部事件）再续流**，实现「刷新 / 重附着即可续看」。

## 理由

- 流是天然单向（服务端 → 客户端），SSE 语义正好；自带断线重连与 `Last-Event-ID` 概念；
- 纯 HTTP：穿透代理简单、调试方便（curl 即可观察）；无需协议升级与额外端口；
- 重放 + 续流让「打开页面时 Run 已在跑」的体验无缺口（配合 ADR 12 的解耦）。

## 被否决的方案

- **WebSocket 承载运行流**：双向能力用不上，还需自行设计重放协议；WS 另有更合适职责（通知，ADR 11）；
- **轮询增量**：延迟与请求量都不可接受。

## 影响

- 引擎向 SSE 连接广播事件；Run 与连接解耦后多连接可同时订阅同一 Run；
- 心跳由 `startSseHeartbeat` 维持（防中间层掐断空闲连接）。
