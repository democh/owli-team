# ADR 0207：消息表情回应——三列唯一表 · 全量替换帧 · 纯人类元数据

- 状态：Accepted
- 引入：M80-B（2026-09-22）
- 相关：[server/src/store/reactions.ts](../../server/src/store/reactions.ts)、[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[client/src/components/chat/MessageReactions.tsx](../../client/src/components/chat/MessageReactions.tsx)、[server/tests/m80-reactions.test.ts](../../server/tests/m80-reactions.test.ts)

## 背景

群聊里「收到 / 同意 / 点赞」必须发整句——刷屏且触发语义噪音（team 会话 auto 模式下还会误唤起 AI）。消息模型无 reactions 字段，悬停工具条只有消息操作。需要一种「挂在本条消息上、不产生新消息」的轻量表态。

## 决策

1. **存储单表**（迁移 v28）：`message_reactions(message_id, user_id, emoji)` 三列联合主键（`message_id` 外键级联删除 + 索引）；不建独立栈、不引入消息行之外的第二套聚合结构。
2. **API 挂载于会话子资源**（复用既有会话守卫做读 / 写权限判定）：`PUT /api/sessions/:id/messages/:messageId/reactions { emoji }` 挂（幂等）、`DELETE ...?emoji=` 摘（仅本人，query 传参兼容客户端无 body 通道）。权限 = 会话写级成员（viewer 403 由守卫统一；兼容模式无账号拒绝——reactions 需要用户身份，单用户模式无观众）。软限：同一条消息同用户 ≤8 种（幂等重复挂同 emoji 不占额，超限 429）；emoji 形态经 `isEmojiLike` 校验（ADR 0206，非法 400）。
3. **投影与广播**：消息投影随行 `reactions: Array<{ emoji, count, userIds, mine }>`（挂载于 GET `/sessions/:id` 与相关消息返回，批量聚合 `summaryForMessages`）；变更广播 `notify:reaction` **全量替换帧**（单消息体量小，免 diff 与乱序合并）；帧内 `mine` 不按接收方区分——客户端按 `userIds.includes(本人)` 本地推导，与投影口径一致。
4. **语义边界（纯人类元数据）**：不进 LLM 上下文装配（assembler 零改动）、不触发 Run、不计未读；agent 消息同样可被挂回应（「这条答得好」场景）。契合 M79 的「一切皆会话 / 零平行栈」红线。
5. **入口与渲染**：气泡悬停工具条「表情回应」按钮（快捷 6 连 👍❤️😂🎉👌🙏 + 「更多」唤起 compact 完整面板；toggle 语义：再点自己已挂的 = 摘除）；气泡下方聚合条 `[👍 3]`（自己挂过高亮，悬停显示回应者名单）；viewer 只读不渲染入口（服务端 403 同口径兜底）。

## 被否决的方案

- **独立 reactions 栈 / 新 WS 主题**：与 M79「零平行栈」红线冲突，且消息行投影已能承载（单消息体量小）。
- **diff 增量帧（+1/-1）**：客户端需维护合并状态机，乱序 / 重连场景易漂移；全量替换帧简单且天然幂等。
- **reactions 进 LLM 上下文**：情绪噪音污染 prompt；人类元数据与人类署名同层即可（agent 无感知必要）。
- **图片表情 / 表情包**：同 ADR 0206（v1 边界外）。

## 边界与后续

- 多用户模式功能：兼容模式（无账号）整体隐藏入口、API 拒绝；UI 与权限口径一致；
- 客户端：`toggleReaction` 挂 / 摘后 `patchMessage` 就地更新；广播帧 `notify:reaction` 幂等 upsert；
- 测试：`server/tests/m80-reactions.test.ts`（挂 / 聚合 / 幂等 / 摘除全链 + 广播帧；非法 400 / 软限 429 / 他人摘除不影响我）；E2E auth 项目 `m80-reactions.spec.ts`（双人互挂 / 实时聚合 / 摘除）。
