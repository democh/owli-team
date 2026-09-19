# 通用调度官与意图路由专项设计（M46）

> **已收档（M48 撤销，2026-09-18）**：本专项的调度官「知舟」与 `dispatch` 机制已整体撤销，调度上收引擎（**平台路由步 PRS**，非角色回合）；下述内容仅作历史记录，现行设计见 [design.md §57](design.md) / [ADR 0101](docs/adr/0101-platform-routing-step.md)，撤销与保留对照见 §57.1。
> 状态：**已实施**（2026-09-18；批 A–D 全部落地并验收：四包 typecheck / lint / 双端测试 / build / check:agents / eval / E2E 全绿；实施期与本稿的差异以 design.md §54 与 ADR 0082–0091 为准）。
> 范围：新建会话零选择（空编制直接开聊）・通用调度官（Harness Agent）作为会话前台・无 @ 消息的意图识别与阵容召集・派发与收口全链路。
> 关联：依赖 M16 动态成员与并行波次、M24 回合范式、M28 工具渐进披露、M35 定时任务（工具运行时注入先例）、M37 场景资产 `guide/agenda` 字段；实施完成后收录 design.md 并落 ADR。
> 编号让位（规划时核对）：**M37–M45 已被「场景化对话体验专项」（docs/scene-chat-design.md，M37 实施中）占用**，本专项自 **M46** 起；ADR 自 **0082** 起预定（scene-chat 已预定至 0081，且存在 0061 双占用历史——动手前按「让位 + 双索引对齐」惯例复核）；design.md 收录章节号施工时按届时最新顺延并核对。
> **实施期核对结论**：scene-chat 枚举冻结于 0081（0062–0081 二十行，未触碰 0082+），本专项落 **ADR 0082–0091** 无冲突；design.md 最新为 §53（金融投研 M34），本专项收录为 **§54**；四处索引（ADR 文件标题行 / docs/adr/README.md / design.md §11 / 正文引用）已对齐。
> 命名占位：调度官展示名「知舟」、场景名「智能协作」为占位提案，评审可调整（资产 id 固定为 `harness`）。

---

## 1. 背景与目标

### 1.1 问题

当前会话的「前台接待」能力有三个断点：

1. **建会话必须先选成员**：`participantIds` 强制 ≥1（server/src/routes/schemas.ts），UI 也拦截 0 人提交（SessionList 三步流）——用户必须先在 84 个角色里做选择，才能开始说第一句话；
2. **无 @ 消息盲投首位成员**：引擎首发队列为 `mentioned.length > 0 ? mentioned : participantIds.slice(0, 1)`（server/src/orchestration/engine.ts「首发队列」注释处）——没有 @ 时永远投给编制链第一位，不做任何意图识别；
3. **没有跨场景的「总调度」角色**：各场景仅靠 chain 顺序接力，用户的需求如果跨场景（如「修 bug 顺便发个修复公告」），要么用户自己挑人，要么首位成员手工接力，没有统一的召集与派发入口。

同时发现一个既有缺陷：命令面板「新会话」快捷入口把**全部角色**塞进同一会话（client/src/components/layout/CommandPalette.tsx `createNewSession`），68 人全会话既无意义又拖慢上下文——本专项顺手修复。

### 1.2 目标与验收（验收导向）

| 目标 | 验收标准 |
| --- | --- |
| 零选择开聊 | 新建会话不选任何成员即可创建、可发消息；会话落库为显式成员 `[调度官]` |
| 无 @ 不再盲投 | 调度官在场的会话，无 @ 消息首波由调度官接手：意图识别 → 召集 → 派发；@ 直投语义零变化 |
| 召集闭环 | 调度官可把未在场角色召集进会话并派发；被召集成员在同一 Run 内开工；成员面板/图谱/事件条实时更新 |
| 显式与可审计 | 调度官是普通成员、普通消息；召集落 system 事件条 + WS 广播 + trace；全程可回放 |
| 零兼容差异 | 无调度官的既有会话行为与现状完全一致；消息协议、数据库模型零变更 |
| 门禁全绿 | typecheck / lint / 双端 vitest / build / check:agents / eval / E2E 全绿（含计数镜像面全量核对） |

