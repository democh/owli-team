# ADR 0103：空场景与通用助手资产（M50）

- 状态：Accepted
- 引入：M50
- 相关：[design.md §60](../design.md)、[docs/blank-scene-design.md](../blank-scene-design.md)、[agents/blank/_group.yaml](../../agents/blank/_group.yaml)、[agents/blank/general/AGENT.md](../../agents/blank/general/AGENT.md)、ADR 0028（Agent 包化与场景分组）、ADR 0054（M28 工具按需发现）、ADR 0102（组队台，空场景入口承载）

## 背景

- 用户需求（本里程碑动因）：「空场景指的是不引入任何角色 agent，只使用一个通用的 harness agent 对话，单 agent 模式」——现有全部场景均为业务角色编制，用户处理轻量 / 通用任务时被迫先组队；
- 语义区分：M48 的「空编制创建」（ADR 0101）的既定语义是「交给平台自动组队并派发」，与「无角色直聊」恰相冲突——两入口不能复用（文案互斥、行为相反）；
- 工具面约束：用户明确「不是加载所有的 tool，只保留核心，其他使用 tool_search 实现」——恰好由 M28 分层体系天然满足（白名单 = 授权全集；运行时 core 常驻 20 项 + deferred 34 项经 `tool_search` 按需激活），零新增机制。

## 决策

1. **资产形态**：新增 `blank` 场景（`_group.yaml`：`order: 1` 居首、`chain: [general]`、guide / agenda 场景化）与 `general` 角色（`agents/blank/general/AGENT.md`）——通用助手无业务人设、无 souls（经典模式）、无 `handoff`（不参与接力，单助手纪律）、temperature 与正文按通用任务编写；
2. **白名单**：`general.tools` 覆盖注册清单差集仅 `handoff`（`fin_*` / `mcp__*` 通配参与匹配）——即除「接力」外的全部能力授权，运行时由 M28 分层常驻 / 延迟；
3. **场景协议**：`agents/blank/_protocol.md` 单助手规则（`<scene_protocol scene="blank">`）——独立完成、按需用工具、结论与依据分开、不召集成员；
4. **计数与镜像面**：19 场景 / 74 角色（后由 M51-A 扩至 21 / 81）；`agents/README.md` 补 blank 行并注明「全部业务角色白名单均含 handoff，`general` 除外」；mock 测试替身四方补齐（`SCRIPTS.general` / `artifactFor` → `docs/交付件-<主题>.md` / `DISPLAY_NAMES` → 通用助手 / `preferredOf` 无条目）；
5. **mock 脚本适配（实施中发现）**：mock 原以「工具清单含 `write_plan` / `submit_review`」判定 M24 规划 / 评审范式——`general` 白名单常驻这两者（core 分层不折叠），普通消息被误判为计划提交而挂起（Run 不结束、无交付件）；修复为范式信号仅对业务角色成立（`meta.agentId !== 'general'`），防回归用例见 `server/tests/m50-blank.test.ts`「真 Mock 剧本 × general solo」。

## 理由

- **资产型零机制**：空场景是「一个场景 + 一个角色」的数据，不引入 `solo` / `standalone` 等资产特例字段（M48 撤销 `dispatch` 字段的直接教训——机制不应人格化 / 特例化为资产字段）；
- **复用 M28 分层而非另设工具集**：白名单全覆盖 + 运行时按需激活，与全部既有角色同一套工具基础设施，零新增代码路径；
- **单助手纪律显式化**：无 `handoff` 是「不接力」的自然表达（工具即纪律），无需引擎特判；场景协议补足行为约束；
- **通用助手可被手动邀请**：资产型意味着它同样出现在控制台 / @ 列表 / 成员邀请中——这是特性（用户想用时可得），隔离层（ADR 0105）保证它不会被**自动**拉入。

## 被否决的方案

- **复用「空编制创建」代替空场景**：语义冲突——空编制的定义是「交给平台组队」，正是单助手模式要规避的行为；两入口并存、文案互斥（blank-scene-design.md §4.2 区分表）；
- **复用 ops/assistant「沐晨」充当通用助手**：业务人设（行政助理）+ `handoff` + 业务技能预载，与「无角色」定位冲突；且会破坏该角色既有会话行为；
- **新增资产字段（`solo: true` / `standalone: true`）**：机制不应特例化为资产字段（同 M48 教训）；编制判定零字段、零迁移；
- **为空场景单独维护一套「精简工具白名单」**：与 M28 分层重复建设；白名单全集 + 运行时分层已达成「核心常驻、其余 `tool_search`」的用户要求；
- **让 `general` 参与接力（保留 handoff）**：单助手语义即「独立完成」，接力会把业务角色拉入单 Agent 模式，破坏直通路由（ADR 0104）的判定前提。

## 适用与失效条件

- 适用：`blank` 场景的全部会话；`general` 可在任意会话中被手动邀请（与普通成员同权，隔离纪律见 ADR 0105）；
- 失效条件：`blank` 资产被删除（违规操作）时——直通判定 `get()?.group` 为 undefined → 不进直通分支，走 PRS 兜底；`check:agents` 在交付前拦截「场景无成员」错误；白名单条目被控制台编辑为含 `handoff` 时，单助手纪律失效（重跑 `m50-blank` 资产断言可发现）；
- 未来新增「白名单常驻范式工具」的角色时，需同步核对 mock 范式信号（见决策 5；该冲突模式已记录于 blank-scene-design.md §7.3）。
