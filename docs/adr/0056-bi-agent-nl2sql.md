# ADR 0056：BI 场景与 NL2SQL 取数管道（BI Agent & NL2SQL Pipeline）

- 状态：Accepted
- 引入：M30
- 相关：[design.md §46](../design.md)、ADR 2（handoff 工具优先）、design.md §21（工具系统与 Harness）、ADR 14（工作区沙箱）、ADR 23（HITL 审批）、ADR 31（场景协议分层）、ADR 38（业务工具集）、ADR 42（连接中心与 SQL 护栏）、ADR 44（数据库工作台）、ADR 45（外部技能适配）、ADR 54（工具按需发现）

## 背景

- M22 / M23 已建成数据库连接能力（连接中心 / `db_*` 工具 / 只读护栏 / 审批门 / 30 行展示截断），但**数据侧取数没有专职角色**：insight（经营分析师）做业务解读与指标体系设计，白名单无 `db_*`；finance 管财务口径与测算，不直连库；data-engineer 管数据管道与建模。用户提出「专业 BI 领域 Agent，结合文件与当前数据库连接能力实现 NL2SQL」。
- 三类缺口：
  1. **角色缺位**：无 BI 场景与取数角色——NL2SQL（自然语言转 SQL）无明确负责人，「问题 → 口径 → SQL → 结果」的链路没有资产承载；
  2. **发现路径缺失**：`db_*` 工具为 `tier='deferred'`（ADR 54），角色白名单授权后模型初始不可见——若方法论文档不引导 `tool_search` 激活，会出现「授权了但不知道能激活」的能力空转；
  3. **取数方法论缺失**：口径五要素、SQL 生成规范、执行校验清单、脱敏与可复现要求散落无归处，协议层与技能层均无对应资产。
- 硬约束：
  1. **零新增工具代码**：只做「已建成能力的角色绑定 + 方法论文档」，不改 `db_*` 实现与引擎；
  2. **只读边界**：BI 面向分析性读取，写操作（建表 / 导数 / 结构变更）不在职责内；
  3. **延迟披露兼容**：`db_*` 保持 `deferred`，经 `tool_search` 激活后本 Run 可用（ADR 54 语义不变）；
  4. **零回归**：mock / eval 不依赖新增可见性；改后 `check:agents` / `check:skills` / `eval` / vitest 全绿。

## 决策

1. **新增 bi 场景**（单角色编制，同 wealth / travel 先例）：id `bi` / 商业智能 / icon `database` / theme `#ec4899`（pink，第 16 个场景色）/ order 65（finance 与 ops 之间）/ chain `[bi]`。
2. **BI 分析师（沈析）工具白名单**：文件集（`list_dir` / `read_file` / `write_file` / `edit_file` / `apply_patch` / `search_text` / `glob` / `grep`）+ **数据库只读三件套**（`db_list_connections` / `db_schema` / `db_query`，不含 `db_execute`）+ 业务工具（`csv_analyze` / `calc` / `date_calc`）+ 协作基线（`write_todos` / `load_skill` / `remember` / `handoff` / `request_approval`）；handoff `[insight, finance, data-engineer]`。
3. **NL2SQL 六步法**（技能层承载）：口径澄清（五要素）→ 库表探索（连接 → schema → 小样本）→ SQL 生成（显式列 / JOIN 验键 / 时区 / LIMIT）→ 执行校验（行数 / 交叉 / NULL / 去重 / 单位 / 边界）→ 解读呈现（结论先行 + chart）→ 口径沉淀（SQL 原文入附录 + `remember` 固化）；数字可追溯三要素（SQL + 口径 + 连接）缺一不写进结论。
4. **场景协议 `agents/bi/_protocol.md`**（取数纪律六条铁律）：① 口径先行（不明确时确认或标注假设）；② 只读取数（无 `db_execute`，写操作交 data-engineer）；③ SQL 纪律（单语句 / 显式列 / LIMIT / 时间显式）；④ 结果校验（sanity check + 库侧文件侧交叉对账）；⑤ 数据安全（明细脱敏 + 样本量 < 5 不做个体结论）；⑥ 可复现（SQL 原文与执行信息入附录）。
5. **技能层**：新增 `skills/nl2sql`（六步法 + SQL 规范 + 校验清单 + 陷阱表 + 工具衔接引导）；bi 预载三技能（`nl2sql` / `data-visualization` / `spreadsheet-modeling`）；技能库 39 → 40。
6. **三处 `tool_search` 引导**：AGENT.md 工作方式、场景协议第 9 条、nl2sql 技能「工具衔接」节均显式写明「先 `tool_search` 检索『数据库 / SQL / schema』激活再使用」；`<tool_discovery>` 区块「数据库」分组概览提供发现面兜底。
7. **数据安全上收协议**：明细脱敏（客户名 → 客户 A / 订单号 → \*\*\*1234）、未脱敏明细不落盘、小样本抑制为场景级铁律；交付件结尾附数据说明（来源连接 / 表 / 时间窗 / 样本量）。
8. **预设与测试**：快速组队预设 +1（`data-briefing`：bi 取数 → insight 解读 → finance 核口径）；新增 `server/tests/m30-bi-nl2sql.test.ts`（12 断言）；`m21.test.ts` 适配 16 场景 / 67 角色 / 11 预设。