### 1.3 定位与边界（与既有资产切割）

| 既有 | 定位 | 与本专项关系 |
| --- | --- | --- |
| handoff 工具（M16/M24） | 成员间结构化转交（≤4 目标 fan-out） | 调度官的派发通道直接复用，零新增 |
| 成员 API（M16） | 用户手动邀请 / 移出 / 换灵魂 | 召集复用同一语义内核（事件条 + 广播），不新增端点 |
| 回合范式（M24） | plan / review / execute 与角色正交 | 调度波恒为 execute；planFirst 延迟到业务首波（见 §5.6） |
| 场景对话基座（M37，实施中） | 场景空态 guide/agenda、波次分隔等视图层 | 本专项零改动直接受益（harness 场景自带空态与议程） |
| 隐藏式路由器 | **不做** | 预调度 LLM 分类不可见、不可审计、另起提示词体系，违背「一切皆回合」纪律 |
| 调度官做业务 | **不做** | 调度官不写交付件、不越权干活；边界见 §5.1 工具白名单 |

---

## 2. 现状盘点

### 2.1 关键事实（代码位置）

| 事实 | 位置 |
| --- | --- |
| 建会话 `participantIds` 强制 ≥1 | server/src/routes/schemas.ts `createSessionSchema` |
| 空成员会话启动即报错「会话没有成员」 | server/src/orchestration/engine.ts `launch` |
| 无 @ → `participantIds.slice(0, 1)` | engine.ts `launch` 首发队列 |
| 插话补位同样取首位未发言者 | engine.ts runLoop「队列已空但仍有插话」分支 |
| 命令面板快捷新建 = 全部角色 | client/src/components/layout/CommandPalette.tsx `createNewSession` |
| 工具运行时 `participants` 为回合开始快照 | engine.ts `buildToolRuntime` |
| 波末 `decideHandoff` 读实时 `session.participantIds`（活引用） | engine.ts 波末 fan-in；server/src/store/sessions.ts `setParticipants` 就地修改 |
| `forAgent(agent, mode)` 只读门控 | server/src/tools/registry.ts（plan/review 下自动收敛为只读 ∪ 范式工具） |
| 成员变更广播处理链已就绪 | client/src/stores/ws-store.ts `notify:members-changed` |
| 场景空态资产字段已就绪 | `_group.yaml` `guide/agenda`（M37）；ChatArea 按首位成员场景取用 |

### 2.2 可复用底座

- **波次编排**：队列只保留在场成员（engine.ts 循环内过滤）——召集发生在本波内、队列在波末合并时读取实时成员表，被召集者可立即进入下一波；
- **handoff 语义**：`reason` / `expected_output` 已随交接注入接收方回合指令（「上一棒期望」便条），调度官派发天然带上下文；
- **资产体系**：`agents/<场景>/<角色>/AGENT.md` + `_group.yaml` + 灵魂 + 头像 + mtime 热更新 + zod 校验 + `check:agents`，新增调度官无需改加载代码；
- **工具运行时注入先例**：`ctx.scheduleRuntime` 模式（server/src/tools/schedule.ts）——召集回调按同款注入；
- **工具渐进披露（M28）**：新工具是否进入 schema 由发现态与白名单共同决定，调度官白名单可直接持有 `invite_members`。

### 2.3 必须处理的接缝

1. **`ToolRuntime.participants` 快照问题**：若调度官在同一回合先 `invite_members` 再 `handoff`，快照里没有新成员 → handoff 误报「不在场」。改为惰性 getter（每次访问读实时成员表），handoff / plan owner 校验 / schedule target 三处同时受益；
2. **`planFirst` 与调度波的先后**：会话级「规划先行」作用于首波；若首波被调度官占用，规划会失效。规则：调度波改判 execute，「规划先行」顺延到业务首波（§5.6）；
3. **持久化不变式**：`queue ⊆ participants`、会话至少 1 名成员、handoff 目标必须在场——全部保持，不为调度引入例外分支。

