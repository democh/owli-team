# 空场景专项设计（M50）：单助手直聊模式

> 状态：**已实施** · v5（2026-09-18：D 批次门禁收尾——全量 E2E 43 条全绿（4.2m，含 `m27-mcp` 按 M50 新语义适配：`general` 的 `mcp__*` 通配命中一切 MCP 工具 → 「N 个工具零可达」警示对新增服务器不出现，用例改反向断言 + 矩阵命中徽章，§9 风险 9；组队台 §59.5 遗留说明的兑现）；v4 要点：批次 D 落盘——编号最终口径（空场景与组队台同批为 M50）、ADR 0103–0106、design.md §60、CHANGELOG v32；v3 要点：其他 Run 启动路径核验（§5.5）、mock / eval 草案（§7.3 / §7.4）、ADR 清单（§6.2）、**工具策略：核心常驻 + `tool_search` 按需（复用 M28 分层，§5.1.2）**）
> 范围：新建会话独立入口「空场景」・通用 harness agent（`general`）资产・单 Agent 直通路由（跳过 PRS）・通用助手不可自动召集纪律・前端入口与列表改动。
> 关联：依赖 M16 动态成员与波次调度、M24 回合范式与收尾语义、M37 场景资产 `guide/agenda` 空态驱动、M48 平台路由步（PRS）与 `launch()` 三分支、M47 工具可用性门控；资产规范见 [agents/README.md](../agents/README.md)。
> 编号落定（D 批次核对）：本专项与「建会话组队台」**同批为 M50**（全仓一致：`m50-blank.*` 测试文件名、mock / engine 注释、`agents/README.md`「单助手纪律（M50）」；组队台见 design.md §59 / ADR 0102；规划期文档中的「M51 / v30」推测已被编码事实与并发占用推翻，按 D 批次口径修正）；**M49** 已被「右栏实况面板合并与主区收敛」占用（design.md §58，纯前端，2026-09-18）。入口落点与组队台对齐（§5.6 落点修订：blank 独立卡在「来源」栏顶部、列表过滤 blank，点卡 = `pickSource` 预选，与 `pickScene` 语义等价）。ADR：0102 已由组队台占用 → 本专项实际落盘 **0103–0106**（docs/adr/README.md 索引已追加）；design.md 收录为 **§60**；eval 为 **20-blank-scene**；agents/CHANGELOG：v30 / v31 已被占（工具可达性 / Mock 镜像面）→ 本专项实际为 **v32**。仓库无 Git：动手前按 `data/*-backup-<date>/` 惯例做目录快照。
> 命名落定：「空场景」「通用助手」为最终展示名，资产 id 固定为场景 **`blank`** / 角色 **`general`**（已核对：`general`、`blank`、`通用助手` 在全部资产 / 代码 / mock 中均无占用；`assistant` 已被 ops/assistant「沐晨」占用，不可用）。

---

## 1. 背景与目标

### 1.1 问题（用户诉求）

用户原话：「空场景指的是不引入任何角色 agent，只使用一个通用的 harness agent 对话，单 agent 模式。」

现状的两条「零选择」路径都不能满足：

1. **空编制创建（M48）**＝「交给平台组队」：0 人提交合法，但首条未 @ 消息会触发 PRS 结构化路由 → 自动召集业务角色（多 Agent 协作）。用户想要的是**不要角色分工、一个人干完**——PRS 的「组队」正是要规避的行为；
2. **挑一个业务角色新建会话**：现有 73 个角色全部携带业务人设（姓名 / 职责 / 交付契约 / 业务技能预载），「单聊」时人设是噪音（如让「前端工程师马克斯」写一份通用调研报告，「角色感」反而错位）。

M48 的复盘结论（ADR 0101）已经指出用户心智模型是「**所有 agent 都应是单一业务 harness agent**」；本次诉求是该模型的自然延伸：**存在一种「没有业务角色」的合法会话形态**——空场景。

### 1.2 目标与验收（验收导向）

| 目标 | 验收标准 |
| --- | --- |
| 单助手直聊 | 空场景会话（编制恰为 `[general]`）未 @ 消息**直达通用助手**：无「平台 召集了…」事件条、无 `__router__` 用量、无 PRS 延迟；@ 直达语义零变化 |
| 不引入角色 | 会话成员仅「通用助手」1 人；无业务人设字段；空态引导与推荐开场由资产 `guide/agenda` 驱动 |
| 全能力可用 | 白名单 = 全部已启用工具 **− handoff**（默认 54 项；授权与可发现全集）；运行时经 M28 分层自动收敛：**20 项 core 常驻 + 34 项 deferred 由 `tool_search` 按需激活**（浏览器 / Git / 数据库 / 定时 / 媒体 / 画布 / 联网 / SSH / 命令）；`fin_*` / `mcp__*` 通配应对开关与 MCP 增删 |
| 收尾闭环 | 每轮完成交还用户（`turn:end.mentions=['user']` + `notify:awaiting-user`）——单助手一问一答形态，非静默 |
| 不可自动召集 | 通用助手不进入 PRS 目录 / 路由校验 / handoff 增援解析（三层隔离）；其他会话无法通过平台机制把它拉入；**成员面板手动邀请保留**（资产型边界） |
| 可编辑可热更 | 控制台可编辑 `blank` 场景与 `general` 角色（与全部资产同一套工件）；mtime 热更新即时生效 |
| 零破坏 | 既有 18 场景 / 73 角色 / 全部入口零改动；多成员会话路由行为零变化；DB 模型 / HTTP 协议零变更 |
| 门禁全绿 | 四包 typecheck / lint / 双端 vitest / build / check:agents / E2E / eval 全绿（含计数镜像面全量核对） |

### 1.3 定位与边界（与既有资产切割）

| 既有 | 定位 | 与本专项关系 |
| --- | --- | --- |
| 空编制创建（M48） | 0 人提交 = 交给平台组队 | **保留**，与空场景是两种不同用户意图（见 §4.2 入口区分表） |
| 平台路由步 PRS（M48） | 未 @ 消息 / 空编制开场的自动组队与派发 | 复用于全部既有会话；空场景单成员时**不进入** PRS（直通） |
| 通用调度官「知舟」（M46，已撤销） | 机制人格化的资产角色 | 反面教训：本次**不新增任何机制字段 / 机制角色**，以「编制判定 + 场景 id 常量」实现 |
| 业务角色 73 个 | 单一业务职责 + handoff 协作基线 | 零改动；通用助手是第 74 个角色，但**差异化定位**（见下表） |
| ops/assistant「沐晨」 | 行政助理（业务人设） | **不复用**：业务人设 + handoff + 业务技能预载，与「无角色」定位冲突 |

**通用助手与其他角色差异表**：

