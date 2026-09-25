# ADR 0218：联网出口层（M82）——BYO 代理与隧道模式（统一出口 · 按通道路由 · 失败回退）

- 状态：Accepted
- 引入：M82 联网出口批（2026-09-25；P0 落地，P1 见下「后续」）
- 相关：[ADR 0035](0035-web-search-baidu-anti-bot.md)（web_search 双模式 + antiBotFetch 反爬栈）、[ADR 0184](0184-web-search-multi-engine-fallback.md)（多引擎降级链；含「代理池 / 第三方中转」否决口径）、[ADR 0134](0134-multi-user-foundation.md)（M57 多用户）、[ADR 0213](0213-network-and-credential-hardening.md)（联网与凭据加固）、[docs/egress-proxy-design.md](../egress-proxy-design.md)（专项设计全量）、[server/src/net/egress.ts](../../server/src/net/egress.ts)、[server/tests/egress.test.ts](../../server/tests/egress.test.ts)

## 背景

全仓联网能力此前没有任何出网代理能力（`grep proxy` 仅命中入站 `TRUST_PROXY` / Vite 开发代理）：`web_search` / `web_fetch` / 财经 Node 源全部经 `tools/http.ts` 的 `antiBotFetch` 从宿主 IP 直出，浏览器 / MCP / Python 桥各自直出。由此三类诉求无法满足：

1. **IP 级风控换出口**：ADR 0184 的多引擎降级链只能「换站点」，当同一出口 IP 被全链牵连时无法「换出口」；
2. **企业 / 合规固定出口**：需全部抓取经统一网关留痕，且代理失败时宁可失败、不得泄漏真实 IP；
3. **本机隧道复用**：用户已有 Clash / V2Ray / 公司客户端，只能改宿主全局代理（Node 的 `fetch` 默认甚至不认 `HTTP_PROXY`）。

关键事实核验（2026-09-25 实测）：npm `undici` 的 `ProxyAgent` **不能**直接传给 Node 内置 `fetch`（`UND_ERR_INVALID_ARG: invalid onRequestStart`，npm v8 与 Node 24 内置版本不同）；改用同包 `undici.fetch` 后，绝对 URI 转发、CONNECT 隧道、URI userinfo / token 鉴权、`AbortSignal` 语义全部通过冒烟。Chrome 侧 `--proxy-server` 支持 http(s)/socks5 但**不支持命令行下发代理凭据**（headless 无鉴权弹窗）——这是 P1 引入「本地出口桥」的结构性原因。

## 决策

1. **统一出口层**：新增 `server/src/net/egress.ts` 作为所有外网请求的唯一出口决策点，Route 四形态 `direct / http-proxy / socks5 / ssh-tunnel`（P0 实现前三者；`ssh-tunnel` 创建期显式拒绝并提示 P1，避免「建了不生效」）。
2. **按通道路由 + 显式启用**：`egressChannels`（默认 `search/finance/browser`）决定哪些通道跟随全局出口，未列出通道恒直连——防「为爬虫配代理把本地 / 国内模型端点打挂」；`llm/mcp` 默认不跟随。
3. **配置三层**：目标与凭据在连接中心新 `kind='proxy'`（SecretVault 加密、`secretSet` 标记、明文永不回传）；策略（模式 / 引用 / 通道 / 旁路 / 回退 / 探测地址）在运行期设置热更新；env（`EGRESS_*`）仅作启动默认与无 DB 后备（`EGRESS_PROXY_URL` 仅在未选连接时生效，连接缺失 / 禁用 → 回落直连并**显式告警**，绝不静默降级到后备）。
4. **Node 侧实现**：依赖 `undici`（纯 JS），代理路径统一走**同包 `undici.fetch` + ProxyAgent**（保证 dispatcher 与实现同版本）；直连路径保持全局 `fetch`（零行为变化）。SOCKS5 由 undici `Socks5ProxyAgent` 原生承接（远端 DNS，域名 ATYP）；**凭据载体按形态区分（实测）：HTTP(S) 代理用 `token`（proxy-authorization），SOCKS5 用 `username/password` 选项**（`token` 对 SOCKS5 静默失效）。
5. **旁路与安全红线**：回环（`localhost` / `127.x` / `::1`）**硬编码恒直连**（本地服务安全红线，与配置无关）；配置旁路支持域后缀 / 裸域名 / IP / IPv4 CIDR，与连接级 `bypass` 求并集。
6. **回退矩阵**：`egressFallback='direct'`（默认）时出口层失败 → 以直连重试一次并在工具结果标注「（出口代理不可用，已直连）」；连续 2 次出口级失败进入 60s 降级冷却（冷却期直连、到期自动重试）；`'fail'`（合规严格）绝不回退——`llm/mcp` 通道恒严格。
7. **错误分类隔离**：新增 `AntiBotError('egress')`——出口失败**不**计入目标 host 风控冷却（`tools/http.ts` 软封锁计数同效），财经网关 `isEgressFailure` 不为出口失败冷却数据源（否则「代理挂了 → 全源冷却 5 分钟」的错误归因）。
8. **可观测**：每响应经 WeakMap 附带出口元信息 → 工具 summary 标注实际出口 / 回退 / 降级；连接卡片「测试」= 出口探测（经该出口请求 `egressProbeUrl`，回显出口 IP / 延迟并回写 status）；`GET /api/egress/status` 供面板；设置变更首次落审计（`settings.update`，仅字段清单）。
9. **BYO 口径（与 0184 的边界）**：平台只提供管道，出口由部署方提供并自负合规责任；**不**内置代理池 / 自动轮换 / 第三方代抓中转（0184 否决口径延续）。

