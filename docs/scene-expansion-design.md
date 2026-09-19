# 场景生态扩展专项设计（M51–M52）：十大新场景 · 命理排盘 · 场景工作区体系

> 状态：**M51–M52 已全部实施**（2026-09-19 收口：M51-A~E 十场景扩展 v33–v37 · M52-A 框架 v38 · M52-B 点亮 v39 · M52-C 既有场景接入 v41 · M52-D 席位发言流 v42；沿线扩展 M53 专业盘面卡 v40；落位详见下条注记）；设计版本 v1.2（2026-09-18；v1 两轮设计合并落盘；v1.1 增补「左对话 + 右工作区」；v1.2 修订：**按场景定制的四形态**（stream / dock / roundtable / arena）+ 28 场景完整清单，不搞一刀切拆分，不触碰全局右栏）
> 范围：**10 个新增场景 / 40 个新角色 / 11 预设 / 5 技能**（PK 博弈 · 社会研讨 · 工作创作 · 生活安居 · 命理占星）＋ **排盘工具四件套**（八字 / 紫微 / 星盘 / 卦）＋ **场景工作区体系**（四形态 + 六面板 + 十二元件 + 三容器族）
> 关联：承接 [docs/scene-chat-design.md](scene-chat-design.md)（M37 基座已实施；M38–M45 内容层继续实施，其中 **M43 PK 范式与本文 §7 arena 形态合流**）；对弈机制复用 invest「多空对弈」先例（M34）；资产规范见 [agents/README.md](../agents/README.md)
> 编号让位（落盘复核 2026-09-18）：**空场景专项已实施**——编号实际落定 **M50（与组队台同批）/ ADR 0103–0106 / design.md §60 / eval 20 / CHANGELOG v32**（0102 由组队台占用；v30 / v31 由工具可达性 / Mock 镜像面占用；见 docs/blank-scene-design.md 头部口径）→ 本专项自 M51 起：里程碑 **M51**（场景资产扩展）/ **M52**（场景工作区体系）；ADR 预定 **0107 / 0108 / 0109**（0106 已被空场景占用）；design.md 收录自 **§61** 起；eval 自 **21** 起；CHANGELOG 自 **v33** 起——动手前按 §10.2 核对清单复核；让位已兑现，无需回移（双索引对齐口径）。
> 实施落位（2026-09-19 收口）：design.md **§61–§67 + §69–§70**（§68 为沿线扩展 M53 盘卡增强）；ADR 实际落位 **0107–0112** 六个（0107 PK 博弈 / 0108 社会研讨 / 0109 工作创作 / 0110 生活安居 / 0111 命理占星 / 0112 场景工作区框架），沿线扩展 **0113**（专业盘面卡 · M53）/ **0114**（arena 席位发言流 · M52-D）；CHANGELOG **v33–v42**；§7.5 矩阵统计全量兑现（stream 4 / dock 18 / roundtable 4 / arena 2——29 场景中 24 已声明，stream 四场景按 §7.5 / §7.10 口径保持现有列表（设计意图，非欠账）；blank 单 Agent 场景不在工作区体系内）。沿线合流 **M43（PK 范式）× arena**：容器族与形态件落 **ADR 0117–0119 / design.md §72 / CHANGELOG v52**（PK-1..PK-5 全量兑现 §7.9 合流口径，§7.2 目标形态「裁决流 / 论断树 / 报价流」中轴合流同批落地）。
> 落地修订（2026-09-19，M52-H）：roundtable 顶区视觉修正（§7.2 / §7.6 元件面）——席位环几何（头像精确落位环周 / 实心桌面坐沿 / 名字带底色不交叉）与议程清单化（纵向清单 + 状态字 + 竖向轨道线，与环等高并排、撑满余宽）；落位 design.md §80 / ADR 0128 / CHANGELOG v51。
> 落地修订（2026-09-19，M60）：arena 席位发言流实时化与侧栏宽度自适应（§7.2 投影面）——SideFeed 改接 `useSceneLiveMessages` 实时快照（冻结例外仅限纯文本投影面，容器解析面不变）+ 侧栏 `clamp(164px, 20%, 280px)`；落位 design.md §81 / ADR 0129 / CHANGELOG v53。
> 落地修订（2026-09-19，M59）：roundtable 顶区重设计（§7.2 / §7.6 元件面）——顶区收为浅灰卡片带；席位环改俯视圆桌（名字径向朝外四向锚定 / 实心桌面 / 去底色）；议程改横向步骤条（节点 + 连线 + 右端摘要，替换 M52-H 纵向清单——用户明确否决）；汇聚板补折叠 / 关闭 / 恢复（口径同 dock，`ma:sc:rt`）；续修订（同日二轮反馈）：顶区内容组整体居中 + 顶区可收起 / 展开（迷你条 `RtPref.topMini`）。落位 design.md §82 / ADR 0130（0128 → Amended）/ CHANGELOG v54。
> 落地修订（2026-09-19，M54）：chartboard 盘面交互化与参与层（§7.2 / §7.5 面板面）——四张排盘卡（八字 / 紫微 / 星盘 / 卦）在聊天卡与面板均改可派生盘面（纯前端派生，失败回退表格）；面板补合参双泳道 toggle（同人双盘）与档案抽屉（存 / 回看 / 对照）；摇卦台 / 报数 / 研习足迹为卡内参与层（产出一律落草稿）。落位 design.md §83 / ADR 0131 / CHANGELOG v55。
> 仓库无 Git：动手前按 `data/*-backup-<date>/` 惯例做目录快照；清理 / 回滚不可恢复。

---

## 1. 背景与目标

### 1.1 现状与缺口（18 场景 / 73 角色的覆盖分析，2026-09-18 快照）

| 维度 | 现状 | 缺口 |
| --- | --- | --- |
| PK 博弈 | 仅 invest 场景内「多空对弈」（限投资标的，机制成熟：回合制 / 证据 / 量化走子 / verdict 裁决） | 通用观点对抗、利益博弈（谈判）无承接；裁决玩法未泛化 |
| 社会议题 | 无 | 多视角研讨、事实基线、立场图谱、政策伦理视角全空白 |
| 工作向 | 研发 / 营销 / 销售 / 运营 / 财务 / 融资 / 战略基本齐备 | 长文创作、职业发展（求职全流程）、游戏设计三条线空白 |
| 生活向 | 健康 / 家庭 / 学习 / 出行 / 财富 / 个人 | 置业安家（购房决策链）、家庭照护空白 |
| 传统文化 | 无 | 传统数术（八字 / 紫微 / 六爻 / 大六壬 / 梅花 / 七政 / 奇门）与西方占星全空白 |
| 交互形态 | M37 基座已上线（guide/agenda、波次分隔、checklist/choice、收尾卡、导航条）；消息流仍为单一线性列表 | 场景间形态同构：对抗（对弈台）、研讨（圆桌台）、工序（工作区）全部缺失；游戏化元件（回合轴 / 计分板 / 席位环 / 盘面）缺失 |

### 1.2 目标与验收（验收导向）

| 目标 | 验收标准 |
| --- | --- |
| 场景覆盖 | 28 场景全量可用（18 存量 + 10 新增）；每场景 guide / agenda / 协议齐备；`check:agents` 通过 |
| 角色专业 | 40 个新角色均为四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）；handoff 跨场景衔接真实存在；tool 白名单全员含 `handoff` |
| 排盘可验 | 八字 / 紫微 / 星盘 / 卦四类排盘走工具精确计算，附 golden 案例测试；盘面走 `::: pan` 容器结构化输出 |
| 交互分化 | 四形态落地（stream / dock / roundtable / arena）+ 六类工作区面板；28 场景逐个判定（4 stream / 18 dock / 4 roundtable / 2 arena）并给出专属细化；任何异常回退 stream（零破坏） |
| 保线性事实源 | 消息序列 / Run 恢复 / SSE 重附着 / fork / 压缩 / 导出语义零变化；四形态与容器全部为视图层派生 |
| 零回归 | 四包 typecheck / lint / 双端 vitest / build / check:agents / check:skills / eval / E2E 全绿；主包 gzip 增量受控 |

