# ADR 0145：点亮本地互动态——sessionStorage 口径与跨实例同步（M38）

- 状态：Accepted
- 引入：M38 研讨型渲染包（2026-09-19）
- 相关：[design.md §92](../design.md)、ADR 0068（本地互动态存储与清理：勾选 / 点亮 / 投票存 sessionStorage 的口径本源，本 ADR 为其「点亮」项的落地细化）、ADR 0064（统一回填语义）、[client/src/components/scene/persist.ts](../../client/src/components/scene/persist.ts)、[client/src/components/chat/md-ext/IdeaCard.tsx](../../client/src/components/chat/md-ext/IdeaCard.tsx)

## 背景

- M38 原案 BS-1 定义点子池支持「点亮」本地计数（ADR 0068 决策：点亮 / 投票 / 勾选存 sessionStorage，键含 sessionId + messageId，不进导出）；
- 同一枚点子存在两处渲染面——消息流点子卡（IdeaCard）与汇聚板点子池（PoolPanel）——两处必须同源同态，否则「消息里点亮了、面板里没亮」；
- 既有先例：checklist 勾选态为 `ma:check:<sessionId>:<messageId>`（ChecklistCard 自持 state，无跨实例同步需求，因清单只出现在消息流一处）。

## 决策

1. **存储键与形状**：`ma:sc:lights:<sessionId>`（sessionStorage）——值为被点亮键的字符串数组；点亮键 = `<messageId>:<编号>:<标题>`（同一点子在消息卡与面板生成相同键，跨实例天然对齐）；读取容错（非数组 / 非法项过滤），写入容错（配额 / 隐私模式静默忽略）。
2. **跨实例同步**：模块级自定义事件 `LIGHTS_EVENT = 'ma:sc:lights'`（detail = sessionId）——`toggle` 先写存储、广播事件，同会话内的其他实例（消息卡 ↔ 汇聚板）经事件重读；发起方同时更新自持 state（不做乐观 diff）。
3. **hook 封装**：`useSceneLights(sessionId)` 返回 `[ReadonlySet<string>, (key) => void]`（persist.ts 导出，与 `useSceneTab` / `loadChecks` 同层）；IdeaCard 缺省自持该 hook（消息上下文提供 sessionId），PoolPanel 注入 `litOverride` / `onToggleLight` 复用同一 hook 实例。
4. **展示口径**：点亮为本地计数开关（点亮 / 已点亮两态；aria-pressed；流式期间禁用）；不落库、不进导出、不做跨会话聚合——与 ADR 0068「本地互动态」边界一致。
5. **会话隔离**：键含 sessionId——不同会话点亮互不可见；会话删除后残留键不构成数据泄漏（仅本地布尔集合），随浏览器存储清理策略回收。

## 理由

- **sessionStorage 而非 localStorage / 落库**：点亮是「当前研讨过程」的轻量标记，跨标签页无意义（刷新保留、关标签即清——sessionStorage 语义恰好）；落库会把本地视图偏好升格为会话语义（ADR 0068 已否决）；
- **事件广播而非全局 store**：点亮只有两个消费点、无需引入新 store 层；自定义事件与全局 store 订阅相比零依赖、易测（jsdom window 事件即可断言）；
- **键含 messageId**：同题多点子（跨波次出现相同标题）不互相污染；与 ADR 0068「键含 sessionId + messageId」逐字一致。

## 被否决的方案

- **localStorage 全局点亮**：跨会话 / 跨用户串态，且与「本地互动态不进导出」边界冲突；
- **点亮计数落库（服务端聚合）**：触发条件未出现（ADR 0082：互动统计后端化仅在真实使用证明需要跨会话聚合时立项）——超前实现违反条件性决策纪律；
- **pool 面板与消息卡各自独立 state**：两处不同步（点亮一条、另一处不亮），违背「同源同态」；
- **每卡片加 `data-lit` 原生属性 + CSS 状态**（无 React state）：跨实例同步仍需事件机制，原生属性方案省不掉广播，反而失去 aria 语义；
- **把点亮并入 `useSceneTab` 通用偏好**：点亮是集合型互动态、偏好是标量，「一个 store 装两种形状」得不偿失。

## 边界与失效条件

- 点亮仅影响卡面展示（两态开关），不写入消息、不触发任何 Run；
- 若未来需要跨设备 / 跨会话的点亮统计，按 ADR 0082 条件性路径另立（interactions 表 + API），本 ADR 的本地口径同时失效；
- 事件同步为同窗口内机制；跨标签页同步不在承诺范围（sessionStorage 本身即标签页隔离）。
