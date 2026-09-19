# 金融投研能力专项设计（M34）

> 状态：**已实施**（M34 批 A–D 全部落地并验收；实施期与本稿的差异以 design.md §53 与 ADR 0066 / 0097 / 0098 为准）
> 范围：金融数据网关（baostock / akshare / 自写爬虫三源混合）・专业工具集（`fin_*`）・
> K 线渲染（klinecharts v10）・行情面板（ADR 0098 已撤除；承载见 §6.1 / §6.4）・**多空博弈模拟（博弈论建模 + ABM 蒙特卡洛 + 交互可视化）**・
> 投研场景 5 角色・策略分析与回测・合规红线
> 关联：design.md §53、ADR 0066、agents/CHANGELOG.md v22

---

## 1. 背景与目标

### 1.1 需求

为项目增强金融投研能力：

- **数据源**：baostock、akshare、自写爬虫三源混合（用户已确认）；
- **品种**：沪深 A 股、场内 ETF、场外基金（净值）、指数（用户已确认「A股+ETF/基金为主」）；
- **内容**：行情、K 线、财务、基金档案、新闻公告；
- **渲染**：K 线使用 **klinecharts**（v10）实现；
- **能力**：专业级投资分析建议、多角色讨论、输出报告、策略分析、可实施（回测验证 + 实施计划）；
- **形态**：新增「投资研究」场景 5 角色（用户已确认）。

### 1.2 能力目标（验收导向）

