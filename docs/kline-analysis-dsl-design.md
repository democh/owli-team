# K 线分析引擎与 DSL 策略专项设计（M83）—— 实施计划

> 状态：**批 A–D 已实施**（2026-09-25 设计并同日实施：shared 契约 / 分析引擎 / DSL 引擎 / 工具与路由 / 图表组件族 / Agent 接入全量落地并验收）；**审计收口已落**（同日后续核验：跨端契约 fixture / E2E m83 / 块模板 render 对象形态解析修复 / 送画布携带叠加层，详见 §7）；**批 E 已全部收口**（E-1 划线圈 12 工具（含扩展 / 分叉 / 量分）/ 自持绘制手势 / 本地持久化 / 分组隔离——ADR 0221 / design.md §126；E 余项经产品侧确认：Monaco 工作室不立项・实时盯盘暂缓——ADR 0222）
> 修订：v2（2026-09-25 自评审吸收 12 项优化：契约单源 shared ・ DSL 回测通道 ・ 叠加层切换失效 ・ 增强字段解析降级 ・ 工具面简化 ・ 阶段转移约束 ・ 无未来函数护栏 ・ 回放预计算 ・ 关键位定义 ・ 工具条自适应 ・ 跨端契约测试 ・ 文案分层）
> 范围：分析引擎（阶段判 / 情绪周期 / 关键位 / 底部特征 / 落图）・DSL 策略引擎（语法 / 安全求值 / 执行）・图表层组件化（主题 / overlay / 自研指标 / 落图引擎）・分析面板・工具与路由・Agent 能力接入（自动分析 + 生成 DSL）
> 来源：外部文献《klinecharts v10 前端集成完整指南》（画布层 + DSL 附录）学习后，按本项目架构重设计（非照搬）
> 关联：docs/finance-invest-design.md（M34）、ADR 拟 0219、design.md 拟 §124、agents/CHANGELOG.md 拟 v106
> 现状基线（代码核实）：client 已有 `lib/kline.ts`（247 行单文件）+ `kline-spec.ts` + KlineBlock / KlineNode / KlineCanvas 三宿主；server 已有金融网关（M34，gateway / indicator / backtest）+ `fin_*` 数据与量化工具集；agents 已有 invest 场景 analyst-ta（雷动）/ quant（方程）两席；client 依赖 `klinecharts ^10.0.3`；server 依赖 `yaml ^2.6.1`（无需新增服务端依赖）
> 编号复核：M82 已被「联网出口专项」占用（设计中）；本专项拟编号 **M83**，ADR 拟 **0219**（M82 拟用 0218），design.md 拟新增 **§124**（M82 拟用 §123）——实施启动时须全仓复核一次占用（M 编号与 ADR 编号独立）

---

## 1. 目标形态（验收导向）

| 能力 | 验收标准（对照目标截图） |
| --- | --- |
| 图表层组件化 | 主图指标切换条（无 / 布林 / 肯特纳 / SAR / 一目均衡 / 超级趋势 / 唐奇安 / 均线束 / 阶段）+ 副图切换（成交量 / MACD / KDJ / RSI）实时生效；副图面高度分配不回退主图（保留既有回归基线） |
| 划线落图 | 后端 `drawings` 一次落图：中枢 `rectZone` 框、止损位 `textLabel` 胶囊标签、支撑 / 压力 `hline`；标签同价合并 + 碰撞避让；交易计划 `positionTool`（信号触发时） |
| 阶段色带 | 「吸筹」类阶段徽章 + 主图阶段背景色带 + 历史阶段条（近 250 根）三处同源（同一 `phaseBands` 数据） |
| 分析面板 | 阶段分析卡（徽章 / 置信度条 / 特征描述）+ 市场情绪周期（分数 + 档位 + 路径）+ 支撑 / 压力 / 量度目标 + 底部特征标签组 + 口径声明行 |
| Agent 自动分析 | `fin_analyze` 一步取全（阶段 / 情绪 / 关键位 / 特征 / drawings）并输出可直接复制的 ```kline 块（含分析面板）——雷动（analyst-ta）接入 |
| Agent 生成 DSL | `fin_strategy` 支持 DSL（YAML）设计 → lint → run；执行产出 signal（入场 / 止损 / 目标 / R:R）+ drawings 随块落图；未触发可查 facts 变量快照——方程（quant）接入 + `strategy-dsl` 技能卡 |
| DSL 回测闭环 | `fin_backtest` 新增 `template: 'dsl'` 通道：DSL 与模板策略共用同一执行模型与费用口径，输出五件套指标（策略「设计 → 验证」闭环）；「模板 ma-cross ↔ 等价 DSL」一致性作为引擎正确性强测试 |
| 兼容与门禁 | 旧 ```kline 块（仅 src + indicators）零改动照常渲染；chart-snapshot 旧快照可读；双端 typecheck / vitest / check:agents / eval 全绿 |

---

## 2. 现状盘点与差距（gap 表）

| 资产 | 现状 | 目标 | 处置 |
| --- | --- | --- | --- |
| `client/src/lib/kline.ts` | 单文件：主题 + 3 内置指标挂载 + simpleTag 标注 | 组件族：theme / overlays / indicators / drawings / 布局 | 拆分迁移至 `components/finance/chart/`；删除原文件并迁移测试引用 |
| `client/src/lib/kline-spec.ts` | `src`/`data`/`indicators`/`annotations` | + `mainIndicator`/`subIndicator`/`showPhases`/`drawings`/`signal`/`analysis` | 扩展（向后兼容，旧字段语义不变） |
| 分析能力 | 无（仅指标数值） | 阶段 / 情绪 / 关键位 / 特征 / 落图 全链 | 新增 `server/src/finance/analysis/` |
| 策略 DSL | 无（仅固定模板回测 `fin_backtest`） | YAML DSL：lint / run / facts / signal / drawings + 回测验证通道 | 新增 `server/src/finance/dsl/`；`fin_backtest` 加 `template='dsl'` |
| 工具 | `fin_kline`（数据 + 落盘 + 块模板） | + `fin_analyze`、`fin_strategy`、`fin_backtest` DSL 通道 | finance.ts / finance_quant.ts 追加；`builtin.ts` 装配点已就位（L903） |
| 路由 | `/api/finance/*` 8 端点 | + analysis / strategy 3 端点 | `server/src/routes/finance.ts` 追加 |
| Agent | 雷动 / 方程无分析、DSL 工具 | 自动分析 + 生成 DSL 的完整 SOP | 两席 AGENT.md 增工具与文案；新增 `skills/strategy-dsl`；CHANGELOG v106 |
| 画布 / 消息块 | KlineNode / KlineBlock 基础图表 | 图表 + 分析面板 + 分析按钮联动 | 宿主升级（KlineCanvas 动态 import 目标切换） |

