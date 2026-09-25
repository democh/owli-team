---
name: strategy-dsl
description: 策略 DSL 设计：YAML 语法全字段、表达式白名单函数、lint → run → 回测工作流与常见错误修正
tags: [invest, quant]
---

# 策略 DSL 设计

## 数据底座与工具

- 策略入口 `fin_strategy`：`action=lint` 静态检查（语法 / 变量 / 函数 / inputs / 落图字段；免取数，可反复调用）→ `action=run` 执行（signal + drawings + facts）。
- 回测验证 `fin_backtest template=dsl`：信号口径与 `fin_strategy` 完全一致（同一共享信号层），DSL 与模板策略在同一把尺下对比；`dsl_inputs` 传参数覆盖。
- 结构配合 `fin_analyze`：阶段 / 关键位 / 情绪（规则化统计口径）——策略条件可引用关键位的人类判读，但数值必须来自工具。
- 执行模型：第 i 根收盘条件为真（false→true 边沿触发首根）产生信号；回测按第 i+1 根开盘成交（避免未来函数）。

## DSL 全字段语法

```yaml
dsl: 1                          # 可选，缺省 1（未知版本拒绝）
name: 均线回踩企稳               # 必填（≤60 字）
description: 一句话口径          # 可选
timeframes: [1d]                # 可选（1d / 1w / 1m / 60m / 30m / 15m / 5m）
inputs:                         # 可选；参数声明（number / string / bool，≤20 个）
  fast: 20
  slow: 60
signals:                        # 必填（1–10 条）
  - when: "cross_up(ma(close, inputs.fast), ma(close, inputs.slow))"
    emit:
      direction: long           # long / short / neutral
      confidence: 0.6           # 0–1（缺省 0.5）
      horizon: swing            # intraday / short / swing / long
      rationale_hint: 均线金叉   # 触发说明（≤120 字）
      entry: "close"            # 入场表达式
      stop_loss: "close - 2 * atr(14)"
      take_profit: ["close + 3 * atr(14)"]   # 目标（≤6 个）
drawings:                       # 可选（≤30 条；落图随 kline 块渲染）
  - kind: hline                 # hline/vline/zone/rect/textLabel/position/segment/…
    at: "low"                   # hline / textLabel 的价格表达式
    x: -1                       # 锚点：bar 索引（负 = 倒数）或 yyyy-MM-dd
    label: 当日最低
llm:                            # 可选（报告/解读提示）
  system_hint: ""
  fields: []
```

## 表达式白名单（只用这些；禁自造）

| 类别 | 函数 | 说明 |
| --- | --- | --- |
| 序列变量 | `open` `high` `low` `close` `volume` `turnover` | K 线原生字段 |
| 均线 | `ma(x, n)` `ema(x, n)` | 前 n-1 期无值（null） |
| 极值 | `hhv(x, n)` `llv(x, n)` | 滚动窗口最高 / 最低 |
| 平移 | `ref(x, n)` | 前 n 根取值；**n ≥ 0，负偏移直接拒绝（反未来函数）** |
| 交叉 | `cross_up(a, b)` `cross_down(a, b)` | 前根未穿、当根穿越（布尔序列） |
| 波动 | `atr(n)` `rsi(n)` | Wilder 口径（与 fin_indicator 数值一致） |
| MACD | `dif(f, s)` `dea(f, s, sig)` `hist(f, s, sig)` | DIF / DEA / 柱 |
| 布林 | `bb_up(n, m)` `bb_mid(n)` `bb_low(n, m)` | 轨道线 |
| 量能 | `vol_ma(n)` | 成交量均线 |
| 逐点 | `abs(x)` `max(a,b)` `min(a,b)` `if(cond,a,b)` | 元素级运算 |
| 语法 | `+ - * / %`、`< <= > >= == !=`、`and or not`、`cond ? a : b` | 除零 → null；比较遇 null 判 false |

## 工作流（设计 → 验证闭环）

1. **规格先行**：把想法写成规格表（信号 / 频率 / 持仓周期 / 风控），再落 DSL。
2. **lint**：`fin_strategy action=lint`——修正全部 error（warning 按需处理）后再往下走。
3. **run**：`fin_strategy action=run`；触发 → signal（入场 / 止损 / 目标 / R:R）+ drawings 随 kline 块落图；**未触发 → 按 facts.signals 排查**：哪条 when 为假、last_when 末值、triggers 历史是否触发过。
4. **回测**：`fin_backtest template=dsl` + `dsl_inputs` 覆盖参数——五件套指标 + 净值曲线 + 成交明细；参数做邻域扫描。
5. **交付**：策略规格表 + DSL 源码 + 回测口径与结果 + 失效条件；不承诺收益、不给下单指令。

## 常见错误与修正

| 症状 | 原因 | 修正 |
| --- | --- | --- |
| `未知变量「closes」` | 变量名不在白名单 | 用 `close`；自定义参数写 `inputs.xxx` 并在 inputs 段声明 |
| `inputs 未声明参数` | 用了未声明的 inputs | 在 `inputs:` 段补声明（或换用已声明键） |
| `表达式嵌套超过 24 层` | 多层函数叠加 | 拆成多条 when / 用中间 inputs 近似 |
| `ref 负偏移`（FUTURE_REF） | 想引用未来数据 | 禁止；改用回看表达（如 `ref(hhv(high, 60), 1)`） |
| `参数需为常量` | 周期位传了序列 | 周期用数字或 `inputs.x`；不能传 `close` 之类序列 |
| run 未触发 | 条件太严 / 方向反 / 锚点过期 | 看 facts：放宽阈值、检查 cross 方向、换更近区间 |
| lint warning：take_profit 为空 | 未给目标位 | 补 `take_profit` 表达式（如 `close + 3 * atr(14)`） |

## 纪律

- **禁止未来函数**：所有表达式严格回看；`ref` 负偏移被引擎拒绝。
- **禁止目测替代**：条件阈值（如放量倍数）取整数区间起点，来源与口径写进 description。
- **一策略一主张**：signals 数量克制（1–3 条为佳），参数扫描在回测阶段做。
- **事实与结果分离**：facts 是排查工具不是结论；回测结果只讲已验证的部分（失败如实报告）。
- 输出固定标注「规则化统计结果，不构成投资建议」；不下单、不承诺收益。
