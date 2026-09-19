# ADR 0138：画布交互深化与效果优化——能力门控 + 专业无限画布手感（M31 修订）

- 状态：Accepted
- 引入：画布 UX 批（2026-09-19）
- 相关：[docs/canvas-ux-design.md](../canvas-ux-design.md)（详细设计 · 对标分析 · 门控矩阵 · 被否决项）、[design.md §49.4](../design.md)、ADR 0059（画布内核与媒体工作台）、ADR 0061（画布输入平权 / MiniMap 移除）、ADR 0093（点击 / 拖动 / 选中交互修订）、ADR 0124（媒体连接全局化）、[client/src/components/canvas/CanvasView.tsx](../../client/src/components/canvas/CanvasView.tsx)、[client/src/components/canvas/useMediaCapabilities.ts](../../client/src/components/canvas/useMediaCapabilities.ts)

## 背景

- 用户诉求（原话）：「着重针对画布相关做优化……如果没有配置多模态 / 生图 / 生视频则不展示对应的效果；设计符合画布场景下的交互；画布要有相关的效果；学习专业无限画布模式的软件进行详细设计」；
- 三项落差：① **能力门控缺失**——未配置媒体连接时，工具栏「媒体生成」、右键「生成变体 / 设为首尾帧」、空画布「创作台 / 分镜台」模板、图片 / 视频节点空态生成话术全部照常展示（点了才被引导去设置）；② **导航手感非专业范式**——滚轮 = 缩放（Figma / tldraw / Excalidraw 均为滚轮 = 平移、⌘ 滚轮 = 缩放），缺手型工具（H）、缩放百分比指示器、缩放到选区、网格吸附；③ **反馈层次薄**——拖拽节点无抬升、框选框未主题化、选中节点与相连边无联动、平移无光标状态；
- 对标结论（详表见 canvas-ux-design.md §2）：本画布已有差异化优势（双击空白创建 / 智能对齐参考线 / 画框收纳 / 脑图 Tab·Enter 手感）应保留；需补齐「导航范式」与「反馈层次」两类通用能力。

## 决策

1. **能力门控（消费面门控、配置面常驻）**：
   - `media-store` 增 `providersLoaded` 与 `ensureProviders()`（幂等 + 并发去重）；`CanvasView` 挂载即 `ensureProviders()`；「设置 → 媒体生成」保存 / 启停 / 删除后 `refreshProviders()` 即时同步；
   - 派生 hook `useMediaCapabilities()`：`canImage`（text2image / image2image）/ `canVideo`（三种视频能力）**按能力拆分**；`providersLoaded=false` 按无能力渲染（杜绝门控元素闪现）；
   - 门控面：工具栏「媒体生成」按钮（canGenerate）、右键生成段（「用作生成输入」canGenerate /「生成变体」canImage /「首尾帧」canVideo；全隐时整段含分隔线不渲染）、空画布模板（创作台 canImage / 分镜台 canVideo；脑图工坊 / 素材墙恒显）、创建菜单提示词 hint（降级「记录可复用的指令」）、图片 / 视频节点空态文案（降级「拖入…或从交付件送上画布」）；
   - 生成面板与 Agent 工具（media_generate / media_video）既有最小权限引导不变（兜底路径）。
2. **导航手感（Figma 范式）**：`panOnScroll`（滚轮 / 双指 = 平移，speed 0.8）+ `zoomActivationKeyCode` 平台默认（⌘/Ctrl + 滚轮 = 缩放）；select 模式 `panOnDrag=[1]`（中键）+ 左键框选不变；**H / V / Esc 工具切换**（hand 模式 panOnDrag=true、cursor grab；会话内瞬时态不持久化）；Space 按住临时平移 + grab 光标（含 window blur 防卡死）；
3. **缩放指示器（右下角 pill）**：`useViewport` 实时百分比 +「− / +」步进 + 菜单「缩放到 100% / 适应视野 / 缩放到选区」（无选区禁用）；窄屏（<768px）隐藏让位底部指令条；
4. **快捷键 ⇧0 / ⇧1 / ⇧2**（100% / 适应视野 / 缩放到选区）：**不采用 ⌘0 / ⌘1**——浏览器保留键不可拦截（与项目「Alt+1..9 切换会话」同一避让纪律）；按 `e.code`（Digit0/1/2）判定不受 ⇧ 符号映射影响；`FIT_MAX_ZOOM` / `FIT_VIEW_PADDING` 上收 `lib/canvas.ts` 与指示器共用；
5. **网格吸附开关**（整理与对齐下拉）：「对齐网格 10px」= React Flow `snapToGrid` + `snapGrid=[10,10]`；与智能参考线**互斥**（onNodesChange 内经 gridSnapRef 判定）；会话内工具态，不落文档 / 设置；
6. **效果与反馈**：选中节点 **关联边高亮**（受控边 data.related 视图层派生——toFlowEdges 随选中集计算、sameFlowEdge 比较 related、FlowEdge 渲染增强：flow 加粗至选中级 / 其余提亮 + stroke 过渡）；拖拽节点**抬升**（`.react-flow__node.dragging .canvas-node-pop`：独立 `scale: 1.02` 属性——**不用 transform**，避开 `.canvas-node-pop` 入场动画的 transform 填充覆盖，同图谱 graph-node-card 技法）+ z-index 置顶；框选框与 Controls 走 **React Flow 主题变量**（`--xy-selection-*` / `--xy-controls-*`，作用于新 `.canvas-stage` 容器类）；pane 光标 grab/grabbing（RF draggable/dragging class + `canvas-space-pan` / `canvas-hand-mode` 补丁）；快捷键帮助新增「画布」分组。

