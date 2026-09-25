# 多空对决场景专项设计（M84）—— 双组辩论 · 全程可视化 · 统计举证

> 状态：**H1–H4 已全部实施**（2026-09-25 同日落地并验收；两处前端微增强与 5 席头像已于同日审计收口补齐；收口账：ADR 0220 / design.md §125 / agents/CHANGELOG v107+v108）
> 范围：新场景「多空对决场」（arena 布局 · 5 角色 · 双阵营编制）・双组对抗交互（立论 / 举证 / 质证 / 结辩 / 裁决）・统计举证引擎（Python 桥 `stats` / `significance` 两任务 + `fin_stats` 工具）・量化证据技能（`quant-evidence`）・mock / Eval / E2E / 门禁收口
> 依赖：**M83**（docs/kline-analysis-dsl-design.md）——`fin_analyze` / `fin_strategy` / `fin_backtest`(dsl) / DSL 引擎为本案证据链底座；本案不重复设计画布层，只做消费与统计补齐
> 关联：docs/pk-game-analysis-design.md（M43/M64/M66 PK 范式 · arena 六件套已实施）・docs/scene-chat-design.md（四形态）・docs/finance-invest-design.md（M34 金融网关）・ADR 拟 0220・design.md 拟 §125・agents/CHANGELOG.md 拟 v107
> 现状基线（代码核实）：arena 布局与六件套 parts（`round-track` / `scoreboard` / `verdicts` / `claim-tree` / `offers` / `cross-fire`）已实施；`::: verdict <多方|空方|僵持>` 容器**原生支持多空状态词**（lib/verdict 共用口径）；negotiation 场景为 arena + seats(left/right/center) + parts 声明先例；invest 场景已有轻量「多空对弈」议程（3 轮 + fin_game 走子 + verdict）；Python 桥任务 9 个（capabilities/quote/kline/calendar/fundamentals/indicators/fund_profile/news/export_table，**无统计任务**）；OPTIONAL 包仅 `openpyxl` / `curl_cffi`；skills 70 个（**无统计证据技能**）；mock「走查」触发体系完备
> 编号复核：M82（联网出口）已落 ADR 0218；本专项拟编号 **M84**，ADR 拟 **0220**（M83 拟用 0219），design.md 拟新增 **§125**（M83 拟用 §124）——实施启动时全仓复核一次占用
> 实施纪律（仓库无 Git）：动手前按 `data/*-backup-<date>/` 惯例做目录快照；清理 / 回滚不可恢复

---

## 1. 背景与目标

### 1.1 需求

围绕**一个或多个标的**，组建「做多组」与「做空组」两支专家队伍进行对抗辩论分析；全流程使用 K 线分析工具链；所有论据**可视化、有理有据**；呈现如专家对专家的 PK；最终输出结论。

### 1.2 与既有资产的差异化论证（不重复建设）

| 既有 | 关系 | 边界 |
| --- | --- | --- |
| invest「多空对弈」（九条协议，M34/M66） | 轻量对弈：四位分析师临时换边 + quant 走子 + 主管裁决，是投研报告内的**一个议程** | 本案是**专职对抗赛场**：固定双阵营编制（主辩 + 证据官）、强制交叉质证、统计举证上桌、独立裁决文书；invest 深度对抗由协议追加一行引导移交本案（§3.4） |
| v99 下线 debate「辩论场」 | 泛议题辩论，与 negotiation / moot-court / society 同质而被下线 | 本案**不是话题辩论**，是**标的对抗研判**——每条主张强制挂工具证据（图表 / 统计 / 回测），量化举证是场景身份（论证附 §9 冗余审查） |
| M43/M64/M66 PK 范式 | 已实施：claim / ruling / verdict / score 容器、交锋计量、计分板、论断树、裁决流 | **全量复用**：容器协议零改动、前端零新增元件（§3.3 映射表） |
| M83 K 线分析引擎与 DSL | 已设计：`fin_analyze` / `fin_strategy` / `fin_backtest`(dsl) | 本案证据链的**图表与策略校验底座**；本案补齐「显著性」维度（Python 统计层） |
| negotiation 谈判桌 | arena 布局先例（`seats left/right/center` + parts） | 布局机制复用；本案 parts = `[round-track, scoreboard, cross-fire, claim-tree, verdicts]`（无 offers） |