---

## 2. 定位与边界（与既有资产切割）

| 既有 | 定位 | 与本专项关系 |
| --- | --- | --- |
| 空场景专项（M50，已实施） | 单助手直聊（无业务角色） | 编号让位（§ 头部）；资产零交叉（`blank`/`general` 不与本专项任何 id 冲突） |
| scene-chat-design（M38–M45） | 消息内容层卡片族（点子池 / 判定卡 / 裁决卡…） | **互补叠加**：内容层照原批次实施；本专项新增形态层（§7 四形态）；M43 与 arena 形态合流 |
| invest 多空对弈（M34） | 投资标的对抗推演（算出的结论） | 机制样板复用（回合制 / 证据挂载 / verdict / 落盘纪律），debate / negotiation 泛化承载「对话过程的对抗呈现与裁决」 |
| development / marketing 等存量场景 | 生产型协作 | 仅新增 `stage` 声明（可选字段；未声明即 stream），角色 / 协议 / 消息零改动 |
| 命理排盘工具（新增） | 纯计算只读工具（干支 / 星历 / 卦爻） | 与 `fin_*` 同为「专业域工具」模式：deferred 加载、白名单授权、无审批（无副作用） |

---

## 3. 设计原则与红线

**沿用 M37 §3.1 全部七条**：线性主干不变（视图层派生，不动消息协议）· 流式纪律（流式纯文本、完成态挂载）· 结构键契约（`role~runId~turnIndex`）· 安静模式与 reduced-motion 登记 · 统一回填语义（composerInsert + sessionStorage）· 静默降级（绝不报错 / 空白）· 文案精简口径（不渲染用户头像）。

**新增红线（本专项特有）**：

1. **命理表述纪律**（metaphysics / astrology 场景协议）：文化研习与参考定位，不承诺预测准确；医疗 / 投资 / 法律 / 婚育 / 生死不做结论性建议；禁止恐吓话术与付费化解暗示；术语附白话释义；结论给「参考区间」不给「必然」。
2. **排盘可验**：先出盘（工具 + `::: pan` 容器）、后解读；推演步骤随盘展示可复查；生辰隐私仅用于本次排盘。
3. **形态降级链**：未声明（stream 缺省）/ 未命中 / 数据不足 / 窄屏（<900px）一律回退纯对话流；四形态不得引入任何消息数据层分叉。
4. **社会议题边界**（society 场景协议）：聚焦民生 / 科技 / 文化 / 环境等非政治敏感议题；不作意识形态输出、不煽动对立；争议结论并列呈现。

---

## 4. 总览

### 4.1 场景与角色总账

| 项 | 现状 | 本专项新增 | 落地后 |
| --- | --- | --- | --- |
| 场景 | 18 | +10 | 28 |
| 角色 | 73 | +40 | 113 |
| 预设 | 15 | +11 | 26 |
| 技能 | 46 | +5（negotiation / debate / game-design / chinese-metaphysics / western-astrology） | 51 |
| 头像资产 | 73 | +40（风格化 3D 卡通 v2，512px） | 113 |
| 排盘工具 | 0 | +4（bazi_pan / ziwei_pan / natal_pan / gua_pan） | 4 |
| 场景形态 | 0（仅线性流） | +4 形态 / +6 面板 / +12 元件 / +3 容器族 | 4 |

### 4.2 批次总览

| 批次 | 主题 | 内容 | 依赖 |
| --- | --- | --- | --- |
| M51-A | PK 双场景 | debate / negotiation；技能 debate / negotiation；预设 2 | 无 |
| M51-B | 社会研讨 | society；预设 1 | 无（与 A 可并行） |
| M51-C | 工作创作 | writing / career / gamedesign；技能 game-design；预设 3 | 无 |
| M51-D | 生活安居 | housing / care；预设 2 | 无 |
| M51-E | 命理占星 | metaphysics / astrology；排盘工具四件套；技能 2；预设 3 | 排盘工具先行 |
| M52 | 场景工作区体系 | 四形态 + 六面板 + 十二元件 + 三容器族 + `stage` 声明 + 既有场景分批接入 | M51 资产（stage 声明）；M37 基座；M42 / M43 合流 |

---

## 5. 新增场景详细设计

> 通用规范：目录 `agents/<场景>/`（`_group.yaml` + `_protocol.md` + 各角色包）；角色正文四段骨架；交付件统一 `docs/<文档类型>-<主题>.md`；handoff 指向真实存在的成员（含跨场景）；工具白名单全员含 `handoff`。

### 5.1 批次 A · PK 双场景

#### 5.1.1 `debate` 辩论场

| 字段 | 值 |
| --- | --- |
| description | 观点对抗 PK：正反双方多轮交锋、证据挂载、裁判终局裁决；与投资多空对弈（限标的）和红队挑刺（单向）区隔——通用议题、双向对抗、胜负裁决 |
| icon / theme | `scale`｜红蓝对撞 `["#dc2626","#3b82f6"]` |
| objective | 把有争议的议题辩出边界：什么成立、什么存疑、什么被证伪 |
| chain | `[judge, affirmative, negative, evidence]` |
| 机制 | `rounds: true`（默认 3 轮可调）、`parallel: true`（正反同波立论）；order 102 |
| guide / agenda | 「抛出议题，开一场有裁决的辩论」｜议程：开一场辩论赛 / 单点交锋 / 帮我预演反方 / 复盘上次裁决 |
| stage | `arena`，seats `{left:[affirmative], right:[negative], center:[judge,evidence]}` |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| affirmative | 立言 | 正方辩手 | 立论 / 论证 / 结辩；证据说话、不人身攻击、不偷换概念 | `docs/正方立论-<主题>.md` |
| negative | 砺锋 | 反方辩手 | 质疑 / 反驳 / 反例；找逻辑漏洞与证据缺口 | `docs/反方立论-<主题>.md` |
| evidence | 昭实 | 证据官 | 中立收集事实 / 数据（附来源等级），双方共用；不站队 | `docs/证据清单-<主题>.md` |
| judge | 明断 | 裁判 | 主持回合、记录交锋、终局裁决 + 复盘点评 | `docs/辩论裁决-<主题>.md` |

props 协同：`affirmative ↔ negative` 互为对手；`judge` 终局裁决；`evidence` 供弹药。handoff：`judge → society.moderator`（议题转研讨）、`affirmative/negative → research.scout`（补证据）。

#### 5.1.2 `negotiation` 谈判桌

| 字段 | 值 |
| --- | --- |
| description | 利益博弈 PK：目标 / 底线 / BATNA 设定，多轮出价与让步，教练旁观复盘；真实谈判前的彩排场 |
| icon / theme | `handshake`｜双色博弈 `["#f59e0b","#8b5cf6"]` |
| objective | 在不破裂的前提下逼近对方底线，拿到可落地的成交区间 |
| chain | `[negotiator, counterpart, tactician]` |
| 机制 | `rounds: true`（严格轮流，串行出价）、`parallel: false`；order 104 |
| guide / agenda | 「说说你要谈的事：谈什么、对方是谁、你的底线」｜议程：彩排一轮谈判 / 定谈判策略 / 模拟对手还价 / 复盘上次谈判 |
| stage | `arena`，seats `{left:[negotiator], right:[counterpart], center:[tactician]}` |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| negotiator | 谭成 | 谈判手 | 目标 / 底线 / BATNA；出价序列与让步节奏；代表用户利益 | `docs/谈判策略-<主题>.md` |
| counterpart | 祁弈 | 对手模拟 | 按设定立场与性格真实还价（可配强硬 / 拖延 / 情绪型）；不轻易让步 | `docs/对手档案-<主题>.md` |
| tactician | 苏纵 | 谈判教练 | 旁观识别锚定 / 让步失误；ZOPA 与得失复盘；下一步建议 | `docs/谈判复盘-<主题>.md` |

