# ADR 0195：触发判断矩阵——显式信号与会话级策略（M79-E）

- 状态：Accepted
- 引入：M79-E（2026-09-20）
- 相关：[docs/social-collab-design.md §8](../social-collab-design.md)、[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[server/src/orchestration/humans.ts](../../server/src/orchestration/humans.ts)、[server/tests/m79-trigger.test.ts](../../server/tests/m79-trigger.test.ts)

## 背景

- 现状语义 = 「一切无 @ 消息都假定为对 AI 说的」→ 一律进 PRS 组队：多人会话中真人讨论会被 AI 误响应；插话会污染 agent 上下文；
- 系统**无法从文本可靠区分**四类意图（对 AI 指令 / 对真人说话 / 回应 AI 提问 / 记录闲聊）。

## 决策

**不引入 LLM 意图分类**（不可见、不可审计、违反「不做隐藏路由器」纪律——ADR 0082 同族否决先例），改为「定向信号 + 会话策略 + 持球命中」三层显式规则，**路由层单点实现**：

| # | 条件 | 行为 |
| --- | --- | --- |
| ① | @agent 命中 | 触发（空闲 launch / 运行中 inject） |
| ② | waiting 命中（发送者 ∈ waiting_on） | 触发（越过策略） |
| ③ | 人类定向（@真人 / 行首 @用户） | 仅存储 + 通知（不触发 PRS） |
| ④ | 无定向 + team + `auto`（默认） | 触发（现状 PRS，零回归） |
| ⑤ | 无定向 + team + `mention` / chat | 仅存储（`notify:turn-end` 补播） |

- `sessions.route_mode`（迁移 v25）：`auto`（存量默认）/ `mention`；team 会话头部开关可切换（`PATCH /sessions/:id` + `notify:session-meta` + 审计 `session.route-mode-set`）；chat 形态恒按 mention 语义（不落列）；
- 客户端提示：mention 模式输入框未 @ 时轻提示「本条将作为协作消息发送（AI 不响应）」。

## 被否决的方案

- **LLM 意图分类自动判断**：不可解释 / 不可测 / 不可审计；
- **全部会话默认静默（mention）**：变更存量语义（零回归红线破）；
- **隐式抑制（有人类在场就静默）**：语义不可预测，用户无法建立心智模型。