---

## 3. 总体架构与数据流

```
                        ┌───────────────────────── 服务端（纯计算，零网络新增）─────────────────────────┐
   FinGateway.kline ──→ │  bars ──┬─→ analysis/analyzeKline(bars) → KlineAnalysis{phases,sentiment,levels, │
   （M34 既有降级链）    │         │        features,drawings,summary,notes}                              │
                        │         └─→ dsl/runStrategy(bars, yaml)  → {facts,signal,drawings}           │
                        └──────────────┬──────────────────────────────┬───────────────────────────────┘
                                       │ 快照 chart-snapshot（+drawings/analysis/signal 可选字段）
                                       ▼
   ┌── 消费方 A：Agent 工具 ──┐   ┌── 消费方 B：客户端直连 ──┐   ┌── 消费方 C：块模板 ──────────┐
   │ fin_analyze（自动分析）   │   │ GET /api/finance/analysis │   │ ```kline 块 JSON 携带       │
   │ fin_strategy（DSL lint/run）│   │ POST /strategy/run|lint   │   │ drawings/analysis/signal    │
   │ fin_backtest（dsl 通道）   │   │ GET /strategy/meta        │   │ render.main/sub/showPhases  │
   └──────────┬───────────────┘   └──────────┬───────────────┘   └──────────┬──────────────────┘
              │                   └──────────┬───────────────┘              │
              ▼                              ▼                              ▼
   ┌────────────────────────────────── 客户端渲染链（全在动态 import chunk 边界内）──────────────────────┐
   │ kline-spec（解析+收窄）→ KlineCanvas → chart/entry.createKlineChart                                │
   │   ├─ chart/theme.ts      色板 / fmtBigNumber / 中文 tooltip / baseKlineStyles                      │
   │   ├─ chart/overlays.ts   rectZone / textLabel / positionTool / phaseBand / polyline（幂等注册）     │
   │   ├─ chart/indicators.ts KCB / ST / DONCHIAN / ICHIMOKU（幂等注册；SAR 用内置）                     │
   │   ├─ chart/drawings.ts   Drawing[] → overlay 引擎（kind 映射 + 标签收集制 + 信号落图）              │
   │   ├─ chart/KlineChart.tsx 生命周期 + 指标工具条 + 阶段色带 + 导出                                   │
   │   └─ chart/KlineAnalysisPanel.tsx 阶段卡 / 情绪 / 关键位 / 特征 / 历史阶段条                        │
   └────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**边界纪律**：引擎（analysis / dsl）为纯函数、可单测、零网络；工具层负责取数与落盘；客户端只消费契约类型（`shared` 不新增依赖 klinecharts 的类型，块 spec 类型保持在 client `lib/`）。

---

## 4. 服务端设计

### 4.1 契约类型单源（`shared/src/kline-contract.ts`，新增）

落图 / 信号 / 分析契约与指标枚举**只定义一次**，server 与 client 双端引用（`@multi-agent/shared` 已是双端依赖，`CanvasKlineData` 同源先例）：

```ts
// shared/src/kline-contract.ts（纯类型 + 常量，零运行时依赖）
export const MAIN_INDICATORS = ['MA', 'EMA', 'BOLL', 'KCB', 'SAR', 'ICHIMOKU', 'ST', 'DONCHIAN'] as const
export const SUB_INDICATORS = ['VOL', 'MACD', 'KDJ', 'RSI', 'ATR'] as const
export const DRAWING_KINDS = ['hline', 'vline', 'segment', 'trendline', 'ray', 'zone', 'rect',
  'textLabel', 'position', 'fibonacci', 'polyline'] as const

export interface DrawingPoint { ts: number; price: number }
export interface Drawing {
  id: string
  kind: (typeof DRAWING_KINDS)[number]
  points: DrawingPoint[]
  label?: string
  style?: { color?: string; width?: number; dash?: boolean; fill?: string; stop?: number; target?: number }
  groupId?: string
  explain?: string
  quality?: number | null      // <35 客户端淡化（预留）
  extend?: Record<string, unknown>
}
export interface SignalSpec {
  symbol: string; period: string; ts: number
  direction: 'long' | 'short' | 'neutral'
  confidence: number; horizon: string
  entry: number | null; stopLoss: number | null; takeProfit: number[]
  riskReward: number | null; rationale: string
  groupId?: string
}
// KlinePhase / KlineAnalysis 类型（§4.2 契约）亦定义于本文件
```

- **消费方**：server 工具枚举 / 路由 `RENDER_INDICATORS` / client `kline-spec` / chart 注册表全部 import 上述常量——「三处同步」从人工纪律升级为编译器保证；
- server 侧仅保留构造工具（id 生成 / 归一化）于 `finance/analysis/drawings.ts`；
- 落地前置核实（批 A 首步）：shared 包 `exports` 出口与双端引用路径，新增文件后立即双端 typecheck。

### 4.2 分析引擎 `server/src/finance/analysis/`（新增目录）

文件：`types.ts` / `phase.ts` / `levels.ts` / `sentiment.ts` / `features.ts` / `drawings.ts` / `index.ts`

**输出契约**（快照 `analysis` 字段与客户端面板共同消费）：

