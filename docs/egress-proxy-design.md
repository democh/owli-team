# 联网出口专项设计（M82）——IP 代理与隧道模式

> 状态：**已实施（P0 全量落地）**（2026-09-25；P0 代码 / 测试 / 面板 / 文档全量完成，门禁：server 1517/1517 · client 1371/1371 · 双端 + e2e typecheck 0 错 · lint 0 error · build 通过）；落位：design.md **§123**、ADR **0218**；P1（本地出口桥 / 浏览器 / 子进程 / SSH 隧道）待实施，范围与文件清单见 §13
> 范围：全仓出网通道盘点 × 出口模型（直连 / HTTP(S) 代理 / SOCKS5 / SSH 隧道）× 配置面（连接中心 + 运行设置 + env）× 各通道接入改造 × 健康回退 × 安全与合规边界
> 关联：ADR 0035 / [0184](../docs/adr/0184-web-search-multi-engine-fallback.md)（反爬栈与多引擎链，含「代理池」否决口径）、ADR 0042（连接中心与 CDP 接入）、ADR 0120（浏览器启动形态与 CDP 韧性）、ADR 0134（M57 多用户基座）、ADR 0213（联网与凭据加固）；[docs/operations.md §4.5](operations.md)、[docs/finance-invest-design.md](finance-invest-design.md)
> 现状基线（代码核实）：design.md 至 §122、docs/adr 至 0217、里程碑至 M81（本批拟编号 **M82**，ADR 拟编号 **0218**，design.md 拟新增 **§123**）；Node v24.14；server 依赖中无任何代理相关包

---

## 1. 背景与问题

用户诉求：**所有联网搜索 / 爬虫相关通道都要能配置出口——IP 代理或隧道模式**。当前代码全仓没有任何出网代理能力（`grep proxy` 仅命中入站 `TRUST_PROXY`、Vite 开发代理与文档叙述），所有抓取请求一律从宿主 IP 直出。这带来四类现实问题：

| # | 问题 | 代码证据（现状） | 后果 |
| --- | --- | --- | --- |
| 1 | **IP 级风控无解**：百度等站点按出口 IP 封锁时，多引擎降级链只是「换站点」而非「换出口」 | `tools/http.ts`（antiBotFetch 全链直连）；ADR 0184 背景实测 | 全链被同一出口 IP 牵连时，`web_search`/`web_fetch` 完全不可用 |
| 2 | **无固定出口能力**：企业 / 合规部署要求出网经统一网关留痕，应用只能走宿主默认路由 | 无配置项；Dockerfile / docker-compose 亦无代理编排 | 无法接入公司网关 / 审计出口 |
| 3 | **跨区访问受限**：学术、境外资料检索需要经特定区域出口 | `web_fetch` 直连 | 特定资料源不可达 |
| 4 | **本机已有隧道用不上**：用户本机的 Clash / V2Ray / 公司 VPN 客户端已提供本地 http/socks 入口，应用无「指向本地端口」的配置 | 同上 | 用户只能改宿主全局代理（影响其它进程），且 Node 的 fetch 默认不认 `HTTP_PROXY` 环境变量 |

补充口径（与既有 ADR 的衔接）：ADR 0184 被否决的是「**平台内置代理池 / 第三方代抓中转**」（信任、成本、合规风险）。本专项引入的是「**管理员自带出口（BYO Proxy / Own Gateway）**」——目标、凭据、责任均在部署方，形态与被否决方案不同；该差异需要在 ADR 0218 中显式说明（见 §16）。

---

## 2. 全仓出网通道盘点（逐条代码核实）

### 2.1 Node 主进程内出网

| # | 通道 | 代码落点 | 当前出网方式 | 反爬栈保护 | 代理改造 |
| --- | --- | --- | --- | --- | --- |
| 1 | `web_search`（含 Cookie 预热） | `server/src/tools/web_search.ts` | `antiBotFetch`（`tools/http.ts:394` 的 `fetch`） | 有（限速/冷却/软封锁/UA 池/Cookie 罐） | **必改**（P0） |
| 2 | `web_fetch` | `server/src/tools/web_fetch.ts` | `antiBotFetch` | 有 | **必改**（P0） |
| 3 | 财经 Node 源（东财 / 新浪 / 腾讯 / 基金 / 新闻） | `server/src/finance/sources/*` → `finance/fetcher.ts` `defaultFetcher = antiBotFetch` | `antiBotFetch` | 有 | **必改**（P0，随 antiBotFetch 一并生效） |
| 4 | LLM 提供商（对话流式） | `server/src/llm/openai.ts`（openai SDK，未注入 `fetch`） | SDK 内部全局 `fetch` | 无 | 可改（P1，通道可选） |
| 5 | LLM 探活 | `server/src/llm/probe.ts` | 全局 `fetch` | 无 | 可改（P1） |
| 6 | 嵌入（向量记忆） | `server/src/embeddings/provider.ts`（openai SDK） | 同上 | 无 | 可改（P1，随 llm 通道） |
| 7 | 媒体生成远端适配器 | `server/src/media/adapters/http.ts:46/60`、`openai-compat.ts` | 全局 `fetch`（comfyui / sdwebui 多为本地） | 无 | 可改（P1，随 llm 通道） |
| 8 | MCP HTTP 传输（Streamable HTTP） | `server/src/mcp/client.ts`（SDK 全局 fetch；transport 支持 `opts.fetch` / `requestInit`） | 全局 `fetch` | 无 | **必改**（P1） |

