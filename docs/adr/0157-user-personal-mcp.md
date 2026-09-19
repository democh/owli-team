# ADR 0157：个人 MCP（personal 服务器）——属主私有 · 属主会话自动授予 · 管理面保持 admin（M57 P3）

- 状态：Accepted
- 引入：M57 P3（2026-09-19）
- 相关：ADR 0146（P3-2 个人连接四层模式）、ADR 0147（P3-1 配额）、[design.md §99](../design.md)、[server/src/routes/mcp.ts](../../server/src/routes/mcp.ts)、[server/src/mcp/manager.ts](../../server/src/mcp/manager.ts)

## 背景

P3「个人资源」两件套的第二件：连接（P3-2）已开放 personal + member_use 开关；`mcp_servers.scope/owner_id` 列自 v14 即预留（零迁移），但一直未开放——成员无法接入自己的 MCP 服务。难点不在存储，而在**工具授予模型**：MCP 工具默认需 Agent 工具白名单（`tools: [mcp__<slug>__*]`）授权，而 agent 是管理面资产（成员不可编辑）——若沿用「授权前置」，成员建的 personal 服务器永远无法被任何 agent 使用（成员无自服务 grant 入口）。

## 决策

1. **数据与守卫（复用 P3-2 四层模式）**：成员创建一律落 `scope='personal'` + `owner_id=本人`（服务端定，不信请求体）；列表 `listForUser` = 全部 system（成员可绑定使用，现状不变）∪ 本人 personal；资源级 `ownerOrAdmin`（system / 他人 personal → 404 不泄漏存在性）；管理面（`json-config*` / `tools` 授权矩阵）保持 adminOnly——`/mcp` 从「整体 admin 挂载」改为**路由级门控**。
2. **可见性 = 属主会话**：`filterForSession(sessionId, tools, sessionOwnerId)` 对 personal 服务器要求 `server.ownerId === session.ownerId`（非属主会话 / 无属主会话不可见）；无 `sessionOwnerId` 参数的旧调用不做 personal 复核（兼容路径零变化）。
3. **属主会话自动授予（本 ADR 核心）**：引擎 execute 模式在 `forAgent` 白名单结果上**并入**属主全部已注册 personal 工具（`personalToolNames(ownerId)` 按 `toolOwner` 反查 + 注册表取件，去重）；plan / review 模式不并入（保持只读白名单语义）；绑定 / 启用 / 连接状态仍由 `filterForSession` 统一复核。语义 = 「我的服务器，我发起的会话里所有成员都能用」——与「会话属主的 Key / 配额」的成本与权限口径一致。
4. **执行侧最小权限**：`executeRegisteredTool` 以 `ctx.userId`（= 会话属主）复核 personal 属主，他人触发直接拒绝（防绑定后属主转移 / 共享会话边界的兜底）。
5. **绑定即连接**：`POST /sessions/:id/mcp-servers` 绑定 personal 服务器后自动 `runtime.connect`（成员无管理台，不能手动重连）；绑定清单防御性过滤他人 personal（历史 / 脏数据兜底）。
6. **级联清理**：账号删除 → 先 `disconnect`（注销工具 + 回收 stdio 子进程）再 `removePersonalOf`（行删除；`session_mcp_servers` 双 FK 级联解绑）；best-effort 不阻断账号删除。
7. **客户端**：个人设置「我的 MCP」卡（列表 + 状态灯 + 新建（stdio/http）+ 测试 / 重连 / 删除；保存即测试）；多用户模式门控；**会话头部「资源」入口**（`SessionResourcesDialog`，连接 / MCP 两页签）补齐成员自助绑定面——已绑定（解绑）+ 可绑定（绑定，候选 = system ∪ 本人 personal），viewer 只读；管理台仍 admin-only（P3-2/P3-4 共同收口件）。

## 理由

- **自动授予而非放开 agent 编辑**：agent 资产是团队治理面（token 预算 / 工具面安全），给成员开编辑口子代价远大于收益；personal 容器天然限定「谁建谁用」，自动授予只影响属主会话；
- **属主会话（session.ownerId）而非触发者（triggerUserId）**：MCP 是**会话级**资源（绑定在会话上），工具清单按会话装配；与共享会话语义对齐（成员进入属主会话即使用属主绑定的服务器，与使用属主 Key 同理）；执行侧另以 `ctx.userId` 兜底；
- **路由级门控替代整体挂载**：`/mcp` 下混有管理面（json-config / 矩阵）与资源面（服务器 CRUD）两类路径，整体 admin 会把 personal 一并挡住；逐路由声明使权限边界显式可审；
- **保存即测试**：成员没有「管理台重连」的心智模型，创建后自动探测连接 + 工具清单，把「是否可用」即时反馈到位。

## 被否决的方案

- **放开 Agent 编辑给成员**：资产治理面失守（提示词 / 白名单 / 模型参数均可被改），且需一套并发的资产 ACL，超范围；
- **personal 工具完全绕过白名单（含 system 服务器）**：等于把「工具面收敛」机制整体旁路，安全面不可接受；
- **绑定即私有可见（仅属主本人的会话列表显示）**——现状已是（会话可见性由 P2 角色矩阵管理），无需额外机制；
- **要求成员在会话内手动「连接」按钮**：与 MCP 生命周期（连接由服务端管理台负责）心智冲突，成员侧只应有「可用 / 不可用」两态。

## 影响

- `/mcp` 挂载语义变化：凡新增 `/mcp/*` 子路由必须显式声明门控（adminOnly / ownerOrAdmin / 登录用户），否则为登录即可访问；
- 引擎回合工具装配多一步并入（有 personal 服务器时），无 personal 时零开销（`personalToolNames` 空数组短路）；
- 兼容模式（无账号）零变化：无 ownerId 传参 → 不进行 personal 复核；`scope` 缺省 system。