```ts
export type KlinePhase = 'accumulation' | 'bottoming' | 'wash' | 'markup' | 'climax'
  | 'distribution' | 'markdown' | 'panic' | 'rebound' | 'range'

export interface KlineAnalysis {
  asOf: string; bars: number; period: string; adjust: string
  phases: {
    current: KlinePhase; confidence: number; since: string   // 当前阶段起始日
    description: string                                      // 如「低位缩量横盘、筹码集中，主力吸筹特征」
    bands: Array<{ ts: number; phase: KlinePhase }>          // 逐根（段内平滑后），色带 / 历史条消费
  }
  sentiment: { score: number; stage: 'panic'|'hesitate'|'repair'|'optimistic'|'euphoric'; pathLabel: string }
  levels: {
    support: { price: number; basis: string; touches: number } | null
    resistance: { price: number; basis: string; touches: number } | null
    target: { price: number; basis: string } | null
  }
  features: Array<{ key: string; label: string; confirmed: boolean }>   // 地量地价 / 筹码集中 / 平台整理 / 三角形整理
  drawings: Drawing[]
  notes: string[]   // 口径说明（固定含「阶段判定为规则化统计口径，仅供复盘研究」）
}
```

**阶段判定（phase.ts，确定性规则，无随机）**：复用 `finance/indicator.ts` 的 MA / ATR / RSI 等口径，输入维度六项：① MA20/MA60 关系与 MA20 斜率；② 近 120 根区间分位；③ 量比（5 日均量 / 60 日均量）与地量分位；④ 波动分位（ATR/close 的 120 日分位）；⑤ 距 120 日高点回撤；⑥ 近 10 根涨速。判定按优先级短路（强特征先行）：

| 阶段 | 触发条件（全部满足） |
| --- | --- |
| `panic` 恐慌 | 近 10 根跌幅 ≥15% 且量比 ≥1.6 且波动分位 ≥85% |
| `climax` 主升 | 近 10 根涨幅 ≥25% 且量比 ≥1.3 |
| `markdown` 下跌 | close < MA20 < MA60 且 MA20 斜率 <0 |
| `markup` 拉升 | close > MA20 > MA60 且 MA20 斜率 >0（未达 climax 强度） |
| `rebound` 反弹 | 下跌结构（close<MA60）中近 8 根涨幅 ≥8% |
| `wash` 洗盘 | 拉升结构内自阶段高点回撤 5–12% 且量比 <0.8 且 close ≥ MA20 |
| `accumulation` 吸筹 | 区间分位 <35% 且近 20 根振幅 <12% 且量比 ≤1.1 |
| `bottoming` 筑底 | 区间分位 <35% 且近 60 根有 ≥2 次探低 ±3% 且波动分位 <40% |
| `distribution` 派发 | 区间分位 >70% 且近 20 根涨幅 <5% 且量比 ≥1.2 |
| `range` 震荡 | 其余（兜底） |

- **置信度** = 命中条件的归一化强度加权（0–100），单一弱条件命中不给高分；
- **逐根回放（两段式）**：① 静态判定——对每根 bar 用「截至该根」的严格回看窗口判定（无未来函数）；② 平滑——「最短段长 ≥3 根」合并 + **转移邻接约束回填**（邻接表常量：禁止 panic→climax 类直接跳变，非法跳变按邻段回填），产出 `bands`；
- **回放预计算纪律**：全序列指标（MA20 / MA60 / ATR / 量比 / 分位）先一次 O(n) 预计算，逐根判定只做 O(1) 查表——杜绝朴素 O(n²) 实现（n≤500 实测目标 <50ms）；
- 参数常量集中导出（`ANALYSIS_PARAMS`），测试直接引用（避免魔法数散落）。

**关键位（levels.ts）**：摆动点精确定义——swing high = `high[i]` 为左右各 3 根窗口的严格最大值（swing low 对称），聚类容差 ±1.2%、同类最短间隔 8 根；近 120 根内按触碰次数排序 → 支撑（下方最近有效）/ 压力（上方最近有效），各带 `basis`（前高 / 前低 / 密集区）与 `touches`；量度目标：近 40–80 根箱体识别（上下沿重叠度 ≥60%）→ 箱高量度（突破位 ± 箱高），无箱体时按前高延伸，均给 basis。

**情绪（sentiment.ts）**：加权分数 0–100（趋势 40% + 量能 20% + 波动 15% + 位置 15% + 涨速 10%）→ 五档（恐慌 0–20 / 犹豫 20–45 / 修复 45–65 / 乐观 65–85 / 狂热 85–100）；`pathLabel` 固定为「恐慌→犹豫→修复→乐观→狂热」并标注当前档位。

**特征（features.ts）**：地量地价（量、价双低分位）、筹码集中（近 60 根 ±5% 价格带内成交量占比 ≥60% 代理口径）、平台整理（近 20 根振幅 <10%）、三角形整理（近 40 根高低点区间收敛 ≥30%）；每项 `confirmed` 区分「已确认 / 近似口径」。

**落图（analysis/drawings.ts）**：中枢 / 箱体 → `zone`（rectZone 紫框样式，label「中枢」）；支撑 / 压力 → `hline`；量度目标 → `hline`（虚线）；探底位 / 阶段沿 → `textLabel`。全部经 §4.4 的同一通道输出，客户端零特判。

**编排（index.ts）**：`analyzeKline(bars, meta)` → 上述全量；bars <60 根时返回 `notes` 声明「样本不足，阶段结论仅供参考」并降低 confidence；**文案分层纪律**——`description` 等短文案由引擎确定性模板生成，深度解读留给 Agent 在 facts 之上撰写（引擎零 LLM 调用，同一 bars 同一结果）。

### 4.3 DSL 引擎 `server/src/finance/dsl/`（新增目录）

文件：`types.ts` / `expr.ts` / `runtime.ts` / `spec.ts` / `exec.ts` / `builtin.ts` / `meta.ts` / `index.ts`

**语法**（YAML；与外部文献 DSL 同族但按本项目收敛，示例即文档）：

```yaml
name: 均线回踩企稳
description: MA20 上穿 MA60 后回踩 MA20 不破
timeframes: [1d]
inputs:
  fast: 20
  slow: 60
signals:
  - when: "cross_up(ma(close, inputs.fast), ma(close, inputs.slow))"
    emit:
      direction: long
      confidence: 0.6
      horizon: swing
      rationale_hint: 均线金叉
      entry: "close"
      stop_loss: "close - 2 * atr(14)"
      take_profit: ["close + 3 * atr(14)", "hhv(high, 60)"]
drawings:
  - kind: hline
    at: "ma(close, inputs.fast)"
    x: -1
    label: MA20 支撑
  - kind: textLabel
    x: -1
    at: "low - 0.5 * atr(14)"
    text: 观察位
llm:
  system_hint: ""
```

