# ADR 52：SQL 护栏加固与 query 只读纵深（诊断修复批）

- 状态：Accepted
- 引入：M22 / M23（诊断修复批）
- 相关：[design.md §35](../design.md)、[design.md §36](../design.md)、ADR 42（连接中心与 CDP 浏览器接入）、ADR 44（数据库工作台与 SSH 交互终端）

## 背景

- 数据库诊断发现三类护栏绕过（`guard.ts` 纯函数对 SQL 文本做保守拒绝）：
  1. **大小写敏感**：`DANGEROUS_RE` 无 `i` 标志——`with x as (select 1) delete from users`（WITH 前置写语句 / data-modifying CTE）与 `select * into new_users ...` 的小写形式全部漏过骨架检测；
  2. **PRAGMA 判定不全**：赋值检查 `/^PRAGMA\b[\s\S]*=/` 同为大小写敏感，且 `PRAGMA journal_mode(wal)` 括号赋值形式（SQLite 合法 setter 语法）完全未被覆盖——`PRAGMA writable_schema=1` 可写坏 sqlite_master；
  3. **MySQL 可执行注释**：`/*!40000 ... */`（MySQL）/ `/*M! ... */`（MariaDB）的内容会被服务器真实执行，但 `scan()` 将其当普通块注释剥离——`SELECT 1 /*!40000 INTO OUTFILE '/tmp/x' */` 可通过只读护栏（INTO / OUTFILE 被隐藏）。
- 可达性条件放大影响：`db_query` 标记 readOnly（不进审批门），其安全完全依赖护栏；`manager.exec(mode='query')` 把 `readOnly = cfgBool('readOnly', true) && !cfgBool('allowWrites', false)` 传给连接器——**「允许写入」连接上 readOnly=false，PG / MySQL 不开只读事务**，护栏被绕即真实执行写（绕过 `db_execute` 的审批门）。
- 同批可达性诊断：`db_*` / `ssh_exec` 在 34 个角色中零绑定（原子化白名单语义下新增工具不会自动可见），M22 / M23 建成的 Agent 侧能力（会话绑定 + 护栏 + 开关 + 审批门）从未接通。

## 决策

**总原则：护栏修复为必须；只读语义下沉到连接层兜底；绑定最小授权。**

1. **护栏三处加固**（`guard.ts`）：危险关键字匹配加 `i`（大小写不敏感）；PRAGMA 写意图 = 含 `=` 赋值（不区分大小写）**或** 括号赋值形式且名称不在只读名单（`table_info` / `index_list` 等 15 个；无法静态识别的名称——如引号包裹——按写处理，失败关闭）；`/*!` / `/*M!` 跳过起始标记后按代码继续扫描（内容含分号自然触发多语句拒绝；普通块注释仍剥离）。
2. **纵深防御**（`manager.ts`）：`mode='query'` 恒按只读执行（`readOnly || mode === 'query'`）——即使连接开启「允许写入」，PostgreSQL / MySQL 走只读事务（写被数据库拒绝），SQLite 执行层对写语句抛错。护栏是逻辑层，连接层是硬保证。
3. **可达性绑定**：`backend` ← `db_list_connections` / `db_schema` / `db_query` / `db_execute`（数据模型与 SQL 实现主责）；`devops` ← `ssh_exec`（运行手册与日志排查）。其余 32 角色不动（对齐 v11 浏览器两角色先例）。
4. **留有痕**（`sqlite.ts`）：只读打开失败回退读写打开时输出告警日志（此前静默；WAL 文件权限场景回退是可用性所需，但驱动层只读保证失效必须可见）。

## 理由

- **大小写绕过是真实可利用路径而非理论风险**：在「允许写入」连接上，Agent 用小写写语句经 `db_query` 即可免审批执行写（`db_query` 不在审批名单）；只读连接上 PG / MySQL 的只读事务能兜住，但防线不应依赖单点。
- **PRAGMA 括号形式是合法 setter 语法**：SQLite `PRAGMA name(value)` 与 `= value` 等价；只读名单外的括号形式一律按写拒绝（名单含需括号参数的只读 pragma——`table_info` / `index_list` 等），"误伤可接受、漏放不可接受"立场。
- **`/*!` 是「会执行的注释」而非注释**：剥离等于主动隐藏可执行内容；按代码扫描后保守方向全部正确（内容含分号 → 多语句拒绝；含危险关键字 → 拒绝）。
- **连接层只读比文本分析可靠**：SQL 方言演进会持续产生新语法，分析层永远可能被绕；数据库自身的只读事务 / 驱动只读打开是硬保证，`db_query` 的契约就是只读，强制即可。
- **绑定最小化**：工具描述与角色职责一对一（db 工具描述"写 SQL 前先确认真实表名字段名" = backend；ssh_exec 描述"查看服务状态、拉取日志、部署脚本" = devops），避免白名单膨胀与无关角色误触。

## 被否决方案

- **仅修大小写敏感**：PRAGMA 括号形式与 `/*!` 注释仍可绕过，不完整；
- **把 db_query 纳入审批门**：只读查询是高频操作，逐次审批破坏体验——改为修复护栏 + 连接层只读兜底；
- **全部 34 角色绑定 db / ssh 工具**：白名单膨胀，多数角色（市场 / 财务 / 法务等）无数据库 / 服务器职责；
- **SQLite 只读打开失败直接报错**：WAL 文件权限场景将直接不可用（可用性损失），回退 + 留痕 + 两层写拒绝更均衡；
- **引入第三方 SQL parser 做方言级分析**：跨三方言成本高且解析器对非法语句的容错差异大；护栏语义只需"保守拒绝"，纯函数状态机足够。

## 后果与边界

- 「允许写入」连接上 `db_query` 不再能执行副作用查询（如 PG `nextval()`、MySQL `SELECT ... INTO @var` 的会话写入路径）——只读事务语义所致，符合 `db_query` 只读契约；
- MySQL 语义细节：`--` 后无空格在 MySQL 中不是注释、`#` 是行注释，护栏扫描按"无条件 `--` 注释 / `#` 视为代码"处理（保守方向），MySQL 侧由 `multipleStatements: false` + 单语句护栏 + 只读事务三层兜底；
- `/*+ optimizer hint */`（MySQL 优化器提示）仍按普通注释剥离——其内容不构成独立语句；
- 回归测试：`tests/m22.test.ts` 新增"绕过加固"用例（小写 CTE / PRAGMA 赋值与括号形式 / `/*!` `/*M!` / 普通注释不误伤）；`tests/m21.test.ts` 新增 backend / devops 绑定断言。
