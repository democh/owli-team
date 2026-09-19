# ADR 0042：连接中心与 CDP 浏览器接入（M22）

- 状态：Accepted
- 引入：M22
- 相关：ADR 14（工作区沙箱）、ADR 23（HITL 审批）、ADR 43（操作直播窗）

## 背景

Agent 只会在工作区内读写文件，看不到「真实系统」——业务库里的数据、浏览器里的页面。M22 补齐两类外部接入：

1. **数据库连接**：需要长期保存连接配置与凭据（MySQL / PostgreSQL / SQLite），Agent 只能操作「本会话显式绑定」的连接，一切执行留痕；
2. **浏览器自动化**：用户要求像 Codex / Manus 一样「看得见」Agent 的浏览器操作，必要时能人工接管；
3. **约束**：单用户本地应用（无多租户、无 KMS）；主库 SQLite；前端 React + zustand；对新增 npm 依赖保持克制。

## 决策

**连接中心（服务端）+ CDP 浏览器运行时（服务端）+ 右栏面板注册（前端），三层各守其责**：

- **五表落地**：`connections` / `session_connections` / `audit_log` / `browser_sessions` / `browser_steps`（v4 迁移，幂等）；
- **凭据加密**：AES-256-GCM，密文 `v1:` 前缀 + 独立 `secrets.key` 文件；对外接口只回 `secretSet: boolean`，解密失败静默返回 `undefined`（换钥不炸历史行）；
- **会话绑定为最小权限面**：`GET/POST /api/sessions/:id/connections`；Agent 工具一律 `requireBinding: true`（未绑定直接拒绝并提示可用清单）；
- **SQL 护栏（纯函数）**：单语句；只读白名单（SELECT / WITH / EXPLAIN / PRAGMA / SHOW）；判定前剥离注释与字符串字面量；骨架级危险意图兜底（data-modifying CTE / SELECT INTO / 会话设置 / PRAGMA 赋值）；
- **三连接器按需加载**：sqlite 走 `node:sqlite`（零依赖）；pg / mysql 在连接器内动态 import（未装驱动只影响该连接类型，不阻塞应用启动）；
- **CDP 三后端**：`managed`（拉起本机 Chrome 无头实例 + `--remote-debugging-port`）/ `local`（复用本机已开浏览器）/ `remote`（连接已有调试端点）；统一 `BrowserRuntime` 记录步骤（动作 / 结果 / 耗时 / 截图落盘）；
- **帧流独立通道**：`/ws/stream`（与通知 WS 分离），token 分权（`watch` 可复用 / `takeover` 一次性）；服务端节流（5/12/24fps 可调）+ 合并 + 背压丢帧，帧以 base64 JPEG 直出 `<img>`；
- **接管语义**：画面点击即接管（键鼠 / 滚轮 / 键盘直通 CDP，坐标按帧/视口缩放）；`watch → takeover` 换发一次性 token；人工接管期间 Agent 动作挂起为「等待人工」。
- **前端面板注册**：右栏新增「连接 / 操作」「浏览器」两个分段（PANEL_DEFS 注册体系，M22 起右栏面板可扩展）。

## 理由

- **密文前缀 + 独立 key 文件**：单用户本地应用没有 KMS 可用，密钥的泄漏面就是文件系统权限；前缀让「密钥轮换」和「密文版本演进」有迹可循；
- **绑定而非全局可用**：Agent 的上下文里同时活跃多个会话，不绑定就意味着「任何会话都能操作任何库」——绑定把权限面收敛到用户显式动作；
- **护栏用「剥离后判定 + 骨架兜底」而非黑名单**：黑名单永远漏；先做词法剥离（注释 / 字符串 / 美元引号）再做白名单，骨架兜底覆盖 `WITH ... DELETE ... RETURNING` 这类「首个关键字是 WITH 但内含写意图」的绕过面；
- **帧流走 WS 而非 SSE**：帧是「最新优先、可丢弃」的数据——WS 可用 `bufferedAmount` 做背压丢帧；SSE 无背压语义，且与通知共用会互相阻塞；
- **token 分权而非登录态鉴权**：帧流入口是 `<img>` 与 WS 直连，携带不了完整会话头；一次性 takeover token 天然防重放；
- **截图落盘 + HTTP 拉取而非消息内 base64**：步骤截图是「审计证据」，需要持久 + 可懒加载；塞进步骤消息会让历史查询膨胀。

## 被否决的方案

- **凭据明文存 settings.json / config**：任何能读工作区的人即可拿到库口令，且与「审计」承诺矛盾；
- **数据库工具全局可用（不要求绑定）**：Agent 幻觉出的库名可能命中无关连接，最小权限失效；
- **只读白名单不做词法剥离**：`SELECT 'DROP TABLE users; --'` 这类合法查询会被误杀，误杀比漏杀更伤可用性；
- **sqlite 走 better-sqlite3 等原生依赖**：Node 22 内置 `node:sqlite` 已够用，原生编译依赖是安装负担；
- **帧画面用 CDP screencast 直连前端**：跨域、鉴权、token 生命周期都要在浏览器侧重建一遍，且断线重连语义与现有 WS 体系重复；
- **原生 Document Picture-in-Picture API 承载直播窗**：浏览器支持面不全（Safari 无、Chrome 版本门槛），样式控制受限——改用 fixed 浮层（见 ADR 43）。
