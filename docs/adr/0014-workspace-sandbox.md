# ADR 0014：工作区沙箱（+ALLOWED_ROOTS / repo / worktree）

- 状态：Amended（M6 起扩展项目挂载与 worktree 模式）
- 引入：v1 决策，M6 修订
- 相关：[design.md §22](../design.md)、[operations.md §5](../operations.md)、ADR 22

## 背景

Agent 的工具（读写文件 / 检索）需要限定作用范围，防止越权访问用户文件系统。

## 决策

**沙箱根 = `workspace/<sessionId>/`**（v1）：

- 所有文件类工具的路径经 `resolveInRoot` 归一化 + 前缀校验；
- 拒绝符号链接逃逸（`PathEscapeError`）；
- 每会话独立目录，删除会话时可选择连工作区删除。

**M6 修订**：引入 Project 实体与三种工作区模式——

- `sandbox`（默认，行为同 v1）；
- `repo`：直接挂载真实仓库目录；
- `worktree`：git worktree 隔离（推荐，见 ADR 22）；
- 挂载根必须在 **`ALLOWED_ROOTS` 白名单**内（逗号分隔；留空 = 仅限 `workspace/` 内），否则 `400`；
- 敏感文件（`.env*` / `.ssh/**` / `*.pem` / `id_rsa*` / `.git/config`）默认拒绝读写；`ALLOW_SENSITIVE=true` 放开后仍强制审批（ADR 23）。

## 理由

- v1 沙箱保证「模型无法碰用户真实文件」；但「能真干活」需要操作真实代码库，一刀切沙箱会挡住核心场景；
- 白名单 + 工作区模式分级让用户显式选择风险级别，默认值仍是安全沙箱；
- worktree 模式把风险进一步收窄到独立分支（ADR 22）。

## 被否决的方案

- **任意路径挂载**：一行配置事故即可让模型扫盘 / 改写系统文件；
- **只保留沙箱**：无法满足「让 Agent 改真实仓库代码」的核心诉求。

## 影响

- `resolveInRoot` 的 root 动态化（按会话解析工作区模式）；
- 交付件语义随之分级：sandbox = 文件列表，repo/worktree = git 变更集（ADR 17）。
