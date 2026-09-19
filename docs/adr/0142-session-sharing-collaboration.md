# ADR 0142：会话共享协作——共享成员 · 角色矩阵 · 署名与可见性（M57 P2）

- 状态：Accepted
- 引入：M57 P2（2026-09-19）
- 相关：ADR 0134（多用户基座 P1：owner_id / AccessService / 通道 ACL）、[design.md §90](../design.md)、[server/src/auth/access.ts](../../server/src/auth/access.ts)、[server/src/auth/guards.ts](../../server/src/auth/guards.ts)、[server/src/routes/shares.ts](../../server/src/routes/shares.ts)、[server/src/store/session-members.ts](../../server/src/store/session-members.ts)

## 背景

M57 P1 是「严格隔离」：会话归属单用户，跨用户一律 404。团队场景下「同一份会话多人协作」成为刚需——属主需要把会话交给同事继续（插话 / 审批 / 停止 / 改成员），或只读围观（review / 汇报）；同时不能破坏 P1 的隔离不变量与单用户兼容模式。

## 决策

1. **共享角色三档**：`owner`（属主，`sessions.owner_id` 承载，不进成员表）→ `editor`（读写：消息 / 插话 / 停止 / 审批 / 成员 / 画布 / 上传）→ `viewer`（只读 + 可自助退出 `/leave`）。**读取 = owner ∪ 成员；写入 = owner / editor**（会话互斥 / 并发上限等既有运行语义不变，先到先得）。
2. **数据模型（迁移 v16）**：`session_members(session_id, user_id, role CHECK(editor|viewer), invited_by, created_at, updated_at)`，PK =（会话, 用户）；外键 CASCADE（删会话 / 删账号自动清理）。`SessionSummary.role` 逐行标注当前请求者角色。
3. **授权唯一事实源**：`AccessService.sessionRole / canWriteSession / assertSessionWrite / assertSessionOwner`；`SessionStore.listForUser`（本人 + 共享）与 `search` 口径扩展；`visibleSessionIds` 复用（WS 订阅 / 通知轮询自动覆盖共享会话，无第二套过滤）。
4. **集中守卫 + 方法级写闸门**：`createSessionAccessGuard` 挂 `/sessions/:id`（读 404 / 写 403；`/leave` 为唯一写例外）；`/runs/:runId` 守卫加 `assertRunAccess`（停止 / 审批对 viewer 403）；`DELETE /sessions/:id` 与共享管理仅属主。
5. **邀请制 + 属主专属管理**：邀请按 `username`（P1 账号由管理员创建）；邀请自己 / 属主 400、已在成员 409、非成员移出 404；共享管理（含移出）仅属主，成员可自助退出。
6. **署名与广播**：共享会话（成员数 ≥1）上下文装配中人类消息署昵称（`【Alice】…`；独占会话 / 兼容模式沿用 `【用户】`）；变更审计 `session.share-add|update|remove|leave` + 广播 `notify:share-changed`。

## 理由

- **owner 不进成员表**：属主是会话固有属性（`owner_id`），入表会产生双真相源（迁移 / 转移时的同步难题）；`sessionRole` 计算时先判 owner 再查成员，语义单一；
- **写闸门按 HTTP 方法而非逐端点标注**：聚合守卫一次挂载天然覆盖全部子路由（含未来新增），与 P1「集中式防遗漏」一脉相承；`/leave` 作为唯一例外显式声明（否则 viewer 无法退出自己的共享）；
- **只读围观（viewer）独立档位**：汇报 / 评审场景不该被迫给写权限；「先到先得的运行语义」下 viewer 无法停止 / 审批，但可实时观看（SSE / WS 读通道不变）；
- **兼容模式零差异**：无账号时全部放行（`sessionRole` 返回 'owner'）、共享写操作 400 明示未启用——存量单用户部署无感（测试断言锁定）；
- **署名解决多人类歧义**：≥2 人类的会话里 `【用户】` 无法区分发言人，模型易把 A 的约束当作 B 的；昵称前缀使归属可辨（昵称缺失回退 `【用户】`，不阻断）。

## 被否决的方案

- **把 owner 也写入 session_members（role: owner）**：双真相源风险（owner_id 与表不一致时行为未定义）；
- **逐路由标注角色（30+ 端点）**：遗漏面大、维护成本高，违背 P1 的集中守卫决策；
- **viewer 折叠进 editor（只读靠 UI 约定）**：无服务端强制 = 假只读，跨用户数据完整性无保障；
- **共享管理允许 editor**：授权扩散风险（被邀请者可再拉人）；属主专属 + 成员自助退出已覆盖协作动线；
- **共享会话不做署名（保持【用户】）**：多人类会话的上下文歧义实际发生（P1 归因字段已就绪，不利用是浪费）；
- **全量搬迁 session_members 到独立索引表 / 拆分权限中心**：P1 规模（团队 ≤ 数十人 / 会话数几百）无必要，SQLite 单表 + 复合索引足够。

## 影响

- 迁移 v16；`shared` 类型新增 `SessionShareRole / SessionAccessRole / SessionShare / SessionSummary.role` 与 `notify:share-changed`；新路由文件 `routes/shares.ts`、守卫文件 `auth/guards.ts`；
- 行为变化：`GET /api/sessions` 返回「本人 + 共享」带 `role`；`/api/search` 口径同步扩展；viewer 写操作 403；`DELETE /sessions/:id` 收紧为属主（此前 P1 已是 owner-only 语义，本次在路由层显式断言）；
- 客户端已随本轮闭环：共享弹窗（`ShareDialog`：成员列表 / 角色切换 / 移出 / 邀请 / 自助退出）+ 头部共享入口（角色态徽章）+ 列表「协作 / 只读」徽章与操作 gating + viewer 横幅与 Composer 锁定 + `notify:share-changed` 消费（ws-store 刷新与自移除处理）；`share-store` 状态层承载全部请求；测试 `client/tests/m57-shares.test.tsx` 5 例 + E2E `e2e/m57-auth.spec.ts` 第二用例（双上下文邀请→转只读→移除全链路，幂等可重跑）。
- 测试：`server/tests/m57-p2-shares.test.ts` 5 例（HTTP 生命周期 / 属主校验 / 可见性与审计 / 署名装配 / 兼容模式），server 全量 86 文件 1139 例全绿。
- 同批收口（连接最小权限复核）：`createConnectionUseGuard` 以「本 Run 触发者」（`RunRecord.triggerUserId`）复核 SSH / 数据库工具——成员仅可用 `member_use=1` 的 system 连接（admin / 兼容模式 / 未知触发者不限）；`ssh.exec` / `db.*` 审计补 `userId`；工具只读结果缓存键收紧为 `sessionId:triggerUserId:tool:args`（原键无会话/用户，跨会话或共享会话同参会命中他人缓存绕过复核）；测试 `server/tests/m57-p2-conn-guard.test.ts` 5 例，server 全量 87 文件 1144 例全绿。
