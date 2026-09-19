# ADR 0147：用户配额与用量看板——并发 · 日 token · 月成本 · 会话 · 存储（M57 P3-1）

- 状态：Accepted
- 引入：M57 P3-1（2026-09-19）
- 相关：ADR 0134（多用户基座：usage.user_id 归因）、[design.md §93](../design.md)、[server/src/quota/service.ts](../../server/src/quota/service.ts)、[server/src/store/quotas.ts](../../server/src/store/quotas.ts)、[server/src/routes/usage.ts](../../server/src/routes/usage.ts)

## 背景

P1/P2 让多用户「能安全共存、能协作」，但资源消耗无约束：单个成员可无限建会话、无限跑任务、无限上传；团队部署（局域网/公网）下这既是成本风险也是可用性风险（单用户拖垮全局算力/磁盘）。plan P3 第一刀 = 配额与用量看板。

## 决策

1. **数据模型（迁移 v17）**：`user_quotas(user_id PK, max_concurrent_runs, daily_tokens, monthly_cost_usd, max_sessions, max_storage_mb, updated_at)` —— **五列均可空**；无行 = 全部不限（兼容模式 / 未配置用户零变化）；全空行自动清理（避免僵尸行）。
2. **单一事实源**：`QuotaService`（limitsOf / usageOf / blockedReason / assertSessionCreate / assertUploadAllowed）+ `QuotaStore`（读写）+ `usage.sumByUser(userId, sinceIso?)`（时间窗聚合）。
3. **四个强制点**：
   - **并发**：`limitsOf().maxConcurrentRuns` 与系统 `RUN_MAX_PER_USER` **取小**；Engine.assertUserCapacity 消费（无配额行时行为与现状完全一致）；
   - **日 token / 月成本**：Engine **波次边界**调用 `blockedReason`（基于 usage 当日 / 当月聚合）——超限时落系统事件条（复用并行写冲突提醒通道）并以 `run:end reason='quota'`（RunEndReason 新增值）收束本 Run；
   - **会话数**：`POST /api/sessions` 前置断言（403 + 中文指引）；
   - **存储**：附件 / 画布素材上传前置断言（工作区目录体积 + 本次增量；目录遍历带上限提前退出，避免大目录全量统计）。
4. **看板与接口**：`GET /api/usage/me`（个人汇总 + 生效限额）；`GET/PUT /api/users/:id/quota`（GET = admin 或本人；PUT = admin，`null` 清除该项）与 `GET /api/users/:id/usage`（admin）；配额变更审计 `auth.quota-set`。客户端：用户管理台行内配额弹窗 + 个人设置「我的用量」卡。
5. **口径统一**：日 / 月重置按**服务器本地时区**（团队单机部署语义直观）；金额 = `LLM_PRICING_JSON` 估算；存储单位 MB（一位小数）。

## 理由

- **波次边界而非每次 LLM 调用前**：每回合前查库会放大热路径开销且语义抖动（同波内成员共享预算）；波次边界 = 天然结算点，「本波跑完即收束」对用户可解释；
- **系统事件条 + reason='quota'**：复用既有系统条通道（零新协议）；reason 独立值使前端 / 排障可精确归因（不冒充 error / stopped）；
- **取小合并（用户配额 vs 系统默认）**：用户配额只能在系统基线之内收紧（防管理员忘记系统值而被单用户覆盖）；无配额行时零开销路径（Engine `deps.quotas?.` 空安全）；
- **上传闸门用目录体积而非记账表**：磁盘是唯一真相（无对账漂移）；「超限提前退出」遍历把最坏开销压到 O(cap)；
- **null = 清除**：与既有「键缺失=不改动」的 PATCH 惯例区分开——配额面是「整体表单提交」语义（空 = 不限），显式 null 表达最直接。

## 被否决的方案

- **按次 LLM 调用前校验**：热路径开销 + 同波成员互相踩线（波内已并行装配），语义难以解释；
- **独立 quota 记账表（增量累计）**：与 usage 表双真相源（漂移 / 对账成本），直接聚合 usage 足够（SQLite 聚合在本项目规模毫秒级）；
- **配额超限直接 429**：非速率语义（速率已有 loginRateLimit / message limiter），用 403 + 明确文案；
- **存储按上传记录累计**：删除会话 / 文件后需回减（易漂移）；目录实测为唯一真相；
- **个人配额自助修改**：配额是资源治理面，管理侧专属（与「系统级资源 admin-only」口径一致）；成员可**只读**自己的限额与用量。

## 影响

- 迁移 v17；`shared` 类型新增 `QuotaLimits / UsageSummary`，`RunEndReason` 增 `'quota'`；新文件 `quota/service.ts`、`store/quotas.ts`、`routes/usage.ts`；Engine / sessions / attachments / canvas 路由接闸门；users 路由增配额三端点（审计 `auth.quota-set`）；
- 兼容模式零变化：无账号 → 无配额行 → 全部不限（测试断言锁定）；前端「我的用量」卡以 `userId` 空串自我隐藏；
- 测试：server `m57-p3-quota.test.ts` 8 例 + client `m57-p3-quota.test.tsx` 4 例；全量 server 88 文件 1164 例 / client 78 文件 955 例全绿；
- 后续（P3 剩余）：个人资源（scope='personal' 连接 / MCP BYOK）与 LLM BYOK；配额看板如需要可按日曲线扩展（usage 表已带时间戳）。
