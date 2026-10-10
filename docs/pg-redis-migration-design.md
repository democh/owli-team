# PostgreSQL 迁移与 Redis 实时层——多实例演进实施总案

> 状态：**方案稿（待决策，不实施）**。决策推进时按惯例：登记专项编号 → 落 ADR（含 ADR 0199 复议标注）→ 收录 design.md → 回写评估报告状态行。
> 编号基线（2026-10-04 仓库快照）：ADR 至 **0222** · design.md 至 **§126** · 里程碑至 **M85** · agents/CHANGELOG **v98+** · 迁移定义 **v27**（本机应用至 v26）。收录 / 落档时按惯例全仓复核（M / ADR / § / CHANGELOG 独立）。
> 修订：v1 初稿（2026-10-04）· v1.1（同日，经确认）：「**SQLite 彻底退役（最终形态）**」——不做双后端 / SQLite 测试矩阵 / 本地 SQLite 模式；P1「先异步化」作为施工过渡批保留；测试基建定为**全量真实 pg**（评估报告 §4.7 A 方案）。
> 动机（已确认）：**多实例 / 云部署**。
> 关联：[db-migration-assessment.md](db-migration-assessment.md)（评估稿；本方案承袭其分期与实测基线，并在 §4.2 修正两处）· [ADR 0018](adr/0018-sqlite-persistence.md)（SQLite 持久化）· [ADR 0047](adr/0047-vector-memory-sqlite-vec.md)（sqlite-vec）· [ADR 0199](adr/0199-multi-instance-notify-bus.md)（多实例通知总线——**本方案第 3 节即其复议后的落地方案**）· [ADR 0193](adr/0193-presence-by-connection-refcount.md)（presence 引用计数）。
> 前置结论：① 权威存储选 **PostgreSQL 全量替换**（弃 MySQL，理由见评估报告 §1）；② 实时层跨实例传输改用 **Redis Pub/Sub**（复议 ADR 0199「否决外部中间件」的旧前提）；③ 两条改造**解耦分期、可并行**——Redis 轨道不阻塞于 pg，pg 轨道不依赖 Redis；④ **SQLite 彻底退役**（经确认）：最终形态 pg 唯一，SQLite 仅存在于 P1 施工过渡期与切换前冻结归档（非运行时依赖）。

---

## 目录

1. 目标与范围　2. 总架构（改造后）　3. 轨道 R：Redis 实时层　4. 轨道 P：PostgreSQL 迁移　5. 多实例收口　6. 改动面总表　7. 分期编排与人日　8. 测试与验收　9. 部署与运维　10. 风险与回滚　11. 决策后程序
附录 A：Redis 数据结构与命令　附录 B：新增与调整的环境变量

---

## 1. 目标与范围

### 1.1 两类改造与分工

| 平面 | 现状 | 目标 | 职责边界 |
| --- | --- | --- | --- |
| **权威存储面** | SQLite（node:sqlite 同步、单文件） | PostgreSQL（异步 + 连接池；pgvector / pg_trgm） | 所有持久数据的唯一真相源：会话 / 消息 / 用户 / 记忆 / 向量 / 运行轨迹 / 收件箱 / 已读水位 |
| **快路径传输面** | 进程内 NotifyHub + `NotifyBusTransport`（memory 缺省 / db 轮询） | 新增 **Redis Pub/Sub transport**；presence 走 Redis TTL | 跨实例 WS 帧扇出、在线状态；**不承担权威**——断线与缺口一律由 REST 权威层 + 客户端 resync 补齐（与 ADR 0199 哲学一致） |
| **前端协议面** | `/ws` 帧协议 + REST 补齐 | **不变** | 客户端零改动（帧类型 / 主题 / 游标语义保持） |

### 1.2 非目标（明确不做）