| 维度 | 业务角色（73） | 通用助手 general |
| --- | --- | --- |
| 人设 | 姓名 / 业务职责 / 交付契约 | 无业务人设；职责 = 独立完成用户需求 |
| 工具 | 按职责最小授权子集 | 授权 = 全量 − `handoff`（54 项 + 通配）；运行时分层：core 常驻、重型能力经 `tool_search` 按需 |
| handoff | 含（结构化转交为第一通道，ADR 2） | **不含**（单助手纪律：不可转交，物理上不可能） |
| 灵魂 | 可选（部分角色有 souls/） | 无（不建 souls/ 目录 = 确定性无灵魂） |
| 平台召集 | 可被 PRS / handoff 增援自动召集 | **不可**（§5.3 三触点隔离）；仅用户手动可邀 |
| 路由 | 未 @ 消息由 PRS 派发 | 单成员编制：未 @ 直达（跳过 PRS） |
| 应用场景 | 场景协作（多成员接力） | 空场景直聊（单 Agent 模式） |

---

## 2. 现状盘点（设计相关既有机制）

### 2.1 启动路由（M48 `launch()` 三分支，engine.ts 约 297–307 行）

```
const queue =
  mentioned.length > 0
    ? [...mentioned]                                        // ① @ 直达（零变化）
    : explicitMode && session.participantIds.length > 0
      ? [session.participantIds[0]]                          // ② 消息级 plan/review → 编制首位
      : []                                                   // ③ 未 @ / 空编制 → routingPending → PRS
const needsRouting = queue.length === 0
```

- `runLoop` 开头消费 `routingPending` → `routeByPlatform()`（非角色回合：不产生消息、不占波次）；
- PRS 输入三件套：`buildRosterCatalogBlock(prompts, presentIds)`（未在场角色目录）+ `knownIds`（全量资产校验集）+ `presentIds`；输出经 `coerceRoutePlan` 容错过滤（未知 / 已在场 / `'user'` 丢弃）；
- 空场景直通 = 在分支③之前插入「编制恰为 `[general]` → 直达」判定（§5.2），**不触碰 ③ 的既有语义**。

### 2.2 收尾语义（无 handoff 的等效性——设计的关键论证）

通用助手无 `handoff` 工具，需确认「每轮结束是否仍能干净收尾」。读取 `scheduler.ts` 的 `mergeWaveSchedule`（约 262–287 行）与 `engine.ts` `finishTurn`（1239 行起）后可确认**等价性成立**：

| 步骤 | 单成员波、无 handoff 提案 | 结果 |
| --- | --- | --- |
| `decideHandoff` | `mentions=[]`，`handedToUser=false`（auto 模式文本解析，正文无 @用户） | `accepted=[]` |
| 波级合并 | `acceptedAll=[]`、`allHanded=false`（非全员交还）→ 队列空 → **收尾兜底**：`participants.find(未发言)` 无候选 → `handedToUser=true` | `acceptedByAgent = handedByAgent = ['user']` |
| `finishTurn` | `turn:end.mentions=['user']`（前端渲染「交还给你」chip，图谱口径一致） | 与手写 `handoff user` 逐字段一致 |
| `finishRun` | `reason='completed' && handedToUser` → 广播 `notify:awaiting-user` | 与多成员会话交还用户的收尾零差异 |

即：**单助手模式无需任何引擎特判，波末兜底天然产出「停轮等你」的收尾**——每轮一问一答，用户决定何时继续。若模型自行在正文写了 `@用户` 也无影响（`handedByAgent` 同样标注 `['user']`）。

### 2.3 通用助手的三个既有「进入路径」（隔离点定位）

| # | 路径 | 代码位置 | 行为 |
| --- | --- | --- | --- |
| ① | PRS 目录可见 | `roster-catalog.ts` `buildRosterCatalogBlock`（52–53 行取 `prompts.list()` / `groups()` 全量） | 若不过滤，「空编制/未 @」会话的 PRS 会把通用助手列为可召集人 |
| ② | PRS 决策校验 | `engine.ts` `routeByPlatform`（约 1366 行 `knownIds: new Set(prompts.list().map(a => a.id))`） | 不过滤则 PRS 幻觉输出 `general` 仍会被放行召集 |
| ③ | handoff 增援 | `engine.ts` `buildToolRuntime` 的 `resolveAgent`（1841–1846 行，全量资产解析；`handoff` 工具 634–651 行先查在场、再查 `resolveAgent`，命中即放行并自动召集） | 不过滤则其他会话成员可 handoff「通用助手」→ 平台自动增援拉入 |
| ④ | 通用助手自身 | 资产 `tools` 白名单 | 含 `handoff` 则单助手可主动转交/召集他人——违背单助手纪律 |

设计对 ①②③ 全部加过滤、④ 以白名单去除（§5.3）；**成员面板 / 成员 API（`inviteMembersCore`）不做限制**——通用助手是可被用户显式邀请的完整资产（资产型决策的边界）。

### 2.4 前端入口现状（组队台来源栏；M50 前为 SessionList 三步流）

> M50（ADR 0102 / design.md §59）已将建会话改为 `CreateSessionDialog` 三栏组队台——下述行号为组队台前的现状记录，入口语义本身不变：点来源行 = 推荐编制（`chain` / `members`）整体替换；blank 落点见 §5.6 落点修订（「来源」栏顶部独立卡 + 列表过滤）。

- step 0（`SessionList.tsx` 424–541 行）：快速组队 grid（`presets.map`）→ 按场景组队列表（`groups.map`，482 行）→「自由组合」虚线按钮；
- step 1：`AgentPicker` + 0 人提示（586–590 行「未选成员：首条消息将由平台自动组队并派发任务」）+ 提交按钮（picked>0 = 「创建并进入（N 位成员）」，0 人 = 「空编制创建 · 交给平台组队」）；
- `pickScene(groupId)`（136–144 行）：按 `chain` 预选已知成员 → step 1——**空场景卡的点击处理可直接复用**（`chain=[general]` 预选 1 人）；
- 命令面板（`CommandPalette.tsx` 200–213 行）：`groups.map` 生成「新建会话：{场景名}」命令 → `requestCreate('scene', id)` → SessionList `pendingCreate` 同源进入 step 1——**blank 加入后自动多一条「新建会话：空场景」，零新代码**；
- 空态引导（`ChatArea.tsx` 122–128 行）：`guideTitle` 优先取首位成员所属场景的 `guide`、`agenda` chips 同源——**blank 资产落盘即自动生效，零代码**。

---

## 3. 设计原则

