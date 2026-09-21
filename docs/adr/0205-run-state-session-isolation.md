# ADR 0205：运行状态会话隔离——切会话断流清态 · 运行态渲染按会话归属

- 状态：Accepted
- 引入：运行状态隔离批（2026-09-21）
- 相关：[client/src/stores/run-store.ts](../../client/src/stores/run-store.ts)、[client/src/components/chat/ChatArea.tsx](../../client/src/components/chat/ChatArea.tsx)、[client/src/components/chat/Composer.tsx](../../client/src/components/chat/Composer.tsx)、[client/src/components/chat/MessageActions.tsx](../../client/src/components/chat/MessageActions.tsx)、[client/tests/run-events.test.ts](../../client/tests/run-events.test.ts)

## 背景

M11 起「回合间隙的下一棒」「协作进行中 · 队列 N」「成员条排队序号」等运行态由全局单例 `run-store`（`active` / `queue` / `currentWave` / `waveIndex`）驱动，消费点（ChatArea / Composer / RelayQueue / GraphView 等）直接读取，**无会话归属校验**。

§18.2 设计的「运行与连接解耦：切换会话仅断开本地流」在实现中不完整——`attachActiveRunFor` 只在**目标会话有进行中 Run** 时才接管（内部 `attach` 会 abort 旧流）；目标会话无 Run 时直接返回，**既不清理旧状态、也不中止旧 SSE 流**。且 `run:start` / `turn:end` / `queue:updated` 的归约对非当前会话事件无守卫（只有消息类事件有 `sameSession` 判断），旧流事件持续改写全局运行态。

实际缺陷（用户实测）：单成员「通用助手」的「你好」会话消息流尾部渲染出 `下一棒 · 安娜 正在热身`——安娜是研究场景队列中的成员（该会话仅 1 位成员，若安娜真属本会话队列，交棒自动召集会使其入场并显示 2 位），泄漏源为用户此前所在会话的运行中 Run（A→B 切换后旧状态未清）。`MessageActions.fork` 分支会话切换路径同样不经 `attachActiveRunFor`。

## 决策

1. **切会话断流清态收口在 `attachActiveRunFor`**：同一会话已挂接运行流 → 短路保持（避免重放抖动）；否则**先 `detach()`**（abort 旧流 + 清 `runId` / `sessionId` / `active` / `queue` / `currentWave` / `waveIndex`），再查询 `GET /api/runs/active`，命中目标会话则重挂接（服务端 `run:start` 快照重放覆盖队列）。
2. **查询竞态守卫**：`await` 期间会话再被切换（快速连点）→ 迟到响应不 attach（对照 `currentId`，与 `session-store.selectSession` 同款守卫语义）。
3. **SSE 流来源守卫**：`attach` 的 `onEvent` 校验 `controller === myController`——流被替换（切会话 / 新 attach / detach）后的迟到事件不再改写运行状态。
4. **运行态渲染按会话归属**：ChatArea「下一棒」提示增加 `runSessionId === currentId` 条件——双保险，不依赖各处清态路径的完整性。
5. **fork 路径补齐**：分支会话创建并切换后同样调用 `attachActiveRunFor`（无 Run → 清态；有 Run → 挂接）。
6. **同批前端精修（Composer 底栏提示行，0137 同区域）**：单行不换行（去 `flex-wrap` + 容器 `overflow-hidden`，状态类信息 `shrink-0` 优先保留）；快捷键提示精简为「Enter 发送 · ⇧Enter 换行」（@ 召唤 / 斜杠命令交由 placeholder 与输入时补全自明），窄窗口（<md）整段隐藏、宽度吃紧时省略号兜底；「运行中发送将作为插话，在回合结束后生效」→「插话 · 回合结束后生效」并去除与运行状态重复的第二个 spinner。交互零变化。

## 被否决的方案

- **只在 ChatArea 加会话守卫**：治标——Composer 成员条排队序号、footer 状态、GraphView 等其余消费点仍会串；且旧流不断，后台持续归约（无谓开销 + WS 队列广播继续改写本地状态）。根因是切会话未断流清态。
- **run-store 引入 sessionId 命名空间 / 多流并行订阅**：当前产品语义同一时刻仅挂接一个 Run（§18.2），多流会引入「哪个会话在跑」的全局指示歧义，超范围。
- **切会话保持旧流「静默跟随」**：旧会话进展已由 WS 通知 / 未读计数 / 列表预览呈现，SSE 流无保留必要；保留即状态泄漏源。
- **底栏提示行整体删除**：快捷键与插话语义仍有一处就近提示价值（「Enter 发送」为测试断言锚点），取精简 + 响应式让位而非删除。

## 边界与后续

- `detach` 清 `runId` / `sessionId` 后，WS `notify:queue-updated`（按 `runId` 匹配）天然不再改写本地队列；
- 消费点仍消费全局 store（未逐一加守卫），依赖「切会话必断流清态」这一不变量；新增消费点时沿用，后续可按需评估选择器化；
- 回归测试：[run-events.test.ts](../../client/tests/run-events.test.ts) +3（无运行清态 / 同会话短路 / 有运行重挂接）；全量 client 单测 118 文件 / 1333 条通过、`tsc --noEmit` 通过；
- UI 文案口径与「全站 UI 文案精简口径」一致：解释性描述缩减、状态与危险提示保留。