### 2.2 子进程出网（不经本进程 fetch）

| # | 通道 | 代码落点 | 当前出网方式 | 代理改造 |
| --- | --- | --- | --- | --- |
| 9 | 财经 Python 桥（akshare / baostock / curl_cffi） | `server/src/finance/bridge/runner.ts` spawn；`bridge/env.ts` 白名单净化 env（**不透传代理变量**） | 子进程内 `requests` 系库自定义网络栈 | **必改**（P1：注入 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY`） |
| 10 | MCP stdio 子进程 | `server/src/mcp/client.ts:171`（SDK 默认环境集 + 配置 env） | 子进程自身网络栈 | **必改**（P1：env 注入 + `NODE_USE_ENV_PROXY=1`） |

### 2.3 浏览器出网

| # | 通道 | 代码落点 | 当前出网方式 | 代理改造 |
| --- | --- | --- | --- | --- |
| 11 | 自启 Chromium（managed / local） | `server/src/browser/launcher.ts` `buildArgs()`（无 `--proxy-server`） | 宿主默认路由 | **必改**（P1：启动参数 + 实例复用的出口一致性守卫） |
| 12 | remote 接入（外部 CDP 端点） | `browser/cdp.ts` `resolveCdpEndpoint` → `launcher.ts` external 复用 | 由外部实例自身决定 | P0 明确提示不支持改出口；P2 评估 `Target.createBrowserContext({proxyServer})` |

### 2.4 恒直连（明确不接出口层）

| 通道 | 落点 | 理由 |
| --- | --- | --- |
| 浏览器可执行文件 / CDP 端点探测 | `browser/discover.ts:161`、`browser/cdp.ts:51` | 回环 / 显式端点，属控制面 |
| Python 环境探测 | `finance/bridge/probe.ts` | 本机进程探测，无网络 |
| 服务端自身 HTTP 服务、WS、SSE | `server/src/index.ts` | 入站通道（`TRUST_PROXY` 语义，与本专项无关） |
| 本地媒体服务（ComfyUI / SD WebUI） | `media/adapters/comfyui.ts`、`sdwebui.ts` | 常规部署为 `127.0.0.1`，默认旁路名单覆盖 |

> 结论：**Node 侧只需改造一个点**（`antiBotFetch` 的 `fetch` 调用，覆盖通道 1–3）；其余通道按「子进程 env / SDK fetch 注入 / 浏览器启动参数」三类接缝逐个接入。

---

## 3. 需求场景、目标与非目标

### 3.1 场景

| 场景 | 描述 | 关键诉求 |
| --- | --- | --- |
| A 反爬换出口 | 百度 / 东财等 IP 级风控时经代理出口检索 / 抓取 | 可配；失败可回退直连；结果标注出口 |
| B 企业固定出口 | 全部抓取经公司网关（留痕 / 合规） | 严格模式：代理失败宁可失败，**绝不泄漏真实 IP** |
| C 跨区访问 | 经特定区域出口查阅境外资料 / 文献 | 隧道或 SOCKS5 均可 |
| D 本机隧道软件 | 用户已有 Clash / V2Ray / 公司客户端，暴露本地 http/socks 端口 | 零开发即可指向本地端口（属 §5 的常规代理形态） |

### 3.2 目标与验收

| 目标 | 验收标准 |
| --- | --- |
| 可配出口 | 连接中心可建「出口代理」条目（HTTP(S) / SOCKS5 / SSH 隧道三形态）；设置面板可启用并指定通道；凭据加密落库、明文永不回传 |
| 通道覆盖 | search（web_search / web_fetch）、finance（Node 源 + Python 桥）、browser、mcp、llm 五通道可按通道独立选择「跟随全局 / 直连」 |
| 零回归 | 默认（未配置出口）时所有行为、文案、测试与现状完全一致 |
| 可回退 | search / finance / browser 默认「代理不可用 → 直连回退」并按结果标注；可切「严格失败」 |
| 可观测 | 连接测试 = 出口探测（返回出口 IP / 延迟）；工具结果标注实际出口；面板展示出口状态与最近错误 |
| 安全 | 代理凭据经 SecretVault 加密；日志 / 错误消息脱敏；回环与内网默认旁路；不引入第三方代抓 / 代理池 |

### 3.3 非目标（本轮明确不做）

- **平台内置代理池 / 自动购买 / 自动轮换第三方代理**（沿用 ADR 0184 否决口径）；
- TLS 指纹伪装库、无头浏览器抓取替代方案（0184/0035 已否决）；
- 按请求伪造 `X-Forwarded-For`、随机指纹对抗（不解决 IP 级风控）；
- 出站流量内容审计 / DLP（属网关职责，应用只负责「把流量送进网关」）。

---

## 4. 设计原则（红线）

1. **零回归**：默认 `direct` 时全链路与现状逐字节一致；出口层仅在显式配置后介入。
2. **出口显式、按通道启用**：默认仅 `search / finance / browser` 跟随全局出口；`llm / mcp / media` 默认直连——防止「为爬虫配了代理，把本地 / 国内模型端点打挂」。
3. **凭据不入 settings.json**：目标与凭据在**连接中心**（SecretVault 加密落库）；运行设置只存「引用 + 策略」（可明文热改）。
4. **回环与内网恒直连**：默认旁路名单覆盖 `localhost / 127.0.0.1 / ::1 / 内网段 / *.local`，本地服务（Ollama / ComfyUI / CDP）永不被代理。
5. **错误分类隔离**：出口层失败（连不上代理 / 407 / CONNECT 失败）与站点层失败（403 / 风控页 / 429）是两类事件——前者不触发目标 host 冷却，后者不触发出口降级。
6. **单一出口层**：所有出网请求经 `server/src/net/egress.ts` 解析出口；新增联网能力必须接入该层（禁止直连旁路）。
7. **失败可见、绝不静默**：回退、降级、连接缺失均产生明确文案与状态；严格模式下绝不回退。
8. **平台只做管道**：BYO 出口的合规责任在使用方；面板 / 文档明示「流量将经第三方可见」。

---

## 5. 出口模型

### 5.1 术语

- **出口（Egress）**：本进程 / 子进程 / 浏览器发起外网请求时使用的网络路径；
- **出口路由（Route）**：一次请求的出口决策结果（四形态之一）；
- **出口绑定（EgressBinding）**：连接中心 `kind='proxy'` 的条目（目标 + 凭据 + 形态）；
- **旁路（bypass）**：命中后强制直连的目标规则（host 后缀 / IP / CIDR）；
- **回退（fallback）**：出口层失败后的兜底动作（直连 / 直接失败）。

### 5.2 路由四形态与各端适配

| Route | 认证 | 远端 DNS | Node 侧（adaptive） | 浏览器 | 子进程 env |
| --- | --- | --- | --- | --- | --- |
| `direct` | — | 否（本地解析） | 全局 `fetch`（现状零变化） | 无 `--proxy-server` | 不注入 |
| `http-proxy`（scheme http/https） | Basic（可选） | ✅（CONNECT / 绝对 URI 由代理解析） | `undici.ProxyAgent`（原生；`token`/`auth`/URI userinfo 三种凭据载体） | 无鉴权直传 `--proxy-server`；**有鉴权走本地桥** | 直传 URL（含凭据）；无鉴权亦可直传 |
| `socks5` | user/pass（可选） | ✅（ATYP=域名，远端解析） | `undici.ProxyAgent`（原生支持 `socks5:` / `socks:`，凭据在 userinfo） | 无鉴权直传 `socks5://host:port`；**有鉴权走本地桥** | 走本地桥（env 生态对 socks 支持不一） |
| `ssh-tunnel`（隧道模式） | 复用 SSH 连接认证 | ✅（`forwardOut` 域直传） | 走本地桥（HTTP 代理入口） | 走本地桥 | 走本地桥 |