1. **零机制字段**：不新增 `solo: true` 之类的资产字段（M48 撤销 `dispatch` 的教训）——单助手行为由「编制实时派生」+ 场景 id 常量判定；
2. **零引擎特判分支**：除 `launch()` 的一处「编制恰为 [general] 直达」外，不改动任何调度语义；收尾、波次、范式全部复用既有等价路径（§2.2）；
3. **隔离用减法、能力用资产**：对「平台自动召集」做三处减法（§5.3），对「工具能力」用白名单声明（54 项 + 通配）；
4. **资产单一事实源**：展示名 / 引导 / 议程 / 工具白名单全部落在 `agents/blank/`，控制台可编辑、热更新生效；
5. **实时派生、无迁移**：单助手判定只看「当前编制」，用户加人/减人即时切换语义（加人后自动恢复 PRS 多成员规则），无会话字段、无数据迁移；
6. **复用入口惯例**：建会话对话框置顶独立卡 + 场景列表过滤（blank 不作为「按场景组队」的普通场景展示）；命令面板 / @ 列表 / 成员选择器等既有遍历点**自然保留**（资产型）。

---

## 4. 总体方案

### 4.1 决策摘要表

| # | 决策点 | 结论 |
| --- | --- | --- |
| D1 | 场景资产 | 新增 `agents/blank/`：`_group.yaml`（id `blank`，name 空场景，order 1，chain `[general]`）+ `general/AGENT.md` + `_protocol.md`（单助手纪律） |
| D2 | 通用助手形态 | 资产型第 74 角色 `general`「通用助手」：无业务人设、无 souls、无 handoff、白名单 = 全量 − handoff（54 项 + `fin_*` / `mcp__*`）；运行时经 M28 分层：20 项 core 常驻 + 34 项 deferred 经 `tool_search` 按需激活（不改 tier、零新增机制） |
| D3 | 单助手判定 | 编制恰为 1 且该成员 `group === BLANK_SCENE_ID` → 未 @ 消息直达本人（跳过 PRS）；规则实时派生，加人即退出单助手模式 |
| D4 | 不可自动召集 | 三层隔离：roster-catalog 过滤 / routeByPlatform `knownIds` 过滤 / `resolveAgent` 过滤；成员面板手动邀请保留 |
| D5 | 收尾语义 | 零改动：波末兜底天然产出 `handedToUser=true` → `turn:end.mentions=['user']` + `notify:awaiting-user`（§2.2 等价性论证） |
| D6 | 前端入口 | step 0 置顶「空场景」独立卡（复用 `pickScene('blank')`）；「按场景组队」列表过滤 blank；其余遍历点自然保留 |
| D7 | 常量 | `shared/src/types.ts` 导出 `BLANK_SCENE_ID = 'blank'`（server / client 共用单一事实源） |
| D8 | 计数镜像 | 18→19 场景、73→74 角色；m21.test.ts / agents/README.md / CHANGELOG 同步；顺手清理 README 的 M48 遗留 stale 两行（§7.5） |

### 4.2 用户体验剧本（端到端）

> 落点注记：下述「step 0 / step 1」为组队台（M50）之前的向导语言；实施落点为组队台「来源」栏独立卡（§5.6 落点修订），交互语义（独立入口 + 1 人预选 + 列表过滤）不变。

1. **入口**：左侧「新建会话」→ 对话框 step 0 置顶灰色卡片「空场景 · 单 Agent · 1 位成员」+ 描述「不引入任何角色，只与一个通用助手直聊」；
2. **确认**：点击卡片 → step 1（已选 1 位：通用助手；可增删、可改标题）→「创建并进入（1 位成员）」；
3. **空态**：会话打开，空态 = 场景图标（message-circle）+ `guide`「直接说出你的需求，由通用助手独立完成」+ 4 个 agenda 推荐 chip（点击预填草稿，不直发）——全部资产驱动；
4. **直聊**：用户发消息（无 @）→ **直达通用助手**（无 PRS 调用、无「平台召集」事件条）→ 流式回复 + 工具调用（检索 / 写文件 / 表格 / 命令…）→ 波末「交还给你」（`notify:awaiting-user` + chip）→ 用户继续，多轮一问一答；
5. **升级路径（可选）**：成员面板邀请某业务角色 → 编制变 2 人 → 单助手模式即时失效，未 @ 消息恢复 PRS 组队（与全部会话一致）；或直接新建场景会话。

**两个相近入口的区分表**（均保留，不合并）：

| 入口 | 编制 | 首条未 @ 消息行为 | 适用 |
| --- | --- | --- | --- |
| **空场景**（新增独立卡） | `[general]` | 直达通用助手（单 Agent，零路由开销） | 一个人干完，不要角色分工 |
| 自由组合 → 0 人（空编制创建） | `[]` | PRS 自动组队并派发（多 Agent） | 不确定找谁，交给平台组队 |

---

## 5. 详细设计

### 5.1 资产：`agents/blank/`（三件套全文草案）

#### 5.1.1 `agents/blank/_group.yaml`

```yaml
id: blank
name: 空场景
description: 不引入任何角色，只与一个通用助手直聊——单 Agent 模式，独立完成各类任务
icon: message-circle
theme: ["#64748b", "#94a3b8"]
objective: 由通用助手独立完成用户需求
chain: [general]
order: 1
guide: 直接说出你的需求，由通用助手独立完成
agenda:
  - label: 起草文档
    prompt: 帮我起草一份文档，主题是：
  - label: 调研对比
    prompt: 帮我调研一下（联网检索、给出信源与对比结论）：
  - label: 整理数据
    prompt: 把下面这组数据整理成表格并做要点分析：
  - label: 直接干活
    prompt: 帮我完成这个任务：
```

- `order: 1` → 场景排序居首（对话框独立卡 + 控制台 / 资产列表首位；m21 排序断言同步，§7.5）；
- `parallel` / `rounds` / `defaultSkills` 均不配置（单成员无并行语义；无预载技能，按需 `load_skill`）；
- 不配 `_presets.yaml`（快速组队是「多角色编制」概念，空场景不需要）。

#### 5.1.2 `agents/blank/general/AGENT.md`

front-matter：

```yaml
---
id: general
name: 通用助手
role: 通用助手
title: General Assistant
description: 单 Agent 模式的通用执行者：不预设业务人设，直接按需求使用全套工具独立完成
capabilities: [对话问答, 检索调研, 文档写作, 数据处理, 任务执行]
avatar:
  icon: sparkles
  gradient: ["#64748b", "#94a3b8"]
tools: [list_dir, read_file, write_file, edit_file, apply_patch, search_text, glob, grep,
        web_fetch, web_search, calc, date_calc, csv_analyze, template_fill,
        remember, write_todos, load_skill, tool_search, run_command,
        git_status, git_diff, git_log, git_branch, git_commit, git_restore,
        request_approval,
        db_list_connections, db_schema, db_query, db_execute,
        browser_open, browser_navigate, browser_snapshot, browser_click, browser_fill,
        browser_press, browser_scroll, browser_wait, browser_screenshot, browser_console,
        browser_eval, browser_close, browser_request_human, ssh_exec,
        write_plan, update_plan_step, submit_review,
        canvas_read, canvas_write, media_generate, media_video,
        schedule_task, list_schedules, manage_schedule,
        "fin_*", "mcp__*"]
temperature: 0.5
---
```