- 不做 MySQL（评估报告已决）；
- 不做消息本体 Redis 化——messages / inbox / 已读水位的权威在 DB（Redis 只做快路径与短态）；
- 不做降级轮询重放缓冲（`NotifyHub.buffers`）外迁——本地 seq 与缓冲强绑定，外迁改变补发语义；
- 不做跨实例 seq 全局化——已评估否决（分配顺序 ≠ 到达顺序，收益被 REST 兜底覆盖）；
- **SQLite 彻底退役**：最终形态 pg 唯一——不做双后端（SQLite 本地 + pg 生产）、不做 SQLite 测试矩阵、不保留 SQLite 本地运行模式；SQLite 仅存在于 P1 施工过渡期（现有库上完成异步化）与切换前冻结归档；
- v1 不做 Redis Streams / NATS / 消息队列替代嵌入队列（嵌入队列交 pg `SKIP LOCKED`）；
- v1 不做 Run SSE 的 Redis 桥（粘性路由优先，见 §5）；不做「正在输入」指示器（无产品需求支撑，仅列扩展位）。

---

## 2. 总架构（改造后）

```
┌──────────── 实例 A ────────────┐        ┌──────────── 实例 B ────────────┐
│ REST/WS(NotifyHub 本地扇出)     │        │ REST/WS(NotifyHub 本地扇出)     │
│   │ publish/publishToUser      │        │   │ publish/publishToUser      │
│   └─ transport ──┐             │        │   └─ transport ──┐             │
└──────────────────┼─────────────┘        └──────────────────┼─────────────┘
                   │ PUBLISH owli:notify                     │ SUBSCRIBE
                   ▼                                         │
              ┌───────────── Redis（瞬态） ◄─────────────────┘
              │  快路径：帧扇出 · presence TTL · （可选）限流
              └─────────────┬───────────────┘
                            │ 都不承载权威
              ┌─────────────▼───────────────┐
              │  PostgreSQL：唯一权威存储     │
              │  会话/消息/记忆/向量/轨迹     │
              └─────────────────────────────┘
```

群聊帧链路（改造后，与现状逐段对照）：

| 段 | 现状（NOTIFY_BUS=db） | 改造后（NOTIFY_BUS=redis） |
| --- | --- | --- |
| 本地下发 | `fanoutSession` 本地扇出（不变） | 不变（含本地 seq 分配 + 重放缓冲） |
| 跨实例传输 | 写 `notify_bus` 行 → 各实例 400ms 轮询（origin 排除） | `PUBLISH owli:notify` → 各实例订阅即达（origin 排除防回环） |
| 投递延迟 | ≤ `NOTIFY_BUS_POLL_MS`（默认 400ms） | 亚毫秒～毫秒级（同机房） |
| 不可达窗口 | 轮询缺行由 REST 补齐 | 订阅断线窗口由 REST 补齐（语义等价） |
| presence | `presence_instances` 表 + 心跳 + stale 回收 | Redis 带 TTL 的计数 key（stale = 自然过期） |
| 重放 / 游标 | 无（不重放历史） | 无（同语义；`buffers` 仍在本地） |

---

## 3. 轨道 R：Redis 实时层（新增）

### 3.1 R1 通知总线 transport（核心，0.5–1 人日）

**接入方式：实现既有 `NotifyBusTransport` 接口**（[ws.ts](../server/src/ws.ts) `publish / start / dispose / stats`）——`NotifyHub` 本体与全部调用点（`publish` / `publishToUser` / `revokeSession` / `kickUser`）**零改动**，群聊帧、用户主题帧（私聊 / 收件箱 / 已读 / presence / 关系变更）、ACL 帧（revoke / kick）全部一处生效。