> 关键事实（已核验）：undici `ProxyAgent` 自 v4.8 起支持 HTTP/HTTPS，SOCKS5 由 `Socks5ProxyAgent` 承接（凭据可嵌 userinfo）；Chrome `--proxy-server` 支持 `http(s)://` 与 `socks5://`，**但不支持命令行下发代理凭据**（headless 无鉴权弹窗）；因此「带鉴权 / SOCKS 鉴权 / SSH 隧道」统一收敛到**本地出口桥**（§7）。

### 5.3 路由解析（单一决策函数）

```
resolveRoute(channel, url) -> Route
  1) 出口未配置（全局 direct）          → direct
  2) channel ∉ egressChannels           → direct
  3) url.host 命中 bypass（§6.4）        → direct
  4) 否则                                → EgressBinding 对应 Route
```

解析结果按 `(channel, 目标 host, 出口配置版本)` 缓存；配置变更（连接 CRUD / 设置热更）即失效（复用 `deps.db.invalidate` / `ssh.invalidate` 既有形态新增 `deps.egress.invalidate`）。

---

## 6. 配置面设计

### 6.1 三层结构与优先级

| 层 | 承载 | 内容 | 优先级 |
| --- | --- | --- | --- |
| ① 连接中心 | `connections` 表（kind=`proxy`） | 目标地址 / 形态 / 凭据（SecretVault 加密） | 高（被设置层引用） |
| ② 运行设置 | `data/settings.json`（热更新，admin-only） | 启用开关 / 引用哪个连接 / 通道清单 / 旁路 / 回退策略 / 探测地址 | 中 |
| ③ env | `.env` | 同 ②的启动默认值与「无 DB 后备出口」（`EGRESS_PROXY_URL`） | 低 |

生效规则：`settings.egressConnectionId` 指向的连接 > `EGRESS_PROXY_URL` 后备；连接被禁用 / 删除 → **视为未配置并显式告警**（回落 direct，绝不静默使用后备 URL）。

### 6.2 连接中心新增：`kind='proxy'`（出口代理）

```jsonc
// config
{
  "mode": "http" | "socks5" | "ssh",     // 出口形态
  "scheme": "http" | "https",            // 仅 mode=http；默认 http（https = 到代理本身走 TLS）
  "host": "127.0.0.1", "port": 7890,     // mode=http|socks5
  "sshConnectionId": "conn_xxxx",        // 仅 mode=ssh：引用既有 SSH 连接（隧道模式）
  "connectTimeoutMs": 8000,              // 可选：出口连接超时（默认取 HTTP_TIMEOUT_MS）
  "bypass": ["*.corp.example.com"]       // 可选：连接级直连旁路（与全局 egressNoProxy 求并集）
}
// secret（加密落库；仅 mode=http|socks5）
{ "username": "…", "password": "…" }
```

