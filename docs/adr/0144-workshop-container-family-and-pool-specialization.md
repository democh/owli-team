# ADR 0144：研讨容器族五件套与汇聚板专业化——idea / phase / score / sources / decision

- 状态：Accepted
- 引入：M38 研讨型渲染包（2026-09-19）
- 相关：[design.md §92](../design.md)、[docs/scene-chat-design.md §6](../scene-chat-design.md)（M38 原案——本 ADR 为其容器族与汇聚板的落地方案）、ADR 0062（场景视图层派生：容器优先原则）、ADR 0064（统一回填语义：只写草稿不直发）、ADR 0114（冻结快照：半截容器不进派生）、ADR 0145（点亮本地互动态）、[client/src/components/chat/md-ext/remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[client/src/components/scene/panels/PoolPanel.tsx](../../client/src/components/scene/panels/PoolPanel.tsx)

## 背景

- docs/scene-chat-design.md 的 M38（研讨型场景包：brainstorm / research / strategy）自 M37 起处于「规划待评审」状态——点子卡 / 阶段条 / ICE 评分 / 来源卡 / 论断标签 / 决议卡六类渲染契约仅存在于设计文档；`remark-ext` 中 `idea / phase / score / sources / decision` 五个容器名全部缺失，Agent 侧输出这些容器只会按原文渲染；
- 汇聚板（M52-A pool 面板）为通用容器卡墙（`panRowsOf` 口径），研讨产物（点子 / 来源 / 决议）无专业化呈现；brainstorm / research / strategy 三场景的「点子池 / 来源墙 / 决策板」愿景（scene-expansion-design §7.10）未兑现；
- 用户全场景深度优化要求（批一）明确以研讨域为 P0。

## 决策

1. **五容器语法（自描述容器优先，ADR 0062 精神）**：
   - `::: idea [N] 标题`——字段行 `键：值` / 条目 `- 键 | 值`（同 pan 口径）；字段「状态：候选 | 入选 | 被毙」→ `data-status`（`IDEA_STATUS_MAP`，未命中无徽标）；
   - `::: phase 阶段名`——阶段分隔条；标题含「发散 / 探索」→ 暖色、含「收敛 / 评审 / 收口」→ 冷色（`data-tone`），其余中性；
   - `::: score [标题]`——条目 `- 名称 | 影响 8 | 信心 5 | 易度 7`；**总分缺省 = 子项乘积**（ICE 口径，与 refiner / facilitator 资产与 mock 先例 8×5×7=280 逐字一致）；显式「总分 / 合计」列优先；结果按总分降序；
   - `::: sources [标题]`——条目 `- 标题 | URL | 日期 | 要点 | 高|中|低`（五列，URL / 日期 / 可信度可缺省；容忍裸 URL 与 markdown 链接两种形态）；域名 chip 取 host 去 www；
   - `::: decision [标题]`——字段行 `背景： / 决策： / 后果：`（渲染按三要素排序，其余字段排后）。
2. **单一解析实现（防双实现漂移）**：`parseIdeaArg` / `ideaStatusOf` / `parseScoreLines` / `parseSourceLines` / `domainOf` 全部从 remark-ext 导出——remark 收尾（mdast → 扁平文本）与场景面板（容器原始行）共用同一函数；面板行含 `- ` 列表标记，解析器双重剥离无害。
3. **fail-safe 降级链（不变式）**：未知容器名 / 游离闭标记 → 保持原文；未闭合容器 → 去壳展开、内容保留；无有效条目 → `data-raw` 静态兜底（不空白、不丢内容）；流式期间轻结构容器直接渲染（同 M37–M43 口径）。
4. **汇聚板专业化（场景感知）**：`idea / score / sources / decision` 在 pool 面板与消息流**同组件渲染**（IdeaCard / ScoreCard / SourcesCard / DecisionCard）——面板条仅保留作者头像 + 类型徽标 + 定位按钮（卡片自带标题，避免双层壳体与标题重复）；`phase` 为消息流分隔条语义，不入面板卡墙；逐场景空态文案（brainstorm 点子 / research 来源 / strategy 决议 / society 立场 + 中性默认）。
5. **资产落地（容器格式写入资产是面板出现的前提，M37 checklist 先例）**：
   - `brainstorm / research / strategy` 三份场景协议新增「渲染容器约定」段（点子编号与状态枚举 / 阶段条 / ICE 评分 / 来源五列 / 决议三要素）；
   - `facilitator / ideator / refiner / scout / chief` 五个 AGENT.md「工作方式」各加一行输出约定；
   - mock 三组触发块（唯一触发词「点子走查 / 来源走查 / 决议走查」，同 M37 checklist / M54 pan 先例）供 E2E 确定性。
6. **编号与落位**：原预定的 M38 三决策（ADR 0066–0068 → 二次让位 0067+）经全仓核对落 **0144 / 0145**；design.md 落 **§92**（原预定 §53 → +2 让位 §55 → 实际 §92）；CHANGELOG v72。

## 理由

- **容器优先于正文正则聚合**（ADR 0062 复申）：fail-safe、可回放、与流式纪律兼容；协议显式示例 + mock / eval 断言约束输出稳定性；
- **ICE 乘积口径与资产逐字对齐**：refiner 资产明确「影响 × 信心 × 易度」，mock 先例 280 = 8×5×7——求和口径会造成卡片与《评分矩阵》数字不一致；
- **面板与消息同组件**：同一份数据（data-fields / data-scores / data-sources JSON）两处渲染，零双实现；面板条去重避免「卡片套卡片」；
- **单一解析实现**是本次的工程红线：面板走原始行、消息走 mdast 扁平文本，两条输入路径若各自实现必然漂移（此前 derive.panRowsOf 与 remark PAN_FIELD_RE 已用「同口径注释」维护，score / sources 结构更复杂，必须共享函数）。

## 被否决的方案

- **正文正则聚合（解析自然语言编号 / 表格）**：不稳定、不可回放、与流式半截内容冲突（ADR 0062 已否决，复申）；
- **每个容器两套解析（remark 一套 / 面板一套）**：结构稍复杂即漂移（评分列顺序、缺省列容忍度），且测试需双份维护；
- **score 总分求和口径**：与 ICE 资产口径不符，卡片总分与交付件《评分矩阵》对不上；
- **phase 分隔条进汇聚板**：分隔条是消息流时序语义，卡墙中的「阶段卡」无持续价值，反增噪音；
- **汇聚板渲染整卡（含卡片自身头部）**：标题 / 徽标与面板条重复，双层壳体视觉冗余——改为面板条瘦身后同卡渲染；
- **为 brainstorm 单独做点子编号兜底（`【点子 N】` 文本解析）**：BS-1 原案的兜底路径在容器化后无必要，反而引入第二事实源。

## 边界与失效条件

- 容器内不写 `@`（防误判为转交，沿用 M42 纪要卡先例）；容器为纯前端派生，不改消息协议与编排语义；
- 冻结口径不变（ADR 0114）：半截容器不进面板派生；流式期间消息内轻结构容器直接渲染；
- 面板就绪判定沿用 M58 `panelReady`（pool = 有结构化行或带标题容器）——新增容器名不需扩展该判定（命中已有「结构化行 / 标题」分支）；
- 若未来容器语法聚合或 remark 解析迁移服务端，本 ADR 的「单一解析实现」须随共享层迁移。