handoff：`negotiator → legal`（条款）、`→ finance`（金额口径）；`tactician` 与 `career.comp-advisor`（谈薪）联动。

### 5.2 批次 B · 社会研讨

#### `society` 议题圆桌

| 字段 | 值 |
| --- | --- |
| description | 社会议题多方研讨：事实基线 + 立场图谱 + 政策伦理视角，记录共识与分歧；聚焦民生 / 科技 / 文化 / 环境等非政治敏感议题，不作意识形态输出、不煽动对立 |
| icon / theme | `globe`｜青蓝 `["#0ea5e9","#14b8a6"]` |
| objective | 把一个议题看清楚：事实是什么、各方关切是什么、可行的中间路径在哪 |
| chain | `[moderator, fact-checker, stakeholder, policy-advisor]` |
| 机制 | `rounds: true`、`parallel: true`（事实与立场并行梳理）；order 106 |
| guide / agenda | 「抛出一个议题，我们多视角研讨」｜议程：组织议题研讨 / 核查一组说法 / 梳理各方立场 / 对比政策做法 |
| stage | `roundtable`（汇聚板 = 立场泳道 + 共识 / 分歧板；席位环按立场方着色） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| moderator | 齐观 | 议题主持 | 定议题边界、组织多轮研讨、记录共识与分歧、收口观察报告 | `docs/议题观察报告-<主题>.md` |
| fact-checker | 尚真 | 事实核查员 | 事实基线、数据来源分级、辟谣与不确定标注 | `docs/事实基线-<主题>.md` |
| stakeholder | 方衡 | 立场推演官 | 利益相关方地图、各方主张与核心关切、被忽视视角 | `docs/立场图谱-<主题>.md` |
| policy-advisor | 允中 | 政策伦理顾问 | 政策工具与国际经验、公平 / 权利 / 后果框架、可行建议区间 | 并入观察报告「政策伦理」章 |

### 5.3 批次 C · 工作创作

#### 5.3.1 `writing` 创作工作室

| 字段 | 值 |
| --- | --- |
| description | 长文创作全流程：选题策划 → 主笔成稿 → 编辑定稿 → 出版发行；与营销文案（content）和技术文档（tech-writer）区隔——文学 / 长文 / 出版向 |
| icon / theme | `pen-tool`｜纸墨褐 `["#92400e","#d97706"]` |
| objective | 把想法变成可发表的成稿，并找到合适的发布路径 |
| chain | `[storyline, author, editor, publisher]` |
| 机制 | `parallel: false`（串行创作链）；order 110 |
| guide / agenda | 「想写点什么？长文、专栏、小说、剧本都可以」｜议程：打磨选题与大纲 / 起草一段正文 / 编辑润色这稿 / 规划发布路径 |
| stage | `dock` · panel `board`（文稿台：版本线 + 字数 / 进度） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| storyline | 曲径 | 选题策划 | 选题、切入角度、大纲与叙事结构；受众与调性定位 | `docs/选题大纲-<主题>.md` |
| author | 文藻 | 主笔 | 正文创作与按编辑意见修订；保风格一致 | `docs/文稿-<主题>.md` |
| editor | 锦言 | 编辑 | 润色、校对、风格统一；给修改意见（不越权改写） | `docs/定稿-<主题>.md` |
| publisher | 书远 | 出版顾问 | 投稿 / 出版路径、版权与 IP 运营建议 | `docs/出版方案-<主题>.md` |

handoff：`publisher → ip`（版权 / 商标）、`→ marketing.pr`（宣发）。

#### 5.3.2 `career` 职业发展

| 字段 | 值 |
| --- | --- |
| description | 求职全流程：职业定位 → 简历打磨 → 模拟面试 → offer 谈判；求职者视角（与招聘方视角的 recruiter 区隔） |
| icon / theme | `target`｜职场青绿 `["#0f766e","#2dd4bf"]` |
| objective | 从「我想换工作」到「拿到并谈好 offer」的完整陪跑 |
| chain | `[career-advisor, resume-coach, interview-coach, comp-advisor]` |
| 机制 | `parallel: false`；order 112 |
| guide / agenda | 「说说你的求职方向与现状」｜议程：职业定位与路径 / 打磨简历 / 模拟一轮面试 / 评估与谈 offer |
| stage | `dock` · panel `coach`（求职进度环 + 产出物） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| career-advisor | 程途 | 职业顾问 | 定位、路径规划与转行决策；行业信息与技能差距分析 | `docs/职业规划-<主题>.md` |
| resume-coach | 履新 | 简历顾问 | 简历 / 作品集 / 职业档案优化；STAR 化改写 | `docs/简历-<主题>.md` |
| interview-coach | 问达 | 面试教练 | 模拟面试官逐轮提问 + 候选人复盘（PK 彩排玩法） | `docs/面试手册-<主题>.md` |
| comp-advisor | 薪言 | 薪酬顾问 | offer 评估与谈薪策略；跨场景 handoff 至 negotiation 彩排 | `docs/offer评估-<主题>.md` |

handoff：`comp-advisor → negotiation.negotiator`（谈薪彩排）、`career-advisor → ops.hr`（岗位视角）。

#### 5.3.3 `gamedesign` 游戏工坊

| 字段 | 值 |
| --- | --- |
| description | 游戏内容设计：玩法 / 数值 / 叙事 / 玩法验证；产出 GDD 等设计件（与写代码的 development 区隔） |
| icon / theme | `flame`｜紫粉 `["#7c3aed","#ec4899"]` |
| objective | 从玩法点子到可验证的设计文档：核心循环成立、数值不崩、叙事自洽 |
| chain | `[game-designer, balance-designer, narrative-designer, playtester]` |
| 机制 | `parallel: true`（玩法 / 数值 / 叙事并行）、`rounds: false`；order 108 |
| guide / agenda | 「说说想做的游戏：类型、平台、核心体验」｜议程：立项与核心循环 / 设计数值体系 / 搭建世界观 / 模拟验证平衡 |
| stage | `dock` · panel `board`（GDD 目录树 + 数值曲线卡） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| game-designer | 游心 | 玩法策划 | 核心循环与机制设计；GDD 主笔 | `docs/游戏设计文档-<主题>.md` |
| balance-designer | 千衡 | 数值策划 | 成长 / 经济曲线、平衡表与模拟验算 | `docs/数值平衡表-<主题>.md` |
| narrative-designer | 织境 | 叙事策划 | 世界观、角色与剧情线 | `docs/世界观设定-<主题>.md` |
| playtester | 百试 | 玩法验证 | 对局模拟验证平衡与上手体验；出测试报告 | `docs/玩法测试报告-<主题>.md` |

### 5.4 批次 D · 生活安居

#### 5.4.1 `housing` 置业安家

