# Owli Team

本地运行的多角色 AI 协作应用：18 大场景（研发 / 商业战略 / 深度研究 / 投资研究 / 市场增长 / 销售客户 / 财务法务 / 运营行政 / 融资资本 等，覆盖工作与生活）共 73 位角色，在同一会话中自由混搭、共享上下文，通过 `@某角色` 或结构化 `handoff` 工具自主转交、形成接力链，全程流式输出。

系统按「专业级」路线完成十项能力建设：**会不失忆**（五层上下文装配 + 滚动摘要压缩）、**能真干活**（Project 层 + git worktree 隔离 + 文件与 Git 工具集 + HITL 审批）、**可控可证**（会话级 Run 互斥与插话、Run/Task/Trace 落库、指标与评测闭环）。

场景化扩展（M15–M18）：Agent 单包目录与场景分组、可插拔灵魂人格、动态成员、并行波次、协作图谱——详见 [design.md](design.md) §25–§29。

渲染扩展（M19）：消息与交付件支持 mermaid / chart 图表块、分栏与容器语法（callout / 折叠）、代码块工具条（文件名 / 行高亮 / 复制 / 长码折叠）与 TurnCard 展示优化——详见 [design.md](design.md) §30。

OPC 业务扩展（M21）：9 场景 34 角色全职能虚拟公司、业务工具（calc / date_calc / csv_analyze / template_fill）、业务 Markdown 卡（KPI / 时间轴 / 邮件 / 方案）与快速组队预设——详见 [design.md](design.md) §31–§34。

协作范式与任务指挥（M24）：与角色正交的规划 / 执行 / 评审三范式（显式 opt-in，默认零差异）、计划提交挂起与批准 / 驳回修订 v2、派发执行与步骤进度收口、任务面板 2.0（计划板 / 按成员分组 / 「规划先行」）——详见 [design.md](design.md) §40–§41。

**环境要求**：Node.js 22.5+（推荐 24，持久化依赖内置 `node:sqlite`）；系统 `git`（仅 repo / worktree 模式需要）。

## 快速开始

```bash
npm install
cp .env.example .env    # 必填：填入 LLM_API_KEY（未配置时服务拒绝启动）
npm run dev             # 同起 server(8787) + client(5173)
```

打开 http://localhost:5173 ，在左栏新建会话（组队台：选来源（快速组队 / 按场景）→ 角色池增减成员 → 编制与灵魂微调 → 创建），发送消息即可看到接力链实时推进；@ 两位成员可触发并行波次。访问 http://localhost:5173/#/avatars 预览全部角色形象与动画状态，http://localhost:5173/#/agents 浏览全部角色名录。

离线体验（零网络、无需 Key）：在 `.env` 中设 `LLM_MOCK=true`（仅演示 / 测试，生产勿开）。

## 命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | 双端开发模式（Vite HMR + tsx watch） |
| `npm run build` | 生产构建（server → server/dist，client → client/dist） |
| `npm start` | 单端口生产托管（默认 8787，含 API + 前端静态资源） |
| `npm run test` | 全量测试（server + client vitest） |
| `npm run typecheck` / `npm run lint` | 类型检查 / ESLint |
| `npm run eval` | mock 基线评测（32 个 golden 任务 + 回归门禁，非零退出码即回归；`--tasks=` 过滤 / `--update-baseline` 刷新基线 / `--judge` 走真实模型） |
| `npm run e2e` | Playwright E2E（mock 模式，36 条主链路） |
| `npm run check:agents` / `npm run check:skills` | 校验 Agent 包（目录 / `_group.yaml` / 灵魂 / 协议 / 六段骨架 + 正文 ≥1200 字符质量报告）与技能文档（front-matter + 正文 ≥60 行质量报告）；**CI 已启用 strict 门禁**（`QUALITY_STRICT` / `SKILL_STRICT`） |
| `npm run migrate:agents` | 幂等迁移旧资产：`prompts/*.md` + 头像 → `agents/` 单包目录（`--prune` 清理旧文件） |
| `npm run migrate:json` | 旧 `data/sessions/*.json` 一次性导入 SQLite |
| `npm run llm:ping` | 探测真实模型连通性（需 Key） |

## Docker 部署

