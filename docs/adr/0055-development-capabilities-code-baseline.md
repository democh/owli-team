# ADR 0055：研发场景能力矩阵与编码代理能力基线（Code Agent Baseline）

- 状态：Accepted
- 引入：M29
- 相关：[design.md §45](../design.md)、ADR 2（handoff 工具优先）、design.md §21（工具系统与 Harness）、ADR 14（工作区沙箱）、ADR 22（worktree 隔离）、ADR 23（HITL 审批）、ADR 31（场景协议分层）、ADR 45（外部技能适配）、ADR 54（工具按需发现）

## 背景

- 研发场景（development，7 角色：pm / architect / designer / frontend / backend / qa / devops）是本项目的第一场景与最长接力链，但角色能力自 M21（v7 人设专业化）以来未系统审计，存在三类缺口：
  1. **可达性缺口（已建成能力未接通）**：① `handoff` 结构化转交工具在全部 34 角色白名单中零绑定——ADR 2 定义的「工具优先、文本 @ 回退」在 execute 范式下实际只剩文本回退，`reason` / `expected_output` 指派闭环与多目标 fan-out 从未在真实运行中触达；② `remember` 在研发 7 角色零绑定——与协议 `<context_semantics>`「关键约束 / 口径 / 决策必须 remember」及其他 6 场景（27/34 已绑定）不一致，而研发场景恰是最需要固化接口口径与架构决策的场景。
  2. **编码代理能力缺位（职责与能力不对齐）**：`run_command`（跑测试 / 类型检查 / 构建）仅 devops 持有——frontend / backend / qa 无法执行代码验证，「实现者自测 → qa 复验」的验证闭环缺工具支撑；git 写操作（`git_branch` / `git_commit`）仅 devops 持有——代码角色无法建特性分支、提交自己的实现；qa 无数据库只读工具（db_query）——「数据一致性类问题优先」的测试重点缺数据面手段；designer 无浏览器能力——设计走查只能停留在纸上状态矩阵。
  3. **工程纪律缺口**：无 development 场景协议（brainstorm / research / strategy / finance 均有 `_protocol.md`），代码改动纪律（先读后写、最小 diff）、共享文件所有权、验证闭环、提交与发布纪律缺少场景级约束；`code-review` 技能零预载、正文仅 27 行（低于 60–150 行规范）；无「缺陷定位」类技能。
- 硬约束：
  1. **零新增工具代码**：本批只做「已建成能力的授权接通」与资产层设计，不改工具实现（与 v11 / v12 可达性修复同模式）；
  2. **最小授权不变式**：能力绑定 ≠ 能力启用——`run_command` 仍需 `ALLOW_RUN_COMMAND=true` + 用户显式开启，写类 git / `db_execute` / 覆盖写仍走审批门；
  3. **延迟披露兼容**：重型工具（git / db / browser / ssh / run_command / web）保持 `tier='deferred'`，经 `tool_search` 激活后本 Run 可用（ADR 54 语义不变）；
  4. **零回归**：mock / eval 剧本不依赖新增可见性；改后 `check:agents` / `check:skills` / `npm run eval` / vitest 全绿。

## 决策

1. **编码代理能力基线（CAB，Code Agent Baseline）**：以六域定义「代码角色」的最低能力集，研发角色按职责取子集——
   - ① 代码导航：`list_dir` / `read_file` / `glob` / `grep` / `search_text`（只读，常驻）；
   - ② 精准编辑：`edit_file`（old_text 逐字匹配）/ `apply_patch`（unified diff）/ `write_file`（dry_run 预览覆盖）；
   - ③ 执行验证：`run_command`（白名单前缀 + 审批 + `ALLOW_RUN_COMMAND` 开关，15s 超时）——能跑就跑测试，跑不了给人工验证步骤；
   - ④ 版本控制：只读 `git_status` / `git_diff` / `git_log` 全员可见；写类 `git_branch` / `git_commit` / `git_restore` 按「实现者自提交」原则授权，全部走审批门（worktree 模式下提交落在 `agent/<sid>` 分支，合并回主干仍需用户在 WorktreeBar 显式确认）；
   - ⑤ 数据与环境：`db_*`（backend 全量 / qa 只读三件套）、`browser_*`（frontend 全量 / qa 全量 / designer 只读子集）、`ssh_exec`（devops）；
   - ⑥ 协作与记忆：`handoff` / `remember` / `write_todos` / `load_skill` / `request_approval`。
2. **handoff / remember 全局可达性修复**：`handoff` 补入全部 34 角色白名单（角色无关的协作机制，ADR 2 的优先通道）；`remember` 补入研发 7 角色（对齐其余场景与协议语义）。白名单语义不变（先定可发现范围，tier 只影响初始可见性）。
3. **研发 7 角色能力矩阵**（相对现状的增量，详见 design.md §45.3）：
   - pm：+ `calc` / `date_calc`（排期与验收指标口径，对齐业务纪律）+ `remember` / `handoff`；
   - architect：+ `remember` / `handoff`（其余保持：web 检索 / git 只读 + restore）；
   - designer：+ 浏览器只读子集（`browser_open` / `navigate` / `snapshot` / `screenshot` / `console` / `wait` / `close`）用于设计走查取证 + `remember` / `handoff`；
   - frontend / backend：+ `run_command` + `git_branch` / `git_commit` + `remember` / `handoff`（实现者能自测、能提交）；
   - qa：+ `run_command`（跑测试与复现）+ `db_list_connections` / `db_schema` / `db_query`（只读，数据一致性验证）+ `remember` / `handoff`；
   - devops：+ `remember` / `handoff`（已有 run_command / git 全套 / ssh）。
