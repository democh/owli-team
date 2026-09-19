# ADR 0167：设计容器族与工作台联动——layout / styleboard / render · 打开通道 · 快照入库 · 打印视图（M65-C）

- 状态：Accepted
- 引入：M65 批三（2026-09-19）
- 相关：docs/design-studio-design.md（§8 容器族 / §7.7 打印视图）· ADR 0064 / 0118（回填纪律）· ADR 0144（单一解析实现）· ADR 0159（3D 工作台与 DesignScene）· [client/src/components/chat/md-ext/](../../client/src/components/chat/md-ext/) · [client/src/lib/ds-templates.ts](../../client/src/lib/ds-templates.ts)

## 背景

M65-A 落了 interior 资产与面板骨架、M65-B 落了 3D 基座与场景契约。M65-C 补齐「对话产设计 → 工作台消费 → 成果回消息」的交互闭环：① 设计三容器族（layout / styleboard / render）解析与卡片；② layout 卡 → 3D 工作台的打开通道；③ 快照存工作区与「送图生图」回填；④ 方案书打印视图（§7.7）；⑤ E2E 全链。

## 决策

1. **三容器族（单一解析实现，ADR 0144 纪律）**：`::: layout 方案名`（房间三段 `- 房间 | 面积 | 要点` + 「方案源：」行 → data-items / data-source）；`::: styleboard 主题`（色卡三段 `- 名称 | #hex | 用途` + 「质感：」行 → data-items / data-texture）；`::: render 标题`（`- 键 | 值` → data-items，复用 finalizeItemRows）。**懒续行剥离**：标记行可能被 CommonMark 并入列表末项——解析侧从条目字段剥离（layout「方案源」/ styleboard「质感」均已容错，含空行与无空行两种写法）。
2. **卡片交互（v57 五模式）**：布局卡（房间表 + 方案源 chip + 「在 3D 工作台打开」+ 房间行回填调整草稿 + 复制清单）/ 风格板卡（色块 + 非法色值降级 + 色值点击复制 + 「按此板调整方案」）/ 效果图卡（产物图经 artifactContentUrl + 元信息 + 「再生成一版」seed 提取）；全部流式禁用、只写草稿；解析失败 children 兜底（fail-safe）。
3. **打开通道（跨组件信号）**：`STUDIO_OPEN_EVENT`（`ma:studio:open`）——layout 卡 emit 方案源路径 → StudioPanel 监听并入方案列表并选中（先例 LIGHTS_EVENT；否决新增全局 store 字段——生命周期清理成本）。
4. **快照入库与图生图回填**：快照 = 下载（离线兜底）+ canvas/media 上传通道入库（失败降级仅下载）；入库后「送图生图」可用（`tplSnapshotToRender`，风格词取自最近 styleboard 容器）。复用 media/upload 而非新开二进制端点：design-scenes 仅 JSON；媒体通道白名单 / 配额 / 广播全套已有。
5. **回填模板库**：`lib/ds-templates`（5 纯函数 + seed 提取）——卡片与工作台共用。
6. **方案书打印视图（§7.7）**：StudioPrintSheet 覆层（封面 / 平面图 / 房间表 / 效果图 / 风格板 / 页脚声明）+ `@media print` 仅保留 sheet + `@page` 边距；数据由 StudioPanel 从 containers 只读派生（冻结口径）。
7. **E2E 写法定式（M65-C 教训）**：虚拟列表 + 「上滑不打断」语义下，**等待底部新卡必须轮询点「N 条新消息 / 回到最新」浮标**（视口外元素不挂载，直接 toBeVisible 会假失败）；跨 run 等待用目标卡（而非「你的回合」胶囊——旧胶囊会立即命中）；全链多条 run 的用例需 `test.setTimeout` 放宽。spec 已入 `testMatch` 白名单（`m65-.*`）。

## 理由

- 容器名选用英文短名（layout / styleboard / render）：与既有族（pan / offer / claim / idea…）零冲突，语义直白。
- 三容器全部「先条目后字段」的双通道解析（data-items + 标记行字段）：与 pan / offer 先例同构，React 侧解析函数各自独立导出（同组件测试复用）。
- 打开通道与回填全部遵守既有纪律：跨面板轻量解耦（CustomEvent）+ 只写草稿（ADR 0064 / 0118）+ 冻结快照（ADR 0114）。

## 被否决与边界

- **打开通道走 ui-store 全局字段**：面板树外生命周期清理成本高，CustomEvent 先例充分；
- **快照新开二进制写端点（design/ 前缀）**：与 media 通道职责重叠，且 design-scenes 的 JSON-only 白名单更收敛；v2 若需 design/ 素材可另行评估；
- **完整 PDF 管道**：已于设计评审落档否决（§15.2），打印视图为零依赖方案；
- **E2E 直接断言 styleboard 卡四类选择器等待**：受虚拟列表挂载语义限制——统一走 jumpToLatest 轮询（定式入列）。

## 影响

- 前端：remark-ext（三 builder + finalizeLayout / finalizeStyleboard + 懒续行剥离）、Markdown.tsx（props + 三分派）、LayoutCard / StyleBoardCard / RenderCard、studio-open、ds-templates、StudioPrintSheet、StudioPanel（打开监听 / 快照入库 / 送图生图 / 打印）、index.css（三卡 + 打印段 + @page）；
- 服务端：mock.ts 修正「【用户】前缀匹配」（外部 M77 引入的前导空格致**全部触发块失效**——修正并注释留痕）；
- 测试：client m65-cards（8 例）/ 面板打印（1 例）/ E2E `m65-studio`（1 例全链，24s 绿）；client 全量 1107 全绿。
