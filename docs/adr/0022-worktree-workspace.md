# ADR 0022：worktree 工作区隔离

- 状态：Accepted
- 引入：M6
- 相关：[design.md §8](../design.md)、[api.md §2](../api.md)、ADR 14

## 背景

`repo` 模式（直接挂载真实仓库）让 Agent 在主分支工作区直接改文件：任何失误（误改 / 误删 / 半成品提交）都会污染用户的工作区。需要一种「改真实代码但零污染」的机制。

## 决策

**worktree 模式（推荐默认）**：基于 `git worktree` 的会话级隔离——

- 创建会话时：`git worktree add data/worktrees/<sessionId> -b agent/<sessionId>`（基于 `HEAD` 或项目 `baseBranch`）；
- 工具工作区根 = worktree 路径（`resolveInRoot` 的 root 动态化）；git worktree 与主仓库共享对象库但独立工作目录与分支；
- 改动**只落在 `agent/<sid>` 分支**，主分支不受影响；
- 生命周期动作：查看改动（`GET /worktree` 含 diff）、合并回主仓库（`POST /worktree/merge`，**必须 `confirm=true`**）、丢弃（`POST /worktree/discard`，删目录 + 删分支）；
- 删除会话时默认丢弃 worktree（`keepWorktree=true` 可保留）；丢弃失败时保留会话（避免留下无法追踪的 worktree）；
- 合并操作经 M7 审批语义（ADR 23）+ 前端二次确认。

## 理由

- worktree 是 git 原生机制：不需要复制仓库（共享对象库，秒级创建），隔离性由 git 保证；
- 「agent 分支」让改动可 review（diff 即交付件，ADR 17）、可回滚（丢弃即洁净）；
- 相对 repo 模式，用户在合并前有天然的检查点。

## 被否决的方案

- **repo 模式直接改**：无检查点，误操作直接伤及用户主分支；
- **整仓 clone 到沙箱再同步**：磁盘与同步成本高，偏离用户真实仓库状态。

## 影响

- 系统要求安装 `git`；非 git 目录建 worktree 会话会失败并回滚（400 提示）；
- 前端 WorktreeBar 展示模式 / 分支 / diff 与三个动作按钮；
- 测试覆盖：隔离性（主分支不受影响）、路径注入防护、diff 三模式。
