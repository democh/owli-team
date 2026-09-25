---
name: quant-evidence
description: 量化证据与统计检验：描述统计 / 相关性 / 条件显著性（t 检验 · bootstrap CI）的方法与口径纪律，含证据行铸造规范
tags: [invest, quant]
---

# 量化证据与统计检验

## 数据底座

- 统计主入口 `fin_stats`：`analysis=summary`（1–5 标的描述统计 + Pearson/Spearman 相关 + ADF 平稳性）/ `analysis=significance`（事件后前向收益的显著性检验）。
- 事件检测器（significance 的事件来源）：`ma_cross_up` / `ma_cross_down`（fast/slow）、`drop_pct` / `rise_pct`（window/pct）、`volume_spike`（ratio/window）、`touch_level`（price/tolerancePct）。
- 结构证据 `fin_analyze`（阶段 / 关键位 / 落图 kline 块）；规则证据 `fin_strategy` → `fin_backtest template=dsl`（同口径回测）。
- 执行口径：事件在第 i 根收盘成立（bar 高开区间覆盖等按严格定义）；前向收益 = 第 i+h 根收盘 / 第 i 根收盘 − 1；bootstrap 为均值百分位法 95% CI（固定 seed 可复现）。

## 统计口径纪律

1. **样本门槛**：n≥30 才给结论性表述；n<30 标注「仅供参考」并说明放宽路径（扩大 limit / 放宽事件阈值）。
2. **多重检验**：多窗口（horizons）判定一律看 Bonferroni 校正后 α′（= α / 窗口数）；汇报时同时给出显著与不显著的窗口。
3. **基准对照**：事件收益必须与「全样本同窗口前向收益」基准对照（excess 列）；只报绝对收益不报超额视为口径不完整。
4. **显著性表述模板**：`p=0.03（n=45，CI[1.2%, 4.8%]，Bonferroni α′=0.01）`——p / n / CI / 校正四要素缺一不可。
5. **不硬造**：Python 统计扩展缺失（scipy/statsmodels）时 significance 会明确报错——按引导 `fin_env action=install group=analytics` 安装，禁止用近似值冒充。

## 典型工作流

- ① 支撑位有效性：`fin_stats significance` + `touch_level`（price=支撑位）→ 看反弹窗口（h=1/3/5）胜率与 CI 是否显著为正。
- ② 金叉显著性：`ma_cross_up`（fast/slow 按主辩口径）→ 多窗口收益分布与基准对照。
- ③ 多标的相对强弱：`analysis=summary`（symbols=A,B）→ Pearson/Spearman 相关 + 区间涨跌/波动对比（relative 对决举证）。
- ④ 放量含义：`volume_spike`（ratio=2）→ 后续波动是否放大（均值 / 波动对比）。

## 输出解读（significance 表列含义）

- `样本`：有效事件数（后向窗口不足的事件自动剔除）；`均值 / 中位`：事件后 h 根收益分布的中心——受极值影响时以中位为准。
- `胜率`：正收益比例；`盈亏比`：总盈利 / 总亏损（<1.2 时胜率需更高才可采信）。
- `p 值`：相对「均值为 0」的单样本 t 检验（越小越难用随机波动解释）；`95% CI`：bootstrap 均值区间——**区间不含 0** 是显著性最可信的形态。
- `判定`：按 Bonferroni 校正后阈值给出「显著 / 不显著」；`vs 基准`：相对全样本同窗口均值的超额（>0 表示事件含正向信息量）。
- summary 表：`当前分位` = 当前收盘在样本内位置（低分位 + 缩量常伴吸筹语境）；`偏度 / 峰度` 描述收益分布尾部形态（尖峰厚尾意味着极端行情概率高于正态假设）。

## 降级矩阵（先说清楚再引用）

- `summary`：统计扩展缺失时降级 Node 基础统计（区间涨跌 / 年化收益波动 / 最大回撤 / Pearson）；缺偏度峰度 / 分位 / 直方图 / Spearman / ADF（正文会注明），引用时必须带上「基础统计」限定词。
- `significance`：无降级——缺 scipy 直接报错并引导 `fin_env action=install group=analytics`；禁止用近似值冒充显著性。

## 与主张卡配合（证据行写法）

- 统计证据行：`- 论据 | fin_stats significance p=0.03 n=45 CI[1.2%, 4.8%]`（工具名 + 参数 + 四要素）。
- 图表证据行：`- 论据 | fin_analyze day 250 根 阶段=吸筹（置信度 62）`。
- 回测证据行：`- 论据 | fin_backtest template=dsl 总收益 +12.3% 回撤 −8.1% 夏普 1.2`。
- 证据行必须可复算：同工具 + 同参数 + 同窗口能复现同一数字。

## 反模式（出现即回炉）

- 小样本当结论（n<30 却下断言）；
- 只报显著窗口不报不显著（挑选汇报 / p-hacking）；
- 把相关性当因果（横截面同涨同跌不构成方向依据）；
- 用「统计显著」包装未经检验的结论（无 p / 无 n / 无 CI 的「显著」）；
- 改口径迁就结论（先换窗口再选样本）；
- 缺包时用估算值代替工具（数字必须出自 `fin_*`）。

## 合规红线

- 输出固定标注「规则化统计结果，不构成投资建议」；不预测点位、不给买卖指令、不承诺收益。
- 置信度用「高 / 中 / 低」表达；显著性含义解释为「历史上该事件后收益偏离随机基准的程度」，不说成「未来涨跌概率」。
