# ADR 0154：交锋计量板与交锋看板——claims 计数 · crossFireOf 派生 · 计分板三层读数 · arena parts 六件套

- 状态：Accepted
- 引入：M64 对抗博弈主面批一（2026-09-19）
- 相关：[design.md §98](../design.md)、[docs/pk-game-analysis-design.md §4](../pk-game-analysis-design.md)（A1 / A2 / U2）、ADR 0117（PK 范式：分侧 / 配对 / 计分先例）、ADR 0144（单一解析实现红线）、ADR 0114（冻结快照）、[lib/pk.ts](../../client/src/lib/pk.ts)、[ArenaStage.tsx](../../client/src/components/scene/ArenaStage.tsx)、[Scoreboard.tsx](../../client/src/components/scene/parts/Scoreboard.tsx)、[CrossFire.tsx](../../client/src/components/scene/parts/CrossFire.tsx)

## 背景

- debate 计分板（`Scoreboard`）读数 = 终局 `::: verdict` 状态计数——verdict 只在终局产生，**开赛后全程 0:0**，与「交锋」语义脱节；
- 缺陷-修补配对（`::: findings` 的「已响应」推导）只在消息内的配对卡呈现，**arena 中轴无聚合**；brainstorm 红队的挑刺-修补状态不进汇聚板；
- `duelTally`（PK-5）已有 speaks / findings / responded 三项，无 claims 项；`PART_NAMES`（v68 五件套）无 findings 聚合位。

## 决策

1. **计量扩展（纯派生）**：`duelTally` 增 `claims` 字段（`claimNodesOfContent` 计数，按席位分侧；口径与 `duelSides` 席位优先 / 姿态兜底一致）；新增 `crossFireOf(messages, sides)`——findings 条目 + 「已响应」全量提及扫描（排除定义行，口径同配对卡 / duelTally），**未响应优先排序**（同状态按编号升序）；
2. **计分板三层读数**（`Scoreboard` 升级，向后兼容——读数缺省保持 v1 外观）：`发言 N · 主张 N · 交锋 x/y`；交锋读数点击 → 定位该侧首个未响应缺陷；终局徽标（`{席名} 胜 · 置信度 高`）点击 → 定位裁决消息；全部读数 hover 口径提示；
3. **交锋看板 CrossFire**（新元件 `parts/CrossFire`）：双泳道 = 侧名 + 提缺 / 已响应计数 + 响应率条；条目 = `#N` + 描述摘要 + 状态点（未响应优先，每侧上限 6 条折叠 `+N`）；「催回应」仅未响应条目（`TEMPLATES.chaseFinding` 回填）——**只读模式**（汇聚板红队段）不提供；
4. **arena parts 六件套**：`PART_NAMES` 五件套 + `cross-fire`（交锋看板）；debate `stage.parts` 声明同步（round-track / scoreboard / verdicts / **cross-fire** / claim-tree）；arena 中轴 insights 段序固定「交锋看板 → 论断树 → 报价流」；m21 stage 断言同步；
5. **红队段复用**：汇聚板（pool）在存在对抗姿态对（`DUEL_STANCE`：ideator ↔ challenger 等）且产出 findings 时，榜首沉淀「红队看板」（同组件、只读、无催回应——红队对无固定轮次纪律）；就绪判定沿用既有「结构化行 / 标题」分支。

## 理由

- **容器优先 / 纯前端派生**（ADR 0062 / 0114 复申）：findings / claim 均为结构化容器，冻结口径下派生零数据层改动；「已响应」推导与配对卡、duelTally 三处同口径（同一提及扫描），避免第二事实源；
- **向后兼容的读数升级**：`speaks` 为可选 prop——未传时渲染 v1 外观，既有测试零改动期望；
- **六件套声明式裁剪**：沿用 v68 `partEnabled` 单一事实源，negotiation 不加 cross-fire 即天然不出。

## 被否决的方案

- **计分板继续只显示裁决计数**：开赛恒 0:0 的失真实显（v68 已为 negotiation 摘除计分板，同一问题不在 debate 重演）；
- **交锋看板做成独立面板（非 insights 段）**：arena 无右区（§7.2），中轴洞察区是唯一承载面；独立面板会破坏形态边界；
- **红队段带「催回应」**：红队对无回合纪律，「催」语义失真——只读呈现配对状态。

## 边界与失效条件

- 交界 / 读数均为视图层派生：消息协议 / 编排 / 服务端零改动；容器半截不进派生（ADR 0114）；
- `crossFireOf` 要求消息含 `id`（定位锚点缺失时该条跳过）；「已响应」为全量提及口径（含 findings 定义之前消息的提及——与 duelTally 一致）；
- 若未来 findings 语义改版（编号跨对局复用等），本 ADR 的提及口径须同步更新。
