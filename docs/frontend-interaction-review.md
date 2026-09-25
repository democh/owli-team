# Owli Team 前端交互全量分析报告

> 分析范围：`client/src`（262 个 tsx / 约 5.5 万行），重点覆盖布局、消息流、输入区、命令面板、WS 通知、手势库、可访问性与移动端。分析日期：2026-09-22。

---

## 0. 总体结论

这套前端的交互工程质量**整体偏高**：消息流已用 `@tanstack/react-virtual` 虚拟化 + 订阅隔离（流式 delta 不触发列表重渲染）、WS 有指数退避 + 半开探活 + 降级轮询、重组件（xterm / React Flow / three / shiki）全部懒加载分包、`prefers-reduced-motion` 在多处落实、Pointer Events 手势库带 rAF 节流。

仍存在的优化空间按维度整理如下，每项标注【严重度】（🔴 高 / 🟡 中 / 🟢 低）与文件位置。

---

## 1. 消息流与渲染性能（ChatArea / MessageItem）

### 1.1 🔴 高频 selector 全量扫描：流式期间 O(n) × 每帧
`ChatArea.tsx` 中两个 zustand 选择器在**每次 store 更新**时都要遍历全部消息：

- `structureKey`（L225-232）：把所有消息的 `role~runId~turnIndex` 拼成一根长字符串。每次 store setState（包括流式 delta）都会执行，千条消息时每次构建数千字符的字符串并做字符串比较。
- `anyStreaming`（L329-334）：线性扫描 `order` 判断有无 `status === 'streaming'`。

流式 delta 约 40ms 一批，意味着这两个 O(n) 计算在长会话里每 40ms 跑一次。
**建议**：在 `session-store` 的 reducer 层维护 `streamingCount` 计数与结构指纹（追加消息时增量更新），selector 退化为 O(1) 读数。

### 1.2 🟡 onScroll 未做 rAF 节流
`onScroll`（L257-280）每个 scroll 事件都执行：阈值计算、`virtualizer.getVirtualItems()`、`setVp`/`setAtBottom`。React 对同值 setState 会 bail out，但 handler 本身（含虚拟列表查询）仍每事件跑。
**建议**：用 `requestAnimationFrame` 合帧（与 `use-drag.ts` 同款模式），或给容器加 `passive` 监听并节流 50ms。

### 1.3 🟢 aria-live 播报粒度
消息容器 `role="log" aria-live="polite"`（L489-491），流式期间单条消息内容虽经 150ms 节流，但对屏幕阅读器仍是每 150ms 一次的连续播报轰炸。
**建议**：流式期间把播报降级（如仅在消息 `status` 从 streaming → done 时播报一次），或用 `aria-live="off"` + 完成时手动 announce。

### 1.4 🟢 「回到最新」缺键盘路径
`jumpToBottom` 只有点击入口。建议补 `End` 键（焦点不在输入框时）或 ⌘↓ 直达底部。

---

## 2. 输入区（Composer，1037 行）

### 2.1 🔴 草稿每击键同步写 localStorage
L390-395：`value` 每次变化即 `localStorage.setItem`。同步写会阻塞主线程（尤其是长草稿），且多标签页打开同一会话时互相覆盖（无 `storage` 事件同步）。
**建议**：300–500ms 防抖落盘 + 监听 `storage` 事件做多端对账。

### 2.2 🔴 斜杠命令态按 Escape 清空**全部**输入
L685-689：slash 菜单打开时按 Esc 执行 `setValue('')`——用户只想关菜单却丢整条草稿，且无 undo。
**建议**：Esc 第一击只关菜单（恢复非命令态），第二击才清空；或清空后 toast 提供「撤销」。

### 2.3 🟡 提及菜单的 WAI-ARIA 不完整
候选容器有 `role="listbox"`，但条目是普通 `<button>`（非 `role="option"`），textarea 上没有 `aria-expanded` / `aria-controls` / `aria-activedescendant`，读屏用户无法感知上下键导航。
**建议**：条目改 `role="option" aria-selected`，textarea 加 combobox 语义三件套。

### 2.4 🟡 拖拽高亮闪烁风险
`onDragOver → setDragging(true)` / `onDragLeave → setDragging(false)`（L713-723）：当指针划过子元素边界时 dragleave/dragover 交替触发，蓝色高亮框会抖动。
**建议**：用 enter/leave 计数器（dragenter++ / dragleave--，归零才置 false），或判断 `e.relatedTarget` 是否仍在容器内。

### 2.5 🟡 附件错误提示逐文件弹 toast
`attachFiles` 对每个非法文件单独 `toast.error`，拖入 20 个超限文件会弹 20 条。
**建议**：聚合成一条「N 个文件被忽略：格式不支持 ×a / 超限 ×b」。