## 理由

- **单点改造覆盖主链路**：`web_search` / `web_fetch` / 财经 Node 源本就收敛于 `antiBotFetch`，一处接入即覆盖三大抓取通道；浏览器 / 子进程 / LLM 各自有干净注入点（启动参数 / env / SDK `fetch`），无需重构网络层。
- **同包 fetch 而非版本碰运气**：npm `ProxyAgent` 喂给内置 `fetch` 已实测失败；用 `undici.fetch` 保证「dispatcher 与实现同版本」，且未来 Node 升级不影响代理链路（设计文档预写的兜底分支直接启用）。
- **按通道而非全局一刀切**：本地 Ollama / ComfyUI / 国内模型端点与「换出口抓取」是相反诉求，默认只让 `search/finance/browser` 跟随；llm/mcp 需显式加入。
- **错误分类隔离是可用性刚需**：出口故障若被当成「站点风控」，会连锁产生 host 冷却 + 数据源冷却，把一次代理抖动放大成全功能不可用。
- **凭据与策略分层**：`settings.json` 无加密能力，凭据必须走 SecretVault；连接中心已具备 CRUD / 状态 / 审计 / 成员可见性语义，新增 kind 复用全部既有面。

## 被否决的方案

- **平台内置代理池 / 自动轮换 / 第三方中转**：信任、成本与合规风险（ADR 0184 口径延续）；
- **仅靠 `NODE_USE_ENV_PROXY=1` + 进程 env**：进程级、需重启、无法按通道路由、凭据只能明文入 env 文件；仅作为 P1 子进程注入的一个环节保留；
- **引入 `https-proxy-agent` / `node-fetch` 栈**：与既有 undici 栈并存两套网络层，重构面大、收益为零；
- **默认严格失败（不回退）**：反爬场景代理抖动 = 检索整体不可用；改为「search/finance/browser 默认回退 + llm/mcp 恒严格」；
- **把所有通道默认纳入出口**：会打挂本地 / 国内模型端点（零回归红线）；
- **浏览器 / 隧道直接吃鉴权代理**：Chrome 命令行不支持代理凭据；SSH 隧道无原生消费方 → P1 统一收敛到本地出口桥；
- **回退放在工具层各自实现**：出口语义（绑定 / 旁路 / 冷却 / 标注）必须单点拥有，否则各工具行为漂移。

## 影响

- 新增：`server/src/net/egress.ts`（出口层）、`server/tests/egress.test.ts`（29 例：配置解析 / 旁路 / 路由 / HTTP 代理链路 / SOCKS5（含账号口令 RFC 1929 握手）/ 鉴权 / 回退 / 降级 / 探测 / 路由层 CRUD / 设置热更与审计 / antiBotFetch 集成 / 工具标注）、`client/tests/m82-egress.test.tsx`（4 例：设置区块渲染与出口状态 / 保存载荷 / 测试出口 / 新建出口代理载荷）；依赖 `undici`（server workspace，exact 版本）。
- 改动：`tools/http.ts`（`egressChannel` + `AntiBotError('egress')` + 响应携带出口元信息）、`tools/web_search.ts` / `tools/web_fetch.ts`（通道注入 + summary 标注 + egress 文案）、`finance/fetcher.ts`（finance 通道）+ `finance/gateway.ts`（出口失败不冷却源）、`config.ts` / `settings.ts`（`egress*` 字段与 env）、`routes/connections.ts`（kind=proxy 校验 / 成员 403 / 不参与绑定 / 测试=探测 / 变更失效）、`routes/settings.ts`（出口字段变更失效 + 审计 + `/egress/status`）、`routes/index.ts` + `index.ts`（装配 `egress`）、`store/audit.ts`（`settings.update`）、`shared/src/types.ts`（`ConnectionKind + 'proxy'`）、client（连接表单 proxy 形态 + `KIND_META`/`KIND_LABEL` + 设置「联网与出网」区块 + 出口状态/测试）。
- 零回归边界：`egressMode='direct'`（默认）时全部路径与历史一致（既有限量 / 冷却 / 多引擎链 / 财经降级语义不变；server 1488 → 1517、client 1367 → 1371 全绿）。
- 后续（P1，已在设计文档 §13 定案）：本地出口桥（含自研 SOCKS5 客户端与 ssh2 `forwardOut` 出口）→ 浏览器 `--proxy-server` / 实例 `egressKey` 复用守卫、Python 桥与 MCP 子进程 env 注入、LLM / 嵌入 / 媒体远端 `fetch` 注入、remote CDP 出口限制提示。
- 镜像面：`design.md §123`、`docs/operations.md §4.5 + §8`、`.env.example`、[docs/egress-proxy-design.md](../egress-proxy-design.md)（状态回写）、`docs/adr/README.md` 索引、本 ADR。
