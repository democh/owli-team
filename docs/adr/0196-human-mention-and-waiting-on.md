# ADR 0196：真人 @ 寻址与持球方——零 Run 锁的等待语义（M79-E）

- 状态：Accepted
- 引入：M79-E（2026-09-20）
- 相关：[docs/social-collab-design.md §8.6–8.7 / §13](../social-collab-design.md)、[server/src/orchestration/parser.ts](../../server/src/orchestration/parser.ts)、[server/src/orchestration/humans.ts](../../server/src/orchestration/humans.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[server/src/store/sessions.ts](../../server/src/store/sessions.ts)

## 背景

- 人类不可被 @ 寻址（mention token 表只吃 agent 成员）；agent「交还用户」无目标（多人会话不知球在谁手里）；
- 「挂起 Run 等真人」与 Run 互斥 / 并发配额 / 断线控制语义冲突。

## 决策

1. **人类 token 表与 agent 隔离**（注册期互斥，杜绝双命中）：显示名 → 与在场 agent 名 / id 冲突或人类重名则不注册；`username` 恒可用（撞 reserved 的极端情形不可点名）；行首 `@用户/@user/@你` 泛指语义不变；
2. **消息级字段**：`humanMentions: string[]`（userIds；迁移 v25 列 `messages.human_mentions`）——agent `mentions` 语义零变更；正文 chips「提及」渲染；
3. **行首 @具体人 = 指定交还**：agent 输出行首 @人 → Run 收尾 `handedTo`（Run 内并集）→ 成员校验（仅在场人类）→ `sessions.waiting_on` 写入 + `notify:session-meta` 广播 + 每目标 inbox `waiting`（同会话同目标 60s 聚合）+ `notify:awaiting-user` payload 增 `targets`；
4. **零 Run 锁**：等待发生在 Run 收束之后——Run 互斥 / 配额 / 插话语义零变化；头部琥珀徽章「等待 X 回复」（被等待者 Composer 上方提示条）；**任何消息集合差清除**（发送者 ∈ waiting_on → 移除 + 广播）+ 成员移除钩子清洗（`clearWaitingForUsers`）；
5. **@真人通知**：inbox `mention`（60s 聚合；title=会话名，正文截断 120 字）；`humanDirected` 消息不触发 PRS（ADR 0195 矩阵③）。

## 被否决的方案

- **挂起 Run 等待真人（parked run）**：Run 互斥锁被长时间占用、断线不可控；
- **humanMentions 并入 agent mentions 字段**：污染引擎队列过滤不变量（`queue ⊆ participants`）；
- **@ 真人隐式触发接管**：误触发面扩大（@ 只是通知，触发语义由矩阵显式定义）。
