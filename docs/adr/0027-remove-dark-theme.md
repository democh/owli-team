# ADR 0027：移除深色主题（回归仅浅色）

- 状态：Accepted（取代 [ADR 0024](0024-dark-theme.md)）
- 引入：M11
- 相关：[design.md §10](../design.md)（§10.1 / §12.2 / §17 / §22.5）、ADR 16 / 24

## 背景

M8 引入双主题（ADR 24，取代 ADR 16 的「仅浅色」）。M11 产品侧确认：实际使用中不需要暗黑模式——单人本地协作工作台以浅色为唯一形态，维护双套 token、双主题高亮缓存 key、切换入口与主题测试的边际成本不再划算。

## 决策

**回归仅浅色（单主题）**：

- 移除 tailwind `darkMode: 'class'`、CSS `.dark` token 块与 `.dark` 适配样式；
- 移除 `html.dark` 切换逻辑（ui-store `Theme` 类型 / `applyTheme` / `setTheme`）与顶栏切换按钮；
- shiki 高亮固定 `github-light`（删除 `activeShikiTheme` 运行时判定，缓存 key 使用常量 `SHIKI_THEME`）；
- 清除组件中的 `dark:` 变体类；原主题测试精简为密度测试（`density.test.ts`）；
- 废弃偏好持久化键 `ma:theme`（残留值读取即忽略）。

## 理由

- 单用户本地工作台，界面形态收敛为浅色可显著降低样式分支与测试成本（每个语义 token 不再需要双值校对、逐组件 `dark:` 评审）；
- 与「安静模式 / reduced-motion」动效降级策略无关，本变更不触动动效体系。

## 被否决的方案

- **保留双主题但不维护**：状态不明，后续改动持续背上 `dark:` 兼容负担；
- **仅隐藏切换入口**：死代码（`.dark` token 块、shiki 双主题初始化）继续误导维护者。

## 影响

- design.md §10.1 / §12.2 / §17 / §22.5 同步更新（去掉深色相关描述）；
- ADR 16 / 24 归档为历史存档，行为以本 ADR 为准；
- 未来如需暗黑模式，应从 token 体系直接重建（而非恢复本 ADR 移除的增量分支）。