| 项 | 决策 |
| --- | --- |
| 依赖 | `ioredis`（`server/package.json` 新增；重连 / 离线队列 / 自动重订阅成熟） |
| 连接 | 双连接：`pub`（发布）+ `sub`（订阅）；订阅连接按 Redis 协议不可复用普通命令 |
| channel | 单 channel（默认 `owli:notify`，可配）；payload = `NotifyBusEntry` + `origin` 字段 JSON。**不分片**——小团队规模帧量低；未来需要时按 target 哈希加后缀（记入扩展位） |
| 防回环 | 订阅端过滤 `origin === cfg.instanceId`（与 DbNotifyBus 同语义） |
| publish（同步签名兼容） | fire-and-forget：`void pub.publish(...).catch(记 dropped + warn)`；`enableOfflineQueue=true`（断线期间缓冲发布，重连补发；溢出丢弃计入 stats） |
| start（异步订阅） | 内部 `void sub.subscribe(channel)`；ioredis 重连后自动恢复订阅。`ready` 状态进 stats；订阅未就绪期间本实例发布照常（发布不依赖订阅） |
| dispose | 双连接 `quit()` |
| stats | `{ mode: 'redis', instance, published, received, dropped, reconnects, ready }`（`GET /api/ws/stats` 的 `bus` 字段直接可用） |
| 丢失语义（声明） | Pub/Sub 无持久无重放 = 与「启动游标=maxId 不重放」等价；断线窗口的补齐责任在 REST 权威层（客户端重连 resync 已就绪）——**不做运行时降级切换**（Redis 挂了不自动切 db 总线，避免语义混乱） |

新增与修改落点：

| 文件 | 动作 |
| --- | --- |
| `server/src/realtime/notify-bus-redis.ts` | **新增**（约 100 行，接口与 notify-bus-db.ts 对齐） |
| `server/src/config.ts` | `notifyBus: 'memory' \| 'db' \| 'redis'`（枚举扩一值）；新增 `redisUrl`（`REDIS_URL`）、`redisNotifyChannel`（可选） |
| `server/src/index.ts` L288 段 | 装配分支扩三态；`presenceInstances` 按模式选择 Redis / DB / 无 |
| `.env.example` | 新增项（附录 B）；`NOTIFY_BUS` 注释更新 |
| `server/src/realtime/notify-bus-db.ts`、`store/notify-bus.ts` | **保留**（无 Redis 环境的降级/实验路径；pg 落地后其清理链随 `notify_bus` 表退役，ETL 不迁该表） |
| `server/tests/` | 新增 transport 契约测试（见 §8）；`m79-multibus.test.ts` 改造为**三 driver 参数化**（memory / db / redis，redis 用真实服务或测试替身） |

### 3.2 R2 跨实例 presence（0.5–1 人日）

现状 = `presence_instances` 表（每实例每用户计数行 + 心跳刷 updated_at + stale 回收）。Redis 版把「stale 判定」交给 **TTL**：

| 项 | 决策 |
| --- | --- |
| key 设计 | `owli:presence:<userId>:<instanceId>` → value = 本实例连接数；**TTL = 90s**（> 2×心跳 30s）。实例死亡 → 其全部 key 自然过期，无需 prune |
| 写入 | connect/disconnect 时 `SET ... PX 90000`（count=0 → `DEL`）；与现状 `setCount` 同语义 |
| 心跳 | 每 30s 对本实例活跃用户批量 `SET ... PX 90000`（数据源 = `PresenceTracker.userIds()`，index.ts 已有） |
| globalCount | `SCAN MATCH owli:presence:<userId>:* COUNT 100` 游标迭代求和（每用户 key 数 = 实例数，量级个位数） |
| pruneStale | 退役（TTL 承接）；维护轮只保留心跳 |
| 接口 | `PresenceInstanceStore` 方法 Promise 化（或新类 `PresenceRedisStore` 同接口）——**本项是 Redis 轨道唯一的接口签名变化** |

**离线门控异步化（唯一结构影响点）**：现状 `PresenceTracker.onFlush` 为同步回调（[presence.ts](../server/src/realtime/presence.ts) `flush()`），内部同步查 `globalCount` 决定离线帧是否广播。改造：

1. `onFlush` 类型放宽为 `(events) => void \| Promise<void>`，`flush()` 内 `void Promise.resolve(result).catch(() => {})`（状态机不因投递失败回滚，保持现有容错哲学）；
2. index.ts 的 `onFlush` 实现改 async：对 `online === false` 的事件先 `await globalCount(userId)`，> 0 则不广播（防「A 断开但 B 在线」误判——语义与 db 模式逐字一致）；
3. 顺序说明：离线帧本就延迟 30s 广播 + 500ms 聚合窗口，异步化不改变最终一致性；`dispose` 时 pending 异步链自然结束（无句柄泄漏）。

