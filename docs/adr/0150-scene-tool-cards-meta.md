# ADR 0150：场景工具卡变体与工具记录 meta 扩增（BI-1 / SR-2）

- 状态：Accepted
- 引入：M39 生产型渲染包（2026-09-19）
- 相关：[design.md §97](../design.md)、[docs/scene-chat-design.md §7](../scene-chat-design.md)（M39 原案；决策项 0070「toolCall 派生场景卡与 ToolCard 关系」落位）、ADR 0129（LiveDock 实时通道——「同源不重复」边界）、[client/src/components/chat/ToolCard.tsx](../../client/src/components/chat/ToolCard.tsx)、[client/src/components/chat/DbPipelineCard.tsx](../../client/src/components/chat/DbPipelineCard.tsx)、[client/src/components/chat/SshEvidenceCard.tsx](../../client/src/components/chat/SshEvidenceCard.tsx)、[server/src/tools/db.ts](../../server/src/tools/db.ts)、[server/src/tools/ssh.ts](../../server/src/tools/ssh.ts)

## 背景

- M39 原案定义两张场景工具卡：BI-1 取数管道卡（问题 → SQL 可展开 → 结果预览 ≤5 行 → 校验徽章）与 SR-2 证据卡（等宽命令块 + 输出折叠 + 审批联动），来源均为 toolCall——但**现有 `ToolCallRecord` 只持久化 `summary`（单行）**：db_query 的 summary 仅「查询完成：N 行（ms）」、ssh_exec 仅「命令完成：exit 0（ms）」，行数据与命令输出落在 `ToolResult.detail`（仅回灌模型，不随记录持久化）——两张卡的预览与证据**无数据可渲染**；
- 原案决策项 0070：场景卡是 ToolCard 的**变体布局**（数据同源、不重复消费事件）；非场景角色保持原样——待落位；
- 「与 LiveDock 同源不重复」（原案边界）：LiveDock 操作流经 `opNotify` 独立通道（实时事件，不持久化）；消息内卡片必须走 ToolCallRecord（持久、可回放）——两者数据形状可对齐但通道不同。

## 决策

1. **ToolCard 场景路由（客户端）**：`ToolCard` 顶层按场景分派——`bi × db_query / db_schema` → 取数管道卡；`sre × ssh_exec` → 证据卡；其余场景 / 工具走 `GenericToolCard`（现有实现原样保留）；无 SceneContext（独立渲染 / 测试）→ 通用卡（安全降级）。
2. **工具记录 meta 扩增（服务端，`ToolResult.meta` 既有通道）**——随 `ToolCallRecord` 持久化（engine `entry.meta = result.meta`）：
   - `db_query` 成功：`{ columns, rows: ≤5 行（单元格文本化、单值 ≤160 字符）, rowCount, durationMs }`——行对象按列名取键，非字符串值 `String()` / 对象 `JSON.stringify` 后截断；
   - `ssh_exec` 成功：`{ command: ≤500 字符, exitCode, durationMs, output: stdout+stderr 合并 ≤2000 字符, truncated }`（输出过长追加 `…` 并置 truncated，与结果 DTO 的截断标记取或）。
3. **体积有界与降级链**：meta 单条上限约 20KB 量级（5 行 × 160 字符 / 2000 字符输出）；历史消息（meta 缺省）→ 卡片降级为 summary 行（不空白、不编造）；错误 / 拒绝路径无 meta → 命令块取 `args.command`、摘要行取 `summary`。
4. **不另起数据管道**：两张卡不消费 op 事件、不二次查询；LiveDock 保持实时通道独立（同源 = 同一工具执行的两个投影面；不重复 = 不把实时事件再渲染进消息卡）。

## 理由

- **meta 是最小侵入的持久化通道**：ToolResult.meta 自 M31（canvasNodes）即有「结构化元信息随记录持久化」语义，复用不新增管线 / 不新增 API；`meta` 为 `Record<string, unknown>` 开放形状，新增键向后兼容（历史记录无键 → 解析器返回 undefined → 降级）；
- **预览 ≤5 行 + 输出 ≤2000 字符**：与 LiveDock 预览行数对齐；消息记录进 SQLite + SSE 广播 + 前端缓存三处流通，体积必须硬约束；
- **路由在客户端**：服务端只管「记什么」，前端管「怎么显示」——同一工具在不同场景呈现不同（bi 的 db_query 是管道、development 的 db_query 是通用工具），场景归属只有前端侧知道（scene group）。

## 被否决的方案

- **客户端二次取数（调 API 再查一次）**：另起数据管道、权限 / 连接时点漂移、与「持久可回放」冲突；
- **把 detail 全量持久化进 ToolCallRecord**：db 结果 30 行 + ssh 全量输出 → 消息记录膨胀（SSE / SQLite / 缓存三处放大）；
- **服务端专用预览 API（按 callId 取）**：为两张卡新增端点与生命周期（记录 GC / 权限）不成比例；
- **替换 GenericToolCard（全场景换卡）**：改变既有行为面（M39 原案已否决「替换 ToolCard」）；
- **meta 键直接塞进 summary 文本再解析**：污染模型回灌面（summary 会进上下文），且格式脆弱。

## 边界与失效条件

- E2E 无真实 DB / SSH 连接，两张卡的**有数据路径由组件测覆盖**（chartboard 先例：「无 E2E 有数据路径由单测覆盖」）；E2E 仅覆盖其所在场景的消息流不回归；
- meta 键名即渲染契约：`columns/rows/rowCount/durationMs`（db）与 `command/exitCode/durationMs/output/truncated`（ssh）——变更须同步两张卡的解析器与组件测；
- 审批路径（拒绝 / 超时）不产生 meta：证据卡以 summary 关键词映射「审批拒绝」徽章（拒绝文案为服务端固定串）；若文案变更须同步该映射。