### 1.3 目标与验收标准

| 能力 | 验收标准 |
| --- | --- |
| 双组对抗 | 多方组（主辩 + 证据官）vs 空方组（主辩 + 证据官）+ 中立裁决长；默认 3 轮，可加轮 / 叫停 / **立场互换** / 追加标的 |
| 全证据链 | 每条主张挂 ≥1 条工具证据（口径含参数 / asOf）；统计断言必须 `fin_stats` 口径（n / 显著性 / CI）；结构断言必须落到 ```kline 图 |
| 全可视化 | arena 六件套（席位 / 回合轴 / 交锋计量 / 论断树 / 计分板 / 裁决流）+ 消息内 kline 图（阶段色带 / 关键位落图 / 分析面板）+ claim / verdict / kpi 容器；**零新增可视化元件** |
| 可裁决 | 终局 `::: verdict`（胜负 / 置信度 / 核心依据 / 翻盘条件）+ `::: kpi` 对决结算（主张 / 显著证据 / 胜轮 / 回应率）；落盘对决报告 |
| 统计引擎 | `fin_stats` 两模式（summary / significance）确定性输出；Python 缺环境时**分级降级**（Node 兜底基础统计 / 明确引导安装） |
| 零回归 | 门禁全绿：check:agents（41 场景 / 166 角色 / 协议 41/41）、check:skills（71）、eval 无回归、E2E 新增 spec 全过、双端 typecheck |

---

## 2. 场景设计（`agents/bullbear/`）

### 2.1 场景元数据（`_group.yaml`）

```yaml
id: bullbear
name: 多空对决场
description: 标的对抗研判：多方与空方两支专家队立论 / 举证 / 质证 / 结辩，裁决长终局判定；图表与统计全程可视
icon: scale                       # 天平（avatar-icons 已注册）；备选 gavel
theme: ["#dc2626", "#059669"]     # 红多绿空（与 KPI 卡组同源）
objective: 产出有理有据的多空裁决书；不做涨跌预测、不给买卖指令、不构成投资建议
chain: [judge, bull-lead, bear-lead, bull-quant, bear-quant]
rounds: true                      # 严格轮流（negotiation 同款语义）
parallel: false
order: 63
guide: 说说要辩的标的（1–5 个）与周期
agenda:
  - label: 标准对决
    prompt: 围绕下面的标的组织一场多空对决（默认 3 轮：双方立论 → 量化举证 → 交叉质证 → 裁决长逐轮判定，终局出裁决书）：
  - label: 相对强弱对决
    prompt: 用相对强弱模式对决以下标的组（多方做多 <A>、空方做空 <B>，断言相对收益方向；举证用统计检验与图表）：
  - label: 单轮快辩
    prompt: 只辩一轮：多空各一次立论 + 一次质证，裁决长给阶段性结论与不确定性清单：
stage:
  layout: arena
  seats:
    left: [bull-lead, bull-quant]       # 多方营地
    right: [bear-lead, bear-quant]      # 空方营地
    center: [judge]
  parts: [round-track, scoreboard, cross-fire, claim-tree, verdicts]
