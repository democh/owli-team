# Agent 资产包指南（agents/）

> M15 起，所有角色资产（定义 / 灵魂 / 头像）以「包目录」形式自包含地放在本目录下。
> 新增一个 Agent **无需改任何代码**：建目录 → 写 `AGENT.md` → （可选）放 `souls/` 灵魂 → 放 `avatar.png` → `npm run check:agents` 校验。

## 目录规范

```
agents/
├── README.md                 # 本文件
├── _protocol.md              # 全局协作协议（对所有场景生效）
├── CHANGELOG.md              # 变更日志（协议 / 人设改动须登记）
├── _presets.yaml             # 快速组队预设（可选；跨场景编制模板，缺失时 UI 自动隐藏）
└── <场景 id>/                # 一个目录 = 一个场景（group）
    ├── _group.yaml           # 场景元数据（必填）
    ├── _protocol.md          # 场景协议（可选；本包 34 场景已全量具备，追加在全局协议之后）
    └── <agent id>/           # 一个目录 = 一个 Agent（id 跨场景全局唯一）
        ├── AGENT.md          # front-matter + 人设正文（必填）
        ├── souls/            # 灵魂变体（可选；不建目录 = 无灵魂，行为与经典模式一致）
        │   └── default.md    # 一个文件 = 一套人格 / 风格
        └── avatar.png        # 形象照（可选；loader 自动发现，无需写 image 字段）
```

- **目录即分组**：`group` 由 `agents/<场景>/` 目录名推导，不要（也不允许）在 front-matter 手写 `group`；
- **目录即 id**：Agent 目录名必须与其 front-matter 的 `id` 一致；soul 文件名必须与其 `id` 一致；
- `id` 在全部场景内全局唯一；`handoff` 指向的成员必须真实存在（`check:agents` 校验）。

## AGENT.md front-matter 字段

```yaml
---
id: pm                        # 必填，与目录名一致
name: 费利                     # 必填，展示名
role: 产品经理                 # 必填，角色徽标
title: Product Manager        # 展示用英文头衔
description: 一句话职责说明
capabilities: [需求分析, 任务拆解]
avatar:
  icon: clipboard-list        # 回退图标（lucide 名，见 client/src/lib/avatar-icons.ts 注册表）
  gradient: ["#f59e0b", "#fbbf24"]   # 回退渐变（图片缺失 / 加载失败时）
  # image: /avatars/x.png     # 一般不需要：目录内有 avatar.png 时会自动使用 /api/agents/<id>/avatar
soul: wild                    # 可选：默认灵魂 id（未写时取 souls/default.md；都没有 = 无灵魂）
handoff: [architect, designer] # 常用交接对象（按需，不限制实际 @）
tools: [...]                  # 可选：工具白名单（缺省 = 全部已启用工具）
skills: [...]                 # 可选：预载技能（缺省时若场景 _group.yaml 配了 defaultSkills 则采用）
model: deepseek/deepseek-chat # 可选：服务名/模型名（前缀 = 「设置 → 模型与生成 → 模型服务」的连接名；如 deepseek/deepseek-flash）
temperature: 0.6              # 可选；设置面板「统一温度」开启时被忽略
---
```

### 正文规范：专家级六段骨架

正文（front-matter 之后的人设）统一采用六段骨架，**每段均为必含段**；正文目标 1200–2400 字符，由 `npm run check:agents` 质量报告实测（`--strict` 时为 CI 门禁）：

1. `## 职责`——一句形象 + 分点职责（每条以动词开头的闭环）；**末条固定为职责边界**（做什么 / 不做什么 / 什么归谁）。
2. `## 专业判断`——3–5 条**硬规则**：阈值、取舍口径、分支决策（什么情况走 A、什么情况走 B）、不变量（什么永远不妥协）。写「可判定的规则」，不写泛泛态度。
3. `## 工作方式`——SOP 化编号步骤：每步可执行、含工具口径（用哪个工具、参数口径、禁止什么）；决策点写明判断依据。
4. `## 质量与自检`——交付前核对清单（3–5 条可判定项）+ 2–3 条**反模式**（本角色最常见的错误及表现），形成自我 QA 闭环。
5. `## 交付契约`——产物路径（`docs/<文档类型>-<主题>.md`，须与 mock.ts `artifactFor` 逐字一致）+ 章节结构 + 完成定义。
6. `## 协作接口`——上游输入 / 下游交接（**交接品质标准**：交棒时必须携带的信息包）/ 升级路径（什么情况找谁、什么情况 @用户 拍板）。

