# 多用户浏览器资源治理专项设计（M62）

> 状态：**已实施**（2026-09-19；M62-A/B/C 全量落地，门禁：server 1134/1134 · client 892/892 · typecheck / lint 0 错 · build 通过）；落位：design.md **§89**、ADR **0139 / 0140 / 0141**（编号让位注记：ADR 0137 与 §88 已被「上下文电池」批占用、ADR 0138 另被画布 UX 批占用，原预定 0137–0139 / §88+ 顺延）
> 范围：浏览器实例全生命周期治理（归属隔离 · 实例注册表 · 页面分治 · 配额与空闲回收 · 关闭链路 · 崩溃恢复）× 连接线治理（CDP 链路契约 · 远端端点租约与再解析 · 连接中心健康回写 · 帧流通道）× 多用户观测面（admin 实例总览）
> 关联：ADR 0042（连接中心与 CDP 接入）· ADR 0051（多标签页跟随）· ADR 0120（启动形态与 CDP 韧性）· ADR 0134（M57 多用户基座）；既有测试 `server/tests/browser-*.test.ts`（6 文件）
> 现状基线（规划时仓库快照）：迁移至 v14、design.md 至 §87、docs/adr 至 0136；`.git` 已初始化（有提交历史，动手前以 git 留底替代目录快照惯例）

---

## 1. 背景与问题

M57 P1（ADR 0134）已落地账号认证、`owner_id` 逻辑隔离、AccessService 集中守卫与流 token 用户绑定；浏览器子系统的**会话级守卫**（bsid 归属、流 token 绑定用户、`/sessions/:id` 聚合守卫）已成立。但实例管理仍是「单信任域、单机单用户」时代的假设，多人共用一台服务器时存在以下缺口（全部为代码核实结论）：

