# ADR 0151：工序卡 · 验收单 · 复盘容器（DEV-2 / DEV-3 / SR-3）

- 状态：Accepted
- 引入：M39 生产型渲染包（2026-09-19）
- 相关：[design.md §97](../design.md)、[docs/scene-chat-design.md §7](../scene-chat-design.md)（M39 原案）、ADR 0123（交付清单分层默认）、ADR 0079（聊天流只做摘要与跳转——预览深度边界）、ADR 0149（阶段映射表——stageOf 复用）、[client/src/lib/acceptance.ts](../../client/src/lib/acceptance.ts)、[client/src/components/chat/DeliveryList.tsx](../../client/src/components/chat/DeliveryList.tsx)、[client/src/components/chat/CloseoutCard.tsx](../../client/src/components/chat/CloseoutCard.tsx)、[client/src/components/chat/md-ext/PostmortemCard.tsx](../../client/src/components/chat/md-ext/PostmortemCard.tsx)

## 背景

- M39 原案剩余三项：DEV-2 工序卡（交付明细行增强：角色头像 + 阶段标签 + 懒加载预览 popover）、DEV-3 验收单（收尾卡变体：本 Run artifacts + qa 判定 + 未决项）、SR-3 复盘卡（时间线 + 归因 + 改进项；「`::: postmortem` 或正文」）；
- 现状：交付明细行已有类型图标 / 目录 / 名称 / 体积 / 作者（收尾清单）/「送上画布」（M37-6 + ADR 0123），但消息内行不透传作者、无阶段语义、无悬停预览；收尾清单无验收语义；复盘无结构化呈现（改进项四要素纪律在协议层已强制，但无渲染载体）。

## 决策

1. **DEV-2 工序卡**：交付明细行（`ArtifactRow`）新增——阶段标签 chip（`stageOf(groupId, agentId)` 派生，未收录场景不渲染）与悬停预览 popover（Radix Tooltip，**懒挂载**：悬停才渲染元信息卡——完整路径 / 类型 / 体积 / 交付者 / 阶段 / 操作提示）；`DeliveryFiles` 透传消息作者（`agentId` prop），消息内行补作者头像。**预览深度边界**：popover 只给元信息，完整内容预览仍走交付件视图（ADR 0079 复申：聊天流只做摘要与跳转，避免双实现）。
2. **DEV-3 验收单**：收尾卡（`CloseoutCard`）在 `development` 场景追加验收区——`acceptanceOf(messages, runId)` 纯函数启发式派生：判定徽章（`未通过 > 有条件通过 > 通过` 优先级，扫描本轮 qa 消息）+ 未决项列表（`- 未决：… / - 待验证：… / - 遗留：…` 条目，去重至多 5 条）；无 qa 内容 / 非 development 场景 → 不渲染验收区（降级不变：仅列交付件）。
3. **SR-3 复盘卡**：新增 `::: postmortem [标题]` 容器（remark-ext builder + finalize，字段 / 条目同 pan 口径）——字段行「分级 / 时间线 / 归因」按序渲染，条目行 `- 改进项 | 内容 | 归属` 归属渲染为 chip（owner + 期限）；sre 协议新增「渲染容器约定」条目 12（含输出格式与《事故复盘》表的同源关系）；复盘呈现以**消息内复盘卡**为主（原案的「收尾卡聚合变体」未建，留待真实需求——判定同 ADR 0082 条件性纪律）。
4. **派生口径写入资产**：qa 输出约定（「验收判定：X（N 项未决）」+ 未决条目）写入 mock 触发块（E2E 确定性）；启发式派生**宁缺毋滥**——无命中即不渲染，不猜测、不编造（与「不能确认的不计入」（ADR 0080）同族）。

## 理由

- **阶段标签是工序语义的最小载体**：在明细行上加一枚 chip 就能回答「这份件出自哪道工序」，无需打开交付件（DEV-2 的核心价值）；
- **Tooltip 懒挂载 popover 而非内联预览**：悬停才渲染、移出即卸载——零常驻成本，且与行点击（打开交付件）职责分离；
- **验收派生挂在收尾卡而非独立卡**：验收是对「本轮交付」的判断（同一 Run 的 qa 结论），与交付清单同容器呈现语义最准确；启发式（文本派生）避免为判定新增结构化工具面（qa 工具白名单最小授权原则）；
- **postmortem 容器化**：改进项四要素（行动 / owner / 期限 / 验证）在协议已强制，容器给结构化的可视载体；字段 / 条目复用 pan 口径与 finalizeFieldsAndItems——零新解析路径。

## 被否决的方案

- **qa 判定落结构化字段（submit_acceptance 工具）**：为渲染新增工具面（白名单 / 审批 / mock / eval 全链），与「最小授权」不符；文本派生 + 协议输出约定足够；
- **LLM 二次判定（另起模型调用判 readme 文本）**：成本与不确定性双高，且判定应是 qa 的显式输出而非二次推断；
- **popover 内联完整文件预览（懒加载内容）**：与交付件视图双实现（ADR 0079 已否决「聊天内联完整 Diff」同族）；元信息卡已满足「确认是不是这份文件」；
- **postmortem 由正文正则聚合（无容器）**：不稳定、不可回放（ADR 0062 复申）；sre 协议改造面极小（一处条目）；
- **验收区放进消息流（独立验收卡）**：与收尾清单重复挂载（同一 Run 的两张卡），信息架构冗余。

## 边界与失效条件

- 验收派生为**启发式**：判定词 / 未决条目格式即契约（写入 mock 与协议输出约定）；qa 真实输出偏离格式 → 不渲染（宁缺毋滥）；未决项上限 5 条（溢出不进卡，完整表在《测试报告》交付件）；
- popover 依赖全局 TooltipProvider（App 根已有；测试需包裹——m26/m27 先例）；
- `::: postmortem` 的字段 / 条目语法为渲染契约，sre 协议条目 12 与 mock 触发块为该契约的资产镜像面；若未来收尾卡聚合复盘（SR-3 变体）落地，本 ADR 的「消息内为主」结论按新需求修订。
