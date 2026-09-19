# ADR 0063：场景资产扩展走 _group.yaml（Scene Assets: guide / agenda）

- 状态：Accepted
- 引入：M37
- 相关：[design.md §52](../design.md)、ADR 28（agents/ 包化与场景分组）、ADR 31（场景协议分层与技能包绑定）、ADR 50（资产控制台）、ADR 62（场景差异化限定于视图层派生）

## 背景

- 空态引导文案此前仅有 3 条内置（development / brainstorm / research 的 `EMPTY_GUIDES`），其余 14 场景回退通用文案；「推荐开场」类议程模板完全没有；
- 资产体系已有 `_group.yaml`（场景组元数据：name / description / icon / theme / objective / chain / parallel / order / guide），经 AgentGroupSchema 校验、随 `/api/agents` 热更新（改完即生效、无需重启）；
- 硬约束：
  1. 场景文案与议程是**数据**（可热更、可被资产控制台治理），不是代码常量；
  2. 单侧维护：同一场景的 name / theme / guide / agenda 不应分散两处（避免双份维护漂移）；
  3. 向后兼容：新增字段必须可选——旧资产（无 guide / agenda）不报错、渲染层静默降级。

## 决策

1. **字段落点**：`_group.yaml` 新增可选字段 `guide`（空态标题，string）与 `agenda`（议程模板列表，`{ label, prompt }[]`，2–4 条）；
2. **校验**：`AgentGroupSchema`（`server/src/store/prompts.ts`）增加两字段校验（agenda 条目 label / prompt 非空）；shared 类型（AgentGroup）同步；
3. **交付面**：17 个场景全部补齐 guide + agenda（与既有 name / theme / chain 同文件维护）；随 `/api/agents` 下发，前端经 useGroup 消费；
4. **降级链**：guide 缺省 → 回退 `EMPTY_GUIDES` 内置三条；agenda 缺省 → 空态不渲染议程区块；校验失败 → 该字段丢弃（其余场景不受影响）；
5. **交互语义**：议程 chip 点击只写 Composer 草稿（composerInsert），不直发（ADR 64）。

## 理由

- **资产即数据**：guide / agenda 属场景运营面（措辞、顺序、节奏会持续调优），随资产热更与资产控制台治理是既有产品承诺（ADR 28 / 50）；
- **单一文件维护**：场景元数据集中在 `_group.yaml`，避免「主题在资产、文案在前端常量」的双份漂移；
- **可选字段 + 兜底**：向后兼容旧资产与用户自建分组（本地 agents 目录可能被用户编辑过）；
- **议程 2–4 条**：空态视觉密度的护栏（过多 chips 与成员 chips 抢焦点）。

## 被否决的方案

- **前端常量表**（沿用 EMPTY_GUIDES 扩展 17 条）：不可热更、双份维护（资产改场景名后文案表漂移）；
- **写入各角色 AGENT.md**：议程是场景级（组）而非角色级；且需聚合多角色内容才能生成，放角色资产会重复 N 份；
- **新增 groups.json / agenda.md 等旁路文件**：多引入一条资产加载与校验链路，收益为零（`_group.yaml` 就在同目录）；
- **议程 chip 直发消息**：绕过 Run 互斥与插话语义（与 ADR 64 一致地否决）。

## 适用与失效条件

- 适用：场景组规模在此量级（17 组）；agenda 为静态模板（非动态生成）；
- 失效条件：
  - **议程按会话状态动态化**（如「继续上次」类上下文相关开场）：静态资产模型失效，需前端派生层生成（届时 guide / agenda 仍可作模板源）；
  - **资产控制台可视化编辑 agenda**：需补编辑 UI 与校验往返（当前为手写 YAML + `check:agents` 门禁）。
