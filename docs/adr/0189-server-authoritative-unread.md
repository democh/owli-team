# ADR 0189：未读服务端化——session_reads 单一事实源（M79-A）

- 状态：Accepted
- 引入：M79-A（2026-09-20）
- 相关：[docs/social-collab-design.md §9.4](../social-collab-design.md)、[server/src/store/session-reads.ts](../../server/src/store/session-reads.ts)、[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[client/src/stores/ws-store.ts](../../client/src/stores/ws-store.ts)

## 背景

- 未读计数纯客户端（`ws-store.unread` 内存态、notify 驱动）：刷新即丢、多端不一致；
- DM / 群聊语境下未读必须跨端可靠（谁读了、哪个端读过）。

## 决策

1. **口径单一定义**：`unreadCount = count(messages where seq > last_read_seq and userId != 自己)`——含 agent 与 system 事件条；`last_read_seq` 以**消息 seq**为参照系；
2. **存储**：`session_reads(user_id, session_id, last_read_seq)`；上报**单调推进**（max(既有, 新值)，回退忽略防乱序）；
3. **上报路径**：WS `read` 帧（在线）/ `POST /api/sessions/:id/read`（降级 REST，读级放行——viewer 亦可）；客户端「进入会话 / 可见时消息集合变化 / 回到前台」自动上报；
4. **多端同步**：上报落库后 `notify:read-state` 广播该用户**其他连接**（不回执对方——无已读回执产品语义）；对端 `loadSessions` + 服务端 `unreadCount` 对账（ws 本地计数降级为显示缓存）；
5. **列表聚合**：`GET /sessions` 单查询聚合附带 `unreadCount`（避免 N+1）。

## 被否决的方案

- **维持客户端自算**：多端不一致、刷新即丢；
- **已读回执（向对方显示）**：隐私争议与群聊社交压力（v1 边界外）。