| 字段 | 值 |
| --- | --- |
| description | 购房决策链：选房对比 → 贷款测算 → 装修规划；与日常家务（home）和理财（wealth）区隔——置业专项决策 |
| icon / theme | `map`｜砖橙 `["#c2410c","#fb923c"]` |
| objective | 用数据做次不后悔的置业决策：买得起、住得好、预算不失控 |
| chain | `[home-finder, mortgage-advisor, reno-designer]` |
| 机制 | `parallel: false`；order 114 |
| guide / agenda | 「说说买房 / 租房的需求与预算」｜议程：梳理需求与看房清单 / 测算贷款方案 / 规划装修预算 / 对比候选房源 |
| stage | `dock` · panel `board`（对比矩阵 + 预算计算） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| home-finder | 择邻 | 选房参谋 | 需求梳理、看房清单、砍价策略；地段 / 户型 / 通勤权衡 | `docs/选房对比-<主题>.md` |
| mortgage-advisor | 家树 | 房贷顾问 | 贷款方案、还款测算、税费；handoff 至 wealth 做总资产检视 | `docs/贷款方案-<主题>.md` |
| reno-designer | 筑居 | 装修规划 | 预算、风格、施工排期与验收清单 | `docs/装修方案-<主题>.md` |

handoff：`mortgage-advisor → wealth`、`→ finance.legal`（购房合同条款）。

#### 5.4.2 `care` 家庭照护

| 字段 | 值 |
| --- | --- |
| description | 家庭照护支持：照护规划 / 陪诊协助 / 康养活动；**非医疗诊断**，不做诊断、不开药、不替代医生，异常症状直接建议就医 |
| icon / theme | `heart-handshake`｜暖粉 `["#be185d","#f472b6"]` |
| objective | 让照护有方案、有排班、有记录，让家人安心、自己不透支 |
| chain | `[care-planner, care-escort, elder-advisor]` |
| 机制 | `parallel: false`；order 116 |
| guide / agenda | 「说说需要照护的家人情况与你最操心的事」｜议程：制定照护方案 / 准备一次陪诊 / 适老化与康养建议 / 整理照护排班 |
| stage | `dock` · panel `coach`（照护排班表 + 就医清单） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| care-planner | 顾宁 | 照护规划师 | 照护方案、排班与资源协调；并发症预警清单（非诊断） | `docs/照护方案-<主题>.md` |
| care-escort | 陪安 | 陪诊助手 | 就医准备、资料整理与就诊记录；只记录不解读医嘱 | `docs/陪诊记录-<主题>.md` |
| elder-advisor | 颐和 | 康养顾问 | 适老化改造、康养活动与情绪陪伴 | `docs/康养建议-<主题>.md` |

### 5.5 批次 E · 命理占星

#### 5.5.1 `metaphysics` 传统数术（7 角色）

| 字段 | 值 |
| --- | --- |
| description | 传统术数研习：四柱八字 / 紫微斗数 / 六爻 / 大六壬 / 梅花易数 / 七政四余 / 奇门遁甲；排盘可验、过程可查，文化研习与参考定位 |
| icon / theme | `moon`（备选新注册 `moon-star`）｜玄墨金 `["#1e293b","#f59e0b"]` |
| objective | 以传统术数为镜做文化研习与决策参考；先盘后论、表述克制 |
| chain | `[bazi, ziwei, liuyao, meihua, qizheng, daliuren, qimen]` |
| 机制 | `parallel: true`（多术可同波并行）、`rounds: false`；order 118 |
| guide / agenda | 「提供生辰或起卦信息，开始研习」｜议程：排盘解读 / 多术合参 / 择时参考 / 术语答疑 |
| defaultSkills | `chinese-metaphysics`（新建） |
| stage | `dock` · panel `chartboard`（多盘 tab 面板） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| bazi | 观复 | 四柱研习师 | 四柱 / 十神 / 五行强弱 / 大运流年；先盘后论 | `docs/八字命盘-<主题>.md` |
| ziwei | 星垣 | 紫微研习师 | 十二宫 / 主星与四化 / 大限流年；逐宫讲解 | `docs/紫微命盘-<主题>.md` |
| liuyao | 灼见 | 六爻研习师 | 起卦装卦（六亲六神世应）、爻位关系与应期参考 | `docs/六爻卦解-<主题>.md` |
| daliuren | 溯机 | 大六壬研习师 | 四課三傳 / 天地盘 / 遁干；课传结构与议题对应 | `docs/大六壬课解-<主题>.md` |
| meihua | 心易 | 梅花研习师 | 体用互变 / 起卦取数 / 象数理串联 | `docs/梅花卦解-<主题>.md` |
| qizheng | 步天 | 七政研习师 | 七政四余星历盘 / 十二宫位 / 星曜庙旺；中西星盘互参 | `docs/七政星盘-<主题>.md` |
| qimen | 奇正 | 奇门研习师 | 九宫局盘 / 三奇六仪 / 用神落宫与方位时段参考 | `docs/奇门局解-<主题>.md` |

跨场景 handoff：`bazi ↔ ziwei`（命盘合参）、`liuyao ↔ meihua`（卦象互参）、`qizheng ↔ astrology.natal`（中西星盘互参）、`qimen → astrology.horary`（择时联动）。

红线：见 §3 第 1–2 条（表述纪律 + 排盘可验）。

#### 5.5.2 `astrology` 星象占星（4 角色）

| 字段 | 值 |
| --- | --- |
| description | 专业占星视角：本命盘 / 行运 / 合盘 / 卜卦择时；盘面为据、表述克制；与七政四余（中国星历）互参 |
| icon / theme | `star`｜星夜蓝紫 `["#312e81","#a5b4fc"]` |
| objective | 用星盘语言看清主题与时机，给参考不给宿命 |
| chain | `[natal, transit, synastry, horary]` |
| 机制 | `parallel: true`、`rounds: false`；order 120 |
| guide / agenda | 「提供出生时间与地点，开始排盘」｜议程：本命盘解读 / 行运与流年 / 合盘分析 / 择时参考 |
| defaultSkills | `western-astrology`（新建） |
| stage | `dock` · panel `chartboard`（星盘轮盘 + 相位表） |

| id | 角色 | 职衔 | 职责（要点） | 交付件 |
| --- | --- | --- | --- | --- |
| natal | 司辰 | 本命占星师 | 行星 / 星座 / 宫位 / 相位；元素模式平衡与关键格局 | `docs/本命盘报告-<主题>.md` |
| transit | 星移 | 行运占星师 | 行运 / 次限三限 / 流年重点期与触发点（附时间窗） | `docs/行运报告-<主题>.md` |
| synastry | 合璧 | 关系占星师 | 合盘 / 组合盘：吸引力与摩擦点、相处模式建议 | `docs/合盘报告-<主题>.md` |
| horary | 问星 | 卜卦择时师 | 卜卦盘与择时盘：问题对应与时间窗 | `docs/择时报告-<主题>.md` |

### 5.6 PK 对弈统一机制（对弈协议模板）

debate / negotiation 与 invest 多空对弈共用一套对弈协议（写进各场景 `_protocol.md`）：

1. **回合制**：默认 3 轮，用户可指定或中途叫停；每轮必须回应对方上一轮论点 / 报价，禁止复读与自说自话。
2. **挂证据与置信度**：辩论每轮立论挂证据 + 置信度（高 / 中 / 低）；谈判每轮记录报价、让步幅度与理由。
3. **终局裁决**：复用 `::: verdict` 容器——辩论给「胜负 + 置信度 + 核心依据 + 翻盘条件」；谈判给「成交区间（ZOPA）+ 得失评分 + 改进点」。
4. **落盘与声明**：裁决书 / 复盘写入 `docs/`，声明「模拟推演」性质；收尾由裁判 / 教练统一 @用户。
5. **并行纪律**：正反双方可同波立论（`parallel: true`）；谈判严格串行（等待对方回应）。

---

## 6. 命理排盘工具（M51-E 专项）

### 6.1 工具清单与契约（v1 四件套）

