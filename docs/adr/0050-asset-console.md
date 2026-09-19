# ADR 0050：资产控制台（ActivityRail + Agent / Skill 管理）

- 状态：Accepted
- 引入：M26
- 相关：[design.md §42](../design.md)、ADR 28（Agent 包化与场景分组）、ADR 29（灵魂层）、ADR 31（场景协议与技能绑定）、ADR 15（Skill 渐进式披露）、ADR 40（快速组队预设）、ADR 11（SSE + WS 双通道）、ADR 25（前端 store 架构）

## 背景

- 资产真相层早已是文件目录：`agents/<场景>/<agent>/`（AGENT.md + souls/ + avatar.png）与 `skills/<name>/SKILL.md`（ADR 28 / 15 / 29 / 31）。但此前只有「读」没有「管」：新增 / 修改角色与技能必须手改文件，没有 schema 自检、没有引用告警、没有统一的校验入口。
- 需求：最左侧常驻纯图标导航栏（对话 / Agent 管理 / Skill 管理，后续扩展工具中心等）；Agent 管理支持「新增自定义 agent + 编辑全部可配置项」；Skill 管理支持新建 / 复制 / 软删除；并且把「还有哪些可配置」整理为可演进的全量矩阵。
- 硬约束：
  1. **零双真相**：DB / store 只做缓存，写盘只能落到 `agents/`、`skills/` 目录本身，否则 mtime 热更新失效；
  2. **无 Git 环境**：删除不可恢复 → 一律软删除到回收站，删除 / 覆盖前做引用检查；
  3. **写后即生效**：写盘后依赖既有 mtime 热更新（下一回合即用新定义），无需重启；
  4. 本地单用户产品：无并发编辑冲突，不需要乐观锁 / 版本号。

## 决策

1. **导航与视图挂载**：最左常驻 `ActivityRail`（44px、icon-only + tooltip：工作台 / Agent 管理 / Skill 管理；设置 pin 底部）。`ui-store.appView: 'workspace' | 'agents' | 'skills'` 持久化 localStorage（`ma:appView`，非法值回退 workspace）。`appView !== 'workspace'` 时只切换主区内容——**AppLayout 不卸载**（WS 生命周期 / 运行状态保持），HeaderBar 与 rail 保留；窄屏同样保留 rail。
2. **唯一写盘入口 `AssetManager`**（`server/src/assets/manager.ts`）：控制台的全部读写（含头像 / 灵魂 / 场景创建）都经它执行：
   - 读：`listAgents / getAgent`（raw AGENT.md + 灵魂列表 + 头像状态）、`listSkills / getSkill`、`references(id)`（handoff / 场景 chain / 预设 members / 会话 participantIds / 技能预载的引用方清单）；
   - 写：`createAgent / updateAgent / duplicateAgent / deleteAgent`、`writeSoul / deleteSoul`、`writeAvatar / deleteAvatar`、`createGroup`、`createSkill / updateSkill / deleteSkill`。
