# ADR 0187：塔罗抽牌台——仪式化亲手抽牌与公版韦特牌面（M78）

- 状态：Accepted
- 引入：M78（2026-09-19）
- 相关：[design.md §113](../design.md)、[docs/tarot-ritual-design.md](../tarot-ritual-design.md)（专项设计）、[server/src/tools/tarot.ts](../../server/src/tools/tarot.ts)、[client/src/components/chat/md-ext/tarot/](../../client/src/components/chat/md-ext/tarot/)（deck / TarotRitual / CardBack / TarotCardFace / JournalDialog / CodexDialog / TarotRitualHost）、[client/public/tarot/](../../client/public/tarot/)（78 张公版韦特 + 牌背，PD 登记）、[agents/tarot/_protocol.md](../../agents/tarot/_protocol.md)、[skills/tarot-reading/SKILL.md](../../skills/tarot-reading/SKILL.md)、[server/tests/m78-tarot-ritual.test.ts](../../server/tests/m78-tarot-ritual.test.ts)、[client/tests/m78-deck.test.ts](../../client/tests/m78-deck.test.ts)、[client/tests/m78-ritual.test.tsx](../../client/tests/m78-ritual.test.tsx)、[e2e/m78-tarot-ritual.spec.ts](../../e2e/m78-tarot-ritual.spec.ts)

## 背景

- M69 交付后塔罗抽牌是 **AI 单方行为**：用户发问题 → tarot-reader 调 `tarot_draw` → 回复内 `::: cards` 卡；用户全程只能「看」，与「塔罗研习」的文化参与感相悖（用户诉求原话：「交互性和可玩性、趣味性，让用户能参与进去，比如随机选牌」「好看的一套卡片效果，完整的，或者使用专业的卡牌」）；
- 参与先例成熟：metaphysics 摇卦台（M54-C）已验证「**用户亲手完成仪式 → 交复现参数请解 → 工具复算逐位核对**」闭环——`pan/coin.ts` ↔ `server/src/pan/gua.ts` 的「本地推导与工具逐位同源」工程模式可直接复用；
- 牌面现状：`::: cards` 为纯文字行，78 张象征符号系统缺视觉本体；
- 合规框架已就位：`agents/tarot/_protocol.md` 七条铁律 + `pan/trail.ts`「不做签到 / 连击 / 成就 / 排行」红线先例。

## 决策

1. **抽牌台六阶段状态机**（`TarotRitual`，全局宿主挂 AppLayout）：idle（静心：选牌阵 + 所问）→ shuffle（亲手洗牌，生成仪式种子并公开）→ cut（三堆点选置顶）→ draw（**78 格牌背网格亲手选牌**，roving tabindex + 撤销）→ reveal（逐张 3D 翻牌 + 牌位语义浮现）→ complete（复现参数全展示 + 牌组构成事实 + 请解 / 重放 / 重新洗牌）。进度只存参数与进度（`ma:tc:ritual`），关闭 / 刷新可续；
2. **诚实参与——选择即结果**：用户点选的格位索引直接进入复现参数（`picks`），不做「结果已定、动画演戏」的假交互；**正逆位在洗牌阶段一次性为 78 张定妥**（「牌带正逆位」），切牌旋转与选牌只搬运不重置；
3. **复现三元组 `seed + cut + picks`**（`tarot_draw` 扩展）：`cut`（0/1/2 = 第 c 堆放最上，等价牌堆旋转）与 `picks`（不重复 0-77 整数，长度 = 牌阵张数，牌位序 = 点选序）为可选参数；**缺省（cut=0 / picks=[0..N-1]）与旧版逐位一致**（既有 golden 不动）；客户端 `deck.ts` 与工具逐字同源，跨端期望值由两侧测试向量字面锁定；
4. **公版韦特牌面（PD）**：源 `mixvlad/TarotCards` 仓库（Rider-Waite-Smith 1909，Public Domain；经 jsDelivr 直链拉取，实测可达），`sips -Z 560` 压缩落盘 `client/public/tarot/rws/`（78 张 / 6.5MB）；牌背为定制「星月紫金」（ImageGen 设计稿 + SVG 兜底）；**三级降级链**（位图 → 程序化文字牌·花色符号 × 点数阵列 → 文本），78 张永不缺失；许可登记随素材目录交付；
5. **研习设施（无 gamification）**：手记自动记录（幂等、只存参数、可重放 / 再请解 / 删除）；78 张图鉴（分组浏览 + 遇见计数只读小字 + 问这张回填）；足迹从手记派生（`抽过 X 阵 · 遇见 X/78 张 · 请解 X 次`）——**无签到 / 连击 / 成就 / 排行 / 积分 / 音效**；
6. **入口三处**：ChartboardPanel 面板行（亲手抽牌 / 图鉴 / 手记；**空态即有**——`SceneStage` 对 tarot·chartboard 恒就绪）；消息内 `CardsCard` 第三按钮「亲手抽一组」；类名一律 `.tc-*` 命名空间（不复用 `.pn-*`，保 m69 既有断言）；
7. **协议与技能同步**：`_protocol.md` 铁律 8（亲手抽牌按三元组复算、不采信转述牌面）+ 工具纪律参数口径；tarot-reader「亲手抽牌复算」一行；`tarot-reading` 技能补复现三元组与检查清单条目。

