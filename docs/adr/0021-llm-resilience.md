# ADR 0021：LLM 韧性层——重试 / 超时分层 / 限流 / usage

- 状态：Accepted
- 引入：M4
- 相关：[design.md §7](../design.md)、[operations.md §4.2](../operations.md)、ADR 19

## 背景

v1 对 LLM 调用无韧性治理：一次 429 / 网络抖动 / 空闲超时就让整个回合失败；单一 `TURN_TIMEOUT_MS` 无法区分「连不上」与「出字慢」；无 usage 采集（成本不可见）；无并发控制（多 Run 同时打满配额）；超长上下文靠服务端 400 事后发现。

## 决策

**新增 `server/src/llm/resilience.ts`，覆盖五件事**：

1. **错误分类 + 重试**（`withRetry`，`LLM_MAX_RETRIES=3`，指数退避 + 抖动）：可重试 = 429（尊重 `Retry-After`）/ 408 / 5xx / `ECONNRESET`/`ETIMEDOUT`/`EPIPE` / 空闲超时；致命 = 400 参数错误 / 401 / 403；特判 `context_length_exceeded` → 强制压缩后重试该回合（仅 1 次）；
2. **超时分层**：`FIRST_TOKEN_TIMEOUT_MS=30s`（首 token）、`STREAM_IDLE_TIMEOUT_MS=60s`（流空闲）、`TURN_TIMEOUT_MS=120s`（回合总上限）；
3. **并发限流**：全局信号量 `LLM_MAX_CONCURRENCY=3`，超出排队；
4. **usage 采集**：真实 Provider 打开 `stream_options.include_usage`，流末产出 `{ type: 'usage' }` chunk；引擎写 `usage` 表并按 `DEFAULT_PRICING` / `LLM_PRICING_JSON` 估算 `cost_usd`；
5. **流中断恢复**：记录已产出内容，`stopped`/`error` 消息支持「继续生成」（`POST /api/runs/:runId/messages/:messageId/resume`）。

## 理由

- 重试要区分「值得重试」与「重试无用」：对 400/401 重试只是浪费时间，对 429 不重试则白扔一个回合；
- 超时分层让「连不上」快速失败（30s）、「慢速生成」给足空间（120s），避免单一超时两难；
- usage 是成本透明与预算校验（发送前压缩决策，ADR 19）的数据基础。

## 被否决的方案

- **无限重试 / 长超时**：问题被掩盖，用户等待无上限；
- **不做并发限流**：多会话并行时直接触发 provider 侧 429 风暴。

## 影响

- `Engine` 经 `resilientStream` 统一调用 Provider（单测注入 429/500/超时可复现）；
- 前端 `NOTIFY_POLL_MS` 未生效问题一并修复（由 `GET /api/health` 下发 `notifyPollMs`）。