白名单说明（54 精确项 + 2 通配 = 56 条目）：

- **= 全部已启用工具 − `handoff`**（默认注册 55 项，FINANCE_ENABLED=false 时不注册 `fin_*`）：`handoff` 的缺席即「单助手纪律」的物理实现；
- `fin_*` 通配：金融开关启用后（+12 工具）自动可用；未启用时通配零命中、白名单合法（控制台校验放宽「精确名或尾部 `*`」，AssetManager 已支持）；
- `mcp__*` 通配：会话绑定的 MCP 工具（M27）全量可用，与服务器增删解耦；**附带效应（已适配）**：该通配使 MCP 管理台「N 个工具零可达」警示对新增服务器不再出现（工具恒被通用助手可达）——`e2e/m27-mcp.spec.ts` 已按新语义调整（零可达徽章反向断言 + 授权矩阵命中「通用助手」徽章），M27 授权链路守护不变；
- 显式枚举而非「缺省=全部」：缺省会包含 `handoff`，枚举是唯一无特例的实现方式（registry 白名单为 include-only，无黑名单机制）；
- 不含 `handoff` 后的完整性核对：其余 54 项覆盖文件 / 检索 / 计算 / 数据 / 命令 / git / 审批 / 数据库 / 浏览器 / SSH / 范式工具 / 画布媒体 / 定时——「harness 全能力」；
- 门控一致性：`git_*` 受 M47 会话模式门控（sandbox 会话不进模型清单，repo / worktree 可见，index.ts `isGitMode` 注入），与全部 agent 同一机制——「全能力」= 全部**已注册且未被门控**的工具。

**运行时 = 核心常驻 + `tool_search` 按需（M28 分层，零新增机制）**：白名单是「授权与可发现全集」，**不等于每轮注入模型的清单**——引擎把 `tier === 'deferred'` 的工具折叠出清单（engine.ts 1514–1516 行），模型经 `tool_search` 检索激活（命中即入 Run 级激活集，下一子轮起本任务内持续可用）。本白名单自动分层结果：

| 层 | 数量 | 清单 |
| --- | --- | --- |
| core · 常驻 | 20 | 文件 8（list_dir / read_file / write_file / edit_file / apply_patch / search_text / glob / grep）· 计算与模板 4（calc / date_calc / csv_analyze / template_fill）· 记忆待办技能 4（remember / write_todos / load_skill / tool_search）· 审批 1（request_approval）· 范式 3（write_plan / update_plan_step / submit_review） |
| deferred · 按需 | 34 | 浏览器 13 · Git 6 · 数据库 4 · 定时 3 · 媒体 2 · 画布 2 · 联网 2（web_search / web_fetch）· SSH 1 · 命令 1（run_command） |

- 分层启用判定：`resolveDiscovery` auto 模式——deferred 条目数 ≥ `TOOL_SEARCH_MIN`（默认 10）→ 必然启用（本白名单 34 项）；启用后系统提示自动注入 `<tool_discovery>` 分组概览（约 100–200 token），`tool_search` 工具说明引导模型「任务需要时先检索」；
- 发现域约束：`tool_search` 的检索域 = **白名单内的 deferred 集**（engine.ts 1936 行）——所以白名单必须包含 deferred 工具（授权全集），否则「按需能力」不可发现；**「核心 + tool_search」的运行时效果由 tier 分层自动达成，无需缩短白名单**（缩短反而丢能力）。

正文（四段骨架，零业务人设）：

```markdown
你是「通用助手」：空场景下的唯一成员，以单 Agent 模式独立完成用户需求。

## 职责

- 独立执行：直接按用户需求完成检索、写作、数据处理、任务执行与代码工作，不依赖他人接手。
- 全程贯通：从判断需求 → 执行 → 交付 → 收尾由你一人完成；产出写入工作区交付件。
- 适度澄清：需求含糊且影响方向时，先用一两句确认关键口径；信息足够就直接开工，不空转。

## 工作方式

1. 先判断需求类型（问答 / 检索 / 写作 / 数据处理 / 任务执行），选择最短完成路径。
2. 善用工具而非空谈：检索用 web_search / web_fetch，计算用 calc，数据处理用 csv_analyze，交付用 write_file 落盘。
3. 交付件优先：成果写入工作区（docs/ 等目录），回复中给出路径与三行以内要点概览。
4. 单助手纪律：不转交任务、不等待其他角色（本场景没有其他成员）。

## 交付契约

- 形成交付件时写入工作区并在回复中给出文件名与要点概览。
- 完成定义：用户需求得到直接回应或可验证产出；回复末尾明确交还用户。
- 信息不足且无法推断时，给出「需要你补充什么」清单，而不是原地打转。

## 协作接口

- 上游：用户直接输入；下游：用户本人（独立完成后交还）。
- 本场景不参与多成员接力与平台路由；用户若需要多角色协作，建议其新建场景会话或邀请成员。
```

#### 5.1.3 `agents/blank/_protocol.md`

```markdown
<scene_protocol scene="blank">
你是「空场景」的通用助手：本场景只包含你一位成员，以单 Agent 模式独立完成用户需求。

## 单助手规则

1. 独立完成：不依赖其他角色、不转交任务；需求跨领域时按「先给可用结果，再列后续建议」推进。
2. 工具直用：检索、计算、数据处理、文件读写、命令执行等工具按需直接使用；写类工具按全局审批策略执行。
3. 交付清晰：产出落盘工作区（给出文件路径）；无法落盘时在回复内给出完整可用的结果。
4. 收尾直接：每轮完成后交还用户；如需继续，给出一到三行「下一步建议」，不空转、不复读。
5. 汇报诚实：工具失败或信息缺位时如实说明并给出替代路径，不编造结果。

## 交付

- 有明确产物：写入工作区，回复给出路径与要点概览。
- 无明确产物：回复内给出结构化答案（结论 / 依据 / 待确认）。
</scene_protocol>
```

### 5.2 引擎：单助手直通（`launch()` 变更）

`server/src/orchestration/engine.ts` `launch()`（现行 297–307 行）：

```ts
// 现状
const queue =
  mentioned.length > 0
    ? [...mentioned]
    : explicitMode && session.participantIds.length > 0
      ? [session.participantIds[0]]
      : []
```

```ts
// M50 变更（新增 soloBlank 判定，其余零改动）
const soloBlank =
  session.participantIds.length === 1 &&
  this.deps.prompts.get(session.participantIds[0])?.group === BLANK_SCENE_ID
const queue =
  mentioned.length > 0
    ? [...mentioned]
    : (soloBlank || explicitMode) && session.participantIds.length > 0
      ? [session.participantIds[0]]
      : []
```