```bash
# 1) .env 中设置 AUTH_TOKEN（必填，可用 openssl rand -hex 24 生成）与 LLM_API_KEY
# 2) Linux 宿主准备挂载目录属主（macOS/Windows 的 Docker Desktop 可跳过）
mkdir -p data workspace && sudo chown -R 1000:1000 data workspace
# 3) 构建并启动
docker compose up -d --build
# 4) 浏览器首次访问（种 cookie 后直接访问 / 即可）
#    http://127.0.0.1:8787/?token=<AUTH_TOKEN>
```

- 容器内以 `BIND_ALL=true` 监听 0.0.0.0（端口映射前置条件），`AUTH_TOKEN` 强制校验（HTTP + WebSocket 握手）；compose 未设置 token 会直接报错退出；
- 端口默认仅绑定宿主 `127.0.0.1`；如需局域网访问改为 `"8787:8787"`（token 仍是准入条件）；
- `data/`（数据库 / 日志 / settings / worktree）与 `workspace/`（交付件）以卷持久化；
- 真实仓库模式：挂载仓库目录并在 compose 中设置 `ALLOWED_ROOTS`（见 `docker-compose.yml` 注释），改动隔离在 `agent/<会话id>` 分支，合并需显式确认。

## 目录结构

```
├── shared/          协议单一事实源（Session / ChatMessage / RunEvent / NotifyEvent / Artifact…）
├── agents/          Agent 资产包（单目录自包含，18 场景 73 角色；每角色 = AGENT.md + 可选 souls/ 灵魂变体 + avatar.png）
│   ├── README.md    新增角色操作手册（建目录 → 写 AGENT.md → 可选 souls/ 与 avatar.png → check:agents）
│   ├── _protocol.md 全局协作协议（分层协议第一层，场景协议追加其后）
│   ├── _presets.yaml 快速组队预设（跨场景编制模板；缺失时 UI 自动隐藏）
│   ├── strategy/    商业战略（chief / strategist / pricing / insight + 场景协议）
│   ├── development/ 研发团队（pm / architect / designer / frontend / backend / qa / devops 等 13 角色 + 场景协议）
│   ├── sre/         站点可靠性（sre + 场景协议）
│   ├── brainstorm/  头脑风暴（facilitator / ideator / challenger / refiner + 场景协议）
│   ├── research/    深度研究（lead / scout / analyst / verifier + 场景协议）
│   ├── marketing/   市场增长（growth / content / seo / brand / ads / social / video / pr / influencer / localizer，场景并行）
│   ├── sales/       销售客户（bd / sales / success / support）
│   ├── finance/     财务法务（finance / tax / legal / compliance / ip + 场景协议）
│   ├── invest/      投资研究（invest-lead / analyst-fa / analyst-ta / analyst-news / quant + 场景协议）
│   ├── bi/          商业智能（bi + 场景协议）
│   ├── ops/         运营行政（ops / assistant / recruiter / supply / hr / trainer）
│   ├── funding/     融资资本（fundraiser / ir）
│   ├── health/      健康生活（fitness / nutrition / wellness）
│   ├── learning/    学习成长（tutor / language / reading）
│   ├── travel/      出行旅行（travel）
│   ├── wealth/      财富管理（wealth）
│   ├── home/        家庭生活（chef / home / parenting / pet）
│   └── personal/    个人管理（coach / life-admin）
├── skills/          技能库 46 个（12 组：研发 / 设计 / 数据 / 研究 / 营销 / 客服 / 财务法务 / 投资研究 / 运营 / 战略等；业务角色显式预载，生活场景角色按需加载，见 agents/README.md「技能库与预载」）
├── design.md        架构设计总纲（含 76 条 ADR 索引）
├── docs/            api.md（接口表）· operations.md（运维与配置）· adr/（决策记录）
├── server/          Express + ws
│   └── src/
│       ├── orchestration/  parser（@解析）→ scheduler（planWave 波次规划 / decideHandoff / mergeWaveSchedule / 循环检测）→ engine（波次循环 + tool loop + 审批挂起）
│       ├── context/        tokenizer / 五层装配器 / 滚动摘要压缩器 / context 服务
│       ├── llm/            provider（OpenAI 兼容）+ resilience（重试退避 / 超时分层 / 并发信号量）
│       ├── tools/          registry（execWithAbort / 并行 / 幂等缓存）+ 56 工具 + MCP 适配层
│       ├── routes/         agents / sessions（含成员动态增删与换灵魂） / runs / artifacts / context / settings / metrics / feedback / projects…
│       ├── store/          SQLite（node:sqlite + 迁移器）：会话/消息/运行/任务/记忆/摘要/usage/FTS/工具指标
│       └── ws.ts           NotifyHub（订阅 / 心跳 / 环形重放）+ AUTH_TOKEN 握手校验
├── client/          React 18 + Vite + Tailwind（仅浅色主题 · 紧凑布局）
│   └── src/
│       ├── stores/         agent / session / run / task / ws / ui（byId+order，O(1) 订阅）
│       └── components/     三栏布局、虚拟消息列表（并行协作组 / system 事件条）、审批卡、Diff 视图、上下文电池（Composer 底栏）、AgentPicker、协作图谱（懒加载）、名录页、Trace / 指标抽屉、⌘K
├── evals/           评测任务（tasks/*.json）+ baseline.json + reports/
├── e2e/             Playwright 主链路测试（mock 模式）
├── data/            SQLite 库 / settings.json / logs / worktrees（运行时生成）
└── workspace/       交付件根目录（按会话隔离，工具沙箱根）
```