---

## 3. 设计原则与全局约定

1. **显式成员模型**：调度官是普通一等成员（成员表、图谱、记忆归属、头像体系全部适用）；不引入隐式幽灵成员、不做会话外接管；
2. **可见可审计**：调度官消息是普通 Agent 消息；召集动作落 system 事件条 + `notify:members-changed` + trace `dispatch:invited`；不做静默路由换人；
3. **调度与业务分离**：调度官只做意图识别 / 召集 / 派发 / 收口；业务交付（文件、代码、文档）一律由被召集成员完成；
4. **兼容零差异**：无调度官资产的会话、无调度官在场的会话、显式 @ 消息——行为与现状完全一致；消息协议与数据库模型零变更；
5. **单一收口**：roster 变更（召集）只有两个入口——用户（成员 API）与调度官（`invite_members`）；其他成员需要增援时 `handoff` 回调度官发起；
6. **文案口径**：沿用全站精简口径；调度说明 ≤120 字；事件条沿用「…加入协作」后缀（SystemMessage 直接渲染文本，无解析依赖）；
7. **编号纪律**：动手前核对最新 ADR / design.md 章节号；遇并行工作占号按「让位 + 双索引对齐」（ADR 文件标题行、docs/adr/README.md、design.md §11 索引、正文引用四处一致）；无 Git 仓库，每批次动手前做目录快照备份。

---

## 4. 总体方案

### 4.1 核心决策摘要

| # | 决策 | 一句话 |
| --- | --- | --- |
| D1 | 调度官是一等资产 | `agents/harness/` 场景 + 单角色 `harness`，front-matter `dispatch: true` 标记（全局唯一，check 校验） |
| D2 | 空选择 = `[调度官]` | `POST /sessions` 允许空 `participantIds`，服务端填充调度官；不引入空成员会话特例 |
| D3 | 无 @ 路由调度优先 | 调度官在场 → 首波调度官；消息级显式 plan/review 与既有关系保持不变（兼容矩阵见 §5.3） |
| D4 | 召集 = `invite_members` | 仅调度官白名单可见；agentIds（≤20）或 sceneId（整链）二选一 |
| D5 | 上下文注入收口于调度官 | `<roster_catalog>`（全量目录，排除在场）+ 「开场调度」回合指令；其他角色零变化 |
| D6 | 调度波恒 execute | planFirst 顺延到业务首波；显式 @ 组合不特判 |
| D7 | 默认携带 | 所有新会话（场景 / 预设 / 快捷新建）默认预选调度官，成员步可取消；移出调度官 = 关闭智能调度 |

### 4.2 变更量级

Session / ChatMessage 数据模型 **0 变更**；数据库迁移 **0**；新 API 端点 **0**（POST /sessions 语义扩展、GET /api/agents 载荷自动扩展）；新增角色 1（资产目录）、新增内置工具 1（`invite_members`，需同步工具计数断言两处）；引擎改动集中在路由规则、装配注入与两个接缝。

### 4.3 端到端时序

```
用户：新建「智能协作」→ 发「帮我把登录页的 bug 修了」（无 @）
 │  POST /sessions { participantIds: [] } → 落库 [harness]
 ▼ launch：无 @ → queue = [harness]；首波 execute
[波1] 知舟（调度官）：
   · 读 roster_catalog → 判定「缺陷修复」→ 需要 backend + qa
   · invite_members([backend, qa], reason)
        → setParticipants + system 事件条「知舟 召集了 … 加入协作」+ WS 广播
   · handoff([backend, qa], expected_output)
        → 波末 decideHandoff（实时成员表校验通过）→ 下一波队列
   · 输出 ≤120 字调度说明（用户可见，普通 Agent 消息）
[波2..n] backend 修复 → handoff qa 回归 → …（既有波次 / 循环检测 / 审批全复用）
收尾：成员 @用户 交还；知舟不参与业务收尾
```