- 语义：编制恰为 1 **且**该成员属空场景 → 未 @ 消息（含会话「规划先行」/消息级 plan / review）一律直达本人；`needsRouting` 保持原样（`queue.length === 0` 才为 true）；
- **保守边界**：其他场景的单成员会话（如手动建 `[backend]`）不享受直通——仍走 PRS，M48 行为零变化；
- **实时派生**：判定只看当前编制——加人（≥2）或换人（非 blank group）即自动退出，无字段、无迁移；
- `shared/src/types.ts` 新增：

```ts
/** M50：空场景（单助手直聊）场景 id —— 单成员编制时未 @ 消息直达本人，不进入平台路由 */
export const BLANK_SCENE_ID = 'blank'
```

### 5.3 纪律：通用助手不可自动召集（三层隔离 + 资产缺口）

| # | 触点 | 文件 / 位置 | 变更 |
| --- | --- | --- | --- |
| ① | PRS 目录 | `server/src/orchestration/roster-catalog.ts` `buildRosterCatalogBlock`（52–53 行） | `prompts.list()` / `prompts.groups()` 过滤 `group !== BLANK_SCENE_ID`（PRS 看不到通用助手） |
| ② | PRS 校验 | `server/src/orchestration/engine.ts` `routeByPlatform`（约 1366 行） | `knownIds` 排除 blank 成员（PRS 幻觉输出 `general` 也被 `coerceRoutePlan` 丢弃） |
| ③ | handoff 增援 | `server/src/orchestration/engine.ts` `buildToolRuntime.resolveAgent`（1841–1846 行） | 排除 blank 成员：`handoff` 工具解析不到 → 返回「「通用助手」不在场」错误 → 模型按提示重选（不产生自动召集） |
| ④ | 自身转交 | `agents/blank/general/AGENT.md` 白名单 | 无 `handoff` → 单助手物理不可主动转交 / fan-out |

```ts
// ③ 变更示意（engine.ts）
resolveAgent: (token) => {
  const byId = this.deps.prompts.get(token)
  if (byId && byId.group !== BLANK_SCENE_ID) return { id: byId.id, name: byId.name }
  const match = this.deps.prompts
    .list()
    .find((a) => a.group !== BLANK_SCENE_ID && a.name === token)
  return match ? { id: match.id, name: match.name } : undefined
},
```

**边界（明确保留的能力）**：

- 用户可在成员面板 / 成员 API 手动邀请通用助手加入任意会话（资产型语义；邀请后它与普通成员同权）；
- 空场景会话内，用户 @ 不在场角色 → `parseMentions` 过滤后视为未 @ → 直达通用助手（正文中的 @ 字样仅作文本）；通用助手不可自行拉人；
- 通用助手**在场**时（被手动邀请），PRS 可把任务派给在场的它（`assignments ∈ present`，M48 既有语义，无需改动）。

### 5.4 收尾与范式兼容

| 场景 | 行为 | 说明 |
| --- | --- | --- |
| 普通回合收尾 | 波末兜底 → `handedToUser=true` → `turn:end.mentions=['user']` + `notify:awaiting-user` | §2.2 等价性；零引擎改动 |
| `write_plan`（planFirst / 消息级 plan） | 只读 + `write_plan` 挂起 → 批准后派发执行；负责人 = 计划步骤内的本人 | M24 既有语义；`MODE_EXTRA_TOOLS.plan` 含 `handoff`，但白名单交集后不可见（通用助手白名单无 handoff），无副作用 |
| `submit_review` | 只读 + `submit_review`；blank 会话无评审对象时报「未启用 / 无目标」 | M24 既有语义 |
| 断点恢复 / 停止 / 超时 | 与全部会话一致 | 零改动 |
| Run 记录 / trace / 用量 | 全部既有形状；**无 `__router__` 用量**（直通不经过 PRS） | 可断言（§7.1） |
| 审批门（`request_approval`） | 白名单含审批工具；写类 / 高危动作的挂起审批流与全部会话一致 | M7 既有语义 |

### 5.5 其他 Run 启动路径覆盖核验（逐条读码：全部天然兼容，零改动）

单助手判定只加在 `launch()` 一处；其余 Run 启动路径均不经 PRS（`routingPending: false` 或队列已定），逐条核验结论如下：

| 路径 | 入口 | 队列来源 | 结论 |
| --- | --- | --- | --- |
| 主消息发起 | `POST /sessions/:id/messages` → `launch()`（routes/sessions.ts 443 行） | `soloBlank` 判定（§5.2） | **本设计唯一改动点** |
| 断点恢复 | `POST /sessions/:id/resume` → `resume()`（engine.ts 522–531 行） | `snapshot.queue.filter(在场)` | 恢复既有队列，不再路由；零改动 |
| 续写 | `resumeMessage()`（691–738 行） | `queue: []` + `routingPending: false`，复用原消息 `agentId` 继续 | 续写的即通用助手消息；零改动 |
| 重生成 | `regenerateMessage()`（744–796 行） | 同上（重跑原 `agentId`） | 零改动 |
| 计划执行 | `launchPlanExecution()`（372–384 行） | `planOwnerQueue(approved)`（步骤负责人） | 负责人 ∈ 会话成员（blank 场景 = 通用助手自领）；零改动 |
| 波次插话 | `runLoop` 波次边界（995–1010 行） | `mentioned → fresh（未发言）→ participantIds[0]` | solo 下兜底即通用助手；零改动 |
| 定时任务到点 | M35 `kind=run` → `ScheduleService` 的 `launch` 回调（index.ts 335 行） | 继承 `launch()` 判定 | 继承直通语义；零改动 |

### 5.6 前端：入口与列表

> **落点修订（实施对齐）**：M50 与「建会话组队台」重构（三栏：来源 / 角色池 / 编制，取代原两步向导）同期落地；本节原「SessionList step 0 独立卡」在实施时对齐为**组队台「来源」栏顶部独立卡**——语义与交互同设计（独立入口 + 列表过滤），零额外机制。

**变更点一：「来源」栏顶部「空场景」独立卡**（`CreateSessionDialog.tsx` sourcePane 滚动容器首位、快速组队区块之前）：

```tsx
const blankGroup = groups.find((g) => g.id === BLANK_SCENE_ID)
const blankHit = Boolean(blankGroup &&
  (!q || blankGroup.name.toLowerCase().includes(q) || blankGroup.description.toLowerCase().includes(q)))
...
{blankGroup && blankHit && (() => {
  const on = source?.kind === 'scene' && source.id === blankGroup.id
  return (
    <button type="button" aria-label={`组队来源：${blankGroup.name}`} aria-pressed={on}
      onClick={() => pickSource({ kind: 'scene', id: blankGroup.id })}  // 复用选来源：chain=[general] → 编制预选 1 人
      className={cn('w-full rounded-xl border p-2.5 text-left ...', on ? 'border-primary/45 bg-primary/[0.05]' : '...')}>
      ... 微标「单 Agent · 1 位成员」...
    </button>
  )
})()}
```