## 理由

- **「亲手选」而非「随机分配」**：塔罗仪式的核心参与感在洗牌 / 切牌 / 选牌的动作链上；用户点选位置直接决定结果，既诚实又有仪式感，且与「种子可复现」不冲突——种子定牌堆，用户定取哪几张；
- **本地推导 + 工具复算双层**：本地仪式展示必须与工具逐位一致（否则信任事故），交叉向量测试把这条约束变成 CI 门禁；正式牌面以工具复算为准（与摇卦台「报数不本地预测卦名」同一诚实边界）；
- **公版位图优先**：用户明确要「专业卡牌」；韦特牌面是塔罗研习的通用参照，PD 状态无版权风险；程序化牌降为兜底（点数阵列仍按马赛 pips 传统排布，兜底也保持体系正确性）；
- **零奖励机制**：可玩性来自仪式沉浸与复现自检（重放验证），不来自激励系统——`trail.ts` 红线口径直接继承，避免研习工具滑向游戏化。

## 被否决的方案

- **Wikimedia Commons 直连下载**：实测不可达（TLS 超时；upload.wikimedia.org 历史同结论）；
- **运行时直链 CDN（不落盘）**：离线不可用、波动不可控，违背「素材预置」惯例；
- **ImageGen 生成 78 张牌面**：78× 成本、风格一致性不可控、经典牌义细节易错（牌背单张生成可行——已采用）；
- **纯 CSS/emoji 文字牌面作主方案**：不满足「好看完整 / 专业卡牌」诉求，降为 L2 兜底；
- **用户点选不影响结果（假交互）**：违背诚实参与原则，被用户感知即为信任事故；
- **音效 / 庆祝动画 / 成就徽章**：无先例 + 合规红线；
- **凯尔特十字（10 张）等新牌阵本批引入**：范围失控，列二期开放点（专项设计 §13.3）。

## 影响与验证

- **工具**：`tarot_draw` 增 cut / picks（可选、向后兼容）；summary / detail 追加复现三元组行；`::: cards` 卡模板契约不变；
- **前端**：新增 `md-ext/tarot/` 8 文件（deck / journal / CardBack / TarotCardFace / TarotRitual / TarotRitualHost / JournalDialog / CodexDialog）+ `.tc-*` 样式块（约 930 行）+ ui-store 请求族 + AppLayout 挂载 + SceneStage tarot 恒就绪（一行）；
- **验证**：server 既有 m69 13 例全绿（缺省兼容）+ 新增 m78 6 例（cut/picks golden / 旋转等价 / 校验）；client m78-deck 6 例（与 server 向量字面一致）+ m78-ritual 10 例（状态机主路径 / 撤销 / 恢复 / 文案 / 手记 / 图鉴 / 降级链）+ m69-md-ext 17 例回归；E2E `m78-tarot-ritual` 2 例（全流程 + 图鉴手记入口，隔离环境 8795 / e2e-m78）；typecheck 0 错误；
- **素材账**：78 张 6.52MB（均 86KB）+ 牌背 51KB（client/public/tarot/）；原始 720px 留档 `data/tc-raw/`（脚本 `tmp-fetch-tarot-cards.mjs` 可断点续拉）；
- **镜像面**：`docs/tarot-ritual-design.md`（专项设计落盘）、`docs/adr/README.md` 索引、`agents/CHANGELOG.md` v98（协议变更登记）、`design.md §113`。