---

## 5. 详细设计

### 5.1 调度官资产（agents/harness/）

```
agents/harness/
├── _group.yaml          # 场景元数据
├── _protocol.md         # 调度协议（路由决策表 / 召集纪律 / 回复格式）
└── harness/
    ├── AGENT.md         # 四段骨架人设
    ├── souls/           # 可选（v1 可不配）
    └── avatar.png       # 可选（缺失回退 gradient + icon）
```

`_group.yaml` 草案：

```yaml
id: harness
name: 智能协作
description: 不选成员直接开始：调度官识别意图、召集角色、派发与收口
icon: waypoints
theme: ["#4f46e5", "#6366f1"]
objective: 把无定向的一句话需求路由到正确的角色与协作链
chain: [harness]
order: 1
guide: 直接说出你的需求
agenda:
  - label: 开发任务
    prompt: 帮我完成一个开发任务：
  - label: 头脑风暴
    prompt: 组织一次头脑风暴，议题是：
  - label: 研究报告
    prompt: 帮我做一份研究报告，主题是：
```

- `order: 1` 使该场景排在全部场景最前；`PromptLibrary.list()` 排序随之让调度官天然位于建会话落库编制的首位（`POST /sessions` 按 list() 序排序成员）；
- `guide/agenda` 直接复用 M37 资产字段：空会话空态自动呈现「直接说出你的需求」+ 议程 chips（点击预填草稿）。

`AGENT.md` front-matter 草案：

```yaml
id: harness
name: 知舟
role: 总调度
title: Dispatcher
description: 会话前台：意图识别、阵容召集、任务派发与收口，不包办业务
dispatch: true
tools: [list_dir, read_file, search_text, glob, grep, web_search, web_fetch,
        date_calc, write_todos, load_skill, remember, handoff, invite_members,
        request_approval, canvas_read]
temperature: 0.3
```

人设正文（四段骨架）要点：

- **职责**：意图识别（闲聊问答 / 单领域任务 / 跨领域复合任务 / 需澄清四分类）；阵容召集（最少必要原则）；任务派发（handoff + reason + expected_output）；收口汇总（调度说明 ≤120 字）。职责边界：不写交付件、不替成员干活、不代替用户拍板；
- **工作方式**：每条无 @ 消息四步——① 能否直接答复（能则直接答并 `handoff user` 交还）；② 需要谁（优先已在场成员；单一角色能完成只召集一人；整链任务传 `sceneId`）；③ 先 `invite_members` 再 `handoff`；④ 需求含糊时向用户追问一句，不猜；
- **交付契约**：调度说明格式 = 意图一句 + 召集名单 + 派发任务与期望产出；不落任何文件；
- **协作接口**：成员中途请求增援（`handoff` 回调度官）时二次召集；跨场景只对接各场景收敛者；与用户交互保持「确认—派发—收口」三拍。

`_protocol.md` 要点：调度四步决策表（何时不召集 / 何时追问 / 何时直接答复）、召集上限（单次 ≤20、优先 ≤4）、禁止事项（不越权、不空转、不重复召集已在场者）。

**校验与镜像面**（批次 A 一并做）：

- `AgentFrontMatterSchema` 增 `dispatch: z.boolean().optional()`（server/src/store/prompts.ts）；
- `PromptLibrary.validate()` 增：`dispatch: true` 全库至多一个（>1 报错，与 id 重复同级）；
- `check:agents` 输出调度官标记行；`AgentDefinition`（shared/src/types.ts）增 `dispatch?: boolean`，`GET /api/agents` 载荷自动携带；
- 资产控制台（M26）round-trip 校验：编辑保存后 `dispatch` 字段不丢失（编辑其他字段时透传保留）；
- 计数镜像面全量核对：server/client 测试中的「场景 × 角色」计数断言、`e2e` 断言、`agents/README.md` 清单、评测基线；`agents/CHANGELOG.md` 登记（附 eval 结果）。

### 5.2 会话创建与成员模型

**服务端**：

