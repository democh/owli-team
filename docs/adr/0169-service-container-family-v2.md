# ADR 0169：业务容器族 v2——服务型五容器（pipeline / figures / risk / progress / qa）与语法归一

- 状态：Accepted
- 引入：M41 服务型渲染包（2026-09-19）
- 相关：[design.md §103](../design.md)、[docs/scene-chat-design.md §9](../scene-chat-design.md)（M41 原案；决策项 0071 落位）、ADR 0062（容器优先）、ADR 0064（统一回填）、[client/src/components/chat/md-ext/remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[client/src/components/chat/md-ext/PipelineCard.tsx](../../client/src/components/chat/md-ext/PipelineCard.tsx)、[client/src/components/chat/md-ext/FiguresCard.tsx](../../client/src/components/chat/md-ext/FiguresCard.tsx)、[client/src/components/chat/md-ext/RiskBand.tsx](../../client/src/components/chat/md-ext/RiskBand.tsx)、[client/src/components/chat/md-ext/ProgressCard.tsx](../../client/src/components/chat/md-ext/ProgressCard.tsx)、[client/src/components/chat/md-ext/QaCard.tsx](../../client/src/components/chat/md-ext/QaCard.tsx)

## 背景

- M41 原案（scene-chat-design §9）定义服务型场景包：SA-1 客户管道 kanban（sales）/ FI-1 测算表卡 / FI-2 口径校验徽章 / FI-3 风险色带（finance·legal）/ FU-1 BP 进度卡 / FU-2 Q&A 卡（funding）/ OP-1 纪要卡（已由 M42 minutes 落地）/ OP-2 SOP 步骤卡（checklist 复用）/ OP-3 招聘管道（SA-1 复用）；
- 原案决策项 0071：**业务容器族 v2 语法归一**——新容器一律 `::: <name>` + 条目行 `- 字段 | 字段 | …` 扁平语法（沿用 kpi / timeline 先例）；状态枚举用**首词参数**（如 `::: risk 高`）；
- 现状：sales / finance / funding 的消息只承载散文与 kpi / timeline 复用卡——管道阶段、测算关键行、风险等级、里程碑进度、投资人问答均无可视结构。

## 决策

1. **五容器语法（v2 归一版）**：
   - `::: pipeline [标题]`——条目 `- 客户 | 阶段 | 金额 | 下一步`；阶段 ∈ {线索|意向|报价|成交}，**未识别归「其他」列**（fail-safe，不丢行）；
   - `::: figures [标题]`——条目 `- 行名 | 值 | 说明`；**关键行启发式**：行名命中 合计/总计/小计/毛利/净额/净利/EBITDA/税后 → 加粗 + 淡底；
   - `::: risk <高|中|低> [标题]`——**首词参数**（命中才着色；未命中 → 中性色带，整串为标题，不猜测等级）；正文 children 原样渲染（条目作补充说明）；
   - `::: progress [标题]`——条目 `- 章节 | 状态`；状态 ∈ {完成|进行中|待办}，未识别/缺省 → 待办；卡内总进度条 = 完成数 / 总数；
   - `::: qa [标题]`——条目 `- 问 | 答`；答案列内 `|` 保留合并（split 首段后 join）；渲染为原生 details 折叠对（无 JS 状态、缓存安全）。
2. **共享收尾与降级链**：四类行集容器共用 `finalizeRowSet`（takeList → 行解析 → `data-rows` JSON + `data-count` + `data-raw` 重建）；空行集 → 保持原文；组件侧解析失败 → raw 静态兜底；未闭合容器 → 去壳展开（既有口径）。
3. **SA-1 交互（回填统一语义）**：管道卡点击 → `composerInsert('跟进 <客户>：')`（只写草稿不直发，ADR 0064）；流式期间卡禁用。
4. **OP 面收敛（不重复造卡）**：OP-1 纪要 = 既有 `::: minutes`（M42，E2E 已覆盖）；OP-2 SOP = 既有 `::: checklist`（M37，E2E 已覆盖）；OP-3 招聘管道 = SA-1 复用（ops 场景输出 `::: pipeline` 即得同卡，零新容器）。

## 理由

- **语法归一（0071 落地）**：行集容器统一「条目行 + | 分隔」——解析器可共享（finalizeRowSet），模型侧一个心智模型（kpi / timeline / 五新容器同构），mock / 协议示例可互抄；
- **状态 / 阶段 / 等级全部「显示词即协议词」**：中文枚举直接作为输出语汇（`完成` / `意向` / `高`），无需 id 映射层——与 M38 状态枚举（候选/入选/被毙）同族口径；
- **关键行启发而非标记符**：财务语汇（合计 / 毛利 / 税后）天然携带「这是关键行」信号——启发式零输出成本；标记符方案要模型额外遵守且输出不稳；
- **「其他」列与「待办」兜底**：管道阶段与进度状态是模型输出里最易漂移的字段——归一兜底保证「表不丢行、卡不空白」（宁可展示降级不隐藏）。

## 被否决的方案

- **表格化重设计（figures 用真 Markdown 表格）**：与 kpi/timeline 语法分叉、解析需第二套实现；行集语法已表达同等结构；
- **pipeline 阶段自由文本**：列数不定 → 布局不可预期；四列 + 其他列是销售管道的行业标准形态；
- **`**关键行**` 显式标记**：增加模型输出负担且不稳定（漏标即退化）；启发式关键词已覆盖财务主语汇；
- **qa 用状态化手风琴（JS 展开）**：原生 details 零 JS、缓存安全、Markdown 语义直通——与 md-details 先例一致；
- **risk 未命中时猜测等级（按关键词如「合同」猜高）**：色带是强语义（红 = 高风险），猜测的代价高于中性展示。

## 边界与失效条件

- 阶段枚举 / 状态枚举 / 等级词表 / 关键行词表为**渲染契约**：扩展即改 remark-ext 常量表 + 对应单测（未知词永远安全降级）；
- 五卡为**消息内嵌**渲染（不含右区面板）；sales / finance / funding / ops 的 console 面板专业化（管道看板 / 指标区等）不在本 ADR 范围（另批评估）；
- `data-pipeline-card / data-pipeline-col / data-figures-card / data-figure-key / data-risk-band / data-progress-card / data-progress-pct / data-progress-state / data-qa-card / data-qa-row` 为测试锚点；
- 若未来容器语法 v3（payload 化 / 结构化消息卡协议），本 ADR 的 v2 语法口径随之退役（scene-chat-design §15 候选范式观察位）。
