# ADR 0141：浏览器实例观测面——admin 实例总览 · 连接控制台「实例」页签（M62-C）

- 状态：Accepted
- 引入：M62-C（2026-09-19）
- 相关：ADR 0120（复用实例徽章）、ADR 0134（M57 管理面 admin-only 口径）、ADR 0139 / 0140（治理内核与连接线）、[design.md §89](../design.md)、[server/src/routes/browser.ts](../../server/src/routes/browser.ts)、[client/src/components/console/ConnectionsConsole.tsx](../../client/src/components/console/ConnectionsConsole.tsx)

## 背景

M62-A/B 落地了实例隔离、配额回收与连接线治理，但运行时状态此前只有 per-session 视图（浏览器面板 / 历史行）：admin 无法一屏回答「谁在占用几个浏览器 / 哪些空闲 / 哪些异常 / 哪些连接被租约占用」；空闲回收与配额拒绝发生时用户缺少显式入口（只能等面板逐个关闭）。

## 决策

1. **admin 实例总览端点**：`GET /api/browser/sessions`（admin-only；单用户兼容模式放行，与连接管理 / 用户管理等管理面口径一致）返回活跃实例：`id / sessionId / ownerId / ownerName / backend / state / controller / headless / external / connectionId / currentUrl / createdAt / lastFrameAt / idleMs / subscribers`；数据源 = `runtime.listDetailed()`（内存注册表 + `subscriberCount` 注入 + users store 补显示名）。
2. **连接控制台「实例」页签**：admin 可见（成员隐藏且**不发起**实例请求——实例元数据含他人 URL，跨户信息泄漏面控制在管理面）；行 = 归属显示名 / 后端 / 状态（含人工）/ 观察者数 / 复用徽章 / 当前 URL / 空闲时长 / 启动时刻 + 行内关闭（复用 `POST /browser/sessions/:bsid/close`，关闭后本地列表移除）。
3. **面板文案对齐**：复用实例徽章 tooltip 明确「复用了你已运行的浏览器实例（同一账号的 local 持久配置）」；空闲回收 / 配额 / 租约 / 绑定错误由服务端文案原样透出（均可操作）；空闲回收经 `closed` 事件广播原因（面板提示「再次调用 browser_* 会自动重启」）。
4. **历史回放归属修复（同批收口）**：`canAccessBsid` 对已关闭会话改按库内 `user_id` 判定——成员可回看**自己**的历史 bsid 步骤 / 截图（此前仅 admin）；无归属行（兼容模式遗留）仍仅 admin。

## 理由

- **admin-only 而非成员可见**：与 M57「系统级资源管理面 admin-only」一致；成员对自己实例的可观测性由浏览器面板承担（已有完整视图），无需重复暴露全局面；
- **聚合在连接控制台而非新管理页**：实例与连接同域（占用 / 租约 / 健康），单页面对比排障成本最低；「实例」页签与「操作」流水并置，符合排障动线；
- **数据源单一**：观测与配额 / 回收共用 runtime 内存注册表与订阅计数（`listDetailed` 复用 `infoOf` + `lastActiveAt`），不引入第二份统计口径；
- **回放归属修复**：最小惊讶原则——自己的历史证据链（步骤 / 截图）不应被隐去；判定数据来自 v15 迁移落库的 `user_id`。

## 被否决的方案

- **成员可见实例总览（只读）**：实例元数据含他人 URL / 业务会话，跨户信息泄漏面不必要；
- **独立管理页 / 右栏新面板**：与 ADR 0100（右栏收敛）冲突，且连接控制台聚合已覆盖排障动线；
- **按用户分组视图 / 实例图表**：首版规模（≤ 全局上限 8）不需要，行式清单足够；
- **回放继续仅 admin**：成员自己的历史浏览器证据被隐去，支持与审计双损；
- **实例页签对所有模式一致展示**：兼容模式（无账号）`isAdmin` 恒真，自然等价展示，无额外分支。

## 适用与失效条件

- 适用：多用户与兼容模式（后者合成管理员，页签可见）；观测字段随运行时演进（新增字段只增不改，客户端可选消费）；
- 失效条件：实例规模显著增长（数十以上）须改为分页 / 虚拟列表；若未来开放「成员可见只读视图」，须重新评估 URL 字段的脱敏口径。

## 状态

Accepted · M62-C（2026-09-19；门禁：client 新增 m62-browser-instances 2 例全绿；admin 可见 / 成员隐藏且不请求两态）
