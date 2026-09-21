# ADR 0201：群管理生命周期——退出 / 解散 / 留痕 / 改名归属（M79-AA）

- 状态：Accepted
- 引入：M79-AA（2026-09-20）
- 相关：[docs/social-collab-design.md §12.2/§12.3](../social-collab-design.md)、[server/src/routes/shares.ts](../../server/src/routes/shares.ts)、[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[client/src/components/sessions/ChatMembersDialog.tsx](../../client/src/components/sessions/ChatMembersDialog.tsx)

## 背景

- M79-D 设计（§12.2/§12.3）已定义群聊管理语义：成员「退出」（`POST /sessions/:id/leave`）、owner「删群 = 解散」（`DELETE /sessions/:id`）、owner「改群名」；
- 实施收口后仍有四处缺口：ChatMembersDialog 无退出 / 解散入口（chat 形态头部只开成员弹窗，ShareDialog 的退出入口对 direct/group 不可达）；退出 / 移出无群内系统事件条留痕（邀请有、退出没有）；群名 `PATCH title` 未做 owner 收紧（editor 亦可改，与设计 §12.3 不符）；解散广播 payload 为空（成员端统一提示「本会话已被删除」，不区分群聊）；
- `POST /sessions/:id/leave` 对 direct 亦放行，与设计 §12.2「私聊只有隐藏、不支持退出」不符（API 层可单方断开私聊）。

## 决策

1. **成员退出**：ChatMembersDialog（群）对非 owner 成员提供「退出群聊」（行内二次确认）→ 复用 `POST /sessions/:id/leave`；退出后失去访问（列表过滤 + 当前会话清空）、群历史对其他成员保留；direct 走 `400` 防护（只有隐藏，对方不受影响）；
2. **群主解散**：owner 提供「解散群聊」（行内二次确认）→ `DELETE /sessions/:id`（硬删除，所有成员失去访问、不可恢复；运行中禁止）；owner 不提供「退出」——转让 / 自动解散列为不做（隐式行为不可预期）；
3. **留痕**：退出 / 移出 append 一条 system 事件条（group：「X 退出了群聊 / A 将 B 移出了群聊」；team：「退出了协作 / 移出了协作」；direct 不适用）+ `notify:turn-end` 广播（同会话 upsert、跨会话列表预览——与消息广播同一口径）；
4. **改名归属**：group 群名（`PATCH title`）仅 owner（403「仅群主可修改群名称」）；`routeMode` 等其他字段维持 M79-E 权限矩阵（editor 可写）；team / direct 维持写闸门现状；
5. **解散广播**：`notify:session-deleted` payload 增 `kind`；客户端按 kind 区分「群聊已被解散」/「本会话已被删除」，toast 以 `session-deleted-<id>` 为 id 与操作者本地提示合并去重；
6. **入口收敛**：解散 / 退出主入口在「成员」弹窗（与移出 / 邀请同屏）；群聊重命名入口在会话列表行 hover（owner 可见）；兼容模式（multiUser=false）全部不渲染。

## 被否决的方案

- **群主退出 = 自动转让 / 自动解散**：转让不在 v1 范围，静默降级为解散会误伤成员；
- **解散 = 软删除（成员保留只读历史）**：与既有「删除会话」硬删语义分裂，形成双态会话；
- **群名放开给全体成员**：与设计 §12.3「owner 可改群名」不符；
- **退出以隐藏代替**：隐藏只是本人视图过滤，成员退出需要真正脱离（不再订阅 / 不再计未读）；
- **退出 / 移出走 inbox 逐人通知**：消息级事件条 + 会话订阅广播已足够（inbox 承载边界见 ADR 0188——防膨胀）。