**变更点二：「按场景组队」列表过滤 blank**（避免双入口；搜索后同步过滤）：

```tsx
const groupList = (q ? groups.filter(命中 name/description) : groups)
  .filter((g) => g.id !== BLANK_SCENE_ID)
```

**零改动清单（自然生效 / 自然保留）**：

| 位置 | 行为 |
| --- | --- |
| 编制栏（lineup） | **不过滤**：需显示已选的通用助手，也允许用户在其上增删成员 |
| `pickSource` / `pendingCreate` | 复用：命令面板 `requestCreate('scene','blank')` → 初始 source 预置 `{kind:'scene',id:'blank'}`（零新代码） |
| CommandPalette 场景命令 | `groups.map` 自然多出「新建会话：空场景」 |
| ChatArea 空态 | `guide` / `agenda` / 图标自动取 blank 资产；`participants.length===0` 的空编制特供文案不触发（1 人会话） |
| Composer @ 列表 | `rank` 由 groups 顺序派生 → 通用助手排首位（order 1，预期行为） |
| 成员面板 / 图谱 / 控制台 | blank 作为普通场景渲染，可编辑（资产型） |

### 5.7 边界与失效条件

| 情形 | 行为 |
| --- | --- |
| 用户移除 general 至 0 人 | 变空编制 → 未 @ 消息走 PRS（「交给平台组队」语义）——合法且可预期 |
| 用户把 general 换成单个业务角色（如 `[pm]`） | 非 blank solo → 未 @ 走 PRS（现状不变） |
| 用户手动把 general 邀入业务会话 | 与普通成员同权；handoff 到它 = 「不在场」错误（resolveAgent 拒绝，§5.3 ③），显示名可从成员面板复制核对 |
| PRS 幻觉输出 `members: ['general']` | `coerceRoutePlan` 以 `knownIds` 丢弃（§5.3 ②），trace 无召集记录 |
| blank 资产被删除（违规操作） | `launch` 判定 `get()?.group` 为 undefined → 不进直通分支，走 PRS 兜底；`check:agents` 会在交付前拦截场景无成员错误 |
| FINANCE_ENABLED / MCP 变化 | 白名单通配零命中或自动覆盖，无需改资产 |
| 失效条件 | 「单助手判定」依赖资产 group id 常量（`BLANK_SCENE_ID`）与编制实时状态；未来若引入「多会话模板」类机制，需复核本判定的适用范围，**不得**改为资产特例字段 |

---

## 6. ADR 决策项（0103–0106，已落盘）

### 6.1 决策汇总

| ADR | 决策 | 要点 |
| --- | --- | --- |
| **0103** | 空场景资产与单助手纪律 | `blank` 场景 + `general` 角色（无业务人设 / 无 souls / 无 handoff / 白名单 54 项 + 通配）；工具运行时复用 **M28 分层**（20 项 core 常驻 + 34 项 deferred 经 `tool_search` 按需激活，零新增机制）；`_protocol.md` 单助手规则；计数 19 / 74 |
| **0104** | 单助手直通路由 | 编制恰为 `[general]` → 未 @ 直达，跳过 PRS；规则实时派生（加人即退出）；`BLANK_SCENE_ID` 共享常量；其他单成员场景零变化 |
| **0105** | 通用助手不可自动召集 | 三层隔离（roster-catalog / knownIds / resolveAgent）+ 白名单缺口；成员面板手动邀请保留；在场时可被 PRS 正常派发 |
| **0106** | 空场景入口形态 | 组队台「来源」栏顶部独立卡（复用 `pickSource`）；「按场景组队」列表过滤 blank；命令面板 / @ 列表 / 成员选择器自然保留 |

### 6.2 ADR 落盘清单（文件与标题；正文按 ADR 0101 模板五段展开）

| 文件 | 标题 |
| --- | --- |
| `docs/adr/0103-blank-scene-general-agent.md` | ADR 0103：空场景与通用助手资产（M50） |
| `docs/adr/0104-solo-blank-direct-routing.md` | ADR 0104：单助手直通路由——编制恰为 `[general]` 时跳过平台路由（M50） |
| `docs/adr/0105-general-agent-non-recruitable.md` | ADR 0105：通用助手不可自动召集——三层隔离（M50） |
| `docs/adr/0106-blank-scene-entry.md` | ADR 0106：空场景入口形态——组队台独立卡与场景列表过滤（M50） |

模板五段：背景 / 决策 / 理由 / 被否决的方案 / 适用与失效条件；已同步 `docs/adr/README.md` 索引（design.md §11 汇总表只列到 #96，97+ 以 README 索引为准）。

### 6.3 被否决方案

- **复用「空编制创建」代替空场景**：语义冲突——空编制的定义是「交给平台组队」，正是单助手模式要规避的行为；两入口并存、文案互斥（§4.2 区分表）；
- **复用 ops/assistant「沐晨」充当通用助手**：业务人设（行政助理）+ `handoff` + 业务技能预载，与「无角色」定位冲突；且会破坏该角色既有会话行为；
- **新增资产字段（`solo: true` / `standalone: true`）**：M48 撤销 `dispatch` 的直接教训——机制不应人格化 / 特例化为资产字段；编制判定零字段、零迁移；
- **引擎按「无 handoff 工具」间接判定单助手**：以资产白名单细节承载路由机制，脆弱且不可读（白名单随时可被控制台编辑）；编制 + 场景 id 判定直接表达用户意图；
- **PRS 内识别 blank 场景并派给 general**：多一次 LLM 调用与首响延迟，「单 Agent 模式」不该为路由付任何开销；
- **空场景会话禁止加人（锁定编制）**：违背资产型与用户自由度；实时派生已保证加人后语义正确（自动恢复 PRS）；
- **前端按会话硬编码空态文案**：`guide/agenda` 资产已驱动空态（M37），硬编码引入第二事实源。

---

## 7. 测试与评测

### 7.1 server 单测（新增 `server/tests/m50-blank.test.ts`）

真实资产（`realLibrary` 模式）+ 引擎级行为断言：

