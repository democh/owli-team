# ADR 0101：调度平台化——撤销调度官角色，调度上收引擎（M48）

- 状态：Accepted
- 引入：M48
- 相关：[design.md §57](../design.md)、[docs/harness-dispatch-design.md](../harness-dispatch-design.md)（已随本次撤销收档）、[server/src/orchestration/platform-router.ts](../../server/src/orchestration/platform-router.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[server/src/orchestration/roster-catalog.ts](../../server/src/orchestration/roster-catalog.ts)、[server/src/tools/roster.ts](../../server/src/tools/roster.ts)、[agents/README.md](../../agents/README.md)、ADR 82–91（M46 调度官系列，本 ADR 撤销其中 82/83/85/86/88/90 六条决策与 84 的服务端填充、95 的收口波）、ADR 87（roster_catalog，本 ADR 复用）、ADR 89（惰性 participants，本 ADR 复用）、ADR 91（事件与广播复用，trace 更名）

## 背景

- M46 为「零选择直接开聊」引入「智能协作」场景与调度官「知舟」：置顶场景 + `dispatch: true` 资产标记 + 无 @ 消息路由 + `invite_members` 召集 + 空编制创建填充 `[调度官]`。上线后追加三轮补丁（M46-2 的派发优先 / 收口波 / 串行执行），机制复杂度持续累积；
- **用户反馈（本里程碑动因）**：调度官「引入了一个新角色，感觉怪怪的」——用户的心智模型是「**所有 agent 都应是单一业务 harness agent**」（消费同一套 AGENT.md 工件、可被 @、有业务职责）。调度官把「平台的调度机制」人格化成了一个资产角色，用户需要额外理解一套平台机制；
- **机理问题**：① 特例税——`dispatch` 字段贯穿资产 schema / check 校验 / 控制台 round-trip / 前端徽标与预选；② 机制噪音——调度官回合占用波次与消息流，催生接手护栏（≤3 次）、调度波恒 execute、收口汇总波等补丁；③ 自由度——空编制创建被强制填充调度官，用户无法「零选择」开场；④ 归属混乱——意图识别与阵容召集是**平台能力**，不是某个角色的职责。

## 决策

1. **撤销调度官资产**：删除 `agents/harness/` 场景（含「知舟」人设）；`dispatch` front-matter 字段从资产模式（`AgentDefinition`）、`check:agents` 校验、控制台编辑 round-trip、前端 `DispatchBadge` / 徽标 / 预选逻辑全链移除；计数 19→18 场景、74→73 角色；
2. **调度上收引擎 = 平台路由步（新模块 `server/src/orchestration/platform-router.ts`）**：未 @ 消息 / 空编制开场由引擎执行一次结构化 LLM 调用（`responseFormat: json_schema 'platform_route'`，`summaryModel`，temperature 0），**非角色回合**——不产生消息、不占波次、不参与交接队列、不受接手护栏约束；
3. **PRS 契约**：输入 = 用户需求（`<request>`）+ 最近上下文（`<context>`，最近 4 条截 160 字 / 总 800）+ 未在场角色目录（`buildRosterCatalogBlock`，ADR 87 复用）+ 在场名单；输出 `{ members[], assignments[{agentId, task}], reason }`——`members` 为需召集的未在场角色；`assignments` 有序 1–4 位（首位最先开工、≥2 位触发并行波）；`task` ≤120 字折叠截断；`coerceRoutePlan` 容错：未知 / 已在场 / `'user'` 一律丢弃、去重、`assignments` 空 = 路由失败；调用用量 `kind='turn'`（`agentId='__router__'` 哨兵，与角色 id 空间隔离，mock 据此分派剧本）；
4. **启动三分支（`launch()`）**：① @ 直达（零变化）② 消息级显式 plan / review 且编制非空 → 编制首位（目标已明确，直接投场景首棒）③ 未 @ 或空编制 → `routingPending` → `runLoop` 开头消费 PRS 后进入波次循环；
5. **应用语义（引擎侧）**：先召集后派发——召集走 `inviteMembersCore`（verb「召集了」/ actor「平台」，落库 + 事件条 + 广播，与成员 API 语义一致）→ 派发为任务便条注入（`handoffNotes` from「平台」+ `expectedOutput`，接手者回合显示「上一棒期望」）+ 队列填充；
6. **降级路径（绝不阻断主链路）**：PRS 调用 / 解析失败 → 有编制则在场首位接手（task「按你的职责推进该需求」，trace `{fallback:true, error}`）；空编制无兜底 → 系统事件条「平台未能为该需求匹配到合适的成员，请手动邀请后重发」并收尾（绝不静默）；召集后以 `presentNow` 复核派发目标；
7. **handoff 增援自动化**：成员转交的目标不在场但资产存在 → 平台自动召集（`source='handoff'`，reason「X 转交时自动召集」）——「成员增援无需手动邀请」，与 PRS 召集共用同一内核；
8. **审计可见性**：trace `routing:dispatched` 三形状——`{source: 'route'|'handoff', members, reason}`（召集）/ `{assignments, reason}`（派发）/ `{fallback: true, error}`（降级）；前端 TraceDrawer 依形状渲染「平台召集 / 平台派发 / 平台路由降级」；
9. **接口与工具面**：空编制创建语义（`POST /sessions` 接受 `participantIds: []`，不再填充调度官）；`invite_members` 工具移除（56→55 工具）——召集单一入口收敛为「平台」（PRS / handoff 增援 / 成员 API 三路共用 `inviteMembersCore`）；
10. **前端体验**：删 `DispatchBadge`；空编制建会话（0 人提交 = 「空编制创建 · 交给平台组队」，提示「未选成员：首条消息将由平台自动组队并派发任务」）；空态引导「直接描述你的需求，平台将自动组队并派发任务」。

## 理由

- **心智模型一致性（用户原则）**：所有 agent 回归单一业务角色——资产层再无「平台机制角色」；用户只需理解「@ 谁 / 不 @ 交给平台」两条规则；
- **特例税清零**：`dispatch` 字段的资产 schema、校验、控制台 round-trip、前端徽标四条特殊路径全部删除，新角色不再需要理解调度字段；
- **机制回归引擎**：意图路由与阵容召集是平台能力——PRS 无回合、无波次、无消息，M46-2 的接手护栏 / 恒 execute / 收口波补丁自然消亡（不撤销而消解）；每 Run 仅一次调用，token 成本可控；
- **复用而非重写**：`inviteMembersCore`（召集内核）、`buildRosterCatalogBlock`（目录注入，ADR 87）、惰性 participants（同回合召集→派发，ADR 89）、事件与广播复用（ADR 91）四件套零重写；`coerceRoutePlan` 纯函数可单测，失败语义稳定（`ok:false` 永不抛错）；
- **零选择自由度**：空编制创建合法化——用户可以从零开始，平台按首条需求组队；有明确目标时仍可 @ 直达或显式范式（零变化）。

## 被否决的方案

- **保留调度官但改名 / 换人设**（如「协调员」）：机制仍是资产角色，特例税与机制噪音照旧——问题不在名字而在「机制人格化」本身；
- **关键词 / 场景映射式硬编码路由**：不满足「任意需求任意场景」的开放域（「帮我做登录」跨产品、架构、测试三角色）；引擎既有结构化调用能力（`summaryModel` + json_schema + `extractJson` + `resilientStream`）已足；
- **把 PRS 做成「隐藏 agent 回合」**（有 message 不显示 / 有 wave 不计数）：占用波次、消息、交接语义，护栏与收口波补丁必然回归——「非角色回合」是本质要求；
- **空编制开场直接取全量资产首位**：无场景上下文时「首位」不可知（资产顺序非需求序），纯兜底会让「帮我做登录」落到无关角色；
- **`invite_members` 保留给普通成员**：召集权限收敛到平台三路（PRS / handoff 增援 / 成员 API），成员保留「拉人」能力会让调度面重新碎片化；
- **PRS 结果写回用户可见的「调度消息」**：违背「不产生消息」契约，且会把平台机制再次暴露给用户（审计需求已由 trace 三形状 + 事件条满足）。

## 适用与失效条件

- 适用：全部会话的未 @ 消息与空编制开场（含跨场景召集）；@ 直达、消息级 plan / review、会话级「规划先行」语义零变化；
- 失效条件：PRS 依赖 provider 的结构化输出能力（mock 以 `agentId='__router__'` 哨兵分派 `routeScript`）；新增「平台级决策」时应扩展 PRS 的输入/输出与 trace 形状，**不得**新建「平台角色」资产；
- 测试镜像面：`server/tests/m48-routing.test.ts`（PRS 契约与降级）+ `server/tests/m48-roster.test.ts`（空编制 / 增援语义）；mock `routeScript`（空编制 → 召集 pm/architect/qa + 首棒 pm）与 `pickNext` 接力（preferred 在场未发言 → 成员顺序 → 交还用户）；client `m48-frontend`（空编制建会话流）+ `m9`（trace 三形状）；e2e `m48-routing.spec.ts`（真实引擎 + mock：零选择开场全链）；eval `18-platform-routing`（`participants: []` 三回合）。