4. **场景协议 `agents/development/_protocol.md`**（六条工程纪律）：① 代码改动纪律（先读后写、最小 diff、遵循既有风格、范围外改动先说明）；② 共享文件所有权（同一文件同一时刻一个负责人，并行波前声明归属）；③ 验证闭环（实现者自测 → 交棒带可执行验证步骤 → qa 复验才算完成）；④ 缺陷回交（最小复现 + 期望 vs 实际 + 影响面；修复先复现再回归）；⑤ 提交与发布纪律（commit 前 git_status / git_diff 自查、一提交只含本任务改动、不 push、发布仅 devops）；⑥ 依赖与配置纪律（新增依赖须说明理由并获用户批准，不擅改 .env 与依赖版本）。
5. **技能层**：新增 `skills/debugging`（六步缺陷定位法：症状采集 → 复现与最小化 → 证据链 → 假设验证循环 → 最小修复与回归 → 复盘沉淀；引用真实工具 browser_console / run_command / db_query / git_diff）；预载 frontend / backend / qa；`code-review` 升级为完整评审手册（60+ 行：正确性 / 边界 / 安全 / 性能 / 可维护性 / 测试六组清单 + 输出协议），按需加载不预载（评审为周期性动作，避免常驻上下文开销）。
6. **命令白名单不扩展**：`run_command` 默认前缀保持保守（`npm test` / `npm run` / `npx tsc` / `node -v` / `git status|diff|log`）；项目侧通过 package.json scripts（test / lint / typecheck）暴露验证入口，由 `npm run` 覆盖。
7. **可达性测试**：新增 `server/tests/m29-code-bindings.test.ts`——断言 34 角色全员含 `handoff`、研发 7 角色含 `remember`、代码角色含 `run_command` 与写类 git、qa 含 db 只读三件套且不含 `db_execute`、designer 浏览器子集完整且不含交互类（click / fill / press / eval）。

## 理由

- **接通优于新建**：三类缺口中两类是「能力已建成但零绑定」（handoff / run_command），修复成本一行白名单，收益是整条研发链的协作质量；与 v11（浏览器）、v12（数据库 / SSH）的可达性修复模式一致。
- **实现者自证**：编码代理不能跑测试就无法对产出负责；`run_command` + 审批 + 开关三重护栏下，授权风险可控（白名单前缀 + shell 元字符拒绝 + 15s 超时 + 输出截断）。
- **提交权跟随实现者**：worktree 模式下提交只落在会话专属分支，合并回主干仍需用户显式确认——「实现者自提交」不破坏用户控制权，却让 devops 从「替所有人提交」的伪瓶颈中解放，保留发布动作（分支策略 / 回滚 / 部署）。
- **按需加载的克制**：code-review 不预载（周期性动作），debugging 预载（高频且易被忽略的方法论）；设计师只拿浏览器只读子集（走查取证），交互操作留给 frontend / qa（职责不重叠）。
- **纪律先于工具**：工具解决「能不能做」，协议解决「怎么做才对」——六条工程纪律把「先读后写 / 最小 diff / 验证闭环」写成场景级契约，避免能力放开后出现「能跑命令但不跑测试」的能力空转。

## 被否决的方案

- **新建代码能力专用工具**（如 `code_outline` 符号大纲 / `run_test` 专用测试工具）：grep / glob / search_text / read_file 已覆盖代码导航；AST 级符号工具需引入解析器依赖（违反零新增依赖），`run_test` 是 `run_command` 的同义包装（工具数量膨胀）；
- **扩展 `run_command` 默认前缀**（`npx vitest` / `npx eslint` / `pytest` 等）：npx 会在本地缺失时下载并执行任意包（供应链风险）；改用 package.json scripts + `npm run` 覆盖，白名单保持最小；
- **git 写操作仍仅 devops 持有**：实现者的提交意图（改了什么 / 为什么）只有实现者最清楚，经 devops 转述提交会失真；且 devops 成为全链提交瓶颈；
- **qa 获得 db_execute / git 写操作**：qa 是验证方不是修改方，写类能力违背「只报告不改动」的职责边界；数据核对用只读 db_query 足够；
- **designer 获得完整浏览器工具集**：click / fill / eval 会改变页面状态，属 frontend 自测与 qa 实测职责；设计走查只需要「看」（snapshot / screenshot / console），不需要「动」；
- **code-review 预载到全部代码角色**：每个预载技能正文约占 1–2k token 常驻系统提示；代码评审是周期性动作，索引常驻 + 按需 `load_skill` 已足够；
- **把编码代理能力基线写成新技能**（如 `code-implementation`）：纪律属协议层（最高约束），方法属技能层；把纪律塞进技能会与其「可裁剪」语义冲突（协议不可裁剪）。

## 适用与失效条件

- 适用：本地单用户部署（与 ADR 42 / 50 / 53 同一产品形态）；被授权角色基于真实模型运行（mock 剧本不消费新增可见性）；worktree / repo 模式下的 git 工具（非 git 目录下 git 工具返回明确不可用提示）。
- 失效条件：
  - 引入多用户 / 多租户共享实例时，「实现者自提交」需叠加用户级授权模型（当前以会话与审批门为边界）；
  - 引入远程执行沙箱（云端 runner）时，`run_command` 的本机白名单模型需替换为容器级隔离；
  - 若模型频繁误用 `handoff`（如重复转交空转），应回归「工具 + 文本」双轨的调度阈值调参，而非撤销授权；
  - 技能库继续扩容（预载技能正文合计接近系统层预算阈值）时，debugging 等预载项应回归按需加载并重新评估索引摘要长度。