> 段序即建议顺序；升级既有角色时 front-matter 与交付契约中的路径文本不得改动（受测试断言保护）。

正文写作要点（四段骨架时代的通用建议，仍适用）：你是谁（一句形象）→ 职责（含边界）→ 工作方式（可执行步骤与决策规则）→ 交付契约（产物路径 + 章节结构 + 完成定义）→ 协作接口（上游输入 / 下游交接 / 升级路径）。

## 工具白名单（front-matter `tools`）

- `tools: [...]` 为可选白名单：缺省 = 该角色可用全部已启用工具；写上则仅暴露列出项（最小授权，如 legal 只给 `template_fill` 与检索类）；
- 业务工具四件套（M21）：`calc`（金额 / 比例 / 利率，禁止心算）、`date_calc`（日期与排期，含工作日）、`csv_analyze`（表格汇总 / 筛选，禁止目测）、`template_fill`（合同 / 报价 / 邮件等模板批量渲染，写类走审批）；
- 「何时必须用」由协议层约束（`_protocol.md <tool_policy>` 的业务纪律四条），工具授权只解决「能不能用」。
- 外部 MCP（免 Key 批，`mcp.json` 文件权威）：九台服务器（sequential-thinking / memory / time / weather / markitdown / deepwiki / context7 / arxiv / yfinance）按场景最小授权授予对应角色（`mcp__<slug>__*` 通配，会话绑定后可见）；安装台账见 [design.md §109](../design.md)。
- 协作基线（M29，v14 扩展至全部角色）：全部 139 业务角色白名单均含 `handoff`（结构化转交为第一通道，ADR 2；`reason` / `expected_output` 随交接注入接收方回合指令）；研发 7 角色均含 `remember`（关键口径固化，对齐协议 `<context_semantics>`）。空场景通用助手 `general` 除外：无 `handoff`，单助手纪律（M50）。
- 调度（M48）：**不再有「调度官」角色**——未 @ 消息与空编制开场由引擎的**平台路由步（PRS）**自动组队与派发（见 [design.md §57](../design.md) / [ADR 0101](../docs/adr/0101-platform-routing-step.md)）；全部 agent 均为单一业务角色，不存在「平台机制角色」。

## 研发场景能力基线（M29）

研发 7 角色按「编码代理能力基线（CAB）」取子集：代码导航 / 精准编辑 / 执行验证（`run_command`）/ 版本控制（git 只读全员，写按实现者授权 + 审批）/ 数据与环境（db / browser / ssh 分权持有）/ 协作与记忆（`handoff` / `remember` / `write_todos` / `load_skill` / `request_approval`）。职责边界：designer 只「看」页面（浏览器只读子集），qa 只「查」数据（`db_*` 只读三件套，不含 `db_execute`），发布动作仅 devops；工程纪律（先读后写 / 最小 diff / 验证闭环 / 提交与发布纪律）见 `development/_protocol.md`；完整矩阵与决策见 [ADR 55](../docs/adr/0055-development-capabilities-code-baseline.md) 与 design.md §45。

## 协同范式（M24：执行 / 规划 / 评审）

每个回合可处于三种协作范式之一，**与角色正交**（任何 Agent 均可承担，工具白名单自动收敛）：

- **执行（execute，默认）**：现状行为零差异；收到「你负责的计划步骤」时按步骤执行，并用 `update_plan_step` 汇报进度（in_progress / done / blocked / skipped）。
- **规划（plan）**：只读工具 + `write_plan`（写类工具不可见）；提交计划后本回合挂起等待用户批准 / 驳回——驳回带反馈、作者当场修订出 v2；批准后引擎按步骤负责人派发执行，全步完成后作者获得一次收口回合。
- **评审（review）**：只读工具 + `submit_review`；对 `plan:` / `step:` / `artifact:` / `message:` 目标给出 pass / conditional / fail 判定与发现、证据；fail 会阻塞对应步骤或计划（修复后可复审）。