### 2.6 🟢 其他小项
- textarea 自适应上限 160px 后无展开/全屏编辑入口，长 prompt 编辑体验受限。
- 仅 Enter 发送，未提供 ⌘Enter 选项（部分用户习惯）；可作为设置项。
- 成员条横向滚动无渐变遮罩，「还有更多」不可感知。

---

## 3. 全局布局与导航（AppLayout / CommandPalette）

### 3.1 🔴 面板布局不持久化
`paneLayout` 用 `useRef` 存内存（L294），刷新后三栏比例全部回到默认。用户精心拖好的布局每次重开都丢。
**建议**：`onLayout` 防抖写 `localStorage`（或 zustand persist），启动时读取。

### 3.2 🟡 移动端视口高度 `h-screen`
窄屏分支用 `h-screen`（100vh，L499），iOS Safari 地址栏伸缩会导致底部成员条/输入区被遮或跳动。
**建议**：改用 `h-[100dvh]`（或 CSS `height: 100dvh` + `100vh` 兜底）。

### 3.3 🟡 分栏拖拽把手仅 1px 宽
`PanelResizeHandle` 是 `w-px`（L566/587），鼠标命中区域极窄，触屏几乎不可用。
**建议**：视觉 1px、命中区扩到 6–8px（负 margin + 透明 padding 热区）。

### 3.4 🟡 命令面板无背景遮罩
`Command.Dialog` 只有 fixed 容器（L163），没有半透明 backdrop：视觉层级弱，且用户可能误以为点击空白不会关闭（cmdk 底层 radix 实际会关）。
**建议**：补一层 `bg-black/20 backdrop-blur-[2px]` 遮罩。

### 3.5 🟡 命令面板会话列表无虚拟化 + 检索字段单一
`value={`session ${s.title}`}`：只能按标题匹配，不支持按 id / 最近消息 / 成员名检索；会话数大时一次性渲染全部 `Command.Item`。
**建议**：value 拼入成员名等别名；超 50 条时截断 + 「输入以细化」提示。

### 3.6 🟢 快捷键体系已较全（⌘K / ⌘B / ⌘⇧B / Alt+1..9 / ?），建议补：
- ⌘. 或 Esc 停止当前运行（高频救命操作目前要点按钮或 `/stop`）；
- ⌘↑/⌘↓ 在会话间切换（Alt+数字需记住序号）；
- 会话内搜索（目前只有跨会话 FTS，无 Ctrl+F 会话内过滤）。

### 3.7 🟢 缺「跳到主内容」skip-link
键盘用户每次都要 Tab 过整条 ActivityRail 和顶栏。加一个 `sr-only focus:not-sr-only` 的 skip-link 成本极低。

---

## 4. 会话列表与搜索（SessionList）

### 4.1 🟡 搜索命中跳转用固定 220ms setTimeout
`jumpTo`（L114-118）：切会话后硬编码 220ms 再 `focusMessage`。慢网/大会话下消息尚未加载，定位静默失败且无重试无提示。
**建议**：改为对 `loadingMessages === false && byId.has(messageId)` 做条件等待（轮询或 store 订阅），超时给 toast。

### 4.2 🟢 会话列表无虚拟化
几百个会话时一次性渲染全部行（含头像、预览、角标）。量级小时可忽略；预期会超 200 条则复用 react-virtual。

### 4.3 🟢 搜索仅防抖 250ms，无「无结果」以外的空态引导（如「试试搜索成员名」），搜索中无骨架——有 `searching` 状态但建议确认 UI 呈现。

---

## 5. 可访问性（a11y）

整体：883 处 `aria-*`/role/tabIndex/onKeyDown、221 处 aria-label，覆盖度不错；ui/button 有统一 focus-visible ring。**剩余短板**：

- 🔴 **无暗色主题**：全库未见 `dark:` 类或 `data-theme`。若设计即浅色-only 可忽略；否则这是最大的视觉可访问性缺口（暗光环境 / 光敏用户）。
- 🟡 **图标按钮依赖 `title` 而非 `aria-label`**：title 不是可靠的可访问名（触屏/读屏不稳定）。建议 ui/button 增加 `icon-sm` 时强制要求 aria-label 的 lint 约定。
- 🟡 大量自绘可点击图形（盘面、座位环、画布节点）虽多有 onKeyDown，但缺少整体键盘动线文档，建议用键盘走一遍核心任务（发消息→审批→停止）补断点。
- 🟢 toast（sonner）默认有 `role="status"`，确认 `toast.error` 用 alert 语义。

