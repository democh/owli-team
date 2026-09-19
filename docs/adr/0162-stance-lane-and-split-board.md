# ADR 0162：立场泳道与共识分歧板——`::: stance` / `::: split` 两容器族 · pool 泳道沉淀 · 收尾合并

- 状态：Accepted
- 引入：M66 分析域批二（2026-09-19）
- 相关：[design.md §100](../design.md)、[docs/pk-game-analysis-design.md §6-N4](../pk-game-analysis-design.md)、ADR 0144（单一解析实现红线 / 汇聚板专业化先例）、ADR 0114（冻结快照）、ADR 0064（统一回填）、[remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[StanceCard.tsx](../../client/src/components/chat/md-ext/StanceCard.tsx)、[SplitCard.tsx](../../client/src/components/chat/md-ext/SplitCard.tsx)、[PoolPanel.tsx](../../client/src/components/scene/panels/PoolPanel.tsx)

## 背景

- society（议题圆桌）语境为「事实基线 + 立场图谱 + 共识与分歧」，但协议无容器约定；汇聚板（pool）为通用卡墙——立场与共识分歧无结构化沉淀（scene-chat-design 原「批六」事项）；
- 立场卡需要三要素（主张 / 核心关切 / 被忽视视角）与依据（含证据等级）；共识分歧需三类并列（共识 / 分歧 / 存疑）且「分歧不得抹平」；
- remark-ext 中 verdict（M52）/ ruling（M63）已形成两份同构的键值条目收尾实现，存在合并窗口。

## 决策

1. **新容器 `::: stance <立场方>`**（立场卡）：字段行 主张 / 核心关切 / 被忽视视角（`finalizeFieldsAndItems` 复用——与 decision 同构）+ 条目 `- 依据 | …`；StanceCard：三要素固定序渲染（缺省字段排后）、依据正文走 `lib/evidence.gradeOf` 等级徽标（U1 共用件）、「推演关切」回填 `TEMPLATES.stanceAsk`（流式禁用）；
2. **新容器 `::: split <标题>`**（共识分歧板）：条目 `- 共识|分歧|存疑 | …`；SplitCard：三列分桶（`splitBucketOf`：共识|一致 / 分歧|争议 / 存疑|待核|未定；**未知键落「其他」行 fail-safe 不丢内容**）、分歧置中主位；分歧条目点击 → `TEMPLATES.splitPath`（中间路径）、存疑条目 → `TEMPLATES.splitVerify`（核实路径）、共识条目静态（定位由面板条承担）；
3. **汇聚板沉淀**（pool）：`SPECIAL_CARDS`（idea / score / sources / decision）与 `NON_GENERIC`（+ stance / split / phase）拆分——stance → **立场泳道**（按容器首参分组，稳定哈希 6 色相 `data-hue`；面板条瘦身 + 同组件渲染，M38 先例）；split → **共识分歧板段**；就绪判定沿用「结构化行 / 标题」口径（零扩展）；
4. **容器标记防冲突**：stance 容器用 `data-stance-card`（claim 已占用 `data-stance` 表示「倾向」字段——标记必须可区分，Markdown 分派链零歧义）；
5. **收尾合并（附）**：verdict / ruling / split 三族共用 `finalizeItemRows`（box 按 `b.type`）——消除 M63 引入的重复实现；
6. **资产**：society 协议新增「渲染容器约定」段（条目 14–15：立场三字段与依据等级 / split 三类条目 / 事实基线 `::: sources`）；mock 触发块「立场走查」（stakeholder 两席 + moderator 共识分歧）。

## 理由

- **容器优先 + 单一解析**（ADR 0062 / 0144 复申）：stakeholder / moderator 结构化输出即可驱动泳道与共识板；面板与消息同组件渲染，零双实现；
- **fail-safe 优先**：未知键不丢内容（落「其他」行）；无字段无条目时正文照常渲染（不空白）；
- **色相稳定哈希**：立场方着色无需配置（同名恒同色），`data-hue` 数据属性可测；
- **标记可区分**是硬约束：`data-stance`（claim 倾向字段）与 `data-stance-card`（stance 容器）同前缀不同键——分派链顺序零风险。

## 被否决的方案

- **复用 `::: claim` + 字段承载立场**：立场方名 / 三要素语义与 claim（主张-论据-证据）不同构，且 claim 已被 debate / invest 占用；
- **split 用 `::: minutes` 三栏类比**：minutes 键域为 决议/待办/风险，语义不符（共识/分歧/存疑）；
- **立场泳道独立面板（第 8 类）**：pool 段足够；扩面板破坏注册表稳定；
- **共识条目也可点（回填）**：共识的下一动作是「落地执行」而非追问——保留静态，定位走面板条（宁缺毋滥）。

## 边界与失效条件

- stance / split 不入通用卡墙（`NON_GENERIC`）；phase 分隔条语义不变；
- 立场泳道按容器首参分组——首参缺省归「相关方」；匿名化纪律由协议层约束（society 铁律 4），前端不做身份推断；
- 若未来 society 需要「立场时间线」等增强，扩模板与段注册即可；容器语法不变。
