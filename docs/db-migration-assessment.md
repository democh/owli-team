# 数据库迁移评估报告：PostgreSQL / MySQL（面向多实例与云部署）

> 状态：**评估稿（未决策，不实施）**。决策推进时按惯例登记专项编号并落 ADR（M 编号与 ADR 编号独立复核；**M80 已被表情体系专项预定**，ADR 已用至 **0205**、表情专项预占 0206–0208）。
> 动机（已确认）：**多实例 / 云部署**。
> 相关：[ADR 0018 SQLite 持久化](adr/0018-sqlite-persistence.md)、[ADR 0047 向量记忆 sqlite-vec](adr/0047-vector-memory-sqlite-vec.md)、[ADR 0199 多实例通知总线](adr/0199-multi-instance-notify-bus.md)、[ADR 0193 presence 连接引用计数](adr/0193-presence-by-connection-refcount.md)、[operations.md §9](operations.md)、[store/db.ts](../server/src/store/db.ts)、[store/migrations.ts](../server/src/store/migrations.ts)。

---

## 1. 结论摘要

1. **工作量：约 25–40 人日（单人 5–8 周）**；其中 **60–70% 不在 SQL 方言，而在「同步 API → 异步驱动」的全链路改造**。
2. **选 PostgreSQL，不选 MySQL**：`ON CONFLICT ... excluded.` 与现状近乎逐字兼容、`RETURNING` 可直接替代 `lastInsertRowid`、`pgvector`/`pg_trgm` 有成熟等价物；MySQL 需全量重写 upsert 且**无实用向量索引**（记忆召回能力硬缺失），成本再高 30–50%。
3. **迁 DB 是「多实例」的必要但不充分条件**：另有 4 项 DB 之外的收口缺口（定时任务互斥、共享文件存储、实例亲和、密钥一致性），增量约 5–10 人日。**目标总盘子 ≈ 30–50 人日**。
4. **关键工程建议：把「存储层异步化」与「换库」解耦**（先分批在 SQLite 上完成异步化并保持行为零变化，再挂 pg 实现），可显著压低风险与回滚成本。
5. **若目标只是「云上单实例」→ 不必迁**：现有 Docker 单容器形态已可云部署；迁移的收益仅体现在多实例/水平扩展、跨实例协作与写并发/事件循环解阻。

---

## 2. 现状盘点（全量实测）

| 维度 | 实测值 |
| --- | --- |
| 驱动 | `node:sqlite`（**同步 API**），全部经 `AppDb` 封装（[db.ts](../server/src/store/db.ts)），WAL + `busy_timeout=5000` + `foreign_keys=ON` |
| 表结构 | 普通表 **46 张**（含 `memory_vectors` 镜像表、`embedding_cache`）；另有 FTS5 族 12 表（`messages_fts` / `memory_fts` 及影子表）+ vec0 族 6 表（`memory_vec_index*`）+ 内部 1 表，`sqlite_master` 共 65 条 |
| 迁移 | 定义 **27 版**（本机库已应用 1–26；v27 spaces 待应用），含「重建表改 UNIQUE」历史模式 |
| Store 层 | **38 个文件 / 365 个公共方法 / 263 处** `.all/.get/.run/.exec/.stmt/.tx` 调用 |
| 消费面 | src 内 **63 个文件**引用 store（routes 7.0k 行、orchestration 5.1k 行，src 共 70.5k 行） |
| 事务 | 11+ 处 `db.tx(() => {...})` **全为同步回调**（含嵌套 savepoint），依赖单连接隐式事务态；`AppDb` 另有按 SQL 缓存的预编译语句表 |
| 运行时扩展 | 跨会话全文检索 = FTS5 trigram（[store/sessions.ts](../server/src/store/sessions.ts)、[store/memory.ts](../server/src/store/memory.ts)，**含 LIKE 回退**）；向量召回 = sqlite-vec vec0（[memory/vectors.ts](../server/src/memory/vectors.ts)，**memory_vectors BLOB 为唯一真相源 + JS 余弦兜底**） |
| 测试 | **122 个测试文件**；27 个直接 `openDatabase(':memory:')`；约 **971 处** store 方法调用、542 处底层 db 调用 |
| 数据面 | `data/app.db` 约 19MB；`data/` 另含 `avatars` / `canvas` / `browser-profile` / `logs` / `tc-raw` 等本地文件；会话工作区在 `workspace/` |
| 部署 | 单进程单容器（docker-compose 一个 service），`127.0.0.1:8787` 本地优先；DB 备份 = 拷贝 `data/app.db` |
| 既有资产 | ① `pg@8.23` / `mysql2@3.24` **已在依赖里**（连接中心 [connections/db/](../server/src/connections/db/) 210+234 行的 pg/mysql 连接器，可复用连接池/参数规范化/行清洗模式）；② **ADR 0199 多实例总线已落地**（`DbNotifyBus` + `presence_instances`，迁移 v26，默认 `NOTIFY_BUS=memory`）；③ `npm run memory:reindex` 重建脚本；④ `legacy-import` ETL 模式 |