## 6. 移动端 / 窄屏

- ✅ <900px 三栏折叠为抽屉 + 底部成员条，入口齐全。
- 🟡 窄屏下 `BottomMemberBar` 成员多时要横向滑很久，无「全部成员」聚合入口。
- 🟡 LiveDock 悬浮窗 `defaultPos` 按桌面视口锚定右下，小屏下最小尺寸可能超过视口（`clampSize` 有视口上限 ✓，但 min 尺寸若大于小屏宽会矛盾——值得在 375px 宽实测一次）。
- 🟢 画布（React Flow）在窄屏仍可用，但节点上下文菜单等 hover 优先的交互需确认 touch 长按路径。

## 7. 连接与通知（ws / ws-store）——已很稳，两个小点

- 🟢 标题闪烁 interval 900ms 在后台标签页被浏览器节流为 ≥1s，行为略漂移但无害。
- 🟢 降级轮询仅在页面可见时跑 ✓；建议轮询响应携带 `Retry-After`/间隔字段已实现（NOTIFY_POLL_MS 由 health 下发 ✓）。

## 8. 构建与加载性能（vite.config）

- ✅ vendor 分包策略精细（md / shiki / three 独立 chunk），重组件全懒加载。
- 🟡 `chunkSizeWarningLimit: 1500` 偏宽松，可能掩盖主包膨胀；建议降到 800 并加 CI bundle size 报告。
- 🟢 建议给懒加载 chunk 加 `vitePrefetch`/hover 预取（如画布 Tab 悬停即预取 CanvasView chunk），把懒加载等待藏进交互间隙。

---

## 9. 优先级清单（Top 10）

| # | 严重度 | 事项 | 位置 |
|---|--------|------|------|
| 1 | 🔴 | 结构指纹/流式计数下沉到 reducer，消除每 40ms O(n) 扫描 | ChatArea.tsx L225/L329 |
| 2 | 🔴 | 草稿落盘防抖 + storage 事件多端同步 | Composer.tsx L390 |
| 3 | 🔴 | 斜杠菜单 Esc 不再一键清空全文 | Composer.tsx L685 |
| 4 | 🔴 | 三栏布局持久化到 localStorage | AppLayout.tsx L294 |
| 5 | 🟡 | 移动端 100dvh；分栏把手命中区 6-8px | AppLayout.tsx |
| 6 | 🟡 | 提及菜单补 combobox/option ARIA 语义 | Composer.tsx L747 |
| 7 | 🟡 | 搜索跳转改条件等待，替代固定 220ms | SessionList.tsx L114 |
| 8 | 🟡 | 命令面板加 backdrop + 会话检索别名 | CommandPalette.tsx L163 |
| 9 | 🟡 | 图标按钮 aria-label 全覆盖（lint 约束） | 全局 |
| 10 | 🟢 | ⌘. 停止运行 / ⌘↑↓ 切会话 / 会话内搜索 | AppLayout.tsx |


---

# 第二轮补充（全量深审，2026-09-22 22:55）

> 本轮补充审查：服务端消息加载链路、Overlay/灯箱、MessageItem 订阅粒度、命令面板剩余部分、auth/api 层、store 持久化。暗色主题按需求排除。

## 10. 数据加载链路

### 10.1 🔴 会话消息历史无分页（服务端 + 前端同因）
服务端 `server/src/store/sessions.ts:195` 是 `SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC` 全量拉取；前端 `session-store.ts selectSession`（L204-222）一次性 `set` 全部消息。长会话（数千条）切换时：大 JSON 传输 + `toStores` 全量建 Map + 虚拟列表总行数回填，期间只有「正在加载会话…」占位。
**建议**：服务端加 `?before=<seq>&limit=100` 游标分页，前端配合已有的虚拟列表做「上滑加载更早」（prepend 时用库的行高锚定补偿保持滚动位）。这是当前消息流体验最大的结构性短板。

### 10.2 🟡 api 层无请求超时
`lib/api.ts request()` 裸 fetch，无 `AbortSignal.timeout`。服务端挂起时 loading 态（会话加载、搜索、审批）永远转圈，用户只能刷新。
**建议**：`apiGet` 默认 20s 超时（`AbortSignal.timeout(20_000)`），超时错误文案区分「服务器无响应」。

### 10.3 🟢 apiUpload 进度回调高频 setState
XHR `onprogress` 每次触发都 `setTray(map 全数组)`。文件大时进度事件密集，每次都重建整个托盘数组。XHR 进度事件频率有限，影响轻微；如托盘条目变多可考虑 rAF 合帧。

## 11. 组件订阅粒度（二轮新发现）

