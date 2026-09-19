# ADR 0099：工具可用性门控与失败语义收敛（M47）

- 状态：Accepted
- 引入：M47
- 相关：[design.md §56](../design.md)、[server/src/tools/availability.ts](../../server/src/tools/availability.ts)、[server/src/tools/registry.ts](../../server/src/tools/registry.ts)、[server/src/orchestration/engine.ts](../../server/src/orchestration/engine.ts)、[server/src/index.ts](../../server/src/index.ts)、[shared/src/types.ts](../../shared/src/types.ts)、[client/src/components/chat/ToolCard.tsx](../../client/src/components/chat/ToolCard.tsx)、ADR 14（工作区沙箱：sandbox/repo/worktree）、ADR 23（HITL 审批）、ADR 35（联网检索）、ADR 38（业务工具 calc）、ADR 54（工具按需发现）

## 背景

- **真实失败数据取证**（`data/app.db` `tool_metrics` 全量聚合：593 次调用 / 17 次失败；`run_events` 精确文案）——失败并非分散噪声，归因为六类系统性根因：
  1. **环境未启用但清单可见**（web_search / web_fetch 6 次）：工具始终注册进模型清单（执行期才检查开关），.env 未启用 / 运行进程持旧环境时，模型看到工具 → 调用 → 必然失败（网络类，且会重试）；
  2. **整组关闭 + 泛化报错**（fin_kline / fin_quote 2 次）：FINANCE_ENABLED=false 时 `fin_*` 整组不注册，人设/白名单仍引导调用 → 执行期返回泛化「未知工具」，模型无法区分「不存在」与「未启用」，无法向用户给配置指引；
  3. **正常态被记为失败**（tool_search 3 次）：发现未启用（小集合工具已全量直出）时调用 tool_search 返回 `ok:false`——实为「无需检索」正常态，污染失败率并诱发无谓重试；且无参调用透出 zod 英文 `Required`；
  4. **中断被计入失败**（write_file / remember 4 次）：用户点停止 / 回合超时导致的中断走异常通道 → 落失败指标 + 前端红卡——用户主动停止被记为「工具失败」；
  5. **报错不可行动**（calc 1 次）：`breakeven` 参数个数报错无用法签名，模型无法一步纠正（附带 usage 后即自愈）；
  6. **负向业务结果**（write_plan 1 次）：用户驳回计划——业务语义，**保持 `ok:false` 不变**（协议依赖该回灌驱动修订）。

## 决策

1. **环境门控单一事实来源**（新模块 `server/src/tools/availability.ts`）：`toolUnavailableReason(name, cfg)` 集中判定 web_search（WEB_SEARCH_ENABLED）/ web_fetch（WEB_FETCH_ALLOWED_DOMAINS 非空）/ run_command（ALLOW_RUN_COMMAND）；统一 DISABLED_SUMMARY 文案（含「改哪个配置后重启」指引）；`GIT_TOOL_NAMES` + `isGitToolName` 供模式门复用；
2. **引擎清单过滤**（治本）：`availableTools` 构建时按 `toolUnavailableReason` 过滤——未启用工具**不进模型 schema、不进 tool_search 可发现范围（发现区块与激活池同源）**；执行期守卫**保留**（双保险：防旧会话快照 / 幻觉调用）；
3. **会话模式门控**（`EngineDeps.isGitMode?`）：sandbox 会话无仓库 → git 6 工具不进清单；repo / worktree 可见；**缺省（未装配）= 不判定**（eval / 单测零差异）；生产装配 `workspace.isGitMode(sessionId)`；
4. **registry 三能力**：`markUnavailable(names, hint)`——整组关闭时登记「已知但未启用」（执行期返回精确配置指引而非「未知工具」）；`unavailableNames()`——控制台白名单校验合并该清单（编辑引用 `fin_*` 的角色不再误报「未知工具」）；`describeParamIssue`——zod 校验首条问题本地化（必填缺失 →「query 为必填项」）；
5. **tool_search 非失败语义**：未装配检索内核 / 发现未启用 → `{ ok: true, direct: true, note: '当前所有工具均已直接可用，无需检索' }`（`ToolSearchOutcome.direct` 新字段）；真正空命中才给改写建议；
6. **discoveryGate 精化**：未激活的延迟工具仅在**本回合可发现范围内**才给「先 tool_search 激活」引导；被环境过滤 / MCP 未绑定 → 放行到执行层给精确原因（避免引导模型检索一个不存在的条目）；
7. **中断语义收敛**：用户停止 / 回合超时 ≠ 工具失败——不写失败指标、trace 留痕 `aborted:true`；`ToolCallRecord.status` 新增 `'stopped'`（前端 ToolCard 琥珀 `CircleSlash`，不再是红卡）；停止导致的审批取消、批次未执行条目同归 `stopped`；用户驳回 / 审批超时仍为 `error`（负向业务结果，保持回灌语义）；
8. **calc 报错自愈**：函数运行错误附 `usage` 签名（`（用法：breakeven(固定成本, 单价, 单位变动成本) = …）`），模型按签名一步纠正。