## 核心机制

- **接力与编排**：`@某角色` 或 `handoff(target, reason, expected_output)` 工具转交（`target` 支持多目标 ≤4 = fan-out 并行意图）；同会话永远只有一个活跃 Run，运行中再发消息 = 插话（回合边界注入）；循环检测（波次签名序列 + 3-gram 内容级）自动收尾交还用户。
- **场景与 Agent 包**：19 大场景（智能协作 / 商业战略 / 研发团队 / 站点可靠性 / 头脑风暴 / 深度研究 / 市场增长 / 销售客户 / 财务法务 / 投资研究 / 商业智能 / 运营行政 / 融资资本 / 健康生活 / 学习成长 / 出行旅行 / 财富管理 / 家庭生活 / 个人管理）；`agents/<场景>/<角色>/` 单目录自包含（AGENT.md 人设 + 可选 souls/ 灵魂变体 + avatar.png 自动发现）；协议分层 = 全局协议 + 场景协议（追加语义）+ 人设 + 灵魂段；新增角色只需建目录并跑 `check:agents`，无需改代码。
- **灵魂变体**：同一角色可挂多套人格与表达风格（如卢娜的「狂野 / 禅意 / 考据派」），创建会话时可选、运行中可一键切换（落 system 事件条）；无 souls/ 的角色行为与现状完全一致，职责、事实与协议优先级永远高于灵魂。
- **同角多魂（分身同台）**：同一角色的不同人格可**同时以多个成员实例入编**（如 卢娜·狂野 + 卢娜·禅意 同台）——组队台按「参与性格」勾选入编（首人格走经典成员键、其余为分身键 `agentId~soulId`）；`@名字` 召集该角色全部在场实例、`@名字·灵魂名` 点名单个分身；多实例在场时发布/展示统一为 `名字·灵魂名`（单实例零变化）；分身可随时换装（键替换）或移除。
- **动态成员**：运行中可邀请 / 移出成员；变更落 `role:'system'` 消息（渲染为成员事件条，不进 LLM 窗口）；加人从下一回合即时生效，当前发言 / 波内进行中的成员拒绝移出。
- **并行波次**：回合循环升级为波次循环（串行 = 单波特例，默认行为不变）；显式触发（@ ≥2 人 / handoff 多目标 / 场景 `parallel: true`）；波内上下文隔离（统一基于波前历史）+ 波末 fan-in 收敛；`PARALLEL_MAX` 默认 3（=1 关闭），`maxTurnsPerRun` 语义 = 最大波数。
- **协作图谱**：TeamPanel 第 7 视图（React Flow 懒加载独立 chunk，不占首屏）可视化接力关系与实时状态（发言中 / 排队 / 待你指示）；边由消息 `mentions` 纯前端推导，零后端改动；安静模式 / reduced-motion 降级。
- **上下文工程**：L0 协议 / L1 记忆 / L1.5 语义召回 / L2 摘要 / L3 半静态 / L4 最近回合 / L5 工具结果分层装配；超预算 × 0.7 触发按「回合组」压缩（结构化摘要 + 增量合并）；压缩事件进 Trace；`remember` 工具 + 记忆面板兜底关键约束。
- **向量记忆（M25）**：四层关联（会话 / 角色 / 项目 / 全局）的语义记忆；sqlite-vec 双后端（纯 JS 余弦兜底）、嵌入凭据走连接中心 SecretVault（未配置即模块休眠）、混合评分召回注入 L1.5（300ms 超时静默降级）；Run 后可选沉淀候选记忆待审（默认关）。
- **工具 Harness**：55 内置工具（21 常驻 + 34 延迟加载；文件读写 / glob / grep / apply_patch / web_search 联网检索（百度→Bing→搜狗→360 降级链）/ web_fetch / Git 六件套 / 待办 / 记忆 / Skill / 审批 / handoff）；只读并行 + 写类串行、60s 幂等缓存、超时与取消真中断（无遗留副作用）、敏感文件默认拒绝、`run_command` 白名单。
- **安全与审批**：`APPROVAL_MODE=risky|all|off`，高风险工具（`git_commit` / `run_command` / 覆盖写 / 敏感文件）触发审批卡并挂起 Run，批准 / 拒绝 / 超时（默认 10 分钟）都会回灌模型；服务默认仅监听 `127.0.0.1`。
- **持久化与恢复**：SQLite（WAL）+ 迁移器，消息 / 运行 / 任务 / 记忆 / 摘要 / usage / 交付件版本 / 工具指标全落库；崩溃重启后未完成 Run 标记 `interrupted`，支持「从断点继续」。
- **可观测与评测**：`run_events` 全链路 Trace（回合耗时 / token / 工具 / 压缩 / 调度决策）、指标面板、FTS 全文检索、反馈闭环；`npm run eval` 用 mock 断言 + baseline 回归门禁保障 prompt 改动质量。
- **异步与通知**：关闭页面后运行继续（`RUN_DETACH_ON_DISCONNECT`）；完成 / 出错 / 待审批通过 WebSocket 推送（重连补发 + 降级轮询）。
- **金融投研（M34）**：三源混合行情网关（东财 / 腾讯 / 新浪直连 + baostock / akshare Python 桥 + 能力级降级链 + 反爬共享模块）；12 个 `fin_*` 工具全量延迟加载（`FINANCE_ENABLED` 默认关闭）；K 线 / 博弈入会话（kline / game 围栏块「送上画布」）与画布（博弈推演 / K 线行情节点，四模型推演直连 API 不耗 LLM，Agent 可经 canvas_write 直接落节点；主区「行情」Tab 已撤除，见 ADR 0098）；K 线快照 `charts/` 进交付件体系；invest 场景五角色协作链（投研快评 / 策略研究预设；多空对弈协议链路——逐轮立论 × 量化走子 × `::: verdict` 终局裁决卡）。
- **调度平台化（M48）**：新建会话零选择直接开聊——**不再有调度官角色**（所有 agent 均为单一业务角色）；未 @ 消息与空编制开场由引擎的**平台路由步（PRS）**自动组队与派发（结构化决策「召集 + 派发」，非角色回合不产生消息 / 不占波次），@ 直达与显式 plan / review 语义零变化；成员增援自动化（handoff 未在场目标自动召集）；全程可审计（事件条 + 广播 + trace `routing:dispatched` 召集 / 派发 / 降级三形状）。

## 文档

- [design.md](design.md)：架构设计总纲（含 ADR 索引与验收清单）
- [docs/api.md](docs/api.md)：全部 HTTP / SSE / WS 接口表
- [docs/operations.md](docs/operations.md)：部署形态、环境变量全表、备份与故障排查
- [docs/adr/](docs/adr/)：116 条架构决策记录（至 ADR 0131 / M54；完整索引与状态汇总见目录 [README](docs/adr/README.md)）

## 环境变量

见 [docs/operations.md](docs/operations.md)（全表 + 说明）与 `.env.example`。常用项：`LLM_API_KEY`（必填）、`LLM_MODEL`、`CONTEXT_BUDGET_TOKENS`、`APPROVAL_MODE`、`BIND_ALL` + `AUTH_TOKEN`、`LLM_MOCK`。

配置优先级：`data/settings.json`（UI 可改，无需重启）> 环境变量 > 内置默认值。

## 技术栈

React 18 · TypeScript 5 · Vite · Tailwind · shadcn/ui（Radix）· lucide-react · zustand · react-markdown · shiki · @tanstack/react-virtual · Express · ws · zod · openai · js-tiktoken · pino · SQLite（node:sqlite + sqlite-vec）· vitest · Playwright
