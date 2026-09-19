# ADR 0028：Agent 包化与场景分组——agents/ 单包目录（取代 7）

- 状态：Accepted（取代 ADR 7）
- 引入：M15
- 相关：[design.md §25](../design.md)、[agents/README.md](../../agents/README.md)、ADR 7、ADR 29

## 背景

v1 的角色资产是 `prompts/*.md` 平铺结构：定义、头像资产（`client/public/avatars/`）、可选人格全部散落在不同目录，新增一个角色要跨目录同步多处。同时产品要引入「场景分组」（研发 / 头脑风暴 / 深度研究）与「灵魂变体」（同一角色多套人格），平铺结构无法承载「一个角色 = 一个自包含单元」的模型。

## 决策

**角色资产重构为 `agents/<场景>/<id>/` 单包目录**，每个包自包含 `AGENT.md`（定义）+ 可选 `souls/`（灵魂变体）+ `avatar.png`（形象照）：

- **目录即分组**：`group` 由父目录名推导，不接受 front-matter 手写（单一事实源，防不一致）；
- **场景元数据** `_group.yaml`（zod 校验）：name / description / icon / theme / chain / defaultSkills / parallel / rounds / parallelMax；
- **协议分层**：根 `_protocol.md`（全局）+ 场景 `_protocol.md`（追加）——全局约束永远生效；
- **头像自动发现**：包内 `avatar.png` 存在即映射 `/api/agents/<id>/avatar`（服务端直出 + ETag），不再依赖 client 静态目录；
- **链序统一**：会话创建按 `group.chain` 排序落库，此后链序 = `session.participantIds` 唯一事实源（`DEFAULT_START_ORDER` 移除）；
- **迁移与回退**：`migrate:agents` 幂等迁移脚本 + 加载器双轨（`AGENTS_DIR` 优先，`prompts/` 保留一个版本周期回退并告警）；`check:prompts` 升级为 `check:agents`（旧名别名）。

## 理由

- 单包自包含让「新增角色 = 新建一个目录」；头像 / 灵魂 / 协议全部随包走，资产搬移与备份天然对齐；
- 目录即分组消除了「front-matter 写 group 与目录不一致」的整类 bug；`check:agents` 静态校验兜底；
- 链序单事实源消除了引擎与调度器各自维护顺序的双轨问题（历史 bug 来源）；
- 双轨回退让迁移可演练、可回滚，不阻塞既有部署。

## 被否决的方案

- **保留 prompts/ 平铺 + 旁边再加分组配置**：同一角色的信息继续跨目录散落，分组与角色目录可能失配；
- **front-matter 手写 group 字段**：与目录结构可能不一致，校验成本高且天然可违反；
- **一步切换（删 prompts/）**：破坏既有部署的热更新工作流，回滚困难。

## 影响

- `agents/` 成为与 `server/` 并列的一等目录；Dockerfile 打包与 CI 校验同步切换；
- 头像资产从 client 静态目录迁入各 Agent 包，`GET /api/agents/:id/avatar` 成为唯一出口；
- ADR 7 的「prompts/*.md 文档驱动」精神保留（文档驱动 + 热更新），仅存储形态被本 ADR 取代。