### 11.1 🟡 MessageItem 订阅了 `sessions.find(...)` 整对象
`MessageItem.tsx:144`：每条消息都 `useSessionStore((s) => s.sessions.find((x) => x.id === s.currentId))`。而 `noteIncoming`（session-store L257-274）在**每条新消息到达当前会话时**都会重建该 session 对象 → 所有挂载的 MessageItem 全量重渲染一次（即使它们只用 session 做 `labelOfMemberKey`）。
**建议**：在 session-store 维护 `currentSession` 派生引用，或 selector 只取 `participantIds` 等真正消费的字段（zustand `useShallow`）。

### 11.2 🟢 renderCache 无会话切换清理
`md-cache.ts` LRU 200 常驻内存，跨会话累积。单条渲染结果不大，可接受；如内存敏感可在 `selectSession` 时按前缀清。

## 12. 弹层体系（Overlay / Lightbox / Dialog 混用）

### 12.1 🟡 自研 Overlay 缺焦点管理 + 滚动锁定有布局跳动
`md-ext/Overlay.tsx`：portal + Esc + 遮罩点击 ✓，但无焦点陷阱、无初始焦点（打开后 Tab 会跑到背景层）、`body.overflow=hidden` 不补偿滚动条宽度（页面右移 ~8px）。项目里 radix Dialog 已是依赖（SessionList 抽屉在用）。
**建议**：Overlay 整体替换为 radix `Dialog`（自带 focus trap / scroll lock / aria），或至少加 `padding-right: scrollbarWidth` 补偿与 `autoFocus`。

### 12.2 🟢 Lightbox 方向键监听挂在 window 且无输入态判断
`AttachmentLightbox.tsx` L29-37：灯箱打开时全局 ← → 被劫持（如在视频控制条、文本框里按方向键也会切图）。影响面小（灯箱是全屏模态），可接受；建议加 `e.target` 判断或只在图片 kind 时启用。

## 13. 命令面板（补完）

### 13.1 🟡 「@ 召唤成员」与「会话」组全量渲染
L486-503 对所有 agents、L176 对所有 sessions 无条件 map。agent/会话数量大时 cmdk 的过滤性能会下降（cmdk 内置过滤是 O(n) 每条渲染）。
**建议**：超过阈值（如 20 条）时只显示前 N 条 + 「继续输入以细化」占位项。

### 13.2 🟢 检索词无拼音支持
中文标题/成员名只能精确子串匹配（cmdk 默认）。如用户习惯拼音首字母检索，可给 value 拼接拼音首字母（pinyin-pro 离线生成一次）。

## 14. 会话切换体验

### 14.1 🟡 快速连切会话时加载态闪烁
`selectSession` 立即清空消息并显示 loading。Alt+1..9 快速连点时消息区在「空 → 转圈 → 内容」间闪烁；竞态守卫（`currentId !== id`）已正确处理结果覆盖 ✓。
**建议**：骨架屏延迟 ~150ms 出现（快会话直接无感），或保留旧消息置灰直到新数据就绪（stale-while-revalidate）。

### 14.2 🟢 快捷键帮助与实际快捷键的一致性
`ShortcutHelp.tsx` 与散落在 AppLayout/CanvasView/Composer 的快捷键是两处手工维护，存在漂移风险（如画布的 ⇧0/⇧1/⇧2、H/V 是否收录未逐一核对）。
**建议**：快捷键定义收敛为一张声明式表（keys + description + handler），帮助面板与监听都从该表生成。

## 15. 安全与账号

### 15.1 🟢 Cookie 认证（非 localStorage token）✓
auth 走种 cookie 模式（auth-store L6），无 XSS 窃取 token 风险，优于多数同类项目。建议确认服务端 cookie 带 `SameSite=Lax + HttpOnly + Secure`（生产 HTTPS）。

### 15.2 🟢 401 全局翻转登录页 ✓（api.ts L38），但翻转后原操作静默失败——建议登录恢复后 toast 提示「请重试刚才的操作」。

## 16. 二轮优先级清单（增量 Top 6）

| # | 严重度 | 事项 | 位置 |
|---|--------|------|------|
| 1 | 🔴 | 消息历史游标分页（服务端 + 前端 prepend） | store/sessions.ts:195 · session-store.ts:204 |
| 2 | 🟡 | api 层默认超时（防 loading 永转） | lib/api.ts |
| 3 | 🟡 | MessageItem 改订阅派生字段，消除新消息全量重渲染 | MessageItem.tsx:144 |
| 4 | 🟡 | Overlay 换 radix Dialog（焦点陷阱 + 滚动条补偿） | md-ext/Overlay.tsx |
| 5 | 🟡 | 会话切换 stale-while-revalidate / 延迟骨架 | session-store.ts:204 |
| 6 | 🟡 | 快捷键声明式收敛（帮助面板与监听同源） | 全局 |

