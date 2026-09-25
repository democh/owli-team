# ADR 0221：K 线手动划线圈（M85 / M83 批 E-1）

- 状态：Accepted（2026-09-25 落地并验收；同日修订：工具集 9→12、绘制手势改为自持实现）
- 关联：M83（ADR 0219 / docs/kline-analysis-dsl-design.md 批 E 首项）・design.md §126・外部文献《klinecharts v10 前端集成完整指南》划线圈章节

## 背景

M83 批 E 首项「划线圈」：用户在图上手动画线（线段 / 水平线 / 矩形 / 斐波那契 / 测量 / 文本等），样式可调、本地持久化、与「分析落图」互不干扰。图表唯一动态 import 入口为 `chart/entry`（klinecharts 独立 chunk），划线体系必须沿用该接缝。

## 决策

1. **工具集（12）**：线段 / 射线 / 直线 / 水平线 / 垂直线 / 矩形 / 斐波那契回撤 / 斐波那契扩展 / 安德鲁分叉线 / 文本 / 测量 / 区间成交量分布——内置 overlay 6 项（segment / rayLine / straightLine / horizontalStraightLine / verticalStraightLine / fibonacciLine）+ 自定义 overlay 6 项（rectZone / textLabel / measureBox / **fibExtension** / **pitchfork** / **volProfile**，`extendData.interactive=true` 时主图形参与事件；分析落图路径保持 `ignoreEvent` 纯显示语义不变）；三点工具（扩展 / 分叉）与两点工具（量分）补齐「更多 overlay」需求；volProfile 数据源为 `chart.getDataList()`（时间滤镜经 xAxis.convertFromPixel，价格桶 24）。
2. **绘制手势（自持实现）**：多点工具**依次点击 N 点即完成**（N = 工具落点数；单点工具单击完成）。**不再依赖框架 progress overlay 的步数语义**——实测该语义在不同 totalStep 下不一致（内置两点工具「两次单击不完成」需第三次确认或末点双击；自建 totalStep=4 的三点工具在「2 次点击 + 双击」时仅落 2 点即被 forceComplete）。实现：entry 层在容器上以 **capture 阶段 `mousedown` / `contextmenu`** 收集落点 + `chart.convertFromPixel` 换算为 {ts, price}；每落一点重建静态预览 overlay（独立组 `manual-draft`，自定义工具降为不可交互）；凑齐 N 点移除预览 → `onDone` 交回受控状态层重建。Esc = cancelDraw，右键 = 取消 + 回调。
3. **分组与更新路径**：手动组 `groupId='manual'`，不进入 `applyDrawings` 的 knownGroups（分析 / 策略落图先清后画不影响手动层）；`update({manual})` 走智能路径——**id 集合不变（样式 / 拖动 / 撤销）→ 逐条 `overrideOverlay` 就地覆盖（保留选中与交互态）；结构变化（新增 / 删除）或覆盖失败 → 整组重建**。
4. **持久化与多实例一致**：localStorage `ma:kline-draw:v1:<symbol>:<period>:<adjust>`（无 symbol 的内联块不启用——不落盘也不展示工具条）；形态 `{v:1,d:[]}`；读取全量净化（工具白名单 / 点数值校验 / 色值正则 / 线宽 1–4 钳制 / 文本 ≤24 / 上限 100 条）；每次变更落盘并广播 `ma:kline-draw-changed` 事件——块内与全屏两个实例自动一致（事件内容比对防自激）。
5. **交互配套**：Esc 取消绘制 / 取消选中；Del 删除选中（未锁）；⌘Z / ⇧⌘Z 撤销重做（≤50 步）；清空两步确认；样式栏（6 色板 / 线宽 1–3 / 虚线 / 填充 / 文本输入 / 锁定 / 删除）；键盘事件对输入框豁免。
6. **范围边界**：手动划线为**用户本地标注**——不落服务端、不随「送上画布」迁移（快照落图仍走 shared `Drawing` 通道）；批 E 余项（Monaco 策略工作室 / 实时盯盘）已于同日经产品侧确认收口——**不立项 / 暂缓**（见 [ADR 0222](0222-batch-e-closure.md)）。

## 理由与权衡

- 复用现有 `entry` 接缝与 overlay 注册体系，零新依赖、chunk 边界不变（klinecharts 仍仅 entry 动态引入）；
- 就地覆盖优先是「样式栏不因改色丢选中」的关键：整组重建会触发 onDeselected，样式栏即闪退；
- 自持 selectedId（React 状态）而非依赖 klinecharts 选择态：库无编程选择 API，重建后选择高亮丢失可接受，样式栏以 React 态为准；
- 不并入 shared `Drawing` 契约：避免为纯本地功能扩散服务端 DSL 白名单与快照契约。

## 被否决

- 把手动划线并入 shared Drawing / 快照（契约扩散，服务端解析被迫扩展）；
- 每次变更整组重建（丢选中 / 交互态，样式栏闪退）；
- 依赖 klinecharts 编程选择 API（v10 不存在）；
- 持久化落 DB（本地标注场景过重）；
- **依赖框架 progress overlay 完成手势**（步数语义不一致：同一点击序列在不同 totalStep 下行为不同；双击完成在不同工具下可能提前截断甚至丢点——两轮探针实测后改为自持绘制）。

## 验收

client 全量（新增 `m85-manual-drawings` 13 例：存储净化 / overlay 映射（含三新件）/ 钩子撤销重做与持久化 / 组件集成）；E2E `m85-kline-drawings` 1/1（单击落线 → 样式栏 → 删除 → 撤销 → 两步清空 → 线段两点 → 分叉三点（含像素→价格径向 sanity 与样本区间断言）→ localStorage 断言）；双端 + e2e typecheck 0 错。
