# ADR 0149：生产型场景渲染包——阶段映射表 · 悬浮条场景化 · 波次网格（DEV-1 / SR-1 / MK-1）

- 状态：Accepted
- 引入：M39 生产型渲染包（2026-09-19）
- 相关：[design.md §97](../design.md)、[docs/scene-chat-design.md §7](../scene-chat-design.md)（M39 原案）、ADR 0065（悬浮阶段条先例）、ADR 0112（四形态容器）、[client/src/lib/stage-map.ts](../../client/src/lib/stage-map.ts)、[client/src/components/chat/WaveStrip.tsx](../../client/src/components/chat/WaveStrip.tsx)、[client/src/components/chat/WaveGroup.tsx](../../client/src/components/chat/WaveGroup.tsx)

## 背景

- M39 原案（scene-chat-design §7）定义三项「结构化换显示」能力：DEV-1 交付流水线阶段条、SR-1 事故阶段条（悬浮条换显示：阶段名 + 进度段）、MK-1 波次网格（marketing/health 同波 2–4 条 → 2 列）；均未落地；
- 现状：悬浮阶段条恒显「第 N 波 · 共 N 波」（对研发/事故这类**有稳定工序语义**的场景，波次号不如阶段名可读）；WaveGroup 恒纵向单列（营销 / 健康场景同波并行产出在宽屏下浪费横向空间）；
- 原案决策项 0069（阶段映射表落点）待落位：映射是**渲染知识**，不应塞进 `_group.yaml` 资产（资产是服务端语义）。

## 决策

1. **阶段映射表落点**：集中新文件 `client/src/lib/stage-map.ts`（前端常量表）——
   - `development`：`order = [需求, 架构, 设计, 前端, 后端, 测试, 部署]`（七段主链 pm → devops）；旁路角色折入相邻段（ux-researcher / ux-writer → 设计；ai-engineer / data-engineer → 后端；security → 安全、tech-writer → 文档——不在 order 内时只显示标签、不计进度）；
   - `sre`：`order = [分级止血, 回滚, 修复, 回归, 复盘]`（sre → 分级止血、devops → 回滚、backend → 修复、qa → 回归）；
   - 纯函数 `stageOf`（角色 → 阶段名）与 `waveStage`（波次成员集合 → 去重按序标签 + 进度段 `x/y`）；未收录场景 / 全未映射 → `undefined`（调用方回退）。
2. **悬浮条场景化（DEV-1 / SR-1）**：`WaveStrip` 新增 `group` prop（ChatArea 传 `sceneGroup`）——命中阶段映射时药丸换显示为「阶段名（多段以 `·` 连接）· 阶段 x/y」；未命中沿用「第 N 波 · 共 N 波」与「共 N 波」读数（口径零变化）；`title` 同时保留波次与阶段（`跳到第 N 波起点（阶段名）`）；新增测试锚点 `data-wave-stage`。
3. **波次网格（MK-1）**：`WaveGroup` 布局选项——`marketing / health` × 同波 **2–4 条** × 非窄屏 × 非对决 → 内容区 2 列网格（`grid-cols-2` + `data-wave-grid` 锚点）；单条 / 5 条以上 / 窄屏 / 其他场景回退纵向单列（现状口径）；对决（PK）与网格互斥（duel 优先）。

## 理由

- **渲染知识进前端常量表**：角色→阶段名是「怎么看」而非「怎么协作」——进 `_group.yaml` 会污染服务端资产语义（并在 check:agents / m21 断言面上引发连锁）；新场景在表内扩展即可，零资产成本；
- **换显示而非增显示**：悬浮条是低干扰读数，双行 / 双读数会加重视觉负担——替换波次数字为阶段名，波次信息退入 `title`；
- **2–4 条是网格可读窗口**：单条无需分栏；5 条以上 2 列会产生参差高与阅读断裂（营销波通常 3–4 人同波）；窄屏维持纵向单流（既有降级契约）。

## 被否决的方案

- **映射表进 `_group.yaml`**：污染资产语义（服务端只用 chain/agenda/stage，不消费阶段名），且引发资产校验 / 测试面连锁改动；
- **映射表进服务端（随会话下发的角色元数据）**：渲染知识服务端化，跨端负担为零收益；热更新优势不存在（前端常量随构建即最新）；
- **悬浮条「第 N 波 + 阶段名」双读数**：低干扰读数双段化违背设计初衷（M37-3/ADR 0065 的轻量药丸口径）；
- **全场景网格化（按条数统一）**：研发/研讨等场景的波次语义是「接力 / 研讨」而非「并列产出」，网格化会改变阅读节奏——按场景定制（不搞一刀切，M51–M52 原则复申）；
- **网格改为 CSS auto-fit 自适应列数**：营销波人数不定，自适应会产生 1–4 列跳变，卡片宽度不可预期。

## 边界与失效条件

- 阶段映射表为**单点扩展位**：新增生产型场景（如未来 platform）在表内加一条即可；未收录场景行为与现状完全一致；
- `waveStage` 的进度段取「标签在 order 中的最大序号」（并行波以最靠后阶段为准——与工序推进直觉一致）；order 外的标签（安全 / 文档）只显示不计进度；
- 网格阈值为常量（2–4 条 × marketing/health）；若真实使用证明其他场景需要，按同表扩展；对决 / 窄屏优先级高于网格。
