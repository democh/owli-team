# ADR 0192：好友图与隐私——单行双向状态机（M79-C）

- 状态：Accepted
- 引入：M79-C（2026-09-20）
- 相关：[docs/social-collab-design.md §11](../social-collab-design.md)、[server/src/store/friends.ts](../../server/src/store/friends.ts)、[server/src/routes/friends.ts](../../server/src/routes/friends.ts)、[client/src/components/contacts/ContactsPanel.tsx](../../client/src/components/contacts/ContactsPanel.tsx)

## 背景

- 无任何社交关系表；M57 的会话共享按用户名邀请（无前置关系图）；私聊 / 邀请 / 可见性缺关系基座。

## 决策

1. **单行双向**（迁移 v23）：`friend_links(user_a < user_b 字典序, state, requested_by, blocked_by, message)`；UNIQUE(user_a,user_b)；
2. **状态机**：无关系 ──request──▶ pending ──accept──▶ accepted ──remove──▶ 无关系（行删除）；reject = 删行（可再申请）；block = 覆盖为 blocked（隐含解除）；unblock 仅拉黑方（回无关系）；
3. **视角关系态**：`pending-in` / `pending-out` 由 `requested_by` 推导（服务端视图，客户端只用 `relation` 字段）；
4. **主动作分流**（搜索 / 邀请面板）：none→加好友 · pending-out→已申请 · pending-in→接受 · accepted→私聊；重复 / 反向并存 / 已好友给出明确文案（409）；
5. **隐私**：拉黑**四面切断**（请求 / 搜索双向 / 好友列表 / 私聊创建；被拉黑方仅见「对方设置了隐私限制」，不暴露拉黑事实）；`searchable=false` 仅精确 username 命中（存在性最小暴露）；`allowFriendRequests` 开关（user prefs）；
6. **限流**：请求日限流 `FRIEND_REQUEST_DAILY_LIMIT=20`（429 文案含上限值）；搜索 30 次/分/用户（滑动窗口）；
7. **通知**：请求 / 接受经 inbox 实时到达 + `notify:friends-changed` 双方连接；全部动作落 `audit_log`（friend.*）。

## 被否决的方案

- **双行关系表（A→B / B→A 各一行）**：状态同步复杂、无单点真相；
- **接受前可见对方资料详情**：存在性最小暴露原则；
- **解除好友即删历史会话**：历史协作链断裂（会话保留可读写，关系仅约束新建私聊 / 邀请候选）。
