# ADR 0197：在线状态可见域扩展与会话内容隐私语义固化（M79-G）

- 状态：Accepted
- 引入：M79-G（2026-09-20）
- 相关：[server/src/realtime/presence-recipients.ts](../../server/src/realtime/presence-recipients.ts)、[server/src/index.ts](../../server/src/index.ts)、[server/src/auth/access.ts](../../server/src/auth/access.ts)、[server/tests/m79-privacy.test.ts](../../server/tests/m79-privacy.test.ts)、[client/src/components/chat/OnlineDot.tsx](../../client/src/components/chat/OnlineDot.tsx)

## 背景

- M79-C 将 presence 可见域收窄为「好友面（v1）」（ADR 0193 §决策 4）；设计原案为「好友 ∪ 同会话成员」——群 / 私聊协作场景中非好友协作者看不到对方在线态，与「协作者需要彼此可见」的产品语义脱节；
- 设计文档曾把「admin 对全部会话（含私聊）可见」记为已知边界，并预留 `DM_ADMIN_VISIBLE` 开关；**代码复核表明该表述不成立**：`AccessService.ownsOrAdmin` 仅覆盖孤儿行兜底，`listForUser` 严格 owner ∪ 共享成员，WS `canSubscribe` 同规——admin 对成员私有会话（team / direct）详情 / 列表 / 搜索 / 订阅**本就 404 或过滤**。

## 决策

1. **presence 可见域 = 好友 ∪ 同会话人类成员**（收件人计算落 `createPresenceRecipients`：好友 ∪（主体所属每个会话的属主 + 全部人类成员）；去重、排除本人、不返回无关用户）；
2. **收件人计算独立成工厂**（`realtime/presence-recipients.ts`）——`index.ts` 的 `onFlush` 仅做遍历投递，隐私边界可被测试直接固化（m79-privacy 用例一）；
3. **客户端通用面**：`notify:presence` 除驱动好友列表在线点外，同步写 `ws-store.presenceMap`（userId → online；未广播 = 未知灰）；成员弹窗行 / @ 人类候选 / 联系人列表共用 `OnlineDot`（ContactsPanel 本地实现抽公共）；
4. **admin 无会话内容旁路——固化而非开关**：不引入 `DM_ADMIN_VISIBLE`（其前提「默认可见」不存在）；以 `m79-privacy.test.ts` 将既有语义固化为回归保护（admin 详情 / 写操作 404、列表仅自有、搜索无命中、WS 可见集不含；bob 反向对照 200）；文档更正边界表述；
5. **运维镜像**：operations.md §9 增「在线状态可见域」与「会话内容可见性」两行。

## 被否决的方案

- **保留 presence 仅好友面**：群 / 私聊协作中非好友不可见在线态，与成员弹窗 / 群聊产品语义冲突；同会话成员是介入协作前的「共同上下文」，隐私面收敛（同群全互通）已被群成员可见性与成员名单本身覆盖；
- **presence 全员可见**：隐私扩散（任意用户可探测活跃画像），否决维持；
- **`DM_ADMIN_VISIBLE` 开关（含默认 false）**：实现前提（admin 默认可见全部会话）与代码事实不符；引入开关等于为不存在的旁路增加配置面与语义分叉，收益为负；
- **收件人计算内联在 index.ts**：不可测（装配闭包），隐私边界无法回归固化。