**安全求值器（expr.ts + runtime.ts，核心资产，禁止 `eval` / `new Function`）**
- 自研 tokenizer + 递归下降 parser → AST（算术 `+ - * / %`、比较、逻辑 `and/or/not`、三元 `cond ? a : b`（与 `if(cond,a,b)` 等价）、括号、数字 / 字符串 / 布尔字面量、标识符、函数调用、`inputs.*` 访问）；
- **向量化求值**：每个 AST 节点对「序列上下文」求值为与 bars 等长的数组（标量广播），`ref(x, n)` 平移序列，`cross_up(a,b)` = 前一根 a≤b 且当前 a>b 的布尔序列；
- 变量表：`open/high/low/close/volume/turnover`（来自 bars）+ `inputs.*`（常量）；函数白名单：`ma/ema/hhv/llv/ref/cross_up/cross_down/atr/rsi/dif/dea/hist/bb_up/bb_mid/bb_low/vol_ma/abs/max/min/if`——序列函数复用 `finance/indicator.ts` 的 `sma` / `computeIndicator` 口径（与 fin_indicator 数值一致）；
- 护栏：DSL 源 ≤20KB、单表达式 ≤400 字符、AST 深度 ≤24、单策略序列函数调用 ≤64 次；超限报 lint 级错误；源含 `dsl: 1` 版本字段（缺省 1，未知版本拒绝执行）；
- **未来函数禁令**：`ref(x, n)` 仅允许 n ≥ 0（回看平移）；负偏移在 parser 层拒绝（错误码 `FUTURE_REF`）——对齐 `backtest.ts` 的反未来函数纪律；
- **null 语义**：窗口不足 / 除零 → null 传播；比较与逻辑遇 null 判定为 false（条件不命中）；`when` 序列全 null 的组合在 lint 层给 warning。

**lint（spec.ts）**：zod 结构校验 + 静态检查清单——未知字段 / 未知变量 / 未知函数 / 参数个数与类型 / `inputs` 引用未声明 / `signals` 为空 / `take_profit` 为空 / drawing kind 未知 / 表达式超长或过深；输出 `{ level: 'error'|'warning', code, message, path? }[]`（**免取数、免网络**，供工具与未来编辑器共用）。

**执行（exec.ts）**：
- 载入 bars（≥30 根）→ 合并 `inputs` 覆盖（工具层可传 override）→ 逐条 `signals` 求值 `when` 布尔序列 → **边沿触发**（false→true 的首根，语义同 `fin_backtest`：第 i 根收盘产生信号）；
- `generateDslSignals(bars, spec)` 抽为**共享信号层**（exec.ts 导出）：`fin_strategy`（信号落图）与 `fin_backtest template='dsl'`（回测验证）共用同一实现，口径唯一；以「模板 ma-cross ↔ 等价 DSL」一致性测试锁定（信号序列 / 交易数 / 收益一致）；
- `emit` 表达式在触发根求值 → `SignalSpec`（entry / stop_loss / take_profit 多目标 / R:R = |target0-entry| / |entry-stop|）；无触发 → `signal: null`，`facts` 给出各条件末值；
- `drawings[]`：`x` 支持 bar 索引（负 = 倒数）与 `yyyy-MM-dd` 日期（对齐快照 ts 口径），`at` 表达式在该锚点求值 → `Drawing`；
- `facts`：末根全量变量快照（含 `triggered` / `trigger_index` / `when_series_tail`），未触发时排查主通道；
- 返回 `{ success, facts, signal, drawings, triggered, notes }`。

**内置示例（builtin.ts）**：4 条可直接跑的 DSL 源码文本（均线回踩 / 布林突破 / RSI 反转 / 箱体突破回踩）——供 lint/run 测试基线、Agent 参考模板。

**元数据（meta.ts）**：`DslMeta`（变量组 / 函数签名 / 枚举 direction·horizon / drawing kinds / 由 zod 生成的 JSON schema）；经 `GET /api/finance/strategy/meta` 下发，供编辑器 / 外部消费（原计划供 Monaco 工作室消费——2026-09-25 经 ADR 0222 决定不立项；路由保留）。

### 4.4 快照与块模板扩展

- `server/src/finance/snapshot.ts`：`ChartSnapshot` 追加**可选**字段 `drawings?: Drawing[]`、`signal?: SignalSpec | null`、`analysis?: KlineAnalysis`、`render?: { mainIndicator?: string; subIndicator?: string; showPhases?: boolean }`；`buildKlineSnapshot` opts 同步扩展。**兼容承诺**：旧快照无这些字段照常渲染（客户端全部可选消费）。
- `server/src/tools/finance_shared.ts`：`klineBlockTemplate(title, src, indicators, extra?)`——`extra` 注入 `mainIndicator/subIndicator/showPhases`；块 JSON 保持 `{ src, indicators, ...extra }` 形状（旧字段语义不动）。

### 4.5 工具设计（`server/src/tools/`）

**`fin_analyze`**（新增，`finance.ts`，deferred / readOnly）——Agent 自动分析主入口：

| 参数 | 说明 |
| --- | --- |
| `symbol`（必填）/ `period` / `adjust` / `limit`（默认 250，上限 500）/ `source` | 同 `fin_kline` 口径 |
| `persist`（默认 true） | 快照携带 `analysis` + `drawings`，块模板含分析面板；分析项固定全量输出（phase / sentiment / levels / features）——参数面最小化，模型零选择负担 |

