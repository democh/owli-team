# ADR 0140：浏览器连接线治理——远端连接独占租约 · 重连端点再解析 · 连接健康回写 · 最小权限复核（M62-B）

- 状态：Accepted
- 引入：M62-B（2026-09-19）
- 相关：ADR 0042（连接中心与 CDP 接入）、ADR 0051（多标签页跟随——「remote 共享实例会接管他人页面」失效项收口）、ADR 0120（CDP 韧性：保活 / 退避重连）、ADR 0139（实例治理内核）、[design.md §89](../design.md)、[server/src/browser/runtime.ts](../../server/src/browser/runtime.ts)、[server/src/browser/session.ts](../../server/src/browser/session.ts)、[server/src/stream.ts](../../server/src/stream.ts)

## 背景

「连接线」在本批定义为三条链路：实例 ↔ 服务端的 CDP 连接链路、服务端 ↔ 面板的帧流 / 输入通道、连接中心 ↔ 实例的健康线。M57 后仍存在的缺口（代码核实）：

- **remote 无租约**：同一 CDP 端点可被任意多会话接入——页面互抢（ADR 0051 已注明失效项「remote 共享实例会接管他人页面」）；外部人打开的页面也不受页面分治约束；
- **重连端点固化**：`tryReconnect` 用固定 endpoint——远端端点重启换端口、local/managed 进程重启后 `--remote-debugging-port=0` 端口漂移均无法自愈（只能重试耗尽落 error）；
- **健康线失真**：`connections.status` 只由「测试」按钮回写；真实接入失败 / 断线 / 重连耗尽不落状态灯；
- **最小权限缺口**：`browser_open(connection_id)` 与面板启动均未校验「会话已绑定该连接」，`member_use` 只在绑定时校验——成员可用任意 chrome 连接（绕过绑定纪律）；admin 收回 `member_use` 后已绑定会话仍可继续用；
- **同用户接管自锁**：takeover 单持有者按 topic 拒绝——右栏面板 + 直播窗 + 多标签页是该账号常态，一个视图接管后另一个视图被自己挡在门外。

## 决策

1. **remote 独占租约**：同一连接（`conn:<id>`）或同端点（`endpoint:<ws>`）同时只允许一个活动浏览器会话接入；占用者仍活跃才拒绝（关闭即释放）；连接 `config.shareInstance === true` 显式放开并发接入（共享时按 ADR 0138 页面分治）。拒绝错误含连接名与出路（关闭原会话后重试）。
2. **重连端点再解析**：`BrowserSession` 增 `resolveEndpoint` 注入，每次重连尝试前调用、失败回退固定端点（退避序列不变）；remote 的 http(s) 端点重新 `resolveCdpEndpoint`（`ws://` 无再解析余地），local 读 `DevToolsActivePort` + `probeEndpoint`；成功换端点后更新内存与 `browser_sessions.endpoint`。**不引入进程级自动重启**（承袭 ADR 0120 否决项）。
3. **连接健康回写**：以真实接入结果回写——启动 / 端点解析 / CDP connect / session.start 失败与重连耗尽 → `error` + `lastError`（截断 500 字符）；成功接入与自动重连成功（`step.action === 'reconnect' && ok`）→ `ok`；正常关闭（用户 / 空闲 / 删除）不回写（连接本身仍存在）；同一连接 30s 节流防抖动。
4. **最小权限复核**：`ensureForSession` 在 owner 存在时校验——连接 `enabled` + **会话绑定**（`connections.isBound`，未绑定给「去连接管理绑定」指引）+ 成员 `member_use`（admin 豁免）；与 db / mcp 既有最小权限口径对齐（`db.manager requireBinding` / `mcp isBound` 先例）。
5. **帧流线**：`StreamHub.subscriberCount(topic)` 新增（空闲回收判定的数据源，经 runtime deps 注入、未注入视为 0）；**同用户 takeover 流转**——同 `userId` 的新 takeover 订阅转移持有权（原客户端收 `takeover_moved` 并降级 watch，会话控制权保持 human），跨用户保持 `takeover_busy` 拒绝；兼容模式（无 userId）沿用单持有者拒绝。

## 理由

- **独占租约而非共享**：remote 端点上的页面可能由外部人产生（非本系统会话），页面分治约束不了外部行为；独占是唯一可控边界；共享仅用于受控场景（专用测试端点），显式开启并留审计；
- **端点再解析成本极低**：只在重连窗口内探测（此前必然失败），不改变稳态行为；覆盖「远程重启换端口」这一运维常态，与 ADR 0120「自愈优于报错」一致；
- **健康线必须单一事实源**：连接卡片是运维第一入口，状态应反映最近一次真实使用结果；30s 节流避免状态灯高频抖动刷库；
- **绑定复核与既有口径对齐**：浏览器连接与 db / mcp 同类（会话级最小权限资源），补齐后三者一致，减少认知负担；
- **同用户流转的必要性**：单用户多视图（面板 / 直播窗 / 标签页）是产品既有形态，把用户自己挡在门外没有任何安全收益；跨用户严格拒绝不受影响。

## 被否决的方案

- **remote 完全共享（无租约）**：外部页面不可控，页面分治不约束外部行为（ADR 0051 失效项的直接成因）；
- **租约占用即拒绝（不判断占用者是否活跃）**：关闭 / 崩溃后的陈旧租约会造成误锁，运行时活跃判定是唯一权威；
- **断线自动杀进程重启浏览器（local / managed）**：端口漂移 + 用户可能已手动退出，可控性差（ADR 0120 承袭否决）；自愈走「端点再解析 + 按需重启」；
- **健康回写无节流 / 每次动作都写**：状态灯高频抖动、SQLite 写放大；
- **`member_use` 仅在绑定时校验**（现状）：收回后已绑定会话仍可用，最小权限形同虚设；
- **同用户 takeover 也严格单持有**（现状）：与单账号多视图形态冲突，无安全收益；
- **应用层命令保活 / 更激进探测**：污染调用记录（ADR 0120 已否决）。

## 适用与失效条件

- 适用：多用户模式（owner 存在）下的连接线治理；绑定 / member_use 复核对全部 backend 生效；租约对 remote 默认独占、`shareInstance` 显式放开；端点再解析对 remote（http 形式）与 local 生效（managed 临时实例无复用场景，不注入）；
- 失效条件：remote 端点若始终以 `ws://` 形式配置（无 http 探测入口）→ 再解析退化为无操作，须在连接表单提示；`shareInstance=true` 的连接若被多用户并发接入，页面分治只覆盖本系统会话，须复核使用纪律；同用户 takeover 流转依赖流 token 的用户绑定（M57），兼容模式（无 userId）不适用。

## 状态

Accepted · M62-B（2026-09-19；门禁：server 1134/1134 · client 892/892 · 帧流线用例含同用户流转与跨用户拒绝）