## 理由

- **未配置即不出现**是「最小权限 + 引导不打扰」在消费面的正确形态：设置页是唯一配置入口（常驻），画布不再用生成话术占位；能力拆分让「只配了生图」的用户看不到视频入口，避免点开后被拒；
- **滚轮平移**是触摸板时代的主流范式（Figma / tldraw / Excalidraw 一致），⌘ 滚轮缩放保留鼠标用户习惯；双手通道（中键 / Space / H）覆盖各类习惯；
- **⇧0/⇧1/⇧2** 与 Figma 精确对齐且全部可在浏览器中拦截，不产生「按了没反应」的既视感；
- 效果全部为**过渡或复用既有 keyframes**（无新增持续动画，quiet-mode 清单零增量），受控重建纪律（ADR 0093：measured / selected / 引用复用）零破坏——related 标记只进视图层 data，不落画布文档。

## 被否决的方案

- **恢复小地图**：M36 / ADR 0061 已决策移除（画布即全景），复议无新证据；
- **滚轮 = 缩放（Miro 式）**：与主流范式相悖（详见 canvas-ux-design.md §6）；
- **⌘0 / ⌘1 快捷键**：Chrome 保留键无法拦截（切标签 / 页面缩放），会与浏览器行为打架；
- **⌥ 拖拽复制（Figma）**：需在拖拽生命周期接管 altKey，与受控回写叠加风险高，收益中等——延后；
- **onlyRenderVisibleElements（视口裁剪）**：当前节点量级收益小，与受控重建 + measured 抖动风险不成比例（ADR 0093 纪律）——延后（大画布档位预留）；
- **拖拽抬升用 transform: scale**：被 `.canvas-node-pop` 入场动画的 fill 覆盖（动画值优先于普通声明），改用独立 scale 属性；
- **门控用「禁用 + 引导」替代「隐藏」**：用户明确要求「不展示对应的效果」，禁用态仍是视觉噪音；
- **门控判定放组件内各自读 providers**：闪现代价与判定漂移风险；统一走 `useMediaCapabilities` + `providersLoaded` 语义。

## 影响

- 前端：`canvas/useMediaCapabilities.ts`（新）、`canvas/CanvasZoomIndicator.tsx`（新）、`CanvasView.tsx`（panOnScroll / 手型 / 网格 / 快捷键 / related / ensureProviders）、`CanvasToolbar.tsx`（手型钮 / 网格开关 / 生成钮门控）、`CanvasCreateMenu.tsx` / `NodeContextMenu.tsx` / `EmptyCanvas.tsx` / `nodes/{Image,Video}Node.tsx`（门控）、`edges/FlowEdge.tsx`（related）、`stores/media-store.ts`（providersLoaded / ensureProviders / 切会话保留 providers）、`settings/MediaConnectionsSection.tsx`（变更同步）、`layout/ShortcutHelp.tsx`（画布组）、`index.css`（canvas-stage 质感段）、`lib/canvas.ts`（FIT_* 常量上收）；
- 测试：`client/tests/m31-canvas-ux.test.tsx`（11：门控四组件 + 工具开关 + 生成入口注入）、`m31-canvas.test.tsx`（EmptyCanvas 门控口径改 +3）；E2E `e2e/m31-canvas-ux.spec.ts`（4：未配置隐藏 / 配置后出现并清理 / 缩放指示器与快捷键 / 滚轮·手型手感）；
- 文档：本 ADR、`docs/canvas-ux-design.md`（详细设计）、`design.md §49.4` 修订注记、`docs/adr/README.md` 索引；
- 服务端 / 画布文档契约：零变更（门控全部为前端消费面派生）。

## 适用与失效条件

- 适用：全部会话的画布视图（主区「画布」Tab）；协作图谱（GraphView）不适用（其交互语义与画布不同，滚轮缩放为其既定验收）；
- 失效条件：若媒体能力矩阵扩展（如音频生成 / 3D），门控矩阵与 `useMediaCapabilities` 需同步扩展；若引入多画布 / 全局素材库，门控判定源不变（providers 已全局化）；
- 已知边界：网格吸附与智能参考线互斥（不做叠加）；手型 / 网格为会话内瞬时态（切 Tab 重置为默认选择工具 + 参考线）；⌘ 滚轮缩放依赖浏览器修饰键事件（触控板捏合原生支持）。
