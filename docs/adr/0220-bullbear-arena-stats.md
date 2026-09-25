# ADR 0220：多空对决场景与统计举证引擎（M84）——专职对抗赛场 · 桥专属统计 · 镜像面四件套

- 状态：Accepted
- 引入：M84 多空对决专项（2026-09-25；H1–H3 与 H4 的 E2E 落地并验收；两处纯前端微增强与 5 角色头像为观察项/可选资产延后）
- 相关：[docs/bullbear-arena-design.md](../bullbear-arena-design.md)（专项设计全量）、[ADR 0219](0219-kline-analysis-dsl.md)（M83 K 线分析 / DSL——本场景证据链底座）、[ADR 0218](0218-egress-proxy-tunnel.md)（让位先例）、[agents/bullbear/](../../agents/bullbear/)、[server/src/finance/stats.ts](../../server/src/finance/stats.ts)、[server/src/finance/bridge/py/fin_bridge.py](../../server/src/finance/bridge/py/fin_bridge.py)（stats / significance）、[server/src/tools/finance_quant.ts](../../server/src/tools/finance_quant.ts)（fin_stats）、[server/tests/m84-stats.test.ts](../../server/tests/m84-stats.test.ts) + [e2e/m84-bullbear.spec.ts](../../e2e/m84-bullbear.spec.ts)

## 背景

- invest 场景已有轻量「多空对弈」（议题之一），但缺少**专职对抗赛场**：固定双阵营编制、强制交叉质证、统计显著性举证上桌、独立裁决文书；
- M83 已交付 K 线分析（阶段 / 关键位 / 落图）与 DSL 策略（lint → run → 同口径回测），但缺「条件是否显著」的统计维度——「有理有据」的证据链缺最后一环；
- Python 桥现有 9 任务均为数据获取类，无统计任务；本机与目标环境缺 `scipy` / `statsmodels`；
- 项目纪律（v14/v15）：新增角色必须补齐 mock 镜像面四件套（SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf + e2e AGENT_NAME），否则 E2E/eval 台词错位。

## 决策

1. **场景与编制**：新增 `bullbear`（多空对决场）——arena 布局（`seats` 左多右空 + 中央裁决）、`rounds: true` 严格轮转、5 角色（judge 顾鉴 / bull-lead 向阳 / bear-lead 知寒 / bull-quant 陆准 / bear-quant 程实）；协议 17 条（五拍回合 / 证据纪律 / 容器约定 / 立场互换 / 合规红线）；预设 `bullbear-pk`。与 invest「多空对弈」的边界：专职赛场 + 统计上桌 + 独立裁决书；invest 协议加一行引导移交。
2. **统计桥任务为纯计算**（延续 M34 约定）：`stats`（series 由 Node 侧传入；numpy+pandas 必需、statsmodels 可缺省并降级注明）与 `significance`（bars/events 由 Node 侧传入；scipy 必需）；零网络、bootstrap 固定 seed 42（可复现）。
3. **网关 `pyStats` 通道**：`absent` 直接抛 GatewayError（不提供 Node 近似值）；缺包由 `BridgeError DEP_MISSING` 透出——工具层转中文安装引导（`fin_env action=install group=analytics`）。
4. **`fin_stats` 双模式降级矩阵**：`summary` 在统计扩展缺失时降级 Node 基础统计（区间涨跌 / 年化收益波动 / 最大回撤 / Pearson；缺偏度峰度 / 分位 / Spearman / ADF，正文注明）；`significance` **无降级**（缺 scipy 明确报错——统计能力不允许降级为猜测）。
5. **事件检测器在 Node 侧**（6 类：ma_cross_up / ma_cross_down / drop_pct / rise_pct / volume_spike / touch_level；复用 `indicator.ts` 的 sma 口径），significance 的事件来源由此注入桥任务。
6. **probe / fin_env 扩展**：`ANALYTICS_PY_PACKAGES = [numpy, scipy, statsmodels]` 入 OPTIONAL（不参与 ready/partial/absent 分档）；`fin_env action=install` 增 `group: base（默认，兼容现状）/ analytics / all`；探测 summary 增「统计扩展」状态行。
7. **镜像面四件套全量补齐**（v14/v15 纪律）：5 角色 SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf + `e2e/helpers.ts AGENT_NAME`；各角色落盘路径与 AGENT.md 交付契约逐字对齐（`docs/多空对决|多方论证|空方论证|多方证据|空方证据-<主题>.md`）。
8. **E2E 经「对决走查」mock 触发块**（claim ×2 + ruling + verdict + kpi 四容器确定性输出）；**eval 沿用零新增口径**（mock 走查 + E2E 承接；设计稿明示的替代路径）。

## 理由

- **专职赛场优于议题内轻量对弈**：固定编制（主辩 + 证据官）使「立论—举证—质证」职责分离，统计举证可被裁决长核验；与 invest 研究场景互不侵入（一行引导移交）；
- **统计能力必须「零妥协」**：显著性检验（t / bootstrap / ADF）不做 Node 近似，缺包即报错并给出安装引导——「硬造显著性」比没有结论更危险；
- **纯计算桥任务**：数据由 Node 侧传入复用网关缓存，桥无网络耦合，任务可离线测试（真脚本冒烟按环境能力守卫）；
- **镜像面先于功能验证**：四件套补齐确保 E2E / eval 在 mock 模式下与真实资产零漂移（历史两类缺陷：台词错位 / 转交显示 id）。

## 被否决的方案

- **把统计做进 M83 批 E**：不相干的两条能力线（画布交互 vs 统计举证），耦合会拖慢两者；
- **significance 做 Node 兜底**：无法合法计算 t 分布 p 值 / bootstrap 之外的推断，会用「近似值冒充显著性」；
- **新增独立「统计官」角色**：与两证据官职责重叠（同质化先例 v99 的教训）；
- **把 scipy / statsmodels 并入 REQUIRED 核心包**：会改变现网 ready/partial/absent 分档语义并迫使全量金融能力依赖重型包；
- **eval 新增任务**：mock 走查 + E2E 已确定性承接四容器输出（零新增口径在设计中已预留）。

## 后续

- 观察项（设计稿「实现期核实必要性」）：证据徽标统计变体、立场互换轮次标记——待使用反馈后定；
- 可选资产：5 角色头像（512×512，不拦截门禁）；
- M83 批 E（划线圈 / Monaco 工作室 / 实时盯盘）另行推进；M84 场景可消费 `fin_strategy` / `fin_backtest(dsl)` 做策略级对弈证据。