```

### 2.2 角色编制（5 席 · 全量六段骨架）

| id | 名（拟） | role | 职责要点 | tools（增量部分） | skills |
| --- | --- | --- | --- | --- | --- |
| `judge` | 顾鉴 | 裁决长 | 开题确认要素；维护质证秩序（每方每轮 ≤2 问）；**证据核验**（工具溯源抽查：口径 / asOf / 样本量）；逐轮 `::: ruling`；终局 `::: verdict` + 结算 + 报告落盘 | + `fin_analyze` `fin_stats`；skills: `quant-evidence` + `report-authoring` | |
| `bull-lead` | 向阳 | 多方主辩 | 多头逻辑主线与条件触发；每轮立论挂证据、**必须回应空方上轮最强论点**（禁复读）；结辩收敛 | + `fin_analyze`；skills: `technical-analysis` + `investment-strategy` | |
| `bear-lead` | 知寒 | 空方主辩 | 空头逻辑主线（对称） | 同 bull-lead | |
| `bull-quant` | 陆准 | 多方证据官 | 量化举证与质证回应：图表（`fin_analyze`）/ 统计（`fin_stats`）/ 策略（`fin_strategy`）/ 回测（`fin_backtest`）；证据行口径铸造 | + `fin_analyze` `fin_stats` `fin_strategy` `fin_backtest` `csv_analyze`；skills: `quant-evidence` + `investment-strategy` | |
| `bear-quant` | 程实 | 空方证据官 | 对称 | 同 bull-quant | |

**全员基础工具**（最小授权基线）：`list_dir` / `read_file` / `write_file` / `edit_file` / `search_text` / `glob` / `grep` / `calc` / `date_calc` / `write_todos` / `remember` / `handoff` / `request_approval` / `canvas_read` / `canvas_write` / `fin_env` / `fin_search` / `fin_quote` / `fin_kline` / `fin_indicator` / `fin_news`（+ 各席增量；不挂 `mcp__*`、不挂 `media_*`——最小授权）。

**图标与头像**：icon 建议 `gavel`（顾鉴）/ `trending-up`（向阳）/ `trending-down`（知寒）/ `calculator`（陆准）/ `bar-chart-3`（程实）——实现期对 `client/src/lib/avatar-icons.ts` 注册表核验（缺则回退 `scale` / `shield-check`）；`avatar.png` 按 §19 规格生成（可选资产，可后补、不拦截门禁；建议批 H4 前补齐）。**（2026-09-25 审计收口：5 席头像已生成并 512×512 落盘，见 design.md §19.3 表尾 v108 批 + CHANGELOG v108）**

### 2.3 场景协议（`_protocol.md` 要点 · 12 条）

1. **开题要素**：标的（1–5）/ 周期 / 时间窗 / 轮数（默认 3）/ 模式（`direct` 正面 / `relative` 相对强弱）——judge 开场确认并回显；缺项按用户消息推断后请用户确认。
2. **回合结构**：多方主辩立论 → 空方主辩立论 → 双方证据官各出一组量化证据 → 交叉质证（每方 ≤2 问，被质方证据官回应）→ judge 轮次判定。
3. **证据纪律**：主张必须挂 ≥1 条工具证据（口径含参数与 asOf）；统计断言必须出自 `fin_stats`（附 n / 显著性 / CI）；结构断言必须落 ```kline 图（`fin_analyze` 模板）；**禁止目测读图与记忆数字**。
4. **质证纪律**：只质疑证据与逻辑，不攻击角色；必须回应对方上轮**最强**论点；禁止复读上一轮文本（交锋计量板统计提缺 / 已响应，复读会被计为无效）。
5. **容器约定**：立论 / 结辩 → `::: claim`（`视角：多方|空方` / `倾向` / `置信度` + 依据行），轮次判定 → `::: ruling <多方|空方|僵持> 第 N 轮`，终局 → `::: verdict` + `::: kpi 对决结算`；容器内不写 @。
6. **立场互换**：用户指令「交换立场」→ 两队全套对调重赛 ≥1 轮；judge 记录「同证据异结论」现象（检验立场偏见——本案特色动作）。
7. **终局裁决**：`::: verdict` 四要素 = 胜负（多方 / 空方 / 僵持）+ 置信度（高 / 中 / 低）+ 核心依据（≤5 条，逐条挂证据）+ 翻盘条件；另附失效条件与免责声明。
8. **对决结算**：judge 输出 `::: kpi 对决结算`——逐行指标，值列写「多 / 空」对照：`- 主张数（多/空） | 9 / 7 | — | — | claim 计数`；行含：主张数 / 显著证据数 / 胜轮数 / 质证回应率（口径列注明统计来源）。
9. **落盘**：judge 收口写 `docs/多空对决-<标的>-<日期>.md`——开题要素 / 逐轮记录（含 ruling）/ 证据账本（工具口径 + 显著性）/ 裁决书 / 快照引用 / 免责声明。
10. **叫停与加轮**：用户可随时叫停 → judge 按已有轮次收敛「阶段性结论」并声明未决点；加轮续战从下一轮序号接续。
11. **多标的规则**：`direct` 模式下 1–5 标的分轮聚焦（judge 指定 per 轮 focus 或全量覆盖）；`relative` 模式下双方标的组可不同，断言「相对收益方向」，举证必须含 `fin_stats` 相关性 / 相对强度。
12. **合规红线**：全部输出固定声明「分析结论基于历史数据与规则化统计口径，不构成投资建议」；不预测点位、不给买卖指令、不承诺收益；置信度表达用「高 / 中 / 低」不写百分比胜率。

