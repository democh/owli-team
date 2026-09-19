# ADR 0163：核心交付锚点——锚点选择 · 钉选本地存储 · 锚定条（AF-1）

- 状态：Accepted
- 引入：M44 核心交付锚点范式（2026-09-19）
- 相关：[design.md §101](../design.md)、[docs/scene-chat-design.md §12](../scene-chat-design.md)（M44 原案；决策项 0078 落位）、ADR 0123（交付清单分层——重要度排序复用）、ADR 0065（悬浮条先例）、[client/src/lib/focus-artifact.ts](../../client/src/lib/focus-artifact.ts)、[client/src/lib/artifact-versions.ts](../../client/src/lib/artifact-versions.ts)、[client/src/components/chat/FocusBar.tsx](../../client/src/components/chat/FocusBar.tsx)

## 背景

- M44 原案定义 AF-1 交付锚定条：「核心交付：需求.md · v3 · 修改者头像流 · 未闭环意见 2」；hover 展开版本线；无交付件→隐藏；多件→钉选切换；
- 原案决策项 0078：锚点 = 自动候选 + 手动钉选，本地存储；**不落库**（视图偏好非会话语义）；会话删除清理本地键；
- 现状：交付件只在消息内（DeliveryFiles / 收尾清单）可见——长会话滚离交付时点时，用户失去「本轮核心产出是什么、改到第几版」的常驻读数。

## 决策

1. **锚点选择（纯函数 `pickFocusPath`）**：手动钉选（localStorage `ma:focus-artifact:<sessionId>`）**且仍存在于交付件集合**时优先；否则按 `partitionDelivery`（ADR 0123 重要度：文档 > 图示与页面 > 媒体 > 源码 > 数据；过程产物剔除）取首个；无交付件 → undefined（锚定条隐藏）。
2. **钉选存储**：localStorage（视图偏好，跨刷新保留、不进导出、不落库）；点击候选再点即取消钉选（toggle）；会话切换重读。
3. **锚定条（FocusBar）**：
   - 定位：对话区左上角常驻轻量药丸（M37 悬浮条机制同层：`pointer-events-none` 外层 + 药丸自身 `pointer-events-auto`）；药丸读数 = 核心交付名 + vN + 修改者头像流（版本作者去重 ≤3）+ 未闭环意见计数（>0 才显示）；
   - 悬浮展开面板：版本线（vN + 作者 + 时间 + 体积，上限 6 条）· 未闭环意见列表（可「标记已满意」本地排除，上限 3 条）· 钉选候选（多件时，上限 4 条）· 操作（查看 Diff / 提意见）；
   - 隐藏条件：无交付件 / 纯列表模式（listMode）/ 窄屏（ctx.narrow）——零干扰口径。
4. **版本数据（`useArtifactVersions`）**：共享缓存 hook（zustand，与 use-artifact-meta 同构）——键（会话 + artifactVersion + 路径），复用既有 `GET /api/sessions/:id/artifacts/versions`；失败静默（undefined → 降级「仅文件名」，不阻塞渲染）。

## 理由

- **重要度排序复用而非再造**：partitionDelivery 已是「最终交付优先」的单一事实源（ADR 0123），锚点自动候选与它同源，避免两套「什么算核心」的判断；
- **不落库**：锚点是「这一屏该盯哪个文件」的视图偏好——落库会把偏好升格为会话语义（ADR 0078 已否决）且引发多用户可见性设计问题；
- **左上角而非顶部居中**：顶部居中被 M37 悬浮阶段条占用；左上角与消息头区自然共生（消息在左），不抢读数动线；
- **版本读取走共享缓存**：锚定条、变更卡、签收块三处消费同一版本数据——一个 hook 三个消费点，防止三份实现漂移。

## 被否决的方案

- **锚点落库（会话字段）**：视图偏好非会话语义；多用户共享会话下「谁的锚点」无解；
- **「最高频修改路径」自动候选**：需要为全量交付件预取版本列表（N 次请求）才能统计频次——重要度排序已覆盖「哪个更核心」的意图，零额外请求；
- **锚定条顶部居中 / 底部右角**：与阶段条 /「回到最新」按钮互斥；底部是输入区动线；
- **悬浮面板用 Radix Tooltip（无自身状态）**：面板含可交互元素（标记已满意 / 钉选）——Tooltip 内容不可交互；改用 hover 展开的受控面板（`data-focus-hover` 锚点，进入面板不关闭）；
- **钉选进 localStorage 全局键（不带 sessionId）**：跨会话串态，违背 M38/M44 本地键的会话隔离口径。

## 边界与失效条件

- `data-focus-bar / data-focus-version / data-focus-open-count / data-focus-panel / data-focus-hover / data-focus-satisfy / data-focus-pick / data-focus-action` 为测试锚点（语义变更须同步 E2E/单测）；
- 版本接口失败 / 未返回 → 药丸无 vN、面板「版本信息加载中…」——功能降级不阻塞；
- 会话删除后的残留本地键（钉选 / 已满意 / 签收）不构成数据泄漏（仅本地标识集合）；若要接入跨设备同步需另立（本 ADR 不承诺）。
