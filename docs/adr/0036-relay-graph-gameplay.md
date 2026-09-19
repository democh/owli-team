# ADR 0036：协作图谱游戏化——拖拽节点 · 自适应折行赛道 · 双布局 · 导演镜头 · 档案面板

- 状态：Accepted
- 引入：M21
- 相关：[design.md §28](../design.md)、ADR 32、ADR 33、ADR 25

## 背景

M17 图谱（ADR 32）解决了「有没有」，但作为只读拓扑在侧栏里体验很差：接力链强制单行（7 人链画布内容宽 1440px），侧栏仅 ~330px，fitView 受 `minZoom` 截断后内容溢出容器——边缘节点被主区 DOM 覆盖，**既不可见也不可交互**（实测 `elementFromPoint` 命中的是聊天区）；节点实际渲染尺寸仅 ~45px。用户诉求是把图谱「当成一个游戏来设计」：可拖动、强交互、有趣味、能展示、带工作面板。

## 决策

**在 React Flow 受控模型上做「作战圆桌」游戏化升级，数据口径与懒加载纪律不变（零后端）**：

- **自适应折行赛道（核心修复）**：`pickChainPerRow(count, w, h)` 按容器尺寸选档——单行适配缩放 ≥ 0.7 保持单行长链（全屏 / 宽容器保留接力语义）；否则枚举 perRow 取「适配缩放最大」（窄栏折行填满，节点 ~120px 可点可拖）。dagre 只负责 (rank, 层内序) 排序，蛇形铺网格（偶数行左→右、奇数行右→左，折返处上下相邻）；`ResizeObserver`（2px 防抖）驱动选档，档位变化平滑重排 + fitView（首次瞬移）。
- **节点拖拽 + 位置记忆**：受控 `nodes` + `applyNodeChanges`；`offsets` ref 记录拖动终位，实时重算 / 布局重排时手动位置优先；拖动中保留 state 位置（防重排抖动）；「整理布局」清偏移平滑归位；拖动位置是视图态，不持久化。
- **双布局**：接力链（长链 / 蛇形赛道）↔ 圆桌（radial + 中心图腾 CoreNode 显示场景名 + 在场人数）；切换用节点 `style.transition` + fitView 动画平滑过渡；core 节点仅 radial 出现。
- **能量边与接力脉冲**：运行中接力边沿方向流动（`--flow-ms` 速度 / 粗细随接手次数）；接力边 count 增长（非会话切换）触发边爆发 + 目标节点接收光环——脉冲以 nonce state 快照进入渲染依赖（修复 ref 不进依赖数组导致动画不触发的隐患）。
- **导演镜头**：跟随当前发言者（无则队首），`setCenter` 平滑居中；全屏默认开启。
- **HUD 战况 + dock**：成员 / 接力总数 / 波次（`run-store` 新增 `waveIndex`）/ 队列 / 最新接力；dock = 布局切换 · 整理布局 · 导演镜头。
- **档案工作面板（GraphInspector）**：点击节点滑出——状态徽章（发言中 / 排队第 N 位 / 待你指示 / 待命）/ 战绩三格（接手 · 交出 · 发言）/ 工作产出（该成员交付件列表，按 `authorAgentId` 归集，点击跳转交付件浏览器）/ 上下游 chips（点击换人）/ 最近发言（点击定位对话区）/ 操作行（聚焦 · 拍一拍 · @ 召唤 → `insertToComposer`）。
- **悬停稳定化与画布底噪清理**：边标签仅随「点选成员 / 悬停边本身」出现（悬停节点不再弹出/收回）；焦点切换（边透明度 / 描边宽 / 节点淡化）全部走 CSS 过渡。**受控重建契约（悬停闪烁根因）**：`adoptUserNodes` 仅当节点对象引用相等（`checkEquality`）或携带 `measured` 时保留内部节点的测量值（`measured` / `handleBounds`），否则按「用户重新初始化」清空——被清空节点 `hasDimensions=false`，NodeWrapper 立即 `visibility: hidden`，hit-test 瞬时消失触发 `mouseleave` → 状态回摆 → enter/leave 振荡（实测 2s 内 150+ 次，表现为线条闪烁 + 点击失效）。修复 = `sameFlowNode` 浅比较复用未变化节点引用 + 变化节点随对象保留 `measured`（来自 React Flow `dimensions` change 回传）+ 全量未变时短路跳过更新。移除 MiniMap 与 React Flow 水印（`proOptions.hideAttribution`）。
- **降级**：quiet / reduced-motion 关闭流动、脉冲与入场动画；空态保留编制预览。