---

## 3. 交互设计

### 3.1 对战全流程

```
开题：judge 确认要素（标的 / 周期 / 轮数 / 模式）→ 席位卡亮起（左多右空）
第 N 轮（默认 N=1..3，可加轮）：
  ① 多方立论（向阳）        → ::: claim（视角：多方 · 依据行挂工具口径；可附 ```kline）
  ② 空方立论（知寒）        → ::: claim（视角：空方）
  ③ 双方举证（陆准 / 程实）  → ```kline（fin_analyze 落图）| 统计表（fin_stats）| 回测摘要
  ④ 交叉质证（双方 ≤2 问）   → 提缺 / 已响应进交锋看板（CrossFire 计量）
  ⑤ 轮次判定（judge）        → ::: ruling <多方|空方|僵持> 第 N 轮（亮点 / 未决点）
结辩：向阳 / 知寒 各 1 条 claim（只收敛不新增证据）
终局：judge → ::: verdict（四要素）+ ::: kpi 对决结算 → 报告落盘 → @用户 交还
```

### 3.2 用户参与动作（复用 ArenaActions 参与条，ADR 0064 口径：只写 Composer 草稿）

| 动作 | 语义 | 实现 |
| --- | --- | --- |
| 加轮 | 「再战一轮」→ 从 N+1 接续 | 既有「加轮」入口；协议第 10 条 |
| 叫停 | 按已有轮次出阶段性结论 | 既有「叫停」入口；协议第 10 条 |
| 表态 | 倾向标记（供态势条显示用户立场） | 既有「表态」入口 |
| **立场互换** | 两队对调重赛 ≥1 轮（检验偏见） | **新增语义**（协议第 6 条；实现期在 ArenaActions 新增一项快捷草稿，纯前端） |
| 追加标的 / 换周期 | judge 确认后重启对应证据链 | 草稿指令（judge 响应） |

### 3.3 可视化清单（全部映射既有元件 —— 前端零新增元件）

| 可视化 | 元件 / 容器 | 数据源 | 状态 |
| --- | --- | --- | --- |
| 双阵营席位 | SeatStrip / SeatCard（`stage.seats`） | 角色 | 已有 |
| 回合轴 | `round-track`（part） | 发言时序 | 已有 |
| 交锋看板（提缺 / 已响应计量） | `cross-fire`（part） | claim 配对计量 | 已有 |
| 论断树 | `claim-tree`（part） | claim 论据 | 已有 |
| 计分板 | `scoreboard`（part） | ruling 计数 | 已有 |
| 裁决流 | `verdicts`（part） | verdict | 已有 |
| 态势条 / 结论条 / 参与条 | MomentumBar / ConclusionBar / ArenaActions（容器固定组成） | ruling 序列 / verdict | 已有 |
| K 线图与落图（阶段色带 / 关键位 / 分析面板） | KlineBlock（M83 批 C） | `fin_analyze` 快照 | M83 |
| 统计举证表 / 相关性矩阵 | 消息内表格 + 快照 | `fin_stats` | 本案 |
| 对决结算 | `::: kpi`（五列，口径列注明统计来源） | judge | 已有容器 |