### 3.3 R3 部署与压测（0.5–1 人日）

- `docker-compose.yml` 新增 `redis` service：`redis:7-alpine`，**关闭持久化**（`--save "" --appendonly no`）——总线与 presence 均为瞬态数据；
- 本机双进程多实例压测脚本（复用 `m79-multibus.test.ts` 的双实例夹具模式，driver 换 redis）：跨实例帧延迟采样、origin 防回环、断线重连补发、presence 收敛；
- `docs/operations.md` 增 Redis 运维段（无状态、可随时重启、多实例共享同一实例/集群）。

### 3.4 R4 可选扩展（按需，各 0.5–1 人日）

| 项 | 落点 | 说明 |
| --- | --- | --- |
| 发送/登录限流 Redis 化 | `server/src/middleware.ts`（`express-rate-limit` 挂 `rate-limit-redis`） | 多实例下必须（否则每实例独立计数）；单实例可不动 |
| 「正在输入」指示器 | ws.ts 新帧 + `client/src/stores/ws-store.ts` + Composer | 扩展位：高频可丢不落库，直接复用 transport，客户端为唯一改动面 |
| 总线分片 | `notify-bus-redis.ts` channel 后缀 | 仅当帧量压测暴露瓶颈时 |

---

## 4. 轨道 P：PostgreSQL 迁移（承袭评估报告）

### 4.1 分期承袭（人日与门禁以评估报告 §4/§7/§9 为准）

| Phase | 内容 | 人日 |
| --- | --- | --- |
| P0 前置验证 | ALS「当前事务连接」原型 + kv/users 试点；pg_trgm / pgvector 中文影子评测；docker pg 跑通 v1–v27 迁移 | 2–3 |
| P1 存储层异步化 | **现有库上施工（过渡批，非保留路线；行为零变化）**：`AppDb` async + ALS 事务 + 365 方法 Promise 化 + 63 消费文件级联 + 测试 await 化，全绿独立验收 | 8–12 |
| P2 方言层与 pg 实现 | `DbDialect` + pg 驱动实现 + 27 版迁移重写 + `seq` 回填 + `RETURNING`；复用 `connections/db/postgres.ts` 的池/参数/行清洗模式 | 3–5 |
| P3 扩展替换与 ETL | pg_trgm（FTS）、pgvector（向量，机制净删）、`EmbedQueueStore.claim` 改 `FOR UPDATE SKIP LOCKED`、ETL 双跑校验（46 表行数 + 哈希） | 6–9 |
| P4 多实例收口 | 见 §5（通知项由轨道 R 承接） | 4–9 |
| P5 切换与回滚 | 生产切换窗口 + 切换前旧库冻结归档 + 回滚演练 | 含在 P3/运维面 |

### 4.2 相对评估报告的两处修正

1. **§5-1「DbNotifyBus 换 pg 后才真正可用」论证被本方案替代**：跨实例实时层改由 Redis 承接后，pg 的必要性回归为「共享权威存储 + 写并发 + pgvector / pg_trgm」——`NOTIFY_BUS=db` 不再是 pg 的前置理由；P4 压测目标改为 **`NOTIFY_BUS=redis` 双实例**；`notify_bus` 表不进入 ETL。
2. **测试基建（已确认：全量真实 pg，评估报告 §4.7 A 方案；不做 B 双后端矩阵）**：CI 增加服务容器——R1 起可选加 `redis:7`（transport 集成测试）；P2 起加 `pgvector/pgvector:pg16`（或 `postgres:16` + 扩展安装），隔离沿用 P0 决策（每测试 schema / 事务回滚）。P1 期间测试仍跑现有库（过渡批属性），P2 起全部切换真实 pg——SQLite 测试面随 P1 结束退役。

### 4.3 实现要点补充（相对报告的增量）

