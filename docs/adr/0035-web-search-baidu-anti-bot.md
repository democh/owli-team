# ADR 0035：联网检索与反爬（web_search 百度检索 + web_fetch 反爬增强）

- 状态：Accepted
- 引入：M20
- 相关：[design.md §21](../design.md)、ADR 14（工作区沙箱）、[docs/operations.md §4.5](../operations.md)

## 背景

v1 只提供 `web_fetch`（白名单域名抓取），存在三个缺口：

1. **没有主动检索**：成员只能抓已知 URL，无法「先搜再抓」；调研场景（scout）对外部信息的获取能力受限；
2. **反爬能力缺失**：`web_fetch` 使用固定 UA `multi-agent/1.0 (+local-agent-workspace)`（非浏览器特征）、无重试/限速、无风控识别；中文站点常见的 GBK 编码页面直接按 UTF-8 解码会乱码；命中网站风控（验证页 / 403 / 429）时只会得到「HTTP 403」之类的低信息量错误；
3. **百度检索有两条路**：HTML 结果页（免 Key，但存在反爬：wappass 安全验证页、UA 校验、频率封禁）与官方渠道千帆「百度搜索」API（`POST https://qianfan.baidubce.com/v2/ai_search/web_search`，Bearer 鉴权、结构化 `references`、每月免费额度、无风控问题）。

## 决策

**新增 `web_search` 工具（百度检索，双模式），并把两个联网工具的反爬能力统一收敛到共享模块 `tools/http.ts`（antiBotFetch）**：

- **web_search 双模式**：`BAIDU_SEARCH_API_KEY` 非空 → 官方 API 模式（推荐）；否则 HTML 模式（默认，免 Key）：BAIDUID cookie 预热（TTL 30 分钟）→ 抓取结果页 → 解析（`data-tools` 转义 JSON / `mu` 属性 / h3 跳转链三级回退；摘要取 `c-abstract` 等；站点取真实 URL hostname 或灰字）。`WEB_SEARCH_ENABLED` 为总开关（缺省关闭，与其他联网能力一致的最小暴露原则）；
- **反爬共享模块 `tools/http.ts`**（web_search / web_fetch 共用，进程级按 host 状态）：
  - 浏览器请求头：Chrome 桌面 UA（`HTTP_USER_AGENT` 可覆盖）、`Accept-Language: zh-CN`、`Sec-Fetch-*`；调用方可加 referer / cookie / authorization；
  - 域名级限速：同 host 串行队列 + 最小间隔 `HTTP_MIN_INTERVAL_MS`（默认 1200ms）；
  - 风控识别与冷却：wappass/verify 重定向、`百度安全验证` 标题、Cloudflare 挑战（`Just a moment` / `cf-chl-`）、403 → 判定 blocked，**不重试**并对 host 冷却 60s（不加剧封禁）；
  - 退避重试：仅 429 / 5xx / 网络错误（尊重 `Retry-After`，默认最多重试 1 次）；外部取消（工具中断）不重试；
  - 字符集解码：BOM → `content-type charset` → `<meta charset>` → utf-8 兜底；GBK 家族（gb2312/gbk）归一 gb18030 解码；
  - 体积上限：`content-length` 声明超限直接拒绝（不读流）+ 流式累计兜底（沿用 M-5 语义）；
- **web_fetch 重构**：接入 antiBotFetch（浏览器头 / 限速 / 重试 / GBK / 风控提示），保留白名单域名、重定向最终域名校验、512KB / 8000 字符上限等既有安全边界（错误文案向后兼容）；
- **配置与授权**：`WEB_SEARCH_ENABLED` / `BAIDU_SEARCH_API_KEY` / `BAIDU_SEARCH_API_URL` / `HTTP_USER_AGENT` / `HTTP_MIN_INTERVAL_MS` / `HTTP_TIMEOUT_MS` 经 ToolRuntime 注入；持有 `web_fetch` 的 6 个角色（architect / backend / devops / frontend / qa / scout）同步授权 `web_search`；全局协议 `tool_policy` 增加「先搜后抓、被风控不反复重试」规则，research 场景协议与 scout 人设更新检索流程。

## 理由

- **API 优先、抓取兜底**：官方 API 无风控、结构化、有免费额度，是质量最高的路径；HTML 模式降低使用门槛（零配置可用），代价用反爬栈控制；
- **反爬集中而非分散**：限速/冷却状态按 host 全局共享，两个工具混合调用时频率仍然一致；解析器（SERP）与传输层（antiBotFetch）解耦，可分别单测；
- **风控拦截 = 不重试 + 冷却 + 明确回灌**：验证页重试只会加深封禁；提示中直接给出「稍后重试 / 配置 API Key」的可操作路径，模型能换思路而不是空转；
- **GBK 解码**：中文站点存量页面大量使用 GBK 家族编码，`TextDecoder`（Node full-icu）零依赖解决。

## 被否决的方案

- **无头浏览器（Playwright）抓取**：依赖与资源占用大，与「本地轻量 Harness」定位冲突；cookies/指纹对抗维护成本高；
- **只做 HTML 抓取、不接官方 API**：风控不可控、页面结构变更时解析器持续维护；
- **引入第三方搜索代理 / 中转服务**：信任、可用性与合规风险；用户数据经第三方；
- **引入 cheerio 等 DOM 解析依赖**：新增包体；正则 + 三级回退对本场景足够，且可用 fixture 精确回归；
- **在工具内静默无限重试风控页 / 轮换代理 IP**：加剧封禁，违背「被拒绝不重试同一动作」的既有协议精神。

## 影响

- 新增 `server/src/tools/http.ts`（反爬客户端）、`server/src/tools/text.ts`（htmlToText 迁出，web_fetch re-export 兼容）、`server/src/tools/web_search.ts`；`web_fetch.ts` 重构；
- ToolRuntime 增 4 个字段（webSearch / httpUserAgent / httpMinIntervalMs / httpTimeoutMs）；`config.ts` / `engine.ts buildToolRuntime` / `.env.example` / `docs/operations.md §4.5` 同步；
- 角色授权：architect / backend / devops / frontend / qa / scout 的 `AGENT.md tools` 增 `web_search`；`agents/_protocol.md <tool_policy>`、`agents/research/_protocol.md`、`skills/deep-research/SKILL.md` 更新；
- 测试：新增 `server/tests/anti-bot.test.ts`（请求头 / 风控识别 / 解码 / 重试 / 冷却 / 限速 / cookie 预热）与 `server/tests/web-search.test.ts`（SERP 解析 / 双模式端到端 / 错误码），`m5.test.ts` 增 GBK 与风控用例；
- 运维：6 个新环境变量（默认值安全：`WEB_SEARCH_ENABLED=false`、限速 1200ms、超时 15s）。
