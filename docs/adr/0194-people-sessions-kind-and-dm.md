# ADR 0194：人物会话——kind / dm_key / 隐藏复现 / 群邀请放宽（M79-D）

- 状态：Accepted
- 引入：M79-D（2026-09-20）
- 相关：[docs/social-collab-design.md §12](../social-collab-design.md)、[server/src/routes/chats.ts](../../server/src/routes/chats.ts)、[server/src/store/session-hides.ts](../../server/src/store/session-hides.ts)、[server/src/store/sessions.ts](../../server/src/store/sessions.ts)

## 背景

- 会话以 agent 编制为核心：空编制消息走平台路由组队——纯人聊天会被当作「待组队需求」派发 agent；私聊 / 群聊无承载。

## 决策

1. **一切皆会话**（迁移 v24）：`sessions.kind: team（存量默认）/ direct / group`；私聊 / 群聊复用消息存储、渲染、未读、搜索、附件——**零平行 IM 栈**；
2. **私聊唯一键** `dm_key =` 排序后两 userId 以 `|` 连接（部分唯一索引）；并发创建竞态由唯一索引兜底 → 回查复用；
3. **私聊语义**：仅好友可发起（403 明确）；双方成员（创建人 owner / 对方 editor）；**标题动态渲染** = 对端显示名（不落库，防改名过期）；不支持删除（「隐藏」= DM 删除语义）；
4. **群聊**：创建人 owner + 受邀者 editor（1–50 人；成员须为创建人好友）；可后续经成员 API 拉 agent 进群组成混编；
5. **隐藏复现**：`session_hides` 仅从本人列表隐藏；查询侧「hidden && unreadCount == 0」才过滤——**新消息自动复现**；
6. **群邀请放宽**：`shares.ts` 按 kind 分流——群聊任何成员可邀请**自己的好友**（role 恒 editor）；团队会话维持 owner-only；被邀请人 inbox 实时到达；
7. **chat 免路由**：direct / group 无 @agent 命中时零引擎（仅存储 + `notify:turn-end` 补播）；混编群 @agent → 正常唤起（M79-E 触发矩阵补全 routeMode / 人类定向维度）；
8. 工作区零特判：chat 会话照常分配沙盒目录（附件 / 交付件链复用）。

## 被否决的方案

- **独立聊天表 / 独立消息栈**：双份未读 / 渲染 / 搜索 / ACL；
- **DM 单方删除整会话**：连带删除对方历史；
- **chat 会话不分配工作区**：附件 / 上传链断裂（特例扩散）。