- `AppDb` 目标形态（P1）：全方法 `Promise` 化；`tx` 回调改 async 且经 AsyncLocalStorage 绑定「当前事务连接」，事务内禁止裸连接调用；stmt 缓存改每连接缓存（或去缓存）；
- 关键机制（事务语义 / rowid→seq / 时间戳 TEXT 保留 / LIKE 大小写）执行评估报告 §4.3–4.5 与 §8 风险表，不另行展开；
- ETL 脚本新增于 `server/src/scripts/`（沿用 `migrate-json.ts` 幂等模式），映射勾稽 = 46 普通表行数 + 关键字段哈希 + 向量 BLOB→`vector` 字面量逐条校验。

---

## 5. 多实例收口（整合评估报告 §5，通知项已由轨道 R 承接）

| # | 状态面 | 方案 | 落点 | 人日 |
| --- | --- | --- | --- | --- |
| 1 | 通知 / 会话帧 / presence | **轨道 R**（Redis transport + TTL presence） | §3 | 1.5–3（已计） |
| 2 | 定时任务 | **CAS 乐观抢占**（首选）：`due()` 候选 → `UPDATE scheduled_tasks SET next_run_at=? WHERE id=? AND next_run_at=?` changes>0 才触发；备选 pg advisory lock / Redis `SET NX` 租约 | `schedule/service.ts` tick + `store/schedules.ts` | 1–2 |
| 3 | 共享文件存储 | 共享卷（NFS/EFS）挂载治理（workspace + data 子目录）；对象存储演进后置 | 部署面 | 2–4 |
| 4 | 实例亲和 | 网关粘性路由（user/session hash）；Run 观察流保持进程内 + REST/DB 轨迹补齐降级 | 网关 / 文档 | 1–3 |
| 5 | 密钥一致性 | 共享 `CONNECTION_SECRET_FILE` 或 `CONNECTION_SECRET_KEY` 环境变量（配置项已存在） | 部署面 | 0.5 |

> §5-2 的 CAS 改造**只依赖单语句原子性**，在 SQLite 上即可先行完成与验收（不绑定 pg/Redis），是 P4 中最先可做的一批。

---

## 6. 改动面总表（文件级）

### 6.1 轨道 R（新增 / 修改 / 退役）

| 类型 | 文件 | 内容 |
| --- | --- | --- |
| 新增 | `server/src/realtime/notify-bus-redis.ts` | Redis transport 实现 |
| 新增 | `server/src/store/presence-redis.ts` | presence Redis 实现（同接口 Promise 化） |
| 新增 | `server/tests/*redis*.test.ts` | 契约 + 双实例集成测试 |
| 修改 | `server/src/config.ts` | `notifyBus` 三态 + `redisUrl` + `redisNotifyChannel` |
| 修改 | `server/src/index.ts` | 装配分支；presence 异步门控；维护轮（心跳保留 / prune 退役） |
| 修改 | `server/src/realtime/presence.ts` | `onFlush` 允许异步返回 |
| 修改 | `server/src/ws.ts` | 无（transport 接口不变——仅注释提及 redis 模式） |
| 修改 | `server/package.json` | `ioredis` |
| 修改 | `docker-compose.yml` / `.env.example` / `docs/operations.md` | 服务与配置面 |
| 修改（可选） | `server/src/middleware.ts` | 限流 store |
| 保留待退役 | `server/src/realtime/notify-bus-db.ts`、`server/src/store/notify-bus.ts`、`store/presence-instances.ts` | pg 落地后随表退役；ETL 不迁 `notify_bus` / `presence_instances` |

### 6.2 轨道 P（文件级落点汇总，详见评估报告 §2/§4）

