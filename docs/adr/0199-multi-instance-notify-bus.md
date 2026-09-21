# ADR 0199：多实例演进——共享通知总线与跨实例 presence（M79-L）

- 状态：Accepted
- 引入：M79-L（2026-09-20）
- 相关：[server/src/store/notify-bus.ts](../../server/src/store/notify-bus.ts)、[server/src/store/presence-instances.ts](../../server/src/store/presence-instances.ts)、[server/src/realtime/notify-bus-db.ts](../../server/src/realtime/notify-bus-db.ts)、[server/src/ws.ts](../../server/src/ws.ts)、[server/src/index.ts](../../server/src/index.ts)、[server/tests/m79-multibus.test.ts](../../server/tests/m79-multibus.test.ts)

## 背景

- M79-A/C 的实时通道（用户主题投递 / 会话帧 / presence）为**单进程内存态**（ADR 0188/0193 明示边界）：多实例部署时，帧只达本实例连接，presence 只见本实例计数；
- 三层投递的**权威层在 DB**（user_inbox / session_reads / 会话列表）——快路径（WS）跨实例缺失时可由 REST 快照补齐，因此总线只需承担「快路径传输」，无需引入新的权威协议。

## 决策

1. **总线只做跨实例传输，默认不启用**：`NOTIFY_BUS=memory`（默认）行为与现状逐字节一致；`NOTIFY_BUS=db` 时 NotifyHub 挂载 `DbNotifyBus`——本地下发保持现状，另写 `notify_bus` 行供其他实例消费（origin 排除防回环；远程条目走本地扇出路径分配本地 seq）；
2. **传输语义**：`kind='session'`（target=会话 id，各实例仅投给本地订阅者）/ `kind='user'`（target=userId，仅投给该用户的本地连接）；**不重放历史**——实例启动游标 = 当前 maxId（启动前无本地连接可投；重启窗口缺口由客户端断线重连 resync + REST 权威层补齐，与既有重连哲学一致）；
3. **延迟与清理**：轮询间隔 `NOTIFY_BUS_POLL_MS`（默认 400ms）= 跨实例投递延迟上限；行保留期 `NOTIFY_BUS_RETENTION_MINUTES`（默认 10；0 = 不清理）；维护轮 30s 一并做保留期清理；
4. **跨实例 presence（最终一致）**：`presence_instances` 表记录各实例「本用户连接计数」；离线广播前合并全局合计（`globalCount`，stale 行按 updated_at 过期忽略）——**其他实例仍有活跃连接时不广播离线**；实例 30s 心跳刷行（防长连不变误判 stale）；stale 行随维护轮回收。在线事件幂等重复可接受（客户端按 userId 覆盖）；
5. **观测**：`GET /api/ws/stats` 增 `bus`（mode / instance / published / received）；
6. **实例标识**：`INSTANCE_ID`（缺省 `hostname:pid`）——presence 行与总线 origin 共用。

## 被否决的方案

- **引入外部消息中间件（Redis / NATS）**：部署复杂度与运维成本不成比例；DB 轮询在目标规模（小团队协作）内延迟与吞吐足够，且复用既有清理链与备份面；
- **总线承担权威（重放跨实例历史）**：与三层投递权威层重复；跨实例游标（客户端在实例间漂移）语义复杂且无收益——REST 快照已是既定补齐路径；
- **presence 立即广播离线（不做全局合并）**：多实例下「A 断开但 B 在线」将误报离线；
- **强制所有部署启用总线**：单实例场景徒增每帧一次 DB 写；默认 memory 保零回归。

## 边界与后续

- 客户端在实例间漂移重连时，会话游标（本地 seq）不通用——重连 resync 全量快照覆盖（既有行为）；
- presence 为**最终一致**（≤心跳/轮询窗口），非强一致；
- 单进程 memory 模式所有新组件不实例化（presenceInstances / bus store 均 undefined）——单实例零开销。
