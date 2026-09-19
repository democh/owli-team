# ADR 0186：输出完整性治理——显式输出上限、截断提示与静默中止兜底（对话链微批）

- 状态：Accepted
- 引入：对话链微批（2026-09-19）
- 相关：[design.md §7](../design.md)、[server/src/config.ts](../../server/src/config.ts)、[server/src/llm/openai.ts](../../server/src/llm/openai.ts)、[server/src/llm/provider.ts](../../server/src/llm/provider.ts)、[server/src/llm/resilience.ts](../../server/src/llm/resilience.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[client/src/components/chat/MessageActions.tsx](../../client/src/components/chat/MessageActions.tsx)、[server/tests/resilience.test.ts](../../server/tests/resilience.test.ts)、[server/tests/m4.test.ts](../../server/tests/m4.test.ts)、[e2e/stop.spec.ts](../../e2e/stop.spec.ts)

## 背景

用户反馈「输出经常不完整」：消息结尾断在半句，且**没有任何中断标记**（无「已停止」徽章、无系统条提示、无法续写），观感上是模型突然失智。据库审计定位到三层根因：

1. **单次输出上限静默触顶**：请求未显式下发 `max_tokens`，`finish_reason=length` 也未被消费——正文断在半句而消息仍标记 `complete`；
2. **OpenAI SDK 对 abort「静默结束」**（`streaming.js`：*If the user calls `stream.controller.abort()`, we should exit without throwing*）：用户停止 / 进程优雅停机（`engine.stopAll`）/ 单次尝试级超时（first-token、idle）触发 abort 时，迭代器**正常结束且不抛错**，韧性层与引擎把中断误判为「正常完成」→ 消息 `complete` + 半截正文；
   - 定位证据：截断消息所在 Run **无任何 usage 记录**（流末 usage 未达），turn 时长与进程「正在退出…」日志时刻精确重合（±10ms）；
3. **续写能力无前端入口**：引擎侧 `resumeMessage`（M4「继续生成」）与路由早已就绪，但消息操作菜单没有入口，「续写剩余内容」对用户不可达。

## 决策

1. **显式输出上限**：`openai.ts` 请求下发 `max_tokens`（新配置 `LLM_MAX_OUTPUT_TOKENS`，默认 `8192`，`0` = 交给服务商默认）；
2. **触顶可感知**：`finish_reason=length` → 新 `truncated` chunk → 引擎在三条回合路径（execute / resume / regenerate）落**系统事件条提示**（正文保留、状态不变；可续写 / 重新生成 / 分批补齐）；
3. **静默中止兜底（韧性层单点收口）**：`resilientStream` 流循环正常退出前**复核父级信号与超时相位**——父级 aborted → `AbortError` 上抛（引擎按中断收尾为 `stopped`）；`timedOutPhase` 置位 → `LlmTimeoutError`（已产出不重试 / 未产出按可重试重放）；`openai.ts` 另对「**全程无收尾标记**（finish_reason 与 usage 双缺）且非主动中止」的流抛 `LlmStreamInterruptedError`（可重试分类）——摘要 / 压缩 / 平台路由 / 记忆沉淀等所有 `resilientStream` 消费方一次到位；
4. **续写入口补齐**：消息操作菜单新增「继续生成」（仅 `stopped` / `error` 且有正文时可见）→ 既有 `POST /api/runs/:runId/messages/:messageId/resume`（轻量 Run，不触发调度 / 接力）。

## 理由

- **兜底放在韧性层而非引擎**：引擎三个回合路径之外还有摘要 / 压缩 / 路由 / 沉淀四个消费方，全部经 `resilientStream` 收口，一处兜底即全覆盖；引擎零改动（减少并发批次冲突面）；
- **静默截断判定保守化**：「无收尾标记」仅在 finish_reason 与 usage **双缺**且非中止时才判定异常（正常 OpenAI 兼容端点必发其一），避免误伤不实现 `stream_options` 的第三方端点；
- **截断 ≠ 失败**：触顶消息保留 `complete` 与正文 + 系统条提示，不阻断接力链（提示可行动路径：续写 / 重新生成）；中断（stopped / error）才走可续写态；
- **续写复用既有引擎能力**：零新接口、零新状态，UI 入口即可闭环（服务端守卫已有：不可续写态 / 空正文 / 运行互斥）。

## 被否决的方案

- **「无 finish_reason 即致命错误」**：对忽略 `stream_options` 的第三方兼容端点过严误伤；改为「finish_reason / usage 双缺且非中止」的保守判定（`LlmStreamInterruptedError` 按可重试分类，首增量前可安全重放）；
- **在引擎三条回合路径分别加后置 abort 检查**：三处重复且覆盖面窄（摘要 / 压缩 / 路由仍漏）；韧性层单点复核兼顾全部消费方；
- **中断后服务端自动续写**：无用户意图的自动 token 消耗与链路噪声；保留显式「继续生成」触发；
- **已产出内容后重放重试**：重复文本（M4 已确立「仅首增量前可安全重试」纪律，沿用）。

## 边界与失效条件

- `max_tokens` 语义随服务商而异（思考模式下 reasoning 与正文可能共享上限）；`0` = 不显式下发，回到服务商默认；
- 触顶提示仅在**末轮截断**时出现：若截断后模型自行发起工具轮补齐（内容完整），视为自愈不提示（m4 有断言保护）；
- 收尾标记判定依赖 OpenAI 兼容协议（finish_reason / usage 至少其一）；完全背离协议的端点会被判为「意外中断」；
- 停机 / 停止中断的 Run 仍以 `stopped` 收尾：未消费队列成员需用户 @ 续起（会话级「断点继续」语义不变，属 M3 边界）；
- 中断的流不产生 usage 记录（费用侧缺该次统计，为已知取舍）。

## 验证

- server `tests/resilience.test.ts` **+3**：静默中止三态（父级中断后迭代器不抛错 → 仍上抛 AbortError / 空闲超时 → LlmTimeoutError 且不重试 / 首 token 超时 → 重试成功）；
- server `tests/m4.test.ts` **+1**（引擎级）：已产出内容后被停止（迭代器静默结束）→ 消息标记 `stopped` 而非 `complete`；**敏感性已证**（摘除兜底代码该用例转红）；
- server 全量 **1338 例**通过；client 全量 **1242 例**通过（MessageActions 条件渲染）；
- E2E `e2e/stop.spec.ts` **+1**：停止 → 消息操作菜单「继续生成」→ 续写 Run 收束不接力（2 例通过）。