校验（`routes/connections.ts` zod + 服务端）：端口 1–65535；`mode=ssh`（隧道模式）在 P0 **创建期显式拒绝**并提示「SSH 隧道出口将在 P1 提供」（避免「建了不生效」；P1 落地后改为引用存在且 `enabled` 的 `ssh` 连接，复用其认证与主机指纹校验）；名称唯一沿用既有约束；`memberUse` 对系统级出口无意义（成员不可创建 / 不可见，见 §6.5）。

**测试按钮 = 出口探测**：经该 Route 请求 `egressProbeUrl`，回写连接 `status` + 返回 `{ 出口 IP, 延迟, 代理握手详情 }`（复用既有 test 路由审计与状态灯）。

### 6.3 运行设置新增字段（`settings.ts` `RuntimeSettingsSchema`）

| 字段 | 类型 / 默认 | 说明 |
| --- | --- | --- |
| `egressMode` | `'direct' \| 'proxy'`，默认 `direct` | 全局出口形态（`proxy` 时需有可用绑定，否则告警并回落 direct） |
| `egressConnectionId` | `string`，默认 `''` | 使用的连接 id；空 = 用 `EGRESS_PROXY_URL` 后备 |
| `egressChannels` | `Channel[]`，默认 `['search','finance','browser']` | 跟随全局出口的通道；未列出的通道恒直连 |
| `egressNoProxy` | `string[]`，默认见 §6.4 | 直连旁路规则（连接级旁路与其求并集） |
| `egressFallback` | `'direct' \| 'fail'`，默认 `direct` | 出口层失败后的回退（仅 search/finance/browser；llm/mcp 恒 `fail`） |
| `egressProbeUrl` | `string`，默认 `https://myip.ipip.net` | 出口探测地址（回显出口 IP / 文本均可解析；空 = 仅探测连通性；境外出口可改 `https://api.ipify.org?format=json`） |

### 6.4 旁路名单（默认值）

```
localhost, 127.0.0.1, ::1, *.local,
10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, fc00::/7
```

匹配语义：`*.suffix` 域后缀、IP 字面量、CIDR（Node 侧自实现，纯字符串规则）；浏览器侧翻译为 Chrome 的 `--proxy-bypass-list` 语法（Chrome 支持域名后缀 / IP 字面量，**不支持 CIDR** → CIDR 规则由「桥侧旁路」兜底：桥收到 CONNECT / 绝对 URI 时同样执行一次旁路判定）。

### 6.5 多用户与权限（对齐 M57）

- 出口绑定为**系统级连接**（`scope='system'`）：admin 管理，成员不可见 / 不可创建——在 `routes/connections.ts` 的成员创建 / 绑定拒绝清单（现为 `embedding / media / llm`）中加入 `proxy`，对齐全局语义；
- 设置字段 admin-only（沿用 `SETTINGS_FIELDS` + 设置路由守卫，成员读取子集为空）；
- 新增：**设置变更落审计**（字段 diff，无凭据内容）——补上当前 `/api/settings` 未审计的缺口。

### 6.6 热更新与失效

连接 `create/update/delete` 与设置 `PUT` 后：`deps.egress.invalidate()` → 重建 dispatcher 缓存 / 关闭并按新配置重建本地桥；注意「桥端口变化 → 已启动浏览器实例的出口已固定」，处置见 §8.2。

---

## 7. 出口层实现设计

### 7.1 模块划分（新增）

| 文件 | 职责 |
| --- | --- |
| `server/src/net/egress.ts` | 配置源注册（`configureEgress`）、`resolveRoute`、dispatcher 缓存、`egressFetch(channel, url, init)`、健康状态机、回退与标注、`resetEgressState()`（测试） |
| `server/src/net/egress-bridge.ts`（P1） | 本地出口桥：HTTP 代理入口（CONNECT + 绝对 URI）→ 上游 HTTP / SOCKS5 / SSH 三形态；含旁路执行与凭据注入 |
| `server/src/net/socks5.ts`（P1） | 桥内 SOCKS5 客户端（RFC 1928 CONNECT + RFC 1929 账号口令；域名 ATYP 保证远端 DNS） |

依赖：新增 **`undici`**（纯 JS、Node 官方维护，符合「拒绝原生绑定」的既有口径）。兼容性结论（P0 实测）：npm `ProxyAgent` 直接喂给 Node 内置 `fetch` 报 `UND_ERR_INVALID_ARG: invalid onRequestStart`（npm v8 与 Node 24 内置 undici 版本不同）——**已按设计预写的兜底分支实现：代理路径统一走同包 `undici.fetch`**（dispatcher 与实现同版本，未来 Node 升级不受影响）；直连路径保持全局 `fetch`（零回归）。

### 7.2 `antiBotFetch` 接入（P0 核心，一处改动覆盖通道 1–3）

```ts
// tools/http.ts（示意）
const res = await egressFetch(req.egressChannel ?? 'search', req.url, { ...init })
```

