# ADR 0094：派发优先于交还报备（Dispatch Priority Over User Handback）

- 状态：Accepted
- 引入：M46-2
- 相关：[design.md §55](../design.md)、[server/src/orchestration/scheduler.ts](../../server/src/orchestration/scheduler.ts)、ADR 4（交还判定：仅行首 `@用户`）、ADR 85（无 @ 路由调度优先）、ADR 90（调度接手护栏）

## 背景

- `HANDOFF_MODE=auto` 下交还信号有双通道：行首 `@用户`（文本）与 `handoff(user)`（工具）；解析器把「行首 @用户」判为 `handedToUser = true`，同时仍会解析同条消息里的成员提及（[parser.ts](../../server/src/orchestration/parser.ts)）；
- 波次合并（[scheduler.ts](../../server/src/orchestration/scheduler.ts) `mergeWaveSchedule`）旧逻辑：`allHanded = decisions.every(d => d.handedToUser)` 命中即早退——清空队列、丢弃本波全部 `accepted`、Run 结束；
- 真实故障（头脑风暴会话，run_7b3fda05 / run_43713c38 / run_78ecb13b 连续三次复现）：调度官知舟同一条消息「先派发梅森（facilitator）定稿，再在消息末尾 @用户 报备进度」——单成员波内 `decisions = [{ handedToUser: true, accepted: ['facilitator'] }]` → `allHanded = true` → 梅森的接手被静默丢弃、Run 结束。导出 trace 可见 `schedule` 事件 `accepted=[{"agentId":"harness","accepted":["user"]}]`、`queue=[]`；最终交付件 `docs/创意方案-如何设计一个好的产品.md` 从未产出，用户反馈「没有汇总给我」。

## 决策

1. **先收集后判交还**：`mergeWaveSchedule` 先按波内顺序收集全部 `accepted`（跨成员去重 → `acceptedAll`），再做交还判定；
2. **交还条件收紧**：`allHanded = decisions.every(d => d.handedToUser) && acceptedAll.length === 0`——「全员交还**且本波无任何成员接手**」才是收尾交还；部分交还（含同条消息的报备）视为不交还，Run 继续消费成员接手；
3. **每成员接手口径**（turn:end.mentions 与图谱数据源）：有明确 `accepted` 时以成员为准（`['facilitator']`），仅纯 `@用户`（无成员）才标注 `['user']`。

## 理由

- 「先派发、再 @用户 报备」是调度官的自然表达（派发与告知用户应并行不悖）；`@用户` 报备**不撤销**同条消息的派发；
- 修复范围最小且语义单向：只放开「有成员接手时的交还」，纯 `@用户`（无接手）仍照旧收尾（单测固定该边界）；
- `acceptedByAgent` 以成员为准后，前端 `HandoffBar` 会渲染成员胶囊而非「你的回合」——「派发生效」在 UI 上直接可见（对齐真实执行）。

## 被否决的方案

- **解析层：mentions 非空时忽略 `@用户`**：交还语义是全局基础设施（ADR 4），在解析层做特例影响面过大，且「@用户 + 派发」并存时用户确实期待看到报备；
- **同条消息冲突时告警**：无实际处理路径（告警后仍要二选一），不如按「派发优先」定则收敛；
- **合并层保留 accepted 但维持交还**：队列被清空后 accepted 无处安放，等于把丢弃从 scheduler 挪到 engine。

## 适用与失效条件

- 适用：`mergeWaveSchedule` 全部调用路径（串行单成员波 / 并行多成员波 / rounds 场景）；
- 失效条件：无（该定则为引擎不变量；若未来引入「显式取消派发」语义，需以显式信号（如取消工具）表达，而非依赖 `@用户` 的副作用）。
