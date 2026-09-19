# ADR 0166：场景扩展二批——十场景资产 · 场景玩法工具（种子复现）· roll / cards / sim 容器族 · 牌阵台与卡片交互

- 状态：Accepted
- 引入：M69 场景扩展二批（2026-09-19）
- 相关：[design.md §101](../design.md)、[docs/scene-expansion-v2-design.md](../scene-expansion-v2-design.md)（交互与前端蓝图）、ADR 0144（单一解析实现 / 汇聚板专业化先例）、ADR 0064（统一回填）、ADR 0112（场景工作区形态）、[remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[RollCard.tsx](../../client/src/components/chat/md-ext/RollCard.tsx)、[CardsCard.tsx](../../client/src/components/chat/md-ext/CardsCard.tsx)、[SimCard.tsx](../../client/src/components/chat/md-ext/SimCard.tsx)、[ChartboardPanel.tsx](../../client/src/components/scene/panels/ChartboardPanel.tsx)、[dice.ts](../../server/src/tools/dice.ts)、[tarot.ts](../../server/src/tools/tarot.ts)

## 背景

- 全量盘点后选定十场景实施（经营创作域：ecommerce / creator；实用域：legal-personal / academic / relationship；玩法域：trpg / tarot / moot-court / business-sim / philosophy）——用户明确「着重交互与前端设计」与「新增 skill / tool 自行查找实现」；
- 玩法域需要两类随机源且必须可复现：跑团的掷骰与塔罗的抽牌——「跑团剧本杀需先定骰子随机策略」为既有储备前置项；随机若不可复现，战报与复盘无法复查；
- 交互层需要新容器承接随机结果（骰卡 / 牌阵卡 / 回合结算卡）与既有四形态 / 六面板体系对齐；tarot 的 chartboard 面板需要「牌阵台」区（此前 chartboard 只服务 pan 容器）。

## 决策

1. **十场景资产**（10 × `_group.yaml` + 协议 + 34 角色）：形态声明 dock ×6 / roundtable ×2 / arena ×2（moot-court / business-sim 带 seats + parts）；协议统一「渲染容器约定」段规定各场景容器用法（ecommerce→kpi/checklist/timeline 等）；**补强 12 角色（travel / wealth / funding / bi / sre / personal / ops）不进 chain**（镜像面既有口径——经成员微调或自动召集使用）；
2. **场景玩法工具两件（新分类「场景玩法」）**：`dice_roll`（骰式解析 d20 / 3d6+2 / 2d10-1；**mulberry32 确定性 PRNG**——种子缺省随机生成并回显、同种子逐位复现；输出含 `::: roll` 容器模板）与 `tarot_draw`（78 张全表 + 正逆位 50%；输出含 `::: cards` 容器模板）；两者 tier=deferred + readOnly + 无审批，与 pan 四件套同模式（纯计算、禁止心算造数）；
3. **三容器族**（remark-ext，`finalizeFieldsAndItems` 复用 + 收尾按 type 分派）：`::: roll`（字段行 骰式/种子 + 明细/修正/总值）、`::: cards`（条目 `- 牌位 | 牌名 | 正逆位 | 关键词`）、`::: sim`（条目 `- 决策 | … | 反馈 | … | 指标 | …`）；对应卡片组件「解析失败 → raw 兜底」「流式禁用」「回填只写草稿」（ADR 0064）；
4. **卡片交互**：RollCard 双按钮——「再掷一次」（**换新种子**）与「复现本次」（**同种子重掷**，seed 缺省时不渲染）；CardsCard 双按钮——「重抽一组」（新种子）与「深入解读这组牌」；SimCard「下个回合」；全部经 `composerInsert` 回填模板句（含角色 @）；
5. **tarot 牌阵台（chartboard cards 区）**：ChartboardPanel 收集 `cards` 容器 → 复用 CardsCard 渲染（面板与消息同组件，ADR 0144 纪律）；tarot 场景隐藏「亲手摇卦」入口（体系隔离）且空态文案场景化；pan 路径零变化（有 pan 才渲染 PanBoard）；
6. **mock 触发块三组**（「骰子走查 / 牌阵走查 / 回合走查」——E2E 与 eval 的确定性演示通道，索引走 `baseId` 与并发批次口径一致）；
7. **技能 7 件**（trpg-hosting / tarot-reading / ecommerce-operations / creator-economy / academic-writing / relationship-communication / philosophy-dialogue）：含「常见的坑」/ 检查清单 / 工具接入口径（新工具在技能内写明调用纪律）。

## 理由

- **种子复现 = 可复现性契约**：骰子与牌序的「同种子逐位复现」让战报 / 解读可存档复查，直接落实储备方向「先定骰子随机策略」；mulberry32 零依赖、跨环境稳定；
- **容器单一解析**（ADR 0062 / 0144 复申）：三卡片与面板共用同一数据形状；fail-safe 优先（无字段无条目 → raw 兜底不空白）；
- **组件复用**：面板牌阵区直接复用 CardsCard（消息卡）——同组件渲染消灭双实现风险；
- **体系隔离**：塔罗属西方象征体系，与 pan（命理占星）分容器分区；chartboard 免新建第 8 类面板（注册表稳定）。

## 被否决的方案

- **随机数直接用 Math.random / 时间种子**：不可复现，战报与复盘无法复查——否决；
- **骰子并入 gua_pan 扩展**：卦占与跑团职责混杂，且 pan 的 deferred 激活词不匹配——独立工具；
- **塔罗并入 astrology 场景**：ADR 0111 已裁「无星历 / 宫位同源方法论」——独立场景 + 独立工具；
- **牌阵专用新面板（第 8 类）**：chartboard 加 cards 区足够；扩面板破坏注册表稳定（ADR 0162 同口径）；
- **骰卡免种子（纯展示）**：失去复现能力——种子上卡为硬契约。

## 边界与失效条件

- **种子兼容为永久契约**：mulberry32 序列与牌表洗牌算法一旦发布，修改 PRNG 实现须保证同种子兼容（或升版本字段）；
- **合法性边界**：塔罗定位文化研习（不承诺预测、不恐吓不推销——场景协议铁律）；`dice_roll` 不涉博彩性玩法；
- **cards 区不参与归档**：PanBoard 存档（`ma:pn:*`）仅服务 pan；牌阵的重看走消息流卡片；
- 若后续为 tarot 增加「牌阵历史对照」等增强，扩 chartboard 的 cards 区段即可；三容器语法不变。
