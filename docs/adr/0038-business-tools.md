# ADR 0038：业务工具集——calc / date_calc / csv_analyze / template_fill（零新增依赖）

- 状态：Accepted
- 引入：M21
- 相关：[design.md §32](../design.md)、ADR 14（工作区沙箱）、ADR 23（HITL 审批）、ADR 37（OPC 业务场景编制）

## 背景

业务角色（经营 / 增长 / 销售 / 财务 / 法务 / 运营 / 融资）的产出依赖确定性计算：毛利率、CAGR、IRR、贷款月供、盈亏平衡点；日期与排期（含工作日）；CSV / TSV 表格的汇总与筛选；模板化文档（合同 / 报价 / 邮件）的批量渲染。让模型心算或目测汇总属于结构性不可靠；引入 `mathjs` / `d3-dsv` 等库违背「零新增 npm 依赖 + 包体门槛」硬约束。

## 决策

**自实现 4 个业务工具并注册进 `createToolRegistry`，全部复用既有沙箱与安全边界**：

- `calc`（readOnly）：`{ expression }` —— 自写 tokenizer + Pratt parser（纯函数、可单测），四则 / 乘方 / 括号 + 函数表 20+（round / min / max / sum / avg、pct_change、gross_margin、markup、discount、cagr、compound、loan_payment、npv、irr（二分法）、roi、roas、cac、ltv、breakeven、net_after_tax）；**禁止 eval / new Function**；错误信息中文化；detail 分步展示求值过程，便于复核；
- `date_calc`（readOnly）：`{ base?, op: add|diff|list|period, amount?, unit?, to?, interval?, count?, skip_weekends? }` —— add（day / week / month / year / business-day）、diff（自然日 + 工作日）、list（生成 N 个排期日，可跳周末）、period（所在周 / 月 / 季 / 年的起止，财务口径）；输出 ISO + 中文 + 星期；
- `csv_analyze`（readOnly）：`{ path, op: head|describe|groupby|sort|filter, column?, by?, agg?, where?, order?, limit?, columns? }` —— 自写 RFC4180 子集解析（引号 / CRLF，`.csv` / `.tsv` 嗅探）；describe 输出列类型 / 空值 / 唯一值 / 数值统计；filter 语法 `列 操作符 值`（`= != > >= < <= ~` 包含）；复用 `resolveInRoot` 沙箱 + `sensitiveRejection` + 5MB 体积上限；detail 返回 Markdown 表格（≤ 50 行）；
- `template_fill`（写类）：`{ template, data, output, dry_run? }` —— 读工作区模板（`{{dot.path}}` 占位）→ 渲染 → 原子写；缺失变量汇总为错误清单（不静默跳过）；dry_run 返回渲染预览（截断 2KB）不落盘；成功后标记 artifacts（进交付件面板与版本链）。

## 理由

- **Pratt parser 而非正则求值**：表达式语法（优先级 / 结合性 / 函数调用）用 Pratt 解析 180 行左右纯函数即可覆盖，可单测、可给分步 detail，且天然拒绝任意代码执行路径；`eval` / `new Function` 是注入与沙箱逃逸面，直接禁用；
- **IRR 用二分法**：无解析解，二分在 [-0.99, 10] 区间内对现金流符号变化不敏感、迭代收敛稳定，且实现无依赖；
- **CSV 自写 RFC4180 子集**：业务表格的实际复杂度（引号转义 / CRLF / 制表符）远低于完整 RFC，子集解析 ~120 行可控，错误可中文化；
- **template_fill 原子写 + 缺变量报错**：批量文档最危险的是「静默漏填」，缺失变量必须汇总报错；写类走既有审批与敏感文件名拒绝，行为与 write_file 一致；
- **全部纯函数 + 沙箱**：4 个工具无网络、无进程、无新依赖，readOnly 三件套可进只读并行组，评测与单测全离线可跑。

## 被否决的方案

- **mathjs**：新增依赖（体积与评审成本），函数表实际使用面不到其 1%，且表达式中文化错误需二次包装；
- **`new Function` / `eval` 求值**：任意代码执行与沙箱逃逸风险，直接违背安全边界；
- **d3-dsv / papaparse**：为几百行可自写的解析引入依赖；
- **调用外部计算 / 表格服务**：离线（LLM_MOCK）与内网部署场景不可用；
- **在模型侧用提示词约束心算**：没有确定性回执（detail 分步），无法审计，错误不可复现。