返回：摘要行（阶段 + 置信度 + 情绪分数档位 + 支撑 / 压力 / 量度目标 + 特征标签）+ drawings 条数 + **可直接复制的 ```kline 块模板**（含 `analysis`/`drawings`/`render`，复制即渲染出目标截图形态）。

**`fin_strategy`**（新增，`finance_quant.ts`，deferred / readOnly）：

| 参数 | 说明 |
| --- | --- |
| `action`（必填） | `lint`（静态检查，免取数）/ `run`（执行） |
| `dsl`（必填） | DSL 源码文本（YAML，≤20KB） |
| `symbol` / `period` / `adjust` / `limit` / `source` | `action=run` 时 `symbol` 必填 |
| `inputs`（可选） | 参数覆盖（如 `{"fast": 10}`） |
| `persist`（默认 true，run 时） | 落盘策略执行快照 + 块模板（含 `signal`/`drawings`） |

返回：lint → 结论清单（error 阻断 / warning 提示）；run → facts 摘要 + signal（方向 / 置信度 / 入场 / 止损 / 目标 / R:R）+ drawings + 块模板；失败如实返回错误与修正建议（未知变量列出可用名）。

**`fin_backtest` 扩展（`finance_quant.ts`）**：`template` 枚举追加 `'dsl'`，新增可选 `dsl`（源码文本，`template='dsl'` 时必填）与 `dsl_inputs`（参数覆盖）。信号来源切换为 §4.3 的共享信号层（`generateDslSignals`），执行模型 / 费用滑点 / 绩效指标 / 快照**完全复用**现有回测管线——DSL 策略与模板策略在同一把尺下对比，notes 注明「信号源：DSL」。

**`fin_kline` 保持纯数据通道（不加 analyze 开关）**：职责边界单一化——取数 / 落盘 / 块模板归 `fin_kline`，分析归 `fin_analyze`；减少模型在「哪个入口带分析」上的选择负担与双份参数校验维护。

**枚举单源（shared）**：主图 / 副图 / drawing kind 白名单统一摘自 `shared/src/kline-contract.ts`（§4.1）——`server/src/tools/finance.ts`、`server/src/routes/finance.ts`（`RENDER_INDICATORS`）、`client/src/lib/kline-spec.ts` 全部引用同一常量，「三处人工同步」升级为编译器保证。

### 4.6 路由（`server/src/routes/finance.ts` 追加）

| 端点 | 语义 |
| --- | --- |
| `GET /api/finance/analysis` | symbol / period / adjust / limit / source → `{ analysis, kline? , source, asOf, cache, degraded? }`（客户端「智能分析」按钮直连；不落盘） |
| `POST /api/finance/strategy/lint` | `{ dsl }` → `{ findings }`（免取数） |
| `POST /api/finance/strategy/run` | `{ dsl, symbol, period?, adjust?, limit?, inputs? }` → `{ result }`（不落盘；落盘走工具通道） |
| `GET /api/finance/strategy/meta` | → `DslMeta`（工作室预留） |

未装配网关 503 / 参数非法 400 / 上游全失败 502——沿用 finance 路由既有错误语义与 zod 校验模式。

---

## 5. 客户端设计

### 5.1 图表层组件族 `client/src/components/finance/chart/`（新增目录）

| 文件 | 职责与关键实现要点 |
| --- | --- |
| `theme.ts` | `CHART` 色板（**以项目 md-light 为源**：涨 `#dc2828` / 跌 `#0fa975`，与 KPI 卡组同源；吸收文献的 `compareRule: 'previous_close'`、`indicator.bars` 副图柱红涨绿跌、`separator` 增强、极淡横向网格）；`fmtBigNumber`（亿/万）；`buildKlineTooltip`（中文 OHLC + 涨跌幅带色 + 成交量缩写）；`baseKlineStyles()/baseKlineOptions()` |
| `overlays.ts` | `registerMarketOverlays()`（模块级幂等守卫）：**首批** `rectZone` / `textLabel` / `positionTool` / `phaseBand` / `polyline`；工具函数 `darken` / `alphaHex` / `textFigure`（白字深底彩边胶囊）；纯显示图形一律 `ignoreEvent: true`；段宽不足跳过标签（窄段防溢出） |
| `indicators.ts` | `registerMarketIndicators()`（`getSupportedIndicators` 守卫）：`KCB`（EMA20±2×ATR10）/ `ST`（超级趋势，棘轮推进）/ `DONCHIAN` / `ICHIMOKU`（含 `draw` 云区，云区 `zLevel: -1` 衬底；未来段外推用 Raw 值）；原 ATR 自注册迁入 |
| `layout.ts` | `allocateSubPaneHeight(containerHeight, subPaneCount)`——主图保底 ≥50% 且 ≥96px、每副图 30–140px（**数值断言随 `client/tests/m34-kline-panes.test.ts` 迁移保留**，560px+3 副图→93px/面、860px+3 副图→140px 封顶） |
| `drawings.ts` | `applyDrawings(chart, drawings, bars, signal?)`：`kind → overlay` 映射（hline→priceLine、vline→verticalStraightLine、zone/rect→rectZone、trendline/segment→segment、ray→rayLine、fibonacci→fibonacciLine、position→positionTool、polyline→polyline、未知→segment 兜底）；**标签收集制**（完全去重 → 同价 <0.4% 合并 `·` 连接 → y 接近且 x 接近时左移错开）；`fadeColor`（quality<35 淡化）；signal → `positionTool`（几何走 signal，标签 R:R / 止损距%）；先清后画按 `groupId='analysis'`，效果内 `requestAnimationFrame` 等 `resetData` 完成 |
| `KlineChart.tsx` | 主组件：① init 一次（`dispose(容器)` 释放；ResizeObserver 监听 **0→非 0 宽度恢复** → `scrollToRealTime()`，修复 display:none 后最新 K 线跑出可视区）；② `setSymbol/setPeriod` 同步；③ 数据重灌 `resetData()` + 柱宽按根数自适应（>400→4 / >200→6 / 否则 8）；④ overlay 落图等一帧；⑤ **指标工具条**（内置子组件：主图 `无/布林/肯特纳/SAR/一目均衡/超级趋势/唐奇安/均线束/阶段`、副图 `成交量/MACD/KDJ/RSI`——主图多指标 `isStack=true`、切换先按名移除；副图固定 paneId 重复创建即替换；阶段开关联动 phaseBand；**工具条宽度自适应**：容器 <560px 自动 compact（主图指标收为下拉、副图 chips 保留），画布节点天然落 compact）；⑥ 阶段色带（`bands` 合并连续段 → `phaseBand`，震荡段不着色）；⑦ 截图导出按钮（`getConvertPictureUrl`，白底 PNG）；`forwardRef` 暴露 `getChart()` |
| `KlineAnalysisPanel.tsx` | 纯展示（props.analysis）：阶段卡（中文徽章 + 置信度条 + `description` + 「阶段」开关联动回调）+ 情绪周期（分数 + 档位 + 路径）+ 支撑 / 压力 / 量度目标三数字行 + 底部特征 chips（confirmed 实色 / 未确认描边）+ 历史阶段条（`bands` → 横向色块时间轴 + 首尾日期）+ 口径声明行；面板整体可折叠（默认展开，折叠偏好 localStorage 记忆） |
| `entry.ts` | `createKlineChart(el, input): KlineHandle`——**唯一 import klinecharts 的入口文件**（保持动态 import chunk 边界），内部装配 theme/overlays/indicators/drawings |
| `phaseColors.ts` | 阶段配色与中文名（与 overlay / 面板 / 历史条共享；key 与后端 `KlinePhase` 一一对应） |