3. **校验与序列化复用运行时 schema**：写侧直接复用 `AgentFrontMatterSchema / SoulFrontMatterSchema / AgentGroupSchema / SkillFrontMatterSchema`（zod），序列化器按固定字段顺序生成 front-matter + 正文——**写出的文件必然能被 PromptLibrary / SkillLibrary 加载**（不会制造「能存不能读」的资产）。`validate()` 聚合解析 / 语义问题 + skills 目录结构扫描（异常转 issue，不 500），供页头校验徽章。
4. **安全写入**：id / soulId / 技能名统一 `^[a-z][a-z0-9-]{0,39}$`（防路径穿越，读 / 写 / 删全链路先 assert）；同目录 `.tmp` → rename 原子写；头像仅 PNG magic 校验且 ≤8MB（`/api/console/agents/:id/avatar` 单独 12mb JSON 上传通道，base64 直传，与 sessions/uploads 同模式）；`prompts/` 回退模式下一律拒绝写（提示先 migrate:agents）。
5. **软删除与引用检查**：删除一律软删除到 `data/trash/assets/<ISO 时间戳>/<相对路径>`（相对路径含顶层种类 `agents/…`、`skills/…`）；无 `?force=1` 时若有引用返回 **409 + 引用清单**，前端对话框展示影响面二次确认；组内最后一名角色删除 = 整组入回收站（`deletedGroup: true`，含 `_group.yaml`）。
6. **三态语义（tools / skills）**：`tools` 缺省 = 全部工具、数组 = 指定白名单；`skills` 缺省 = 继承场景 `defaultSkills`、`[]` = 显式不预载、数组 = 指定清单。更新接口显式接受 `null` 表示「恢复未配置」（写键删除）；编辑器对「白名单 / 清单为空」做前端拦截（空数组在运行时等价全量，落盘只制造误导）。
7. **实时刷新（双保险）**：所有写操作成功后服务端广播 `notify:assets-changed`（保留主题 `__assets__`，不进未读计数）；本页 `console-store.afterWrite()` → `refreshAll()` 并联动 `agentStore.reload()`（建会话成员选择器 / 团队面板立即反映新角色）；多标签经 ws-store 订阅同一主题刷新（降级轮询路径天然覆盖）。
8. **前端结构**：`components/console/`（ActivityRail、AgentConsole + AgentEditor 七页签抽屉、SkillConsole + SkillEditor、fields 基元、ValidateBanner）；`stores/console-store.ts` 管理数据加载与全部变更动作；CommandPalette 增加「打开 Agent 管理 / Skill 管理」命令（视图类命令先切回 workspace，避免控制台视图下「点了没反应」）。
9. **本期范围**：Agent 管理（列表按场景分组 / 搜索 / 过滤 / 新建向导 / 编辑 / 复制 / 软删除）+ Skill 管理（列表引用统计 / 新建 / 复制 / 编辑 / 软删除）+ 资产校验徽章；场景 / 预设 / 工具中心管理列入二期，数据管理列入三期（矩阵见下）。

## 配置矩阵（一至三期全量）

标注：**本期** = M26 已实现；**二期 / 三期** = 已规划未实现（只写入本文档，不改代码）。

### Agent 级（本期全部可编辑）

| 配置项 | 落盘位置 | 说明 |
| --- | --- | --- |
| `id` | 目录名 | `^[a-z][a-z0-9-]{0,39}$`，全局唯一，创建后不可改（改名 = 三期） |
| `name` / `role` / `title` / `description` | front-matter | 显示名 / 角色徽标 / 头衔 / 名片描述 |
| `capabilities` | front-matter | 能力标签（团队面板展示） |
| `avatar.icon` + `avatar.gradient` | front-matter | 无 PNG 时的回退形象 |
| `avatar.image` | front-matter | 自定义图片路径（有 avatar.png 时可读展示） |
| 头像 PNG | `avatar.png` | 上传 / 删除（magic 校验、≤8MB，走回收站） |
| 人设正文 | AGENT.md 正文 | Markdown 编辑器（复用 chat/Markdown 预览） |
| `souls` | `souls/<id>.md` | 新建 / 编辑 / 设为默认 / 删除（含 `setDefault`） |
| `soul`（默认灵魂） | front-matter | 高级页下拉显式指定 |
| `handoff` | front-matter | 交接对象多选（排除自身） |
| `tools` | front-matter | 三态：全部 / 指定白名单 /（空数组被前端拦截） |
| `skills` | front-matter | 三态：继承场景 / 不预载 `[]` / 指定清单 |
| `model` / `temperature` | front-matter | 留空 = 继承全局；温度 0–2 |

### Skill 级（本期全部可编辑）

| 配置项 | 落盘位置 | 说明 |
| --- | --- | --- |
| `name` | 目录名 | 同 ID_RE，全局唯一，创建后不可改 |
| `description` | front-matter | 「何时使用」，进入模型工具提示 |
| `tags` | front-matter | 标签数组 |
| 正文 | SKILL.md 正文 | Markdown 编辑 / 预览；引用影响面警示（被哪些角色预载 / 场景兜底） |

### 场景级（二期）

`_group.yaml`：`name / description / icon / theme / objective / chain`（排序）/ `defaultSkills` / `parallel` / `rounds` / `parallelMax` / `order`；`_protocol.md` 只读查看（高级编辑三期）。本期的场景能力仅「新建向导内联建场景」（`POST /api/console/groups`）。

### 工具级（二期）

工具中心页：全部工具的清单 / 分类（文件检索 / 联网 / 业务 / Git / 执行 / 连接自动化 / 记忆协作 / 范式）/ `readOnly` 标记 / 各角色白名单使用矩阵；全局禁用 `settings.disabledTools`（`ToolRegistry.forAgent` 过滤）。不做 UI 自定义工具创建（HTTP 工具列入三期演进）。

