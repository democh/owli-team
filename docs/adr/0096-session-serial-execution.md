# ADR 0096：会话级串行执行（Session Serial Execution）

- 状态：Accepted
- 引入：M46-2
- 相关：[design.md §55](../design.md)、[shared/src/types.ts](../../shared/src/types.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[server/src/orchestration/scheduler.ts](../../server/src/orchestration/scheduler.ts)、[client/src/components/team/TaskView.tsx](../../client/src/components/team/TaskView.tsx)、ADR 3（顺序执行）、ADR 33（并行波次：显式触发、默认串行）

## 背景

- 并行波（ADR 33）下，同波成员**互不可见对方当前输出**（上下文隔离 §29，基于波前历史装配）：后续成员看不到前一成员刚落盘的交付件，出现「红队报告写『点子池尚未落盘（工作区当前为空）』」式的交付件脱节；
- 场景 `parallelMax > 1` 时用户显式 `@≥2` 即触发并行成波，多条消息并发涌入信息流，用户难以逐条跟进（「并行太快，不便于查看」）；
- 需要一条**会话级**的、默认收敛的开关：默认逐位出场（前序产出可见、消息按序可读），需要速度时再显式放开。

## 决策

1. **数据模型**：`Session.serial?: boolean`（shared 类型）；迁移 v12 `ALTER TABLE sessions ADD COLUMN serial INTEGER NOT NULL DEFAULT 1`——旧库升级即串行；`createSession` 默认开启（`opts.serial === false` 才关闭）、`PATCH /api/sessions/:id` 可切换（`updateSessionSchema` 加字段）；
2. **引擎收紧**：`runLoop` 波规划 `globalParallelMax: session.serial ? 1 : cfg.parallelMax`——`planWave.capOf` 在 `globalParallelMax <= 1` 时恒返 1，**显式 `@≥2` / handoff 多目标（forceParallel 分支）同样逐位消化**；波内上下文隔离、收口波、合成波、plan / review 等既有编排规则原样生效（串行只限同波人数，不减波次）；
3. **前端开关**：TaskView chips 行「串行执行」芯片（`ListOrdered` 图标；开启态高亮 + 「已开」字样，两个布局分支均渲染）——点按 `PATCH { serial: !session.serial }` + `applySession` + toast（开：「逐位出场，便于跟进查看」/ 关：「同场景成员可并行成波（推进更快）」）；配套修复客户端 `applySession` 的缺省语义字段同步缺陷（服务端以「键缺失」表示关闭，浅合并残留旧值导致芯片不回滚；改为 `serial` / `planFirst` / `memberSouls` 显式覆盖，保留 summary 字段，单测锁定）。

## 理由

- **默认值即产品决策**：默认串行让「前序产出可见 + 消息逐条可读」成为所有会话的基线体验；并行是提速选项而非默认行为，与 ADR 33「显式触发」精神一致且更进一步（连显式 @ 也逐位消化，要并行必须主动关开关）；
- **缓解交付件脱节**：串行下每位成员看到前序全部产出，「点子池未落盘」类错位从机制上消除（而非靠提示词祈祷）；
- **落库显式列**：布尔开关持久化到会话（刷新 / 重连 / 多端一致），不做内存态；DEFAULT 1 让旧库无损升级；
- **改动面收敛**：引擎一行收紧 + 迁移一列 + 芯片一处；scheduler 纯函数零改动（`globalParallelMax` 本就是它的输入契约）。

## 被否决的方案

- **仅前端节流 / 折叠并行消息**：治标不治本——不解决波内互不可见导致的交付件脱节；
- **把并行产出串行渲染（假时序）**：消息顺序与实际执行不符，破坏时间轴回放与图谱推导的可信性；
- **删除并行能力（全局关闭）**：并行仍是真实场景（投研四路独立产出）的提速路径，且是既有特性（ADR 33）；一刀切损失能力；
- **默认关闭（opt-in 串行）**：与用户「不需要并行，便于查看」的诉求相反；默认必须是串行。

## 适用与失效条件

- 适用：全部会话（含 preset 创建）；e2e 并行专项 spec（m16-parallel / m16-brainstorm / m21-opc / m34-invest）显式 `disableSerial` 后再测并行路径，新增 `m16-serial` 固定串行默认与切换；
- 失效条件：无（若产品方向反转，改默认值即可，机制保留）；单测镜像面：m16 / m24 / m34 并行用例显式 `{ serial: false }` 建会话。
