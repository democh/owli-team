# ADR 0115：圆桌会议范式——容器族驱动 · 议题进度容器化 · 派活确认制（M42）

- 状态：Accepted
- 引入：M42
- 相关：[design.md §71](../design.md)、[docs/scene-chat-design.md §10](../scene-chat-design.md)、ADR 0112（场景工作区体系：roundtable 形态与结构键契约）、ADR 0064（交互卡片回填 = 草稿）、ADR 0034（Markdown 容器语法与包体纪律）、ADR 0116（纪要容器 @ 转交豁免）、[client/src/lib/meeting.ts](../../client/src/lib/meeting.ts)、[client/src/components/chat/md-ext/MeetingCard.tsx](../../client/src/components/chat/md-ext/MeetingCard.tsx)、[client/src/components/scene/RoundtableStage.tsx](../../client/src/components/scene/RoundtableStage.tsx)、[server/src/llm/mock.ts](../../server/src/llm/mock.ts)

## 背景

- §10（RT-1..RT-5）规划了圆桌会议范式：会议声明卡 / 席位环 / 议题进度 / 纪要卡 / 散会胶囊——彼时以 ADR 0073 / 0074 预定号规划（该区间已被后续批次占用，编号让位后并入本 ADR）；
- M52-A（ADR 0112）已交付 roundtable 形态（席位环 + 汇聚板 + 议程条），但议程条仅有「波次驱动」的进度（前 N-1 步 done、当前步 doing），会议语义（声明议题 / 逐项推进 / 收尾 / 派活）无形态承载；minutes 容器已在 M41（OP-1 三栏纪要）落地，但缺少会议链路的开场声明与进度闭环；
- `docs/scene-expansion-design.md` 规划 M42 与 roundtable 合流——把「会议」实现为「roundtable 形态 + 协议容器族」，而非新造一个会话模式或独立布局；
- 约束（ADR 0112 同源）：形态层纯前端派生，不改消息数据层与虚拟列表结构键契约；容器语法沿用 ADR 0034（remark-ext builder + React 卡片 + fail-safe 降级）。

## 决策

1. **会议范式 = 协议容器 + 场景形态驱动，不引入会话级开关**：`::: meeting` 容器在消息内呈现会议声明卡（任意场景），议题进度容器化仅在 roundtable 形态生效（`RoundtableStage`）；不新增 `session.roundtable` / `mode: 'meeting'` 状态位——行为语义（谁发言 / 几轮 / 何时收尾）由协议与编排决定，前端只呈现（沿用原 RT-1 决策的口径）。
2. **容器族语法与卡片**：`::: meeting [标题]` 条目 `- [x] / - [>] / - 项` 三态（已决 / 进行中 / 待议）；`::: minutes [标题]` 条目 `- 键 | 值`，键 ∈ {决议 / 待办 / 风险}（未识别键归决议栏，空栏占位）。remark-ext 侧转 `data-items` JSON，React 侧 `MeetingCard` / `MinutesCard` 同构解析（与 `lib/meeting` 纯函数同源）；未闭合容器不剥离（fail-safe，按普通段落渲染）、解析失败 / 空条目 → raw 静态兜底。
3. **议题进度「容器更新优先，本地勾选兜底」**（RT-3）：`RoundtableStage` 合并会话内全部 `meeting` 容器（后声明的显式态覆盖、todo 不覆盖、新标签按首见追加）；本地勾选存 `sessionStorage ma:meeting:<sessionId>`（不落库，ADR 0064 同源）；运行中首未决项点亮 doing；heading 显示「议题 x/n · 当前：XXX」/「议题 n/n · 已全部议决」；点击议题定位议题头词首条成员发言（无则回退会议声明消息）。无会议容器时回退 M52-A 波次驱动（零回归）。
4. **派活 = 草稿回填（复用 ADR 0064）**：待办行 `@负责人 事项` 解析出负责人后整行可点 → `composerInsert('@负责人 ')`，只写草稿不直发；出勤成员显示头像、非出勤 / 无资产首字回退；流式期间派活行禁用（防与插话歧义）。
5. **散会胶囊（RT-5）为尾条派生**：运行未活跃且末条非 system 消息为含 `::: minutes` 的成员消息时，渲染「散会 · 会议已收尾」静态事件条（无点击）；订阅按「尾条指纹 id~role~status」隔离，流式 delta 不触发本组件重渲染。
6. **引擎侧转交语义修订**：`::: minutes` 容器内的 `@成员名` 是派活锚点，不构成对成员的即时应答转交（决策与理由见 ADR 0116）——协议约定「转交须单独起一行」由此在解析层获得单一事实来源。
7. **协议与 mock 链路**：strategy / brainstorm 协议新增例会纪律（主持人开场声明 → 成员逐项逐字回标 → 末位回交主持人 → 主持人收尾出纪要并单独一行交还用户；待办 @ 为派活锚点）；mock 脚本化例会链路（触发词「例会」+ 主持人在场，5 波串行），eval 新增 `opc-weekly-review` 用例（turns_lte 5 / 交还用户 / 无循环）。