## 理由

- **「必然失败」优先消灭**：五类可机制性消除的根因中，1/2 属于「模型看到的工具注定不可用」——对体验伤害最大（连锁：调用失败 → 重试 → 红卡 → 用户困惑）；schema 过滤从源头移除，优于任何提示词修补；
- **失败指标的纯度**：失败率是质量信号，必须只反映「工具真的失败了」——用户停止是意图、用户驳回是决策，两者与执行失败在 UI（琥珀 vs 红）与指标（不计 vs 计）上可区分，否则仪表盘长期虚高、真实回归被掩盖；
- **单一事实来源**：环境判定集中在 availability.ts，新增门控工具时只改一处；避免「注册了但执行期才拒绝」的清单/执行不一致；
- **双保险而非单点**：schema 过滤治本（新回合）；执行期守卫保留治标（历史快照 / 幻觉 / 脚本化调用仍得精确文案）；
- **零新增依赖、零协议变更、零新增端点**；`stopped` 为客户端-服务端共享类型的向后兼容扩展（新增枚举值）。

## 被否决的方案

- **只在执行期给精确提示（不动 schema）**：模型仍看到必然失败的工具并反复调用（真实数据已证），治标不治本；
- **整组静默注销（不做 markUnavailable）**：`fin_*` 引用得到泛化「未知工具」，模型/用户无法区分「不存在」与「未启用」，无法给出配置指引；
- **中断计入失败、仅前端特殊渲染**：指标面板仍虚高，掩盖真实质量信号（指标与 UI 必须同源收敛）；
- **write_plan 驳回归入 stopped**：驳回是用户的负向业务决策——现有协议依赖 `ok:false` 回灌驱动「按反馈修订 v2」，改语义会破坏修订回路；
- **git 工具改为进程级开关**：仓库有无是**会话级事实**（项目 workspaceMode），不是进程配置；
- **fail-fast 提示词修补（人设里写「没有的工具别调」）**：概率性规避，不可验证、不可测试（历史已多轮证明）。

## 适用与失效条件

- 适用：全部会话与工具执行路径（引擎 / registry / 控制台）；环境门控随 `AppConfig` 生效（.env 改动重启后）；git 模式门随会话项目 `workspaceMode` 实时判定；
- 失效条件：新增「环境门控类」工具（第三方服务开关）时**必须**同步在 `availability.ts` 注册门控与文案，否则回退为清单盲区（模型可见但必然失败）；
- 测试镜像面：`server/tests/m47-tool-availability.test.ts`（9 例：门控单测 / fin_* 精确提示 / 必填中文化 / schema 过滤与发现范围 / git 模式门 / direct 语义 / 中断不落失败指标）；`m28-engine-search`（计数顺应 git 模式门 + 网关门控显式 pin `NET_ENABLED`，与环境解耦）；`m28-discovery`（direct 语义两例）；`m7`（停止收口 `stopped`）。
