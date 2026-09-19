# ADR 0024：深色主题

- 状态：Superseded → [ADR 0027](0027-remove-dark-theme.md)（M11：产品决策不需要暗黑模式，回归仅浅色）
- 引入：M8
- 相关：[design.md §10](../design.md)、ADR 16 / 27

## 背景

v1 决策「仅浅色」（ADR 16）；M8 前端重构阶段评估：长时间编码场景对深色的需求明确，且语义 token 体系已经成熟。

## 决策

**双主题，浅色为默认**：

- Tailwind `darkMode: 'class'`；补齐全部语义 token 的 `dark` 值（background / card / muted / border / ring / primary 等）；
- 顶栏提供切换入口（ui-store `setTheme`），选择持久化；
- 配套「密度」两档（`compact | comfortable`，CSS 变量驱动）。

## 理由

- 语义 token 体系让补 `dark` 值的边际成本低于 v1 预期：绝大多数组件零改动（用的是 token 而非硬编码色值）；
- 默认浅色保持 v1 用户心智不变，深色是增量选项；
- 与「密度」一起做成 ui-store 的展示偏好，统一持久化。

## 被否决的方案

- **保持仅浅色**（ADR 16 原结论）：需求已被验证为真实，延后收益不再成立；
- **跟随系统自动切换**：保留为后续可选项，当前用显式切换降低不确定性。

## 影响

- 单测覆盖主题切换与持久化；E2E 检查深色下关键视图可读性；
- `prefers-reduced-motion` / 安静模式的动效降级策略在双主题下保持一致；
- ADR 16 归档为 Superseded（历史存档，行为以本 ADR 为准）。
- M11 起本 ADR 亦被 [ADR 0027](0027-remove-dark-theme.md) 取代（产品决策：不需要暗黑模式）。
