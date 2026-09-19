# ADR 0018：持久化——SQLite + 迁移 + FTS

- 状态：Accepted（取代 [ADR 0006](0006-json-session-files.md)）
- 引入：M1
- 相关：[design.md §8](../design.md)、[operations.md §2](../operations.md)

## 背景

M1 起数据实体快速增多（会话 / 消息 / 运行 / 摘要 / 记忆 / 任务 / 版本 / 审批 / usage / trace / feedback），且需要跨会话全文检索。v1 的 JSON 全量重写方案（ADR 6）已到瓶颈：写放大、无事务、无索引。

## 决策

**SQLite 为唯一持久化方案**：

- 驱动隔离在 `server/src/store/db.ts`（`SqlDriver` 接口 + `AppDb` 封装）：**当前采用 Node 内置 `node:sqlite`**（Node 22.5+）；全部 SQL 使用位置参数 `?`、boolean 以 0/1 存储，保证驱动可替换；
- WAL 模式、`foreign_keys=ON`、`busy_timeout=5000`；`schema_migrations` 表 + 顺序执行 `store/migrations/*.sql`（M1 一次建全量 schema，后续里程碑只填数据）；
- `messages_fts`（FTS5 trigram）支撑跨会话全文检索，查询失败回退 LIKE；
- 旧 `data/sessions/*.json` 启动时**一次性幂等导入**（`store/legacy-import.ts`，原文件保留 + `.imported` 标记），也可手动 `npm run migrate:json`。

## 理由

- 需要事务（崩溃不留半写状态）、索引与分页（消息懒加载）、FTS（检索）；
- **放弃 better-sqlite3（计划原选型）**：原生编译在 CI / 用户环境存在失败风险（计划风险清单已列「原生编译失败」对策）；实际落地发现 Node 22.5+ 内置 `node:sqlite` 已满足全部需求（同步 API、事务、FTS5），零原生依赖、零编译风险；
- 驱动抽象（`SqlDriver`）保留：若未来需要更换驱动（如更好性能特性），只需新增一个驱动实现，业务侧（store/*）零改动；
- 一次建全量 schema 让 M2–M9 无需为「加表」再走迁移评审，迁移器只服务真实演进。

## 被否决的方案

- **继续 JSON / 纯 JSONL**：无检索、无事务；跨实体查询要全量载入内存；
- **better-sqlite3（原生构建）**：需 node-gyp 工具链，编译失败即全局不可用；内置驱动已满足需求，原生编译风险不划算（保留为可插拔选项）。

## 影响

- `SessionStore` / `ArtifactStore` 改为读 DB；`saveNow/scheduleSave` 语义降级为「显式 flush 事务」（保留接口名最小化调用方改动）；
- 运行环境要求 Node 22.5+（推荐 24；CI 与 Docker 镜像均为 24）；
- 备份 = 拷贝 `data/app.db`（含 WAL/SHM）。
