# ADR 0139：多用户浏览器实例治理——用户级 Profile 隔离 · 页面分治 · 配额与空闲回收 · 生命周期闭环（M62-A）

- 状态：Accepted
- 引入：M62-A（2026-09-19）
- 相关：ADR 0042（连接中心与 CDP 接入）、ADR 0051（多标签页跟随）、ADR 0120（启动形态与 CDP 韧性）、ADR 0134（M57 多用户基座）、[design.md §89](../design.md)、[server/src/browser/runtime.ts](../../server/src/browser/runtime.ts)、[server/src/browser/launcher.ts](../../server/src/browser/launcher.ts)、[server/src/browser/session.ts](../../server/src/browser/session.ts)、[server/tests/browser-multiuser.test.ts](../../server/tests/browser-multiuser.test.ts)

## 背景

M57 P1（ADR 0134）已落地账号认证、`owner_id` 逻辑隔离与通道 ACL，但浏览器子系统仍按「单信任域、单机单用户」假设运行（代码核实结论）：

- **Profile 全局共享**：local 持久 Profile 恒为 `data/browser-profile/local`——用户 B 以 local 模式启动时 `findExistingLocal` 命中用户 A 的实例，直接接管其浏览器（登录态 / 标签页 / 会话凭据暴露）；managed 临时目录同根、无归属；
- **同用户多会话抢页**：第二个 BrowserSession `attachToPage` 挑 `pages[0]` → 两会话 attach 同一管理页互踩；页面跟随（ADR 0051）的 opener 链与回退路径也可能越权接管他人管理页；
- **关闭链路断裂**：`closeForSession` 无任何调用方（会话删除不关浏览器：进程 + 内存注册表 + DB 活跃行全部泄漏）；用户删除同样不清理运行时；
- **无配额 / 无空闲回收 / 无启动对账**：单人开 N 个会话即可耗尽内存（Chrome 实例 ~200–400MB）；崩溃 / 重启后僵尸行 + `managed-*` 目录 + 无主 Chrome 进程三重残留。

## 决策

1. **用户级 Profile 隔离**：多用户模式 Profile 根 = `<dataDir>/browser-profile/u_<userId>/`（admin 同样独立）；兼容模式（无账号）沿用旧布局 `browser-profile/`（零迁移）；`LaunchOptions.profileRoot` 语义不变（由 runtime 决策传入，launcher 不感知用户）。
2. **实例注册表 `.ma-instance.json`**（profile 目录内，端点就绪后写入：`browserSessionId / sessionId / userId / backend / pid / endpoint / headless / startedAt`；关闭 / 对账时删除）：驱动崩溃恢复（pid 归属校验）、观测（实例 ↔ 业务会话映射）、**复用归属防御**（复用实例的注册表 `userId` 与当前 owner 不一致 → 拒绝并给可操作错误）。
3. **页面分治（同实例多会话）**：runtime 维护 `endpoint → targetId → browserSessionId` 占用表；同端点已有其他活跃会话 → 新会话 `Target.createTarget` 自建管理页（`forceFreshTarget`）；`isForeignTarget` 三路径过滤——新页事件、空白页观察、回退候选；会话关闭 / 切页 / 管理页销毁均经 `onPageChange` 上报释放登记。无隔离需求时保持 `attachToPage` 旧路径（既有跟随语义与测试零改动）。
4. **配额（先回收再拒绝）**：`BROWSER_MAX_PER_USER`（默认 3）/ `BROWSER_MAX_TOTAL`（默认 8），0 = 不限；检查点 = 新建实例前（复用已有会话不拦截）；超限先回收本用户空闲实例，仍超限抛含当前值与出路的错误。
5. **空闲回收**：`BROWSER_IDLE_CLOSE_MS`（默认 30 分钟，0 = 不回收）+ `BROWSER_RECLAIM_INTERVAL_MS`（默认 60s）；判定 = `state=ready` + `controller=agent` + 非 busy + 无帧流订阅者（`StreamHub.subscriberCount`）+ 距最近活动（`lastActiveAt`：动作 / 人工输入 / 步骤）≥ 阈值；`awaiting_human` / `human` / 兼容模式（无归属）永不回收；回收经 close 落库并广播 `closed` 原因。
6. **生命周期闭环**：会话删除（`DELETE /sessions/:id` → `closeForSession`，best-effort 不阻断）；用户删除（`DELETE /users/:id` 先 `closeForUser`，含 DB 兜底行）；`shutdown` 补 `close_reason`；**启动对账 `reconcileOnStartup`**——僵尸行（`closed_at IS NULL`）标记 `service_restart`；注册表 pid 存活且 `ps -p <pid> -o command=` 含 `--user-data-dir=<dir>` 才终止（SIGTERM → 2s → SIGKILL）；`managed-*` 目录删除；`local` 目录保留（登录态），仅清注册表与残留 `DevToolsActivePort`。
7. **数据与类型**：迁移 v15（`browser_sessions` + `user_id` / `close_reason`，回填自 `sessions.owner_id`，索引 `(user_id, closed_at)`）；`BrowserSessionInfo` 增可选 `ownerId` / `closeReason`；关闭原因全量落库（用户关闭 / 会话删除 / 用户删除 / 服务关闭 / service_restart / 空闲超时）。
8. **兼容模式零变化**：全部治理逻辑以「owner 存在」为开关；单用户（无账号）保持旧路径 / 旧复用 / 旧关闭语义，兼容路径断言进测试。