- `createSessionSchema.participantIds` 放宽为允许空数组（缺省 `[]`）；
- `POST /sessions`：`ids.length === 0` 时 → 调度官在场资产存在则填充 `[调度官]`；不存在则 400「未选择成员且调度官资产缺失（agents/ 需有且仅有一个 dispatch: true 角色）」；
- 其余语义（已知角色校验 / 链序排序 / 灵魂校验 / 项目关联）不变；调度官按 `list()` 排序天然居首。

**客户端（建会话三步流）**：

- 第 0 步置顶新增卡片「**智能协作 · 不选成员直接开始**」→ 预选 `[调度官]` 进入第 1 步（可继续增员）；
- 场景 / 预设流程 `pickScene/pickPreset` 默认预选 `[调度官, ...chain|members]`（成员步可取消勾选；取消后按用户选择提交，不回加）；
- 第 1 步 0 人时提交按钮可用，文案「交给调度官 · 0 位成员」→ 发送 `participantIds: []`（由服务端填充，按钮文案即显式同意）；
- CommandPalette `createNewSession`：全部角色 → `[调度官]`（修复既有缺陷）；无调度官资产时回退旧逻辑并 toast。

**成员模型边界**：会话至少保留 1 名成员（移出唯一调度官被既有守卫拒绝）；移出调度官 = 该会话关闭智能调度（无 @ 回退首位成员）；fork 复制成员表原样（含调度官）。

### 5.3 消息路由

**launch 路由规则**（替换 engine.ts 首发队列三行）：

```ts
const dispatcherId = session.participantIds.find((id) => prompts.get(id)?.dispatch)
if (mentioned.length > 0)                     queue = mentioned                         // ① @ 直达（零变化）
else if (opts.mode === 'plan' || opts.mode === 'review')
                                              queue = session.participantIds.slice(0, 1) // ② 消息级显式范式不走调度官
else if (dispatcherId)                        queue = [dispatcherId]                    // ③ 调度官接手（新）
else                                          queue = session.participantIds.slice(0, 1) // ④ 兼容兜底（零变化）
```

规则 ② 的理由：消息级显式 plan/review 是「对具体工作的指令」，规划 / 评审目标通常已明确，直接投场景首棒更直接；会话级 `planFirst` 仍走调度官（顺延规则见 §5.6）。

**插话补位**（runLoop「队列已空但仍有插话」分支）：`mentioned → 调度官 → 首位未发言者 → 首位成员`，与 launch 同一优先级。

**兼容矩阵**：

| 会话形态 | 消息 | 行为 |
| --- | --- | --- |
| 含调度官 | 有 @ | 直达被 @ 成员（零变化） |
| 含调度官 | 无 @、execute | **调度官接手**（新） |
| 含调度官 | 无 @、消息级 plan/review | 首位成员（兼容） |
| 含调度官 | 无 @、会话 planFirst | 调度官接手；规划顺延业务首波（§5.6） |
| 无调度官（含全部旧会话） | 任意 | 与现状完全一致 |

### 5.4 召集能力：invite_members（新工具）

新建 `server/src/tools/roster.ts`（仿 schedule.ts 的 `ctx.scheduleRuntime` 注入先例），注册进 `createToolRegistry`：

```ts
{
  name: 'invite_members',
  description: '召集不在场角色加入本会话（调度官专用）。agentIds（≤20）或 sceneId（整链召集场景默认编制）二选一或并用；召集后请立即 handoff 派发任务。',
  parameters: {
    agentIds?: string[]   // 角色 id（以 roster_catalog 为准）
    sceneId?: string      // 场景 id：召集该场景 chain 默认编制
    reason?: string       // 一句话理由（写入事件条与 trace）
  }
}
```

执行语义：