---

## 3. 为什么多实例必须换 pg（动机验证）

| # | 事实 | 结论 |
| --- | --- | --- |
| 1 | SQLite 为单文件 + WAL，`-shm` 依赖共享内存；网络文件系统（NFS/EFS）上的 WAL 锁定不可靠 | 多实例**不能**共享一份 SQLite 文件 |
| 2 | ADR 0199 选择「共享 DB + 轮询总线」并**否决了 Redis/NATS**；总线前提是共享 DB | 现有 M79-L 总线在当前 SQLite 上是「无承载的铺垫」——**换 pg 后才真正可用** |
| 3 | `node:sqlite` 同步 API 阻塞事件循环；写并发仅单写者 | 迁移后两个根因同时解除（异步 + 真并发） |

---

## 4. 成本分项拆解（PostgreSQL 单方言，含人日）

### 4.1 存储层异步化（8–12 人日）——最大头

- `AppDb` 由同步 API 改为 async；**365 个 store 方法签名与实现**级联 Promise 化；
- **事务连接绑定（最高正确性风险）**：连接池下事务内的语句必须走同一连接——需要 `AsyncLocalStorage` 注入「当前事务连接」或显式 client 透传全部方法；嵌套 savepoint 逻辑重写；事务内**写后读**（如 `markSuperseded` 返回布尔、`remove` 返回 changes）语义逐一核对；
- 预编译语句缓存（`Map<sql, stmt>`）在池模型下失效，改为每连接缓存或去缓存；
- 同步回调 / 构造器内的 DB 调用点需人工排查（不可机械 await 化）。

### 4.2 消费方 await 级联（5–8 人日）

- **63 个 src 文件**加 `await` 并向上层传染（routes / orchestration / tools / schedule / memory / embeddings）；
- Express 处理器天然可 async，但 WS 消息处理、SSE 写路径、定时回调、工具实现需逐一核对时序。

### 4.3 SQL 方言移植（3–5 人日）

| 现状（SQLite） | 规模 | pg 方案 | 备注 |
| --- | --- | --- | --- |
| `ON CONFLICT ... excluded.` | 24 处 | **零改动** | MySQL 需全部改 `ON DUPLICATE KEY UPDATE` |
| `AUTOINCREMENT` | 6 表 | `GENERATED ALWAYS AS IDENTITY` | |
| `ORDER BY ... rowid` | 12+ 处 | 新增显式 `seq` 列（迁移回填） | 语义为「同秒并列的稳定排序」，不可丢 |
| `lastInsertRowid` | 4 处 | `INSERT ... RETURNING id` | pg 独有 |
| 27 版迁移 SQL | 全量 | 逐版移植；重建表模式可简化成 `ALTER TABLE ... DROP/ADD CONSTRAINT` | 需新 `schema_migrations`（pg 版） |
| 时间戳 TEXT（ISO）/ 0-1 布尔 | 全局 | **可原样保留**（存 text/int） | 建议保留以最小化改动，`timestamptz` 另案 |
| `LIKE` 大小写敏感性 | 47 处 | pg 用 `ILIKE`/`citext` 或保持 lower() 比较 | 需逐处核对语义 |

### 4.4 全文检索替换（2–3 人日）

- FTS5 trigram → `pg_trgm` GIN（中文子串匹配可行）；`MATCH ... ORDER BY rank` 需改为 `similarity()` 排序或 `tsvector`（中文分词需 zhparser，部署成本高）；
- 代码已有 **LIKE 回退**路径 → 可灰度、可降级，风险可控；召回质量需用真实 messages 数据做**影子对比评测**。