| # | 缺口 | 证据（现状） | 多用户下的后果 |
| --- | --- | --- | --- |
| 1 | **Profile 全局共享**：local 持久 Profile 恒为 `data/browser-profile/local`，managed 临时目录同根 | `runtime.ts` `profileRoot = path.join(cfg.dataDir, 'browser-profile')`；`launcher.ts` local 目录固定 | 用户 B 以 local 模式启动时 `findExistingLocal` 命中用户 A 的实例 → 直接接管 A 的浏览器（登录态 / 标签页 / 会话凭据暴露）；两用户视角互踩 |
| 2 | **复用不核对归属**：external 复用仅凭 DevToolsActivePort 探测 | `launcher.ts` `findExistingLocal` | 同上；「复用实例」徽章在跨用户命中时是安全事件而非提示 |
| 3 | **同用户多会话抢页**：local 复用同一实例时，第二个 BrowserSession `attachToPage` 挑 `pages[0]`（或 url 命中）→ 两会话 attach 同一管理页 | `cdp.ts` `attachToPage`；`session.ts` `attachPipeline` | 同账号两个业务会话（Agent 与人工）操作同一页面互踩；页面跟随的 opener 链可能越权接管他人管理页 |
| 4 | **关闭链路断裂**：`closeForSession` 无任何调用方——会话删除不关浏览器 | `runtime.ts:361` 定义；全仓无调用；`routes/sessions.ts` `DELETE /sessions/:id` 仅 `sessions.remove` | 删除会话后 Chrome 进程 + 内存注册表 + DB 活跃行全部泄漏，重启前永久占用 |
| 5 | **用户删除不清理**：`DELETE /users/:id` 仅级联删库 | `routes/users.ts:108` → `auth.deleteUser`（FK 级联不含运行时） | 被删用户的浏览器进程 / 内存会话继续存活（仍可被 Agent 工具操作） |
| 6 | **无配额**：per-user 活跃浏览器无上限；Chrome 实例 ~200–400MB | 无任何配置项；M57 已为 Run 设 `RUN_MAX_PER_USER`，浏览器未对标 | 单人开 N 个会话即可耗尽内存（团队部署 DoS 面） |
| 7 | **无空闲回收**：实例只在显式关闭时释放 | runtime 无回收循环 | 长期挂起的浏览器占资源；local 复用实例尤其长命 |
| 8 | **无启动恢复**：服务重启后 DB `closed_at IS NULL` 僵尸行、`managed-*` 临时目录、无主 Chrome 进程（父进程退出后归 init）全部残留 | `index.ts` 只有优雅 `shutdown()`；无启动对账 | 目录 / 进程 / 数据三重泄漏；配额统计失真 |
| 9 | **remote 无租约**：同一 CDP 端点可被任意多会话接入 | `runtime.doEnsure` 每次新建 CdpClient 直连端点；ADR 0051 已注明「remote 共享实例会接管他人页面」 | 成员 A 与 B 接入同一 remote 连接 → 互抢页面；外部人开的页面也会被接管 |
| 10 | **最小权限缺口**：`browser_open(connection_id=…)` 与面板启动均未校验「会话已绑定该连接」；`member_use` 只在绑定时校验 | `runtime.doEnsure` 仅校验连接存在 + kind；`memberUsable` 仅路由绑定用 | 任意成员可用任意 chrome 连接（绕过绑定纪律）；admin 收回 member_use 后已绑定会话仍可继续用 |
| 11 | **连接线健康不回写**：Chrome 连接 status 只由「测试」按钮写；真实接入失败 / 断线 / 重连耗尽不落状态灯 | `routes/connections.ts` 仅测试路径 `setStatus` | 连接卡片状态与事实不符；运维无从感知端点故障 |
| 12 | **历史回放归属缺失**：已关闭 bsid 的回放判定 = 「非多用户 or admin」 | `routes/browser.ts` `canAccessBsid` | 成员无法回看自己历史浏览器会话的步骤时间轴与截图证据 |
| 13 | **browser_sessions 无 user_id**：仅 session_id | 迁移 v14 表结构 | 观测 / 回放 / 清理只能反查 sessions；用户删除后反查链断裂 |
| 14 | **观测盲区**：无全局实例视图 | 只有 per-session `listForSession` | admin 无法看到「谁占用几个浏览器 / 哪些空闲 / 哪些异常」 |

> 说明：「连接线」在本专项中定义为三条链路——① 实例 ↔ 服务端的 CDP 连接链路（保活 / 重连 / 租约 / 健康）；② 服务端 ↔ 面板的帧流与输入通道（StreamHub / 流 token）；③ 连接中心 ↔ 实例的健康线（status 回写）。

---

## 2. 目标与验收

| 目标 | 验收标准 |
| --- | --- |
| 用户级隔离 | 任意两账号（含 admin）不共享实例 / Profile / 管理页 / 帧流；跨用户 bsid 一律 404；复用永远命中本账号实例 |
| 归属闭环 | 会话删除 / 用户删除 / 服务重启 / 进程崩溃四场景后：无存活孤儿 Chrome、无残留临时目录、无僵尸 DB 行 |
| 公平与稳定 | per-user 上限 + 全局上限 + 空闲回收；超限错误文案明确且先尝试回收；运行中 / 人工接管 / 有订阅者的实例不被误回收 |
| 连接线清晰 | remote 独占租约（或显式共享）；重连可再解析端点；连接健康与实际一致；帧流 / 输入通道跨用户严格拒绝、同用户可流转 |
| 最小权限 | 未绑定连接不可被工具 / 面板启动；成员受 `member_use` 约束；违规给出可操作提示 |
| 可观测 | admin 一屏看到全部活跃实例（归属 / 状态 / URL / 空闲时长 / 订阅数 / 关闭操作） |
| 零回归 | 单用户兼容模式（无账号）行为与路径完全不变；`browser-*.test.ts` 六文件与相关 E2E 全绿 |

---

## 3. 设计原则（红线）