触发规则（显式 opt-in，默认不触发）：Composer 消息级选择（仅对下一条消息生效）> 会话「规划先行」开关 > 计划步骤声明的 `mode: review` > 默认 execute。协议契约见 `_protocol.md <paradigm_modes>`；各角色资产无需逐个修改（白名单交集自动生效）。

## 技能库与预载（skills/）

三层加载：**常驻索引**（全部技能的 name + description 注入系统提示 `<available_skills>`，任何角色可按需 `load_skill` 加载正文）→ **预载**（front-matter `skills: [...]`，正文直接进系统提示 L3 层，可裁剪）→ **场景兜底**（`_group.yaml` 的 `defaultSkills`，仅当 agent 未显式配置 skills 时生效）。

- 技能为单文件 `skills/<name>/SKILL.md`：front-matter（`name` 必须等于目录名 / `description` 必填含触发场景 / `tags`）+ 中文正文 60–150 行；库按 mtime 热更新，`npm run check:skills` 校验（附行数质量报告；**CI 已启用 `SKILL_STRICT=1` 强制门禁**）；
- 只引用本仓真实工具与 Markdown 容器（`::: kpi / timeline / mail / option / cols / details / process`、`chart` / `mermaid`）；角色缺该工具时以「如可用」降级并给替代路径；
- 外部来源（Anthropic 官方 / 社区职能库 / Vercel 界面指南等）统一改写为「本仓工具可执行」的方法论，规范见 ADR 45；安装批新增 8 项外部来源（paper-search / avoid-ai-writing / superpowers / claude-code-owasp / naming / en-zh-translation-polish / claude-persona / Claude-Ally-Health），来源登记见 [design.md §109](../design.md)。

72 技能按 17 组归类：研发工程（api-design / code-review / debugging / test-plan / webapp-testing / release-engineering / system-design / mcp-server-building / incident-response / test-driven-development / secure-coding）、产品与设计（prd-authoring / visual-design / design-system / interaction-motion / ui-review / frontend-design / react-performance / brand-system / game-design / interior-design / 3d-visualization）、数据与演示（nl2sql / data-visualization / spreadsheet-modeling / deck-authoring）、研究与验证（deep-research / source-verification / red-team / academic-writing / literature-search / user-persona）、风暴与元技能（brainstorm-facilitation / skill-authoring）、营销增长（content-marketing / seo-optimizer / sales-outreach / brand-naming）、客户服务（customer-success / support-desk）、财务法务（financial-modeling / contract-review / formal-document）、投资研究（technical-analysis / fundamental-analysis / investment-strategy / market-news-analysis / game-theory-trading）、运营人事（process-improvement / recruiting / procurement）、战略管理（business-review / strategic-planning）、写作沟通（comms-writing / doc-coauthoring / natural-writing / translation-quality / report-authoring）、谈判与辩论（negotiation / debate）、 命理占星（chinese-metaphysics / western-astrology / fengshui）、场景玩法（trpg-hosting / tarot-reading / philosophy-dialogue）、经营创作（ecommerce-operations / creator-economy）、生活沟通（relationship-communication / health-metrics）；academic-writing 并入「研究与验证」组。

各角色预载一览（业务角色显式配置；技能库均为工作向方法论，生活场景角色不硬配，按需 `load_skill`）：

