# ADR 0127：场景工作区就绪判定与面板标题合行——无数据不展示 · 折叠 / 关闭钮注入 · dock 拖拽增强

- 状态：Accepted
- 引入：M58
- 相关：[design.md §79](../design.md)、ADR 0112（场景工作区体系）、[client/src/components/scene/panel-ready.ts](../../client/src/components/scene/panel-ready.ts)、[client/src/components/scene/DockStage.tsx](../../client/src/components/scene/DockStage.tsx)、[client/src/components/scene/panels/PanelShell.tsx](../../client/src/components/scene/panels/PanelShell.tsx)、[client/src/components/scene/panels/chrome.tsx](../../client/src/components/scene/panels/chrome.tsx)

## 背景

- 用户实测截图（传统数术 dock·chartboard 八字盘面）：右工作区面板标题行（「盘面面板」+ 徽标）与右上角折叠 `>` / 关闭 `×` 独立操作条各占一行——同一功能区内两行操作语义割裂；截图同时反映：① 纯对话起步阶段（尚无盘面产出）右区仍以默认 340px 常驻空态（「对话中产生的盘面将显示在这里」）；② 用户实测拖宽至上限 520px 对盘面 / 看板类内容仍显窄；
- 用户诉求原话：「右侧面板 做成标题，放到 header 上，与关闭一行，整体优化设计i下，右侧面板没数据的时候可以先不展示，有内容之后在展示，并调整合理的宽度等，交互详细设计优化下」；
- M52-A（ADR 0112）起六面板空态一律 PanelEmpty「不空白、不报错」——在「对话即全部」的起步阶段，「空白区 + 引导文案」仍是视觉噪声与宽度浪费。

## 决策

1. **面板就绪判定（「无数据不展示」单一事实来源）**：新增 `panelReady(panel, { containers, verdicts, messages })` 纯函数 + `useScenePanelReady(panel)` hook（`panel-ready.ts`）——六面板逐一口径（宁可多显示不可漏显示）：chartboard = 有 `::: pan` 容器；pool = 有「结构化行或带标题」容器；versus = 有 `::: verdict` 裁决实例；board = 成员消息带 Markdown 标题或存在交付件；console = 成员消息 / 管道列容器 / 交付件任一非空；coach = 有 `::: checklist` 容器。SceneStage 接入：未就绪 → `panel` 不下传（dock 直通纯对话流 / roundtable 无汇聚板 aside / 窄屏无抽屉），有内容自动出现。
2. **标题合行（PanelChrome 注入）**：PanelShell 标题行统一「图标 + 标题 + 徽标（贴左）+ 操作区（右推）」；宿主经 `PanelChromeContext` 注入折叠 / 关闭钮（DockStage 注入，`actions` prop 可覆盖）；独立操作条 `.scene-dock-bar` 删除；滚动下沉——标题行固定（border-bottom）+ `.scene-panel-body` 内部滚动，右区 / 抽屉 / 汇聚板三宿主同构。
3. **宽度与拖拽增强**：默认 340 → 360px，clamp 260–520 → 280–640px；拖拽零 React 渲染（ref 直改 aside 宽度，抬手一次落态 + 落盘）；双击把手复位默认宽；把手键盘可达（`role=separator` / `aria-valuenow·min·max`；← → 步进 16px、Shift 加速 48px）；pointercancel 回滚起始宽度（不落盘）；拖拽中 `.scene-dock-resizing`（全域 col-resize 光标 + 把手高亮 + 禁止选择）；组件卸载清理 body 光标 / 选择态。
4. **入场动画与降噪**：右区 / 汇聚板 aside 就绪挂载入场 `scene-aside-in`（0.18s，opacity + translateX(10px)）；quiet-mode 与 `prefers-reduced-motion` 下全关。
5. **组件级空态保留为兜底**：PanelEmpty 分支不删除（就绪判定与容器渲染间的时序兜底）；单测双层口径——宿主用例断言「不渲染」，组件用例断言「空态」。

## 理由

- **「有内容之后再展示」**：纯对话起步不在右区吃宽度（对话区获全宽）；成员一旦产出（容器 / 交付件 / 首条成员消息）自动挂载，挂载即带真实数据（无「空态闪一下」）；closed（手动关闭）尊重用户意图——有数据后显示 reopen 按钮而非自动弹出；
- **口径「宁可多显示不可漏显示」**：判 true 时最多多渲染一次空态（可接受），判 false 才隐藏——漏判将造成「有数据但工作区不出现」的功能倒退，故口径按各面板数据源取并集语义并与面板内部分类（KANBAN_NAMES 等）注释双向绑定防漂移；
- **标题合行的信息架构收益**：面板身份（图标 / 标题 / 徽标）与面板操作（折叠 / 关闭）同处一行，消除独立操作条的第三行结构；chrome 经 context 注入而非 props 透传——六面板注册表（STAGE_PANEL_COMPONENTS）以零 props 装配，面板组件保持形态无关；
- **拖拽 ref 直改**：拖拽中的 setState 级联（盘面 / 看板类内容全量重渲染）卡顿明显；ref 直改 + 抬手 commit 把 React 渲染压到 1 次；双击 / 键盘复用同一 commit 路径保证三入口一致；
- **宽度 360 / 640 取值**：默认 +20px 缓解盘面类内容初始拥挤；上限 +120px 覆盖盘面 / 看板阅读需要，同时 640 在 1280 桌面宽度下对话区仍保 ≥640px——右区不挤占对话可用性。

## 被否决的方案

- **无数据时渲染空态面板（本批前行为）**：用户明确诉求「不展示」——空态骨架仍占宽且构成视觉噪声；空态语义降级为组件级兜底保留；
- **各宿主分支自配就绪判断**：六面板 × 四形态组合判定散布宿主，口径漂移；收进 `panelReady` 纯函数单一事实来源（可独立单测）；
- **就绪后延迟 / 防抖展示**：流式收束瞬间的产出本就期望即时呈现，延迟制造伪需求；
- **拖宽上限继续放大（800+）**：右区 >50% 时对话区不可用——640 + 双击复位 + 键盘微调已覆盖阅读需要；
- **拖拽每帧 setState**：重渲染代价高（见理由）；
- **折叠条保留独立行**：与标题行合并才是用户所见图景。

## 适用与失效条件

- 适用：dock / roundtable 两形态的面板宿主（六面板全量 + 窄屏抽屉）；「无数据不展示」为有数据后单向（隐藏仅经手动关闭 / 折叠）；
- 失效条件：新增第七面板时 `panelReady` 须同步扩展口径（switch 穷尽 + 与面板空态分支对照）；就绪判定输入依赖消息流派生（containers / verdicts / artifacts）——若派生管线改服务端推送，判定输入须替换；
- 已知边界：判定口径与面板内部数据切片以注释双向绑定（如 console ↔ ConsolePanel.KANBAN_NAMES = kanban / pipe / board）；listMode（切回纯列表）不渲染工作区（既有口径不变）。
