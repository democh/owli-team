# ADR 0213：联网与凭据安全加固——UA 池可配 · Cookie 分桶 · SSH 指纹 · 口令脱敏 · 写类不重试

- 状态：Accepted
- 引入：连接与联网加固批（2026-09-23）
- 相关：[server/src/tools/http.ts](../../server/src/tools/http.ts)、[server/src/tools/registry.ts](../../server/src/tools/registry.ts)、[server/src/browser/session.ts](../../server/src/browser/session.ts)、[server/src/connections/ssh/connector.ts](../../server/src/connections/ssh/connector.ts)、[server/tests/anti-bot.test.ts](../../server/tests/anti-bot.test.ts)、[server/tests/m23.test.ts](../../server/tests/m23.test.ts)、[server/tests/tools.test.ts](../../server/tests/tools.test.ts)

## 背景

M57 多用户与联网工具长期运行暴露若干横切风险：① 内置 UA 池版本滞后于主流浏览器（反爬误杀面扩大）；② 联网 Cookie 罐为进程级全局桶——多用户同站点会话可能串号；③ web_search 的「手工拼 Cookie 预热」与反爬层 Cookie 罐双套机制并存（绕过域 / 路径 / 过期语义）；④ 写类工具失败自动重试可能在「服务端已生效但响应失败」时造成重复副作用；⑤ 浏览器表单口令会以明文片段随步骤时间轴落库；⑥ 浏览器截图目录随会话只增不减；⑦ SSH 连接无主机指纹校验（MITM 面）。

## 决策

1. **UA 池**：内置池刷新至主流稳定版（Chrome 151 / Safari 26）；新增 `HTTP_UA_POOL`（每行一个，与内置池**前置合并**、按 host 散列选择，`effectivePool` 共享实现）——版本跟进不再等发版。
2. **Cookie 罐按 `cookieKey` 分桶**（触发者 userId；缺省 = 全局桶）：多用户同站点会话互不串号；web_search 预热统一走反爬层 Cookie 罐（删除手工 cookie 拼接与独立缓存；按「引擎 + 用户」30 分钟节流）。
3. **SSH 主机指纹校验（opt-in）**：连接 config `hostFingerprint`（`SHA256:<base64>` 或 64 位 hex，归一化去冒号后由 hostVerifier 比对；不匹配拒绝连接并记错误日志）；缺省不启用——存量连接零影响；连接表单补「主机指纹」字段。
4. **写类工具不自动重试**：registry 失败重试仅对 `readOnly === true`（幂等）生效；写类失败直接返回 `工具失败：…` 交由模型按语义决定是否重来。
5. **浏览器口令脱敏**：fill 动作命中 password 输入时，步骤时间轴落库值替换为 `***`（`elementCenter` 附带 password 标记）。
6. **截图目录清理**：浏览器会话关闭 / 回收时删除 `browserShots/<browserSessionId>`。

## 被否决的方案

- **写类工具也重试（交给工具作者自行保证幂等）**：错误边界不可判——超时 / 断连既可能未生效也可能已生效；统一不重试是唯一保守口径。
- **强制 SSH 指纹校验**：存量连接会一次性全断，且首次连接无既有指纹可比（TOFU 交互未设计）→ 采用 opt-in 渐进。
- **引入第三方 UA 数据库 / 指纹库**：与「本地优先 + 最小依赖」不符；静态池 + 配置追加已覆盖。

## 边界与后续

- Cookie 分桶边界：CLI / 无触发者场景走全局桶（与旧版行为一致）；
- 测试：`anti-bot.test.ts`（effectivePool 合并语义 / cookieKey 分桶不串号）、`m23.test.ts`（指纹解析与 hostVerifier 命中 / 拒绝 / 非法格式）、`tools.test.ts`（写类不重试 / 只读重试 1 次）；
- 镜像面：`.env.example`（`HTTP_UA_POOL`）、`docs/operations.md` §4.5、design.md §119、本 ADR + `docs/adr/README.md` 索引。