- `AntiBotRequest` 新增 `egressChannel?: 'search' | 'finance'`（缺省 `search` 兼容既有调用；web_search / web_fetch 显式传 `search`，`finance/fetcher.ts` 的 `defaultFetcher` 统一注入 `finance`）；
- 失败分类：出口层错误包装为 `AntiBotError('egress', …)`（新增 kind），**不计入 host 软封锁 / 冷却**；
- 回退：`egressFallback='direct'` 且出口层失败 → 以 direct 重试一次；结果标注 `（出口代理不可用，已直连）`；
- 标注：成功时 summary / detail 追加 `（出口：<连接名>）`（仅代理生效时）；
- `resetAntiBotState` 同步重置出口状态，保证既有测试零污染。

### 7.3 财经网关接入细化

- `finance/gateway.ts` `runChain` catch 分支：`AntiBotError('egress')` → **不调 `sourceFail(label)`**（否则「代理挂了 → 所有数据源被冷却 60s」，是错误归因），改记出口健康降级 + 失败原因按出口聚合；
- Python 源（`layer='py'`）的出口失败同样归因到出口层（`runPyFn` 抛出的错误在 `BridgeError` 之外新增出口可判定的包裹信息，见 §9.1）。

### 7.4 错误分类与文案

| 触发 | 分类 | 文案（模型可见） |
| --- | --- | --- |
| 连不上代理 / CONNECT 失败 / 代理超时 | `egress`（network 类） | `出口代理不可用（连接超时）：<名称>` + 回退标注 |
| 代理返回 407 / 403 | `egress`（auth 类） | `出口代理鉴权失败（HTTP 407）：请检查账号口令` |
| 隧道断开（SSH） | `egress`（network 类） | `SSH 隧道中断：<ssh 连接名>` |
| 严格模式下出口不可用 | `egress`（fatal） | `出口不可用且已启用严格模式（不回退直连）：<原因>` |
| 站点风控 / 429 | 既有分类不变 | 既有文案不变 |

---

## 8. 浏览器专项（通道 workspace）

### 8.1 自启实例（managed / local）

- `launcher.ts` `buildArgs()` 增补：`--proxy-server=<endpoint>`、`--proxy-bypass-list=<join(';')>`；
- endpoint 归一：
  - 无鉴权 http/https 代理 → `http(s)://host:port` 直传；
  - 无鉴权 socks5 → `socks5://host:port`（Chrome 原生，远端 DNS）；
  - 有鉴权 / SSH 隧道 → 本地桥 `http://127.0.0.1:<port>`（桥注入 `Proxy-Authorization` / SOCKS5 鉴权）；
- 本机回环目的地：Chrome 默认旁路 localhost（与我们的默认名单一致）；仅「严格模式」下加 `<-loopback>` 反转；
- 实例注册表 `InstanceInfo` 增 `egressKey`（出口配置指纹：mode+host+port+凭据摘要，不含明文）。

### 8.2 复用守卫（local 模式）

`findExistingLocal` 命中实例后核对 `egressKey`：

- 一致 → 照旧复用；
- 不一致 → **拒绝复用**并给出可操作文案：`本地浏览器实例的出口与当前配置不一致（实例：直连 / 当前：代理 A）：请关闭该实例后重试（面板提供「关闭实例」），或恢复原出口配置`；
- 理由：同一 `--user-data-dir` 无法并存两个实例（Chrome 单例锁），且「静默复用旧出口」等于配置失效——必须显式暴露。

### 8.3 remote 接入（外部 CDP 端点）

- P0：明确「不支持改出口」，启动前置校验：若 `egressChannels` 含 `browser` 且全局出口非 direct 且以 remote 接入 → 返回可操作提示（改用 managed/local 或把外部实例自身配好代理）；
- P2：评估 `Target.createBrowserContext({ proxyServer, proxyBypassList })` 的 per-context 出口（**语义代价**：独立上下文 = 隔离 Cookie / 存储，登录态不共享，需单独设计）。

---

## 9. 子进程专项

### 9.1 财经 Python 桥

- `finance/bridge/env.ts` `sanitizedEnv(extra)` 增补：当 `finance` 通道启用出口时注入 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY / NO_PROXY`（无鉴权 http 代理直传 URL；socks / 带鉴权 / SSH 隧道 → 指向本地桥）；
- `requests` / `urllib3` / `curl_cffi` 均读取上述 env（akshare / baostock 内部走 requests），无需改脚本；`NO_PROXY` 恒含回环与内网段；
- 桥内 `curl_cffi`（TLS 指纹接管）与代理**可共存**（`proxies` 透传在白名单里，env 由 requests 默认读取）；
- 出口不可用时：`runPyFn` 的错误需能被识别为出口级（出口层在调用前做一次「出口健康短路」：出口已判死 → 直接抛出口级错误，避免白起子进程）。

### 9.2 MCP

- **stdio**：`mcp/client.ts` 子进程 env 注入出口变量 + `NODE_USE_ENV_PROXY=1`（Node 系 MCP server 的 `fetch` 才认 env；Python 系靠 `HTTP_PROXY`）；**继续保持「不透传完整进程 env」的安全口径**（只加代理四元组）；
- **HTTP 传输**：向 transport 注入自定义 `fetch`（SDK 支持 `opts.fetch`）→ `egressFetch('mcp', url, init)`（比塞 `dispatcher` 进 `requestInit` 更类型安全，且统一错误分类）。

### 9.3 LLM / 嵌入 / 媒体远端（通道 `llm`，默认直连）

- `llm/openai.ts`、`embeddings/provider.ts`：openai SDK 构造注入自定义 `fetch`（`new OpenAI({ fetch })`）；
- `llm/probe.ts`、`media/adapters/http.ts`：改用 `egressFetch('llm', …)`；
- 语义：该通道**恒严格**（不回退直连）——若管理员显式把模型流量放进代理（合规 / 跨境），静默回退直连反而泄漏，必须显式失败。

---

## 10. 健康、回退与可观测

### 10.1 出口健康状态机

```
direct ──配置出口──▶ proxied ──连续 N=2 次出口级失败──▶ degraded（冷却 60s，回退直连并标注）
                                                              │
   ▲───任一成功（或探测通过 / 手动测试通过）──────────────────┘──▶ proxied
 严格模式（fallback=fail / llm·mcp 通道）：失败直接暴露错误，不进 degraded 回退路径
