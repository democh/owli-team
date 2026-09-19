# ADR 0170：口径校验徽章——calc 成功即亮「已核算」（FI-2）

- 状态：Accepted
- 引入：M41 服务型渲染包（2026-09-19）
- 相关：[design.md §103](../design.md)、[docs/scene-chat-design.md §9](../scene-chat-design.md)（M41 原案 FI-2 落位）、ADR 0169（同批服务型容器族）、[client/src/lib/calc-badge.ts](../../client/src/lib/calc-badge.ts)、[client/src/components/chat/MessageItem.tsx](../../client/src/components/chat/MessageItem.tsx)

## 背景

- M41 原案 FI-2：口径校验徽章——消息头部徽章位；「消息 toolCalls 含 calc」派生「已核算」徽章（hover 展示表达式）；无 calc → 不渲染；
- 背景纪律：业务工具四件套（M21）中 `calc` 的「何时必须用」由协议层约束（金额 / 比例 / 利率一律 calc，禁止心算）——徽章是**呈现层对已发生事实的投射**，不新增任何强制机制；
- 现状：calc 调用只出现在折叠的工具卡内（ToolCallsPanel 默认收起），消息级「这条发言算过了吗」不可扫视。

## 决策

1. **派生口径（纯函数 `calcExpressionOf`）**：取消息 toolCalls 中**首个 `status='ok'` 的 calc** 的 `args.expression`（非空字符串）；无 calc / 全部非 ok / 表达式缺失 → undefined（不渲染）。
2. **展示**：消息头部徽章行（波次徽章之后）渲染「已核算」徽章（emerald 淡底 + Calculator 图标）；`title = 已核算：<表达式>`（hover 即见口径）；`data-calc-badge` 测试锚点。
3. **不渲染场景**：运行中 / 失败的 calc 不亮（只有成功执行才是「已核算」事实）；用户消息不可能有 toolCalls（自然不亮）。
4. **不新增工具面 / 不落库**：徽章完全由既有 ToolCallRecord 派生（无新字段、无新接口）；协议纪律（何时必须用 calc）维持既有约束不改。

## 理由

- **规则外置、事实内显**：协议约束「必须用」，徽章展示「用了」——两者分离，用户可扫视核对而无需打开工具卡；
- **title 承载表达式**：hover 展示表达式（原案要求）用原生 title 即可——表达式可能较长，自定义 popover 成本与收益不成比例（且徽章是低交互信息点）；
- **首个成功调用即可**：一条消息多次 calc 时，声称「已核算」的事实依据是「至少算过一次」——展示首个表达式已足够建立证据感（全量表达式在工具卡内）。

## 被否决的方案

- **徽章挂到工具卡内部**：工具卡默认折叠 → 消息级扫视不可得；头部徽章位才是「这条发言的口径可信度」的正确信息层级；
- **徽章落库（消息字段）**：纯派生事实（toolCalls 已在消息上）——冗余存储且双源可能漂移；
- **每次 calc 亮一枚徽章**：徽章行会随调用数膨胀（头部拥挤）；一次即亮、细节看工具卡；
- **hover 自定义 tooltip 组件**：title 足够（纯文本表达式）；避免为一个徽章引入 Popover 交互面。

## 边界与失效条件

- `data-calc-badge` 为测试锚点；徽章文案「已核算」与 title 前缀「已核算：」为渲染契约（E2E 断言）；
- 若未来 calc 工具参数改名（expression → expr），派生函数随之调整（单测覆盖）；
- 若未来引入「必须核算」的强制门禁（引擎层拦截），本 ADR 的派生口径不变（呈现面独立）。