## 理由

- **接通优于新建**（与 M29 同模式）：M22 / M23 已建成连接中心与 `db_*` 工具链，缺的只是「角色绑定 + 方法论文档」——新增成本集中在资产层，无工具代码与引擎改动；
- **只读边界与 qa 先例一致**：BI 做分析性读取，写库需「连接允许写入 + 会话绑定 + 审批」三重护栏，属数据工程职责；只读三件套已覆盖 NL2SQL 全部取数动作（`SELECT` / `WITH` / `SHOW` / `EXPLAIN`）；
- **方法论文档三处引导**：`deferred` 工具的核心风险是「授权了但不知道能激活」——LLM 需在角色正文、场景协议、技能正文多个语境反复看到激活路径才能形成稳定行为（M29「存在但不可达」经验的镜像问题）；
- **场景=职能域**：BI 是跨场景数据职能（可服务 marketing / sales / finance），独立场景比并入 strategy 更符合组织语义，且与 finance / ops 等职能场景同构；
- **单角色场景先例**：职责聚焦（取数管道），无需编制链；后续若需要「数据可视化专家」「指标治理专家」可在 bi 场景内扩张。

## 被否决的方案

- **BI 授予 `db_execute` 全量能力**：写类操作违背「分析读取」职责边界；需三重护栏支撑的场景（导数 / 建视图）应交 data-engineer；与 qa 只读三件套先例保持一致的最小授权；
- **新建 NL2SQL 专用工具**（如 `nl2sql_query` 直接接受自然语言并内部调用 LLM）：工具层做 NL2SQL 需要内置模型调用（工具应保持无 LLM 的确定性语义），且重复 LLM 调用带来成本与不可观测性；`db_query` + 方法论文档组合已覆盖；
- **把 NL2SQL 提示词硬编码进引擎**：违反资产化原则（agents/ 与 skills/ 是热更新资产，改行为无需改代码重启）；M15 以来的资产包体系即为此设计；
- **把 BI 作为 strategy 场景的第 5 个角色**：BI 的数据职能跨场景（marketing / sales / finance / ops 都可能是需求方），锁进 strategy 编制链会误导默认组队；独立场景让「按需邀请」语义更清晰；
- **引入 SQL 方言转换层 / ORM 抽象**：`db.ts` 已按连接类型注入方言提示与护栏；额外抽象违反零新增依赖，且 BI 场景的方言差异（时间函数 / LIMIT 语法）用技能文档提示已足够；
- **三件套改 `core`（常驻可见）**：违背 ADR 54 的渐进披露设计——BI 会话中相当比例的任务只做文件侧分析，`db_*` 常驻会让每轮工具 schema 白付 token；`tool_search` 激活一次即本 Run 可用，成本更低；
- **预载全部四个预载位**（含 `code-review` 式全量方法论）：三预载已是系统层可观开销（nl2sql ~1.5k token）；取数、呈现、文件侧三件覆盖主路径，其余按需 `load_skill`。

## 适用与失效条件

- 适用：本地单用户部署（与 ADR 42 / 44 / 53 / 54 同一产品形态）；已绑定数据库连接的会话（未绑定时应收到「右侧面板「连接」页签绑定」提示而非报错）；分析性只读取数场景。
- 失效条件：
  - 引入多用户 / 多租户共享实例时，交付件脱敏与样本量抑制需升级为用户 / 租户级列权限模型；
  - 若未来向 BI 开放 `db_execute`（如物化视图 / 结果集落库），须重新评估审批与授权模型，并回改本 ADR 与场景协议第 2 条；
  - 技能库继续扩容至系统层预算阈值时，bi 三预载应回归按需加载并重新评估索引摘要长度（对齐 ADR 55 失效条件）；
  - 若模型在 `tool_search` 缺失语境下频繁漏激活 `db_*`，应增强 `<tool_discovery>` 区块的数据库分组提示，而非把工具改回常驻。