1. **兼容模式零变化**：无账号（`auth.multiUser=false`）时保持旧路径 `data/browser-profile/`、旧复用、旧关闭语义；一切新治理逻辑以「owner 存在」为开关。
2. **隔离在服务端强制**：路径隔离 + 运行时守卫双层，UI 只是呈现。
3. **复用不跨用户**：复用只允许同 owner 同 profile；归属不一致按「无实例」处理并告警。
4. **生命周期有界**：数量有上限、空闲有时间界、崩溃有对账；清理 best-effort、不阻断主流程、不误杀（命令行校验）。
5. **连接线单一事实源**：连接健康以真实接入结果回写；租约 / 占用是运行时唯一权威。
6. **审计一致**：start / attach / close（含 idle）/ reclaim / reconcile / lease 拒绝 全部落 `audit_log`。

---

## 4. 专项总览

| 批次 | 主题 | 规模 | 关键交付 | ADR 预定 |
| --- | --- | --- | --- | --- |
| M62-A | 实例治理内核 | 1.5–2 天 | 用户级 Profile 隔离 + 实例注册表 + 页面分治 + 配额 / 空闲回收 + 关闭链路补全 + 启动恢复 + 迁移 v15 | 0137 |
| M62-B | 连接线治理 | 1–1.5 天 | remote 独占租约 + 重连端点再解析 + 连接健康回写 + 绑定 / `member_use` 复核 + 帧流同用户流转 | 0138 |
| M62-C | 观测与 UI | ~1 天 | admin 实例总览端点 + 连接控制台「实例」页签 + 面板提示文案 + E2E | 0139 |

实施顺序 A → B → C，每批独立过门禁。ADR 号为预定值，动手前核对最新编号（仓库有并行批次让位先例）。

---

## 5. M62-A 实例治理内核

### 5.1 归属与 Profile 隔离

**决策**：Profile 根目录按 owner 划分，实例注册表文件随 profile 落盘。

- 目录布局：
  - 多用户：`<dataDir>/browser-profile/u_<userId>/`（admin 同样独立）；
  - 兼容模式：`<dataDir>/browser-profile/`（旧布局，零迁移）。
- local → `<root>/local`；managed → `<root>/managed-<random>`；`LaunchOptions.profileRoot` 语义不变（由 runtime 决策传入，launcher 不感知用户）。
- 实例注册表文件 `<profileDir>/.ma-instance.json`（端点就绪后写入；关闭 / 清理时删除）：
  ```json
  { "v": 1, "browserSessionId": "bs_x", "sessionId": "s_x", "userId": "u_x", "backend": "local", "pid": 1234, "endpoint": "ws://…", "headless": true, "startedAt": "…" }
  ```
  用途：崩溃恢复（pid 归属与命令行校验）、观测（实例 ↔ 业务会话映射）、复用时的归属防御。
- **复用核对**：`findExistingLocal(profileDir)` 命中后校验 `.ma-instance.json.userId === 当前 ownerId`；文件缺失时——兼容模式放行，多用户模式按「无实例」处理并 warn。owner 经 `sessions.getSession(sessionId).ownerId` 解析（M57 已有字段；Runtime deps 增 `sessions: SessionStore` 或 owner 解析回调）。

### 5.2 复用语义与页面分治（同用户多会话）

问题：local 复用同一实例时，会话 2 的 `attachToPage` 会抢会话 1 的管理页（缺口 #3）。

**决策**：实例内「管理页分治」——每个会话持有自己的管理页。

- Runtime 维护 `instancePages: Map<endpoint, Set<targetId>>`（活跃会话已登记的管理页）。
- attach 策略（`attachPipeline` 入口判定）：
  - endpoint 无其他活跃会话 → 首会话：沿用现语义（preferUrl 命中 → `pages[0]` → 无页新建）；
  - endpoint 已有其他活跃会话 → 后续会话：`Target.createTarget('about:blank')` 新建管理页并登记，`startUrl` 导航落自有页。
