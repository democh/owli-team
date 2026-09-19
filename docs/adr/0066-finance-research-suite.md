# ADR 0066：金融投研专项（三源混合网关 + 全量延迟工具集 + 行情 / 博弈双端）

- 状态：Accepted
- 引入：M34
- 相关：[design.md §53](../design.md)、[docs/finance-invest-design.md](../finance-invest-design.md)（专项设计源）、ADR 3 / 33（发言并发度：场景 `parallel` 与 `parallelMax` 复用）、ADR 54（工具按需发现：全量 `deferred` 的延续）

## 背景

- 需求：投研工作流（行情 → 指标 → 选股回测 → 博弈推演）需要数据管道与计算能力，既要覆盖 A 股 / 基金主流数据（东财 / 腾讯 / 新浪 / baostock / akshare），又不能把外部数据源的不稳定性转嫁给协作主链路；
- 硬约束：
  1. 免费数据源处于反爬环境（限流 / 风控页 / 编码陷阱）——需要多源降级与礼貌采集，且「降级」必须可解释（原因链 + 冷却可视）；
  2. Python 生态（baostock / akshare / ta）是数据质量最优解，但部署环境不保证 Python——能力必须自适应（探测 + 三档可用性 + Node 兜底）；
  3. 工具数量大（12 个）——全量注册会污染所有会话的工具清单（token 与选择噪声），与 ADR 54 渐进披露冲突；
  4. 图表（250 根 K 线 × 指标）与博弈推演是重数据 / 重计算——不能让 LLM 窗口转述，也不能加重协作回合负担；
  5. 面向非投研用户零打扰：金融入口与工具必须纯 opt-in。

## 决策

1. **三源混合网关**（`server/src/finance/gateway.ts`）：能力路由（quote / kline / indicator / fundamental / calendar / fund_profile / fund_nav / news / symbol·screen）+ 能力级降级链（Node 直连源与 Python 桥混合排序）；`source: 'auto' | 'node' | 'py'` 可强制层级；结果携带 `degraded` 原因链 + `cache: 'hit' | 'stale'`（源全失败回退过期数据）+ 数据时点，全链可溯；
2. **反爬共享模块**（`server/src/tools/http.ts`）：UA 池按 host 粘性 / tough-cookie 会话罐 / 域名级限速 + 指数退避 / 风控页识别与 60s 冷却 / GBK→gb18030 解码 / 流式体积上限；网关联动：同源连续失败 ≥2 次进入 5 分钟冷却、路由自动跳过，成功后清零，冷却状态经 `GET /finance/env` 透出；
3. **Python 桥**（`server/src/finance/bridge/`）：解释器 + 核心包探测，三档 `ready / partial / absent`；固定脚本 + stdin/stdout JSON；30s 超时 kill、并发信号量 1、env 净化（不透传密钥）；缺包不阻塞——Node 源兜底并注明降级原因；
4. **12 个 `fin_*` 全量 `deferred`**（ADR 54 延续）+ `FINANCE_ENABLED` 门控：数据类 8 + 量化类 4；默认关闭时工具不注册、路由统一 503；按角色分权到 invest 场景五角色（12 / 9 / 7 / 6 / 4）；
5. **K 线快照进交付件体系**：`charts/<symbol>-<period>-<yyyymmddHHMM>.json`（chart-snapshot schema），可版本 diff、可被消息块与报告引用；
6. **前端独立 Tab + 直连 API**：「行情」（自选 + K 线 / 概况 / 新闻，交易时段感知轮询）与「博弈」（matrix / sequence / evolve / simulate 四模型）为主区 Tab；博弈直连 `POST /api/finance/game` 纯计算不耗 LLM（seed 可复现）；```kline / ```game 围栏渲染块进消息流；
7. **invest 场景 = 五角色协作链**：四路独立分析（基本面 / 技术面 / 舆情 / 量化）+ 主管收口；`parallel: true` + `parallelMax: 4`；协议「投研纪律九条」（数据可溯 / 观点与事实分离 / 免责声明 / 模拟推演不越界）；
8. **存储**：迁移 v10 五表——缓存三表（`finance_kline_cache` / `finance_quote_cache` / `finance_news_cache`）+ `finance_watchlist`（symbol 唯一 upsert + 物理删除）+ `finance_meta`（探测结果 / 交易日历）+ 网关缓存（`finance/cache.ts`：symbol 主档 7d / screen 基表 10min / 日历 12h）。

## 理由

- **降级链是刚需**：免费源随时可能限流 / 改版——多源 + 冷却 + stale 回退让「数据变慢」表现为可解释的降级而非报错；
- **Python 是可选增强而非依赖**：Node 源保底覆盖核心能力（行情 / K 线 / 指标），Python 在场时提升数据质量（baostock 日线 / ta 指标）；三档探测让设置面板能引导用户补装；
- **deferred + 门控双层**：工具既不在默认清单，也不在关闭态注册——非投研会话零成本（token / 噪声 / 入口三重零可见）；
- **博弈纯计算直连**：四模型本质是确定性数值计算（PRNG + seed），绕开 LLM 既省钱又稳定可复现；LLM 只在「解读结果」时参与（渲染块 + game-theory-trading 技能）；
- **资产层复用既有协作范式**：invest 场景零编排代码改动——parallel 波次（ADR 3 / 33）+ handoff + 场景协议全部复用 M16 / M18 能力。

## 被否决的方案

- **单源直连（只挂东财）**：反爬风险集中（限流 / 风控升级直接不可用），无法满足「降级可解释」；
- **Python 作为硬依赖**：部署环境不保证 Python 与包完整——把 baostock / akshare 设为必装会让无 Python 环境整体不可用；
- **12 工具全量注册（非 deferred）**：所有会话工具清单 +12——token 成本与选择噪声不可接受；
- **图表 / 博弈数据经 LLM 转述**：250 根 K 线 × 指标与推演数值经 LLM 窗口既贵又失真；改为前端直连 API + 渲染块引用快照；
- **博弈推演由 LLM 生成**：确定性数值计算不可由 LLM 编造（不可复现 / 可能臆造数值）；改为服务端纯计算 + seed 透传；
- **默认开启（FINANCE_ENABLED=true）**：会改变全部既有会话的工具面与主区 Tab，违背「专项 opt-in」原则。

## 适用与失效条件

- 适用：`FINANCE_ENABLED=true` 的投研会话与主区「行情 / 博弈」Tab；数据源名单以 gateway 路由表为准（实施期实测校准可替换个别源）；
- 失效条件：
  - **上游源大面积改版 / 收费**：降级链需重排（如东财 clist 关闭则 screen 走 akshare）；
  - **Python 生态策略变化**：桥的三档探测与包清单需随 baostock / akshare 废弃调整；
  - **实盘对接**：本专项明确不含交易通道；若未来接入实盘，合规评审与审批门为前置条件（协议「模拟推演不越界」需修订）；
  - **工具披露模型变更**（ADR 54 被取代）：deferred + 门控的双层策略需重新评估。
