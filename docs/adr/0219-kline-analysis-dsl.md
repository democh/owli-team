# ADR 0219：K 线分析引擎与 DSL 策略引擎（M83）——契约单源 · 规则化分析口径 · 自研安全求值器

- 状态：Accepted
- 引入：M83 K 线分析引擎与 DSL 策略专项（2026-09-25；批 A–D 落地并验收，批 E（划线圈 / Monaco 工作室 / 实时盯盘）待续）
- 相关：[docs/kline-analysis-dsl-design.md](../kline-analysis-dsl-design.md)（专项设计全量）、[docs/finance-invest-design.md](../finance-invest-design.md)（M34 金融网关与 fin_* 工具体系）、[ADR 0218](0218-egress-proxy-tunnel.md)（编号让位先例）、[shared/src/kline-contract.ts](../../shared/src/kline-contract.ts)、[server/src/finance/analysis/](../../server/src/finance/analysis/)、[server/src/finance/dsl/](../../server/src/finance/dsl/)、[client/src/components/finance/chart/](../../client/src/components/finance/chart/)、[server/tests/m83-analysis.test.ts](../../server/tests/m83-analysis.test.ts) + [m83-dsl.test.ts](../../server/tests/m83-dsl.test.ts) + [m83-finance-tools.test.ts](../../server/tests/m83-finance-tools.test.ts)

## 背景

M34 已具备金融数据网关与 fin_* 工具（K 线 / 指标 / 回测 / 博弈），client 已有 klinecharts v10 基础渲染（KlineBlock / KlineNode），但存在三处缺口：

1. **分析空白**：无阶段 / 情绪 / 关键位 / 特征的结构化结论——「走势复盘」只能靠模型目测读图（违反 M34「数字必须出自工具」纪律）；
2. **策略表达空白**：策略只能从 5 个固定模板选（fin_backtest），无法把想法写成可校验、可执行、可回测的规则；
3. **渲染与契约散**：主题 / 落图 / overlay 单文件堆放（lib/kline.ts），指标枚举分散在 server 工具 / 路由 / client 三处人工同步（漂移温床）；后端无「落图」概念，分析结论无法落到图上。

## 决策