**迁移处置**：`client/src/lib/kline.ts` 删除（职责拆分上表）；`lib/kline-spec.ts` 的 `KlineRenderInput` 类接口迁至 `chart/`；`KlineCanvas.tsx` 动态 import 目标改为 `chart/entry`（`KlineHandle` 的 `resize/dispose` 契约不变）。

### 5.2 `kline-spec.ts` 与解析扩展（`client/src/lib/`）

- 新增 `client/src/lib/kline-analysis.ts`：`parseKlineAnalysis(raw)` / `parseDrawings(raw)` / `parseSignal(raw)` 纯函数（零依赖；类型来自 shared 契约，形状收窄返回 `{ value?, warnings }`）；
- **解析降级策略（增强字段与主契约分离）**：`bars`/`indicators` 保持显式报错（模型自纠通道）；`drawings`/`signal`/`analysis` 非法时**降级**——丢弃该字段 / 丢弃单条非法 drawing（上限 60 条）并收集 `warnings[]`，主图照常渲染 + 块内小字提示（增强数据脏不应让图挂掉；引擎 / 工具产出的数据天然合法，此防线只兜模型手写块）；
- `kline-spec.ts` 扩展字段（全部可选、旧块零影响）：

| 字段 | 校验 | 缺省行为 |
| --- | --- | --- |
| `mainIndicator` | 枚举（none/MA/EMA/BOLL/KCB/SAR/ICHIMOKU/ST/DONCHIAN） | 由 `indicators` 首个主图成员推导；再缺省 MA |
| `subIndicator` | 枚举（VOL/MACD/KDJ/RSI/ATR/none） | 由 `indicators` 首个副图成员推导；再缺省 VOL |
| `showPhases` | boolean | `analysis` 存在时 true |
| `drawings` | 数组 ≤60 条；kind 白名单；points 数值 | 无 |
| `signal` | 对象形状 + 数值域 | 无 |
| `analysis` | 形状收窄（phases/sentiment/levels/features） | 无 |

- 枚举引用 shared `MAIN_INDICATORS`/`SUB_INDICATORS`（主图 8 + 副图 5；`indicators` 旧字段语义不变，保持 `DEFAULT_KLINE_INDICATORS=['MA','VOL']`）。

### 5.3 宿主升级

- **KlineCanvas.tsx**：props 透传新字段（`drawings/signal/analysis/mainIndicator/subIndicator/showPhases`）；`data-state` 流程不变；分析面板由上层（KlineBlock / KlineNode）组合渲染（Canvas 保持「纯图」职责，面板拆给宿主——块与节点复用同一 `KlineAnalysisPanel`）。
- **KlineBlock.tsx（消息块）**：
  - spec 含 `analysis` → 图下渲染 `KlineAnalysisPanel`；
  - 无 `analysis` → 工具条右侧「智能分析」按钮 → 直连 `GET /api/finance/analysis`（当前 symbol/period/adjust）→ 本地展示（**不改快照**，与周期切换同语义）；
  - **周期 / 复权 / 标的切换 = 叠加层强制失效**：spec 自带的 `analysis`/`drawings`/`signal` 锚定旧 bars 的 ts 坐标，切换后必须整体隐藏（防色带错位 / 划线错位一整根），本地分析结果同步清空，按钮复位可对当前 bars 重取。
- **KlineNode.tsx（画布节点）**：同款「智能分析」按钮；结果 **写回节点 data**（`CanvasKlineData` 追加可选 `analysis`/`drawings` 字段，`@multi-agent/shared` 同步类型；画布自动保存 → 节点持久携带分析面板）；节点内周期 / 复权切换（写回节点）时同步清除 `analysis`/`drawings`（同一失效纪律）；`.canvas-kline-frame nodrag` 手势隔离规范保持不变。

### 5.4 样式

`client/src/index.css`：指标工具条（chip 组、选中态）/ 分析面板（阶段卡、置信度条、特征 chips、历史阶段条）/ 阶段徽章 的样式类（md-light 对齐，命名沿用 `md-kline-*` 前缀族）；容器高度口径不变（聊天块 560px / 全屏 860px / 节点填满）。

---

## 6. Agent 能力设计（自动分析 + 生成 DSL）

### 6.1 设计决策：不新增角色，能力挂既有两席

- **理由**：雷动（analyst-ta）职责即「K 线语言与趋势结构分析」、方程（quant）职责即「策略规则化与回测验证」——分析引擎与 DSL 正是其职责的工具化落地；新增角色会与两席重叠（项目先例：M79 事实核查收编 moderator、场景调优消除同质角色）；
- **最小授权**：`fin_analyze` 只授给 analyst-ta（及投研链路需要时经 tool 授权扩展）；`fin_strategy` 只授给 quant；
- **升级路径**：两席结论仍经 invest-lead（祝衡）收口；不越界（分析不给买卖指令、DSL 不给下单能力——不改 M34 合规红线）。

### 6.2 `agents/invest/analyst-ta/AGENT.md`（雷动）变更