| 工具 | 门类 | 输入（要点） | 输出（要点） | 库候选 |
| --- | --- | --- | --- | --- |
| `bazi_pan` | 四柱八字 | 公历 / 农历（含闰月）+ 时辰、性别、出生地经度、真太阳时开关 | 四柱干支、十神、藏干、五行统计、起运与大运列表、流年序、校正告警 | `lunar-javascript`（lunar-typescript） |
| `ziwei_pan` | 紫微斗数 | 同上 | 十二宫（宫名 / 主星辅星 / 四化）、五行局、命主身主、大限 | `iztro` |
| `natal_pan` | 西方星盘 | 出生时刻（UTC + 时区）、经纬度、宫位制（默认 Placidus） | 行星（黄经 / 星座 / 度数 / 宫位 / 逆行）、宫头、相位矩阵、四轴 | `astronomy-engine` + 自研宫位 / 相位算法 |
| `gua_pan` | 六爻 / 梅花起卦装卦 | 方式（时间 / 摇卦 / 数字）、随机种子、问题、起卦法 | 本卦 / 变卦 / 互卦、六亲六神、世应、动爻；梅花体用 | 自研（规则代码化；种子可复现） |

契约示例（`bazi_pan`）：

```json
// 输入
{ "birth": "1990-05-12 14:30", "calendar": "solar", "gender": "male",
  "longitude": 116.4, "trueSolarTime": true, "timezone": "Asia/Shanghai" }
// 输出
{ "pillars": { "year": "庚午", "month": "辛巳", "day": "丙申", "hour": "乙未" },
  "tenGods": { "...": "..." }, "wuxing": { "wood": 2, "fire": 3, "earth": 2, "metal": 1, "water": 0 },
  "startLuck": { "age": 6, "date": "1996-08-03" }, "luckPillars": ["壬午", "癸未", "..."],
  "warnings": ["已按真太阳时校正 -12 分钟"] }
```

### 6.2 实施约定

- **deferred 加载**（M28 先例）：`tool_search`「排盘 / 命盘 / 星盘」激活；白名单配给 metaphysics / astrology 全员；纯计算只读、无审批。
- **依赖引入**：`server/package.json` 新增上述库（均纯计算、无网络、无副作用）；工具实现落 `server/src/tools/`，命名与 `fin_*` 同为领域前缀模式。
- **精度约定**：真太阳时默认开启并给校正告警；农历闰月显式入参；星盘时区必须显式（缺省拒绝并提示）。
- **失败语义**：库计算失败 → 结构化错误 + 建议（如「请补充出生地经度」），禁止模型心算兜底冒充工具结果。

### 6.3 二期门类（v1 对话推演 + 明确「未工具化」声明）

| 门类 | 说明 |
| --- | --- |
| 七政四余 | 需中国星历与四余算法，开源稀缺；v1 用 `natal_pan` 星历近似 + 对话推演，标注精度边界 |
| 大六壬 | 四課三傳算法复杂；v1 对话推演 + 结构展示，二期评估自研 |
| 奇门遁甲 | 局盘算法复杂；同上 |

### 6.4 容器契约与测试

- **落盘链路**：角色调工具 → 输出 `::: pan <type>` 容器（内嵌工具输出摘要）→ 前端渲染盘面；容器与工具输出对齐（见 §7.5）。
- **golden 案例**：固定已知答案案例集（八字四柱 / 紫微盘 / 星盘各 ≥3 例；卦用固定种子复现）——新增 `server/tests/m51-pan.test.ts`（或按实施时里程碑号命名），断言工具输出与参考值一致。
- **eval**：新增命理 golden 任务（≥1：排盘工具调用 → 盘面容器 → 解读文本路径）。

---

## 7. 场景工作区体系（M52）：按场景定制的四种形态

### 7.1 定位与边界

| 项 | 说明 |
| --- | --- |
| 是什么 | **Chat 区域内部**的按场景定制呈现：形态与场景匹配（纯对话流 / 左对话+右工作区 / 圆桌台 / 对弈台）；消息协议、数据层完全不变 |
| 不是什么 | **不搞一刀切**——不是所有场景都左右拆分；不改全局右栏（团队 / 交付件 / 任务 / 记忆 / 指标 / 连接 / 实况等面板注册表零改动）；不改消息数据层；不新建主区 Tab |
| 与内容层关系 | M38–M45 消息内嵌卡片（点子池 / 来源卡 / 判定卡…）照原批次实施；四种形态是其「常驻聚合与舞台视图」——卡片管「一条消息」，形态管「整场会话」 |

红线沿用 §3（线性主干不变、流式、结构键、quiet、回填、静默降级、窄屏回退）。

### 7.2 四种形态（按场景定制 + 判定原则）

| 形态 | 结构 | 专属交互 | 适用判定 |
| --- | --- | --- | --- |
| `stream` 纯对话流 | 现有 chat 列表（虚拟列表 / 波次 / 卡片），零新增结构 | 无——对话即全部（M37 增强已够用） | 接力 / 文件型产出；无「持续演进视图」；无对抗 / 研讨结构 |
| `dock` 左对话 + 右工作区 | 左 = 消息流；右 = 场景工作区（默认 360px，可拖宽 280–640 / 双击复位 / ←→ 键盘微调 / 折叠 / 关闭，localStorage 记忆；**无数据不展示**——面板就绪后才渲染，M58） | 工作区实时聚合（盘面 / 看板 / 打卡 / 矩阵…）；点条目回填 | 存在「过程中持续演进、反复查看与交互」的单一专属视图 |
| `roundtable` 圆桌台 | 中 = 消息流；顶 = 席位环（当前发言高亮 + 等待序）；右 = 汇聚板 | 席位轮转可见；汇聚板收敛（点子 / 来源 / 立场 / 选项） | 多方研讨（发散 / 检索 / 研判 / 立场）且需要「收敛物」沉淀 |
| `arena` 对弈台 | 左 = 左席发言流；中轴 = 回合轴 + 裁决流；右 = 右席发言流（顶部计分板） | 回合制推进；左右席对峙；终局裁决仪式 | 回合制对抗：立场对抗（辩论）、利益博弈（谈判），需胜负 / 成交裁决 |

**判定原则**：① 先问「会话过程有没有一个持续演进的专属视图」——没有 → `stream`；② 有 → 回合制对抗 → `arena`；多方研讨 + 收敛沉淀 → `roundtable`；其余 → `dock`。③ 形态由场景 `_group.yaml` 声明，用户可在会话内随时切回 `stream`（兜底永远可用）。

### 7.3 统一规范（四种形态共用）

1. **数据来源**：纯前端派生（消息容器解析 + artifacts + 消息元数据 + agenda 资产）；交互态（点亮 / 勾选 / 折叠）存 sessionStorage（键 `ma:sc:*`），不落库；
2. **交互回填**：一切点击只写 Composer 草稿（composerInsert 统一回填语义，由用户确认发送）；点条目可 focusMessage 定位来源消息；
3. **空态与就绪（M58 修订）**：**无数据不展示**——面板就绪（六口径见 [design.md §79](../design.md)）前工作区整体不渲染（dock 直通纯对话流 / roundtable 无汇聚板 / 窄屏无抽屉），就绪自动出现（挂载即真实数据）；组件级空态引导文案保留为宿主兜底——不空白、不报错；
4. **流式与降级**：流式期间工作区不更新（完成态才挂载重组件）；解析失败回退空态；quiet / reduced-motion 去动效；窄屏（<900px）右区收起为底部抽屉（默认收起），`arena` 降级为「单流 + 席位高亮 + 回合轴」；
5. **性能**：各形态仅订阅本会话 store 切片（500ms 节流，复用 MessageRail 先例）；不参与虚拟列表结构键契约。

### 7.4 工作区面板类型（dock 右区 / roundtable 汇聚板的内容注册表）

