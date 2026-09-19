# ADR 0053：MCP 接入与管理（Model Context Protocol）

- 状态：Accepted
- 引入：M27
- 相关：[design.md §43](../design.md)、ADR 11（SSE + WS 双通道）、ADR 23（HITL 审批）、ADR 42（连接中心与 CDP 浏览器接入：凭据加密 / 会话绑定先例）、ADR 50（资产控制台：rail 导航先例）

## 背景

- `server/src/tools/mcp.ts` 自 M5 起只有预留空壳（`parseMcpServers` + 占位 adapter）：没有真实连接、没有凭据管理、没有授权边界。需求是把 MCP 生态（官方 registry 的本地 stdio 服务器与远程 Streamable HTTP 端点）接入为**一等工具来源**，与内置工具共用注册表 / 审批 / 会话模型。
- 硬约束：
  1. **函数名协议约束**：工具名进入模型函数调用协议（`[a-zA-Z0-9_-]`、≤64 字符），MCP 原始工具名不受此约束，必须建立稳定映射；
  2. **凭据最小暴露**：stdio 的 `env` / http 的 `headers` 常含密钥，不得明文落库、不得回传前端、**不得把进程 env（如 `LLM_API_KEY`）透传给第三方子进程**；
  3. **子进程不可信任**：第三方 MCP 服务器 = 任意本地代码，启动参数不过 shell、cwd 受控；
  4. **可用性对齐既有安全模型**：M22 已确立「会话级绑定 + 最小权限」；M7 / M23 已确立「写类操作过审批门」——MCP 工具不得成为绕过口；
  5. 运行环境 Node ≥18（SDK 要求），TypeScript ESM（tsup 构建）。

## 决策

1. **SDK 与传输**：采用官方 `@modelcontextprotocol/sdk`（`^1.30.0`）——stdio（`StdioClientTransport`）与 Streamable HTTP（`StreamableHTTPClientTransport`）双传输；`clientFactory` 可注入（单测用 `InMemoryTransport`，E2E 用真实 stdio 夹具）。
2. **存储**：迁移 v8 新增 `mcp_servers`（配置 / 工具快照 / 状态 / `source`）与 `session_mcp_servers`（绑定，双 FK `ON DELETE CASCADE`）；`env` / `headers` 全量进 **SecretVault**（`secret_enc`，AES-256-GCM），对外仅 `secretSet` 布尔；明文永不回传。
3. **工具命名**：`name` 即 slug（`^[a-z][a-z0-9-]{0,39}$`，唯一，工具前缀）；注册名 `mcp__<slug>__<tool>`：raw 名 `[^a-zA-Z0-9_-]` → `_`；总长超 64 时截断 tool 段并追加 6 位稳定哈希；同服冲突追加 `_2` / `_3`；保留 `registeredName → rawName` 映射（调用回传 raw）。
4. **子进程安全**：env = `getDefaultEnvironment()` 白名单基座（PATH / HOME / TMPDIR / LANG…）+ 配置 env，**绝不透传进程 env**；spawn 走 argv 数组不过 shell；cwd 缺省 `rootDir`；stderr 转日志；连接超时固定 15s。
5. **readOnly 判定**：`annotations.readOnlyHint === true` → 只读（可并行 + 60s 结果缓存）；服务器级 `readOnlyOverride: 'auto' | 'readonly' | 'write'`（默认 auto）兜底无注解服务器。**默认写类（保守）**——无注解即串行、不缓存、进入审批门。
6. **三层可用性**：服务器 `enabled` + `status === 'ok'`（已连接）→ 会话绑定（未绑定会话不可见）→ Agent `tools` 白名单（精确名或尾部 `*` 通配：`mcp__<slug>__*` 整台 / `mcp__*` 全部）。回合清单在 `forAgent` 后按 `filterForSession` 过滤；**执行期再校验一次**（绑定中途解除的回合级竞态兜底，按「未知工具」回灌）。
7. **审批策略**：服务器级 `approvalPolicy: 'risky' | 'always' | 'never'`（默认 risky）。引擎 `approvalGate` 判定顺序：`off` → `request_approval` → `APPROVAL_TOOLS` 显式命中 → **`mcp__` 规则**（never 豁免 / always 全拦 / risky 仅写类拦截）→ `all` → 内置高危清单；审批 detail 含服务器 / 工具 / 参数摘要。
8. **运行时管理**：`McpRuntimeManager`（`server/src/mcp/`）——`start / connect / disconnect / restart / test / refreshTools / stopAll`；订阅 `tools/list_changed` 自动刷新（diff 注册 / 注销 + 读缓存失效）；调用超时 per-server `timeoutMs`（默认全局工具超时，1s–600s）且 `ctx.signal` 透传 SDK；结果扁平化：text 块拼接、image / audio / resource → 占位摘要（`[图片 image/png 123KB]`）、`structuredContent` 截 4KB、detail 硬上限 64KB。
9. **管理面**：ActivityRail 第四入口「MCP 管理」（独立主区视图，AppLayout 不卸载——对齐 ADR 50 的 rail 先例）；控制台：服务器清单（状态灯 / 传输与来源徽章 / 工具数 / **零角色可达警示**）+ 测试 / 重连 / 刷新 / 启停 / 编辑 / 删除 / 会话绑定；编辑器双态表单（stdio：command / args / cwd / env；http：url / headers）+ 策略字段；工具清单展示授权矩阵（注册名 / 原始名 / 只读 / 命中角色）。M26 Agent 编辑器增加「MCP 服务器组」整组勾选（写 `mcp__<slug>__*` 通配），闭合「工具注册后零角色可达」。
10. **变更广播与审计**：所有写操作 / 状态变化 / 工具清单变化广播 `notify:mcp-changed`（保留主题 `__mcp__`，不计未读，多标签实时同步——镜像 `notify:assets-changed`）；全部管理动作落审计（`mcp.create / update / delete / test / reconnect / refresh / bind / unbind`）。
11. **env 种子**：启动时 `MCP_SERVERS`（`name=command args...` / `name=https://...`）按 name 导入（不存在才建，`source='env'`）；**此后 DB 为唯一真相，管理台为准**。
12. **装配与关停**：`index.ts` 装配 store + manager，`void manager.start()` 非阻塞（失败置 `status='error'` 不阻断启动）；`finishShutdown` 中 `await stopAll()`（回收 stdio 子进程）。