**仅两个前端小增强**（纯前端派生，实现期核实必要性）：
a) **证据徽标统计变体**——claim 证据行文本含 `p=` / `n=` / `CI` 时，徽标升级「统计级」样式（A3 证据徽标族已交付，此为小改）；
b) **立场互换轮次标记**——计分板 / 回合轴对互换轮次加角标（协议第 6 条的可见化）。

### 3.4 与 invest 场景的联动（一行引导，可选小改）

`agents/invest/_protocol.md` 「多空对弈」条目追加：「需要多轮质证 + 统计举证的深度对抗 → 移交多空对决场（@顾鉴）」。

---

## 4. 证据链与工具设计

### 4.1 证据类型矩阵

| 断言类型 | 工具 | 可视化产物 |
| --- | --- | --- |
| 结构 / 阶段 / 关键位 | `fin_analyze`（M83） | ```kline 块（阶段色带 + 关键位落图 + 分析面板） |
| 指标状态 | `fin_indicator` | 数值表 + kline 指标面板 |
| 条件有效性（金叉 / 支撑 / 放量…） | `fin_stats` **significance**（本案） | 显著性表（n / p / CI / 胜率） |
| 策略规则化与验证 | `fin_strategy` + `fin_backtest`(dsl)（M83） | 五件套表 + 信号落图 |
| 多标的相对强弱 / 相关性 | `fin_stats` **summary**（本案） | 相关性矩阵 + 相对强度表 + 双 kline |
| 消息面催化剂 | `fin_news` | 信源等级列表 |
| 博弈推演（可选加分项） | `fin_game`（M34） | ```game 块 + 走子板 |

### 4.2 新工具 `fin_stats`（`finance_quant.ts`，deferred / readOnly）

| 参数 | 说明 |
| --- | --- |
| `analysis`（必填） | `summary`（描述统计 + 分布 + 相关性 + 平稳性）/ `significance`（条件显著性检验） |
| `symbols` | summary 模式：1–5 个标的（代码 / sh600519 / 名称） |
| `symbol` | significance 模式：单标的 |
| `period` / `adjust` / `limit` / `source` | 同 `fin_kline` 口径（默认 day / qfq / 250） |
| `events` | significance 模式的事件来源：`{ kind: 'ma_cross_up'\|'ma_cross_down'\|'drop_pct'\|'rise_pct'\|'volume_spike'\|'touch_level', ...params }`（内置检测器，Node 纯计算）或 `{ dsl: '<M83 DSL 条件>' }`（依赖 M83 引擎，进阶） |
| `horizons` | significance 模式：前向窗口（默认 `[1,3,5,10,20]`） |

**返回**：summary → 逐标的统计表（年化收益 / 波动 / 最大回撤 / 当前分位 / 偏度 / 峰度）+ 相关性矩阵（Pearson / Spearman）+ ADF 平稳性 + 口径行；significance → 逐 horizon 表（n / 均值 / 中位 / 胜率 / 盈亏比 / p 值 / bootstrap 95% CI / Bonferroni 校正标注）+ 结论行（显著 / 不显著，α 口径）；`persist=true` 时落盘（chart-snapshot 姊妹 schema）。**降级语义**见 §5.3。

### 4.3 与 M83 工具的分工

- `fin_analyze` 出「结构与图」、`fin_stats` 出「统计显著性」、`fin_strategy`/`fin_backtest` 出「策略与验证」——证据类型不重叠、口径各自单一；
- `fin_stats` significance 的 `events.dsl` 通道**复用 M83 DSL 引擎**求边沿触发（口径与策略执行一致）；内置检测器为其零依赖前置形态。

---

