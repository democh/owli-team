# ADR 0193：在线状态——连接引用计数与好友面可见（M79-C）

- 状态：Accepted
- 引入：M79-C（2026-09-20）
- 相关：[server/src/realtime/presence.ts](../../server/src/realtime/presence.ts)、[server/src/ws.ts](../../server/src/ws.ts)、[server/src/index.ts](../../server/src/index.ts)、[client/src/stores/friends-store.ts](../../client/src/stores/friends-store.ts)

## 背景

- 联系人 / 邀请 / 协作缺「谁在线」判断；引入独立在线信令又需新协议与存储。

## 决策

1. **推导而非信令**：`online = 活跃 WS 连接引用计数 > 0`（多标签页 / 多端各自 +1；`onConnect/onDisconnect` 钩子挂 NotifyHub）；
2. **离线延迟广播**：最后一条连接关闭 → 延迟 30s 发出离线事件（吸收刷新 / 切页抖动；期间重连取消）；
3. **聚合节流**：变更事件按 `PRESENCE_AGGREGATE_MS=500` 聚合为批量帧 `notify:presence { users: [...] }`；
4. **可见范围 = 好友面（v1）**：仅向该用户的好友推送其在线变更（隐私最小面；「同会话成员」扩展后置——群聊成员不互见在线，防群内全互通）；
5. **投影**：好友列表 / 搜索命中随行 `online` + `lastSeenAt`（离线未广播前以本地状态为准）；
6. **单进程边界**：内存态、重启重建（首帧以快照对齐）；多实例 presence 列为演进项（ADR 0188 同族边界）。

## 被否决的方案

- **独立 presence 表 / 心跳协议**：连接表已是唯一事实源（推导零维护）；
- **全员可见在线状态**：隐私扩散（非好友可见活跃画像）；
- **即时离线广播**：刷新页面即闪「离线」的抖动体验。