| 能力 | 验收标准 |
| --- | --- |
| 数据可信 | 所有行情 / 财务 / 新闻数字来自工具调用（可溯源、带时间戳与口径），禁止模型臆造 |
| 专业分析 | 基本面 / 技术面 / 舆情 / 策略四类分析各有方法论技能支撑，输出结构化交付件 |
| 能讨论 | 5 角色接力 + 并行波次；数据冲突有裁决规则（来源可靠性 + 时效） |
| 能报告 | 投研主管收口 `docs/投研报告-<主题>.md`（含免责声明与数据附录） |
| 策略与实施 | 策略规则化 → 回测（收益 / 回撤 / 夏普 / 胜率）→ 参数敏感性 → 实施计划与监控清单 |
| 博弈推演 | 做多/做空对峙可建模：静态矩阵（纳什均衡）/ 序贯（逆向归纳）/ 演化（复制动态）/ ABM 蒙特卡洛；输出最终结果（均衡解 / 路径分位 / 事件概率）并落盘可复现；参数可交互重跑 |
| K 线专业呈现 | 消息内 ```kline 代码块 + 「行情」Tab 大图；多周期、复权、主副图指标、标注 |

### 1.3 定位与边界（与既有资产切割）

| 既有 | 定位 | 与本专项的关系 |
| --- | --- | --- |
| wealth 场景（钱程） | 个人理财框架：预算 / 储蓄 / 比例纪律，**明确不给标的、不预测行情** | 钱包账本归 wealth；标的研究与策略归 invest。设定交叉引用话术 |
| bi 场景（沈析） | 企业内部经营取数（NL2SQL） | 库表数据归 bi；金融市场数据归 invest |
| finance 场景（周正等） | 企业财务法务 | 税务 / 合同归 finance；投资研报归 invest |
| research 场景 | 通用深度研究 | 通用研究方法论共用，金融数据管线归 invest |

**红线**：不接交易通道（无下单能力）；不承诺收益；一切输出标注「不构成投资建议」。

---

## 2. 总体架构

```
┌─────────────────────────── 前端（client） ───────────────────────────┐
│ 消息内 ```kline 块（KlineBlock）   主区「行情」Tab（FinanceView）      │
│ 消息内 ```game 块（GameBlock）     画布节点（GameNode / KlineNode）    │
│  └─ lib/kline.ts 封装 klinecharts v10（懒加载独立 chunk）             │
│  └─ components/game/ 渲染内核（矩阵/树/演化/模拟，懒加载独立 chunk）   │
│  └─ 数据：内联 data 或 artifacts content API 读快照 + /api/finance/*   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ REST（/api/finance/*）
┌──────────────────────────────┴──────────────────────────────────────┐
│                        工具层（server/src/tools/finance.ts）          │
│ fin_env fin_search fin_quote fin_kline fin_indicator fin_fund        │
│ fin_fundamental fin_news fin_screen fin_backtest fin_watch fin_game  │
│ （全部 tier=deferred，经 tool_search 渐进披露；白名单按角色分配）      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ 统一 Facade（能力路由 / 降级链 / 快照）
┌──────────────────────────────┴──────────────────────────────────────┐
│                    数据网关（server/src/finance/）                    │
│ symbol 归一化 · 缓存（SQLite + TTL）· 快照落盘 · 限速与交易时段感知    │
│ game 引擎（博弈求解 + ABM 蒙特卡洛，确定性种子可复现，纯计算零网络）   │
│       ┌──────────────┬───────────────────┬─────────────────┐        │
│       │ 源 A 自写爬虫 │ 源 B Python 桥     │ 源 C（预留）     │        │
│       │ 东财/腾讯/新浪 │ baostock/akshare  │ browser 运行时   │        │
│       │ 天天基金（Node）│ pandas/ta/tablib │ 强反爬站点       │        │
│       └──────────────┴───────────────────┴─────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.1 关键决策摘要

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **三源混合**：Node 自写爬虫为主干（零门槛），Python 桥增强（专业口径），browser 源预留 | 用户确认；无 Python 环境下核心能力仍可用 |
| D2 | Python 桥 = **固定脚本 + JSON 协议**，探测 / 依赖检测 / 错误码映射 / 安装引导走审批门 | 安全（不执行任意代码）、可控（超时 / 并发）、可降级 |
| D3 | K 线数据**不由模型输出**：工具落盘快照（`charts/*.json`），消息块只引用 `src` | 250 根 K 线 ≈ 10-20KB，模型重输出既贵又易错 |
| D4 | 渲染封装单点化：`lib/kline.ts` 隔离 klinecharts v10 API，版本锁定 | v10 API 较新（`setDataLoader` 等），单点可控 |
| D5 | 回测引擎 **Node 自研**（日线级、含费用与滑点），不引入 backtrader 等重依赖 | 与「无重依赖」工程原则一致；口径透明可测 |
| D6 | 工具全部 `tier='deferred'` + 角色白名单收敛 | 对齐 M28 渐进披露；12 个新工具不进常驻清单 |
| D7 | watchlist 为**全局单表**（跨会话），行情 Tab 直接读写 `/api/finance/*` | 自选关注是工具属性而非会话资产 |
| D8 | 行情刷新采用**交易时段感知轮询**（默认 10s，非交易时段停） | 免费接口限速现实；数据延迟在 UI 标注 |
| D9 | 博弈引擎 **Node 自研**（纳什求解 / 逆向归纳 / 复制动态 / ABM 蒙特卡洛），固定随机种子可复现 | 纯计算无 IO，无需 Python；相同种子+参数结果逐位一致是「输出最终结果」的验收前提 |
| D10 | 博弈能力**双形态**：消息内 ```game 块（静态结果）+ 主区「博弈」Tab（交互沙盘：调参重跑 / 轨迹对比 / 交给 Agent 解读） | 讨论与模拟互补：报告要静态可引用，探索要交互可迭代 |

---

## 3. 数据源层（三源混合）

### 3.1 来源 A：Node 自写爬虫（主干，复用 `tools/http.ts` 反爬模块）

复用既有 `antiBotFetch`（浏览器 UA / 域名限速 / 风控冷却 / 退避重试 / GBK 解码），新增 `server/src/finance/sources/` 适配器：

| 适配器 | 用途 | 接口形态（实施时逐个实测验证） |
| --- | --- | --- |
| `eastmoney.ts` | 实时快照（批量）、日/周/月/分钟 K 线、全市场列表（筛选底表） | `push2.eastmoney.com/api/qt/ulist.np/get`（secid 批量）；`push2his.eastmoney.com/api/qt/stock/kline/get`（klt 101/102/103/5/15/30/60、fqt 前/后/不复权）；`push2.eastmoney.com/api/qt/clist/get`（全市场 5000+ 标的快照，筛选用） |
| `tencent.ts` | 快照兜底 | `qt.gtimg.cn/q=sh600519,...`（GBK，批量） |
| `sina.ts` | 快照二备 / 新闻兜底 | `hq.sinajs.cn/list=...`（需 Referer）；财经滚动新闻页 |
| `fund.ts` | 场外基金净值 / 详情兜底 | 天天基金 `fund.eastmoney.com/pingzhongdata/<code>.js`、`api.fund.eastmoney.com/f10/lsjz`（需 Referer） |
| `news.ts` | 个股新闻 / 公告 / 市场要闻 | 东财资讯接口 + 备用新浪财经（标题 / 时间 / 来源 / URL / 摘要，去重） |

**约束**：所有请求走 `antiBotFetch`；同 host 最小间隔沿用 `HTTP_MIN_INTERVAL_MS`（默认 1200ms，金融源单独可调 `FINANCE_MIN_INTERVAL_MS`）；解析失败即降级下一源，不重试死循环。

### 3.2 来源 B：Python 桥（增强）

**能力矩阵**（pip 包 → 网关能力）：

| 包 | 提供能力 | 必要性 |
| --- | --- | --- |
| `baostock` | 历史 K 线（日/周/月/5-60 分钟，前/后复权）、财务季报、指数、**交易日历** | 高（复权口径与财务数据最可靠） |
| `akshare` | 基金/ETF 档案（规模/持仓/费率/跟踪指数/分红）、新闻、全市场快照 | 高（基金维度主力） |
| `pandas` | 数据清洗 / 重采样 / 统计（指标与回测的底座） | 高（ta 依赖） |
| `ta` | 技术指标库（MA/EMA/MACD/RSI/KDJ/BOLL/ATR 等 40+） | 中（Node 侧有自研兜底） |
| `tablib` | 结果表导出（CSV/JSON/XLSX；XLSX 需 `openpyxl`） | 中（筛选/回测结果导出交付件） |

**探测与状态**（`server/src/finance/bridge/probe.ts`）：

1. 解释器：`FINANCE_PYTHON` env > `python3` > `python` > `py -3`（Windows）；版本 ≥ 3.9；
2. 依赖：`importlib.util.find_spec` 逐个检测 5 包 + openpyxl，输出版本表；
3. 结果缓存 10 分钟（mtime 或手动刷新），`fin_env` 工具与「设置 → 金融数据」面板共用；
4. 状态三档：`ready`（核心包齐）/ `partial`（部分包缺，逐能力降级）/ `absent`（无 Python 或核心包全缺 → 全走源 A）。

**调用协议**（`server/src/finance/bridge/runner.ts` + `bridge/py/fin_bridge.py`）：

```
spawn(python, [fin_bridge.py, <task>], { env: 净化后环境 })
stdin  ← {"params": {...}}          // 单次 JSON，参数在脚本侧白名单校验
stdout → {"ok": true, "data": ...}   // 单次 JSON（大数组走紧凑编码）
stderr → 日志（调试信息）
```

- task 清单（脚本侧注册表）：`kline` / `fundamentals` / `fund_profile` / `calendar` / `indicators` / `export_table` / `news`（akshare 兜底）；
- 超时：默认 30s（`FINANCE_PY_TIMEOUT_MS`），kill 进程组；并发信号量 1（baostock 全局登录态冲突规避）；
- 错误码 → 工具层中文提示：`DEP_MISSING`（缺包 → 引导安装）/ `LOGIN_FAIL`（baostock 登录失败 → 网络提示）/ `TIMEOUT` / `BAD_PARAM` / `SOURCE_ERROR`；
- **安全**：仅执行仓库内固定脚本（路径常量拼接，不接用户输入）；参数 JSON 白名单校验；不出网例外——数据源本身需要外网，允许但限速；脚本无文件写权限敏感操作（快照写出 Node 侧完成）。

**安装引导**（`fin_env` 工具 + 设置面板）：

- 展示：解释器路径 / 版本 / 包状态表 / 「一键安装」按钮与手动命令；
- 一键安装经**审批门**（`request_approval`）：执行 `python -m pip install -U baostock akshare pandas ta tablib`（超时 5 分钟，输出摘要回灌）；国内镜像可选 `FINANCE_PIP_INDEX_URL`（默认官方源）；
- 安装完成后自动重新探测。

### 3.3 能力路由与降级链（`gateway.ts` 内建路由表）

| 数据类别 | 主源 | 备源 | 兜底 |
| --- | --- | --- | --- |
| 实时快照（股票/ETF/指数） | 东财（Node） | 腾讯 → 新浪（Node） | akshare |
| K 线（日/周/月，前复权默认） | baostock（Py） | 东财（Node） | akshare |
| K 线（分钟级） | 东财（Node） | akshare | — |
| 技术指标 | ta（Py） | Node 自研指标库 | — |
| 财务数据 / 交易日历 | baostock（Py） | akshare | — |
| 基金 / ETF 档案 | akshare（Py） | 天天基金（Node） | — |
| 场外基金净值 | 天天基金（Node） | akshare | — |
| 新闻 / 公告 | 东财（Node） | 新浪（Node） | akshare |
| 全市场筛选底表 | 东财 clist（Node，缓存 10 分钟） | akshare | — |
| 回测 | Node 自研引擎（唯一） | — | — |

路由语义：`source: 'auto' | 'node' | 'py'`（工具入参可强制，默认为 auto 按上表）；降级发生时在工具结果中注明实际来源（数据溯源要求）。

### 3.4 快照与缓存

- **快照（可复现资产）**：`fin_kline` / `fin_backtest` / `fin_screen` / `fin_game` 结果默写快照到会话工作区 `charts/<symbol>-<period>-<yyyymmddHHMM>.json`（含 `meta`：来源 / 抓取时间 / 复权口径 / 条数），消息块与报告引用之；工作区文件进出交付件体系（可版本 diff）；
- **缓存（性能）**：SQLite 表（迁移 v10）：
  - `finance_kline_cache`（symbol+period+adjust 唯一，存快照 JSON，TTL：日线当日内逐日追加不重复拉取，分钟线 5 分钟）；
  - `finance_quote_cache`（symbol 唯一，TTL 10s，仅防抖不落盘展示）；
  - `finance_news_cache`（symbol/市场维度，TTL 30 分钟，去重键 URL）；
  - `finance_watchlist`（id / symbol / type / name / sort / created_at，全局单表）；
  - `finance_meta`（探测结果、交易日历缓存、数据源健康度）。
- 交易时段感知：`asOf` 时间戳 + 周末/节假日（日历优先 baostock，缺省内置周末规则）判断「行情是否新鲜」，过期数据在工具结果与 UI 显式提示。

---

## 4. 符号与品种模型（`server/src/finance/symbol.ts`）

```ts
type AssetType = 'stock' | 'etf' | 'fund' | 'index'
interface FinSymbol {
  type: AssetType
  code: string            // 归一化：股票/ETF/指数 6 位数字；场外基金 6 位数字
  exchange?: 'sh' | 'sz' | 'bj'
  symbol: string          // 展示规范：sh600519 / sz159915 / 000001(场外基金)
  name?: string
  secid?: string          // 东财 secid：1.600519（沪）/ 0.000001（深）
}
```

- 归一化规则：`600519 / sh600519 / 1.600519 / 贵州茅台` → 统一 `FinSymbol`；前缀判定（60/68→sh，00/30/12→sz，43/83/87→bj，159/510/512/513/515/588→ETF，51x/58x 场内、0xxxxx 场外基金按证券列表消歧）；
- 解析依赖**证券主数据表**：启动惰性拉取全市场列表（东财 clist，缓存 7 天）→ `finance_meta`；离线兜底：内置常见指数与名称反查失败时要求精确代码。
- `fin_search` 工具 / `/api/finance/search` 搜索接口共用同一解析（代码 / 名称 / 拼音首字母模糊匹配）。

---

## 5. 工具集契约（`fin_*`，全部 `tier='deferred'`）

> 通用约定：`readOnly=true`（`fin_watch` 写类除外）；结果含 `asOf`（数据时间）、`source`（实际来源）、`cache`（命中与否）；工具层不认识 `symbol` 时返回标准化错误与候选。

### 5.1 工具清单

| 工具 | 入参（要点） | 出参（要点） | 说明 |
| --- | --- | --- | --- |
| `fin_env` | `action: status\|install\|refresh` | 解释器/包状态表/安装指引 | Python 桥状态与安装（install 走审批） |
| `fin_search` | `query, type?` | 候选列表（symbol/name/type） | 代码/名称/拼音模糊搜索 |
| `fin_quote` | `symbols: string[]（≤50）, fields?` | 快照表（价/涨跌幅/量额/换手/市值/PE/PB） | 批量实时快照 |
| `fin_kline` | `symbol, period（day/week/month/min5..60）, adjust（qfq/hfq/none）, limit≤500, indicators?[], annotations?[], persist?` | 快照路径 + 摘要统计（区间涨跌/波动/量能）+ **kline 块模板**（供模型复制） | K 线数据主力通道；默认落盘快照 |
| `fin_indicator` | `symbol\|series, indicator, params, period` | 最新值 / 序列 / 信号摘要（如 MACD 金叉日） | ta 优先，Node 兜底 |
| `fin_fund` | `code, kind: etf\|fund` | 档案：规模/费率/跟踪指数/前十大持仓/分红/近1/3/6/12月收益 | 基金与 ETF 详情 |
| `fin_fundamental` | `symbol, reportType（季/年）, years?` | 三表要点 / 财务比率（ROE/毛利/负债率/现金流）/ 估值分位 | baostock 报表 |
| `fin_news` | `symbol?, market?, limit≤20, since?` | 新闻/公告列表（时间/来源/标题/URL/摘要） | 去重排序，标注信源等级 |
| `fin_screen` | `conditions[]（字段/算子/值）, orderBy, limit≤100, type?` | 结果表 + 快照（导出 CSV/XLSX 可选） | 全市场筛选（快照底表 + 缓存） |
| `fin_backtest` | `symbol, strategy: { template: ma-cross\|rsi-reversal\|macd-cross\|boll-breakout\|buy-hold, params }, range, fee?, slippage?, persist?` | 绩效表（收益/年化/回撤/夏普/胜率/交易数）+ 净值曲线数据 + 快照 | 策略回测（Node 引擎） |
| `fin_game` | `action: matrix\|sequence\|evolve\|simulate, topic, params{…}, seed?, persist?` | 均衡解 / 博弈树 / 演化曲线 / 路径分位统计 + 结论要点 + 快照 + **```game 块模板** | 多空博弈建模与模拟（§5.4） |
| `fin_watch` | `action: add\|remove\|list, symbol?, note?` | 自选列表（联动行情 Tab） | watchlist 管理（写类，审批门） |

### 5.2 K 线渲染数据通道（关键设计）

1. `fin_kline` 执行：数据获取 → 指标计算 → **快照落盘** `charts/<symbol>-<period>-<ts>.json` → 返回：
   - `detail`：数据摘要（区间 / 涨跌幅 / 波动 / 关键价位）+ **现成的 kline 块模板**（模型复制到回复即可，无需重输出数据）；
   - `artifacts: ['charts/...json']`（进交付件体系）。
2. 快照 JSON schema（`chart-snapshot`）：

```json
{
  "kind": "kline", "symbol": "sh600519", "name": "贵州茅台", "period": "day", "adjust": "qfq",
  "meta": { "source": "baostock", "asOf": "2026-09-17T15:00:00+08:00", "bars": 250 },
  "bars": [{ "timestamp": 1757952000000, "open": 1450.0, "high": 1468.0, "low": 1442.0, "close": 1461.0, "volume": 2834500, "turnover": 4.13e9 }],
  "indicators": ["MA", "VOL", "MACD"],
  "annotations": [{ "type": "priceLine", "price": 1500, "label": "压力位" }]
}
```

3. 消息块（模型在回复中输出）：

   ````markdown
   ```kline title="贵州茅台 日K（前复权）"
   { "src": "charts/sh600519-day-202609171500.json", "indicators": ["MA","VOL","MACD"] }
   ```
   ````

   - 小而简的数据允许内联 `"data"`（同快照 schema 的 bars），阈值 ≤120 根且由工具模板决定；默认一律 `src` 引用；
   - 解析器 `client/src/lib/kline-spec.ts`（零依赖纯函数，对齐 `chart-spec.ts` 模式）：`{ src?, data?, indicators?, annotations?, title? }` 松校验 + 中文错误。

### 5.3 Agent 侧纪律（写入场景协议与技能）

- K 线 / 行情 / 财务 / 新闻数字必须来自 `fin_*`（工具失败如实说明，禁止编造、禁止手写数据）；
- 每份报告的数据附录列出：工具名 / 标的 / 口径（复权） / `asOf` / 快照路径；
- 回测必须 `fin_backtest`；指标数值必须 `fin_indicator`（禁止目测近似）；博弈模拟必须 `fin_game`。

### 5.4 博弈模拟引擎（模型与算法，`server/src/finance/game/`）

> 纯计算模块（零网络、零 IO），全部可单测；ABM 使用自实现 PRNG（mulberry32），
> **相同 `seed + params` 输出逐位一致**。计算护栏：ABM 默认 500 路径 × 120 轮 ≈ 6 万步 < 200ms；上限 2000 × 240 ≈ 48 万步 < 2s（工具超时内）。

公共入参 `GameScenario`：`{ topic, symbol?, params, seed?（默认 20260918） }`；
公共出参 `GameResult`：`{ model, params, seed, result, stats, narrative }`——`narrative` 为解要点文本（供模型引用，如「懦夫博弈：双方进攻双输，先退让方损失最小」）。

#### 模型 1 · 静态矩阵博弈 `matrix`（多空对峙与纳什均衡）

- 参与方：多头 L / 空头 S；双方策略空间各 3 档：`aggressive`（进攻：加仓 / 加空）、`hold`（观望持有）、`retreat`（撤退：平仓）；
- 收益函数（每方）：`U(own, opp) = 方向 × priceImpact × (ownStress − oppStress) + oppRetreatCarry − cost(ownStress)`；
  参数：`capital`（资金规模）、`priceImpact`（冲击系数）、`carryCost`（持仓成本 / 期）、`retreatLoss`（撤退滑点损失）；
- 求解：纯策略纳什均衡（3×3 最优反应不动点遍历）+ 混合策略均衡（support enumeration 全支持集枚举，线性方程组精确解，退化集合标记）；
- 理论映射：按参数区间自动识别经典博弈类型——囚徒困境（双方进攻双输且无法协调）/ 懦夫博弈（对撞升级 vs 单方退让）/ 协调博弈（一致行动得高分）/ 智猪博弈（小方跟随大方），映射结果进 `narrative`；
- 输出：双向收益矩阵、均衡集（纯 / 混合 + 概率）、均衡解读、敏感性（关键参数 ±10% 对均衡类型的影响扫描）。

#### 模型 2 · 序贯博弈 `sequence`（逆向归纳）

- 结构：深度 2-3 层决策树，节点 =（参与方，可选行动），叶收益复用模型 1 公式（简化参数）；
- 求解：逆向归纳 → 子博弈完美均衡路径；输出树结构（节点 / 边 / 收益对）+ 均衡路径 + 反事实对比（若先动方选择另一分支的结局）；
- 参数：`leader: 'long' \| 'short'`（主导方）、行动序列模板（如「增持 → 跟随加仓 / 观望」「减持 → 跟随撤退 / 抄底」）。

#### 模型 3 · 演化博弈 `evolve`（复制动态）

- 群体：多头比例 `x` 与空头比例 `1−x`（可扩展三群体 +观望）；适应度 `U_L(x)` / `U_S(x)` 由价格反馈给出（价格 = 比例映射（线性 / logistic）→ 方向收益）；
- 动力学：`dx/dt = x(1−x)(U_L(x) − U_S(x))`，RK4 数值积分（时长 / 步长可配）；
- 求解：固定点（数值扫描 + 收敛精化）、稳定性判定（导数符号 → 稳定 = 演化稳定策略 ESS）；输出演化曲线 + 稳定点标注 + 初值敏感性（多初值曲线叠加）。

#### 模型 4 · ABM 蒙特卡洛 `simulate`（主体建模）

- 主体类型与规则（权重参数化）：多头趋势派（动量 > 阈值加多）/ 空头趋势派（反向）/ 均值回归套利者（偏离均线反向承接）/ 做市商（按库存调报价，缓冲动量，提供流动性）/ 噪音散户（随机小单）/ 机构大单（预设时点的冲击事件）；
- 每轮流程：各主体输出净订单流 `flow_t` → 价格冲击 `ΔP = λ·flow_t + σ·ε_t`（λ 冲击系数、σ 波动、ε 白噪声）→ 更新多空累积盈亏 → **级联机制**：空头浮亏 > `cascadeThreshold` 触发被动平仓（放大上行动量 = 挤空），多头同理（踩踏）；
- 蒙特卡洛：N 条路径（默认 500，上限 2000）；统计输出：
  - 价格分位带（P5 / P25 / P50 / P75 / P95 按轮次）、终值分布直方图；
  - 多空累积盈亏分布（均值 / 分位）、最大回撤分布；
  - 事件概率：**挤空**（上行突破阈值 + 空头级联）/ **踩踏**（反向）/ **僵持**（终值落带宽内）；
- 参数：`initialPrice, lambda, sigma, rounds（≤240）, paths（≤2000）, longWeight, shortWeight, arbWeight, mmLiquidity, retailNoise, cascadeThreshold, shockEvents[]`。

#### 输出与复现

- 结果快照落盘 `charts/game-<topic-slug>-<ts>.json`（`kind: 'game'`，含 `meta`：模型 / 种子 / 参数 / 生成时间）；相同种子可重放；
- 消息块协议：

  ````markdown
  ```game title="茅台多空对峙推演"
  { "src": "charts/game-maotai-duikang-202609181030.json", "model": "simulate" }
  ```
  ````

  - `matrix` / `sequence` 结果小，允许内联 `"data"`；`simulate` / `evolve` 默认 `src` 引用（数据量护栏：分位带 + 抽样路径，全量路径不入快照）；
- `client/src/lib/game-spec.ts` 解析（对齐 `kline-spec` 模式：零依赖纯函数 + 中文错误信息）。

---

## 6. 前端设计

### 6.1 K 线块（消息内）

- 组件：`client/src/components/chat/md-ext/KlineBlock.tsx`（对齐 `ChartBlock` 模式：流式期显示源码 → 解析 → 渲染；工具条：源码 / 全屏 / 复制；错误卡 + 源码回退）；
- 解析：`client/src/lib/kline-spec.ts`（纯函数，主包可引用）；
- 渲染：`client/src/lib/kline.ts`（唯一接触 klinecharts 的模块，动态 import 独立 chunk）：

```ts
import { init, dispose } from 'klinecharts'   // v10
// init(el) → chart
// chart.setSymbol({ ticker, pricePrecision, volumePrecision })
// chart.setPeriod({ span, type })
// chart.setDataLoader({ getBars: ({ callback }) => callback(bars) })
// chart.createIndicator({ name: 'MA', paneId: 'candle_pane' })
// chart.createIndicator({ name: 'VOL', paneId: 'vol_pane' })
// 主题对齐 md-light（A 股配色：涨红跌绿）；ResizeObserver → resize；卸载 destroy
```

- 数据获取：`data` 内联直接用；`src` 走既有交付件内容接口 `GET /api/sessions/:id/artifacts/content?path=<src>&raw=1`（M6 通道，零新增）；
- 周期切换：块内小工具条（日/周/月 + 复权）触发 `/api/finance/kline`（只读网关直连，不重新问 Agent），切换结果仅本地展示不改快照；
- 标注渲染：`priceLine` / `marker`（买卖点）/ `segment`（支撑压力）→ klinecharts overlay（`createOverlay`）。

### 6.2 「行情」主区 Tab（FinanceView）

> **M34 修订（ADR 98，2026-09-18）**：本节「行情」主区 Tab 已撤除——`FinanceView` / `KlinePanel` / `trading-hours`、Command Palette 入口与 `MainTab` 类型一并移除；K 线承载改由会话 ```kline 块（§6.1）与画布 `KlineNode`（§6.4）提供；§7 接口与 watchlist 存储不变。下述布局 / 刷新描述留存沿革。

- 注册：AppLayout 主区 `Tabs` 新增 `行情`（懒加载独立 chunk，不进首屏）；Command Palette 新增入口；
- 布局（左列表右详情）：
  - 左：**自选列表**（watchlist）：分组（股票 / ETF / 基金 / 指数）+ 实时价 / 涨跌幅 / 迷你走势；拖拽排序 / 搜索添加 / 删除；
  - 右：Tab 详情 —— `K线`（大图，周期/复权/指标全切换，复用 `lib/kline.ts`）/ `概况`（快照 + 估值 + 基金档案）/ `新闻`（个股新闻流）；
- 数据通道：`/api/finance/*` REST（见 §7）；刷新：交易时段轮询（默认 10s，`FINANCE_QUOTE_REFRESH_MS`），非交易时段停；顶部标注数据延迟与 `asOf`；
- 空态与错误：未启用时引导（设置开关）；源全部失败显示降级提示与重试。

### 6.3 LiveDock 扩展（可选；实施期结论：未实施——裁剪为工具卡展示，见 §13 评审结论）

- `fin_*` 工具执行经 `opNotify`（`kind: 'fin'`）→ LiveDock 第 4 视图「数据」（抓取源 / 标的 / 耗时 / 快照路径流）；
- 若实施批 D 判定收益不足，可裁剪为仅工具卡展示（ToolCard 已能显示摘要与产物）。

### 6.4 博弈交互可视化（GameBlock + 画布节点）

> **M34 修订（ADR 97，2026-09-18）**：主区「博弈」Tab 与 GameLab 博弈实验室**已移除**——博弈不做独立面板，收敛为「会话内块 × 画布节点 × Agent 通道」三形态；「多空对弈」升级为协议驱动的 agent 对抗链路。以下为修订后设计。

**GameBlock（消息内呈现）**：按 `model` 分派渲染内核（`client/src/components/game/`，懒加载独立 chunk，画布节点共用）：

- `matrix`：收益矩阵热力图（多头收益蓝 / 空头收益橙双色域；均衡格加边框徽标；悬停显示双方收益与最优反应；自绘 SVG——3×3 自绘比通用图表可控）；
- `sequence`：博弈树（自绘 SVG：节点 = 参与方徽标 + 行动标签，叶 = 收益对；均衡路径高亮加粗、反事实路径虚线灰）；
- `evolve`：演化曲线（echarts line：多空比例 vs 时间；稳定点标记线 + 多初值曲线叠加）；
- `simulate`：价格路径扇形图（echarts line + P5-P95 分位带渐变）+ 终值直方图 + 多空累积盈亏条形；挤空 / 踩踏事件打标（markPoint）；
- 工具条与降级：源码 / 全屏 / 复制 / **送上画布**（数据集落为 game 节点：含结果直出结果态，缺结果落配置态）；错误卡 + 源码回退；流式期显示源码。

**博弈推演画布节点（GameNode）**：

- 配置态：模型 2×2 卡片 + 标的（可选标注）+ 话题 + 场景预设一键装载 + 「高级参数」折叠区（随机种子 + 各模型核心参数，与消息块共用 `MODEL_FIELDS` 定义）；
- 「运行推演」：直连 `POST /api/finance/game`（纯计算毫秒级，不耗 LLM），成功写回节点（画布自动保存 + 撤销历史），失败节点内展示中文原因；
- 结果态：与消息块共用 `GameResultView` 内核；标题条（话题 / 模型 / 标的 / 种子）+「调整」回配置态（草稿保留）；agent `canvas_write` 或「送上画布」写入自动切结果态。

**K 线画布节点（KlineNode，同批落地）**：空态输入标的 →「拉取行情」直连 `GET /api/finance/kline`（只读网关）写回节点；结果态周期（日 / 周 / 月切换条）/ 复权切换 + 刷新（切换结果写回节点——工作台实体与 K 线块的「仅本地」不同）；K 线块工具条同样提供「送上画布」（bars 内联）。

**协议驱动的 agent 对抗（多空对弈）**：博弈从「工具产物」升级为协议链路——invest 协议「多空对弈」四条（触发与阵容 / 回合纪律 / 走子口径 / 终局裁决）：秦砚持多方 × 雷动持空方逐轮立论交锋（挂证据与置信度、回应对方论据），闻笛归堆证据弹药（附信源等级），方程逐轮量化走子（`fin_game` + 快照 + 种子），祝衡以 `::: verdict` 终局裁决卡落卡（胜负 + 置信度 + 核心依据 + 翻盘条件）；预设 `bull-bear-duel` 一键发起。

- 空态与错误：`FINANCE_ENABLED=false` 时行情入口隐藏、画布节点运行报「服务未启用」；运行失败显示原因（参数越界 / 计算护栏 / 服务未启用）。

---

## 7. HTTP API（`/api/finance/*`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/finance/status` | 桥状态 / 数据源健康度 / 配置摘要（设置面板用） |
| POST | `/api/finance/env/install` | 一键安装依赖（审批门 + 长任务流式输出） |
| GET | `/api/finance/search?q=` | 标的搜索（代码/名称/拼音） |
| GET | `/api/finance/quote?symbols=a,b,c` | 批量快照 |
| GET | `/api/finance/kline?symbol=&period=&adjust=&indicators=` | K 线（面板直连；**不落盘**，与工具通道隔离） |
| GET | `/api/finance/fund?code=` | 基金档案 |
| GET | `/api/finance/news?symbol=&limit=` | 新闻 |
| GET/POST/DELETE | `/api/finance/watchlist` | 自选增删查（写操作要求本地准入，同设置类接口） |
| POST | `/api/finance/game/run` | 运行博弈推演（action / params / seed → GameResult；前端直连**不落盘**） |
| POST | `/api/finance/game/snapshot` | 将当前推演结果落盘 `charts/` 并返回可引用路径（「交给 Agent」用；写操作） |
| GET | `/api/finance/game/presets` | 博弈场景预设列表（参数模板） |

约定：全部只读缓存优先；返回统一 `{ data, asOf, source, degraded? }`；错误 `{ error }` 中文文案（对齐既有 API）。

> **实施期收敛**：实际落地 9 条路由（env / watchlist ×3 / quote / kline / search / news / game）——桥状态并入 `GET /api/finance/env`，一键安装经 `fin_env` 工具（审批门），基金档案经 `fin_fund` 工具（无独立路由），博弈统一为 `POST /api/finance/game` 纯计算直连（快照由 `fin_game` 工具落盘）；最终字段以 [api.md](api.md) §15 为准。

---

## 8. Agent 资产（invest 场景）

> 目录：`agents/invest/`（19 个场景）；角色 id 全局唯一；`order: 62`（finance 与 bi 之间）；
> icon `trending-up`；theme `#dc2626`（红——A 股涨色，与 finance 绿区分）。

### 8.1 场景与角色（5 角色）

| id | 名字 | 角色 | 职责 | 核心交付件 |
| --- | --- | --- | --- | --- |
| `invest-lead` | 祝衡 | 投研主管 | 议题拆解与分工、交叉检验、数据冲突裁决、报告收口 | `docs/投研报告-<主题>.md` |
| `analyst-fa` | 秦砚 | 基本面分析师 | 财报与财务比率、估值（PE/PB/PEG/DCF 三口径）、行业对比、护城河与风险 | `docs/基本面分析-<主题>.md` |
| `analyst-ta` | 雷动 | 技术面分析师 | K 线语言、趋势结构、指标（MA/MACD/RSI/BOLL/KDJ）、支撑压力、量价、多周期 | `docs/技术面分析-<主题>.md` |
| `quant` | 方程 | 量化策略师 | 策略规则化、回测与参数敏感性、**多空博弈建模与模拟推演**、实施计划（仓位/触发条件/止损/监控） | `docs/策略方案-<主题>.md` / `docs/博弈推演-<主题>.md` |
| `analyst-news` | 闻笛 | 舆情新闻分析师 | 公告解读、事件分级、预期差、情绪与信源核实 | `docs/舆情简报-<主题>.md` |

- chain：`[invest-lead, analyst-fa, analyst-ta, analyst-news, quant]`；`parallel: true`（四路分析可并行，lead 收口）；
- 工具白名单（草案，落地时以检查脚本校验）：

| 角色 | fin_* 子集 | 通用 |
| --- | --- | --- |
| invest-lead | 全部 12 个 | 文件集 + calc/date_calc/csv_analyze + web_search/web_fetch + 协作基线 |
| analyst-fa | env search quote kline fundamental fund news | 文件集 + calc/date_calc/csv_analyze + 协作基线 |
| analyst-ta | env search quote kline indicator news | 文件集 + calc/date_calc + 协作基线 |
| quant | env search quote kline indicator backtest screen fund game | 文件集 + calc/csv_analyze + 协作基线 |
| analyst-news | env search quote news | 文件集 + calc/date_calc + web_search/web_fetch + 协作基线 |

（协作基线 = `handoff` / `remember` / `write_todos` / `load_skill` / `request_approval`）

### 8.2 场景协议 `agents/invest/_protocol.md`（投研纪律九条）

1. **数据可溯**：所有数字来自 `fin_*`，附来源 / `asOf` / 口径；快照路径进数据附录；
2. **不臆造**：工具失败如实说明并降级（换源 / 缩小范围 / 交还用户）；禁止估算冒充实测；
3. **观点与事实分离**：事实 vs 判断分列；判断给依据与置信度（高/中/低）；
4. **概率思维**：不预测点位与涨跌；用情景（乐观/中性/悲观）+ 条件触发表达；
5. **风险先行**：任何建议带波动 / 流动性 / 集中度风险说明；不承诺收益；
6. **免责声明**：全部交付件页脚固定模板「本材料由 AI 基于公开数据生成，仅供研究参考，不构成投资建议」；
7. **工具纪律**：K 线必须 `fin_kline`；指标必须 `fin_indicator`；回测必须 `fin_backtest`；博弈模拟必须 `fin_game`；金额与仓位用 `calc`；
8. **分工与裁决**：四路分析各司其职、独立产出；数据冲突由 lead 按「来源可靠性 > 时效 > 一致性」裁决并记录；策略由 quant 主编，报告由 lead 收口。
9. **模拟推演不越界**：博弈输出固定标注「模型推演，非预测」；模型假设（参与方 / 策略空间 / 收益口径 / 参数来源）必须列明；模拟结论不替代事实数据；进报告的推演须附快照路径与随机种子。

### 8.3 技能（5 个，技能库 41 → 46）

| 技能 | 内容要点 |
| --- | --- |
| `technical-analysis` | K 线语言（实体/影线/缺口/形态）、趋势结构（高点低点/均线系统）、指标用法与误区（MACD 滞后、RSI 背离、BOLL 收口）、多周期共振、量价关系、支撑压力画法 |
| `fundamental-analysis` | 三表精读、财务比率（ROE 杜邦 / 毛利 / 负债 / 现金流质量）、估值三口径（相对 / 绝对 / 分部）、行业对比与分位、财报排雷清单（应收 / 存货 / 商誉 / 关联交易） |
| `investment-strategy` | 想法→规则化（入场/出场/仓位/止损）→回测口径（区间 / 费用 / 滑点 / 样本外）→评估指标（收益 / 回撤 / 夏普 / 胜率 / 换手）→参数敏感性→实施（触发条件 / 监控清单 / 复盘节奏） |
| `market-news-analysis` | 事件分级（政策 / 业绩 / 事件 / 情绪）、预期差框架、公告类型影响速查、信源等级与核实、舆情极值的反向思考 |
| `game-theory-trading` | 博弈论交易应用：懦夫 / 囚徒 / 协调博弈映射与识别、纳什均衡速算与解读、复制动态与 ESS、ABM 参数化（主体 / 冲击 / 轮次）、模拟结果解读与反模式（把推演当预测、参数过拟合） |

### 8.4 预设与头像

- `_presets.yaml` +2：
  - `invest-review`「投研快评」：`invest-lead + analyst-ta + analyst-news`（一盘快评：技术位 + 舆情面 → 简报）；
  - `strategy-research`「策略研究」：`quant + analyst-fa + analyst-ta + invest-lead`（策略从标的到回测到实施）；
- 头像 5 张（512×512，v17 3D 卡通风格，七维区分）：祝衡（深蓝西装 + 趋势线平板）、秦砚（金丝眼镜 + 财报册）、雷动（卫衣 + 多屏 K 线）、方程（极客风 + 回测曲线）、闻笛（耳麦 + 快讯屏）；注册图标 `trending-up` / `line-chart` 等。

---

## 9. 合规与安全

1. **免责**：报告 / 简报页脚固定免责模板；「行情」Tab 底部常驻「数据仅供参考，不构成投资建议」；
2. **不承诺收益、不给点位预测**：协议层约束 + 技能反模式清单；输出带情景与条件表达；
3. **无交易通道**：本专项不实现任何下单 / 委托接口；「实施」= 条件触发式计划与监控清单；
4. **数据安全**：快照与报告仅落本地工作区；新闻正文引用注明来源与 URL；不爬取需登录 / 付费专区；
5. **爬虫克制**：复用 `antiBotFetch` 限速与冷却；批量接口合并请求；`clist` 全市场快照重缓存（10 分钟）；
6. **Python 桥安全**：固定脚本 + JSON 白名单参数 + 进程组超时 kill + 净化 env（不透传 API Key）；安装命令经审批门且仅白名单包名；
7. **配置开关**：`FINANCE_ENABLED`（默认 **false**，离线 / 演示环境不受影响；开启后入口与工具才可见）。
8. **博弈推演声明**：博弈模拟输出（界面与报告内）固定标注「模型推演，非预测」；模型假设、参数与随机种子随快照落盘可复现。

---

## 10. 配置与数据表

### 10.1 env（`.env.example` 增量）

```
# ---- 金融数据（M34）----
FINANCE_ENABLED=false              # 总开关（false = 入口隐藏、fin_* 不出现在工具面）
FINANCE_PYTHON=                    # Python 解释器路径（缺省自动探测 python3/python/py -3）
FINANCE_PY_TIMEOUT_MS=30000        # Python 桥单任务超时
FINANCE_PIP_INDEX_URL=             # pip 镜像（缺省官方源）
FINANCE_MIN_INTERVAL_MS=1200       # 金融源同域最小间隔
FINANCE_QUOTE_REFRESH_MS=10000     # 行情 Tab 轮询间隔（交易时段内）
FINANCE_KLINE_SNAPSHOT_DIR=charts  # 快照落盘目录（工作区内）
FINANCE_GAME_MAX_PATHS=2000        # 博弈 ABM 路径数上限（计算护栏）
FINANCE_GAME_SEED=20260918         # 博弈模拟默认随机种子（相同种子可复现）
```

- `data/settings.json`（UI 可改）：`financeEnabled`（启用开关，启动时判定、改后需重启）/ `financeQuoteRefreshMs` / `financeMinIntervalMs` / `financePyTimeoutMs`（后三项经网关 getter 热读，保存即生效）；
- 设置页新增「金融投研」区块：启用开关 / 行情轮询与最小请求间隔 / Python 桥超时与包状态 / 一键安装引导 / 数据延迟说明。

### 10.2 迁移（`server/src/store/migrations.ts` v10 `finance`）

`finance_kline_cache` / `finance_quote_cache` / `finance_news_cache` / `finance_watchlist` / `finance_meta`（详见 §3.4；均为本地单用户表，无外键依赖）。

---

## 11. 测试与评测策略

| 层 | 内容 |
| --- | --- |
| server 单测 | `m34-symbol.test.ts`（归一化 / 消歧 / secid 映射）、`m34-sources.test.ts`（源适配器 fixture 回放）、`m34-gateway.test.ts`（路由 / 降级 / 缓存 TTL / 快照落盘）、`m34-indicator.test.ts`（Node 兜底指标 vs 期望值）、`m34-backtest.test.ts`（已知序列的绩效指标口径）、`m34-pybridge.test.ts`（探测解析 / 错误码映射 / fake runner 注入）、`m34-finance-tools.test.ts`（12 工具契约 + 审批 + deferred 契约）、`m34-finance-api.test.ts`（路由契约 / 503·502·400 语义）、`m34-game.test.ts`（纳什求解 / 混合策略 / 复制动态稳定点 / ABM 种子回放 / 计算护栏边界） |
| 网络件 | 东财等源适配器用 **fixture 回放**（录制 JSON 样本进 `tests/fixtures/finance/`），不打真实网络；真实网络冒烟为手动脚本 |
| client | `kline-spec` 解析（合法/非法/内联/src）、`KlineBlock` 渲染（mock klinecharts 或 jsdom 降级态）、`game-spec` 解析与 GameBlock 四模型渲染（jsdom 降级态）、FinanceView store（watchlist 增删 / 轮询启停 / 交易时段判定） |
| e2e | `e2e/m34-invest.spec.ts`（3 条）：投研快评 preset 建会 → 两路并行 → 主管收口（3 交付件）；策略研究 → 三路并行 → 收口（4 交付件）；多空对弈 → 三路交锋并行 → 量化走子 → 终局裁决与 5 交付件（M34 修订新增）；真实浏览器链路通过 |
| mock 剧本 | `server/src/llm/mock.ts`：invest 5 角色剧本 + `artifactFor` 5 份交付件（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案·博弈推演，与角色交付契约一致）；对弈专属剧本 `DUEL_SCRIPTS`（M34 修订新增） |
| eval | golden `16-invest-quick-review`（3 回合）、`17-invest-strategy-research`（4 回合）；M34 修订新增 `19-bull-bear-duel`，基线 19/19 全绿 |
| 校验脚本 | `check:agents` 适配（19 场景 / 74 角色 / 预设 15 条）；`check:skills`（46） |

---

## 12. 实施批次（评审通过后执行）

| 批次 | 内容 | 出口标准 |
| --- | --- | --- |
| **A. 数据底座** | symbol / 缓存与迁移 / Node 源适配器（fixture 测试）/ Python 桥（探测+runner+脚本）/ 网关路由 | server 单测绿；fixture 回放通过；桥探测在无 Python 环境正确降级 |
| **B. 工具与 API** | `fin_*` 12 工具（含 `fin_game`）+ `/api/finance/*` 9 条路由（env / watchlist ×3 / quote / kline / search / news / game，game 纯计算直连）+ 设置项 | 工具契约测试绿；deferred 契约验证；本地手工调用通则 |
| **C. 前端** | kline-spec / KlineBlock / lib/kline.ts（klinecharts v10）/ FinanceView（行情 Tab）/ game-spec / GameBlock / GameLab（博弈实验室，M34 修订移除）/ Command Palette / 设置面板 | client 测试绿；构建包体增量可控（klinecharts 与 game 渲染各自懒 chunk） |
| **D. 资产与收口** | invest 场景 5 角色 + 协议（九条）+ 5 技能 + 预设 + 头像 / mock 剧本 + eval + e2e / design.md §53 + ADR 0066 + CHANGELOG v22 + README | check:agents 19 场景 74 角色过；eval 17 golden 零回归；e2e（新增 m34 用例）全绿；typecheck/lint 全绿 |

依赖顺序：A → B → C → D（C 依赖 B 的 API；D 依赖 B 的工具与 C 的渲染块）。每批独立可验证，批间可停顿评审。

---

## 13. 风险与开放问题

| 风险 | 应对 |
| --- | --- |
| 东财 / 新浪等非官方接口变更或风控 | 多源降级链 + fixture 回放回归 + 缓冲突发；接口失效率高时优先 baostock/akshare |
| akshare 版本迭代频繁（接口易变） | 桥按「能力」而非「函数名」封装；探测包版本并做兼容矩阵提示 |
| klinecharts v10 API 较新（生态资料少） | `lib/kline.ts` 单点封装 + 版本锁定 + 降级（渲染失败显示源码与错误卡） |
| 免费行情延迟 / 非交易时段无更新 | UI 与工具结果标注 `asOf` 与延迟说明；协议要求报告标注数据时效 |
| E2E 无真实数据源 | mock 剧本 + fixture 注入，断言「渲染与链路」而非「真实行情」 |
| pip 安装受网络 / 权限影响 | 一键安装可选 + 手动命令指引 + `partial` 状态逐能力降级 |
| 博弈模拟被误读为「预测」/ 参数过拟合 | 输出与界面统一标注「模型推演，非预测」；协议第 9 条 + `game-theory-trading` 技能反模式清单；报告引用推演必须附模型假设、参数、种子与快照路径 |

**开放问题（评审可拍板）**：

1. 快照目录用 `charts/` 还是并入 `docs/` 附录体系？——建议 `charts/`（数据与文档分离）；
2. `fin_screen` 首期是否含「选基」（基金筛选）还是仅 A 股/ETF？——建议首期仅股票/ETF，基金筛选列二期；
3. LiveDock 第 4 视图（§6.3）是否实施？——建议批 D 视工作量裁剪；
4. 博弈模型深度：首期 4 模型（矩阵 / 序贯 / 演化 / ABM）是否够用，「信号博弈」（信息不对称下的信号传递）是否列二期？——建议首期 4 模型落地，信号博弈按需追加。

> **评审结论（实施期）**：4 项均按建议执行——快照目录 `charts/`；`fin_screen` 首期仅股票 / ETF（基金筛选列二期）；金融视图落地为主区「行情」「博弈」双 Tab（LiveDock 第 4 视图未实施，工具卡展示已覆盖）；博弈首期 4 模型（信号博弈列二期评估）。
>
> **M34 修订（ADR 97，2026-09-18）**：「双 Tab」修订为「行情 Tab + 会话块 + 画布节点」（「博弈」Tab 与 GameLab 移除）；K 线 / 博弈支持画布节点（GameNode / KlineNode）；投研链路增「多空对弈」协议链路（预设 `bull-bear-duel` + `::: verdict` 终局裁决卡）。