| panel | 名称 | 面板形态 | 核心交互 | 用于场景 |
| --- | --- | --- | --- | --- |
| `pool` | 汇聚板 | 卡片墙 / 泳道 / 矩阵（点子 / 来源 / 立场 / 选项） | 点卡「深入 / 引用 / 追问」回填；优选标记 | brainstorm / research / strategy / society |
| `versus` | 局势面板 | 多空计分 + 局势条 + 标的卡（关键位 / 情景 / 信号） | 点信号回填；随对弈轮次更新 | invest |
| `board` | 工序面板 | 版本线 / 目录树 / 对比矩阵（文稿 / 设计 / 房源） | 点节点跳转；点条目回填；版本对比 | writing / gamedesign / housing |
| `console` | 看板面板 | kanban / 指标卡 / 时间轴 / 进程条 | 点卡定位；阶段推进回填 | sales / sre / bi / marketing / funding |
| `coach` | 陪跑面板 | 打卡格 / 进度环 / 日程表 / 清单 | 打卡点亮（sessionStorage）；点项回填 | health / learning / travel / wealth / personal / care / career |
| `chartboard` | 盘面面板 | 多盘 tabs + 盘面渲染 + 高亮联动 | 切盘；点柱 / 宫高亮；「看解读」回填 | metaphysics / astrology |

游戏化机制（学自游戏）：**席位与对阵**（`arena` 阵营分栏、`roundtable` 席位环）、**回合制**（回合轴 + 当前轮高亮）、**计分与局势**（判定累计 / 报价折线 / 置信度条）、**焦点跟随**（当前发言席位高亮；复用 GraphView 导演镜头先例）、**裁决仪式**（verdict 卡 + 彩纸，复用 M37 战绩机制）、**分层阅读**（L1 结论条 / L2 要点 / L3 论据，论证树折叠）、**收敛沉淀**（研讨产物实时汇入汇聚板，避免「聊完即散」）。

### 7.5 28 场景完整形态清单（既有 18 + 新增 10）

| 场景 | 形态 | 面板 | 场景专属细化（内容 / 交互 / 派生） |
| --- | --- | --- | --- |
| development | `stream` | — | 保持现有列表：产出 = 文档与代码（交付件 / 任务归全局右栏）；工序在消息与波次内已清晰，不新建视图 |
| brainstorm | `roundtable` | pool | 汇聚板 = 点子池（编号 / 一句话 / ICE 分 / 来源波次）；顶部阶段条（发散 / 收敛）；点「深入」回填 |
| research | `roundtable` | pool | 汇聚板 = 来源墙（域名 / 等级 / 引用数）+ 证据链（论点→证据）；点「引用」回填、点证据跳消息 |
| strategy | `roundtable` | pool | 汇聚板 = 权衡矩阵（选项 × 维度评分）+ 决议卡；点行聚焦、点「选它」回填 |
| society | `roundtable` | pool | 席位环按立场方着色；汇聚板 = 立场泳道 + 事实卡 + 共识 / 分歧板；点主张回填追问 |
| sre | `dock` | console | 事故时间轴（事件 / 分级色带 / 状态）+ 处置进度；点事件跳消息 |
| bi | `dock` | console | 指标卡区（KPI 汇总 + 口径徽章）+ 取数历史；点卡展开 SQL / 跳消息 |
| marketing | `dock` | console | 战役日历（内容项 × 渠道 × 日期）+ 渠道指标；点条目回填 |
| sales | `dock` | console | 管道看板（阶段 × 线索 / 客户卡）；点卡定位；阶段推进回填 |
| finance | `stream` | — | 保持现有列表：测算过程在消息内、结果归交付件；金额核对类卡片已够用 |
| funding | `dock` | console | 融资进程条（BP → 数据室 → 条款 → 交割）+ 材料清单；点节点回填 |
| ops | `stream` | — | 保持现有列表：事务 / SOP / 招聘以清单与文档为主，无持续视图 |
| invest | `dock` | versus | 多空局势：计分 + 局势条 + 标的卡（关键位 / 情景 / 信号）；点信号回填；随对弈轮次更新 |
| health | `dock` | coach | 三轨打卡格（训练 / 饮食 / 睡眠）+ 周计划；打卡点亮；点计划回填 |
| learning | `dock` | coach | 学习路径（节点 / 进度）+ 打卡；点节点回填 |
| travel | `dock` | coach | 行程表（按天时间轴）+ 预算条；点日程回填；预算展开 |
| wealth | `dock` | coach | 预算环 + 目标储蓄进度 + 账本摘要；点目标回填 |
| home | `stream` | — | 保持现有列表：生活杂谈为主（菜谱 / 家务 / 育儿 / 宠物），无专属视图 |
| personal | `dock` | coach | 事务清单（倒排提醒）+ 习惯打卡；打卡；点事项回填 |
| debate | `arena` | — | 左 = 正方席（立言） / 中轴 = 回合轴 + 裁决 / 右 = 反方席（砺锋）；顶 = 计分板 + 论断树；点回合跳转、点论断展开证据 |
| negotiation | `arena` | — | 左 = 己方（谭成） / 中轴 = 回合 + 教练复盘 / 右 = 对手（祁弈）；顶 = 报价折线 + 筹码条 + 让步刻度；点报价定位 |
| writing | `dock` | board | 文稿台：版本线 + 当前稿目录 / 字数 + 进度；点版本对比；点章节回填 |
| career | `dock` | coach | 求职进度环（规划 → 简历 → 面试 → 谈薪）+ 产出物清单；点阶段回填 |
| gamedesign | `dock` | board | 设计台：GDD 目录树 + 数值曲线卡；点章节回填 |
| housing | `dock` | board | 对比矩阵（房源 × 维度）+ 预算计算；点维度排序；点房源回填 |
| care | `dock` | coach | 照护排班表 + 就医 / 康养清单；点班次回填；清单勾选 |
| metaphysics | `dock` | chartboard | 盘面板：多盘 tabs（八字 / 紫微 / 六爻 / 大六壬 / 梅花 / 七政 / 奇门）；切盘；点柱 / 宫高亮；「看解读」回填 |
| astrology | `dock` | chartboard | 星盘面板：轮盘 + 相位表 + 行运时间条（本命 / 行运 / 合盘 / 择时 tabs）；切盘；点相位高亮 |

统计：`stream` 4 · `dock` 18 · `roundtable` 4 · `arena` 2，合计 28。**既有 18 场景（含当前已支持的存量场景）的逐场景细化见 §7.10。**

### 7.6 游戏化元件库（12 件）

| 元件 | 派生来源 | 用于 |
| --- | --- | --- |
| RoundTrack 回合轴 | turnIndex / wave 事件 | arena |
| Scoreboard 计分板 | 判定容器累计 / offer 容器折线 | arena |
| SeatCard 席位卡 | stage.seats + 成员状态 | arena |
| SeatRing 席位环 | stage 成员 + 发言事件流（当前发言高亮 / 等待序） | roundtable |
| MomentumBar 局势条 | 置信度 / 让步幅度聚合 | arena、roundtable、versus |
| ClaimTree 论证树（分层折叠） | `::: claim` 容器 | arena、roundtable |
| AgendaTrack 议程推进条 | agenda 资产 + 会话进度 | roundtable |
| KanbanBoard 管道看板 | 管道容器（M41 承接） | console |
| ProgressRing / CheckGrid | checklist 容器 + sessionStorage | coach |
| DeliveryPanel 交付件面板 | artifacts（M44 承接） | board、console |
| VerdictCard 裁决卡 | `::: verdict`（已有） | arena、roundtable |
| PanBoard 盘面板 | `::: pan` 容器 | chartboard |

### 7.7 新容器族（Markdown 扩展，remark-ext 新增 builder）

```
::: offer                     # 报价卡（谈判）：金额 / 条件 / 有效期 / 让步幅度
- 报价 | 月租 8500 | 让步 | -300
:::

::: claim                     # 主张卡（辩论，分层折叠）：主张 → 论据 → 证据
主张：……
- 论据 1 | …… | 证据 | 《来源》
:::

::: pan bazi                  # 盘面卡（命理）：结构化盘数据 → 前端渲染盘面
四柱：甲子 丙寅 戊辰 壬戌
十神：偏财 偏印 日主 偏财
大运：……
:::
```