1. **校验**：未知 id → `ok:false` + 回灌候选提示（相近 id +「请查阅 roster_catalog」）；`sceneId` 不存在 → 列出全部场景 id；已在本会话 → 幂等（`already` 列表）；单次解析后 ≤20（对齐成员 API 上限）；
2. **落库与广播**：`setParticipants` 去重追加 → system 事件条「**{调度官名} 召集了 {名单} 加入协作**（{reason}）」→ `notify:members-changed`（payload `{session, message}`，客户端 ws-store 既有处理链直接生效）→ trace `dispatch:invited` `{agentIds, sceneId?, reason}`；
3. **回灌**：detail 附**刷新后的在场名单**（id + 名），引导模型直接进入 handoff；
4. **共享内核**：与成员 API（POST /sessions/:id/members）抽出同一 `inviteMembersCore`（成员校验 / 排序 / 事件条 / 广播），路由与工具双入口防语义漂移（措辞区分：用户「邀请了」/ 调度官「召集了」）。

**两处引擎接缝**：

- `ToolRuntime.participants` 由快照改**惰性 getter**（engine.ts `buildToolRuntime`）：每次访问读实时成员表——保证「同一回合先召集、后 handoff」成立；handoff / plan owner 校验 / schedule target 同时受益；
- 波末 `decideHandoff` 已读实时成员表（活引用），被召集成员可被同一 Run 下一波正常接手——**零改动**。

**护栏**：新增常量 `DISPATCH_MAX_INVITES_PER_RUN = 32`（可选）、`DISPATCH_MAX_TURNS_PER_RUN = 3`（同一 Run 调度官接手 ≤3 次，超出走常规 fallback）；其余复用既有循环检测（波签名 + 内容相似）与回合上限。

### 5.5 装配注入：roster_catalog 与调度回合指令

**roster_catalog**（仅 `agent.dispatch === true` 的回合注入；assembler 增可选 block，仿 M28 `toolDiscoveryBlock` 先例）：

```
<roster_catalog>
你可召集下列未在场角色（已在场：知舟(harness)）。按场景分组；sceneId 可整链召集。
## 研发团队 development（objective：…；编制：pm → architect → …）
- pm 费利 · 产品经理：需求澄清与可验收需求文档
- architect 艾达 · 架构师：技术方案与架构决策记录
…
</roster_catalog>
```

- 由 `PromptLibrary` 派生：场景行（id / name / objective / chain 编制链）+ 角色行（id / name / role / description 截断）；**只列未在场**；随资产 mtime 热更新，按（资产签名 + 在场集合）缓存；
- 预估 2–4k token，仅调度官回合承担，不扩大其他角色上下文。

**调度回合指令**（`buildTurnInstruction` 新增 dispatch 分支；仅当本回合为调度官且非 review/plan）：

```
【开场调度】本回合你是调度官：
1. 判断意图与所需专业角色；闲聊/元问题/简单问答可直接答复并交还用户；
2. 需要协作：先 invite_members 召集（缺席且必要，≤4 位优先；整链任务传 sceneId），
   再 handoff 派发（每位目标附 reason 与 expected_output）；
3. 不产出业务交付件、不越权替成员干活；调度说明 ≤120 字。
```

### 5.6 范式与波次交互

- **调度波恒为 execute**：调度是编排原语，不吃 plan/review 语义（`invite_members` 非只读，范式只读门控下自动不可见，不会越权）；
- **`planFirst` 顺延**：`turnModeOf`（engine.ts）加一条——`waveIndex === 0` 且成员全为调度官且 `record.mode === 'plan'` → 本波返回 execute 并置 pending 标记；`waveIndex === 1` 消费标记返回 plan。避免「调度官开场导致规划先行永久失效」；`notePlanProtocolViolation` 不受影响（plan 波才检查）；
- **召集 ≠ 同时并行**：并行上限仍由 `PARALLEL_MAX` / 场景 `parallelMax` 控制，超编成员留队列分批（既有语义）；
- **显式 @ 组合不特判**：用户 `@调度官` 或混 @ 时按既有波规划执行（尊重用户显式意图）。

### 5.7 前端改动