## 17. 全量结论（两轮合并）

两轮共记录 **30 项**：🔴 5、🟡 16、🟢 9。
最重要的两条结构性建议：
1. **消息历史分页**（10.1）——当前唯一会随使用时间线性劣化的体验瓶颈；
2. **store 订阅粒度收敛**（1.1 + 11.1）——把 O(n) selector 和宽订阅下沉为增量维护的派生数据，是流式高频更新场景下最值得做的性能工程。
其余多为局部打磨（焦点管理、防抖、命中区、快捷键补全），可纳入日常迭代逐项消化。


---

# 第三轮补充（全量复审 + agent 协作交互专项，2026-09-22 22:57）

> 本轮重点：团队协作链路（TeamPanel 成员/接力/战绩、接力队列、审批、场景舞台、头像体系），并给出 agent 面板的设计优化提案。前两轮结论不重复。

## 18. 协作面板性能（本轮最重要发现）

### 18.1 🔴 流式期间整个右栏团队面板每 40ms 全量重算
链路：`session-store.upsertMessage`（L282-286）每个流式 delta 都 `new Map(s.byId)` → TeamPanel L1134 `messages = useMemo(messagesOf, [byId, order])` 依赖 byId 引用 → **每个 delta 重建全量消息数组** → `MembersView` 的 `stats`（遍历全部消息统计发言/交付，L308-319）、`StatsView`、`RelayView` 的 `steps` 全部重算重渲染。

即：用户看着流式输出时，右栏面板以 25 次/秒做 O(消息总数) 的统计计算。消息越多越卡，且与 1.1（ChatArea selector）是同根问题。
**建议**（按优先级）：
1. `MembersView`/`StatsView` 的统计下沉到 store：upsertMessage 时增量维护 `sessionStats: Map<memberKey, {speaks, artifacts}>`（O(1) 每条），面板直接读；
2. 或最小改动：面板统计基于「冻结口径」（流式期间用上一次的 messages 快照，run 结束后刷新一次）——场景舞台的容器面已是这个模式（ADR 0129 冻结口径），团队面板应对齐。

### 18.2 🟡 MiniDossier / RelayCard / RelayChain / RelayQueue 均重复 `sessions.find(currentId)`
同 11.1（MessageItem）——每个组件各自订阅 sessions 数组并 find。新消息到达当前会话时这些组件全部重渲染。
**建议**：session-store 提供 `useCurrentSession()` 派生 hook（内部 selector 返回缓存引用），全局替换 10+ 处 `s.sessions.find(x => x.id === s.currentId)`。

### 18.3 🟢 RelayChain / RelayQueue 内 `agents.find` 嵌套循环
队列节点逐个 `agents.find(baseAgentId)`，O(队列×agents)。量小无感；如顺手可在 agent-store 建 `Map<id, agent>` 索引统一替换（全局有 30+ 处 `agents.find`）。

## 19. 接力与队列交互

### 19.1 🟡 队列调序只有 ↑↓ 一位一位挪
`RelayQueue` 的 move(i, ±1) 点箭头换位。把第 5 位提到第 1 位要点 4 次，且每次都触发服务端 reorder 广播。
**建议**：chips 支持拖拽调序（HTML5 DnD 或 Pointer 手势，复用 use-drag 的模式），松手一次提交；或在 title 提示外补「置顶」按钮（高频操作一键完成）。

### 19.2 🟢 接力卡无键盘可达性
RelayCard 是 `<button>` ✓ 可聚焦；但接力链节点是纯 `<span title>`，键盘用户拿不到「已出手/排队中」状态。建议改 `<span role="img" aria-label>` 或可视文本。

## 20. 审批与计划（协作卡点）

### 20.1 🟡 审批挂起缺「叫人」通道
ApprovalPanel 快捷键（⌘Enter 批准 / ⌘Backspace 拒绝，capture 拦截 Composer ✓）做得很好。但审批挂起时 run 整体停摆，若用户切走标签页/离开座位，没有任何强提醒——ws-store 的通知管道（toast/标题闪烁/系统通知）覆盖的是消息类事件，审批是否接入未在客户端代码中体现。
**建议**：确认服务端审批请求是否走 notify 通道；若无，挂起审批时应触发未读角标 + 标题闪烁（复用 syncBadge），这是协作链路上唯一会「永久挂起等人」的状态，值得最高级别提醒。