| 层 | 落点 |
| --- | --- |
| 存储内核 | `server/src/store/db.ts`（async + ALS + 池） |
| 迁移 | `server/src/store/migrations.ts`（27 版方言移植）+ pg 迁移器 |
| Store 层 | `server/src/store/*.ts`（38 文件 / 365 方法） |
| 消费方 | `server/src/{routes,orchestration,tools,schedule,memory,embeddings}/**`（63 文件 await 级联） |
| 向量 / FTS | `server/src/memory/vectors.ts`、`store/memory-vectors.ts`、`store/sessions.ts`、`store/memory.ts` |
| 配置 / 部署 | `server/src/config.ts`（`DB_FILE` → pg 连接配置）、`docker-compose.yml`、`.env.example`、CI |
| 测试 / ETL | `server/tests/**`（122 文件）、`server/src/scripts/`（新增 pg ETL） |
| 文档 | `docs/operations.md`（备份改 pg_dump）、`README.md`（部署段）、本方案 §11 回写项 |

---

## 7. 分期编排与人日

两条轨道**可并行**（互不依赖）；推荐先做轨道 R（小、独立、即时收益），P1 异步化与 R1–R3 可同期双线：

| 批次 | 内容 | 依赖 | 人日 |
| --- | --- | --- | --- |
| R1 | Redis transport + 配置 + 装配 + 契约测试 | 无 | 0.5–1 |
| R2 | presence Redis 化 + 门控异步化 | R1 | 0.5–1 |
| R3 | compose / 运维 / 双实例压测 | R1–R2 | 0.5–1 |
| P0 | 前置验证（原型 + 影子评测 + 迁移跑通） | 无 | 2–3 |
| P1 | 存储层异步化（现有库上施工、独立验收；过渡批） | P0 | 8–12 |
| P2 | 方言层 + pg 实现 + 迁移重写 | P1 | 3–5 |
| P3 | pg_trgm / pgvector / SKIP LOCKED / ETL | P2 | 6–9 |
| P4 | 多实例收口（CAS 定时 / 共享卷 / 粘性路由 / 密钥） | P3 + R3 | 4–9 |
| 融合 | 双实例（pg + Redis）联调压测与切换演练 | 全部 | 含 P4/P5 |
| R4（可选） | 限流 Redis 化 / 扩展位 | R3 | 0.5–2 |
| **合计** | | | **约 26–44（核心）** |

---

## 8. 测试与验收

**通用门禁**（每批）：四包 typecheck / lint 0 错 / server 全测 / client 全测 / build ✓ / E2E gold 双跑全绿；`npm run eval` 基线回归。

| 阶段 | 验收 |
| --- | --- |
| R1 | transport 契约测试三 driver 全绿（跨实例投递 / origin 防回环 / 不重放 / stats）；真实 Redis 集成测试（CI service 或本地）；E2E 不受影响（无 Redis → memory 缺省零变化） |
| R2 | presence 计数合并 / TTL 过期（模拟实例死亡）/ 离线门控三态（本实例 / 他实例 / 全部离线）；`m79-realtime` 回归全绿 |
| R3 | 双实例压测：跨实例帧 P95 ≤ 100ms（预期 <10ms）；presence 收敛 ≤ 2 分钟；Redis 重启后自动重订阅恢复 |
| P1 | 异步化后既有测试仅加 await 语义等价通过；写延迟 P95 不回归 |
| P3 | ETL 行数 / 哈希双向一致；FTS / 向量召回 Top-K 影子对比达标；`memory:reindex` pg 上全量重建成功 |
| P4 | 双实例 + pg + Redis：定时任务 N 轮零重复触发；实例杀死后另一实例实时层接管（帧不丢由 REST 补齐验证） |

---

## 9. 部署与运维

- `docker-compose.yml`：`app` + `postgres`（pgvector 镜像）+ `redis`（瞬态）三 service；compose 网络内互通，端口不对外；
- Redis 无持久化、无密码要求（内网）；生产如需远程访问加 `requirepass` + 网络隔离（记入 operations.md）；
- 备份面：`pg_dump` 例行 + `data/` 文件面不变；切换前旧库冻结归档（纯备份文件、非运行时依赖，稳定期后清理归档）；
- CI：verify / e2e / agents 三 job 不变（mock 无外部依赖）；新增集成测试 job（redis / pg service 容器）；
- 回滚：R 轨道 = 配置级（`NOTIFY_BUS` 切 `memory`/`db` 或清 `REDIS_URL`，无数据迁移）；P 轨道 = 冻结归档回切（限切换窗口内；稳定期后回滚面收敛为 pg 快照）。