降级链：流式 = 纯文本；解析失败 = 原文；quiet = 静态；窄屏 = 折叠。

### 7.8 声明与实现

`_group.yaml` 新增可选字段（AgentGroupSchema + shared 类型同步，向后兼容）：

```yaml
stage:
  layout: dock             # 缺省 stream（纯对话流）；未命中注册表亦回退 stream
  panel: chartboard        # 仅 dock / roundtable：工作区面板类型（§7.4 注册表）
  seats:                   # 仅 arena：席位分组（成员必须存在，check:agents 校验）
    left: [affirmative]
    right: [negative]
    center: [judge, evidence]
  parts: [round-track, scoreboard, claim-tree]   # 启用元件（缺省 = 场景默认集）
```

前端：新增 `client/src/components/scene/`（形态注册表 + 四形态容器 + 面板注册表 + 元件库）；ChatArea 内部按当前会话 group 的 `stage.layout` 渲染（现有消息流组件复用零改动）；**任何异常一律回退 `stream`**；会话内提供「切回纯列表」开关（localStorage 记忆，quiet 模式自动降静态）；窄屏右区折叠为底部抽屉；全局右栏面板系统零改动。

落地顺序（M52 内分三步）：**M52-A** 框架（四形态容器 + 面板 / 元件注册表 + `stage` 解析 + 降级链；既有场景零声明即 stream）；**M52-B** 新增 10 场景形态（随 M51 批次声明，自此点亮）；**M52-C** 既有场景接入（14 个：roundtable 3 + dock 11，分批 C1 研讨域 → C2 工作域 → C3 生活域，逐场景实现与评审，详见 §7.10）。

### 7.9 与 M38–M45 的关系

- M38–M45（内容层卡片）不受影响，照原顺序实施；四种形态是其常驻舞台（M38 点子池 / 来源卡 → roundtable 汇聚板；M40 三轨打卡 → coach 面板；M41 管道 kanban → console 面板；M44 交付锚点 → board 面板）；
- **M43（PK 范式）与 arena 形态合流**：判定卡 / 裁决卡 / 计分板直接按 arena 落地；若 M52 先于 M43，arena v1 先以「席位分栏 + 回合轴 + 计分板」上线，判定容器接入后自动增强；
  > 落位注记（2026-09-19，M43 已实施）：arena v1 先行（M52-A/D，v38/v42）→ 判定容器族与中轴合流随后兑现——落 **ADR 0117–0119 / design.md §72 / CHANGELOG v52**（含裁决流 / 论断树 / 报价流三面板与 PK-1..PK-5 全量；编号让位见 [docs/scene-chat-design.md §11](scene-chat-design.md) 落位注记）。
- **M42（圆桌会议）与 roundtable 形态合流**：席位环 + 议程条即圆桌的实施载体。

### 7.10 既有 18 场景详细设计（M52-C 接入）

> 接入原则：既有场景**零资产改动**——只追加 `stage` 声明 + 前端面板实现；角色 / 协议 / guide / agenda / 消息零改动。保持纯对话流的 4 个场景**连声明都不加**（缺省即 stream），零代码改动、零回归风险。

#### 7.10.1 保持纯对话流（4 个，零改动）

| 场景 | 判定理由 |
| --- | --- |
| development | 串行接力（pm → architect → designer → frontend → backend → qa → devops），产物全部是文档与代码（交付件归全局右栏）；工序状态在消息与波次内已清晰 |
| finance | 测算 / 合同审查 / 报表解读 / 税务申报 = 文档与计算过程，结论归交付件；金额类消息已可用内嵌卡承载 |
| ops | SOP / 会议纪要 / 行政安排 / 招聘对接 = 清单与文档，无持续演进视图 |
| home | 每周菜单 / 采买 / 家务排期 / 育儿 = 轻量清单杂谈，无专属视图 |

#### 7.10.2 圆桌台（3 个，M52-C1 批）

**brainstorm 头脑风暴**（roundtable · pool）
- 席位环：facilitator 主持 / ideator 发散 / challenger 红队 / refiner 收敛——按当前阶段高亮
- 阶段条：发散 → 收敛（ICE） → 红队 → MVP（与现有 4 条 agenda 天然对齐）
- 汇聚板（点子池）：点子卡（编号 / 一句话 / 提出者 / ICE 分 / 状态：候选 → 入选 / 被毙）
- 交互：点「深入」回填；「入选 / 被毙」标记；点卡跳来源消息
- 派生：`::: ideas` 容器（M38 承接）+ 阶段事件；空态：「先抛一个议题」

**research 深度研究**（roundtable · pool）
- 席位环：lead 定问题树 / scout 检索归档 / analyst 交叉分析 / verifier 事实核查
- 汇聚板（来源墙 + 证据链）：来源卡（域名 / 等级 / 引用数）；证据链（说法 → 证据 → 置信度 → 核查结论）
- 交互：点「引用」回填；点证据跳消息；置信度不足标黄提示补证
- 派生：`::: sources` 容器（M38 承接）+ verifier 核查结论消息

**strategy 商业战略**（roundtable · pool）
- 席位环：chief 收口 / strategist 推演 / pricing 测算（rounds: true 多轮轮流）
- 汇聚板（决策板）：选项权衡矩阵（选项 × 维度评分）+ 经营简报摘卡 + 定价测算摘卡 +「不做清单」
- 交互：点「选它」回填；点行聚焦论证；增删矩阵维度（回填）
- 派生：优先级排序消息 + 简报 + 定价测算

#### 7.10.3 左对话 + 右工作区（11 个，M52-C2 / C3 批）

**sre 站点可靠性**（dock · console，C2）
- 工作区（事故台）：事件时间轴（时间 / 分级色带 / 状态 / 处置动作）+ SLO 与错误预算卡
- 交互：点事件跳消息；「升级 / 止血」回填；分级随消息更新
- 派生：故障响应消息的时间戳与分级 + 复盘报告

**bi 商业智能**（dock · console，C2）
- 工作区（指标区）：指标卡（值 / 口径徽章 / 时间窗）+ 取数历史（问题 → SQL → 结论）
- 交互：点卡展开 SQL；点「下一层」回填归因；口径徽章 hover 出处
- 派生：消息内 KPI / SQL 代码块

**marketing 市场增长**（dock · console，C2）
- 工作区（战役看板）：活动卡（渠道 / 预算 / 指标 / 止损线）+ 发布日历（选题 × 日期）
- 交互：点日历格回填排期；点卡定位消息；止损线达成提示
- 派生：选题日历消息 + 实验卡 + 渠道分析

**sales 销售客户**（dock · console，C2）
- 工作区（客户看板）：线索 / 客户卡（阶段 / 下一动作 / 时间点 / 异议）+ 报价摘卡（折扣边界）
- 交互：阶段推进回填；点卡定位；「下一动作」一键回填跟进草稿
- 派生：跟进动作消息 + 报价条款

**funding 融资资本**（dock · console，C2）
- 工作区（融资进程）：里程碑条（BP → 材料 → 数据室 → 条款 → 交割）+ 材料清单 + 投资人沟通记录
- 交互：点节点回填；材料勾选；「模拟问答」回填
- 派生：进展消息 + 条款估值

**invest 投资研究**（dock · versus，C2）
- 工作区（多空局势）：四路观点卡（基本面 / 技术面 / 舆情 / 量化，各自着色）+ 多空计分与局势条（对弈时）+ 关键位 / 情景
- 交互：点「追问」回填；点信号定位；局势随对弈轮次更新
- 派生：四路分析消息 + `::: verdict` 裁决 + `fin_*` 工具输出