| 场景 | 角色（预载技能） |
| --- | --- |
| blank | general（按需 `load_skill`） |
| strategy | chief（business-review / deck-authoring / report-authoring）· strategist（strategic-planning / deck-authoring / report-authoring）· insight（data-visualization / spreadsheet-modeling / report-authoring）· pricing（financial-modeling / spreadsheet-modeling / report-authoring） |
| research | lead（deep-research / doc-coauthoring / report-authoring）· scout（deep-research / source-verification / literature-search / report-authoring）· analyst（deep-research / data-visualization / report-authoring）· verifier（deep-research / source-verification / report-authoring） |
| brainstorm | facilitator（brainstorm-facilitation / skill-authoring）· ideator（brainstorm-facilitation / visual-design）· challenger（brainstorm-facilitation / red-team）· refiner（brainstorm-facilitation / doc-coauthoring） |
| development | pm（prd-authoring）· architect（system-design）· designer（visual-design / design-system / interaction-motion / ui-review）· ux-researcher（deep-research / ui-review / user-persona）· ux-writer（comms-writing / doc-coauthoring / translation-quality）· frontend（frontend-design / react-performance / ui-review / debugging）· backend（api-design / mcp-server-building / debugging / test-driven-development）· ai-engineer（mcp-server-building / system-design / secure-coding）· data-engineer（spreadsheet-modeling）· security（code-review / red-team / secure-coding）· tech-writer（api-design / doc-coauthoring）· qa（test-plan / webapp-testing / ui-review / debugging）· devops（release-engineering） |
| sre | sre（incident-response / debugging） |
| marketing | growth（content-marketing / spreadsheet-modeling）· content（content-marketing / doc-coauthoring / natural-writing）· seo（content-marketing / seo-optimizer）· ads（content-marketing / spreadsheet-modeling）· social（content-marketing）· video（content-marketing）· influencer（sales-outreach / content-marketing / user-persona）· pr（comms-writing / formal-document）· localizer（doc-coauthoring / comms-writing / translation-quality）· brand（brand-system / visual-design / brand-naming） |
| sales | sales（sales-outreach / deck-authoring）· bd（sales-outreach / deck-authoring）· success（customer-success / spreadsheet-modeling）· support（support-desk / comms-writing） |
| finance | finance（financial-modeling / spreadsheet-modeling）· tax（financial-modeling / spreadsheet-modeling）· legal（contract-review / formal-document）· compliance（formal-document / contract-review）· ip（formal-document / contract-review） |
| invest | invest-lead（report-authoring）· analyst-fa（fundamental-analysis / report-authoring）· analyst-ta（technical-analysis / report-authoring）· analyst-news（market-news-analysis / report-authoring）· quant（investment-strategy / game-theory-trading / report-authoring） |
| bi | bi（nl2sql / data-visualization / spreadsheet-modeling / report-authoring）· metric-governor（nl2sql / data-visualization / report-authoring） |
| ops | ops（formal-document / process-improvement）· hr（recruiting / formal-document）· recruiter（recruiting / comms-writing）· trainer（doc-coauthoring / process-improvement）· assistant（comms-writing / formal-document）· supply（procurement / spreadsheet-modeling） |
| funding | fundraiser（deck-authoring / spreadsheet-modeling）· ir（deck-authoring / comms-writing） |
| health | fitness · nutrition · wellness（按需 `load_skill`） |
| learning | tutor · language · reading（按需 `load_skill`） |
| travel | travel（spreadsheet-modeling） |
| wealth | wealth（financial-modeling / spreadsheet-modeling） |
| home | chef · home · pet · parenting（按需 `load_skill`） |
| personal | coach · life-admin（按需 `load_skill`） |
| negotiation | negotiator · counterpart · tactician（negotiation） |
| society | moderator（formal-document · source-verification）· stakeholder（deep-research）· policy-advisor（formal-document） |
| gamedesign | game-designer（game-design / doc-coauthoring）· balance-designer（game-design / spreadsheet-modeling）· narrative-designer（game-design / doc-coauthoring）· playtester（game-design / test-plan） |
| writing | storyline（doc-coauthoring / deep-research）· author（comms-writing / doc-coauthoring）· editor（comms-writing / formal-document / natural-writing）· publisher（formal-document / deck-authoring） |
| career | career-advisor（strategic-planning / deep-research）· resume-coach（comms-writing / doc-coauthoring）· interview-coach（recruiting / comms-writing）· comp-advisor（negotiation / spreadsheet-modeling） |
| housing | home-finder（deep-research / spreadsheet-modeling）· mortgage-advisor（financial-modeling / spreadsheet-modeling）· reno-designer（spreadsheet-modeling / visual-design） |
| care | care-planner（process-improvement / doc-coauthoring）· care-escort（doc-coauthoring / formal-document）· elder-advisor（source-verification / doc-coauthoring） |
| metaphysics | bazi（chinese-metaphysics / data-visualization）· ziwei（chinese-metaphysics / doc-coauthoring）· liuyao（chinese-metaphysics / formal-document）· meihua（chinese-metaphysics / doc-coauthoring）· qizheng（chinese-metaphysics / data-visualization）· daliuren（chinese-metaphysics / doc-coauthoring）· qimen（chinese-metaphysics / formal-document） |
| astrology | natal（western-astrology / data-visualization）· transit（western-astrology / data-visualization）· synastry（western-astrology / doc-coauthoring）· horary（western-astrology / formal-document） |
| interior | interior-designer（interior-design）· space-planner（interior-design）· visualizer（3d-visualization） |
| ecommerce | category-scout · listing-optimizer · store-operator · shop-support（ecommerce-operations） |
| creator | account-strategist（creator-economy / brand-naming）· script-writer · growth-editor · monetizer（creator-economy） |
| legal-personal | rights-advisor（formal-document / contract-review）· labor-advisor（contract-review / formal-document）· contract-checker（contract-review / formal-document） |
| academic | lit-reviewer（academic-writing / deep-research / literature-search）· methodologist（academic-writing）· paper-editor（academic-writing / doc-coauthoring / natural-writing）· submit-advisor（academic-writing / formal-document） |
| relationship | rel-coach · date-coach · mediator（relationship-communication） |
| trpg | gm-host · npc-player · rule-keeper（trpg-hosting）· scenario-writer（trpg-hosting / doc-coauthoring） |
| tarot | tarot-reader · symbol-narrator（tarot-reading）· tarot-historian（tarot-reading / source-verification） |
| moot-court | plaintiff-counsel · defense-counsel · presiding-judge（debate / formal-document） |
| philosophy | socratic-host · thought-experimenter · ethics-moderator（philosophy-dialogue） |

