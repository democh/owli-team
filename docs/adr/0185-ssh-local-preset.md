# ADR 0185：SSH「本地」预置——连接管理新建表单一键填入（连接中心微批）

- 状态：Accepted
- 引入：连接中心微批（2026-09-19）
- 相关：[design.md §112](../design.md)、[server/src/connections/ssh/local-preset.ts](../../server/src/connections/ssh/local-preset.ts)、[server/src/routes/connections.ts](../../server/src/routes/connections.ts)、[client/src/components/console/ConnectionsConsole.tsx](../../client/src/components/console/ConnectionsConsole.tsx)、[shared/src/types.ts](../../shared/src/types.ts)、[server/tests/m23.test.ts](../../server/tests/m23.test.ts)、[client/tests/m23-frontend.test.tsx](../../client/tests/m23-frontend.test.tsx)、[docs/api.md §11.1](../api.md)

## 背景

- 新建 SSH 连接需逐项手填主机 / 端口 / 用户名 / 认证方式；「连本机」是开发与演示的最常见起点，但**本机用户名、默认私钥路径、sshd 是否在监听**都要人工查（macOS 默认不开启 sshd，需系统设置手动开「远程登录」）；
- 浏览器连接已有「默认 local（自动发现）」先例（表单 backend 缺省 `local` + `/api/browser/discover` 自动发现），SSH 缺少等价的「本地」一键默认；
- 连接管理的 SSH 表单已支持 password / key / agent 三种认证与 `~` 展开（连接器 `expandHome`），只差「把本机默认值探出来」这一段。

## 决策

1. **服务端探测 `detectSshLocalPreset`**（`server/src/connections/ssh/local-preset.ts`）：用户名 = `os.userInfo().username`（极端环境回退 `USER` / `USERNAME`）；认证优先级 **agent**（`SSH_AUTH_SOCK` 非空，无凭据落库即用）> **key**（`~/.ssh` 默认私钥按 `id_ed25519 → id_rsa → id_ecdsa` 序，以 `~` 形式回传）> **password**（仍需用户填写密码）；22 端口 TCP 探测（600ms 超时，connect / timeout / error 三路收敛为布尔，不抛错）；
2. **只读端点** `GET /api/connections/ssh-preset`（`adminOnly`，与 `/connections/probe` 同面）→ `{ preset: { name, host, port, username, authMethod, privateKeyPath?, agentAvailable, sshdReachable } }`；**注册先于 `/connections/:id`**（防被 id 参数吞没为「连接不存在」）；
3. **前端（新建态专属）**：新建 SSH 表单顶部「本地（本机）」chip → 拉探测 → 回填 `name`（仅在名称为空时）/ `host` / `port` / `username` / `authMethod` / `privateKeyPath`；**凭据字段（password / privateKey / passphrase）不动**；行内给出探测结论（认证方式 + 22 端口未监听时附系统「远程登录」指引）；编辑态不出现；
4. **不代建连接**：预置只填表单，用户审阅后走既有「保存 / 保存并测试」；`allowExec` 保持默认关（安全默认不因预置变化）；
5. **探测零副作用 + 可测试**：`homeDir` / `env` / `username` / `probePort` 全部可注入——单测不触真实 `~/.ssh` 与网络。

## 理由

- **agent 优先**：预置不应引导用户把密码落库；`SSH_AUTH_SOCK` 在场时 agent 是零凭据的最快路径；私钥路径作为无 agent 时的次选（文件读取复用连接器既有 `expandHome` 语义，不复制逻辑）；
- **服务端探测而非前端硬编码**：浏览器拿不到宿主 OS 用户名与私钥路径，硬编码 `127.0.0.1` 之外的价值为零；
- **端口可达作为提示而非门禁**：macOS 本机 sshd 默认关闭是高频失败点，预探测把「22 端口未监听」提前到填表时说明，但不阻断保存（用户可能后开 sshd、或目标其实是端口转发后的本机）；
- **600ms 超时 + 三路布尔**：预置是尽力而为的便利，探测失败必须降级为提示，不能阻塞表单。

## 被否决的方案

- **启动时自动创建 system「本地」连接**：无请求的写库副作用 + 审计缺失；本机 sshd 未开时留下必定失败的僵尸连接；
- **一键直接 POST 建连接**（跳过表单）：绕过用户对用户名 / 认证方式 / `allowExec` 的审阅，与连接中心的「显式配置」纪律相悖；
- **前端硬编码本机预置**：拿不到 OS 用户名与私钥路径，价值减半；
- **用真实 SSH 登录探测可用认证**：需要凭据与连接副作用（且本机可能未开 sshd），超出「表单预置」职责，交给既有 `/connections/:id/test`；
- **自动探测 macOS launchd 的 agent socket 路径**（`SSH_AUTH_SOCK` 为空时兜底）：与连接器 `resolveConnectConfig` 的 agent 判定（只认 `SSH_AUTH_SOCK`）会形成双口径，另批统一评估。

## 边界与失效条件

- **预置 ≠ 就绪**：agent / key 探测只说明「服务端看得见凭据」，不保证 sshd 已授权该公钥；最终可用性以「保存并测试」（`/connections/:id/test`）为准；
- **22 端口探测是 TCP 可达而非 SSH 协议握手**：端口转发 / 代理后的假可达由连接测试兜底；
- **单机前提**：探测的是**服务端宿主**的本机（自托管单机形态）；服务端与用户桌面分离的部署下「本地」= 服务器本机，语义与文案仍成立；
- **admin 面**：入口在连接管理（admin-only 控制台）；成员个人连接（设置 →「我的连接」）不在本批（其表单为密码单一认证，预置价值低）。

## 验证

- server `tests/m23.test.ts` **27 例**（+5：探测默认键 / 认证优先级与私钥候选序 / 端口探测参数透传 / 路由形状（不受本机 sshd 与私钥存在与否影响）/ 路由不被 `/connections/:id` 吞没）；
- client `tests/m23-frontend.test.tsx` **15 例**（+1：「本地（本机）」一键预置回填（名称 / 主机 / 端口 / 用户名 / 认证 / 私钥路径）+ 22 端口未监听提示 + 保存载荷契约（无凭据不携带 secret））。