- `tools` 追加 `fin_analyze`；
- **工作方式**：数据链改为「阶段 / 情绪 / 关键位 / 底部特征一律 `fin_analyze` 一次取全（规则化统计口径，禁止目测读图）；指标现值仍走 `fin_indicator`」；视图承接：「分析收口用 `fin_analyze` 返回的 kline 块模板（含阶段色带、关键位落图与分析面板），一条块全图落位」；
- **专业判断**追加两条硬规则：阶段置信度 <60 时结论降强度表达（「概率性判断」）；情绪周期与特征标签引用时必须标注「规则口径」；
- **质量自检**追加：阶段结论与关键位是否全部出自工具（禁止目测）；口径标注是否齐全。

### 6.3 `agents/invest/quant/AGENT.md`（方程）变更

- `tools` 追加 `fin_strategy`；
- **工作方式**：策略规则化环节改为「模糊想法 → `fin_strategy action=lint` 先行检查 → `action=run` 执行 → 未触发按 facts 变量快照排查（哪条 when 条件为假、差值多少）→ 触发则 signal + drawings 随块落图」；回测环节不变（DSL 产出信号与 `fin_backtest` 模板互为交叉验证口径）；
- **专业判断**追加：DSL 表达式只用白名单函数（引擎口径，禁自造）；stop_loss / take_profit 必须给表达式依据（不可拍脑袋常数）；引用执行结果为「单标的规则化统计验证」，不给下单指令。

### 6.4 新技能 `skills/strategy-dsl/SKILL.md`（新增）

front-matter（name: `strategy-dsl`，tags: `[invest, strategy]`）+ 正文：DSL 全字段语法表（name/description/timeframes/inputs/signals/drawings/llm）・表达式函数白名单与参数表・边沿触发与执行模型・lint/run 工作流・4 条内置示例・常见错误（未知变量 / inputs 未声明 / 深嵌套）与修正。quant 的 `skills` 追加 `strategy-dsl`。

### 6.5 收口登记（批 D 必做）

- `agents/CHANGELOG.md` 追加 v106（动因 / 工具与技能变更 / 文案变更 / 核验：check:agents + eval + 双端测试）；若 mock 面具断言因工具白名单 / 技能集变化受影响，按项目基线刷新流程更新 `evals/baseline.json` 并在条目内登记；
- ADR 拟 0219（引擎口径与集成决策：自研安全求值器 vs eval、规则化阶段口径、组件族拆分、兼容承诺）+ `docs/adr/README.md` 索引 + design.md 拟 §124（实施启动时复核编号占用）。

---

## 7. 测试与门禁

**服务端（vitest，沿用 m34 测试装备：fixture 回放 Fetcher / fake runPy / 可控时钟 / 零网络零 spawn）**
- `server/tests/m83-analysis.test.ts`：合成形态 bars（脚本化吸筹 / 拉升 / 恐慌段）断言阶段判定与置信度区间、bands 平滑（最短段 ≥3）、关键位（触碰数与 basis）、情绪分数档界、特征标签、drawings 有效性（kind 白名单 / 价格有限性）、bars<60 降级声明；
- `server/tests/m83-dsl.test.ts`：表达式（算术 / 优先级 / 比较逻辑 / 三元 / 括号）、函数（ma/ema/hhv/llv/ref/cross_up/atr/rsi/dif…）数值正确性（对照 `finance/indicator.ts` 口径）、lint（未知变量 / 未知函数 / inputs 未声明 / 超深 / 空 signals 全覆盖）、exec（边沿触发语义 / signal 字段与 R:R / drawings 锚点 / facts 快照 / 未触发路径）、护栏（超长 / 超深 / **未来函数拒绝（ref 负偏移）**）、**DSL ↔ 模板 ma-cross 回测一致性**（trades 数 / totalReturn 一致）；
- `server/tests/m83-finance-tools.test.ts`：`fin_analyze` / `fin_strategy` / `fin_backtest template='dsl'` 工具往返（含 persist 落盘断言、块模板 fixture 产出）；路由四端点（400/502/503/正常 + meta schema 形状）；
- **存量保护**：`m34-gateway` / `m34-finance-tools` / `m34-finance-api` / `m34-kline-panes` 全量不回归。

**客户端（vitest / testing-library）**
- `client/tests/m83-kline-spec.test.ts`：新字段解析（合法 / 缺省推导 / 旧块兼容零改动）+ **降级策略**（单条非法 drawing 被丢弃且 warnings 非空、analysis 脏数据忽略不阻断主图）；
- `client/tests/m83-analysis-panel.test.tsx`：面板渲染（阶段徽章 / 置信度 / 特征 chips / 阶段条色块数）+ 阶段开关联动回调；
- `client/tests/m34-kline-panes.test.ts`：import 路径迁移（断言数值不变）；
- **跨端契约 fixture**：以 server 工具实际产出的块模板 JSON（含 `analysis` / `drawings` / `render`）固化为 fixture，client 解析断言通过——双端契约漂移的常驻 防线。**（已实施：`client/tests/fixtures/m83-{block,snapshot}.json` 由真实 server 引擎产出 + `client/tests/m83-kline-contract.test.ts`；夹具首跑即暴露块模板 `render` 对象形态解析缺失，已修复并通过）**

**E2E（批 C 可选，无 LLM 依赖路径）**：`e2e/m83-kline-analysis.spec.ts`——画 布 KlineNode 空态 → 拉取行情 → 「智能分析」→ 面板出现（阶段徽章 + 关键位行）→ 工具条切换副图（data-state 稳定）；与 m34-invest.spec 同模式（真实服务器 + 真实网 关）。**（已实施·路径改编：E2E 环境金融网关未启、真实取数不稳定，改走 mock「K 线走查」内联块路径——覆盖工具条主/副图切换 / 阶段开关 / 分析面板 / 零取数内联渲染；画布节点拉取路径由 client 测试覆盖）**

**门禁序列**：双端 typecheck → server vitest 全量 → client vitest 全量 → `npm run check:agents`（QUALITY_STRICT=1）→ `npm run check:skills` → `npm run eval`（mock 56/56 无回归）→ CHANGELOG 登记。

---

## 8. 实施批次