## 交付件命名规范

- 文档类交付件统一 `docs/<文档类型>-<主题>.md`（主题为需求 / 议题 / 课题的简短名词，如 `docs/需求文档-登录.md`）；同一次任务内各角色沿用同一主题词，避免互相覆盖。
- 部署交付件落 `deploy/部署说明-<主题>.md`；前端实现说明落 `web/src/README-实现说明.md`；来源清单等跨任务共用件落 `docs/来源清单.md`。
- 每个角色的具体交付路径、章节结构与完成定义见其 `AGENT.md` 的「交付契约」一节；mock 演示剧本（`server/src/llm/mock.ts`）与本规范保持一致。
- 上述一致性由 `server/tests/mock-coverage.test.ts` 全量守护（每角色四件套：演示剧本 / 交付件路径 / 显示名 / 转交首选；断言动态取角色库全量，新增角色自动纳入覆盖）；`e2e/helpers.ts` 的 `AGENT_NAME` 与之同步（E2E 转交断言的中文名单一事实源）。

## 交付规格与报告写作（report-authoring）

- 全局协议 `<deliverable_spec>` 定义四档交付规格（速览 ≤800 字 / 标准 1500–4000 / 深度 ≥4000 / 专项多件套），档位优先级：用户显式指定 > 计划验收标准 > 角色契约默认档。
- 方法论统一收敛在 `skills/report-authoring`（四档规格表 / 分章撰写流程 / 领域章节库 / 量化自检清单）；报告密集角色（research / invest / strategy / bi 共 16 个）已预载，其余角色经 `<available_skills>` 索引按需 `load_skill`。
- 报告密集角色在「交付契约」中声明默认档与量化下限（字数 / 章节数 / 证据密度），并附降档规则（用户要「速览 / 简报」时的裁剪口径）；长报告按「骨架占位 → edit_file 逐节填充」撰写，禁止单次成文。

## 灵魂层（souls/，可选人格变体）

分层模型：**职责层**（AGENT.md：你是谁、干什么）+ **协议层**（`_protocol.md`：怎么协作，最高约束）+ **灵魂层**（SOUL.md：怎么说、什么性格，可选）。灵魂可插拔、可多套——同一角色挂不同灵魂即产出不同表达风格与内容气质；**无 `souls/` 目录的 Agent 行为与传统模式完全一致**。

`agents/<场景>/<id>/souls/<soul-id>.md`：

```yaml
---
id: wild
name: 狂野
tagline: 嘴上没门，脑洞没边
icon: flame                        # 前端徽标图标（lucide 名）
traits: [话痨, 情绪外放, 爱夸张, 行动派]
tone: 热情跳脱，多用感叹句与比喻，爱起外号
quirks: [开口先来一句「兄弟们」, 激动时连发三条短句, 点子停不下来]
---
正文：表达示例、口头禅库、互动偏好与边界（不冒犯、不编造、不降智）。
```

