# ADR 0017：交付件浏览——主区 Tab（+版本 Diff）

- 状态：Amended（M8 起增加版本 Diff 视图与 repo 模式语义）
- 引入：v1 决策，M8 修订
- 相关：[design.md §22](../design.md)、[api.md §6](../api.md)、ADR 14

## 背景

Agent 写出的文件（交付件）需要浏览入口。备选：右栏面板、独立页面、聊天区顶部主视图 Tab。

## 决策

**聊天区顶部主视图切换「对话 | 交付件 (N)」**（v1）：左文件树 + 右预览面板；消息内交付件 chip 点击直达定位。

**M8 修订**：

- 新增 **Diff 视图**：`GET /api/sessions/:id/artifacts/diff?path=&from=&to=` 返回 unified diff，前端自研行级渲染（行号 + 增删色 + 折叠未变区块），版本列表来自 `artifact_versions` 表；
- **repo / worktree 模式下交付件语义 = git 变更集**（而非新文件列表），`source` 字段区分 `files | git`。

## 理由

- 交付件是「协作成果」与聊天同等重要：主视图级入口比右栏小面板更匹配其地位；
- 会话运行中需要边聊边看产出，同屏并列（Tab 切换保留滚动位置）优于跳页；
- 版本 Diff 让「模型这轮改了什么」可核对——这是真实仓库场景的刚需（配合 ADR 22 的改动隔离）。

## 被否决的方案

- **独立页面**（`/#/artifacts`）：脱离会话上下文，来回跳转成本高；
- **仅右栏面板**：预览区域太小，Markdown / 代码阅读体验差。

## 影响

- 交付件写入触发 `artifact:updated`（SSE/WS）→ 树局部刷新 + 当前文件「已更新 · 点击重载」提示；
- 消息 `artifacts: string[]` 随消息持久化，历史会话无需重扫即可渲染 chip。
