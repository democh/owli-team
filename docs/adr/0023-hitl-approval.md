# ADR 0023：HITL 审批——request_approval + 挂起恢复

- 状态：Accepted
- 引入：M7
- 相关：[design.md §9](../design.md)、[api.md §7](../api.md)、ADR 14、ADR 22

## 背景

工具集具备真实副作用后（`git_commit` / `run_command` / 覆盖写文件 / 敏感文件读写），全自动执行风险不可接受；但一刀切禁止又会砍掉核心场景。需要「危险动作必须有人点头」的机制。

## 决策

**人在环路（HITL）审批**：

- **工具侧**：`request_approval(action, detail, options[])` 工具；高风险工具（`git_commit` / `run_command` / 覆盖写已有文件 / 敏感文件读写）在执行前自动触发；
- **挂起恢复**：引擎 publish `notify:approval-requested`，Run 置 `awaiting_approval`（落盘），以 Promise 表挂起等待；决定后 Promise 恢复——批准继续执行，拒绝 / 自定义反馈以 `role: 'tool'` 回灌让模型改方案；
- **接口**：`POST /api/runs/:runId/approvals/:approvalId`，body `{ decision: 'approve' | 'reject' | 'custom', feedback? }`（custom 必附 feedback）；`GET /api/runs/:runId/approvals` 供 SSE 重附着恢复审批卡状态；
- **超时**：`APPROVAL_TIMEOUT_MS=600000`，超时视为拒绝并回灌「用户未响应，请改换方案」；
- **策略**：`APPROVAL_MODE=off | risky | all`（默认 `risky`）；`APPROVAL_TOOLS` 可追加强制审批工具。

## 理由

- 审批是「工具在跑、人在看」的自然中断点：挂起 Promise 而不终止 Run，批准后无缝继续，上下文无损；
- 回灌拒绝反馈（而非静默失败）让模型有机会自我修正——「用户拒绝了 git commit，因为提交信息不规范」比「审批失败」信息量大得多；
- 分级策略（off / risky / all）让演示与重管控场景各取所需。

## 被否决的方案

- **拒绝即终止 Run**：用户拒绝一次提交就要重新发起整个任务，代价过高；
- **纯前端拦截**（不落服务端状态）：刷新 / 断线后审批状态丢失，Run 永久挂起。

## 影响

- 前端审批卡（M8）：展示 action、命令原文 / 文件 diff 与三个动作（批准 / 拒绝 / 自定义反馈）；
- 审批记录落表，`GET /api/runs/:runId/trace` 可见审批事件（ADR 26）；
- 测试覆盖：批准 / 拒绝 / 超时 / 并发审批（18 例）。
