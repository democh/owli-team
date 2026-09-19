# ADR 0179：M45 轻回放——波次回放条（R-1 落地；R-2 条件未触发；R-3 收敛）

- 状态：Accepted
- 引入：批八 M45 轻回放（2026-09-19）
- 相关：[design.md §108](../design.md)、[docs/scene-chat-design.md §13](../scene-chat-design.md)（M45 原案；ADR 0081 预定口径落地）、[client/src/lib/wave-replay.ts](../../client/src/lib/wave-replay.ts)、[client/src/components/chat/WaveScrubber.tsx](../../client/src/components/chat/WaveScrubber.tsx)、[client/src/lib/chat-rows.ts](../../client/src/lib/chat-rows.ts)（waveOf 同源）、MessageRail（M37-7，跳转先例）

## 背景

- M45 原案（scene-chat-design §13，条件性）：R-1 波次回放条 · R-2 互动统计后端化（条件）· R-3 面板联动扩展；
- ADR 0081 预定口径：**轻回放只做波次级跳转**——以消息结构派生波次列表，底部 scrubber 跳转 = focusMessage（不重建历史 UI 状态）；被否决：全状态时间旅行；
- 既有设施：`deriveRows` 的 `waveOf`（每行所属波次，含 wave-sep 归属）· `focusMessage`（滚动 align:center + 闪光 `.msg-flash` 1.9s）· MessageRail（≥20 条导航，先例）；
- 本次推进决定：R-1 落地；R-2 触发条件（跨会话统计需求 / 审计要求）未出现——不落；R-3 面板联动已由既有「定位」模式普遍化覆盖（pool / console / 工序卡等）——收敛声明。

## 决策

1. **派生（纯函数 `wave-replay.ts`）**：
   - `waveNodesOf(waveOf)`——唯一 `runId~turnIndex` 首次出现序（wave-sep 行与成员行同源，去重）；**单条波次（单成员消息）同样成节**（回放粒度是「波」，与并行组与否无关）；锚点 = 本波首条成员消息 id；空锚点跳过；
   - `activeWaveIndexOf(waveOf, firstVisibleRow)`——首个可见行起向前扫描的首个波次序号（与悬浮阶段条 currentWave 同源口径）；
2. **呈现（`WaveScrubber`，ChatArea 底部 Composer 之上）**：
   - **≥2 波时呈现**（单波无回放价值；0 波不渲染）；常驻细条：`回放` 前缀 + prev/next + 刻度（1..N 数字圆点）+ 计数（`第 x/N 波` / 无活跃时 `共 N 波`）；
   - 点刻度 / prev / next → `focusMessage(锚点)`——滚动 + 闪光复用，**不重建历史 UI 状态**（ADR 0081 边界；虚拟列表不变、流式不变、本地态不变）；
   - 当前波高亮（`data-wave-current`）+ `is-current` 样式；prev/next 端点禁用（无活跃序号时双端禁用）。
3. **连点节流（`createTrailingThrottle`）**：leading + trailing（默认 150ms）——首次点选立即跳（即时感），窗口内连点合并为尾沿一次（取最新参数）——避免 focusMessage 机关枪；组件卸载 cancel。
4. **R-2 / R-3 处置**：R-2 维持条件性（触发出现时按 §13.2 ADR 0082 路径另立：仅本地互动态被证明确需跨会话聚合才落 `interactions` 表 + API）；R-3 声明为**既有覆盖**（「场景卡 → 面板定位」已由各面板定位按钮与 pool 定位普遍化，不另建新机制）。

## 理由

- **锚点取「首条成员消息」而非波次分隔行**：分隔行是展示附属（deriveRows 行结构），消息 id 是稳定持久锚点——focusMessage 经 rows 反查（`r.kind === 'wave' ? r.ids.includes(id)`）两种都能命中，但消息 id 在缓存/回源扩展上更稳；
- **单条波次成节**：大量场景为串行链（每成员一波）——若只收并行组则多数会话回放条只有零星刻度，与真实节奏感知不符；
- **≥2 波门槛**：单波会话（一次问答）无导航意义，避免常驻噪声；这也与 wave-sep 的插入门槛（≥2 波次起点）同源；
- **数字圆点而非进度条拖拽**：波次是离散节点（点击跳转），拖拽 scrubber 的连续语义在此不成立（原案「scrubber」的轻量化兑现）；连点保护用节流解决而非禁用交互；
- **不重建历史 UI 状态**（ADR 0081）：跳转只滚动 + 闪光——历史消息是同一虚拟列表的同一状态，无快照/回放状态机，成本与风险最低（作品态回放明确另行立项）。

## 被否决的方案

- **全状态时间旅行 / 快照回放**：原案已否（成本高、状态面大；轻回放的定位是导航不是放映）；
- **播放/暂停连续回放**：需要定时器驱动 + 播放态管理——轻回放不做「放映机」；
- **拖拽 scrubber（input range）**：离散波次 + 虚拟列表滚动中拖拽的手感与命中都不稳；点选 + prev/next 已覆盖；
- **锚点用波次分隔行 key**：分隔行不承载交互（deriveRows 约束），且 key 为派生值非持久锚点；
- **R-2 提前落库**：触发条件未出现（原案明确），提前落库违反条件性纪律。

## 边界与失效条件

- 测试锚点：`data-wave-scrubber` / `data-wave-tick` / `data-wave-current` / `data-wave-prev` / `data-wave-next` / `.wave-scrubber-count`；`.wave-scrubber*` 样式族；
- 呈现门槛 ≥2 波；`listMode` 等既有 ChatArea 分支不变（scrubber 仅在标准消息流模式挂载，随 Composer 区域）；
- E2E 口径记录（踩坑沉淀）：并行场景 E2E 需 `disableSerial`（会话级串行默认开启，波次逐位出场）+ **全员 @** 才收敛为严格单波；短会话 `focusMessage` 的 align:center 可能使首波仍在视野 → 活跃序号钉在第一波——相关断言应以「跳转触发 + 闪光」为准（端点/相邻语义归单测）；
- 若未来引入「作品态回放」（快照/状态机），本轻回放口径保持（导航层），新范式另行立项（ADR 0081 边界维持）。