## 5. Python 统计引擎设计（缺库核查 + 桥任务）

### 5.1 缺库核查（当前 → 目标）

| 包 | 现状 | 用途 | 处置 |
| --- | --- | --- | --- |
| `numpy` | 随 pandas 隐式存在（**未显式检测**） | 向量化 / 分位计算 | 纳入检测清单（不单独安装） |
| `scipy` | **缺** | t 检验 / 统计分布 / bootstrap | **新增可选包** |
| `statsmodels` | **缺** | ADF 平稳性 / OLS / 自相关 | **新增可选包** |
| `TA-Lib` | 缺 | K 线形态库 | **明确不引入**——C 依赖重且跨平台安装摩擦大；`ta`（已装）覆盖指标口径，形态统计用规则化实现 |
| `scikit-learn` | 缺 | 机器学习 | **明确不引入**——本场景无 ML 需求，避免重依赖 |

**探测与安装扩展**：
- `probe.ts`：`OPTIONAL_PY_PACKAGES` += `['numpy', 'scipy', 'statsmodels']`；`summary` 增「统计扩展：就绪 / 缺失（显著性检验能力降级）」；
- `fin_env`：`action=install` 增 `group: 'base'（默认，兼容现状）| 'analytics'（base + numpy/scipy/statsmodels）| 'all'`；审批文案列出包清单与用途（statsmodels 安装体积 ~50MB，属可选组，不默认安装）；
- `fin_bridge.py` `capabilities` 名单同步（Node 探测与桥自检双源一致）。

### 5.2 桥任务（`fin_bridge.py` v2 · 两个**纯计算**任务，零网络）

| 任务 | 输入（Node 传入，复用网关缓存） | 输出 |
| --- | --- | --- |
| `stats` | `series: [{name, timestamps[], closes[]}]`（≤8 标的）+ `items: ['summary'\|'distribution'\|'correlation'\|'stationarity']` | summary：年化收益 / 波动 / 最大回撤 / 当前分位 / 偏度 / 峰度 / 尾部比；distribution：收益分位点 + 直方图 buckets；correlation：Pearson + Spearman 矩阵 + 末窗滚动相关；stationarity：ADF（价格 vs 收益）+ p 值 |
| `significance` | `timestamps[]` + `closes[]` + `events: number[]`（bar 索引，Node 侧检测）+ `horizons[]` + `bootstrap: 2000` | 逐 horizon：n / 均值 / 中位 / 胜率 / 盈亏比 / 单样本 t 检验 p 值 / bootstrap 95% CI / vs 全样本基准差检验 / Bonferroni 校正标注 |

- 设计要点：**桥不重复取数**（bars 由 Node 传入，8MB 输入上限内 5 标的 × 500 根安全）；数值异常（样本不足 n<5）返回结构化 `notes` 而非报错；
- `TASKS` 注册表 + 文件头任务注释同步更新；单测可用 `importlib` 加载桥模块直接断言纯函数（不触网，沿用 baostock 字段白名单测试先例）。

### 5.3 降级矩阵（对齐 M34 网关「有 py 依赖时明示」语义）

| 环境 | `summary` | `significance` |
| --- | --- | --- |
| Python ready + 统计包齐 | 全量（含偏度峰度 / ADF / 分位） | 全量（t / bootstrap / 校正） |
| Python partial（缺统计包） | **Node 兜底基础**（均值 / 波动 / 最大回撤 / Pearson；缺项在 detail 注明「需 analytics 组」） | 明确报错 + `fin_env(group='analytics')` 安装引导 |
| Python absent | Node 兜底基础 | 同上（**不硬造** bootstrap / ADF 的近似值——统计能力不允许降级为猜测） |

---

## 6. 技能设计：`quant-evidence`（`skills/quant-evidence/SKILL.md`）

