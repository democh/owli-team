# ADR 0019：上下文工程——五层装配 + 压缩 + 记忆

- 状态：Accepted
- 引入：M2
- 相关：[design.md §21.4](../design.md)、[operations.md §4.3](../operations.md)、ADR 15、ADR 21

## 背景

v1 用 `slice(-40)` 硬截断历史消息：长会话中早期关键约束（如「必须用 PostgreSQL」）会被截掉，模型「失忆」；且硬截断可能从 tool 消息中间切开，触发 API 400。需要从「截断式」升级为「预算 + 压缩 + 记忆」三层结构。

## 决策

**五层优先级装配**（`server/src/context/assembler.ts`）：

| 层 | 内容 | 裁剪策略 |
| --- | --- | --- |
| L0 静态 | 协议 + 人设 + 输出契约 | 永不裁剪，字节级稳定（命中 prompt cache） |
| L1 记忆 | 决策 / 约束 / 术语 / 交付件索引 | 永不裁剪（超限按 kind 优先级截断，先丢术语） |
| L2 摘要 | 已完成 / 关键决策 / 未决问题 / 下一步 | 永不裁剪（滚动合并） |
| L3 半静态 | Skill 索引、工作区清单 | 可裁剪 |
| L4 动态 | 最近 K 回合原文 | 按 token 预算从后往前填 |
| L5 工具 | 工具结果 detail（最近 N 条，更早折叠为一行） | 优先裁剪 |

**压缩器**（`context/compressor.ts`）：预算 `CONTEXT_BUDGET_TOKENS`（默认 60000），触发线 = 预算 × 0.7；以**回合组**为原子单位切分（禁止从 tool 消息中间切开）；结构化摘要（json 输出六字段：completed / decisions / constraints / artifacts / openQuestions / nextSteps）；增量合并推进 `summaries.until_seq`；`decisions/constraints/artifacts` 提升入 `memory` 表（内容哈希去重）；摘要失败降级为硬截断并标记 `degraded`；按真实 `usage.prompt_tokens` 滚动校准估算系数。

**记忆**：`remember(kind, content)` 工具（decision | constraint | glossary）；`GET/DELETE /api/sessions/:id/memory` API。

## 理由

- 「永不裁剪」的 L1/L2 保证关键约束跨压缩存活（配合测试：第 30 回合仍能看到第 1 回合约束）；
- 回合组原子切分从结构上消除 tool 消息孤儿（API 400）；
- 结构化摘要让压缩产物可再压缩（滚动合并）、可提升（进记忆）、可展示（上下文抽屉）。

## 被否决的方案

- **增大截断窗口**（如 slice(-200)）：总有一天会爆窗，且成本线性增长；
- **只压缩不记忆**：摘要被二次压缩时细节仍会二次丢失；记忆层是最终兜底。

## 影响

- 装配前预算校验：超预算先压缩再发（不再依赖服务端 400）；
- `context:compressed` 事件 + trace 记录压缩前后 token（ADR 26）；
- Prompt 协议写明「历史会被摘要替代，关键约束必须 remember 或写文件」。
