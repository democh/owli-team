# ADR 0006：持久化——每会话 JSON 文件

- 状态：Superseded → [ADR 0018](0018-sqlite-persistence.md)
- 引入：v1
- 相关：[design.md §8](../design.md)

## 背景

v1 需要持久化会话与消息。备选：SQLite、JSON 文件（每会话一个）、内存不持久化。

## 决策（历史）

**每会话一个 JSON 文件**（`data/sessions/<id>.json`）：内存 Map 为运行时真相，变更经防抖 `scheduleSave` 批量落盘，显式 `saveNow` 保证关键点即时持久化。

## 理由（当时）

- 零依赖、零 schema 迁移成本，`cat` 即可检查数据；
- 单用户本地场景写量小，防抖全量重写足够快；
- v1 的查询需求简单（列出会话 / 读单个会话），不需要索引。

## 被否决的方案（当时）

- **SQLite**：v1 阶段引入原生编译依赖与迁移体系的成本大于收益（后于 M1 反转，见 ADR 18）。

## 影响与取代原因

- 全量重写不可持续：消息增长后写放大明显；无事务（崩溃可能留下截断文件）；无检索能力（跨会话搜索需全量扫描）；无法支撑 M2–M9 新增的 summaries / memory / task_items / usage / trace / feedback 等多实体；
- **M1 起由 SQLite 取代（ADR 18）**：旧 JSON 启动时一次性幂等导入，原文件保留并打 `.imported` 标记。
