# ADR 0156：报价折线 · 博弈走子板 · 四路观点卡——offerSeriesOf · gameMovesOf · claim 扩展字段与证据徽标

- 状态：Accepted
- 引入：M64 对抗博弈主面批一（2026-09-19）
- 相关：[design.md §98](../design.md)、[docs/pk-game-analysis-design.md §5 / §6](../pk-game-analysis-design.md)（G1 / G2 / G4 / N1 / U1）、ADR 0114（冻结快照）、ADR 0144（单一解析实现）、ADR 0083 / M34（fin_game 快照与 game 块契约）、[lib/pk.ts](../../client/src/lib/pk.ts)、[lib/evidence.ts](../../client/src/lib/evidence.ts)、[OfferChart.tsx](../../client/src/components/scene/parts/OfferChart.tsx)、[MoveBoard.tsx](../../client/src/components/scene/parts/MoveBoard.tsx)、[ViewCards.tsx](../../client/src/components/scene/parts/ViewCards.tsx)、[VersusPanel.tsx](../../client/src/components/scene/panels/VersusPanel.tsx)

## 背景

- negotiation 报价流为纵向列表（标题 / 金额 / 差值色标）——无时间序图形，「目标 / 底线 / BATNA」三桩只在文档与正文；让步递减纪律（质量红线）不可视；
- invest 多空对弈的 `fin_game` 走子（matrix / sequence / evolve / simulate）散在消息内（```game 块 + 快照），面板不可见；种子 / 快照路径不上面板，与投研协议「可复现」诉求脱节；
- invest 四路分析（基本面 / 技术面 / 舆情 / 量化）只有 prose 与文档；scene-expansion §7.10.3 承诺的「四路观点卡」未兑现；claim 容器无视角 / 倾向 / 置信度结构化字段；协议要求证据附来源等级，前端无分级视觉。

## 决策

1. **报价序列（纯派生）**：新 `lib/pk.offerSeriesOf(messages, sides)`——复用 `containerBlocks('offer')` + `offerRowsOf` + `offerAmount`（现件）聚合双方序列；侧由消息作者 ∈ 席位判定；基准线（目标 / 底线 / BATNA|最佳替代）取首个显式字段行（缺省不产出）；不可解析金额点跳过（列表原样保留）；
2. **报价图与让步刻度**（新元件 `parts/OfferChart` + `OfferConcessions`，零图表依赖 SVG 自绘）：双折线（我方暖 / 对方冷）+ 数据点定位（点击 → focus）+ **收敛走廊**（两侧最新报价之间；交叉 → 交叉态配色；不称 ZOPA 避免语义过断言）+ 基准线（目标绿点线 / 底线红实线 / BATNA 灰虚线）；让步刻度：柱高 ∝ |Δ|，**递减绿 / 幅度扩大红警示**（点击 → `TEMPLATES.concessionExplain` 回填）；有效金额点 < 2 不绘图；
3. **博弈走子板**：新 `derive.gameMovesOf`（```game 围栏扫描 + `parseGameSpec` 单一解析；解析失败仍产出条目、仍可定位）；`parts/MoveBoard` 条目 = 轮次 + 模型中文标签 + 标题 + 快照 basename + 种子复制 + 段尾固定声明「模型推演，非预测（参数与种子随快照可复现）」；versus 空态「发起多空对弈」回填 `DUEL_PROMPT`（与 `_agents/_presets.yaml` bull-bear-duel prompt 同文，改动两处同步）；
4. **四路观点卡**：claim 容器扩展**可选**字段行 `视角 / 倾向 / 置信度`（各取首条；`lib/pk.claimMetaOf` 单一解析——remark-ext finalizeClaim 与场景面板共用，ADR 0144 红线）；`parts/ViewCards` 按视角注册表序（基本面 / 技术面 / 舆情 / 量化，未知追加）渲染：视角徽标 + 倾向色条（多红 / 空绿 / 中性灰，`stanceToneOf` 共用）+ 置信度 + 依据数；分歧提示 chip（同时含多与空）→ `TEMPLATES.splitAdjudicate`（invest 协议第 8 条裁决口径）；
5. **证据等级共用件**：新 `lib/evidence.ts`——`gradeOf` 词表（官方 > 学术 > 权威媒体 > 待核实，多命中取最高优先级）+ 中文标签；`ClaimTree` 论据行渲染等级徽标（`scene-claim-grade`）/ 无证据「假设」徽标（`scene-claim-ask.is-hypo`，回填 `TEMPLATES.markHypothesis`）/ 无等级「补证据」按钮（回填 `TEMPLATES.askEvidence`）；行元素改 `div[role=button]` 以容纳嵌套按钮（既有选择器 / 断言不变）；
6. **就绪与场景分支**：`panel-ready` versus 口径扩展（有 verdict / 带「视角」claim / ```game 围栏任一即就绪）；面板侧沿用「场景键 / 数据键 → 段注册」模式（pool SPECIAL_CONTAINERS、console 场景分支同先例），新段一律「无数据不渲染」。

## 理由

- **单一解析 / 复用现件**：offer 解析、game 解析、claim 解析全部走既有单一实现或同一函数导出，面板与消息两处零双实现；
- **图表零新依赖**：自绘 SVG（matrix 热力图先例）避免包体膨胀与版本锁定负担；量级不明时以图 + 列表双层并存兜底（图损不丢信息）；
- **字段全可选**：claim 扩展字段缺省不影响既有渲染路径——消息卡 / 论断树 / 汇聚板对旧内容零变化；
- **合规内置**：走子板固定声明条 + 种子复制，把投研协议第 9 条的复现要求落到 UI 层。

## 被否决的方案

- **报价图称 ZOPA 区间带**：双方方向语义不可靠（用户可能为买方或卖方），称 ZOPA 属过度断言——落为「收敛走廊 + 当前差距（模拟口径）」；
- **走子板从快照 src 拉取数值**：需读交付件内容 + 解析 stats，重且慢；段落聚合以围栏元数据为准（模型 / 种子 / 快照名 + 定位），量化详情仍由消息内 GameBlock 承载；
- **合并出价 / 回价两条折线为一条**（净让步）：丢失对抗语义；
- **四路观点卡另造容器**：claim 扩展字段即可承载（视角 / 倾向 / 置信度），新容器徒增语法面。

## 边界与失效条件

- `offerSeriesOf` 基准线取「首个显式字段」——多轮重复声明以首轮为准（协议要求三桩先行，符合）；金额混合量级时标签走 `formatOfferAmount`；
- `gameMovesOf` 仅扫描成员消息（用户消息不产走子）；`parseGameSpec` 失败条目降级「推演（快照）」但保留定位；
- claim 扩展字段为纯展示语义，不参与任何编排 / 校验；若未来 invest 协议改为专用容器，本 ADR 第 4 条的解析面须同步迁移。