## 理由

- **折行是可用性的必要条件**：340px 级容器里单行 1440px 内容无论怎么调参都不可用；折行后节点从 45px 提升到 ~120px（实测 131×36），且内容不再溢出容器——「可拖动」的前提才成立。
- **保 e2e 锚点**：`.graph-speaking` / EdgeText DOM 结构 / 四段图例 / `.react-flow__controls-fitview` / 默认 chain 7 节点全部保留；core 图腾只在 radial 出现（不破坏默认节点计数）。
- **视图态与数据态分离**：拖动偏移、布局模式不写会话/后端，图谱始终是「消息流 + RunEvent 的另一种视图」（延续 ADR 32）。
- **测量值不可丢（受控合并契约）**：自定义 `setNodes`（非 `useNodesState`）合并 `flowNodes` 时，若直接丢弃 prev 节点上由 `dimensions` change 回传的 `measured`，每次受控重建都会重走 React Flow 的「未初始化」路径（hidden → 重测）；悬停恰好激活该路径并进入鼠标事件回环，代价是一个浅比较函数，但换来节点 DOM/测量完全稳定。
- **游戏化即可观测性**：拖拽整理 = 个性化编排，能量流动 / 脉冲 = 接力实时反馈，档案面板 = 单成员视角，HUD = 运行态势——全部复用既有事件，无新通道。

## 被否决的方案

- **降 minZoom（0.25 → 0.1）全量缩放**：内容能装下但节点不足 20px，不可读不可点——把问题藏起来而非解决；
- **节点分页 / 只显示前 N 个**：丢拓扑（看不到全链），违背图谱「全貌」定位；
- **后端计算布局并持久化**：引入第二事实源与一致性问题（同 ADR 32）；
- **拖动位置持久化到会话**：视图态与数据态耦合，跨端 / 跨窗口不一致，收益低；
- **把悬停淡化移出 React 数据流（imperative DOM class / CSS 层叠）**：可避开重建但绕开 React 数据流，脆弱且与折叠 / 选中态互相干扰，维护成本高于一个浅比较；
- **等待 React Flow 升级修复**：保留 `measured` 是受控模型的既定契约（`parseHandles` 显式读取 `userNode.measured`），非缺陷，升级不改变契约。
- **手写 SVG / d3 自研交互**：放弃 React Flow 的受控模型与内置能力（同 ADR 32）；
- **强制多行（永远折行）**：全屏时丢掉「一行长链」的接力语义，且折行档位固定不随容器自适应。

## 影响

- client 新增：`lib/graph-layout.ts`（折行选档 + 蛇形 + radial）、`components/team/graph/`（AgentNode / CoreNode / RelayEdge / GraphInspector / types）、`lib/agent-actions.ts`（拍一拍共用）；
- `lib/graph.ts` 扩展 `inCount / outCount`（节点接手徽章）、`summarizeGraph`（HUD）、`neighborsOf`（档案面板）；
- `run-store` 新增 `waveIndex`（HUD 波次口径）；`index.css` 新增 M21 图谱动画段；
- 单测扩展（graph / graph-layout / m16-frontend 冒烟，含工作产出 / 空态 / 悬停稳定化用例）；e2e 新增 `m21-graph-gameplay.spec.ts`（拖动 · 整理 · 圆桌 · 档案面板 · 召唤 · 画布底噪）；`m16-graph.spec.ts` 全量回归通过，并新增悬停回归保护（悬停不弹标签且不抖动 → 点击才显示「接手 N 次」）；
- 懒加载纪律不变（图谱仍为独立 chunk，首屏包体门槛不回升）。
