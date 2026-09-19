# 架构决策记录（ADR）

本目录记录项目的关键设计决策，每条含背景、结论理由与被否决方案。索引与状态汇总见 [design.md §11](../../design.md)。

**状态说明**：**Accepted**（生效）｜**Amended**（已修订，行为以修订后为准）｜**Superseded**（被新 ADR 取代，保留存档）。

| # | 决策 | 状态 | 引入 |
| --- | --- | --- | --- |
| [0001](0001-server-side-llm-proxy.md) | LLM 调用位置：服务端代理 | Accepted | v1 |
| [0002](0002-autonomous-delegation.md) | 协作范式：自主委派（handoff 工具优先） | Amended | v1 / M3 |
| [0003](0003-sequential-speakers.md) | 发言并发度：顺序执行（M16 起为波次特例，修订见 33） | Amended | v1 / M3 / M16 |
| [0004](0004-await-user-line-start.md) | 交还判定：仅行首 `@用户` | Accepted | v1 |
| [0005](0005-sse-run-stream.md) | 流式通道：SSE | Accepted | v1 |
| [0006](0006-json-session-files.md) | 持久化：每会话 JSON 文件 | Superseded → 18 | v1 |
| [0007](0007-prompt-file-driven.md) | 角色定义：prompts/*.md 文档驱动（M15 由 28 取代） | Superseded → 28 | v1 |
| [0008](0008-fail-fast-without-key.md) | 无 Key 处理：启动即报错（LLM_MOCK 例外） | Amended | v1 / M10 |
| [0009](0009-delta-batching.md) | delta 渲染：40ms 合并（+150ms 渲染节流） | Amended | v1 / M8 |
| [0010](0010-dual-shape-messages-endpoint.md) | 消息接口双形态（新运行 / 插话） | Amended | v1 / M3 |
| [0011](0011-sse-ws-dual-channel.md) | 异步通知通道：SSE + WS 双通道 | Accepted | v1 |
| [0012](0012-run-detached-from-connection.md) | 运行生命周期与连接解耦 | Accepted | v1 |
| [0013](0013-ai-generated-avatars.md) | 头像方案：AI 生图卡通形象照 | Accepted | v1 |
| [0014](0014-workspace-sandbox.md) | 工作区沙箱（+ALLOWED_ROOTS / repo / worktree） | Amended | v1 / M6 |
| [0015](0015-skill-progressive-disclosure.md) | Skill 机制：文档驱动 + 渐进式披露 | Accepted | v1 |
| [0016](0016-light-theme-only.md) | 前端主题：仅浅色 | Superseded → 24 | v1 |
| [0017](0017-artifact-browser-main-tab.md) | 交付件浏览：主区 Tab（+版本 Diff；M49 修订为右栏实况面 + 深度工作台，见 100） | Amended | v1 / M8 |
| [0018](0018-sqlite-persistence.md) | 持久化：SQLite + 迁移 + FTS | Accepted | M1 |
| [0019](0019-context-assembly-compression.md) | 上下文工程：五层装配 + 压缩 + 记忆 | Accepted | M2 |
| [0020](0020-session-mutex-interjection.md) | 会话级互斥 + 插话 + Run 快照恢复 | Accepted | M3 |
| [0021](0021-llm-resilience.md) | LLM 韧性层：重试 / 超时分层 / 限流 / usage | Accepted | M4 |
| [0022](0022-worktree-workspace.md) | worktree 工作区隔离（agent 分支） | Accepted | M6 |
| [0023](0023-hitl-approval.md) | HITL 审批：request_approval + 挂起恢复 | Accepted | M7 |
| [0024](0024-dark-theme.md) | 深色主题（取代 16；M11 被 27 取代） | Superseded → 27 | M8 |
| [0025](0025-frontend-store-performance.md) | 前端性能架构：byId+order / 虚拟列表 / 节流 | Accepted | M8 |
| [0026](0026-observability-eval.md) | 可观测与评测闭环：trace / metrics / eval / feedback | Accepted | M9 |
| [0027](0027-remove-dark-theme.md) | 移除深色主题，回归仅浅色（取代 24） | Accepted | M11 |
| [0028](0028-agent-packages-scenes.md) | Agent 包化与场景分组：agents/ 单包目录（取代 7） | Accepted | M15 |
| [0029](0029-soul-layer.md) | Agent 灵魂层：可选人格变体 + 优先级护栏 | Accepted | M16 |
| [0030](0030-dynamic-members-system-messages.md) | 会话动态成员：members API + system 消息 | Accepted | M16 |
| [0031](0031-scene-protocols-skills.md) | 场景协议分层与技能包绑定 | Accepted | M18 |
| [0032](0032-collaboration-graph.md) | 协作图谱：React Flow 选型 + 前端推导口径 | Accepted | M17 |
| [0033](0033-parallel-waves.md) | Run 内并行波次：显式触发、默认串行（修订 3） | Accepted | M16 |
| [0034](0034-markdown-rendering-extensions.md) | Markdown 渲染扩展：mermaid / chart / 容器语法与包体纪律 | Accepted | M19 |
| [0035](0035-web-search-baidu-anti-bot.md) | 联网检索与反爬：web_search（百度双模式）+ web_fetch 反爬增强 | Accepted | M20 |
| [0036](0036-relay-graph-gameplay.md) | 协作图谱游戏化：拖拽 / 自适应折行赛道 / 双布局 / 导演镜头 / 档案面板 | Accepted | M21 |
| [0037](0037-opc-business-scenes.md) | OPC 业务场景编制：6 场景 19 角色与业务工具纪律 | Accepted | M21 |
| [0038](0038-business-tools.md) | 业务工具集：calc / date_calc / csv_analyze / template_fill（零新增依赖） | Accepted | M21 |
| [0039](0039-business-markdown-cards.md) | 业务 Markdown 卡：kpi / timeline / mail / option 容器 | Accepted | M21 |
| [0040](0040-preset-rosters.md) | 快速组队预设：_presets.yaml 资产化与建会话交互 | Accepted | M21 |
| [0041](0041-graph-interaction-depth.md) | 图谱交互深化：悬停预览 / 键盘导航 / 接力链追踪 / 时间轴回放 | Accepted | M22 |
| [0042](0042-connections-center-cdp-browser.md) | 连接中心与 CDP 浏览器接入：凭据加密 / 会话绑定 / SQL 护栏 / 帧流分权 | Accepted | M22 |
| [0043](0043-live-dock-dual-view.md) | 操作直播窗（LiveDock）与双视图联动：三态浮层 / 自动滑入 / 引用计数 | Accepted | M22 |
| [0044](0044-database-workbench-ssh-terminal.md) | 数据库工作台（Navicat 式）与 SSH 交互终端：共享网格 / 写确认流 / xterm 多会话 | Accepted | M23 |
| [0045](0045-external-skill-adaptation.md) | 外部技能适配规范：来源选择 / 改写原则 / 预载绑定 | Accepted | M23 |
| [0046](0046-artifact-multiformat-preview.md) | 交付件多格式预览：9 类 kind / 服务端零依赖 Office 解析 / 沙箱直出 | Accepted | M24 |
| [0047](0047-vector-memory-sqlite-vec.md) | 向量记忆：sqlite-vec 双后端 / 连接中心凭据 / 四层 scope 与 L1.5 语义召回 | Accepted | M25 |
| [0048](0048-turn-modes-and-plan-approval.md) | 回合范式（规划 / 执行 / 评审）与计划审批挂起：opt-in 门控 / awaiting_plan / 驳回修订 v2 | Accepted | M24 |
| [0049](0049-plan-dispatch-task-board.md) | 计划派发与任务面板 2.0：队列前置派发 / 按成员待办 / 双通道竞态守卫 | Accepted | M24 |
| [0050](0050-asset-console.md) | 资产控制台：ActivityRail + Agent / Skill 管理（软删除 / 引用检查 / 三态与配置矩阵） | Accepted | M26 |
| [0051](0051-browser-page-follow.md) | 浏览器多标签页感知与激活页跟随：Target 发现 / opener 链与空白页观察 / 动作边界切换 | Accepted | M22 |
| [0052](0052-sql-guard-hardening.md) | SQL 护栏加固与 query 只读纵深（诊断修复批）：大小写绕过 / PRAGMA setter / 可执行注释 | Accepted | M22 / M23 |
| [0053](0053-mcp-integration.md) | MCP 接入与管理：官方 SDK 双传输 / 凭据加密 / 会话绑定 / 通配授权与审批策略 | Accepted | M27 |
| [0054](0054-tool-progressive-disclosure.md) | 工具按需发现（渐进披露）：tier 元数据 / BM25+嵌入混合检索 / auto 阈值与 Run 级激活 / MCP JSON 直配文件权威同步 | Accepted | M28 |
| [0055](0055-development-capabilities-code-baseline.md) | 研发场景能力矩阵与编码代理能力基线：handoff 全局接通 / run_command 与 git 写按实现者授权 / 场景工程纪律 / debugging 技能 | Accepted | M29 |
| [0056](0056-bi-agent-nl2sql.md) | BI 场景与 NL2SQL 取数管道：单角色取数分析师 / db 只读三件套 / 取数纪律六条铁律 / nl2sql 技能与 tool_search 引导 | Accepted | M30 |
| [0057](0057-sre-agent-ssh-incident-response.md) | SRE 场景与 SSH 事故响应管道：单角色 SRE 工程师 / ssh_exec + git 只读边界 / 事故纪律十条 / incident-response 技能与 tool_search 引导 | Accepted | M32 |
| [0058](0058-attachments-and-multimodal.md) | 专业级附件体系与多模态通道：双通道上传（base64 / raw 直传）/ 元数据可信化 / 装配护栏视觉注入 / 零依赖文档识别 / 托盘与消息内原生渲染 | Accepted | M33 |
| [0059](0059-infinite-canvas-media-studio.md) | 无限画布与媒体创作工作台：React Flow v12 复用 / 会话级画布文档与乐观锁 / 四媒体适配器与「创建即返回」任务管线 / 脑图工坊 / Agent 闭环四工具与全角色白名单 | Accepted | M31 |
| [0060](0060-session-scheduled-tasks.md) | 会话级定时任务与到点协作：自研 cron 内核与 Intl 时区 / run 与 remind 双动作 / 忙时 skip 与补跑窗口 / 失败自动暂停 / deferred 三件套与 8 角色白名单 | Accepted | M35 |
| [0061](0061-canvas-input-parity-settings-view.md) | 画布输入平权、设置主区页与媒体配置专业化：底部指令条 + 最近回复浮层 / MiniMap 移除 / 设置主区视图（26 项全量 + 资源概览 + 系统信息）/ 能力矩阵与编辑器校验 / pendingEditId 直达编辑 | Accepted | M36 |
| [0062](0062-scene-view-layer-derivation.md) | 场景差异化限定于视图层派生：场景体验全部纯前端从既有消息字段派生，不动消息协议 | Accepted | M37 |
| [0063](0063-scene-assets-guide-agenda.md) | 场景资产扩展走 `_group.yaml`：guide（空态标题）/ agenda（议程模板）随 /api/agents 热更新 | Accepted | M37 |
| [0064](0064-interactive-card-backfill.md) | 交互卡片回填语义 = 生成草稿：composerInsert 只写草稿由用户确认发送；交互态存 sessionStorage 不落库 | Accepted | M37 |
| [0065](0065-wave-separator-and-strip.md) | 波次分隔与定位：分隔行用普通虚拟行（仅结构键）；「当前波次」用滚动位置派生的悬浮条（不用 CSS sticky） | Accepted | M37 |
| [0066](0066-finance-research-suite.md) | 金融投研专项：三源混合网关（Node 源 + Python 桥 + 降级链）/ 反爬共享模块 / 12 个 `fin_*` 全量 deferred / charts 快照 / 行情 Tab 与博弈实验室 / invest 场景四路协作链 | Accepted | M34 |
| [0082](0082-dispatcher-first-class-member.md) | 调度官为显式一等成员：资产角色 + 进入会话成员表，全部不变量原样成立 | Accepted | M46 |
| [0083](0083-dispatch-asset-flag.md) | `dispatch` 资产标记：front-matter `dispatch: true` 全局唯一 + check 校验 + 控制台 round-trip 保留 | Accepted | M46 |
| [0084](0084-empty-selection-session-creation.md) | 空选择创建语义：`POST /sessions` 接受 `[]` → 服务端填充 `[调度官]`；资产缺失 400 | Accepted | M46 |
| [0085](0085-no-mention-dispatcher-routing.md) | 无 @ 路由调度优先：四分支（@ 直达 / 显式范式 / 调度官 / 兜底）；@ 与消息级范式零变化 | Accepted | M46 |
| [0086](0086-invite-members-single-funnel.md) | 召集单一收口：`invite_members` 仅调度官白名单可见；与成员 API 共享 `inviteMembersCore` 内核 | Accepted | M46 |
| [0087](0087-roster-catalog-injection.md) | roster_catalog 注入：仅调度官回合、只列未在场、内容签名 LRU 缓存（2–4k token 预算） | Accepted | M46 |
| [0088](0088-dispatch-wave-execute-plan-deferral.md) | 调度波恒 execute：`planFirst` 顺延业务首波（一次性标记消费）；调度不吃范式 | Accepted | M46 |
| [0089](0089-lazy-participants-tool-runtime.md) | 工具运行时惰性 participants：同回合「先召集后交接」成立；handoff / plan / schedule 三处受益 | Accepted | M46 |
| [0090](0090-dispatch-turn-guard.md) | 调度接手护栏：同一 Run 调度官接手 ≤3 次 + 既有循环检测叠加（超出走常规 fallback） | Accepted | M46 |
| [0091](0091-invite-events-and-broadcast-reuse.md) | 事件与广播复用：「召集了…加入协作」system 条 + `notify:members-changed` + trace `dispatch:invited` | Accepted | M46 |
| [0092](0092-closeout-delivery-manifest.md) | 收尾交付清单化与消息内交付明细：无交付件不渲染收尾卡；清单卡（件数 / 波次 / 作者 / 明细行）+ 消息内明细行；元数据会话级共享缓存（指纹含交付计数）；清单卡展示形态由 0123 修订（分层默认） | Amended | M37 |
| [0093](0093-canvas-interaction-revision.md) | 画布点击 / 拖动 / 选中交互修订：nodeClickDistance 与 nodeDragThreshold 统一 4px（消除吞 click 死区）；mergeNodes 重建转抄 selected；K 线图表区 nodrag + nowheel | Accepted | M31 / M34 |
| [0094](0094-dispatch-priority-over-handback.md) | 派发优先于交还报备：mergeWaveSchedule 先收集 accepted 再判交还（`allHanded` 需无成员接手）；成员接手口径以 accepted 为准 | Accepted | M46-2 |
| [0095](0095-dispatch-closeout-wave.md) | 调度收口波：全链交还用户且队列空时追加调度官收口摘要（每 Run 一次；【收口汇总】指令 + `dispatch:closeout` trace） | Accepted | M46-2 |
| [0096](0096-session-serial-execution.md) | 会话级串行执行：默认开启（迁移 v12）；`globalParallelMax` 收紧为 1（显式 @≥2 亦逐位消化）；TaskView 芯片切换 | Accepted | M46-2 |
| [0097](0097-game-kline-session-canvas.md) | K 线 / 博弈的会话与画布呈现：移除「博弈」Tab 与 GameLab（否决独立面板）；三形态承载（会话块「送上画布」/ 画布节点 GameNode·KlineNode / Agent 通道 canvas_write）；多空对弈协议化 + `::: verdict` 终局裁决卡 | Accepted | M34 |
| [0098](0098-finance-tab-removal.md) | 撤除主区「行情」Tab：移除 FinanceView / KlinePanel / Command Palette 入口与 MainTab 类型（独立面板形态全部收敛）；K 线 / 博弈三形态承载与金融网关 / `fin_*` 工具 / 门控零改动 | Accepted | M34 |
| [0099](0099-tool-availability-gating.md) | 工具可用性门控与失败语义收敛：环境门控单一事实来源（availability.ts）；未启用工具不进模型 schema 与发现范围（执行期守卫双保险）；git 会话模式门；fin_* 精确配置指引；tool_search direct 非失败语义；中断归因 stopped（不落失败指标，驳回 / 超时仍 error） | Accepted | M47 |
| [0100](0100-live-panel-merge-two-level-nav.md) | 右栏实况面板合并与主区收敛：浏览器 / 交付件 / 数据库 / 终端四面合一（face 条即二级）＋ 跟随引擎（自动聚焦 + 护栏：本 Run 锁 / 60s 锁 / 暂停 / 交付件软跟随）；右栏一级收敛为团队 / 运行 / 实况两组一单（lastOf 组记忆、持久化 v2、browser → live）；主区常态仅「对话 / 画布」+ 按需展开的深度工作台；直播窗让位协同；纯前端零协议变更 | Accepted | M49 |
| [0101](0101-platform-routing-step.md) | 调度平台化：撤销调度官「知舟」与 `dispatch` 机制，调度上收引擎；平台路由步（PRS）非角色回合——未 @ / 空编制开场由引擎结构化决策「召集 + 派发」（json_schema，`__router__` 哨兵）；handoff 未在场目标自动召集；空编制创建合法；`invite_members` 移除；trace `routing:dispatched` 三形状 | Accepted | M48 |
| [0102](0102-session-builder-console.md) | 建会话「组队台」三栏重设计：来源（快速组队 / 按场景）→ 角色池 → 编制一次成局（取代两步向导）；窄屏三页签共享同一 pane JSX；来源行整体替换编制并清 souls；选择器锚点 `组队来源：X` / `移出编制`；轻度游戏化（入选态 / `badge-pop` / `.lineup-enter`，安静模式与 reduced-motion 降级）；行为等价不变量与原文案全保留；纯前端零协议变更 | Accepted | M50 |
| [0103](0103-blank-scene-general-agent.md) | 空场景与通用助手资产：`blank` 场景 + `general` 角色（无业务人设 / 无 souls / 无 handoff）；工具复用 M28 分层（core 常驻 + deferred 按需）；mock 范式信号适配（general 白名单常驻 write_plan / submit_review 不折叠） | Accepted | M50 |
| [0104](0104-solo-blank-direct-routing.md) | 单助手直通路由：编制恰为 `[general]` 且场景 `blank` → 未 @ 消息直达（跳过 PRS）；实时派生（加人即退出）；`BLANK_SCENE_ID` 共享常量；单成员业务会话零变化 | Accepted | M50 |
| [0105](0105-general-agent-non-recruitable.md) | 通用助手不可自动召集：三层隔离（roster_catalog 不列 / knownIds 过滤幻觉召集 / resolveAgent 拒「不在场」）+ 白名单无 handoff；用户手动邀请保留 | Accepted | M50 |
| [0106](0106-blank-scene-entry.md) | 空场景入口形态：组队台「来源」栏顶部独立卡（微标「单 Agent · 1 位成员」）+「按场景组队」列表过滤 blank（去双入口）；命令面板等派生面零特判 | Accepted | M50 |
| [0107](0107-pk-duel-protocol-generalization.md) | PK 对弈协议泛化——辩论场与谈判桌：对弈协议三场景共用（回合制 / 挂证据与置信度 / `::: verdict` 终局 / 模拟推演声明）；debate 4 角色（正反并行立论 + 中立证据官）+ negotiation 3 角色（严格串行出价 + 对手模拟）；技能 debate / negotiation + 预设 classic-debate / negotiation-rehearsal；镜像面七件套 + eval 21/22 | Accepted | M51-A |
| [0108](0108-society-roundtable-protocol.md) | 社会研讨协议——议题圆桌：议题边界红线 + 事实分级（来源等级 / 核验状态）与立场并列（价值分歧不判胜负）；观察报告两版覆盖（开场骨架 → 政策伦理收口）；society 4 角色（主持 / 事实核查 / 立场图谱 / 政策伦理）+ 预设 issue-roundtable；judge → moderator 回填关闭；镜像面七件套 + eval 23 | Accepted | M51-B |
| [0109](0109-work-creation-protocol.md) | 工作创作协议——创作工作室 · 职业发展 · 游戏工坊：原创底线 / 履历真实 / 核心循环先行三条领域红线；writing 串行创作链 + career 串行陪跑链 + gamedesign 三路并行设计（parallelMax 3）；技能 game-design + 预设 writing-sprint / job-hunt-sprint / game-kickoff；tactician → comp-advisor 回填关闭；镜像面七件套（TOPICS +1「求职」）+ eval 24/25 | Accepted | M51-C |
| [0110](0110-home-care-protocol.md) | 生活安居协议——置业安家 · 家庭照护：预算纪律 / 非医疗诊断两条领域红线；housing 串行决策链（选房 → 贷款 → 装修）+ care 串行照护链（方案 → 陪诊 → 康养）；技能零新建 + 预设 home-purchase / care-plan；镜像面七件套（TOPICS +2「购房 / 长辈」）+ eval 26/27 | Accepted | M51-D |
| [0111](0111-metaphysics-astrology-protocol.md) | 命理占星协议——传统数术 · 星象占星（含排盘工具四件套）：表述纪律 / 排盘可验两条领域红线；bazi_pan / ziwei_pan / natal_pan / gua_pan（deferred + 激活词「排盘 / 命盘 / 星盘」+ golden 21 例）+ `::: pan` 容器（remark-ext builder + PanCard 渲染）；metaphysics 7 角色（多术并行）+ astrology 4 角色；技能 chinese-metaphysics / western-astrology + 预设 chart-combo / oracle-crossread / full-horoscope；镜像面七件套（TOPICS +1「前程」）+ eval 28 | Accepted | M51-E |
| [0112](0112-scene-workspace-system.md) | 场景工作区体系——四形态容器 · 六面板注册表 · 12 元件库：stage 类型（layout / panel / seats / parts 可选，未声明即 stream）＋ resolveStage 降级链（未声明 / 非法 / arena 缺席位 / listMode → stream）＋ dock 右工作区（拖宽 / 折叠 / 关闭 / 抽屉）＋ roundtable 席位环 ＋ arena 席位分栏（§7.9 v1）；六面板 + 12 元件组合；纯前端派生 + 500ms 节流 + 流式冻结 + 「切回纯列表」开关 + quiet/reduced-motion；纯前端 + 一个 shared 可选字段；dock 宽度（340→360 / clamp 260–520→280–640）、折叠 / 关闭钮注入面板标题行、空态收口为「无数据不展示」（就绪判定）由 0127 修订 | Amended | M52-A |
| [0113](0113-professional-pan-cards.md) | 专业排盘卡——四张盘面卡结构化重写：计算层字段扩展（旬空 / 地势 / 胎元四宫 / 来因宫 / 生年四化 / 元素模式 / 卦气旬空 / 错综卦）/ 卡头标题化（多盘 tab 区分）/ 卡体与解析同源 + 契约测试（m53-pan-card 4 例）/ 协议整卡复制 · 卡面复用 · 记录真实性红线 | Accepted | M53 |
| [0114](0114-arena-side-feed.md) | arena 席位发言流投影 · 运行中回合号回填 · 贴底跟随末端锚定：SideFeed 只读投影（excerptOf 摘录 + 点击定位，不拆流不触结构键契约）＋ turn:start 回填 turnIndex（计分板 / 回合轴 / 发言流轮次 / M16 并行组实时恢复）＋ anchorTo:'end'/followOnAppend/overflow-anchor:none 末端锚定（手写补正降为兜底）＋ 运行流订阅晚到兜底（仅 HTTP 非 ok 全量刷新，不伪造结束原因）＋ E2E 口径（虚拟剪枝先滚顶；邀请链路移出运行收束窗口；mock 节奏 20→30ms） | Accepted | M52-D |
| [0115](0115-roundtable-meeting-paradigm.md) | 圆桌会议范式：容器族驱动（`::: meeting` 三态议题 / `::: minutes` 三栏纪要，不引入会话级开关）＋ 议题进度容器化（容器更新优先、本地勾选兜底、running 首未决点亮、点击定位）＋ 派活确认制（待办 `@负责人` 回填草稿，ADR 0064 复用）＋ 散会胶囊（尾条指纹派生）＋ 协议例会纪律与 mock 5 波链路（eval 13） | Accepted | M42 |
| [0116](0116-minutes-mention-handoff-exemption.md) | 纪要容器内 @ 不参与转交解析：`parseMentions` 先剥离 `::: minutes` 块（栈式匹配、未闭合 fail-safe、返回原文）——派活锚点不再误触发 owner 入队（波次外扩修复）；语义单一事实来源在引擎，协议同步「待办 @ 为派活锚点、转交单独起一行」 | Accepted | M42 |
| [0117](0117-pk-explicit-structured-trigger.md) | PK 只做显式结构化触发：三入口（ReviewRecord / `::: debate` / 结构化容器 claim·findings·offer）＋四容器族语法与卡片（条目转 `data-items`、fail-safe 降级）＋「已响应」配对前端推导（编号提及扫描 × 消息粒度签名，排除定义行、尾条不判、不落库）；废弃 mentions 交替启发式与宽松时间窗配对 | Accepted | M43 |
| [0118](0118-duel-inline-two-columns.md) | 对决布局单行内二栏：duel 实现在波次组内部（不跨虚拟行，结构键契约）；duelSides「席位优先（seats 左/右）→ 中轴席（seats.center）→ 姿态兜底（DUEL_STANCE）→ 存在『无站位』成员不成对决；两侧均非空才成立（否则降级普通并行组）」；阶段徽章 + 计分条；窄屏回退单流；center 席不占二栏 | Accepted | M43 |
| [0119](0119-verdict-draft-insert-semantics.md) | 裁决回填遵循统一回填语义：四动作（采纳正/反、两案并保留、再来一轮）只写草稿（composerInsert）不直发不落库；仅最新波挂裁决卡且运行中禁用（防与插话歧义）；计分板与裁决流 / 论断树 / 报价流全部纯前端派生 | Accepted | M43 |
| [0120](0120-browser-headless-and-cdp-resilience.md) | 浏览器启动形态可配置（默认无头）与 CDP 连接韧性：三源决策链（opts → 连接 config → BROWSER_HEADLESS）；保活探测（协议 ping 15s + terminate 半开判定）；断线自动重连（退避 300ms/1s/2.5s，重挂原管理页并恢复帧流，动作入口等待恢复）；帧写库节流（≥5s） | Accepted | M22 韧性增强批 |
| [0121](0121-verdict-status-tolerance-versus-head.md) | 裁决状态容错与局势面板局面头：自然语言前缀解析（「空方领先」→ short，derive / remark-ext 镜像面共用 lib/verdict）+ 条目「胜负」值兜底 + 置信度解析（显式百分比直取；定性词映射仅供幅度、展示留原词）+ 局面头（胜负 + 置信度 chip）+ 局势条「方向 × 置信度」加权 + 元条目（胜负/置信度/声明）剔出信号列 | Accepted | M52-E |
| [0122](0122-verdict-item-side-attribution.md) | 裁决条目多空侧归因：信号列逐条分侧——元信息（胜负/置信度/声明）→ meta；显式阵营词（多方/多头/正方/看多 ↔ long；空方/空头/反方/看空 ↔ short）优先；「翻盘条件」归败方（落后方翻盘路径：空方领先归多方、反之归空方）；其余归裁决方向侧；none 不进列（裁决卡兜底） | Accepted | M52-F |
| [0123](0123-closeout-layered-default.md) | 交付清单分层默认——最终交付优先 · 过程产物折叠：路径首段过程目录（charts / data / raw / cache / tmp / temp / logs）与溢出项折叠进「其他」（组头即箭头，全展示 / 收起；主区为空自动展开）；最终交付按重要度（文档 > 图示与页面 > 媒体 > 源码 > 数据）取前 5；面板入口收敛为头部按钮；纯前端零协议 | Accepted | M37-6 续修订 |
| [0124](0124-media-connections-global-settings.md) | 媒体生成迁入设置——全局连接 · IA 收口：媒体连接全局共享（`providersOf()` 无参走全局清单；绑定接口 `400`，与 embedding 守卫同构）；配置入口迁「设置 → 媒体生成」（连接管理不再呈现；生成面板空态引导与直达编辑改跳该分组）；「启用」即总开关（画布 + Agent 工具） | Accepted | M56 |
| [0125](0125-model-output-sanitization.md) | 模型输出净化与落盘声明审计：`[工具调用]` 仿写日志块整块删除（≥1 条带箭头日志行为命中证据、半截流式安全、幂等）＋ `｜｜DSML｜｜` 协议标记泄漏行清理 ＋ 服务端 6 处收尾点净化（落库 / FTS / 记忆 / 上下文装配全干净，防自我强化）＋ 落盘声明与成功写调用不符 → trace `delivery:unverified` 留痕不阻断 ＋ 前端 rawStreams 对原始全文净化兜底（存量不动库） | Accepted | M55 |
| [0126](0126-member-display-dedup.md) | 成员展示去重——标题栏头像组移除 · 输入条成员条席位让位：标题栏纯装饰头像组删除；`poolHidden`（复用 resolveStage 纯函数）——参与者空 / listMode / fallback 不隐藏、roundtable 恒隐藏、arena 全员入席（left/right/center 并集）才隐藏（有未入席成员保留）；stream / dock 无席位载体照常展示；纯前端派生零协议 | Accepted | M52-G |
| [0127](0127-scene-panel-ready-and-title-chrome.md) | 场景工作区就绪判定与面板标题合行——无数据不展示 · 折叠 / 关闭钮注入 · dock 拖拽增强：`panelReady` 纯函数六口径（宁可多显示不可漏显示）+ `useScenePanelReady` hook——未就绪不渲染工作区（dock 直通纯对话流 / roundtable 无汇聚板 / 窄屏无抽屉），就绪自动出现；PanelChrome context 注入折叠 / 关闭钮（独立操作条删除，标题行「图标 + 标题 + 徽标 + 操作」合行，滚动下沉 `.scene-panel-body`）；宽度 340→360 / clamp 260–520→280–640，拖拽零 React 渲染（ref 直改 + 抬手落盘）+ 双击复位 + 键盘微调（16/48px）+ pointercancel 回滚；组件级空态保留为兜底；纯前端批次 | Accepted | M58 |
| [0128](0128-seat-ring-agenda-refine.md) | 席位环几何修正与议程清单化：座位盒 = 头像盒（名字绝对定位不参与盒居中）——头像中心精确落位环周（4 席半径 54±0.05 / 角度 0°/90°/180°/270°）；桌面虚线圆环改实心圆面（inset 38 与头像内缘 39 相切坐沿）；名字带底色不与圆面交叉、底席外溢由顶区 padding 承接；议程单行 chips 改纵向清单（状态点 + 标签 + 状态字 + 竖向轨道线，与环等高并排、撑满余宽）；类名 / DOM 语义 / 交互零改动；议程形态与环面由 0130 修订（纵向清单 → 横向步骤条 / 名字径向朝外与桌面收束） | Amended | M52-H |
| [0129](0129-arena-side-feed-live-channel.md) | arena 席位发言流实时通道与侧栏宽度自适应：双源接入（`useSceneLiveMessages` 实时快照仅供 SideFeed 纯文本投影面；容器解析面 / 裁决流 / 论断树 / 报价流保持冻结，半截容器不进派生——ADR 0114 口径不变）；`data-streaming` 流式态（描边 + caret-blink 光标，reduced-motion 关闭）；`.scene-arena-side` `164px` → `clamp(164px, 20%, 280px)`（窄宿保底不变、宽宿随宿主放宽 280px 封顶） | Accepted | M60 |
| [0130](0130-roundtable-top-refine-and-panel-collapse.md) | roundtable 顶区重设计与汇聚板收起——俯视圆桌 · 横向步骤条 · 折叠 / 关闭：顶区收为浅灰卡片带（席位环 + 议程步骤条同行居中 + 右端摘要）；SeatRing v3（头像 26 / 环半径 40 / 实心桌面 56；名字径向朝外四向锚定 `data-dir`、无底色；`nameDir` 页面方位角 = θ − 90°）；AgendaTrack v3（纵向清单 → 横向 stepper：节点三态 + 半线拼接连线 + 右端摘要，状态字删除）；汇聚板折叠 / 关闭 / 恢复（chrome 注入标题行 + `ma:sc:rt`，口径同 dock）；ADR 0128 议程形态与环面部分由本 ADR 修订；续修订（同日二轮反馈）：顶区内容组整体居中 + 摘要让位优先级（flex-shrink 99，修复 1280 重叠）+ 顶区收起 / 展开（迷你条 `RtPref.topMini`） | Accepted | M59 |
| [0131](0131-playable-pan-interactive.md) | 可玩盘面——四张排盘卡的交互化与参与式游戏化：交互化 = 纯前端派生（`::: pan` 卡文本 → `model/derive`，必需门不过回退表格；零契约 / 零工具 / 零服务端）；默认盘面 + `ma:pn:view` 切换记忆 + 流式冻结回退；回填一律草稿（ADR 0064 复用）；摇卦台种子可复现（crypto 种子 + mulberry32 现推与 `gua_pan` 逐位一致；报数不本地预测卦名）；档案 `ma:pn:archive` 20 FIFO + 同型对照 / 异类并排；合参年龄轴（八字大运 × 紫微大限双泳道、缺出生年只显年龄）；研习足迹 `ma:pn:trail` 只读无成瘾；协议 #14 摇卦复算核对 | Accepted | M54 |
