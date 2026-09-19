# ADR 0171：罗盘第五盘卡与九宫叠图——三环罗盘 · 双盘切换 · 合规色带（M66-B）

- 状态：Accepted
- 引入：M66 批二（2026-09-19）
- 相关：docs/design-studio-design.md（§10.2 第五盘卡 / §10.3 九宫叠图）· ADR 0168（M66-A 工具与口径）· ADR 0131（盘面交互先例）· [client/src/components/chat/md-ext/pan/LuopanBoard.tsx](../../client/src/components/chat/md-ext/pan/LuopanBoard.tsx)

## 背景

M66-A 落地后，`::: pan luopan` 盘卡走 PanCard 未知 kind 降级（通用表格）——M66-B 需将此前的「fail-safe 过渡态」升级为**第五盘卡**：三环罗盘自绘 + 八宅 / 流年双盘切换 + 九宫叠图，且全程守合规表述（参考语统一、无恐吓）。

## 决策

1. **注册路径（单一解析处纪律）**：`remark-ext` 的 `PAN_KINDS` + `'luopan'`（第 10 类）+ 徽标「罗盘」；pan/model.ts 的独立 `PanKind` 声明同步（两处等价声明为既有约定——保持 pan/ 零反向依赖）；`PanCard` 经 `derivePan` 分派 `LuopanBoard`（lazy）；派生失败（必需门：坐向行）→ null → PanView 回退静态表格（零回归路径）。ChartboardPanel 零改动承接（`panelReady('chartboard')` 判定 = 有 `::: pan` 容器）。
2. **派生层 `luopan-model.ts`（纯函数）**：卡内文本 → `LuopanModel`（坐 / 向 / 周天度数 / 宅卦 / 东西四宅 / 八宫吉与慎用 / 运盘 / 流年星级 / 九宫飞布 / 数据等级 / 声明条目）；口径纪律：一律取自工具输出文本，不重算、不预测（与四件套同纪律）。`splitDegrees`（坐向度数拆分）与 `LUOPAN_STAR_NAME` / `LUOPAN_STAR_NOTE` / `LUOPAN_GRID9`（共享常量）同文件导出。
3. **三环罗盘（静态 SVG 320×320，零依赖）**：外环二十四山（每山 15° 扇区 + 标签）/ 中环后天八卦（45° 扇区）/ 内层九宫格（正北在上：上排 西北·北·东北）；坐向指针（坐虚线 / 向实线；仅卡内有周天度数时绘制）；几何 `pt(deg, r)`（deg − 90 转屏幕角）+ `sector()` 环形扇区路径。
4. **双盘切换**：`bazhai`（八宅游年——九宫格显示游年星，吉 = 青绿 / 慎用 = 琥珀色带）/ `feixing`（流年飞星——星号名 一白…九紫；五黄走慎用色带）；**宫位详情条**（替代浮层——点击宫位下方展开「宫 · 方位 · 星 + 参考语」+ 「深入 / 依据核对」回填草稿；重复点击折叠）。
5. **合规色带与参考语**：吉 / 慎用双色（不出现红黑恐吓色）；参考语统一 `LUOPAN_STAR_NOTE`（「传统观点列为慎用方位（宜作辅助功能）」——与工具 / SKILL / 协议同口径）。
6. **九宫叠图 `GridOverlay`（§10.3 v1 修订）**：底图 = 会话内最近图片附件（session store 倒序找；无图 → 空态引导含「图纸需已标注 / 按北向上」前提）；SVG 网格叠图（`preserveAspectRatio="none"` 铺满底图——**格内不置文字**（防非正方形拉伸变形），宫位信息走 SVG `<title>`（宫 · 方位 · 星 + 参考语）；游年 / 飞星 mini 切换；格点击 → 回填草稿；**v1 不做旋转对齐**（固定正北在上，页面明示「偏转对齐列 v2」）——**替代方案**：叠图入口 = 盘卡第三 tab（**不设独立触发块**；文档原「叠图走查触发块」以 tab 入口替代，mock 触发块维持 2 组）。

## 理由

- 三环自绘与轮盘先例（NatalWheel）同构：静态 SVG + 常数几何 + 无动画依赖（jsdom 可测 / 无 canvas）；
- 双盘 tab 比并列双盘更适配窄容器（消息流宽度）；详情条比浮层在虚拟列表滚动下更稳定（无定位回退问题）；
- 叠图去文字 + SVG title：消除 `preserveAspectRatio="none"` 的文本拉伸，同时保留可访问信息。

## 被否决

- **格内文字**（叠图）：非正方形底图拉伸变形——否决；
- **旋转对齐滑条**：方位归属会随旋转变化（星号格需重排）——v1 固定正北、诚实前提声明，旋转对齐列 v2；
- **独立叠图触发块**：盘卡 tab 已是自然入口，独立触发块徒增语料面——否决（mock 触发块维持 M66-A 的 2 组）。

## 影响

- 客户端：`pan/luopan-model.ts`（派生）、`pan/LuopanBoard.tsx`（三环盘 + 双盘 + 详情 + AskBar）、`pan/GridOverlay.tsx`（叠图）、`pan/model.ts`（LuopanModel + PanKind + 联合）、`pan/derive.ts`（分派）、`pan/index.tsx`（lazy + 分派）、`remark-ext.ts`（PAN_KINDS / 徽标）、`index.css`（pn-lp-* 样式）；
- 测试：`tests/m66-luopan.test.tsx`（4 例：派生 / 八宅交互 / 双盘 + 叠图空态 / Markdown 端到端）；client 全量 1160/1160；
- E2E：`e2e/m66-fengshui.spec.ts`（堪舆走查 → 盘卡 → 八宅（伏位 / 慎用详情）→ 飞星（中宫一白）→ 叠图空态；1/1 通过 8.1s）；
- 顺带：`derive.ts` import 引入 `deriveLuopan`（pan/ 内依赖，无循环）。