## 理由

- **隔离两层防御**：路径命名空间使跨用户复用天然不可能（`findExistingLocal` 只看本用户目录）；注册表防御覆盖目录复制 / 恢复类异常场景；
- **页面分治最小侵入**：不重建 CdpClient（承袭 ADR 0120 契约），仅在选择管理页时增加占用过滤；占用表为内存态、随会话生命周期同步，无跨实例查询需求；
- **先回收再拒绝**：与 ADR 0120「自愈优于报错」一致——超限多为「用户忘了关」而非恶意，直接拒绝把可自动恢复的场景变成用户负担；
- **三重豁免防误杀**：等人工的会话（awaiting_human）不能被抽走；人工接管中（human）与有观察者（面板 / 直播窗订阅）代表人在使用；
- **pid 命令行双校验**：`process.kill(pid, 0)` + `ps` 命令行含 `--user-data-dir=<dir>` 才终止，防 pid 复用误杀；全部清理 best-effort、不阻断主流程；
- **可用性护栏**：`closeForSession` 等调用点带 `?.` / catch 容错（最小测试夹具未装配 browser 时跳过），生产装配不受影响。

## 被否决的方案

- **按用户分进程 / 分库**：运维与连接中心（全局资源）语义分裂，成本远超收益；
- **每业务会话独立 Profile**：local 登录态分裂（ADR 0120 已否决同族方案），且 Chrome 目录体积 ×N；
- **Profile 按连接而非按用户隔离**：持久登录态天然属于「人」，连接是可换的接入配置；
- **配额硬拒绝（不先回收）**：把「本可自动恢复」场景变成用户负担；
- **清理时不校验命令行直接 kill pid**：pid 复用误杀风险不可接受；
- **启动对账仅清 DB、不清进程与目录**：三重残留治理不完整（崩溃对账是 M62 的核心承诺）；
- **占用表改全局会话索引**：按 endpoint 收敛即可满足分治需求，全局索引徒增同步面。

## 适用与失效条件

- 适用：多用户模式（`users` 非空）；local / managed / remote 全后端共享同一套归属与生命周期逻辑（remote 无进程 / 目录，注册表与 DB 语义照常生效）；
- 失效条件：Chrome 调试参数形态变化（`--user-data-dir` 不再是 pid 校验锚点）须复核清理逻辑；`ps` 不可用的精简容器须提供替代校验；Profile 根命名规则（`u_<userId>`）变化须同步对账扫描与复用防御；实例体量（内存 / 启动耗时）显著变化时复核配额与空闲阈值默认值。

## 状态

Accepted · M62-A（2026-09-19；门禁：server 1134/1134 · client 892/892 · typecheck / lint 0 错 · build 通过）