```

- 状态与最近错误挂 `EgressBinding`（连接卡片状态灯已有载体：`setStatus`）；
- 探测（连接测试 / 面板按钮）：经 Route 请求 `egressProbeUrl` → 记录出口 IP、握手耗时、总延迟；
- 周期探测、出口 IP 变更告警 → P2。

### 10.2 回退矩阵

| 通道 | 默认跟随全局 | 回退策略 | 理由 |
| --- | --- | --- | --- |
| search | ✅ | direct（可切 fail） | 可用性优先：反爬场景代理抖动不应让检索整体不可用 |
| finance | ✅ | direct（可切 fail） | 同上（行情可用性敏感） |
| browser | ✅ | direct（可切 fail） | 用户可感知；回退在启动时判定并提示 |
| mcp | ❌ | fail | 显式配置才启用；静默改道会改变外部交互语义 |
| llm | ❌ | fail | 合规敏感：配了代理就不允许泄漏直连 |

### 10.3 观测面

- **工具结果**：`（出口：代理 A）` / `（出口代理不可用，已直连）`（随 summary / detail 首行）；
- **连接卡片**：出口探测状态、最近错误（既有 `status/last_error` 载体）；
- **设置面板**：新增「联网与出网」区块 = 模式 / 连接选择 / 通道多选 / 旁路 / 回退 / 探测地址 + 「测试出口」按钮 + 当前状态摘要；
- **审计**：连接 CRUD（已有）+ 设置变更（新增，diff 脱敏）。

---

## 11. 安全与合规边界

1. **BYO 口径**：平台只提供管道；出口由部署方提供并自负合规责任（面板与文档明示「流量将经第三方 / 网关可见」）。
2. **凭据**：仅存 SecretVault 加密串；列表 / 详情只回 `secretSet`；日志、错误消息、`InstanceInfo.egressKey`、面板一律不含明文（`ProxyAgent` 的 `token` 由服务端构造后即弃）。
3. **回环信任**：本地桥绑定 `127.0.0.1` + 随机端口；同一 OS 用户下的本机进程理论可复用该端口（与既有本地 API / CDP 面同一信任模型，文档记录）；多用户同机部署建议独立 OS 用户 / 容器隔离（P2 评估桥令牌）。
4. **SSRF 面**：出口地址本身允许内网 / 回环（这正是「本机隧道软件」场景），不做网段限制；`mode=ssh` 只能引用本系统已登记、`enabled` 的 SSH 连接（防凭据外溢 / 任意跳板）。
5. **DNS 泄漏**：http / socks5 / ssh 三形态均为远端解析；仅 direct 为本地解析（配置面板注明「direct 意味着出口与 DNS 均为本机」）。
6. **不做**：内置代理池、自动轮换 / 购买、第三方代抓中转（ADR 0184 口径延续）、TLS 指纹伪装。

---

## 12. 测试与验收计划

### 12.1 单测（新增文件）

| 用例组 | 覆盖点 |
| --- | --- |
| `server/tests/egress.test.ts` | 路由解析（默认零回归 / 通道过滤 / 旁路命中 / 优先级 / 连接缺失告警）；错误分类；回退路径（假代理 → 直连，断言请求序）；凭据脱敏；`resetEgressState` |
| `server/tests/egress-bridge.test.ts`（P1） | CONNECT / 绝对 URI 转发；`Proxy-Authorization` 注入；SOCKS5 握手（含鉴权 / 域名 ATYP）；SSH `forwardOut` 出口（fake client）；旁路直连；生命周期与端口回收 |
| `server/tests/anti-bot.test.ts`（扩展） | 出口层错误不触发 host 冷却；回退后 host 冷却语义不变；summary 出口标注 |
| `server/tests/m34-sources.test.ts` / 网关用例（扩展） | 出口失败不 `sourceFail` 数据源；严格模式文案 |
| `server/tests/browser-*.test.ts`（扩展） | `--proxy-server` / `--proxy-bypass-list` 生成；`egressKey` 复用守卫；remote 提示 |
| `server/tests/m27-mcp.test.ts`（扩展） | stdio env 注入（含 `NODE_USE_ENV_PROXY=1`，且不泄漏其它进程变量）；http 自定义 fetch 注入 |
| `server/tests/finance-bridge*.test.ts`（扩展） | `sanitizedEnv` 代理注入与旁路 |

### 12.2 集成 / E2E

- 集成（已落地）：本地假 HTTP 代理 / 假 SOCKS5 服务器 + 假站点 → `antiBotFetch` / web_fetch 全链路（经代理成功 / 407 → 回退直连并标注 / 严格模式失败文案；出口失败不冷却 host 与数据源）；
- 客户端组件测试（已落地）：`client/tests/m82-egress.test.tsx` 4 例（区块字段渲染 + 出口状态与最近探测 / 保存载荷 egress* 字段 / 测试出口调用与状态刷新 / 连接管理新建出口代理载荷）；
- Playwright E2E（P1）：连接中心创建「出口代理」（凭据不回传断言）→ 设置「联网与出网」启用 search 通道 → 探测按钮 → 状态展示（需真实 dev 服务与假代理 fixture；列入 P1 与浏览器出口一并实施）；
- 门禁：`server` 全量测试 + `client` 全量测试 + `typecheck` + `lint` + `build`；相关 E2E spec 全绿；评测基线不受影响（不改 agents 资产）。

---

## 13. 分批实施计划

### P0 —— Node 抓取主链路 + 配置面（本专项可用性基线）

> 实施状态：**已完成**（2026-09-25；8 项改动全部落地，新增 `tests/egress.test.ts` 29 例；门禁见顶部状态行；差异说明：① 代理路径改用同包 `undici.fetch`——内置 fetch 与 npm `ProxyAgent` 实测不兼容；② `mode=ssh` 创建期显式拒绝（P1 开放）；③ SOCKS5 凭据走 `username/password` 选项（HTTP 代理才用 `token`，实测差异）；④ 设置变更审计作为配套项一并落地）。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | 出口层核心（路由解析 / dispatcher 缓存 / `egressFetch` / 健康 / 回退 / 标注） | 新增 `server/src/net/egress.ts` |
| 2 | 依赖引入与兼容性冒烟 | `server/package.json`（`undici`）、`server/tests/egress.test.ts` |
| 3 | `antiBotFetch` 接入 + `AntiBotError('egress')` + `egressChannel` | `server/src/tools/http.ts`、`tools/registry.ts`（`ToolRuntime`）、`tools/web_search.ts`、`tools/web_fetch.ts` |
| 4 | 财经网关归因修正（出口失败不冷却源） | `server/src/finance/gateway.ts`、`finance/fetcher.ts` |
| 5 | 连接中心 `kind='proxy'`（CRUD 复用 + 校验 + 探测式测试） | `shared/src/types.ts`、`server/src/store/connections.ts`（kind 透传无改）、`server/src/routes/connections.ts`、`server/src/routes/index.ts`（`deps.egress` 装配） |
| 6 | 运行设置字段 + 热更新 + 失效钩子 + 审计 | `server/src/settings.ts`、`server/src/config.ts`、`server/src/index.ts`（装配）、`server/src/routes/settings.ts` |
| 7 | 面板：设置「联网与出网」区块 + 连接表单代理形态 + `KIND_META` 补齐 | `client/src/components/settings/SettingsView.tsx`、`client/src/components/console/ConnectionsConsole.tsx`、`client/src/components/settings/PersonalConnectionsCard.tsx`（`KIND_LABEL`） |
| 8 | env / 文档 / ADR 镜像面 | `.env.example`、`.env`、`docs/operations.md §4.5`、`design.md §123`、`docs/adr/0218-*.md` + `docs/adr/README.md`、本文件状态行回写 |

### P1 —— 子进程 + 浏览器 + 隧道模式

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | 本地出口桥（CONNECT / 绝对 URI / 旁路 / 鉴权注入）+ SOCKS5 客户端 + SSH `forwardOut` 出口 | 新增 `server/src/net/egress-bridge.ts`、`server/src/net/socks5.ts` |
| 2 | Python 桥 env 注入 | `server/src/finance/bridge/env.ts`、`bridge/runner.ts` |
| 3 | MCP stdio env + http 自定义 fetch | `server/src/mcp/client.ts` |
| 4 | 浏览器 `--proxy-server` / bypass / `egressKey` 守卫 / remote 提示 | `server/src/browser/launcher.ts`、`browser/runtime.ts`、`browser/session.ts`（校验）、`client`（实例卡片提示） |
| 5 | LLM / 嵌入 / 媒体远端注入（通道 `llm`，默认直连） | `server/src/llm/openai.ts`、`llm/probe.ts`、`embeddings/provider.ts`、`media/adapters/http.ts` |
| 6 | 健康降级 / 严格模式 / 面板状态细化 + 设置审计 | `server/src/net/egress.ts`、`routes/settings.ts`、面板 |

### P2 —— 增强（可选，按需触发）

1. remote 实例的 per-context 出口（`Target.createBrowserContext`，登录态语义单独设计）；
2. 按会话 / 会话组覆盖出口（研究类会话独享出口）；
3. 多出口（出口列表 + 按失败切换，**仍为 BYO 静态清单**，非池化轮换）；
4. 周期探测与出口 IP 变更告警、出口速率 / 流量统计；
5. 桥令牌（防本机进程滥用）与 CONNECT 目标端口白名单。

---

## 14. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 平台内置代理池 / 自动轮换 | 合规、信任、成本（ADR 0184 口径延续）；本专项只做 BYO 管道 |
| 仅用 `NODE_USE_ENV_PROXY=1` + 进程 env | 进程级、需重启、无按通道路由、凭据只能明文入 env 文件；作为「子进程注入」环节保留，不作为主方案 |
| 引入 `https-proxy-agent` / `node-fetch` 栈替换现有 fetch | 与 undici 栈并存两套网络层，重构面大、收益为零；undici 已原生覆盖 http/https/socks5 |
| 无本地桥（浏览器直接吃鉴权代理 / SSH 隧道） | Chrome 命令行不支持代理凭据（headless 无弹窗）；SSH 隧道无原生消费方；桥是三形态统一收敛点 |
| 出口失败后**默认严格失败** | 反爬场景代理抖动 = 检索整体不可用；改为「search/finance/browser 默认回退 + llm/mcp 恒严格」 |
| 把所有通道默认纳入出口 | 会把本地 Ollama / ComfyUI / 国内模型端点打挂（零回归红线） |
| 用 CDP `Fetch.enable(handleAuthRequests)` 处理代理鉴权 | 需拦截全部目标请求（patterns 语义受限），与既有页面管线 / 截图链路耦合风险高；桥方案隔离更干净 |

---

## 15. 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `undici`（npm）dispatcher 与 Node 内置版本不兼容 | 代理请求全失败 | 冒烟用例作为门禁；不通过则内部切 `undici.fetch`（调用方无感） |
| 本地桥端口被同机进程滥用 | 出口被借用 | 回环绑定 + 随机端口 + 文档边界；P2 令牌 |
| Chrome 复用实例出口漂移 | 配置不生效 | `egressKey` 守卫 + 拒绝复用 + 明确处置文案 |
| 回退直连泄漏真实 IP（合规） | 违反合规预期 | 严格模式（`fail`）+ 面板显式提示 + 文档口径 |
| 代理抖动引发「回退风暴」 | 双份请求 / 目标站点压力 | 出口健康冷却（60s）+ 回退仅一次 + degraded 标注 |
| 桥实现缺陷（CONNECT / SOCKS5 / SSH） | 隧道不可用 | 独立单测（含假客户端）+ 集成用例 + 局部降级（socks 失败提示改用 http 形态） |
| Python 库忽略 env（显式传 `proxies=None`） | 少数库绕过代理 | 文档列出已知例外；P2 评估桥 + 本地端口强制接管 |

---

## 16. 拟新增 ADR 0218 要点（已成文，2026-09-25）

> 落地时已按本节要点成文：[docs/adr/0218-egress-proxy-tunnel.md](adr/0218-egress-proxy-tunnel.md)（状态 Accepted）+ `docs/adr/README.md` 索引行。以下为原始要点存档。

- **标题**：联网出口层——BYO 代理与 SSH 隧道模式（统一出口层 + 按通道路由 + 本地桥）
- **决策**：
  1. 新增 `server/src/net/egress.ts` 统一出口层，四形态 Route（direct / http-proxy / socks5 / ssh-tunnel），按通道（search / finance / browser / mcp / llm）路由，默认 `direct`；
  2. 目标与凭据落连接中心新 `kind='proxy'`（SecretVault 加密），策略落运行设置（热更新），env 作后备；
  3. Node 侧采用 `undici` ProxyAgent（http/https/socks5 原生）；浏览器与子进程经**本地出口桥**收敛（鉴权注入 / SOCKS5 / SSH `forwardOut`）；
  4. 回退矩阵：search / finance / browser 默认 `direct` 回退并可切 `fail`；llm / mcp 恒严格；
  5. 出口层错误独立分类（`AntiBotError('egress')`），不污染站点冷却与数据源健康；
- **理由**：BYO 与「内置代理池 / 第三方中转」形态不同（ADR 0184 否决口径不受影响）；单点改造（antiBotFetch）即覆盖三大抓取通道；桥是 Chrome 鉴权 / SOCKS 鉴权 / SSH 隧道三需求的唯一统一解；
- **被否决**：见 §14；
- **影响面**：见 §13 文件清单；镜像面 `design.md §123` + `docs/operations.md §4.5` + `.env.example` + 本设计文档状态行。

---

## 17. 镜像面清单（P0 已逐项落地；P1 复用本表）

- [x] `design.md` 新增 §123（联网出口批）
- [x] `docs/adr/0218-egress-proxy-tunnel.md` + `docs/adr/README.md` 索引行
- [x] `docs/operations.md §4.5`（联网工具运维：出口配置 / 探测 / 排障）+ `§8 故障排查`（出口 5 类症状）
- [x] `.env.example`（`EGRESS_*` 段）+ `.env`（默认空值）
- [x] 本文件：状态行「设计中 → 已实施（P0）」+ 门禁结果与落位编号
- [x] README：工具描述未涉及出口行为，无需变更
- [x] agents 资产：本批不改 agents 资产（工具描述 / `_protocol.md` 未涉及出口），无需 CHANGELOG 条目
- [x] 测试与依赖：`server/tests/egress.test.ts`（29 例：含 HTTP 代理 / SOCKS5 无鉴权与账号口令 / 回退降级 / 探测 / 路由层 / 设置）+ `client/tests/m82-egress.test.tsx`（4 例：区块渲染与状态 / 保存载荷 / 测试出口 / 连接表单载荷）+ `server/package.json`（`undici`，exact 版本）
