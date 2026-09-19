# 0134. 多用户基座（M57）：账号认证 · 归属隔离 · 兼容升级

## 背景

产品长期按「单信任域、本地优先」构建：单一共享 `AUTH_TOKEN` 即通行一切；`sessions` / `projects` / `connections` / `mcp_servers` / `finance_watchlist` / `kv` / `settings.json` 均无归属概念；WS 订阅、SSE 运行流、通知降级轮询、流 token（浏览器帧流 / SSH 终端）、媒体任务与审计接口没有任何 ACL；引擎并发（LLM 信号量 / `ASYNC_RUN_MAX`）与消息限流（按 IP）为全局口径。团队在局域网 / 公网（nginx 网关）多人使用时，上述假设直接构成数据越权与单户挤占风险。

## 决策

**一次性落地「账号 + 硬隔离 + 全链路守卫」，按 P1 / P2 / P3 分期实施**（本文记录 P1）：

1. **认证**：scrypt（Node 内置，参数入库可升级）+ 不透明会话令牌（`sa_` 随机串，库中只存 SHA-256；滑动 30 天 + 绝对 90 天，可即时撤销）；`sid` HttpOnly cookie；CLI 用 `mk_` API Key；legacy `AUTH_TOKEN` 映射最早管理员（弃用告警）。
2. **注册**：管理员创建 / 邀请制（无开放注册）；首登强制改密（`must_change_password`）。
3. **首启兼容**：`users` 为空即单用户兼容模式（行为与旧版一致）；`POST /api/auth/setup` 创建首个管理员并**一次性回填**存量数据归属（先 `flushAll` 落盘 → 库内 `UPDATE` → 清 SessionStore 缓存，防陈旧缓存覆盖）。
4. **隔离模型**：逻辑隔离（单库 `owner_id` / `user_id` 列）+ 集中式 `AccessService` 为唯一事实源；`/sessions/:id` 全量子路由由聚合层 `router.use` 统一守卫（跨用户一律 404，不泄漏存在性）；`/runs/:runId` 经 run→session 反查归属。
5. **资源分层**：系统级（连接中心 / MCP / 资产控制台 / 审计 / 指标 / 系统设置写）admin-only；成员可在自有会话绑定使用 `member_use=1` 的 system 连接（管理面仍纯 admin）；记忆 `global` 桶按用户切分（`owner_id = users.id`）+ 全 scope 增 `user_id` 过滤；自选列表按用户。
6. **通道 ACL**：WS 订阅逐会话校验（`__` 全局主题仅 admin）；`/api/notifications` 仅返回可见会话事件；流 token 载荷绑定用户（握手比对）；浏览器 bsid / 媒体任务 / 定时任务按 sessionId 反查守卫。
7. **公平性**：`runs.user_id` 归因 + `RUN_MAX_PER_USER`（活跃 + 排队）上限；消息限流按用户；`usage` / `run_events` / `feedback` / `messages` / `audit_log` / `approvals.decided_by` 全量归因。
8. **团队部署基线**：`TRUST_PROXY`（nginx 后取真实 IP，限流 / 审计依赖）+ `AUTH_COOKIE_SECURE`（HTTPS 下 Secure cookie）+ 非 GET Origin 校验（CSRF 第二道防线）；登录 IP 限流 + 失败锁定（落库）；TLS 终止交由 nginx，应用不内置 HTTPS。

## 被否决方案

- **JWT 无状态令牌**：撤销 / 踢下线 / 禁用即时生效困难；SQLite 同步校验成本可忽略。
- **物理分库（按用户独立 app.db）**：跨域特性（审计、指标、MCP 全局）与迁移成本高；`AppDb/SqlDriver` 抽象保留未来切 Postgres 的缝。
- **路由内联 if 判断归属**（不设 AccessService）：漏网风险随端点增长线性放大；集中守卫 + `router.use('/sessions/:id')` 一次覆盖全部子资源。
- **开放注册 / 邀请链接**：团队规模下管理员创建 + 首登改密已足够；链接式邀请留待 P3。
- **P1 即开放个人连接 / MCP**：凭据横向使用风险与风控成本过高；列 `scope/owner_id` 预留，P3 开放。

## 影响与后续

- 迁移 v13（认证四表）/ v14（归属列 + `connections` / `mcp_servers` / `finance_watchlist` 唯一键重建 + 归因列）；重建遵循「备份子表 → DROP → RENAME → 回填绑定」次序（`session_connections` / `session_mcp_servers` 为 ON DELETE CASCADE，DROP 会级联清行）。
- 客户端已落地：AuthGate（首启向导（兼容模式经账号弹窗发起）/ 令牌入口 / 登录页 / 首登强制改密 / 401 全局回退）；账号弹窗（改密 / 用户管理入口 / 登出）；管理面（Agent / Skill / MCP / 连接 / 用户）仅 admin，成员设置页 = 个人偏好（notifyPollMs）。
- 测试：`m57-multiuser.test.ts` 7 例、`m57-auth.test.tsx` 10 例、`e2e/m57-auth.spec.ts`（独立实例：首启 → 强制改密 → 跨用户隔离，幂等）。
- P2（会话共享协作：`session_members` + owner/editor/viewer）与 P3（配额 / 个人资源 / BYOK）见设计总纲。

## 状态

Accepted · M57（P1 服务端落地；客户端与 P2/P3 后续迭代）