- **front-matter**：`name: quant-evidence`；`description: 量化证据与统计检验：描述统计 / 相关性 / 条件显著性（t 检验 · bootstrap CI）的方法与口径纪律`；`tags: [invest, quant]`；
- **正文结构**（60–150 行，`--strict` CI 门禁）：
  1. `## 数据底座`——`fin_stats` 两模式参数与输出解读（与 `fin_analyze` / `fin_backtest` 的分工）；
  2. `## 统计口径纪律`——**n≥30 才给结论性表述**；多重 horizon 必标 Bonferroni 校正；显著性表述模板（「p=X（n=Y，CI [a, b]）」）；禁止 p-hacking 叙述（换窗口 / 挑 horizon / 删除离群却不披露）；
  3. `## 典型工作流`——① 支撑位有效性（touch_level + significance）② 金叉显著性（ma_cross_up + horizons）③ 多标的相对强弱（summary correlation / 相对强度）④ 回撤分布对比（distribution）；
  4. `## 与主张卡配合`——证据行写法约定：`- <论据> | fin_stats significance p=0.03 n=45 CI[1.2%, 4.8%]`（供证据徽标统计变体识别）；
  5. `## 反模式`——小样本当结论 / 只报显著不报不显著 / 把相关性当因果 / 用统计修饰词包装无检验结论。
- **挂载**：`bull-quant` / `bear-quant` / `judge` 三席 `skills` 引入；两主辩不挂（证据官专职）。

---

## 7. mock / Eval / E2E / 门禁收口

| 项 | 内容 |
| --- | --- |
| mock 触发块 | `server/src/llm/mock.ts` 新增「**对决走查**」（全仓唯一触发词）：固定剧本输出——一轮完整交锋（双方 claim + ruling）+ 终局（verdict 四要素 + kpi 结算），供 E2E 确定性断言 |
| E2E | `e2e/m84-bullbear.spec.ts`：建会话（场景多空对决场）→ 触发「对决走查」→ 断言席位（左多右空）/ 交锋计量读数 / 计分板 / 裁决卡（多方 | 空方状态词）/ 结算表；与 m43-pk / m66-analysis-console 同模式 |
| eval | **零新增（已实施口径）**：mock「对决走查」+ E2E 确定性承接四容器输出（claim / ruling / verdict / kpi）——设计稿预留的替代路径已启用；如需新增任务自当时基线续（按 `evals/baseline.json` 流程） |
| check:agents | 41 场景 / 166 角色 / 协议 41/41（含过程叙述约定三段）/ 声纹不强制（新角色声纹可后补） |
| check:skills | 70 → **71**（quant-evidence 行数 ≥60）；`QUALITY_STRICT=1` 全绿 |
| CHANGELOG | 拟 v107：动因 / 场景与角色新增（5 席）/ 工具与技能变更（fin_stats / quant-evidence / probe / fin_env）/ mock 与 eval / 核验全量（双端测试 / check:agents / check:skills / eval / E2E） |
| 文档账 | ADR 拟 0220（引擎与场景决策：专职对抗场景 vs invest 轻量对弈边界 / 统计能力不允许降级为猜测 / 桥纯计算原则）+ `docs/adr/README.md` 索引 + design.md 拟 §125 + 本文件状态行回写 |

---

## 8. 实施批次