| 位置 | 改动 |
| --- | --- |
| 建会话三步流（SessionList） | 置顶「智能协作」卡；场景/预设默认预选调度官；0 人提交（「交给调度官」按钮）；`submitCreate` 不再拦截 0 人 |
| CommandPalette | 快捷新建 → `[调度官]`（修复全部角色缺陷） |
| 徽标 | AgentPicker / TeamPanel / 消息头：`dispatch` 角色加「调度」小徽标（数据来自 `/api/agents`） |
| 空态引导 | 零改动获益：ChatArea 已有 `guide/agenda` 取用链（M37），harness 场景自然呈现 |
| 类型 | `AgentDefinition.dispatch?: boolean`（shared 包） |
| 实时性 | 召集 → `notify:members-changed` → ws-store 既有链路更新成员面板/事件条；无需新订阅 |

### 5.8 边界、降级与护栏

| 场景 | 行为 |
| --- | --- |
| 调度官资产缺失/被删 | 空成员创建 400（明确提示）；无调度官会话行为零变化 |
| 召集未知角色 | 工具错误回灌 + 候选提示，模型自我修正；不中断 Run |
| 调度官忘召集就 handoff | handoff 报「不在场」+ 辅导语（先 invite_members 再派发） |
| 调度官空转（只说话不派发） | 引擎既有 fallback：队列空 → 首位未发言成员兜底 |
| 循环（成员 ↔ 调度官反复） | 既有循环检测 + `DISPATCH_MAX_TURNS_PER_RUN` 护栏（超出走常规 fallback） |
| 调度官遭遇成本敏感 | 移出调度官即彻底回退（与会话删除调度开关等价） |
| 运行中用户手动加人/移人 | 成员 API 全兼容（移出在队列中成员 → 既有 removeFromQueue 广播） |
| plan/review 范式回合 | 范式只读门控自动隐藏 `invite_members`，调度官作为普通成员受范式约束 |

---

## 6. ADR 决策项（0082–0091，已落盘）

| 预定 | 决策 | 选择 | 备选（拒绝理由） | 边界 |
| --- | --- | --- | --- | --- |
| 0082 | 调度官为显式一等成员 | 资产角色 + 进入会话成员表，全部不变量原样成立 | 隐藏路由器 / 幽灵成员（不可见、不可审计、破坏 `queue ⊆ participants`） | 不做会话外接管 |
| 0083 | `dispatch` 资产标记 | front-matter `dispatch: true`，全局唯一，check 校验 | 硬编码 id / 场景级标记（不够精确） | 控制台 round-trip 保留 |
| 0084 | 空选择创建语义 | `POST /sessions` 接受 `[]` → 填充 `[调度官]`；资产缺失 400 | 客户端自行填充（双份逻辑）/ 允许真空会话（破不变量） | 会话至少 1 成员约束不变 |
| 0085 | 无 @ 路由调度优先 | 无 @ 且非消息级显式 plan/review → 调度官；其余旧行为 | 所有无 @ 都先调度官（显式范式语义冲突） | @ 直达零变化 |
| 0086 | 召集单一收口 | `invite_members` 仅调度官白名单可见；成员需增援走 handoff 回调度官 | 全体成员可召集（权限扩散）/ 新开召集 API | 复用成员 API 语义内核 |
| 0087 | roster_catalog 注入 | 仅调度官回合注入全量目录（排除在场），热更新 + 缓存 | 提供 `list_agents` 检索工具（多一轮工具回合）/ 全角色注入（上下文膨胀） | 2–4k token 预算 |
| 0088 | 调度波恒 execute | planFirst 顺延业务首波；调度不吃范式 | 调度官参与 plan 波（invite 与只读冲突） | 消息级显式范式不走调度官 |
| 0089 | 工具运行时惰性 participants | 快照改 getter，支持同回合「先召集后交接」 | 要求模型跨回合完成（脆弱） | handoff / plan / schedule 三处受益 |
| 0090 | 调度接手护栏 | 同一 Run 调度官接手 ≤3 次 + 既有循环检测 | 无护栏（极端下反复调度） | 超出走常规 fallback |
| 0091 | 事件与广播复用 | 「召集了…加入协作」system 条 + `notify:members-changed` + trace | 新 SSE 事件类型（双通道分叉） | 前端零改动即时生效 |