- 页面跟随（ADR 0051 口径保持）：本会话只跟随「自有管理页 + 其 opener 链新页 + 空白页观察」；**已被其他会话登记为管理页的 target 永不接管**（占用表参与判定）；会话关闭仅释放登记、不关页面（用户可能正在看）。
- remote `shareInstance=true`（见 §6.1）时同一分治逻辑生效。
- 降级：占用表为内存态，进程重启即重建；重建依据 = 启动 / 重连时以「已管理 target」重新登记；登记失败不影响 attach。

### 5.3 配额与空闲回收

**决策**：双层上限 + 空闲回收 + 「先回收再拒绝」。

- 配置（§5.7）：
  - `BROWSER_MAX_PER_USER`（默认 3，0=不限）
  - `BROWSER_MAX_TOTAL`（默认 8，0=不限）
  - `BROWSER_IDLE_CLOSE_MS`（默认 1800000 = 30 分钟，0=不回收）
  - `BROWSER_RECLAIM_INTERVAL_MS`（默认 60000）
- 检查点：`doEnsure` **新建实例前**（复用已有活跃会话不消耗配额、不拦截）。
- 超限顺序：① 先对该用户执行一次 idle 回收；② 仍超限 → 抛可操作错误：`浏览器实例数已达上限（单用户 3 / 全局 8）：请关闭空闲浏览器（面板「关闭」）或稍后重试（空闲实例将自动回收）`。
- 空闲判定（全部满足才回收）：
  - `state ∉ { launching, reconnecting, awaiting_human, error }` 且 `controller === 'agent'`；
  - 无帧流订阅者（`StreamHub.subscriberCount(topic) === 0`，经 runtime deps 注入回调）；
  - 无进行中动作（`busy=false`）；
  - `now - lastActiveAt ≥ BROWSER_IDLE_CLOSE_MS`（`lastActiveAt` 由动作 / 人工输入 / 导航 / 步骤刷新；session 新增 `lastActiveAt()`）。
- 回收动作：`close(reason='idle')` → 审计 `browser.close detail.reason='idle'`；StreamHub 广播 `closed reason='空闲超时自动关闭（再次调用 browser_* 会自动重启）'`；面板明示。
- 豁免：`awaiting_human` / `controller='human'` 永不回收（等人工的会话不能被抽走）。

### 5.4 关闭链路补全

- **会话删除**：`routes/sessions.ts` `DELETE /sessions/:id` 在 `sessions.remove` 之前 `await deps.browser.closeForSession(id, 'session_delete')`（best-effort：失败仅 warn，不阻断删除）。
- **用户删除**：`routes/users.ts` `DELETE /users/:id` 在 `auth.deleteUser` 之前 `await deps.browser.closeForUser(id, 'user_delete')`；Runtime 新增 `closeForUser(userId)`：内存会话按 owner 匹配 + DB 兜底（`browser_sessions.user_id = ? AND closed_at IS NULL`）。
- fork / 消息删除不涉及（fork 新建会话无浏览器；仓库无会话归档端点——已核实）。
- 服务关闭：既有 `shutdown()` 保持；补充「删除 `.ma-instance.json` + `close_reason='service_shutdown'` 落库」。

### 5.5 启动恢复与孤儿清理

**决策**：进程启动后执行一次 `reconcileOnStartup()`（`index.ts` 装配完 BrowserRuntime 后、`listen` 前 await；全程 best-effort + 汇总日志）。

1. **DB 对账**：`UPDATE browser_sessions SET closed_at=now, state='closed', close_reason='service_restart' WHERE closed_at IS NULL`；审计 `browser.reconcile`（数量）。
2. **进程对账**：扫描 `<dataDir>/browser-profile`（含 `u_*` 与 legacy 根）下全部 profile 目录：
   - 读 `.ma-instance.json`：`pid` 存活（`process.kill(pid, 0)`）且 `ps -p <pid> -o command=` 含 `--user-data-dir=<该目录>` → `SIGTERM`（2s 后仍存活再 `SIGKILL`）；命令行不匹配 → 跳过并 warn（防 pid 复用误杀）。
   - local 目录：删残留 `DevToolsActivePort`（沿用 `removeStaleActivePort` 语义）；目录保留（登录态）；删 instance.json。
