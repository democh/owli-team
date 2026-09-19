# ADR 0136：联网工具去除访问限制——web_fetch 域名白名单机制移除 · web_search 退出环境门控（修订 ADR 0035 / ADR 0099）

- 状态：Accepted
- 引入：联网去限制批（2026-09-19）
- 相关：[design.md §56](../design.md)、ADR 0014（工作区沙箱）、ADR 0035（web_search 引入 + web_fetch 白名单边界，本 ADR 修订其白名单判定）、ADR 0099（环境门控体系，本 ADR 撤销其中 web_search / web_fetch 两条门控）、[server/src/tools/web_fetch.ts](../../server/src/tools/web_fetch.ts)、[server/src/tools/web_search.ts](../../server/src/tools/web_search.ts)、[server/src/tools/availability.ts](../../server/src/tools/availability.ts)

## 背景

- 用户实测截图（调研类会话）：`web_fetch` 连续两次被拒「域名不在白名单：baijiahao.baidu.com / zhuanlan.zhihu.com（允许：joinquant.com、ricequant.com、myquant.cn）」，明确诉求「不要限制请求的url，所有的url」；随后进一步要求「所有调用网络部分都不需要限制」；
- 既有语义：`WEB_FETCH_ALLOWED_DOMAINS`（留空 = web_fetch 不可用；非空 = 仅白名单域名，含重定向最终域名校验）与 `WEB_SEARCH_ENABLED`（缺省关闭 = web_search 不可用）——两者均为 ADR 0035 / 0014 建立的「最小暴露」安全边界；ADR 0099 将二者登记为环境门控类（不进模型清单 + 执行期守卫双保险）；
- 差距：「先搜后抓」链路天然面对全部站点，域名白名单维护永远滞后于调研目标（「搜得到、抓不到」）；联网工具的能力开关使网络能力默认不可用或需手工维护配置——与用户「联网调用不设限制」的诉求冲突。

## 决策

1. **web_fetch 域名白名单机制整体移除**：删除 `WEB_FETCH_ALLOWED_DOMAINS` 配置（AppConfig / ToolRuntime / .env）、`domainAllowed` 辅助函数与首次 + 重定向两处校验——任意 http/https 地址均可抓取；
2. **web_search 退出环境门控**：删除 `WEB_SEARCH_ENABLED` 配置与 `webSearch.enabled` 运行时字段——工具始终可用；API 模式 / HTML 模式仍按 `BAIDU_SEARCH_API_KEY` 是否配置自动选择；
3. **门控体系收敛**：`toolUnavailableReason` 仅保留 run_command（`ALLOW_RUN_COMMAND`）；`WEB_FETCH_DISABLED_SUMMARY` / `WEB_SEARCH_DISABLED_SUMMARY` 文案删除；`WEB_FETCH_ALLOWED_DOMAINS` / `WEB_SEARCH_ENABLED` 从 `.env` / `.env.example` / `docs/operations.md` 移除；
4. **保留保护性机制（非访问限制，不在本批范围）**：
   - 协议校验（http/https）、反爬栈（浏览器头 / 域名限速 / 429 退避 / 风控识别与冷却 / GBK 解码 / 超时）——防封禁与防拖垮；
   - 体积上限（web_fetch 512KB / web_search HTML 2MB）与回灌上限（8000 / 4000 字符）——防上下文与内存爆炸；
   - 限速经 `HTTP_MIN_INTERVAL_MS` 可调（`0` = 不限速）；
5. **不在本批范围（非网络访问限制）**：`run_command` 开关（本地命令执行）、`FINANCE_ENABLED`（金融模块功能开关，非访问限制；当前已开启）、浏览器导航协议白名单（本地资源访问）、MCP / SSH / DB（连接配置驱动）。

## 理由

- **定位回归「资料获取」**：联网工具的价值在任意来源取证；把可访问性绑定到白名单配置维护不可持续（截图即一次性失败两例）；
- **口径统一**：web_search（HTML 模式）本就抓取任意百度结果页；两个联网工具一个全地址、一个白名单/开关，模型无法形成稳定直觉；
- **保护与限制分离**：反爬限速 / 冷却 / 体积上限是「防封禁、防爆炸」的保护机制，不改变「能访问什么」；协议校验是技术边界（Node fetch 不支持 file:// 等）；三者保留；
- **本地单信任域基线**：本项目为本地单用户 Harness（无多租户 / 无外包网络），出站访问限制的收益低于其造成的调研摩擦成本。

## 被否决的方案

- **仅把 .env 白名单扩成常见域名集合**：治标不治本——白名单维护永远滞后于调研目标；
- **保留白名单/开关但默认放开（可选收紧；本 ADR 前一稿方案）**：仍保留配置面与「何时会被限制」的不确定性，与「所有调用网络部分都不需要限制」的明确诉求不符；
- **彻底移除反爬保护（限速 / 冷却 / 退避）**：验证页重试与高频请求会加深封禁（ADR 0035 已论证），直接损害联网成功率；
- **移除体积上限 / 回灌上限 / 超时**：超大页面拖垮上下文与内存、无超时挂起——稳定性风险，非用户可感知的「访问限制」；
- **追加 SSRF 守卫（拒绝内网 / 环回）**：本地单用户无多租户威胁模型，且用户诉求为「所有 URL」；多用户化（M57 P2+）或出站策略引入时再评估。

## 影响

- 服务端：`web_fetch.ts`（白名单机制与校验删除）、`web_search.ts`（启用守卫删除）、`availability.ts`（联网门控与文案删除）、`config.ts` / `registry.ts` / `orchestration/engine.ts`（字段与注释清理）；
- 配置 / 文档：`.env` / `.env.example`（两变量移除）、`docs/operations.md §4.5`、`design.md §56.2`（修订注记）与 §12 非目标；
- 资产：`agents/research/_protocol.md`、`agents/research/scout/AGENT.md`、`skills/deep-research/SKILL.md`（删「白名单 / 未启用」表述）+ `agents/CHANGELOG.md` v69；
- 测试：`m5`（web_fetch 用例收敛为「无白名单任意抓取」）、`m47`（门控单测收敛 / 清单计数 51 / 发现区块「联网（2 个）」）、`web-search`（未启用用例删除）、全仓 ToolRuntime / AppConfig 测试替身字段清理；
- 兼容性：原「留空 = 禁用 / 仅白名单可抓」部署行为变为「不限制」；如需收紧网络访问，需在角色 tools 白名单（不授予 web_fetch / web_search）或网络层（防火墙 / 代理）实现，本仓库不再提供配置面。

## 适用与失效条件

- 适用：全部会话 / 全部角色的 web_fetch（含重定向链路）与 web_search 调用；
- 失效条件：多用户 / 多租户化（M57 P2+）、引入出站网络策略或 SSRF 威胁模型变化时，重新评估「默认不限制 vs 默认收紧」并修订本 ADR；
- 已知边界：web_fetch 可访问内网 / 环回地址（本地单信任域下刻意接受）；反爬冷却（风控后 host 暂停 60s）与体积上限保留，属保护机制而非访问限制。