---

## 10. 风险与回滚

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R-1 | Redis 单点故障（多实例下帧投递缺失） | 中 | 缺失面 = 快路径；REST 权威层 + 客户端 resync 补齐；Redis 重启自动重订阅；不做运行时总线切换（语义可控） |
| R-2 | presence 异步化引入竞态（离线门控） | 中 | 门控语义逐字对照 db 模式写测试；聚合窗口 + 30s 离线延迟天然吸收 |
| R-3 | Pub/Sub 无持久被误当可靠通道 | 低 | 「不承载权威」写进接口注释与文档；统计 dropped 观测 |
| P-1 | 异步级联遗漏 / 事务原子性破防 | 最高 | 评估报告 R1/R2：typecheck 强制 + ALS 路由 + 并发交错专项测试 |
| P-2 | ETL 数据完整性 | 高 | 双跑校验 + 冻结副本 + 回滚演练 |
| P-3 | FTS / 向量召回质量回归 | 中 | LIKE 回退保留 + 影子 Top-K 评测 + 灰度开关 |
| 编号 | M / ADR / § / CHANGELOG 并发占用 | 低 | 开工前全仓复核（本稿基线见头部；ADR 0199 需 Amended 标注） |

---

## 11. 决策后程序

1. 全仓复核编号 → 登记专项编号（M 编号）与 ADR 编号（预计 2 条：① pg 迁移决策（承评估报告）；② Redis 实时层 + ADR 0199 Amended 标注）；
2. 落 ADR 文件 + `docs/adr/README.md` 索引同步；
3. 本方案收录 design.md（拟 §127+，收录时复核）+ 头部状态行回写；
4. 评估报告 `docs/db-migration-assessment.md` 回写：状态行 + §5-1 注记「由 pg-redis-migration-design §4.2 替代」；
5. 按 §7 分期实施，每批回写本方案批表与 design.md。

---

## 附录 A：Redis 数据结构与命令清单

| 用途 | 命令 | 键 / 说明 |
| --- | --- | --- |
| 帧扇出（发布） | `PUBLISH owli:notify <json>` | json = `{origin, kind, target, type?, runId?, payload}` |
| 帧扇出（订阅） | `SUBSCRIBE owli:notify` | 过滤 `origin === 本实例`（防回环） |
| presence 写入 | `SET owli:presence:<userId>:<instanceId> <count> PX 90000` | count=0 → `DEL` |
| presence 心跳 | `SET ... PX 90000`（批量） | 每 30s，数据源 = 本地活跃用户列表 |
| presence 聚合 | `SCAN 0 MATCH owli:presence:<userId>:* COUNT 100` | 游标迭代求和（每用户 key 数 = 实例数） |
| 限流（可选） | `INCR` + `PEXPIRE`（或 rate-limit-redis） | 多实例一致计数 |
| 服务启动 | `redis-server --save "" --appendonly no` | 瞬态数据，无持久化 |

## 附录 B：新增与调整的环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `REDIS_URL` | 空（未配置 = Redis 能力不可用） | 如 `redis://127.0.0.1:6379` |
| `NOTIFY_BUS` | `memory` | 扩为 `memory \| db \| redis`；`redis` 需 `REDIS_URL` |
| `REDIS_NOTIFY_CHANNEL` | `owli:notify` | 总线 channel（多环境隔离时可改） |
| `REDIS_PRESENCE_TTL_MS` | `90000` | presence key TTL（> 2× 心跳 30s） |
| `NOTIFY_BUS_POLL_MS` / `NOTIFY_BUS_RETENTION_MINUTES` | 不变 | 仅 `db` 模式使用；pg 落地后随模式退役 |

---

> **本文档为方案稿，不含实施承诺。** 决策推进：登记编号 → 落 ADR → 收录 design.md → 回写评估报告 → 按 §7 分期实施。