3. **目录对账**：`managed-*` 目录（启动前存量的全部）→ 进程处理后 `rm -rf`（best-effort）；mtime 超 24h 的空目录清理。
4. **结果**：日志 `{ killedPids, removedDirs, closedRows }`；任一步失败不阻止启动。

### 5.6 数据、类型与 API（M62-A 部分）

- **迁移 v15**：
  ```sql
  ALTER TABLE browser_sessions ADD COLUMN user_id TEXT;
  ALTER TABLE browser_sessions ADD COLUMN close_reason TEXT;
  UPDATE browser_sessions SET user_id = (SELECT owner_id FROM sessions s WHERE s.id = browser_sessions.session_id) WHERE user_id IS NULL;
  CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id, closed_at);
  ```
  回填说明：`owner_id` 为 NULL（兼容模式遗留）保持 NULL；迁移遵循既有「备份子表 → 变更 → 回填」次序惯例。
- **shared 类型**：`BrowserSessionInfo` 增可选 `ownerId?: string`、`closeReason?: string`（向后兼容，面板可选消费）。
- **Runtime 新增接口**：
  - `closeForUser(userId, actor): Promise<number>`
  - `listActive(): BrowserSessionInfo[]`（带 ownerId；M62-C 扩展观测字段）
  - `ownerOf(bsid): string | undefined`（查 DB，供回放归属判定）
  - 订阅计数注入（构造 deps 增 `subscriberCount?: (topic) => number`，避免 runtime ↔ StreamHub 循环依赖）
- **路由**：`canAccessBsid` 改为：活动会话 → `access.canAccessSession(owner…)`（现状）；已关闭 → `browser.ownerOf(bsid)` 与请求用户比对（本人 / admin 放行；无归属行且非多用户 → 放行）。

### 5.7 实施落点与配置（M62-A）

- `server/src/browser/runtime.ts`（主战场：归属 / 配额 / 回收 / 对账 / 关闭链路）· `server/src/browser/launcher.ts`（instance.json 读写 + 恢复工具函数）· `server/src/browser/session.ts`（`lastActiveAt` / `closeReason` / 页面登记钩子 / `resolveEndpoint` 注入位）· `server/src/config.ts` + `.env.example` + `docs/operations.md`（4 配置项）· `server/src/store/migrations.ts`（v15）· `server/src/routes/sessions.ts` / `routes/users.ts` / `routes/browser.ts` · `server/src/index.ts`（reconcile + 注入）· `shared/src/types.ts`。
- 配置模板：
  ```bash
  BROWSER_MAX_PER_USER=3          # 单用户活跃浏览器上限（0 = 不限）
  BROWSER_MAX_TOTAL=8             # 全局活跃浏览器上限（0 = 不限）
  BROWSER_IDLE_CLOSE_MS=1800000   # 空闲自动关闭（默认 30 分钟；0 = 不回收）
  BROWSER_RECLAIM_INTERVAL_MS=60000
  ```

### 5.8 测试（M62-A）

- 单测新增 `server/tests/browser-multiuser.test.ts`：
  - profile 路径：多用户 → `u_<id>/…`；兼容模式 → 旧路径（零变化断言）；
  - 复用归属防御：instance.json userId 不匹配 → 不复用；
  - 配额：达上限拒绝（文案）+ 先回收后放行；`0=不限` 边界；
  - idle 回收：假时钟推进 + 注入订阅计数（有订阅者 / awaiting_human / human 三种不回收）；
  - 关闭链路：`DELETE /sessions/:id` 触发 closeForSession（spy）；closeForUser 内存 + DB 双路径；
  - 对账：僵尸行 closed、managed 目录清理、pid 校验不匹配跳过（stub `ps`）；
  - 页面分治：第二会话 `createTarget` 新页 + 占用表判定不接管他人管理页。