### 预设级（二期）

`_presets.yaml` 全字段 CRUD：`id / name / description / icon / theme / members / prompt / order`（`check:agents` 同口径校验）。

### 运行期设置扩展（二期）

设置面板字段白名单扩充：`webSearchEnabled / webSearchApiKey`、`httpUserAgent / httpMinIntervalMs / httpTimeoutMs`、`webFetchAllowedDomains`、`parallelMax`、`maxToolSteps`、`browser` 帧率与质量、`dbQueryMaxRows`、`disabledTools`。

### 数据管理（三期）

资产导出 / 导入（zip）、回收站恢复与清空、写前版本快照、使用洞察（`load_skill` 次数 / 工具调用统计）、Agent 系统提示词预览、MCP server 管理 UI、全局协议 `_protocol.md` 高级编辑。

## 理由

- **文件目录唯一事实源**：控制台只做「校验 → 原子写 → 通知刷新」三段，复用 mtime 热更新与既有加载器，天然零双真相；DB 不镜像资产，也就不存在同步 / 漂移问题；
- **复用运行时 schema 做写前校验**：编写侧与加载侧共用同一组 zod schema，杜绝「UI 能保存、运行时加载失败」的资产形态（序列化器固定字段顺序，diff 友好）；
- **软删除优于硬删除**：无 Git 环境下删除不可恢复，回收站（含相对路径）可人工恢复，成本低、兜底强；引用检查 409 让「删了才知道被引用」变成事前可见；
- **三态显式化**：`null / [] / [...]` 在工具与技能上是三种真实语义，更新接口接受 `null` 恢复「未配置」，避免 UI 单向地把「继承」固化成空数组；
- **通知走既有双通道**：`notify:assets-changed` 复用 WS + 轮询降级基建（ADR 11），本页写后立即 `agentStore.reload()` 双保险，多标签自动同步；
- **rail 不卸载工作台**：控制台视图只切主区，WS / Run 状态与后台运行不受影响（避免「去看一眼 Skill 就把正在跑的会话断了」）。

## 被否决的方案

- **DB 双真相（资产入 SQLite，目录由 DB 导出）**：引入双向同步与漂移风险，破坏「文件是唯一事实源」的既有架构（ADR 18 / 28），手改文件的既有习惯也要被迫改造——否决；
- **硬删除（直接 rm）**：无 Git 环境不可恢复；即便加二次确认，误删代价仍不可逆——一律软删除到回收站；
- **写前备份快照（每个资产保留 N 个历史版本）**：与回收站职责重叠、复杂度高且无 Git 场景下收益有限——列入三期数据管理再评估；
- **UI 自定义工具创建（HTTP 工具编排器）**：工具必须被 mock / eval / 审批 / 分类体系完整覆盖，本期不做半成品；工具中心先做授权配置，HTTP 工具列入三期演进；
- **id 改名（重命名目录 + 迁移全部引用）**：引用面（handoff / chain / 预设 / 会话成员 / 白名单）迁移风险高，一期只读展示；三期以「新建 + 迁移引用 + 软删除」流程化实现；
- **控制台整体替换 AppLayout（路由级页面）**：会卸载会话 Run / WS 生命周期，破坏后台运行——改为 appView 主区切换；
- **列表直接读 `/api/agents`（复用运行期数据）**：运行期清单不含 raw front-matter / 引用 / 校验上下文；控制台独立 `/api/console/*` 语义更干净（复用同一 AssetManager）。

## 适用与失效条件

- 适用：本地单用户、文件目录为资产真相源、无 Git（或即使有 Git 也保留回收站兜底）的部署形态；mock 与真实模型一致（控制台不感知 LLM）。
- 失效条件：
  - 引入多用户并发编辑时，需补写冲突策略（mtime 乐观锁或队列化写入）——当前无锁，依赖单用户；
  - 资产目录迁移到远端 / 对象存储时，`AssetManager` 的文件系统语义（tmp+rename、回收站）需整体替换为对应后端；
  - `prompts/` 回退模式（旧平铺目录）下控制台写操作一律拒绝——运行 `npm run migrate:agents` 迁移后自动可用。
