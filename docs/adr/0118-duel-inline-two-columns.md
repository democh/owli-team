# ADR 0118：对决布局单行内二栏——duelSides 分侧与降级口径（M43）

- 状态：Accepted
- 引入：M43
- 相关：[design.md §72.3](../design.md)、[docs/scene-chat-design.md §11](../scene-chat-design.md)、ADR 0112（场景工作区体系：arena 形态与结构键契约）、ADR 0117（PK 显式触发与容器族）、ADR 0119（裁决回填）、[client/src/components/chat/WaveGroup.tsx](../../client/src/components/chat/WaveGroup.tsx)、[client/src/lib/pk.ts](../../client/src/lib/pk.ts)

## 背景

- PK-1 规划「对决组 = WaveGroup 变体（layout='duel'）」：二栏（正/反）+ 组色区分 + 轮次徽章——需要决定分栏发生在哪一层（虚拟列表行内 vs 跨行全局布局）与「谁在左 / 谁在右」的判定口径；
- 结构键约束（ADR 0112 同源）：ChatArea 虚拟列表以「消息组」为行单位，跨行全局二栏会破坏结构键契约（行高测量 / 滚动定位 / 锚定全部依赖单行自包含）——渲染层必须保持「一个波次组 = 一个虚拟行」；
- 分侧数据来源有两类：① 形态声明（`stage.seats.left/right`，辩论场声明 judge/affirmative/negative/evidence 的席位归属）；② 角色姿态（affirmative 天生正方、negative 天生反方）——无声明场景（如头脑风暴的 ideator vs challenger 同波）需要姿态兜底；
- 对抗可能不成立：同波成员全落一侧（或席位表缺一侧）时强行二栏会出现一侧留白——需要明确的降级口径。

## 决策

1. **duel 二栏实现在波次组内部（WaveGroup layout 家族 grid/duel），不跨虚拟行**：`duel = duelSides(...) !== undefined && agentIds.length >= 2`——成立时组内按 left / right 二栏渲染（各自纵向堆叠成员），center 席（judge / evidence 等）不占二栏、渲染于二栏之后；不成立时渲染为普通并行组（零回归）；
2. **duelSides 分侧「席位优先、姿态兜底、全员各就各位、两侧均非空」**：成员依序——在 `stage.seats.left` 中 → 'left'；在 `stage.seats.right` 中 → 'right'；在 `stage.seats.center` 中（显式中轴席，如辩论场 judge / evidence）→ center；否则查 `DUEL_STANCE`（affirmative / ideator → 'left'，negative / challenger → 'right'）；全部未命中的成员计为「无站位」。**任一侧为空、或场上存在「无站位」成员时返回 undefined**（降级普通组）——混合波（如头脑风暴 ideator + challenger + facilitator 全员同波）不成对决，宁可不分栏；
3. **组头呈现**：阶段徽章（`duelPhaseOf`：波序 0 立论 / 1 反驳 / ≥2 修补）+ DuelMeter 计分条（`duelTally`：两侧发言数 / 被响应数，「vs」中轴）；回合轴与计分板的既有形态（M52-A/D）照常；
4. **窄屏（narrow）回退单流**：二栏仅在非窄屏渲染；窄屏走普通组（单流）——二栏在窄容器下不可用（席位栏宽度不足）；
5. **裁决卡（PK-4）挂载于组尾且仅最新波**：`isLatestWave`（order 尾部向前取最后一条 agent 消息 === 本组末尾消息）且非运行中 → DuelVerdictActions（四按钮）；运行中禁用（防与插话歧义，ADR 0119）。

## 理由

- **结构键契约是硬约束**：虚拟列表行高测量 / 锚定 / 滚动定位都以「单行自包含」为前提（ADR 0112 条款与 M52-D 教训）；二栏在行内实现不触任何结构键——跨行全局二栏会破坏滚动锚定与贴底跟随；
- **席位优先是声明优于推导**：`stage.seats` 是场景作者对「谁和谁对决」的显式声明（辩论场左 = affirmative、右 = negative）；姿态表只是无声明时的兜底直觉（ideator 发散 vs challenger 挑刺是头脑风暴的天然对抗）——声明与推导的优先级次序使两组场景（声明 / 未声明）行为可预期；
- **「无站位」成员使对决不成立**（实施期回归甄别，账目见 §72.7）：头脑风暴全员同波（facilitator / ideator / challenger / refiner）曾被姿态兜底误判为对决（二栏拆散并行圆桌，M16 回归失败）——对决的语义是「场上每个人都已占据左 / 右 / 中立席」，存在无站位成员时这是混合讨论而非对决；席位声明场景不受影响（judge / evidence 经 `seats.center` 命中中轴席）；
- **两侧均非空才成立**：同波全落一侧（如两个 ideator 同波）不是对决——强行分栏会给用户「这是对抗」的错误暗示；降级普通组是零成本的正确行为（宁可不分栏）；
- **center 席不占二栏**：judge / evidence 是对决的**中立角色**（主持 / 证据），塞进左/右栏会歪曲其立场语义；渲染于二栏之后保留其在场信息；
- **窄屏回退必要**：二栏的最小可用宽度约 2×280px；窄屏下并排会使消息不可读——单流回退保持内容可读性优先。

## 被否决的方案

- **跨行全局二栏**（对话流整体左右分栏）：破坏结构键契约与滚动体系（ADR 0112 / M52-D 教训），且普通消息无立场无法分栏；
- **独立 arena 渲染路径**（拆流为左右两个独立消息列表）：复制数据层与虚拟列表逻辑（M52-D 曾有双实现的类同问题）；组内分栏复用既有 WaveGroup 结构（零数据层改动）；
- **按 `stage.layout === 'arena'` 强行分栏**（不管成员归属）：无两侧成员时留白 / 误分栏；布局判定必须按「本组成员实际归属」而非场景声明；
- **单侧非空也分栏（另一侧渲染「待发言…」）**：视觉上暗示「另一方会来」但没有成员会来——降级普通组更诚实；「待发言」分支不可达（已按两侧非空收窄）；
- **判决由引擎 / 服务端给出对决成立性**：成立性是**呈现层语义**（消息如何排布），不改变消息数据；前端派生零成本（ADR 0112 / 0117 同口径）。

## 适用与失效条件

- 适用：duel 判定与分侧为纯函数（`duelSides` / `duelPhaseOf` / `duelTally`），与 WaveGroup 渲染共用；`DUEL_STANCE` 姿态兜底适用于所有含 ideator / challenger / affirmative / negative 的场景；存在「无站位」成员、单侧非空、无场景 ctx、窄屏均降级普通并行组（零回归）；
- 失效条件：虚拟列表结构键契约若调整（允许跨行布局），可重审「行内二栏」的边界；`DUEL_STANCE` 是姿态兜底表——新增对抗性角色（如 policy 正反方）须登记，否则该成员计入「无站位」（降级口径为宁缺毋滥，不报错）；席位声明语义若升级（如左侧多席有序）或新增中轴席之外的声明面，duelSides 的判定须复核；窄屏断点调整须复核二栏回退。