- 回归：`browser-*.test.ts` 六文件全绿（`browser-resilience` / `browser-pages` 按新语义小幅修订断言）。

---

## 6. M62-B 连接线治理

### 6.1 remote 独占租约

- **决策**：同一 chrome 连接（remote）同时只允许一个活动浏览器会话接入；默认独占，连接 `config.shareInstance === true` 显式放开（共享时按 §5.2 页面分治）。
- 实现：Runtime `leases: Map<connectionId, browserSessionId>`；`doEnsure` 租入（占用则拒绝，错误含占用者会话提示）；`close` / `onClosed` 释放。
- 理由：remote 端点上的页面可能由**外部人**产生（非本系统会话），页面分治约束不了外部行为；独占是唯一可控边界。共享仅用于受控场景（如专用测试端点）。
- UI（M62-C）：连接卡片 / 实例总览显示租约占用；错误文案给出「关闭原会话后重试」。

### 6.2 重连端点再解析

- 现状：`tryReconnect` 用固定 `this.endpoint`（ADR 0120 契约）。remote 端点重启（新端口）与 local/managed 进程重启后端口漂移（`--remote-debugging-port=0`）都无法自愈。
- **决策**：引入 `resolveEndpoint?: () => Promise<string>`（session 构造注入；重连每次尝试前调用，失败回退固定 endpoint 继续现有退避）。
  - remote：基于连接 config / secret 的 `endpoint`（http(s) 形式）重新走 `resolveCdpEndpoint`；配置本就是 `ws://` → 直接返回原值（无再解析余地）。
  - local / managed：读 `profileDir/DevToolsActivePort` + `probeEndpoint`；不可达 → 返回原 endpoint（等价现状）。
  - 重连成功 → 更新内存 endpoint 与 `browser_sessions.endpoint` 列。
- 边界：**不引入进程级自动重启**（承袭 ADR 0120 否决项）；进程已死的实例走「重试耗尽 → error → 用户 / Agent 重新 open（空闲回收后按需重启）」路径。

### 6.3 连接中心健康回写

- **决策**：以真实接入结果回写 `connections.status`：
  - 成功 start / attach / 重连成功 → `ok`；
  - 启动失败 / 重连耗尽 error / 探测失败 → `error` + `lastError` 摘要（截断 500 字符）；
  - 正常关闭（user / idle / session_delete / 用户删除）→ 不回写（连接本身仍存在）。
- 节流：同一 connection 30s 内至多一次写；仅 `connectionId` 存在的会话。
- 理由：连接卡片是运维第一入口，状态必须反映「最近一次真实使用结果」，而非只有手动测试。

### 6.4 最小权限复核（绑定 + member_use）

- **决策**：`ensureForSession` 接受 `actor?: { userId?: string; isAdmin: boolean }`：
  - `opts.connectionId` 存在时：① `connections.isBound(sessionId, connectionId)` 必须为真 → 否则「会话未绑定连接「X」：请在连接管理中心绑定后重试」；② 非 admin 且 `memberUsable(connectionId) === false` → 「该连接不允许成员使用（请联系管理员开放）」（即使已绑定）。
  - 调用方传入：路由（`req.user`）与工具运行时（`ctx.userId`，`ToolRuntime.userId` 字段已有；runtime 侧注入 `isAdminUser` 回调，或由引擎传入角色）。
- 与 db / mcp 既有最小权限口径对齐（`db.manager requireBinding` / `mcp isBound` 先例）。
- 注意：单用户兼容模式（userId 空）跳过绑定与 member 校验（行为零变化）。