| 批次 | 范围 | 交付物 | 验收 | 依赖 |
| --- | --- | --- | --- | --- |
| **H1 场景资产** | `agents/bullbear/`（`_group.yaml` / `_protocol.md` / 5 席 AGENT.md）+ `_presets.yaml` 预设「多空对决」 | 资产可加载；check:agents 41/166 全绿 | `_group.yaml` stage 席位校验通过（seats 引用真实角色）；协议三段齐备 | M83 批 B（tools 名冻结；H1 可并行起草，门禁在 M83 后跑） |
| **H2 统计引擎** | `probe.ts` / `fin_env` 扩展 + `fin_bridge.py` `stats` / `significance` + `fin_stats` 工具（内置事件检测器 + Node 兜底） | 桥任务单测（importlib 纯函数）+ 工具往返测试（fixture 回放零网络） | significance 表结构（n / p / CI / 校正）与降级矩阵三档行为 | 无（内置检测器零依赖；`events.dsl` 通道待 M83） |
| **H3 技能与镜像** | `skills/quant-evidence` + mock「对决走查」+ eval 任务 + CHANGELOG | 技能 71 个 strict 全绿；mock 触发确定性输出 | 走查剧本含四容器（claim / ruling / verdict / kpi） | H1 |
| **H4 收口** | `agents/invest/_protocol.md` 引导行 + E2E `m84-bullbear`（**已完成**）；证据徽标统计变体 / 立场互换轮次标记（**2026-09-25 审计收口已落地**：`lib/evidence` statistical 统计级 / ArenaActions「互换立场」+ 计分板备注标记） | E2E m84 1/1 ✅；引导行已落；统计级 / 互换动作均带客户端单测 | 裁决流 / 席位分栏 / 四容器断言全过 | H1–H3 |

---

## 9. 风险与边界

- **合规红线（最高优先）**：不预测点位 / 不给买卖指令 / 不承诺收益；置信度用三档不用百分比；免责声明不可省（协议第 12 条 + verdict 固定条目）；
- **角色冗余审查**：与 invest 四分析师（研究为主）、negotiation（利益谈判）、moot-court（法律模拟）逐一边界见 §1.2；核心差异 = 标的对抗 + 工具强制举证 + 统计显著性上桌；若 v99 下线 debate 的复核者质疑，其论证链在 §1.2 完整可引；
- **统计严谨性**：n≥30 门槛、Bonferroni 校正、显著性表述模板写入技能与协议双处；桥任务对样本不足返回结构化 notes 而非硬算；
- **依赖 M83**：H1 的 `fin_analyze` / `fin_stats`（dsl 通道）引用以 M83 批 B 落地为门禁条件；M83 未落地时 H1 资产可起草但不得过 check 门禁（tools 未注册会被拦）——批次依赖已显式标注；
- **Python 体积**：statsmodels + scipy 约 50–80MB，属可选组（`group='analytics'`），不默认安装；缺失时降级矩阵兜底；
- **编号**：本稿 M84 / ADR 0220 / §125 均为拟编号——实施启动前全仓复核（M82 已落 ADR 0218、M83 拟 0219）；
- **零滚动风险**：arena 六件套与容器协议零改动承诺——前端仅两处小改（证据徽标 / 互换标记），均派生式、可独立回退。

---

## 10. 验收自测清单

- [ ] 建会话选「多空对决场」：arena 布局、左多右空席位、guide 预填正确
- [ ] 协议开题：judge 确认标的 / 周期 / 轮数 / 模式四要素并回显
- [ ] 一轮完整交锋：双方 claim（视角词正确）+ 举证（kline 图 / 统计表）+ 质证计量进交锋看板 + ruling 落卡
- [ ] 计分板 / 态势条读数随 ruling 更新；论断树双侧论据可展开
- [ ] 终局：verdict 状态词（多方 / 空方 / 僵持）着色正确 + 四要素齐备 + kpi 结算「多 / 空」对照可读
- [ ] 统计证据：`fin_stats significance` 输出 n / p / CI；证据行被徽标统计变体识别
- [ ] 降级三档：无统计包时 summary 走 Node 兜底且 detail 注明；significance 报错含 fin_env 引导
- [ ] 立场互换：两队对调后 ≥1 轮完成，计分板有互换标记
- [ ] 叫停：阶段性结论 + 未决点清单；加轮：从 N+1 接续
- [ ] 落盘 `docs/多空对决-<标的>-<日期>.md`：开题 / 逐轮 / 证据账本（含统计口径）/ 裁决书 / 免责齐备
- [ ] E2E `m84-bullbear` 全过；mock「对决走查」确定性输出四容器
- [ ] 门禁：check:agents（41/166/协议 41）/ check:skills（71）/ eval 无回归 / 双端 typecheck / vitest 全绿；CHANGELOG v107 登记