1. **资产**：`groups()` 含 `blank`（order 1 居首）；`general` 加载且 `tools` 不含 `handoff`、含 54 精确项（与 registry 默认 55 项差集 = `['handoff']` 的镜像断言）；**M28 分层断言**：mock 引擎跑一轮——`resolveDiscovery.enabled === true`、首个子轮 `request.tools` 不含 `browser_*` / `web_search` / `run_command`（deferred），`tool_search` 激活后下一子轮含；`_protocol.md` 装载（`scene="blank"`）；
2. **直通路由**：编制 `[general]` 的会话发未 @ 消息 → `launch()` 返回 `queue=['general']`、`queued=false`；无 `routing:dispatched` trace（PRS 未触发）、`usage` 无 `__router__` 记录；
3. **收尾**：Run 完成后消息 `mentions=['user']`、`notify:awaiting-user` 广播、`run:end.reason='completed'`（§2.2 等价性回归）；
4. **隔离**：`buildRosterCatalogBlock(prompts, [])` 输出不含 `general`；`coerceRoutePlan({members:['general']}, knownIds)` 丢弃；handoff 工具 `resolveAgent('通用助手')` 返回 undefined（报「不在场」）；
5. **实时派生**：编制 `[general, pm]`（手动邀请后）发未 @ 消息 → `routingPending=true`（恢复 PRS）；编制 `[pm]` → 仍走 PRS（保守边界回归）。
6. **既有测试适配**（计数与单助手例外清单，已实施）：`m21.test.ts` — 场景数组前置 `'blank'`（19 场景）、`lib.list()` 长度 74、`slice(0, 4)` = `['general','chief','strategist','pricing']`；`m29-code-bindings.test.ts` — 「全部角色均含 handoff」改为 blank 场景外（general 单助手为唯一无 handoff 例外）；`m35-schedule-bindings.test.ts` — 能力边界持有者集合排除 blank 场景（general 持全套工具，含定时三件套，不纳入扩散约束）。

测试基座沿用 M48 模式：真实 `agents/` 资产 + 临时 DATA_DIR 启动引擎，脚本化 Provider（`installScript`）记录每请求 `agentId / responseFormat`，直接断言 `launch()` 返回值与 Run 事件流；「未触发 PRS」以**双通道**判定——请求流无 `platform_route` 响应格式调用（调用未发生）+ trace 无 `routing:dispatched` 事件（决策未产出）。M28 分层断言需自建引擎注入 `ToolDiscoveryService`（helpers.makeEnv 默认不装配发现，同 `m28-engine-search.test.ts` 模式）。

### 7.2 client 单测（新增 `client/tests/m50-blank-frontend.test.tsx`）

> 文件名说明：M50 与「建会话组队台」重构同期落地，组队台测试已占用 `m50-frontend.test.tsx`；空场景前端测试独立为 `m50-blank-frontend.test.tsx`（两文件互不改写）。

沿用既有 frontend 测试的 fixture 模式（mock agent-store / session-store / fetch），覆盖组队台「来源」栏（5 用例）：

1. 「来源」栏顶部渲染「空场景」独立卡（置顶、微标「单 Agent · 1 位成员」）；点击 → 选中态 + 编制「已选 1 位」显示通用助手；
2. 「按场景组队」列表不含「空场景」条目（filter 生效，避免双入口）；
3. 搜索：命中保留独立卡 / 不命中隐藏 / 全空态文案；提交 → `POST /sessions` body `participantIds: ['general']`；
4. CommandPalette：命令列表含「新建会话：空场景」；触发后同源进入（`pendingCreate {kind:'scene',id:'blank'}` 消费，预选 1 人）。

### 7.3 E2E（新增 `e2e/m50-blank.spec.ts`）+ mock 增补

mock（`server/src/llm/mock.ts`）**实际增补四处**（①②③ 为既定项；④ 为实施中发现的必要修复）：

```ts
// ① SCRIPTS 表新增 general（单助手口径 3 句；文案以 mock.ts 为准，含「我来独立完成」= E2E 锚点）
general: (ctx) => [
  `收到，${topicName(ctx)}这件事我来独立完成：…关键口径不确定的地方已在交付件里列成「待确认」。`,
  `进展：按需直接用了工具（检索 / 计算 / 数据处理 / 文件读写），结论与依据分开写，未核实项不混入结论。`,
  `产出在 \`${ctx.artifactPath}\`，要点如上；要继续深挖哪一块直接说。`,
],
// ② artifactFor 新增 case（default 之前）—— 路径对齐全局「交付件」口径（非草案「助手产出-」）
case 'general':
  return { path: `docs/交付件-${t}.md`, content: doc(`${t}·助手产出`, …) }