### 6.5 帧流线（StreamHub）

- `subscriberCount(topic): number` 新增（§5.3 回收判定数据源）。
- **同用户 takeover 流转**：同 `userId` 的新 takeover 订阅 → 转移持有权（原客户端收 `error code='takeover_moved'` 并降级 watch；会话控制权保持 human）；跨用户保持拒绝（`takeover_busy`）。理由：右栏面板 + 直播窗 + 多标签页是同用户常态，现状「已有其他客户端接管中」会把用户自己挡在门外。
- 兼容模式（无 userId）沿用现状（单持有者拒绝）。

### 6.6 测试（M62-B）

- 单测：租约（第二会话拒绝 / 关闭后放行 / `shareInstance` 放行）；端点再解析（注入 resolver：成功更新 endpoint 与 DB；失败回退）；健康回写（ok / error / 节流 / 无 connectionId 不写）；绑定与 member 复核四种组合；`subscriberCount` 与 takeover 流转（同用户转移 + 跨用户拒绝）。
- 回归：`browser-keepalive` / `browser-resilience` 与 stream 相关既有用例。

---

## 7. M62-C 观测与 UI

### 7.1 服务端

- `GET /api/browser/sessions`（admin-only）：`{ sessions: [{ id, sessionId, sessionTitle?, ownerId, ownerName?, backend, state, controller, headless, external, connectionId?, currentUrl, createdAt, lastFrameAt, idleMs, subscribers }] }`。
- Runtime `listActiveDetailed()`：内存 + users store 补充 displayName；`subscribers` 来自注入回调。

### 7.2 客户端

- `ConnectionsConsole` 增第三页签「实例」（admin 数据；成员视图隐藏页签）：行 = 用户 / 后端 / 状态 / URL / 空闲时长 / 订阅数 + 「关闭」按钮（复用 `POST /browser/sessions/:bsid/close`）；空态「当前没有活跃浏览器实例」。
- `BrowserPanel`：
  - closed 事件 reason 展示（「空闲超时自动关闭」+ 提示 Agent 再调用会自动重启）；
  - 复用徽章 tooltip：「复用了你已运行的浏览器实例（同一账号的 local 持久实例）」；
  - 配额 / 租约 / 绑定错误原样透出（服务端文案即操作指引）；
  - （可选）remote 被占用时启动按钮给出占用者提示。
- `browser-store`：错误处理保持现有静默对齐纪律；新增 `listInstances()`（admin）。

### 7.3 测试（M62-C）

- client 单测：实例页签（admin 可见 / 成员隐藏）、关闭动作、空态与错误态、面板 closed reason 渲染。
- E2E 新增 `e2e/m62-browser-isolation.spec.ts`（或并入 m57-auth）：
  1. admin 建两名成员 → 成员 A 打开浏览器 → 成员 B 浏览器列表为空且直接访问 A 的 bsid 返回 404；
  2. admin 总览看到 A 的实例并可关闭；
  3. （可选）remote 租约冲突文案。

---

## 8. 被否决的方案

- **按用户分进程 / 分库**：运维与连接中心（全局资源）语义分裂，成本远超收益；
- **每业务会话独立 Profile**：local 登录态分裂（ADR 0120 已否决同族方案）；且 Chrome 目录体积 × N；
- **remote 无租约共享**：外部页面不可控，页面分治约束不了外部行为；
- **断线自动杀进程重启（local / managed）**：端口漂移 + 用户可能已手动退出，可控性差（ADR 0120 承袭否决）；自愈走「端点再解析 + 按需重启」；
- **配额硬拒绝（不先回收）**：把「本可自动恢复」场景变成用户负担，与 ADR 0120「自愈优于报错」精神冲突；
- **全局上限单用（无 per-user）**：单人挤占全体（违背 M57 公平性精神）；
- **Profile 按连接而非按用户隔离**：local 持久登录态天然属于「人」，连接是可换的接入配置；
- **清理时不校验命令行直接 kill pid**：pid 复用误杀风险不可接受；
- **回放归属继续仅 admin**：成员自己的历史证据链不应被隐去（最小惊讶原则）。