| 批次 | 范围 | 交付物 | 验收 |
| --- | --- | --- | --- |
| **A 服务端引擎** | shared 契约文件（类型 + 枚举常量；首步双端 typecheck 核实）；analysis/ 六个模块 + index；dsl/ 八个模块 + builtin | 引擎可独立引用；单测 m83-analysis / m83-dsl 全绿 | 阶段 / 关键位 / 情绪确定性输出；表达式求值对照 indicator 口径一致；lint 清单覆盖；无未来函数（ref 负偏移拒绝） |
| **B 工具与路由** | fin_analyze（finance.ts）/ fin_strategy + fin_backtest dsl 通道（finance_quant.ts）；快照与块模板扩展；4 路由；枚举统一引用 shared 常量 | 工具往返 + 路由测试 m83-finance-tools 全绿；块模板 fixture 跨端解析通过；DSL ↔ 模板回测一致性 | Agent 可用工具产出目标截图形态的块；DSL「设计 → 验证」闭环；旧块 / 旧快照兼容 |
| **C 客户端图表层** | chart/ 组件族（theme/overlays/indicators/layout/drawings/KlineChart/KlineAnalysisPanel/entry/phaseColors）；kline-spec + kline-analysis 扩展；KlineCanvas / KlineBlock / KlineNode 升级；样式 | 目标截图效果在消息块与画布节点还原；client 测试全绿 | 指标切换 / 阶段色带 / 划线落图 / 分析面板 / 导出；旧块零改动渲染 |
| **D Agent 资产与收口** | 两席 AGENT.md；skills/strategy-dsl；CHANGELOG v106；ADR 0219 + design.md §124 + 本文件状态行回写 | 门禁全绿（check:agents / check:skills / eval 无回归） | 雷动一条 fin_analyze 出分析图；方程 lint→run→落图闭环 |
| **E-1 划线圈（已完成）** | DrawingToolbar / DrawingStyleBar / useManualDrawings 持久化 / measureBox / fibExtension / pitchfork / volProfile / 自持绘制与智能更新路径（ADR 0221 / design.md §126） | client m85 13 例 + E2E m85 1/1 ✅ | 分组隔离（manual 组不入 knownGroups）・就地覆盖保选中・依次点击 N 点即完成 | A–D |
| **E 收口（全部完成）** | E-1 划线圈已交付（ADR 0221）；E 余项——Monaco 工作室**不立项**（Agent 闭环完整 + 人工手改走对话）・实时盯盘**暂缓**（缺宿主 + 通道未备；重启条件见 ADR 0222） | 决策记录：ADR 0222 ✅ | — | — |

---

## 9. 风险与边界

- **合规红线（继承 M34）**：不接交易通道；分析输出固定声明「规则化统计口径，仅供复盘研究，不构成投资建议」；不预测点位；DSL 不给下单能力；
- **DSL 安全**：禁止 `eval` / `new Function`；白名单函数 + 自研解析器 + 复杂度护栏（长度 / 深度 / 调用数）；数值异常（除零 / NaN / 无穷）按 null 传播且 lint 提示；
- **性能**：逐根回放 O(n×window) 且 n≤500（目标 <50ms）；客户端 drawings ≤60 条、标签避让为纯计算；副图面高度分配沿用既有回归基线防主图挤压；
- **兼容**：块 spec 与快照 schema 只增可选字段；`lib/kline.ts` 删除属破坏性改动——仅影响 KlineCanvas 与两个测试（同批迁移）；chunk 边界保持（klinecharts 只在 chart/ 动态 import 链内）；
- **叠加层坐标一致性**：`analysis`/`drawings` 锚定 bars ts 坐标——凡 bars 更换（周期 / 复权 / 标的切换、节点写回）必须同批失效叠加层（§5.3 已设计）；日期解析统一走 server `parseCnDate`（北京时间零点），客户端只消费数值 ts，杜绝双端口径漂移；
- **shared 契约迁移**：`kline-contract.ts` 为纯类型 + 常量（零运行时依赖），不影响构建；批 A 首步核实 shared `exports` 出口与双端引用（若构建面异常，回退为「类型入 shared、常量以一致性测试镜像锁死」）；
- **编号**：本稿 M83 / ADR 0219 / §124 均为拟编号——批 A 启动前全仓复核占用（M82 联网出口专项在飞）；ADR 与 CHANGELOG 双索引在批 D 对齐；
- **数据源依赖**：min 级 K 线的阶段 / 情绪结论样本偏少，`notes` 自动降级声明；baostock 字段白名单纪律（time 仅分钟线）不触碰。

---

## 10. 验收自测清单（裁剪自文献 §15.5 / §18.3，批 C/D 逐项过）

- [ ] 旧 ```kline 块（无新字段）渲染与交互零变化
- [ ] 主图指标逐个切换无残留、与均线束叠加正常；副图四指标切换即替换
- [ ] 「阶段」开关：色带显隐 + 面板历史阶段条同源一致；震荡段不着色
- [ ] 分析块渲染：阶段徽章 / 置信度条 / 情绪 / 支撑压力 / 特征 chips / 口径声明齐全
- [ ] 划线落图：中枢框 / 止损标签 / 支撑压力线全部落位；同价标签合并、近价错开不重叠
- [ ] 信号触发：positionTool 双区（盈利红 / 风险绿）+ R:R 标签；未触发不落图
- [ ] 消息块「智能分析」按钮：直连拉取、周期切换后结果清空可重取
- [ ] 画布节点「智能分析」：结果写回节点、刷新后仍在
- [ ] 图表在 display:none 容器恢复后仍定位最新（0 宽恢复）
- [ ] 截图导出含 overlay 且白底
- [ ] `fin_analyze` 一条块复制渲染出截图形态；`fin_strategy` lint→run→facts 排查闭环
- [ ] DSL 回测闭环：`fin_backtest template='dsl'` 输出五件套，且 ma-cross ↔ 等价 DSL 结果一致
- [ ] 周期 / 复权切换后：旧 analysis / drawings / signal 整体失效不残留（无错位色带 / 划线）
- [ ] 门禁：双端 typecheck / vitest、check:agents、check:skills、eval 全绿；CHANGELOG v106 登记