// ③ DISPLAY_NAMES 增：general: '通用助手'（转交行展示）
// ④ 范式信号适配（bug 修复，防计划卡挂起）：
//    write_plan / submit_review 分支与「脚本化工具批」放行条件原以「工具清单含 write_plan/submit_review」
//    判定 M24 规划 / 评审范式；general 白名单常驻这两者（core 分层不折叠）→ 普通消息被误判
//    → 发出 write_plan 挂起、Run 永不结束、无交付件（eval artifact_exists 失败的直接根因）。
//    修复：planSignal / reviewSignal = meta.agentId !== 'general' && toolNames.has(...)，
//    两处范式分支与脚本化工具批条件统一改用信号变量；业务角色语义零变化。
```

mock 为测试替身专用（应用运行时为真实模型唯一），增补不影响生产路径。④ 揭示的冲突模式——「白名单常驻范式工具 × 剧本启发式」——未来新增同类角色时需同样核对（防回归：`server/tests/m50-blank.test.ts` 真 Mock 剧本用例）。

E2E 剧本（mock 模式，真实引擎；`e2e/m50-blank.spec.ts`）：

1. 新建会话 → 「来源」栏「空场景」独立卡 → 「已选 1 位」→ 创建进入；
2. 空态断言：`guide` 文案（「直接说出你的需求，由通用助手独立完成」）+ 「推荐开场」+ 议程 chip 可见；
3. 发「财务数据快报」消息 → 通用助手回复（「我来独立完成」）→ **反向断言无** `平台 召集了 … 加入协作` 事件条（`toHaveCount(0)`，写法参照 `m48-routing.spec.ts` 第 33 行的正向断言）；
4. 收尾断言：`expectYourTurn(page)`（交还用户）+ `[title*="交还给用户"]` 标记；
5. 交付件：成员面板 `工作区 · 1 个文件` + `docs/交付件-财务.md` 可见；
6. 对照回归：既有 `m48-routing.spec.ts` 全绿（空编制 PRS 路径零变化）。

### 7.4 eval（新增 `evals/tasks/20-blank-scene.json`）

任务草案 `evals/tasks/20-blank-scene.json`（结构沿用 18-platform-routing；mock 模式跑，`participants: ['general']` 直接建会话，跳过建会话 UI 步骤）：

```json
{
  "id": "blank-scene",
  "name": "空场景单助手直聊：独立完成并交还用户",
  "participants": ["general"],
  "prompt": "整理一份财务数据快报：营收 120 万、成本 68 万、现金流为正。",
  "maxTurns": 4,
  "assertions": [
    { "type": "agent_spoke", "values": ["general"] },
    { "type": "no_invite" },
    { "type": "artifact_exists", "path": "docs/交付件-财务.md" },
    { "type": "no_loop" },
    { "type": "turns_lte", "value": 4 },
    { "type": "run_end_reason", "value": "completed" }
  ]
}
```

- prompt 含「财务」→ mock `detectTopic` 命中 → 断言路径 `docs/交付件-财务.md`（与 §7.3 增补的 `artifactFor` 一致）；
- **断言器扩展 `no_invite`（已实施）**（`server/src/eval/assertions.ts`）：既有 `invited_members` 为「覆盖」语义（空数组 trivially 满足），无法表达「不得召集」——新增 `no_invite`：「`routing:dispatched` 轨迹中不存在 `payload.members` 非空的条目」（同时覆盖 PRS 召集与 handoff 增援两种 source；派发 / fallback 形状不受影响）。改动五处：头部注释 + 联合类型 + label + case + `parseAssertions`（运行器与单测共用，模式同 M48 加 `invited_members`）；单测矩阵见 `server/tests/m9.test.ts`。

### 7.5 计数与文档镜像面（全量核对清单）

| # | 位置 | 变更 |
| --- | --- | --- |
| 1 | `server/tests/m21.test.ts`（25–69 行断言） | 19 场景 / 74 角色 / `'blank'` 前置 / `slice(0,4)` 顺序；文件头注释计数描述同步 |
| 2 | `agents/README.md` | ① 目录树注释「18 场景」→ 19；② 场景预载表删除 stale 行 `| harness | harness（按需 load_skill）|`（M48 已删该场景，遗留）；③ 删除 stale 字段说明 `dispatch: true`（行 48，M48 已删该字段，遗留）；④ 加入 blank 行（`| blank | general（按需 load_skill）|`）；⑤ 行 59「全部 73 角色白名单均含 handoff」→「除通用助手 `general` 外的 73 角色…（单助手纪律，ADR 0103）」 |
| 3 | `agents/CHANGELOG.md` | 新增 **v32** 条目（格式沿用 v31/v30：版本标题 + 动因 + 变更清单 + 验证） |
| 4 | `design.md` | 收录 **§60**（全文结构：背景 → 资产 → 直通路由 → 隔离纪律 → 收尾 → 前端 → 验证）+ §11 注记 97–106；ADR 索引补 0103–0106 |
| 5 | `docs/adr/` | 新增 0103–0106 四文件 + `docs/adr/README.md` 索引追加 |
| 6 | 无计数但需自查 | `e2e/m16-members.spec.ts` 等涉及场景列表的用例若断言全量场景条目需复核；`client` 侧无计数断言（已核对） |

---

## 8. 实施批次（A–D）

| 批次 | 状态 | 内容 | 验收 |
| --- | --- | --- | --- |
| **A · 资产** | ✅ 已实施 | `agents/blank/`（`_group.yaml` / `general/AGENT.md` / `_protocol.md`）+ `agents/README.md`（补行 + 清 stale）+ `check:agents` | `✓ 19 个场景 / 74 个角色` 输出；控制台可见可编辑 |
| **B · 引擎** | ✅ 已实施 | `shared` 常量 `BLANK_SCENE_ID` + `launch()` solo 分支 + 隔离过滤（roster-catalog / knownIds / resolveAgent）+ `server/tests/m50-blank.test.ts`（8 用例；批次 C 增补「真 Mock 剧本全链」后 9）+ `m21` / `m29` / `m35` 计数与例外适配 | server vitest 全绿（全量 75 文件 / 1031 用例，含本套件 9 例）+ typecheck 通过；PRS / handoff 回归绿 |
| **C · 前端与链路** | ✅ 已实施 | 组队台「来源」栏独立卡 + 列表过滤（§5.6 落点修订）+ `client/tests/m50-blank-frontend.test.tsx`（5 用例）+ mock 四处增补（剧本 / 交付件路径 / 显示名 / 范式信号适配，§7.3）+ `assertions.ts` 的 `no_invite` 扩展（+ m9 单测，§7.4）+ `e2e/m50-blank.spec.ts` + `evals/tasks/20-blank-scene.json` | client vitest 全绿（54 文件 / 621 用例，含新文件 5 例）；E2E `m50-blank` 1/1 绿；eval blank-scene 1/1 绿；m48-routing 对照回归 2/2 绿 |
| **D · 文档与门禁** | ✅ 已实施 | design.md §60 + ADR 0103–0106 + ADR 索引 + CHANGELOG v32 + 全量门禁（含 `m27-mcp` 断言按 M50 新语义适配） | 四包 typecheck 0 错误 / lint 0 errors / 双端 vitest 全绿（server 75 文件 1031 例、client 54 文件 621 例）/ build 通过 / check:agents 通过 / check:skills 通过 / eval 22/22 / E2E 全量 43 条全绿（4.2m） |

依赖顺序：A → B（B 的单测依赖资产）→ C → D；B 与 C 的资产面（mock 剧本）可并行。

---

## 9. 风险登记

| # | 风险 | 等级 | 缓解 |
| --- | --- | --- | --- |
| 1 | `order: 1` 使「通用助手 / 空场景」在 @ 列表、控制台、资产顺序中居首 | 低 | 语义上合理（最简入口）；如需后置仅调 order，但 m21 断言与本文档需同步 |
| 2 | 计数镜像面遗漏（m21 / README / CHANGELOG / ADR 索引） | 中 | §7.5 全量清单逐项勾兑；批次 D 门禁兜底 |
| 3 | e2e mock 无 general 剧本 → 台词错位（走 backend 兜底） | 低 | §7.3 增补（SCRIPTS / artifactFor / DISPLAY_NAMES / 范式信号，四处） |
| 4 | 用户把 general 手动邀入业务会话造成「角色混搭」困惑 | 低 | 允许（资产型）；隔离层保证它不会被自动拉入；文档与协议写明边界 |
| 5 | README 的 M48 遗留 stale（`dispatch` 字段说明 / `harness` 表行） | 低 | 本批次顺手清理（§7.5 #2），避免与 v32 变更混淆 |
| 6 | 「编制恰为 1」判定的边界（1 人业务会话误直通） | 低 | 判定含 `group === 'blank'` 双条件；m50 单测显式回归「`[pm]` 仍走 PRS」 |
| 7 | `handoffMode=text` 兜底下 general 正文误 @ 不在场角色 | 低 | `decideHandoff` 以 `not-in-room` 丢弃 → 波末兜底交还，无副作用（§2.2 已覆盖） |
| 8 | eval 缺「不得召集」反向断言，直通语义无法评测 | 已解 | 新增 `no_invite` 断言（§7.4），覆盖 PRS 召集与 handoff 增援 |
| 9 | `general` 的 `mcp__*` 通配使 MCP 管理台「N 个工具零可达」警示对新增服务器不再出现（工具恒被通用助手可达） | 低 | 设计有意的全能力口径（§5.1.2 附注）；`e2e/m27-mcp.spec.ts` 断言按新语义适配（反向断言 + 矩阵命中徽章仍守护授权链路）；组队台 §59.5 已预告「交由 blank 批次处理」，本批兑现 |
