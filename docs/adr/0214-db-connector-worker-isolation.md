# ADR 0214：DB 连接器 worker 化与只读行数下推——慢查询隔离 · 语句级超时 · 句柄自愈

- 状态：Accepted
- 引入：连接与联网加固批（2026-09-23）
- 相关：[server/src/connections/db/sqlite.ts](../../server/src/connections/db/sqlite.ts)、[server/src/connections/db/guard.ts](../../server/src/connections/db/guard.ts)、[server/src/connections/db/manager.ts](../../server/src/connections/db/manager.ts)、[server/src/connections/db/types.ts](../../server/src/connections/db/types.ts)、[server/tests/m22.test.ts](../../server/tests/m22.test.ts)

## 背景

数据库工作台（M23）的 SQLite 连接器基于 `node:sqlite` **同步 API**在事件循环上直接执行：慢查询 / 大结果会冻结整个进程（所有会话的 ws、审批与其他工具全部卡住）；只读查询此前「全量读入内存再截断」，大表 SELECT 可拖垮内存；语句级超时也无法在主线程实现（`node:sqlite` 无中断 API）。

## 决策

1. **每连接句柄 = 独立 worker 线程**（单连接串行，查询语义不变）：查询在 worker 内执行，主线程事件循环不再被慢查询阻塞；worker 源码以 eval 字符串内联（dev/tsx / vitest / 生产 dist 三种加载形态零路径特判，且无需打包器介入）。
2. **语句级超时生效**：超时即 `terminate()` worker（SQLite 无中断 API，终止是唯一可靠手段）；句柄标记损坏（`DbHandle.isBroken`），管理器下次调用自动重建。
3. **只读查询行数下推**（`wrapSelectWithLimit`）：对 SELECT / WITH 单语句包一层 `SELECT * FROM (...) LIMIT maxRows+1`（+1 探测截断，避免 COUNT 全表扫）——数据库端只返回所需行；EXPLAIN / SHOW / PRAGMA / TABLE / VALUES 与多语句不包裹（返回 null，回退既有路径）。
4. readOnly 语义不变：worker 内以只读方式打开 + 护栏双保险；`allowWrites` 时以可写方式打开（与权限链 `readOnly && !allowWrites` 一致）。

## 被否决的方案

- **换异步驱动（better-sqlite3 native / sqlite3）**：新增原生依赖与打包风险；且与主库 `node:sqlite` 形成双驱动分裂。
- **主线程 + AbortSignal 级超时**：`node:sqlite` 同步执行不接受中断，无法打断正在执行的语句（「超时」只能等语句返回，失去意义）。
- **两阶段查询（先 COUNT 再分页）**：多一次全表扫描——超大表上 COUNT 本身就是慢查询。

## 边界与后续

- worker 终止后该连接句柄作废（`isBroken`）→ 管理器重建；未完成事务随连接终止回滚（SQLite 保证）；
- 测试：`m22.test.ts` 新增 `wrapSelectWithLimit` 断言（SELECT / WITH 包裹、首关键字白名单、多语句、maxRows 下限）；worker 执行路径由既有「SQLite 连接器全链路」用例回归覆盖；
- 镜像面：design.md §119、本 ADR + `docs/adr/README.md` 索引（无新增环境变量）。
