# ADR 0180：脑图节点长文本折行——渲染与布局估算对齐（画布样式修订）

- 状态：Accepted
- 引入：画布样式微批（2026-09-19）
- 相关：[design.md §49.5](../design.md)、[client/src/lib/mind.ts](../../client/src/lib/mind.ts)、[client/src/components/canvas/nodes/MindNode.tsx](../../client/src/components/canvas/nodes/MindNode.tsx)、[client/src/components/canvas/CanvasView.tsx](../../client/src/components/canvas/CanvasView.tsx)（拖拽重挂命中）、[client/tests/m31-mind.test.tsx](../../client/tests/m31-mind.test.tsx)

## 背景

- 反馈：脑图节点长文本（如「E1: 77.93%家乡存在彩礼，平均12.27万（待核实）」）**溢出卡片边界**——文字画到胶囊外面，破坏节点视觉；
- 根因：渲染侧文本 `whitespace-nowrap` + `max-w-52`——超长文本被 span 的 208px 宽度限制后**不折行**，overflow 直接画出胶囊；同时布局估算 `estimateMindSize` 恒按**单行高 34** 计算，两处口径从一开始就不一致（旧行为是「溢出也不换行」，布局永远按单行排）；
- 尺寸模型：`estimateMindSize` 是脑图布局的唯一尺寸源（dagre `layoutMindSubtree` / 加子落位 `nextChildPosition` / 重挂命中 / CanvasView 拖拽重挂检测），渲染侧 `MindNode` 为 `w-fit` 自适应胶囊——估算与渲染必须同源对齐。

## 决策

1. **渲染侧折行（MindNode）**：文本区去 `whitespace-nowrap`、加 `break-words`（超长无空格串硬拆），长文本在 `max-w-52`（208px）内折行、节点高度自适应；编辑态 input 补 `max-w-52`（长文本编辑不再把胶囊拉爆）；
2. **圆角随形态升级**：`rounded-full` → `rounded-2xl`——单行（34px 高）时 16px 圆角与半高 17px 几乎无差（视觉仍是胶囊），多行（54px+）不再呈橄榄形，层级更像卡片；
3. **估算侧按行展开高（lib/mind.ts）**：`height = 34 + 20 × (lines - 1)`；行数用 **token 贪心折行模拟**（与浏览器断行近似）：全角 / CJK 逐字可断、拉丁数字按词不换行（词间断）、超行宽单词硬拆（对齐 `break-words`）；**宽度公式不变**（下限 112 / 上限 248 / `60 + min(textWidth, 208)`），既有单测与视觉基线零变化；
4. **同源常量收拢**：`MIND_TEXT_MAX_W = 208`（= max-w-52）、`MIND_LINE_H = 20`（= leading-5）、`MIND_BOX_BASE_H = 34`（= py-1.5 + 1px 边框 ×2 + 单行 20）——渲染样式与估算常量必须成对维护；
5. **布局自动受益**：dagre 树布局 / 加子落位 / 重挂命中一律经 `estimateMindSize`，多行节点间距（`MIND_V_GAP = 18`）与命中判定无需单独改动。

## 理由

- **折行而非截断**：脑图是信息载体（用户截图三条均为「待核实 / n=5」类关键限定语，截断即失真）；折行后节点最多增高、不丢内容；
- **token 贪心而非简单 `ceil(总宽 / 208)`**：拉丁词不拆行（词边界浪费会低估行数）、超宽词硬拆（否则低估）；CJK 逐字与真实断行一致——估算与渲染同向偏差最小；
- **宽度公式不动**：宽度估算的既有容差（有折叠按钮的渲染宽 ≈ 270 vs 估算 248）在 72px 的列间距下无害；改动会连带既有 6 处单测断言与视觉基线，收益为零；
- **只把「高度」变成变量的最小改法**：所有下游（dagre / 落位 / 命中）都消费同一函数，改一处全链生效。

## 被否决的方案

- **`truncate` 省略号截断**：信息隐藏，与脑图语义相悖；
- **`line-clamp-2/3` 截断**：需与估算行数上限二次对齐，且同样隐藏内容——折行无上限（服务端 LLM 路径已有 `MAX_TITLE_CHARS = 60` 护栏，极端长文属用户自主行为，完整展示）；
- **只加 `overflow-hidden` 兜底**：裁字不换行，问题依旧；
- **编辑态改 textarea 折行**：与 Enter 提交 / Esc 取消快捷链冲突，交互面大，本轮仅限宽；
- **修正 `NODE_SIZE.mind`（180×44）兜底尺寸**：44 与真实单行 34 的偏差影响拖拽吸附 / 对齐参考线基线（面广），本批不夹带，另批评估。

## 边界与失效条件

- **样式-估算成对**：MindNode 的 `max-w-52` / `px-3` / `py-1.5` / `text-[12px]` / `leading-5` 变更时必须同步 `lib/mind.ts` 常量，否则折行位置与布局间距分叉；
- **估算精度边界**：拉丁字符按 6.8px 平均宽，行数为近似（词边界断行）；多行仅影响高度与间距，不影响溢出（渲染 `break-words` 已硬保证不越界）；
- 若未来改为 DOM 实测驱动布局（ResizeObserver 回报尺寸），本估算函数退居兜底，本口径不失效（估算仍是首帧与无渲染路径的唯一尺寸源）。

## 验证

- client `m31-mind`：estimateMindSize 折行断言（20 CJK → 2 行 / 80 CJK → 5 行 / 20 拉丁词 → 3 行），共 26 例绿；
- E2E `m31-canvas-ux`（7）+ `m31-canvas-interactions`（1）回归绿（8795 隔离环境）；真实浏览器三图验收：折行渲染 / 脑图整理后多行间距 / 编辑态限宽。