1. **契约单源（`shared/src/kline-contract.ts`）**：`Drawing` / `SignalSpec` / `KlinePhase` / `KlineAnalysis` 与主副图枚举（`MAIN_INDICATORS` / `SUB_INDICATORS` / `KLINE_RENDER_INDICATORS`）双端只定义一次——server 工具枚举 / 路由 `RENDER_INDICATORS` / client `kline-spec` 全部 import 同一常量，「三处人工同步」升级为编译器保证。
2. **规则化分析口径（`server/src/finance/analysis/`）**：十阶段优先级短路判定 + 逐根回放两段式平滑（最短段长 ≥3 合并 + **方向性**转移邻接回填——`panic→climax` 禁止、`climax→panic` 允许）；摆动点用**非严格极值（容平）**，平底/平顶由聚类合并为同一触碰位（双底 = 触碰 2 次）；情绪五档多因子加权（0–100）；置信度 = 命中强度加权（**非概率**）；样本 <60 根降档 ×0.7 + notes 声明；**引擎零 LLM 调用**（短文案确定性模板，深度解读留给 Agent 在 facts 之上撰写）。
3. **自研安全求值器（`dsl/expr.ts` + `runtime.ts`）**：禁 `eval` / `new Function`——自研 tokenizer + 递归下降 parser + 向量化求值（常量/序列统一广播）；函数白名单（ma / ema / hhv / llv / ref / cross_up / cross_down / atr / rsi / dif / dea / hist / bb_up / bb_mid / bb_low / vol_ma / abs / max / min / if）；**反未来函数三层拦截**：`ref(x, n)` 仅 n ≥ 0，负偏移在 lint（字面量）/ parser / 运行时（经 inputs 注入）全部拒绝（`FUTURE_REF`）；null 语义固化（除零 → null；比较与逻辑遇 null 判 false）；护栏：源 ≤20KB / 表达式 ≤400 字符 / AST 深度 ≤24 / 策略调用数 ≤64 / `dsl: 1` 版本字段。
4. **DSL 与回测同一把尺**：边沿触发（false→true 首根 = 第 i 根收盘信号）；`generateDslSignals` 为共享信号层——`fin_strategy`（run / 落图）与 `fin_backtest template='dsl'` 复用同一实现与执行模型（i+1 根开盘成交 / 费用滑点 / 指标五件套），DSL 与 5 个模板策略口径唯一；以「模板 ma-cross ↔ 等价 DSL」一致性测试锁定（工具层往返测试断言总收益 / 交易数 / 回撤逐字一致）。
5. **工具面单一职责**：`fin_kline` 保持纯数据通道（**不加** analyze 开关）；分析归 `fin_analyze`（全量输出，无子集参数）、策略设计归 `fin_strategy`（lint / run）、回测归 `fin_backtest`（+dsl 通道）——减少模型「哪个入口带分析」的选择负担与双份校验维护。
6. **增强字段降级策略（客户端）**：主契约（bars / indicators / mainIndicator / subIndicator）非法 → 显式报错（模型自纠通道）；增强字段（drawings / signal / analysis / showPhases）非法 → **降级**（丢单条 / 丢字段 + `warnings[]`），主图照常渲染——增强数据脏不应让图挂掉；块与快照 schema 只增可选字段（旧块 / 旧快照零改动）。
7. **叠加层坐标一致性**：bars 更换（块内周期 / 复权 / 标的切换、画布节点写回）→ analysis / drawings / signal **整体强制失效**（防色带与划线按旧 ts 错位）；日期解析统一走 server `parseCnDate`（北京时间零点），客户端只消费数值 ts（零日期解析，杜绝双端口径漂移）。
8. **客户端图表组件族（`components/finance/chart/`）**：单文件 `lib/kline.ts` 删除，按职责拆分 theme / overlays（labeledLine / rectZone / textLabel / phaseBand / positionTool / polyline）/ indicators（KCB / ST / DONCHIAN / ICHIMOKU + ATR）/ layout（副图面高度分配——既有修复与断言保留）/ drawings（kind 映射 + 先清后画）/ entry（唯一动态 import 入口，chunk 边界）；KlineCanvas 升级为带工具条的宿主（主图 8 项 + 副图 + 阶段开关 + 截图导出；窄容器 <560px 主图收为下拉）。
9. **Agent 接入（最小授权）**：`fin_analyze` 仅入 analyst-ta（雷动）、`fin_strategy` + 新技能 `strategy-dsl` 仅入 quant（方程）——「分析引擎归技术面、DSL 归量化」；两席 SOP 写入 lint → run → facts 排查 → `template=dsl` 回测闭环与「规则口径」标注纪律；invest-lead 不扩权。

## 理由

- **口径唯一优于就近实现**：三处枚举同步（M34 遗留）与「DSL / 模板两套回测」都会在演进中漂移——单源契约 + 共享信号层把一致性交给编译器与单一实现；
- **可信度需要硬约束**：禁未来函数（三层拦截）、确定性输出（同 bars 同结果）、统计口径声明（notes 固定行），是「有据可依」的底线；
- **兼容优先**：只增可选字段 + 降级策略，使旧 ```kline 块、旧快照、既有 E2E 全部零改动（回归面收敛在新增模块）；
- **性能与规模意识**：全序列指标一次 O(n) 预计算（逐根判定查表）、表达式护栏（长度 / 深度 / 调用数）防病态输入；
- **边界克制**：划线圈（工具栏 / 属性条 / 持久化）、Monaco 工作室、实时盯盘（subscribeBar 增量）明确留批 E；统计显著性检验（scipy / statsmodels）归属 M84 多空对决专项。

## 被否决的方案

- **`eval` / `new Function` 求值**：注入面与不可控副作用，无法做静态 lint；
- **Drawing 类型放 server + client 镜像**：漂移温床（本次核心教训）；
- **`fin_kline` 加 analyze 开关**：双入口模糊职责、模型选择负担与双份校验；
- **增强字段显式报错**：脏 drawings 拖垮整张图，体验最差；
- **分析引擎调用 LLM 生成文案**：破坏确定性（同 bars 同结果）与成本模型；
- **客户端解析日期（'YYYY-MM-DD' → ts）**：与 server 北京零点口径漂移风险（划线错位一整根的经典来源）。

## 后续

批 E：划线圈（DrawingToolbar / DrawingStyleBar / useManualDrawings 持久化）、Monaco 策略工作室（`GET /api/finance/strategy/meta` 已就绪）、实时盯盘增量、更多 overlay（fibExtension / volProfile / pitchfork / measureBox）；M84：多空对决场景（消费本批工具链 + 统计举证层 Python 扩展）。
