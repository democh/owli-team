# ADR 0047：向量记忆——sqlite-vec 双后端、连接中心凭据与 L1.5 语义召回

- 状态：Accepted
- 引入：M25
- 相关：[design.md §39](../design.md)、ADR 18（SQLite 持久化）、ADR 19（上下文工程）、ADR 21（LLM 韧性层）、ADR 42（连接中心）

## 背景

- M2 的记忆只有会话内一层（L1）：scope 固定为 session、kind 三类（decision / constraint / glossary）、经关键词进入系统提示；跨会话 / 跨角色 / 跨项目的事实无法沉淀，同义表述检索不到。
- 需求：① 记忆按 session / agent / project / global 四层关联；② 语义召回（向量相似度）注入上下文；③ 嵌入模型可配置（连接中心凭据，而非仅 env）；④ 吸收主流记忆库（Mem0 / Zep / Letta / LangMem / Claude memory）的成熟设计但**不引入外部服务**。
- 硬约束：单机 SQLite 形态（ADR 18）、本地部署零新增运维面、模块可休眠（未配置 = 零网络零影响）、包体与测试确定性（LLM_MOCK 下可断言）。

## 决策

1. **sqlite-vec 双后端**：优先加载 `sqlite-vec` 扩展（vec0 虚拟表，按 bucket 分区 KNN）；扩展缺失 / 旧 Node（无 `allowExtension`）自动降级纯 JS 余弦索引（BLOB 扫描 ≤2 万行/桶）。`memory_vectors` 的 Float32LE BLOB 为**规范副本**，vec0 镜像可随时重建；kv `memory.vec.backend` 记录实际后端，与能力不符时自动从 BLOB 重建镜像。
2. **扩展加载最小权限**：`new DatabaseSync(file, { allowExtension: true })` 构造（硬前提，否则 `enableLoadExtension` 报 "disabled at database creation"）；`loadExtension` 返回后立即 `enableLoadExtension(false)`；`OpenDbOptions.noExtensions` 供测试强制 JS 后端。
3. **vec0 DDL 不进 migrations**：v6（memory_scopes + 重建 memory + memory_vectors + embedding_cache + memory_embed_queue）为纯 SQLite 必成迁移；v7（FTS5 trigram keyword 信号）可跳过；vec0 虚拟表由运行时幂等 `CREATE VIRTUAL TABLE IF NOT EXISTS` 创建，维度取自 kv——避免「扩展缺失 → 迁移整体失败」耦合。
4. **混合评分（Mem0 v3 三信号 + 时新性）**：`scope 权重 × (0.50·sim + 0.15·keyword + 0.10·entity + 0.15·importance + 0.10·recency)`，scope 权重 session 1.0 / agent 0.95 / project 0.92 / global 0.90；默认 topK=8、minScore=0.25、注入预算 600 tokens；keyword 信号依赖 v7 FTS5，缺失时自动关闭并归一其余信号。
5. **时间有效性（Zep 轻量版）**：`status`（active / superseded / archived / candidate）+ `supersedes` / `superseded_by` + `valid_from` / `valid_to`；不引入图数据库与自动事实抽取管线。
6. **嵌入凭据走连接中心**：新 kind = `embedding`（SecretVault AES-256-GCM，只写不读、`secretSet` 标记、CRUD 与测试沿用 connections 审计 + `invalidate` 模式）；不参与会话绑定（bind 拒绝 / UI 隐藏入口）。解析顺序：`settings.embeddingConnectionId`（热切换）> `EMBEDDING_*` env > 休眠；`LLM_MOCK=true` 时用确定性 Mock（词哈希投影 + L2 归一）保证 E2E / evals 零网络可断言。
7. **L1.5 注入**：prepareTurn 先取召回（超时 300ms 静默跳过），以 `<recalled_memory>` 独立层注入；与 L1 会话记忆去重（排除 session active 条目）；窗口预算扣减含 L1.5；快照 `recalled` 存最近一次明细（ContextBar 可视化 + trace `memory:recall`）。
8. **写入纪律**：ADD-only + 近重复合并（worker 内 cos ≥ 0.92 合并，仅 active 间发生）；write-then-embed（写入即入 queue，worker 批量 flush、启动补账、失败退避）；remember 工具扩展 scope / importance / supersedes；Run 后 digest 沉淀**默认关**（`MEMORY_DIGEST_MODE=off`）、候选态待审（candidate 不参与召回，审核转 active 才入镜像）。

## 理由

- sqlite-vec 与 `node:sqlite` 同源嵌入（0.1.9 平台二进制经 optionalDependencies 分发，覆盖 darwin-x64/arm64、linux-x64/arm64、win-x64），不新增服务进程 / 端口 / 备份面；BLOB 规范副本使「换后端 / 换模型 / 换维度」都成为可重建操作（reindex 脚本 + kv 游标断点续跑）；
- 双后端是防御性设计：vec0 是加速器不是事实源——降级 / 重建对上层不可见，测试可强制 JS 后端验证两后端 top-k 一致；
- 凭据走连接中心与既有 db / ssh / chrome 同构：复用 SecretVault、审计、`invalidate` 热失效模式，避免「嵌入 Key」成为第二套密钥管理；
- 四层 scope 让「同样的知识」按归属收敛：会话内事实不污染全局，角色经验可跨会话复用，项目约定随 `projectId` 联动；
- 候选态 + digest 默认关控制信噪比：自动沉淀直写 active 会快速污染召回（LLM 抽取不可信是关键假设）。

## 被否决的方案

- **纯 JS 暴力余弦主导**：5 万行 × 每回合 × 四桶的每次全量扫描延迟不可控（原 M23 草案方案，本轮降为兜底）；
- **外部向量数据库（Chroma / Qdrant / LanceDB）**：引入第二条数据链路（进程 / 端口 / 备份 / 一致性），与单机 SQLite 形态冲突；
- **Zep / Graphiti 式时序知识图谱**：实体图 + 边有效性抽取的复杂度远超收益，轻量 status 链已覆盖「新事实取代旧事实」的主场景；
- **嵌入密钥仅 env**：与连接中心既有模式不一致，且用户轮换密钥必须重启；
- **vec0 DDL 进 migrations**：扩展缺失时单个迁移整体被跳过（schema 版本与真实结构漂移），且维度是运行期属性（模型可换），不适合静态 DDL；
- **digest 直写 active / 默认开启**：Mock 与真实 LLM 都可能输出低质候选，直接入召回池污染上下文；候选 + 审计开关是更安全的默认；
- **为 embedding 单独造一套连接与密钥表**：与 ADR 42 的连接中心完全重复。

## 适用与失效条件

- 适用：单机 / 小团队本地部署，向量规模 ≤ 5 万（JS 兜底有效范围）；新记忆类型挂到既有 scope / kind / status 状态机，不新增平行体系；嵌入端点须 OpenAI 兼容 `/embeddings`（供应商无该端点时单独配置嵌入连接）。
- 失效条件：向量规模量级超出（评估 HNSW 类增量索引或专用向量库）；sqlite-vec 停止随 Node ABI 分发（回退纯 JS 或换实现，BLOB 规范副本仍在）；多用户 / 多租户部署（scope 模型与单库形态需重新设计）。