- 装配优先级：**会话内换装 > 角色默认 `soul` > `souls/default.md` > 无灵魂**；
- 灵魂只影响表达风格与互动方式；职责、事实与协作规则的优先级始终更高（协议中有护栏句）；
- 会话内可随时换装（成员卡点击灵魂徽标），无需改文件。把某风格固化为独立「变体角色」：复制 agent 目录并调整默认 `soul` 即可。
- **同角多魂（M77 成员分身）**：同一角色的不同人格可**同时 入编**——成员身份为「成员键」：经典实例 = `agentId`（换装走会话覆盖 `memberSouls`），分身实例 = `agentId~soulId`（灵魂内嵌键中、自描述；分身换装 = 键替换）。通径：组队台编制行「参与性格」多选（首人格自动走经典键、其余生成分身键）或邀请卡「+ 分身」；同角有效灵魂不可重复、实例上限 4；`@名字` 只召集该角色主实例（编制首位），`@名字·灵魂名` 点名单个分身，全员需逐一点名（Composer 候选「名字（全部 N 位）」一键插入；多实例在场时展示统一为 `名字 · 灵魂名`）。资产侧无需任何新约定。

## 场景元数据 `_group.yaml`

```yaml
id: brainstorm                 # 必填，与目录名一致
name: 头脑风暴                  # 展示名
description: 创意发散与点子打磨：先求量、再收敛，禁止过早评判
icon: lightbulb                # 场景徽标（lucide 名）
theme: ["#f59e0b", "#fbbf24"]  # 主题色（前端点缀）
objective: 围绕议题产出可执行的创意方案集
chain: [facilitator, ideator, challenger, refiner]  # 默认接力链（建会话时按此排序）
defaultSkills: [brainstorm-facilitation]            # 可选：场景默认技能（agent 未显式配置 skills 时生效）
parallel: true                 # 可选：场景内允许自动成波并行（默认 false）
rounds: true                   # 可选：允许多人多轮交替（放宽循环检测阈值，默认 false）
parallelMax: 4                 # 可选：场景并行上限（覆盖全局 PARALLEL_MAX）
order: 20                      # 可选：场景展示排序（默认 100，越小越靠前）
```

## 快速组队预设 `_presets.yaml`（可选）

跨场景编制模板：建会话对话框「快速组队」区块与 Command Palette「新建会话」分组都从这里读取；文件缺失 / 为空时两处入口自动隐藏（无兼容负担）。

```yaml
presets:
  - id: weekly-review                # 必填，全局唯一
    name: 周经营例会                   # 展示名
    description: 周一早会：四方汇报 → 经营简报与优先级
    icon: calendar-clock             # 建会话卡片图标（lucide 名，注册表见 client/src/lib/avatar-icons.ts）
    theme: ["#6366f1", "#818cf8"]    # 主题色（卡片点缀）
    members: [chief, finance, growth, sales]  # 跨场景成员 id（必须真实存在，可混场景）
    prompt: 主持本周经营例会：@周正 ...       # 开场指令模板（创建后预填 Composer 草稿）
    order: 10                        # 展示排序（默认 100）
```

- 校验：`id` 全局唯一、`members` 非空且成员必须存在（`check:agents` 与启动时 `validate()` 双保险）；YAML 破损 / 非法成员启动即报错；
- 热更新：`_presets.yaml` 纳入资产文件监听与 `collectFiles`，修改后无需重启；
- 编排语义：`prompt` 中 @ ≥2 人即触发首波并行（见全局协议 `<parallel_waves>`），与 `_group.yaml` 的 `parallel` 场景设置叠加生效。

## 头像规范

- 放在 `<agent 目录>/avatar.png`（纯白底 / 风格化 3D 卡通 v2 / 半身像，年龄·面孔等七维区分，风格与 design.md §19 一致）；
- 存在即自动生效（`GET /api/agents/<id>/avatar`，ETag 缓存）；缺失 / 加载失败时前端回退 `avatar.gradient + avatar.icon`；
- 想用自定义路径时可在 front-matter 写 `avatar.image`（此时自动发现被让位）。

## 场景分层（选择建议）

34 个场景按使用频次与语义分六层，建会话时优先从「核心工作」「生活与身心」两层选择；「专业支援」类场景用于专项任务：

