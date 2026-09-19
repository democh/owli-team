# ADR 0100：右栏实况面板合并与主区收敛（M49）

- 状态：Accepted
- 引入：M49
- 相关：[design.md §58](../design.md)、[client/src/components/live/LivePanel.tsx](../../client/src/components/live/LivePanel.tsx)、[client/src/stores/live-panel-store.ts](../../client/src/stores/live-panel-store.ts)、[client/src/components/team/TeamPanel.tsx](../../client/src/components/team/TeamPanel.tsx)、[client/src/components/panels/registry.tsx](../../client/src/components/panels/registry.tsx)、[client/src/components/layout/AppLayout.tsx](../../client/src/components/layout/AppLayout.tsx)、[client/src/components/artifacts/ArtifactFeedView.tsx](../../client/src/components/artifacts/ArtifactFeedView.tsx)、ADR 17（交付件主区 Tab，本 ADR 修订）、ADR 42 / 43（连接中心与直播窗，入口与让位协同调整）、ADR 44（数据库工作台 / SSH 终端，入口改线）、ADR 52（场景派生，本 ADR 延续纯前端派生原则）

## 背景

- **面板膨胀**：右栏从 M8 的 3 个视图长到 9 个（成员 / 接力 / 图谱 / 战绩 / 任务 / 记忆 / 定时 / 指标 / 浏览器），平铺单行 + 横向滚动，无层级——低频视图（定时 / 指标）与高频视图（成员 / 任务）同权，可发现性与导航效率下降；
- **观看面三处裂开**：「Agent 正在做什么」散落在三处——右栏「浏览器」面板（帧流 / 步骤时间轴）、主区「交付件 / 数据库 / 终端」Tab、直播窗（浏览器 / 数据库 / SSH 三 tab）。用户需要在三处之间手动切换与寻找；
- **主区顶栏稀释**：主区积累了 5 个页签（对话 / 画布 / 交付件 / 数据库 / 终端），其中交付件 / 数据库 / 终端是低频深度工具，却与最高频的「对话」同权占位；
- **用户需求（本里程碑动因）**：①「交付件 / 数据库 / 终端三个面板与浏览器面板合并，Agent 操作什么右侧边栏就显示什么」——四个观看面合一 + 自动聚焦；②「成员 / 接力 / 图谱 / 战绩 / 任务 / 记忆 / 定时 / 指标做二级分支，收敛下一级展示」——一级导航收敛。

## 决策

1. **右栏「实况」面板（LivePanel）= 浏览器 / 交付件 / 数据库 / 终端四面合一**：面板内 face 条（图标 + 标签）即二级导航；未读交付件计数徽标 + 运行中操作面脉冲点（`useBusyOpFaces`）；右侧「暂停跟随」（本次运行不自动聚焦）＋「在主区展开当前面」（浏览器面无此项）。组件**零删除**：现 `BrowserPanel` 原样并入（帧流 / 接管 / 步骤时间轴，`retainView/releaseView` 引用计数语义不变，切面 = 断流 / 续流）；`DockDbView` / `DockSshView` 加 `surface: 'dock' | 'panel'` prop 复用（panel 面底栏为「展开工作台 / 展开终端 + 连接管理」，不触浮窗）；新建窄栏 `ArtifactFeedView`（默认「跟最新」，点列表项 = 钉住，再点回跟随；预览区复用 9 类 kind 预览器）；
2. **跟随引擎（`live-panel-store` + `resolveFollow` 纯函数）**：实况操作（browser / db / ssh）到达 → 自动切右栏视图到实况 + 对应面；护栏三则——① 本 Run 手动切走视图后不再抢（`viewLockedRunId`）② 手动切面 / 手动切视图后 60s 不抢面 / 不抢视图（`faceLockedAt` / `lastManualViewAt`，`FOLLOW_LOCK_MS`）③ 「暂停跟随」后本次 Run 不自动聚焦（`beginRun` 重置）；交付件更新 = **软跟随**（仅面板停在交付件面且未钉住时自动选最新；否则仅亮活动点，不抢视图不抢页签）；点一级「实况」= 恢复跟随；非当前会话事件不干扰；
3. **接线（`ws-store`）**：`notify:op` 处理顺序 = `livePanelStore.noteOp()`（可能程序性切视图）→ `connections.pushOp` → `dockStore.noteOp()`（保证让位判定读到已更新的右栏状态）；artifact 双通道（`notify:artifact-updated` / `run:end` 快照）双写 `ui-store.noteArtifact` + `livePanelStore.noteArtifact`（不引入 store 环）；
4. **右栏两级导航**：`PanelDef` 增 `group: 'team' | 'ops' | 'live'`；`GROUPS` 由 `PANEL_DEFS` 派生（单一事实来源）——团队 = 成员 / 接力 / 图谱 / 战绩，运行 = 任务 / 记忆 / 定时 / 指标，实况 = live（单子项，face 条即二级）；`TeamPanel` 外壳重写为一级 Tabs（3 项免横向滚动）+ 组内二级 chips（与实况 face 条同构；组内单子项不渲染，子面板渲染与插槽零改动）；`lastOf` 组记忆（点一级页签回该组上次子面板）；聚合徽标（运行组 = 任务待批准计数；实况组 = 活动点）；
5. **持久化 v2**：`ma:rightView` 从 v1 裸 id 升级为 `{ current, lastOf }`——`browser → live` 迁移，非法值回退「成员」；白名单仍 9 项（`RIGHT_VIEWS`）；
6. **主区收敛为「对话 / 画布」+ 深度工作台**：常态顶栏仅两个页签；交付件 / 数据库 / 终端改为按需展开的深度工作台（`expandWorkspace` / `closeWorkspaceView` / `deepFrom` 记录返回目标），深看态头部替换为「← 返回（对话 / 画布）｜工作台标题」（h-11 不变，防布局跳动）；`MainTab` 五值保留（内部状态与懒加载零破坏）；
7. **入口改线**：命令面板三条 →「展开 · 交付件 / Diff」「展开 · 数据库工作台」「展开 · SSH 终端」（应用视图类命令自动切回工作台）；消息 chip `requestArtifact` 与收尾清单行 → 实况 + 交付件面 + 钉住（不再切主区 Tab）；`DockDbView` / `DockSshView` 面板面跳转按钮与连接管理「打开」→ `expandWorkspace`；「右栏 · 浏览器」→「右栏 · 实况」；`insertToComposer` / `focusMessage` 仍切「对话」；
8. **直播窗让位协同**：`live-dock-store.noteOp` 前置判定——宽屏（>900px）且 `rightView === 'live'`（操作已在右栏可见）→ 不自动滑入，仅更新 `lastOp` / `tab` 供手动展开对齐（不消费 `autoRunId`）；手动 `openDock` 不受限；窄屏兜底滑入、静音、胶囊回落语义不变；
9. **纯前端**：服务端与消息协议**零变更**、零新增端点 / 事件类型；所有新状态（face / 锁定时刻 / 钉住路径 / 组记忆）仅存前端 store 与 localStorage。