**health 健康生活**（dock · coach，C3）
- 工作区（三轨打卡）：训练 / 饮食 / 睡眠三行周网格 + 本周计划卡 + 复盘提示
- 交互：打卡点亮（sessionStorage）；点计划回填调整；连续打卡徽标（复用 M37 战绩机制）
- 派生：checklist 容器 + 计划消息

**learning 学习成长**（dock · coach，C3）
- 工作区（学习路径）：路径节点（周里程碑 / 状态）+ 进度环 + 练习与检验记录
- 交互：点节点回填「出练习题」；检验结果标记已掌握 / 待复习
- 派生：学习路径消息 + quiz 对话

**travel 出行旅行**（dock · coach，C3）
- 工作区（行程台）：按天时间轴（每日动线 / 交通 / 住宿）+ 预算条 + 行前清单
- 交互：点日程回填调整；清单勾选；预算超限提示
- 派生：行程消息 + 预算测算

**wealth 财富管理**（dock · coach，C3）
- 工作区（财务台）：预算环（固定 / 浮动 / 储蓄）+ 目标储蓄进度 + 复盘摘卡
- 交互：点目标回填；预算占比调整回填
- 派生：预算规划消息 + 储蓄计划

**personal 个人管理**（dock · coach，C3）
- 工作区（事务台）：事务清单（倒排 / 截止 / 提醒）+ 习惯打卡 + 状态摘卡（情绪 / 精力标签）
- 交互：点事项回填；打卡点亮；「到点提醒」标记
- 派生：琐事清单消息 + 目标推进

**接入批次（M52-C）**：C1 研讨域（brainstorm / research / strategy；与 M51-B society 共用 roundtable · pool，先做即四场景受益）→ C2 工作域（sre / bi / marketing / sales / funding / invest）→ C3 生活域（health / learning / travel / wealth / personal）。每批逐场景：声明合入 → 面板实现 → 走查验收（含窄屏降级）。

---

## 8. 配套资产与镜像面清单（每批次核对）

1. `agents/<场景>/`：`_group.yaml`（含 description / guide / agenda / order / 机制 + `stage`）+ `_protocol.md`（铁律 / 协作 / 交付三段式）+ 角色 `AGENT.md`（四段骨架）+ `avatar.png` 512px（风格化 3D 卡通 v2，七维区分）；
2. `agents/_presets.yaml`（§9）、`agents/README.md`（统计与技能预载表）、`agents/CHANGELOG.md`（版本条目 + eval 数字）；
3. `server/src/llm/mock.ts`（DISPLAY_NAMES + preferredOf + 剧本 + artifactFor 与 AGENT.md 一致）、`e2e/helpers.ts`（AGENT_NAME）；
4. `client/src/lib/avatar-icons.ts`（本批图标均已注册；`moon-star` 为可选新增）；工具白名单全员含 `handoff`（m29 断言）；
5. 测试：`m21.test.ts` 场景 / 角色 / 预设断言 + 新场景协议断言；`server/tests/` 排盘工具 golden（M51-E）；eval 新任务（自 21 起）；可选 E2E（PK 链路 + 四形态工作区）；
6. 文档：`design.md` 新章节（自 §61 起）+ ADR（0107 / 0108 / 0109）+ `docs/adr/README.md` 索引；
7. 门禁：四包 typecheck / lint / 双端 vitest / build / `check:agents` / `check:skills` / `eval` / E2E 全绿。

---

## 9. 预设清单（11 个）

| id | 名称 | 成员 | 玩法 |
| --- | --- | --- | --- |
| classic-debate | 辩论赛 | 明断 · 立言 · 砺锋 · 昭实 | 3 轮辩论 → 裁决书 |
| negotiation-rehearsal | 谈判彩排 | 苏纵 · 谭成 · 祁弈 | 定策略 → 多轮出价 → 复盘 |
| issue-roundtable | 议题圆桌 | 齐观 · 尚真 · 方衡 · 允中 | 事实 + 立场并行 → 观察报告 |
| writing-sprint | 写作冲刺 | 曲径 · 文藻 · 锦言 | 选题 → 初稿 → 定稿 |
| job-hunt-sprint | 求职冲刺 | 程途 · 履新 · 问达 · 薪言 | 规划 → 简历 → 模拟面试 → 谈薪 |
| game-kickoff | 游戏立项 | 游心 · 千衡 · 织境 · 百试 | GDD → 数值 / 叙事并行 → 玩法验证 |
| home-purchase | 购房决策 | 择邻 · 家树 · 筑居 | 选房 → 贷款 → 装修 |
| care-plan | 照护规划 | 顾宁 · 陪安 · 颐和 | 方案 → 陪诊 → 康养 |
| chart-combo | 命盘合参 | 观复 · 星垣 | 八字 + 紫微交叉参看 |
| oracle-crossread | 卦象互参 | 灼见 · 心易 | 六爻与梅花两卦对照解 |
| full-horoscope | 星盘全解 | 司辰 · 星移 · 合璧 | 本命 → 行运 → 合盘三段递进 |

preset order：自 160 起顺延（每 10 一个）。

---

## 10. 批次规划与验收

### 10.1 实施顺序

**M51-A（PK 双场景）→ M51-B（社会研讨，可与 A 并行）→ M51-C（工作创作）→ M51-D（生活安居）→ M51-E（命理占星 + 排盘工具）→ M52（场景工作区体系：A 框架 → B 新增场景点亮 → C 既有场景接入；arena 与 M43 / roundtable 与 M42 合流）**。

### 10.2 编号核对清单（每批次动手前复核）

1. 全文检索 M 编号占用（`grep -rn "M5[0-9]"`，M 编号与 ADR 编号独立）；2. `docs/adr/` 最新编号（最新 0106，本专项预定 0107–0109）；3. `design.md` 最新章节（最新 §60，本专项自 §61 起）；4. `evals/tasks/` 最新任务号（自 21 起）；5. `agents/CHANGELOG.md` 最新版本（最新 v32，本专项自 v33 起）；6. 空场景专项（M50）已实施（2026-09-18；ADR 0103–0106 / §60 / CHANGELOG v32）——让位已兑现，无需回移。

### 10.3 验收门禁（每批次）

四包 typecheck / lint 全绿；双端 vitest 全量；`npm run build`（记录主包 gzip 增量）；`npm run check:agents`（含预览清单）；`npm run check:skills`；`npm run eval` mock 基线无回归（改协议 / mock 时先 `--update-baseline` 并复核）；E2E 对应新增 spec + 相邻既有 spec 回归；视觉验收（四形态逐场景走查，含窄屏降级）。

---

## 11. 风险与储备

| 风险 | 缓解 |
| --- | --- |
| 40 角色资产扩张的镜像面遗漏（历史高发） | §8 核对清单逐项打勾；counts 断言（m21）与 mock/helpers 同步先行 |
| 排盘库（lunar / iztro / astronomy-engine）输出与预期口径差异 | golden 案例先行锁定参考值；工具输出附口径字段（如宫位制 / 真太阳时） |
| 四形态对窄屏 / 长会话性能的影响 | 形态全部实现降级链（arena → 单流 + 席位高亮 + 回合轴）；虚拟列表结构键契约不变；主包 gzip 增量受控 |
| 命理内容的合规与观感 | §3 红线 + 场景协议双重约束；表述纪律写进协议铁律 |
| 编号再次冲突（多会话并行） | §10.2 核对清单 + 让位口径（本仓既有先例） |

**储备方向（不在本专项内）**：活动策划（年会 / 婚礼）、跑团剧本杀（玩家向，需先定骰子随机策略）、学术论文（research 扩展）、公益社区、travel / wealth / funding 单角色补强、塔罗（astrology 扩展）。