---

## 9. 风险登记

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| pid 复用 / 误杀 | 杀错进程 | 命令行含 `--user-data-dir=<profileDir>` 双校验 + best-effort；校验失败仅 warn |
| idle 回收误杀等待中的会话 | 丢上下文 | awaiting_human / human / 有订阅者三重豁免；回收前复核 busy |
| 页面分治触碰页面跟随（ADR 0051） | 跟随回归 | 占用表仅新增「他人管理页不接管」判定；`browser-pages.test.ts` 全量回归 + 新增用例 |
| 兼容模式回归 | 单机体验破坏 | 所有新行为以 owner 存在为门；兼容路径断言进测试 |
| 配额默认值不合场景 | 体验 / 资源两难 | 4 项均 env 可调；错误文案含当前值；文档明示调参 |
| 与并行批次编号冲突 | 文档错乱 | 动手前核对 design.md § 与 ADR 编号；冲突按「让位 + 更新本文件」 |
| 用户手动退出真实 Chrome | 状态漂移 | 既有断线自愈 + 健康回写兜底；面板明示 error 原因 |

---

## 10. 实施前检查清单

1. 编号核对：design.md 最新章节（现 §87）/ docs/adr 最新编号（现 0136）/ 本文件预定号；
2. 留底：`.git` 已初始化——动手前 `git add -A && git commit` 快照；
3. 契约先行：先落 §5.1–5.6 / §6.1–6.5 的接口与类型（shared + runtime），再改行为；
4. 测试先行：`browser-multiuser.test.ts` 骨架与既有六文件回归基线先就位；
5. 门禁收口：四包 typecheck / lint + 双端 vitest + build + check:agents（不涉资产）+ eval mock 基线 + 相关 E2E；
6. 文档收口：design.md §88+ + ADR 0137–0139 + §11 索引 + 本文件状态更新 + `.env.example` / `docs/operations.md` 配置项。

---

## 11. 落地注记（2026-09-19，实施后回填）

- **编号让位**：实施期与并行批次冲突——design.md §88 与 ADR 0137 被「上下文电池」批、ADR 0138 被「画布 UX」批占用；本批实际落 design.md **§89**、ADR **0139 / 0140 / 0141**（按「让位 + 双索引对齐」策略同步更新本文件 / design.md / ADR README）；
- **实现微调**：① 页面分治保留 `attachToPage` 旧路径——仅「同端点已有其他活跃会话（forceFreshTarget）或存在他人管理页（hasForeign）」时走新选页逻辑（既有跟随测试零改动）；② 连接健康回写点扩展至启动与端点解析失败（launcher throw / resolveCdpEndpoint throw 均落 error + lastError），不止 CDP 连接阶段；③ 客户端对 `takeover_moved` 静默降级 watch（不弹红条）；④ 测试注入口（runtime deps 的 `cdpFactory` / `launcher` 替身）按 M22 惯例补充，生产不传；
- **E2E 口径**：浏览器能力在仓库无 E2E 先例（e2e/ 无 m22 浏览器 spec，自动化依赖本机 Chrome），本批未新增 E2E，由 `browser-multiuser`（11 例，含跨用户流转 WS 级集成）+ `m62-browser-instances`（2 例）覆盖；原计划中的 `e2e/m62-browser-isolation.spec.ts` 取消；
- **并行协作补缺**：迁移断言 `store.test.ts` 的版本数组随并行批次增量被动抬升（v15 本批 / v16 session-sharing 并行批），实施期按「最小机械修改」补 16 后全绿；
- **门禁快照（当批）**：server **1134/1134**（含本批新增 11）、client **892/892**（含本批新增 2）；lint 0 错；`npm run build`（tsup + vite）通过。
