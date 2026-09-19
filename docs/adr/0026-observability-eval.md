# ADR 0026：可观测与评测闭环——trace / metrics / eval / feedback

- 状态：Accepted
- 引入：M9
- 相关：[design.md §12](../design.md)、[operations.md §7](../operations.md)、ADR 19、ADR 21

## 背景

「改了 prompt / 调了压缩参数，到底是变好还是变坏」在 v1 无法回答：无执行轨迹、无指标、无回归测试集。系统演进（prompt / 压缩 / 调度策略）需要可被证明的质量信号。

## 决策

**四件套闭环**：

1. **Trace 落库**：`run_events` 表记录每回合 start/end、输入/输出 token、工具调用、压缩事件（含压缩前后 token）、调度决策与理由；`GET /api/runs/:runId/trace` + 前端 TraceDrawer 时间轴；
2. **指标**：`GET /api/metrics/summary`（回合数 / token / 费用 / 工具失败率 / 压缩次数 / 平均回合耗时）+ `GET /api/metrics/tools` + 前端指标面板；
3. **评测框架**：
   - `evals/tasks/*.json`：`{ id, name, participants, prompt, maxTurns, assertions[] }`（断言类型：`artifact_exists` / `artifact_contains` / `run_end_reason` / `turns_lte` / `handoff_targets` / `no_loop` / `token_budget_ok` / `judge(rubric, minScore)`）；
   - 运行器 `server/src/scripts/eval.ts`：隔离临时 `DATA_DIR`/`WORKSPACE_DIR` 串行跑，输出 `evals/reports/<ts>.json` + Markdown 报告；与 `evals/baseline.json` 对比，**回归则非零退出**（CI 门禁）；
   - mock 模式跑确定性断言（进 CI）；真实模型跑 `judge` 打分（手动 / 夜间，产出趋势）；
4. **检索与反馈**：`messages_fts` 支撑会话内 / 跨会话搜索；`feedback` 表 + `GET /api/feedback/export` 导出为评测候选集。

**Prompt 版本化**：`prompts/CHANGELOG.md` 记录每次改动 + 对应 eval 分数；评测结果作为 prompt 合并的准入条件。

## 理由

- trace 是排障与优化的前提：「这一回合为什么慢 / 为什么丢了委派」必须能从数据回答；
- eval 基线把「感觉变好了」变成「断言全绿 + 无回归」——prompt 改动是高风险的全局变更，必须有回归网兜底；
- 反馈导出让真实使用数据反哺评测集，形成数据飞轮。

## 被否决的方案

- **只做日志**：无法结构化查询，GUI 可视化成本高；
- **只做真实模型评测**：成本高、结果波动大，无法进 CI 做硬门禁；mock 断言确定性作为 CI 门禁、judge 作为趋势参考，两者分工。

## 影响

- CI：typecheck + lint + test + eval（mock 断言）+ E2E 全部作为合并前置；
- 手工验收清单纳入 eval 回归演练（故意改坏 prompt → eval 变红）。