### 4.5 向量检索替换：pgvector（3–4.5 人日，**净简化**）

现状 = `memory_vectors` BLOB（唯一真相源，FK 级联）+ `memory_vec_index`（sqlite-vec vec0 镜像，bucket 分区，cosine）+ 探测/重建/降级机制（[memory/vectors.ts](../server/src/memory/vectors.ts)、[store/memory-vectors.ts](../server/src/store/memory-vectors.ts)）。**深度复核结论：pgvector 可行，且比现状更简单**：

| sqlite-vec 现状 | pgvector 方案 | 净效果 |
| --- | --- | --- |
| vec0 镜像（扩展可能缺失 → 需探测/重建/JS 降级） | 向量列直接进 `memory_vectors`（`vector` 类型），FK 级联自动清理 | **「规范副本 + 镜像」二元结构消失** |
| bootstrap 探测 → 校验 kv 标记 → 从 BLOB 全量重灌 + `readTableDim` | 无独立索引可丢 → 无需重建 | **整套 rebuild 机制删除** |
| `sqlite-vec` 原生二进制（平台 optional dep）+ `loadExtension` 通道 | 无（扩展装在 pg 服务端） | **原生依赖与平台脆弱性消失** |
| 换模型/维度 → vec0 表 DDL 重建（dim 不可改） | 无维度 `vector` 列 + `model/dim` 过滤，零 DDL | **换维流程简化** |
| `bucket` PARTITION KEY | 过滤列（或沿用 `scanBucket` 的 join `memory.scope/owner_id` 模式） | 等价 |
| `distance_metric=cosine`、`sim = 1 - distance` | `<=>` 余弦距离、`sim = 1 - (v <=> q)` | **语义逐字等价（f32 精度一致）** |

- **性能与索引决策**：记忆规模（桶内 ≤2 万行量级）下**精确 KNN（不加 ANN 索引）**即可（ms 级、确定性、召回优于 ANN）；v1 建议不建索引，以「无维度 `vector` 列 + `model/dim` 过滤」覆盖到 8192 维配置上限（类型上限 16000）。未来确需索引时注意上限：`vector` ANN 索引 ≤2000 维、`halfvec` ≤4000（3072 维模型需 halfvec 或保持精确扫描），且 HNSW 筛后召损需评估。
- **异步涟漪很小**：`VecIndex` 接口（put/remove/query/count/drop）仅 4 个消费文件（recall / service / queue / vectors），且 `MemoryService.recall` **已是 async**、`context/service.ts` 已在 await——并入 Phase 1 顺带完成，不构成额外批次。
- **多实例红利**：索引天然共享（不再每实例一份 vec0）；`EmbedQueueStore.claim` 可改 `FOR UPDATE SKIP LOCKED`，**消除跨实例重复嵌入**（现状 SELECT→UPDATE 跨实例存在竞态）。
- **ETL**：BLOB f32 → `vector` 字面量直接搬运（精度无损，**无需重调嵌入 API**）；`memory:reindex --force` 的「丢弃 vec0 重灌」语义随之退役。
- 注意事项：① 零向量保持「norm = 0 → 空结果」守卫（pgvector cosine 对零向量为 NaN）；② pg 侧需 `CREATE EXTENSION vector` 权限（官方 `pgvector/pgvector` 镜像与主流托管 PG 均支持）；③ 估算 3–4.5 人日（§4.8 仍记 2–3：旧机制整段删除属净减代码，差异含在总量取整内）。

> **MySQL 路线在此项无解**（8.x 无向量索引生态）→ 只能退回 JS 全扫描余弦，规模下不可接受——这是选 pg 的决定性理由之一。

### 4.6 数据 ETL + 运维（2–3 人日）

- 46 张普通表导出/导入脚本（可复用 `legacy-import` 的幂等模式）；行数 + 关键字段哈希双向校验；保留 SQLite 只读副本作回滚面；
- docker-compose 增加 pg service、备份策略（pg_dump/快照）、连接池参数、`DB_FILE`/`DATA_DIR` 等配置面重排。

### 4.7 测试与 E2E 基建（5–8 人日）

- 122 文件 / 971 处 store 调用需 await 化（与 4.1 同批）；
- 二选一：**A) 测试挂真实 pg**（每测试 schema 隔离/事务回滚，需容器化基建；E2E gold 需 pg 化）；**B) 双后端兼容**（SQLite 走测试、pg 走生产）→ 长期双方言维护，**全案成本 ×1.5–1.8**。