## 理由

- **单一观看面（用户原则）**：Agent 操作到达即自动聚焦到对应面——「操作什么就看什么」；四个面共享一个面条，一次点击即可切换，不再跨三处寻找；
- **护栏优先于强制**：自动聚焦是「默认聪明」而非「夺权」——用户任何手动导航都是显式信号（本 Run / 60s 窗口），引擎让位；「暂停跟随」提供始终可控的退路；
- **组件复用零重写**：帧流引用计数、`useBrowserFrameInput` 键鼠直通、终端镜像清洗、9 类预览器、DataGrid / xterm 全部原样复用——新代码集中在「壳」（注册表 / 两级外壳 / 跟随引擎 / 窄栏交付件视图）；
- **两级导航的单一事实来源**：`group` 字段挂在 `PANEL_DEFS` 上（而非另立分组表），命令面板「右栏 · X」、持久化校验、组记忆自动同源派生——新增面板只需一个字段；
- **纯前端派生延续 ADR 52**：跟随规则从既有字段（`toolCalls.status`、`notify:op`、artifact 通知）派生，可单测（`resolveFollow`）、可回放、无协议税；
- **主区回归专注**：对话 / 画布是高频心智主场；深度工具按需展开 + 返回，避免顶栏稀释与误触。

## 被否决的方案

- **维持四个独立观看面（右栏四键或主区四 Tab）**：「操作什么就看什么」不成立，用户仍要自己找；主区顶栏 5 页签稀释最高频入口；
- **强跟随（操作到达无条件切视图 / 切面）**：用户正在读消息或看图谱时被强行拉走——「打开任意一级 / 二级项 = 手动视图变更」是心智模型底线；
- **交付件硬跟随（新交付件到达自动切实况 + 交付件面）**：交付件是「产出物」不是「实况操作」，打断阅读的代价高于及时性收益——软跟随（亮活动点）已满足「不错过」；
- **右栏一级导航做三组以上（如独立「交付件」组）**：一级项超过 3 个即回到「平铺膨胀」；交付件是实况四面之一，face 条承载最自然；
- **主区彻底移除交付件 / 数据库 / 终端能力**：深度操作（SQL 工作台 / xterm 交互 / 文件树 + Diff）无替代承载——「按需展开的深度工作台」两者兼得；
- **跟随状态进 URL / 服务端**：纯瞬态 UI 偏好，localStorage 足够；进服务端会引入协议与多端同步复杂度（零收益）。

## 验证

- 单测：client 全量 **51 文件 602 例** 全绿——新增 `live-follow.test.ts` 24 例（resolveFollow 全规则：自动聚焦 / 60s 视图锁与面锁 / 本 Run 锁 / 暂停 / 软跟随 / 映射 / store 接线）、`live-panel.test.tsx` 8 例（四面切换 / 脉冲点 / 未读徽标清零 / 暂停 / 展开 / 交付件跟随与钉住 / panel surface）；更新 `m22-frontend`（`browser → live`、分组派生）、`m23-frontend`（深度工作台入口）、`live-dock`（让位协同）、`closeout`（实况 + 钉住语义）；四包 typecheck 0 错误；
- E2E：helpers 新增 `openWorkspace`（命令面板「展开 · X」+ 窄屏 Ctrl+K 兜底）；10 个 spec 的旧入口（主区「交付件」页签）全量改线；两级导航用例（m24-plan / m16-serial / m25-memory 先点一级「运行」再点二级）；
- 构建：client `vite build` 通过（帧流 / 预览器 / xterm 懒加载分包不变）。
