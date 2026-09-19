# ADR 0184：web_search 免 Key 多引擎降级链（百度风控的结构性解法）

- 状态：Accepted
- 引入：联网检索反爬专项（2026-09-19）
- 相关：[ADR 0035](0035-web-search-baidu-anti-bot.md)（web_search 双模式 + antiBotFetch 反爬栈）、[docs/operations.md §4.5](../operations.md)、[server/src/tools/search-engines.ts](../../server/src/tools/search-engines.ts)、[server/src/tools/web_search.ts](../../server/src/tools/web_search.ts)、[server/tests/web-search.test.ts](../../server/tests/web-search.test.ts)

## 背景

免 Key 模式（抓取 SERP）下百度风控持续收紧，实测两类拦截：

1. **页面级风控**：结果页 302 到 `wappass.baidu.com` 安全验证页（单次出现即 host 冷却 60s）；
2. **IP 级风控**：同一出口 IP 在一段时间内对 `www.baidu.com/s` 与 `m.baidu.com/s` 全部 302 到验证码页——此时 Cookie 预热 / UA / 限速等单点对抗全部失效，`web_search` 完全无结果（界面连续报「已触发网站风控，冷却 60s」，模型无从继续）。

实测同一网络环境下 Bing / 搜狗 / 360 的 SERP 抓取与解析均正常；百度风控具有**时效性与网络环境相关性**（同 IP 数十分钟后可能恢复），单引擎架构无法覆盖这种不确定性。

## 决策

**把 web_search 免 Key 模式从「百度单引擎」升级为「多引擎降级链」**：

- 引擎链默认顺序 `baidu → bing → sogou → so360`（`WEB_SEARCH_ENGINES` 可配置）；按序尝试，成功即返回；
- 引擎适配器集中于 `tools/search-engines.ts`（URL 构造 / SERP 解析 / 可选 Cookie 预热），统一输出 `SearchItem`；真实 URL 还原：Bing `ck/a` 跳转链 base64 解码、360 `data-mdurl` 优先、搜狗相对 `/link?` 补全；
- 被风控/冷却的引擎自动跳过（复用 antiBotFetch 的 host 级冷却，无新增反爬状态）；反爬状态键由 hostname 收紧为 **host（含端口）**——默认端口下与既有行为等价，显式端口实例精确隔离；
- 结果标注实际引擎与降级：`联网检索「q」：N 条结果（网页抓取·Bing（降级））`，detail 首行附跳过记录；全链失败汇总各引擎原因 + `BAIDU_SEARCH_API_KEY` 建议；
- 摘要净化补强：命名/数字实体解码（`&ensp;` / `&#0183;` 等 SERP 高频噪声）、全角标点前空格清除（`em` 高亮标签边界）。

## 理由

- **多入口是 IP 级风控的结构性解法**：单点客户端伪装（TLS 指纹 / UA）在站点按 IP 拒绝时收益趋零；横向多引擎让「任意单点失败」不再等于「功能不可用」，且各引擎风控互相独立、冷却天然隔离；
- **与既有架构零冲突**：限速 / 冷却 / 软封锁按 host 隔离，切换引擎即切换 host，传输层（antiBotFetch）与解析器完全解耦复用；
- **可观测**：结果标注实际引擎 + 降级记录，用户/模型可判断链路质量，决定是否稍后重试首选引擎或改用官方 API。

## 被否决的方案

- **引入 TLS 指纹伪装库**（impit / got-scraping 等原生绑定）：实测百度为 IP 级封锁时指纹伪装无效；原生二进制增加部署面与架构约束，与轻量定位冲突；
- **代理池 / 第三方搜索中转**：信任、成本与合规风险；用户数据经第三方（ADR 0035 已否决同类）；
- **无头浏览器抓取**：依赖与资源占用大（ADR 0035 已否决）；
- **仅加强单引擎对抗**（更长 Cookie 链 / 更高预热频率）：无法覆盖 IP 级封锁，且高频访问加剧封禁。

## 影响

- 新增 `server/src/tools/search-engines.ts`（引擎注册表 + 4 个 SERP 解析器）；`web_search.ts` 改为引擎链执行（`searchViaEngines`），`parseBaiduSerp` 迁出并 re-export 兼容；
- `config.ts` / `ToolRuntime.webSearch` 增 `engines`（`WEB_SEARCH_ENGINES`，空 = 内置链）与 `engineUrls`（测试注入本地地址）；`.env.example` / `docs/operations.md §4.5` / README 工具描述同步；
- `tools/http.ts`：反爬状态键 hostname → host（含端口）；
- 测试：`web-search.test.ts` 增引擎解析器用例（fixture + 实体/标点净化）与降级链用例（风控降级接管 / 冷却跳过不重撞 / 全链失败汇总）；实证回归覆盖三引擎真实 SERP 数据。