---

## 7. 测试与评测

| 面 | 内容 |
| --- | --- |
| server 单测 | 路由四分支（@ / 显式范式 / 调度官 / 兜底）；空成员创建自动填充与资产缺失 400；`invite_members` 矩阵（成功 / 幂等 / 未知 id 候选提示 / sceneId 整链 / 上限 / 事件条 / 广播 / trace）；惰性 participants「同回合召集→handoff」；roster_catalog 只列未在场 + 热更新 + 缓存；planFirst 顺延；接手次数护栏；`check:agents` dispatch 唯一性；控制台 round-trip 保留 |
| client 单测 | 三步流零选择创建 / 默认预选与取消 / 「交给调度官」文案；CommandPalette 修复；调度徽标 |
| e2e | 新增 `m46-harness.spec.ts`：建会话（零选择）→ 无 @ 消息 → 调度官消息出现 → 成员面板增长 → 被召集成员开工；`e2e/helpers.ts` 同步（默认预选调度官、AGENT_NAME 镜像） |
| eval | 新增 golden 任务（空会话 → 委托研发任务 → 断言：调度官发言 / 成员被召集 / 任务被派发）+ `MockProvider` 增补 harness 剧本（确定性、不吃真实模型）；baseline 更新并复核 |
| 计数镜像面（重点） | 新增工具同步 `tools.test.ts` / `m28-engine-search.test.ts` 两处计数断言；新增角色/场景核对 server/client 测试中的场景 × 角色计数、e2e 断言、`agents/README.md`、评测基线 |

---

## 8. 实施批次（A → D）

| 批次 | 主题 | 交付 | 验收 |
| --- | --- | --- | --- |
| A | 资产基座 | `agents/harness/` 全套资产；`dispatch` 字段与 schema / validate / list 投影；check:agents；控制台 round-trip；计数镜像面 + CHANGELOG | check:agents / 双端测试 / 计数断言全绿 |
| B | 引擎路由 | `createSessionSchema` 放宽 + POST 填充；launch / inject 路由规则；planFirst 顺延；接手护栏 | 路由矩阵单测全绿；无调度官路径零回归 |
| C | 召集闭环 | `invite_members` + `inviteMembersCore` + 惰性 participants；roster_catalog + 调度回合指令；MockProvider 剧本 + 新 golden 任务 | 工具矩阵 / 装配块 / 同回合闭环单测；eval 基线复核 |
| D | 体验与门禁 | 前端三步流 / CommandPalette / 徽标 / 类型；e2e 新 spec + helpers；文档收录（design.md 章节 + ADR 落盘 + docs/adr/README 索引 + 本文件状态更新） | 全量门禁：typecheck / lint / 双端 vitest / build / check:agents / eval / E2E |

每批次开工前：目录快照备份（无 Git）→ 核对最新 ADR / 章节号（让位）→ 基线门禁先跑一遍。改动协议或资产时附 eval 结果并登记 `agents/CHANGELOG.md`。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| LLM 路由误判（召集错角色） | 体验 | 协议契约（四分类 + 最少必要）+ golden 评测 + 用户可 @ 纠正 + trace 可查 |
| 每条无 @ 消息 +1 次调度回合 | 延迟 / 成本 | 可移出调度官；调度说明限长；roster 目录缓存；观测端到端耗时 |
| 计数镜像面遗漏（资产扩张历史高频） | 测试红 / 门禁 | 批次 A 检查清单逐项核对；门禁全量 |
| 与 M37 并行专项冲突 | 编号 / 文件 | 让位策略；重叠面小（ChatArea 已用 agenda 字段，直接受益） |
| 控制台编辑丢 `dispatch` 字段 | 资产损坏 | 批次 A round-trip 单测（编辑保存后字段保留） |
| planFirst 组合失效 | 语义回退 | 顺延规则 + 专项单测 |