### 20.2 🟢 多张审批卡时只有首张有快捷键
设计合理（避免误批），但建议在后续卡片上加视觉提示「批准后下一张自动获得快捷键」，降低疑惑。

## 21. 头像与身份体系

### 21.1 🟡 AgentAvatar 图片无懒加载
`<img src>` 无 `loading="lazy"`，无 srcSet。Agent 名录页（#/agents）与成员条一次渲染几十张头像图，首屏带宽与解码压力大。
**建议**：`loading="lazy" decoding="async"`，服务端出 64/128px 缩略图规格。

### 21.2 🟢 头像状态角标系统（thinking 省略号 / done 星星 / error 闪电）表达力好，但 error 状态没有恢复路径提示（点哪重来）。建议 error 头像角标可点击 → 定位到出错消息。

## 22. Agent 面板设计优化提案（设计向）

现状梳理：agent 状态在**五个位置**各自表达——① TeamPanel 成员卡状态点 ② Composer 成员条状态点+排队序号 ③ 接力链头像圈 ④ 头像角标（省略号/星星/闪电）⑤ 场景席位（SeatRing/SeatCard）。五套视觉语言相近但各自实现。

### 提案 A：统一 `AgentPresence` 组件（一致性 + 可维护性）
把「状态点 + 排队位次 + 发言动画」收敛为一个受尺寸/详略参数控制的组件（`<AgentPresence member={key} detail="full|dot|ring" />`），五处全部替换。收益：状态语义改一处全局生效（例如未来加「等待审批」态）；消除五处样式漂移风险。

### 提案 B：成员卡信息分层（减噪）
MemberCard 次行 chips（灵魂/能力+3/技能/工具数/战绩/计划徽章）在窄栏下最多可叠 8+ 个 chip，视觉噪音高。建议：
- 默认只显示「状态行 + 计划徽章 + 战绩」，能力/技能/工具收进 MiniDossier（点开即见）；
- 或做「密度开关」（紧凑/详细），用户自选。

### 提案 C：接力链 → 「当前回合沙盘」
接力链已是好的进度载体，可升级为交互中枢：点击链上排队节点 = 调序菜单（提前/延后/移出队列），点击已出手节点 = 定位消息（现已有），长按/右键 = 换灵魂/拍一拍。把散在成员卡、Composer、接力视图的操作收口到一条链上。

### 提案 D：运行状态的环境感知（ambient）
「下一棒热身」在消息流底部有提示 ✓，但用户滚动到历史消息时不可见。建议：运行中时窗口标题/顶栏品牌区加极简动态（如「3/5 · 卢娜发言中」轮换），配合已有的 favicon 角标体系，实现「不盯着也能感知进度」。

### 提案 E：空编制/冷启动引导统一
当前空态引导分散在 ChatArea（议程 chips）、Composer 成员条、RelayView 空态三处文案。建议抽 `useSessionOnboarding(session)` 统一决策树：零编制 → 描述需求；有编制无消息 → 推荐开场；有消息无运行 → 继续接力，三处共用。

### 提案 F：战绩榜的「回看入口」
StatsView 有排行/成就/彩纸；建议每行加「TA 的高光时刻」——直接跳该成员本场评分最高的消息（复用 focusMessage），把榜单从「看数」变成「看戏」。

## 23. 三轮优先级清单（增量 Top 5）

| # | 严重度 | 事项 | 位置 |
|---|--------|------|------|
| 1 | 🔴 | 右栏统计改增量/冻结口径，消除流式期 25 次/秒全量重算 | TeamPanel.tsx:1134 |
| 2 | 🟡 | `useCurrentSession()` 派生 hook 全局替换 find 订阅 | 全局 10+ 处 |
| 3 | 🟡 | 审批挂起接入未读/标题闪烁提醒通道 | ws-store + ApprovalPanel |
| 4 | 🟡 | 队列拖拽调序 / 一键置顶 | TeamPanel RelayQueue |
| 5 | 🟡 | AgentAvatar `loading="lazy"` + 缩略图规格 | AgentAvatar.tsx |

## 24. 三轮总计

累计 **35 项**（🔴 6 / 🟡 21 / 🟢 8）+ 6 个设计提案（A–F）。
全局根因归纳：性能问题 80% 指向同一处——**zustand store 的派生数据没有随写入增量维护，靠渲染层 selector 全量重算**。把 session-store 升级为「写入时增量维护派生表」（streamingCount / structureKey / sessionStats / currentSession 引用），1.1、11.1、18.1、18.2 四项一次性解决，是本项目最高杠杆的一次重构。


---

# 实施记录（2026-09-22 23:20）：store 增量派生重构 ✅ 已落地