## 理由

- **官方 SDK 优于自研**：MCP 协议（初始化协商 / 能力发现 / 通知 / 会话恢复）仍在快速演进，自研 JSON-RPC 客户端会持续追赶规范；官方 SDK 同时覆盖双传输与重连语义。
- **会话绑定对齐 M22**：连接中心已证明「绑定才可见」的最小权限面在产品内可解释、可实现（同一交互语言：绑定 / 解绑按钮 + 未绑定提示）；MCP 是第三方能力，权限不应比数据库连接更宽。
- **通配白名单是可达性的关键**：MCP 服务器工具集随时增长（`tools/list_changed`），逐名白名单会让「新工具默认零可达」成为常态；尾部 `*` 让「整台服务器授权」成为一次决策——同时保留精确名收窄能力。
- **默认写类（readOnlyHint 缺失）**：把未知当只读会带来真实危害（并行执行写操作、60s 缓存重复写）；默认保守只损失并行度。
- **截断 + 稳定哈希而非报错**：64 字符是函数名硬约束，截断 + 6 位哈希（由 `slug/raw` 派生）保证同名稳定、跨刷新一致——「注册名报错」会让长名工具彻底不可用。
- **子进程 env 白名单**：MCP 服务器是第三方代码，进程 env 里的 `LLM_API_KEY` / 数据库口令对它是零合法需求；白名单基座 + 显式配置 env 同时满足可用性与最小暴露。
- **结果扁平化进既有工具契约**：`ToolResult { ok, summary, detail }` 是引擎 / 事件 / 审批的公共面；MCP 媒体块与结构化内容以占位摘要 + 截断文本进入 detail，无需改动任何下游。

## 被否决的方案

- **自研 MCP 客户端（手写 JSON-RPC over stdio / HTTP）**：协议演进 + 双传输 + 通知语义的维护面太大，违背「零新增依赖」纪律之外的选择理由不成立——官方 SDK 是唯一合理依赖；
- **SSE 传输（旧规范 `SSEClientTransport`）**：Streamable HTTP 已取代其定位，双传输止步于 stdio + Streamable HTTP，避免维护三套路径；
- **用 `displayName` 或 raw 工具名做注册前缀**：非 ASCII / 空格 / 超长名会系统性违反函数名约束，且 displayName 可改（改名即静默换名）——slug 创建后不可变；
- **env 全量透传进程环境**：第三方子进程可直接读取 `LLM_API_KEY` 等进程级密钥——白名单基座 + 配置 env 是硬要求；
- **全局可用（不引入会话绑定）**：第三方工具面过大时无法解释「为什么这个会话能调数据库 MCP」；M22 的最小权限模型已确立，不引入第二套授权语义；
- **无 `readOnlyHint` 默认只读**：并行 + 缓存会让未知写操作重复执行——默认写类；
- **悬空工具直接注册失败（超长名报错 / 非法名丢弃）**：会让部分工具在 UI 上「可见但不可调」——截断 + 去重保证每个工具都可寻址；
- **独立路由页面（React Router 级 MCP 管理台）**：会卸载 AppLayout（WS 生命周期 / 运行状态），破坏后台运行语义——延续 ADR 50 的 appView 主区切换；
- **凭据明文回传 / 回显**：前端只需要知道「已配置」，编辑留空 = 不修改、显式清除 = `null`——对齐连接中心（ADR 42）；
- **服务器删除时保留工具快照（软状态）**：会导致「服务器删了工具还挂着」的漂移——删除即断开 + 注销工具 + 级联解绑，DB 与注册表同事务边界内收敛。

## 适用与失效条件

- 适用：本地单用户部署（与 ADR 42 / 50 同一产品形态）；Node ≥18；被接入的 MCP 服务器视同不可信第三方代码。
- 失效条件：
  - 多用户 / 多租户时，会话绑定需上升为角色或租户级授权，并补「谁绑定了什么」的审计视图；
  - MCP 协议出现 breaking major（SDK 大版本）时，传输与能力协商层需重新评估（当前锁定 `^1.30.0`）；
  - 单服务器工具数达到数百级时，全量快照 + 每次 `tools/list` 的同步策略需换成分页 / 懒注册；
  - 引入远程多实例（多进程共享 DB）时，「DB 为唯一真相 + 内存注册表」的假设需要分布式协调（当前单进程）；
  - `MCP_SERVERS` 种子语义仅覆盖首启导入——后续合并不再读 env（K8s 式「env 即真相」部署形态下需要引入声明式期望状态对账）。
