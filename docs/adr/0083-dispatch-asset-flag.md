# ADR 0083：`dispatch` 资产标记（Dispatcher Declared by Front-Matter Flag, Globally Unique）

- 状态：Accepted
- 引入：M46
- 相关：[design.md §54](../design.md)、ADR 28（Agent 包化与场景分组）、ADR 50（资产控制台：软删除 / 引用检查）、ADR 82（调度官为显式一等成员）

## 背景

- 系统多处需要判定「谁是调度官」：引擎路由（launch 分支 / 插话补位 / 波前护栏）、装配注入（roster_catalog / 调度回合指令）、工具白名单、前端徽标 / 建会话预选 / CommandPalette；
- 候选方案三类：① front-matter `dispatch: true` 资产标记（全局唯一）；② 硬编码 id（多处判 `id === 'harness'`）；③ 场景级标记（`_group.yaml` 声明整个场景为调度场景）；
- 约束：资产化纪律（自描述 / 热更新 / 可校验），判定单源（前端与后端同一数据面）。

## 决策

1. `AgentFrontMatterSchema`（`server/src/store/prompts.ts`）增 `dispatch: z.boolean().optional()`；
2. `PromptLibrary.validate()` 增唯一性校验：全库 `dispatch: true` 至多一个（>1 报错，与 id 重复同级，统一进 `check:agents` 输出）；
3. `AgentDefinition.dispatch?: boolean`（`shared/src/types.ts`）——`GET /api/agents` 载荷自动携带；前端判定统一为 `agents.find(a => a.dispatch)`；
4. `check:agents` 输出 `dispatch:✓` 标记行；
5. 资产控制台（M26）round-trip：编辑其他字段保存后 `dispatch` 透传保留；复制角色**不继承**该标记（`manager.ts`）。

## 理由

- **资产自描述**：判定与资产同源，替换 / 新增调度官零代码改动；热更新链（mtime → schema → list 投影）自动生效；
- **唯一性可校验**：`check:agents` 在 CI 常驻，防「双调度官」产生式歧义（路由二义 / 前端预选二义）；
- **投影即数据**：前后端单源（`/api/agents`），前端零特判——徽标、预选、命令面板全部由 `dispatch` 字段驱动；
- **透传纪律**：控制台编辑链显式保留字段（round-trip 单测固化），防资产工具静默丢字段的历史类风险。

## 被否决的方案

- **硬编码 id**：改资产即失效；判定分散在多处（路由 / 注入 / 前端），新调度官需改代码；
- **场景级标记**：场景多角色时「场景即调度」不够精确；且与场景顺序（order）语义耦合——order 是展示序，不是权限声明；
- **按名字约定**（如名字含「调度」）：不可校验、易误伤，违背资产化纪律。

## 适用与失效条件

- 适用：全局单调度官模型（当前形态）；
- 失效条件：
  - **多调度官**（按场景 / 项目分区路由）——唯一性校验需扩展为枚举 / 分区语义，路由分支需含「选哪个调度官」；
  - **控制台字段序扩展**——新增字段时需保持透传纪律（round-trip 断言同步扩展）。