最高杠杆项「zustand 派生数据下沉」已实现并验证，一次性解决报告中的 1.1 / 11.1 / 18.1 / 18.2 四项。

## 改动内容

**`client/src/stores/session-store.ts`（核心）**
- 新增写入时增量维护的派生字段：
  - `structureKey`（结构指纹，仅结构变化时替换引用）——替代 ChatArea 每 40ms O(n) 拼接；
  - `streamingCount`（流式计数，upsert/patch/remove 状态跃迁 ±1）——替代 ChatArea 全量扫描；
  - `sessionStats`（成员键 → 发言/交付数，插入计数 + artifacts 差分）——替代 MembersView 每 delta 遍历全部消息；
  - `completedTick`（非流式写时钟）——右栏「冻结口径」刷新信号，对齐场景舞台 ADR 0129；
  - `current`（当前会话引用稳定投影，忽略 lastMessage/unreadCount 易变字段）+ `useCurrentSession()` hook。
- `subscribe` 对账兜底：直接 setState（测试/调试路径）也能保持 `current` 同步，引用一致时天然终止。

**渲染层替换（21 个文件、32 处订阅点）**
- ChatArea：structureKey / anyStreaming / session 三处 O(n) selector → O(1) 直读；
- TeamPanel：根部不再订阅 byId（原每个流式 delta 重渲染整个右栏），消息派生改为 completedTick 冻结口径；成员统计改读 sessionStats；
- MessageItem / Composer / WaveGroup / WaveStrip / MessageRail / PlanReviewCard / MessageActions / ApprovalPanel / SceneStage / GraphView / TaskView / MemoryPanel / SchedulePanel / CanvasView / CanvasComposer / GenerationPanel / BrowserPanel / DockBrowserView / AppLayout / CommandPalette：`sessions.find(x => x.id === currentId)` → `useCurrentSession()` 或 `s.current?.role`。

## 验证

- `tsc --noEmit`：通过；
- `eslint client/src --quiet`：通过（0 问题）；
- `vitest run`：**118 个测试文件 / 1334 个用例全部通过**（中途发现 26 个失败——测试直接 setState 绕过 action 导致 `current` 未同步，已由 subscribe 对账兜底修复）。

## 效果

- 流式输出期间：ChatArea 零 O(n) 计算；右栏团队面板零重渲染（原 ~25 次/秒全量统计）；所有 current 订阅方在跨会话预览刷屏时零重渲染。
- 行为语义不变：统计口径（插入即计数）、结构键格式、viewer gating 均与原实现一致。


---

# 实施记录 ②（2026-09-22 23:35）：剩余 🔴 体验项修复 ✅

报告第一轮 4 项 🔴 已全部清零（store 重构见上一条实施记录）。

## 本轮改动

1. **草稿防抖落盘 + 多标签同步**（Composer，报告 2.1）
   - 每击键同步写 → 400ms 防抖；卸载/切会话前补写，防抖窗口内内容不丢；
   - 新增 `storage` 事件监听：其他标签页修改同一会话草稿时跟随；输入框聚焦时不覆盖，避免打断打字。
2. **斜杠菜单 Esc 不再清空全文**（Composer，报告 2.2）
   - Esc 改为仅关闭命令菜单（`slashDismissed`），重新输入即恢复；切会话时复位。原行为是 Esc 直接 `setValue('')`，误丢整条草稿。
3. **三栏布局持久化**（AppLayout，报告 3.1）
   - `paneLayout` 从内存 ref 升级为 localStorage（`ma:panel-layout:v1`）：启动读取校验（3 元素正数数组），拖动高频 onLayout 防抖 500ms 落盘，卸载兜底补写；两栏折叠态的换算结果同样持久化。刷新后三栏比例原位恢复。

## 顺带修复（并发 WIP 兼容）

工作树中存在另一路进行中的「空间（Space）」功能改动（space-store / CreateSessionDialog 空间归属）。
其 `createSession` 第 4 参无条件携带 `currentId`，导致默认空间下 POST body 多出 `spaceId: 'default'`，
与自身注释（「default 之外的才随行」）不符并打挂 10 个既有测试。已按注释口径修正为
`spaceId === DEFAULT_SPACE_ID ? undefined : spaceId`（CreateSessionDialog.tsx L214-222）。

## 验证

- `tsc --noEmit`：通过；
- `vitest run`：**118 文件 / 1334 用例全部通过**（中途 3 个用例在全量高负载下出现时序性失败，单独/分组/复跑全量均通过，确认为 flaky 而非回归）。


---

# 实施记录 ③（2026-09-22 23:55）：消息历史分页 ✅（报告 10.1，最后一条 🔴）

