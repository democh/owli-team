# ADR 0129：arena 席位发言流实时通道与侧栏宽度自适应——双源接入 · clamp 宽度

- 状态：Accepted
- 引入：M60
- 相关：[design.md §81](../design.md)、ADR 0112（场景工作区体系）、ADR 0114（投影而非拆流）、[client/src/components/scene/use-scene-data.ts](../../client/src/components/scene/use-scene-data.ts)、[client/src/components/scene/SideFeed.tsx](../../client/src/components/scene/SideFeed.tsx)、[client/src/components/scene/ArenaStage.tsx](../../client/src/components/scene/ArenaStage.tsx)、[client/src/index.css](../../client/src/index.css)

## 背景

- 用户实测反馈（arena：辩论场 / 谈判桌）：
  - ① 左右席发言流（SideFeed）**不是实时展示的**——M52-D 接入 `useSceneMessages`（500ms 节流 + 流式冻结，ADR 0114），发言要等整轮收束才进入侧栏（运行中侧栏长时间空白，收束瞬间批量刷新）；
  - ② **全屏 / 大屏下两侧过窄**——侧栏固定 `164px`，宽宿主下中轴撑满、两侧与中轴体量失衡（席位卡与摘要条目单行过短）。
- 约束：冻结口径是工作区性能红线（§66.4「500ms 节流 + 流式冻结」）——工作区不得随流式 delta 全量重渲染；容器解析（claims / findings / offer / verdict）依赖完整文本（半截容器解析会误判 / 闪跳）。

## 决策

1. **双源接入（实时纯文本投影 × 冻结容器解析）**：新增 `useSceneLiveMessages`（use-scene-data.ts）——与 `useSceneMessages` 同构同节流（500ms），仅移除流式冻结；ArenaStage 同时持有两源：冻结 `messages` 供裁决流 / 论断树 / 报价流 / 回合定位（零改动），实时 `liveMessages` 仅供 SideFeed（纯文本摘录投影面）。
2. **流式态表达**：SideFeed 条目挂 `data-streaming`（描边高亮 + 尾部闪烁光标 `caret-blink`；reduced-motion 关闭，与 typing-caret 同口径）；空正文 + 流式 → 「发言中…」占位——条目在首个 delta 后 500ms 内入流并随发言增长，收束后去标记、条目保持。
3. **宽度自适应**：`.scene-arena-side` 由固定 `164px` 改 `width: clamp(164px, 20%, 280px)`——窄宿保底 164px（原值不变），宽宿（含全屏 / 大屏）随宿主按比例放宽、280px 封顶；不新增断点，窄屏（<900px）仍走 §7.3-4 降级（侧栏不渲染）。

## 理由

- **纯文本投影是唯一可安全实时的面**：摘录（`excerptOf`）对半截文本天然容错（围栏 / 容器行跳过 + 56 字符截断 + 空态占位），而容器解析面必须等完成态（ADR 0114 语义不变）——把「实时」限制在投影面，性能与正确性都不受损；
- **同节流同订阅**：live 通道复用 500ms 节流与 `getState` 快照口径——流式期间每 500ms 至多一次侧栏重渲染（两栏合计 O(该席消息数)），不触碰虚拟列表结构键契约（ADR 0112）；
- **clamp 相对宿主**：宽度与宿主挂钩（非 vw），右栏挤压 / 分栏并存时行为一致；上限 280px 防止极端宽屏下侧栏喧宾夺主；下限 164px 保证既有单行可读性不变（窄屏零回归）；
- **交互零改动**：条目定位（focus）/ 席位回填（@）/ 类名（`.scene-side-*`）不变，既有断言面兼容（`data-streaming` 为增量属性）。

## 被否决的方案

- **整面解冻（`useSceneMessages` 去掉冻结）**：容器解析面（面板数据源）会吃到半截文本——论断树 / 报价流闪跳误判，违背 ADR 0114 与 §7.3-4 口径；
- **SideFeed 自订阅 store 直读**：绕过共享节流口径易造成每 delta 重渲染，且与投影层（excerptOf / 席位过滤）耦合；双源 hook 保持「数据面统一在 use-scene-data」的分层；
- **轮询接口 / 服务端推送发言片段**：新增数据通道，违背纯前端派生（ADR 0112）；
- **侧栏改弹性栅格（比例拉满）**：宽屏下中轴反被挤窄（消息流是主角），且窄宿主行为需重新设计——clamp 上下限即够；
- **宽度按视口 vw 计算**：宿主非全宽（右栏 / dock 并存）时失真。

## 适用与失效条件

- 适用：arena 形态（辩论场 / 谈判桌及未来 arena 场景）左右席 SideFeed 与侧栏宽度；其余形态（stream / dock / roundtable）不受影响；
- 失效条件：工作区引入「发言片段级容器解析」（如 token 级断言）时，实时面与解析面的边界需重新评估；侧栏 280px 上限在全屏 4K 场景重估（届时改高上限或引入容器查询）；
- 已知边界：`data-streaming` 条目文案为半截文本（excerptOf 截断），流式闪烁光标在 quiet 模式下不关闭（reduced-motion 关闭——光标为进度指示语义，与 typing-caret 同口径）。