### 4.8 小计

| 项 | 人日 |
| --- | --- |
| 4.1 存储层异步化 | 8–12 |
| 4.2 消费方级联 | 5–8 |
| 4.3 方言移植 | 3–5 |
| 4.4 FTS 替换 | 2–3 |
| 4.5 向量替换 | 2–3 |
| 4.6 ETL + 运维 | 2–3 |
| 4.7 测试基建 | 5–8 |
| **合计（pg 单方言）** | **27–42（取整 25–40）** |

---

## 5. DB 之外的多实例收口缺口（关键增量，5–10 人日）

| # | 状态面 | 现状 | 多实例缺口 | 方案 | 人日 |
| --- | --- | --- | --- | --- | --- |
| 1 | 通知/会话帧/presence | `DbNotifyBus` + `presence_instances`（ADR 0199，v26） | 无（迁移后启用即可） | `NOTIFY_BUS=db` + `INSTANCE_ID` + 压测 | 0.5–1 |
| 2 | 定时任务 | 每实例独立 `setInterval` tick；`due()` 仅 SELECT 后 fire，**无抢占/租约** | **重复触发**（两实例同任务双跑） | CAS 抢占（`UPDATE ... WHERE next_run_at<=now RETURNING`）或单实例领导者（pg advisory lock） | 1–2 |
| 3 | 文件存储 | `workspace/` + `data/{avatars,canvas,materials,logs,tc-raw}` 本地盘 | 实例间不可见；实例故障即数据不可达 | 共享卷（NFS/EFS）挂载治理；后续可演进对象存储 | 2–4 |
| 4 | 实例亲和 | SSH 会话、浏览器 CDP、终端流、Run SSE 均为进程内 | 客户端可能落到无该连接的实例 | 网关粘性路由（user/session hash）；Run 观察流可降级为 REST/DB 轨迹补齐 | 1–3 |
| 5 | 密钥一致性 | `data/.connection-key` 本地文件 | 各实例密钥不同 → 凭据互不可解密 | 共享 `CONNECTION_SECRET_FILE`（配置项已存在） | 0.5 |
| — | **小计** | | | | **5–10** |

> 注：§5-3 即使不做多实例，共享卷也是「云部署 + 实例重建」的既有需求；§5-2 在单实例下无差异，但属多实例**正确性红线**。

---

## 6. 路线对比

| 路线 | 改动面 | 量级 | 优点 | 代价/风险 |
| --- | --- | --- | --- | --- |
| **A. 全量替换 pg（推荐）** | db.ts + store + 63 消费文件 + 迁移 + 测试 + 部署 | **25–40 人日** | 一步到位；多实例可用；并发/事件循环改善 | 异步级联面大；事务语义重构需高度自律 |
| **B. 双后端（SQLite 本地 + pg 服务器）** | A + 方言抽象层 + 双测试矩阵 | 40–65 人日 | 保留本地零依赖体验；云上可选 pg | 长期双份维护；SQL 方言分叉；测试矩阵翻倍 |
| **C. 同步桥（synckit + worker 线程）** | 仅 db.ts + 方言层 | 5–8 人日 | 快、表面改动小 | 每语句跨线程往返（高频写如 run_events/usage 压力大）；桥内仍需实现事务连接绑定；稳定性/可调试性差 → **仅可作过渡，不建议长期** |
| D. 不迁（云上单实例） | — | 0 | 零成本 | 无法多实例；事件循环仍被同步 IO 阻塞 |

---

## 7. 推荐实施分期（决策推进时）

**Phase 0 前置验证（2–3 人日）**：① ALS「当前事务连接」原型 + 1 张表（kv/users）异步化试点，量化级联改动面；② `pg_trgm` / `pgvector` 中文影子评测（同数据 Top-K 对比 + 延迟基线）；③ 环境 spike：本机 docker pg + 迁移器跑通 v1–v27。

**Phase 1 存储层异步化（SQLite 不变，可独立验收）**：`AppDb` async + ALS 事务 + 365 方法 + 级联 + 测试 await 化。**行为零变化**（同步驱动实现 async 接口），全测试/E2E 全绿后独立留档——此步把最大风险批单独隔离。