## 服务端（`server/src/routes/sessions.ts`）
- `GET /api/sessions/:id?limit=N&before=<seq>`：返回最近 N 条 / 该 seq 之前的更早一页（limit ≤ 500）；
- 分页响应附 `hasMore` / `totalCount` / `memberStats`（**全量口径**成员战绩——前端只加载最近一页，统计不能缺）；
- 缺省不带参数 = 全量返回，既有客户端/测试锚点零变化（兼容模式）。

## 客户端
- `session-store`：首载 `?limit=100`；新增 `hasMore` / `totalCount` / `loadingEarlier` / `loadEarlier()`（seq 游标前翻 + 切会话竞态守卫）；`refreshMessages` 保持全量重拉（补偿场景权威口径）。
- `ChatArea`：
  - 滑近顶部（<100px）自动加载更早一页，`useLayoutEffect` 按 scrollHeight 差值补偿滚动锚点（视口不跳），并废除贴底回声锚点防误判；
  - 顶部哨兵行（「上滑加载更早的消息」/ 加载中 spinner）；
  - 标题栏消息计数取 `max(已加载, totalCount)`；
  - `focusMessage` 分页回退：目标在未加载历史时逐页前翻直到命中或穷尽（每个定位请求至多一轮，防死循环）。

## 验证
- 新增契约测试 `server/tests/message-pagination.test.ts`（3 用例：分页字段 + 游标前翻穷尽 + 缺省全量兼容）✅；
- 服务端：1449/1453 通过（仅剩 m21 的 4 个硬编码资产计数断言被并发 WIP 新增角色/预设打破，与分页无关）；
- 客户端：1334/1334 通过；两侧 `tsc --noEmit` 均通过。

## ⚠️ 并发工作区冲突备忘（需要用户决策）
本轮期间检测到另一路并发改动反复重写工作树（Space 空间 / M80 表情回应 / 已读回执 / voice 人格等 WIP）。
**此前已验证全绿的「store 增量派生重构 + Composer 草稿防抖/Esc 修复 + 三栏布局持久化」被stash 收起**，
当前完整保存在 `git stash@{0}`（基于 00fa1a8，与 Space WIP 混合）。当前树上的分页功能不依赖该重构，可独立成立。
建议人工决策：等并发 WIP 落定后，从 stash@{0} 中拣出那批文件恢复（注意 stash 里同时混有当时的 Space WIP 旧版，需按文件拣选，避免覆盖新版）。
另外本轮顺手修复了并发 WIP 引入的两处既有测试破坏（非我的改动）：
- CreateSessionDialog / CommandPalette：`spaceId` 默认空间随行入 body（与其注释口径矛盾），改为 default 不入参；
- tests/m9.test.tsx：共享 Response 实例被新的 /api/spaces 挂载请求抢先消费（body 只能读一次），改为按调用新建 + 按路径分流。


---

# 实施记录 ④（2026-09-23 06:30）：stash 重构安全拣回 ✅

并发 WIP（Space 空间 / M80 表情回应 / 已读回执 / voice 人格 / P2 handoff 升格）已提交落定
（HEAD = 1c68714）。以「当前树为准、逐文件重放我的改动」的方式完成三方合并，
未使用 stash pop（避免旧版 Space WIP 覆盖新版）：

- `session-store.ts`：重写为「增量派生重构 + 消息分页 + M80-C 已读回执 + spaceId」四方合一版本
  （loadEarlier 前插时同步维护结构指纹 token 序列；分页首载以服务端 memberStats 全量口径为战绩底数）；
- 21 个组件文件的 `sessions.find(x => x.id === currentId)` 订阅 → `useCurrentSession()` / `s.current?.role`
  （脚本批量 + 特例手工；修正了批量脚本产生的导入路径深度问题）；
- Composer：草稿 400ms 防抖落盘 + 卸载补写 + 多标签 storage 同步 + 斜杠菜单 Esc 只关菜单（与 emoji 选择器 WIP 并存无冲突）；
- AppLayout：三栏比例 localStorage 持久化（防抖 500ms + 卸载补写）；
- TeamPanel：右栏冻结口径（completedTick）+ 战绩读 sessionStats。

验证：`tsc --noEmit` 通过、`eslint` 0 问题、客户端 **119 文件 / 1337 用例全部通过**。

至此报告全部 6 项 🔴 均已落地：store 增量派生（1.1/11.1/18.1/18.2）、草稿防抖（2.1）、
斜杠 Esc（2.2）、三栏持久化（3.1）、消息分页（10.1）。

`git stash@{0}` 仍保留（含当时的旧版 WIP 快照），确认无遗失后可由用户手动 `git stash drop`。