- **核心工作（16）**：development / sre / ops / strategy / finance / invest / bullbear / bi / marketing / sales / ecommerce / funding / legal-personal / moot-court / academic / research
- **创作与表达（5）**：writing / creator / gamedesign / brainstorm / trpg
- **生活与身心（12）**：home / housing / interior / care / health / wellness-mind / relationship / learning / career / personal / travel / wealth
- **社会与思辨（3）**：society / philosophy / negotiation
- **玄学参考（4）**：metaphysics / fengshui / astrology / tarot
- **单助手（1）**：blank

> 资产精简以数据为依据（ADR 0227）：不做机械合并（角色 id 被存量会话引用、chain 即建会话默认预选、场景承载专属 UI）。`check:agents` 的「资产一致性报告」列出隔离角色（不在 chain/preset/ritual/seats）；减员以 `GET /api/metrics/agents` 的实际负载与质量指标为准。

## 校验与运维

| 命令 | 用途 |
| --- | --- |
| `npm run check:agents` | 校验目录结构 / `_group.yaml` / id 唯一 / handoff / 灵魂引用 / `_presets.yaml`（成员存在 / id 唯一；CI 常驻，并打印预设清单）；附双质量报告：**专家级六段骨架 + 正文 ≥1200 字符**（角色）与**协议 ≥28 行 + 质量红线 / 典型失败模式 / 过程叙述约定三段**（场景）；**CI 已启用 `QUALITY_STRICT=1` 强制门禁**——未达标即失败；本地默认报告模式，`--strict` / `QUALITY_STRICT=1` 可手动切门禁 |
| `npm run migrate:agents` | 从旧 `prompts/` 平铺目录幂等迁移（`--prune` 清理源文件） |
| `AGENTS_DIR` / `PROMPTS_DIR` | 资产目录 env；`agents/` 缺失而 `prompts/` 存在时自动按旧逻辑回退加载并告警 |
| `PARALLEL_MAX` | 并行波次单波人数上限（默认 3；=1 关闭并行） |

## 控制台管理（M26）

界面提供 Agent / Skill 图形化管理（左侧 icon 导航栏「Agent 管理 / Skill 管理」，决策见 [ADR 50](../docs/adr/0050-asset-console.md)），与手改目录**同权互补**：

- **目录仍是唯一事实源**：控制台走「zod 校验 → `.tmp` 原子写 → mtime 热更新」，写出的文件与手写规范完全一致（front-matter 字段顺序固定，diff 友好）；手改文件后控制台刷新即见；
- **可编辑范围**：Agent 全部 front-matter 字段 + 人设正文 + 灵魂 + 头像 PNG + 工具白名单（三态：缺省 = 全部 / 数组 = 指定 / 空数组被编辑器拦截）+ 技能预载（三态：缺省 = 继承场景 `defaultSkills` / `[]` = 不预载 / 数组 = 指定）；Skill 的 `description` / `tags` / 正文；`id` 与技能 `name` 创建后不可改（改名 = 三期「新建 + 迁移引用 + 软删除」）；
- **软删除**：删除一律移入回收站 `data/trash/assets/<ISO 时间戳>/<相对路径>`（含顶层种类，如 `agents/development/<id>/AGENT.md`、`skills/<name>/SKILL.md`），无 Git 环境可手动拷回恢复；有引用（handoff / 场景 chain / 预设 members / 会话成员 / 技能预载）时接口返回 409 + 引用清单，UI 展示影响面后再二次确认；组内最后一名角色删除 = 整个场景目录（含 `_group.yaml`）入回收站；
- **安全约束**：id / soulId / 技能名统一 `^[a-z][a-z0-9-]{0,39}$`（防路径穿越）；头像仅 PNG 且 ≤8MB；`prompts/` 回退模式下控制台拒绝写（先 `npm run migrate:agents`）；
- **校验徽章**：控制台页头实时展示 `POST /api/console/validate` 聚合结果（解析 / 语义 / skills 目录结构，异常转 issue 不 500），也可作为日常自检入口。

## 兼容回退（一个版本周期）

`agents/` 不存在而 `prompts/` 存在时，加载器按旧逻辑读取 `prompts/*.md`（启动告警提示迁移）；调用 `npm run migrate:agents` 完成迁移后，`prompts/` 可保留一个版本周期作为安全网，之后用 `--prune` 清理。