**Phase 2 方言层与 pg 实现**：新增 `DbDialect`（upsert/自增/rowid→seq/分页/FTS/向量接口）→ pg 实现 + 迁移重写 + 方言单测（复用 connections/db 的池/参数/行清洗模式）。

**Phase 3 扩展替换与数据 ETL**：pg_trgm、pgvector（reindex 重建）+ ETL 双跑（SQLite → pg 校验）+ 影子检索评测。

**Phase 4 多实例收口**：定时任务抢占、共享存储挂载、粘性路由、`NOTIFY_BUS=db` 双实例压测。

**Phase 5 切换与回滚**：生产切换窗口 + `data/app.db` 只读冻结副本 + 回滚脚本演练。

---

## 8. 风险清单（含缓解）

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| R1 | 异步级联遗漏/隐式 any 逃逸 | 高 | 每批全量 typecheck 强制兜底；禁新增 any；按模块分批全绿推进 |
| R2 | **事务原子性破防**（语句漏到池中其他连接） | **最高** | ALS 强制事务内连接路由；补「并发交错」专项测试固化；事务内禁止裸 `db.*` 直调 |
| R3 | 同步→异步暴露既有隐式竞态（时序变化） | 中 | Phase 1 单独验收（行为零变化基线）；并发测试 + E2E 双跑 |
| R4 | `rowid` 稳定排序语义丢失 | 中 | 显式 `seq` 列 + 回填校验（同秒并列用例） |
| R5 | FTS 中文召回质量回归 | 中 | LIKE 回退保留 + 影子 Top-K 评测 + 灰度开关 |
| R6 | 向量精度/距离度量差异 | 中 | reindex 全量重建 + 召回评测对比（cosine 一致性） |
| R7 | ETL 数据完整性 | 高 | 行数 + 哈希校验、双跑演练、回滚副本冻结 |
| R8 | 测试基建成本膨胀 | 中 | 优先 A 方案（真实 pg + 事务回滚隔离）；避免双矩阵长期化 |
| R9 | 编号占用（M80 已预定） | 低 | 开工前按惯例全仓检索复核（M/ADR 独立） |
| R10 | 部署面变化（本地开发需 pg） | 中 | 与路线 B 解耦决策；本地保留 SQLite 只读/测试模式 |

---

## 9. 验收标准（分阶段）

- **通用门禁**（每 Phase）：四包 typecheck / lint 0 错 / server 全测 / client 全测 / build ✓ / E2E gold 双跑全绿。
- **Phase 1**：异步化后所有既有测试不经修改地语义等价通过（仅加 await）；性能基线不回归（本地压测对比写延迟 P95）。
- **Phase 3**：① 46 张普通表行数与关键字段哈希一致；② FTS 与向量召回 Top-K 对比达标（目标：中文子串召回不低于现状）；③ `memory:reindex` 在 pg 上全量重建成功。
- **Phase 4**：双实例 + 共享 pg + `NOTIFY_BUS=db`：跨实例通知延迟 ≤ `NOTIFY_BUS_POLL_MS`（400ms）；presence 收敛 ≤2 分钟；**定时任务 N 轮压测零重复触发**；实例杀死后另一实例接管（会话观察可降级恢复）。

---

## 10. 附录：实测复核命令

```bash
# 表/迁移现状
sqlite3 data/app.db "SELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';"
sqlite3 data/app.db "SELECT count(*) FROM schema_migrations;"

# store 规模与调用点
ls server/src/store/*.ts | wc -l
grep -rEno "\.(all|get|run|exec|stmt|tx)\(" server/src/store/ | wc -l
grep -rEl "from '.*store/" server/src --include='*.ts' | wc -l

# 方言特性
for p in "ON CONFLICT" "AUTOINCREMENT" "rowid" "lastInsertRowid" "INSERT OR IGNORE"; do
  printf "%-18s %s\n" "$p" "$(grep -rEio "$p" server/src --include='*.ts' | wc -l)"; done

# 测试面
ls server/tests/*.ts | wc -l
grep -rEo "(sessions|users|memory|store)\.[a-zA-Z]+\(" server/tests/*.ts | wc -l
```

---

> **本文档为评估稿，不含实施承诺。** 决策后：登记专项编号 → 落 ADR（拟占用最新空号）→ 收录 design.md → 按 §7 分期实施并回写状态行。