## 理由

- **形态合流而非新造**：roundtable 的席位环 / 汇聚板 / 议程条恰是会议的空间隐喻；报告型 agenda（波次）与会议型 agenda（议题）切换由「容器是否出现」判定——容器天然是「本次会议」的范围声明，无需会话开关；
- **自描述容器**（ADR 0034 / 0062 同口径）：`::: meeting` / `::: minutes` 可被任意模型输出、前端纯派生渲染，且逐字回标 `- [x] <议题原文>` 使进度**可核**（协议要求逐字，合并按标签精确匹配）——比「轮次计数」式的隐式推导更稳；
- **本地勾选兜底**与 ADR 0064 一致：会议进度是视图态而非会话语义——用户手动勾选存本地、容器一旦显式回标即覆盖本地；不落库带来零迁移成本与零并发冲突；
- **派活走草稿**：@负责人 语义上既可能是「派活」也可能是「转交」，把发送权留给用户（草稿可编辑 / 可放弃）避免角色被意外召唤入队；与 checklist / 裁决卡等全部交互卡的既有语义统一；
- **散会胶囊派生自尾条指纹**：会议收尾的判据（尾条含 minutes + 运行收束）无需新增字段或状态机，与收尾清单（ADR 0092）同口径；指纹隔离使流式期间零额外渲染。

## 被否决的方案

- **会话级会议开关（`session.roundtable` / `mode: 'meeting'`）**：会话语义位需要协议、编排、UI 三侧同步维护，且与「容器自描述」的既有路径分裂；原 RT-1 规划即已否决（类比 planFirst），本批维持；
- **独立会议悬浮层 / 新布局**：席位环与波次悬浮条已有同源挂载点（ADR 0112 roundtable 形态），换皮肤即可覆盖会议语义；独立层会复制滚动派生与窄屏降级逻辑；
- **纪要待办 @ 保持「转交」语义（或改 mock 待办格式规避）**：违反 RT-4「用户确认后派活」的契约与协议 `@负责人` 展示格式；且真实模型会输出同构文本，格式规避只对 mock 有效——选择在解析层豁免（ADR 0116）；
- **把会议议题状态放进容器 JSON（显式状态数组）**：模型输出成本与出错面高；`- [x]` 逐字回标是 Markdown 原生语法，且 remark-ext / 卡片 / 进度合并三侧已同构解析；
- **议题进度用独立导出/接口维护多容器合并结果**：数据已在前端消息流（`useSceneMessages` 500ms 节流 + 流式冻结），服务端接口收益为零（ADR 0112 约束）；
- **派活直接发送消息**：绕过用户确认把「派活」变成「召唤」，与 ADR 0064 全面冲突（checklist / 裁决 / 议程模板全部只写草稿）。

## 适用与失效条件

- 适用：`::: meeting` / `::: minutes` 容器可被任意场景输出（卡片渲染为全局能力）；`lib/meeting` 的解析 / 合并 / 进度纯函数与 `MeetingCard` / `RoundtableStage` / `AdjournPill` 共用同一数据源；mock 例会链路与 eval 13 同构；
- 失效条件：容器语法升级（嵌套 / 新键 / 新三态）须三侧（remark-ext / 卡片 / 进度合并）同步复核；`stripMinutesBlocks`（ADR 0116）与 remark-ext 容器正则为同源契约，容器正则调整须联动；若未来引入「会议持久化 / 会议列表」等会话语义，则需重审「不引入会话级开关」的边界；§10 规划的 RT-2 席位环早已由 roundtable 形态承担，若席位环挂载点变更（ADR 0112 修订）须复核本范式对形态的依赖。
