# ADR 0010：消息接口双形态——一个入口兼顾新运行与插话

- 状态：Amended（M3 起扩展为「新运行 / 插话」双形态）
- 引入：v1 决策，M3 修订
- 相关：[design.md §9](../design.md)、[api.md §4](../api.md)、ADR 20

## 背景

用户发送消息时可能有两种处境：会话空闲（应启动新 Run）或运行中（应作为插话注入当前 Run）。如何设计 API？备选：两个接口，或一个接口按状态分流。

## 决策

**`POST /api/sessions/:id/messages` 为唯一入口，按会话状态返回双形态**：

- 无活跃 Run → 启动新 Run：`201 { message, runId, queue }`（内容经 SSE 消费）；
- 有活跃 Run → 插话：`201 { message, injected: true, position, runId }`。

## 理由

- 前端发送逻辑无需感知会话状态：一个调用、按返回分流 UI（进入流式视图 or 提示「已插话，将在当前回合结束后看到」）；
- v1 起该接口即返回双形态（当时用于「运行中不允许再发」的拒绝与正常启动）；M3 引入互斥语义后自然扩展，接口形态不变；
- 插话语义与「排队新建 Run」互斥（ADR 20）：同会话永远只有一个活跃 Run，从 API 层就消除误用可能。

## 被否决的方案

- **两个接口**（`/messages` 与 `/messages/inject`）：调用方需先查状态，竞态窗口会产生错误调用；
- **同会话排队新建 Run**：上下文污染（见 ADR 20）。

## 影响

- 该接口挂限流护栏（`MESSAGE_RATE_LIMIT`，超限 429）；
- 请求体仅 `{ content }`（≤20000 字符），zod 校验（`sendMessageSchema`）。
