# ADR 0188：用户主题与三层投递——个人事件实时化（M79-A）

- 状态：Accepted
- 引入：M79-A（2026-09-20）
- 相关：[design.md §114](../design.md)、[docs/social-collab-design.md §9](../social-collab-design.md)、[server/src/ws.ts](../../server/src/ws.ts)、[server/src/store/inbox.ts](../../server/src/store/inbox.ts)、[client/src/stores/inbox-store.ts](../../client/src/stores/inbox-store.ts)、[server/tests/m79-realtime.test.ts](../../server/tests/m79-realtime.test.ts)

## 背景

- WsHub 主题仅「会话 id / `__` 全局前缀（admin-only）」：好友请求、被邀请、被 @ 等**个人事件没有实时通道**；
- M57 P2 的真实缺口：邀请只广播到会话主题——被邀请人此刻尚未订阅该会话，**只能刷新后才发现**（E2E 中 bob 需 reload 的根因）；
- 环形重放缓冲仅内存 200/会话，无用户维度投递记录：离线期间个人事件永久丢失。

## 决策

1. **用户主题 `u:<userId>`**：连接握手鉴权通过后服务端**自动绑定本人身份**（免客户端遗漏）；`canSubscribe` 仅本人可订，**admin 亦不可代订**；
2. **三层投递**：① WS 用户主题实时帧 `notify:inbox`（快路径）→ ② `user_inbox` 持久表（权威；每用户 seq 单调、保留期 30 天仅清已读）→ ③ REST `GET /api/inbox?since=`（重连 / 降级轮询 / 缺口补齐）；
3. **inbox 承载边界**：仅「跨会话个人事件」（好友请求 / 邀请 / @提及 / 持球）；**DM 与群聊逐条消息不入箱**（未读 + 消息 seq 已足够，防膨胀）；
4. **邀请实时化**：`shares.ts` / `chats.ts` 邀请路径经 `deliver` 注入投递 inbox（修复 M57 缺口）；
5. 客户端幂等合并（by item.id）+ **seq 缺口检测 → REST 补齐**；`u:` 前缀帧不走会话游标去重（seq=0）。

## 被否决的方案

- **个人事件只走 WS 不落库**：离线丢失、无重放权威、多端收敛无依据；
- **客户端自订用户主题**：漏订即静默丢事件（服务端自动绑定消除此类遗漏）；
- **DM 逐条消息入 inbox**：通知风暴与存储膨胀（未读体系已覆盖）。
