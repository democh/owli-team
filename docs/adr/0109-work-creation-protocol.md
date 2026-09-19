# ADR 0109：工作创作协议——创作工作室 · 职业发展 · 游戏工坊（M51-C）

- 状态：Accepted
- 引入：M51-C
- 相关：[design.md §63](../design.md)、[docs/scene-expansion-design.md](../scene-expansion-design.md)、[agents/writing/_group.yaml](../../agents/writing/_group.yaml)、[agents/career/_group.yaml](../../agents/career/_group.yaml)、[agents/gamedesign/_group.yaml](../../agents/gamedesign/_group.yaml)、ADR 0107（回填台账模式：tactician → comp-advisor 本批关闭）、ADR 0108（同批先例）

## 背景

- 场景生态扩展（§5.3）判定三类工作创作需求无承接场景：① 长篇写作（选题 → 文稿 → 定稿 → 出版）散落在 marketing.content / ops.assistant，无完整创作链；② 求职陪跑（定位 → 简历 → 面试 → 谈薪）方向与 hr / recruiter 恰好相反（候选人侧）；③ 游戏设计（玩法 / 数值 / 叙事 / 验证）与 development（工程实现）本质不同——产出设计件而非代码；
- 三条领域红线各锚定一类高频且后果最重的失败模式：写作的抄袭洗稿与引用失范、求职的「教用户编简历」与信息不对称误导、游戏设计的「陷在炫酷设定里不验证核心循环」；
- M51-A 遗留台账：`tactician.handoff → career.comp-advisor`（谈薪彩排转谈判桌）待本批 career 落地后回填。

## 决策

1. **三条领域协议**（写进三份 `_protocol.md`，各 11 条 = 铁律 7 + 工具纪律 2 + 交接 / 声明纪律 2）：`writing`「原创底线」（不抄袭 / 不洗稿具体表达；参考标注来源与差异；编辑边界——只动语言与一致性，不擅改结构观点；事实核对与出版合规）；`career`「履历真实」（不虚构经历 / 学历 / 成果；优化 = 真实亮点 STAR 化；候选人视角与 recruiter 招聘方视角区隔；薪资口径附来源时效、区间表达不承诺数字；隐私纪律）；`gamedesign`「核心循环先行」（操作 → 反馈 → 成长 → 再行动 闭环不成立不进入数值与叙事细化；数值可解释禁魔数；「好玩」是假设须模拟验证；参考与原创标注）；
2. **`gamedesign` 游戏工坊（4 角色）**：chain `[game-designer, balance-designer, narrative-designer, playtester]`、`parallel: true`（`parallelMax: 3`，三路设计并行 + 验证收口）、`rounds: false`、order 108、icon `flame`、theme 紫粉——游心（玩法策划，`docs/游戏设计文档-<主题>.md`）/ 千衡（数值策划，`docs/数值平衡表-<主题>.md`）/ 织境（叙事策划，`docs/世界观设定-<主题>.md`）/ 百试（玩法验证，`docs/玩法测试报告-<主题>.md`）；
3. **`writing` 创作工作室（4 角色）**：chain `[storyline, author, editor, publisher]`、`parallel: false`（串行创作链）、order 110、icon `pen-tool`、theme 纸墨褐——曲径（选题策划，`docs/选题大纲-<主题>.md`）/ 文藻（主笔，`docs/文稿-<主题>.md`）/ 锦言（编辑，`docs/定稿-<主题>.md`）/ 书远（出版顾问，`docs/出版方案-<主题>.md`，handoff → ip / pr）；
4. **`career` 职业发展（4 角色）**：chain `[career-advisor, resume-coach, interview-coach, comp-advisor]`、`parallel: false`（串行陪跑）、order 112、icon `target`、theme 青绿——程途（职业顾问，`docs/职业规划-<主题>.md`）/ 履新（简历顾问，`docs/简历-<主题>.md`）/ 问达（面试教练，`docs/面试手册-<主题>.md`）/ 薪言（薪酬顾问，`docs/offer评估-<主题>.md`，handoff → negotiator / career-advisor）；
5. **技能与预设**：新增 `skills/game-design`（设计分层 / 核心循环画法 / 数值体系 / 叙事咬合 / 玩法验证）；writing / career 复用既有技能零新建（按角色预载 doc-coauthoring / comms-writing / formal-document / deck-authoring / strategic-planning / deep-research / recruiting / negotiation / spreadsheet-modeling）；预设 `writing-sprint`（曲径 · 文藻 · 锦言，order 190）、`job-hunt-sprint`（程途 · 履新 · 问达 · 薪言，order 200）、`game-kickoff`（游心 · 千衡 · 织境 · 百试，order 210）；
6. **回填台账关闭**：`tactician.handoff` 追加 `comp-advisor`（AGENT.md + mock preferredOf + m21 断言三处同步）——谈薪彩排从职业发展转谈判桌；M51 回填台账全部关闭；
7. **镜像面七件套**：mock.ts 四件套 ×12（SCRIPTS / artifactFor 与交付契约对齐 / DISPLAY_NAMES / preferredOf）+ `TOPICS` 演示词表 +1（「求职」尾部追加）+ `e2e/helpers.ts` AGENT_NAME +12（全量 97 角色 id→name 逐一相等）+ `m21.test.ts`（25 场景 / 97 角色 / 21 预设 / 协议断言 +3）+ README / CHANGELOG；
8. **stage 预写（M52-B 消费）**：gamedesign / writing `{layout: dock, panel: board}`、career `{layout: dock, panel: coach}`——工作台形态（dock 侧栏 + 板 / 教练面板），区别于 debate / negotiation 的 arena 与 society 的 roundtable；schema 非 strict，形态消费端 M52-B 实现；本批零前端改动。

## 理由

- **串行 / 并行的差异化按工序依赖定**：写作与求职是严格串行（后棒依赖前棒产出——编辑不润色不存在的草稿）；游戏设计是「循环先行 + 三路并行」（数值与叙事基于同一循环口径同波展开，验证收口）——不按行业一刀切；
- **三条红线对应三个领域的「最大坑」**：writing 的抄袭洗稿、career 的履历造假、gamedesign 的循环失焦——协议第一条铁律即该领域最重护栏，比分散在多条细则里更有效；
- **与相邻场景显式区隔（写入 _group.yaml description）**：writing ↔ marketing.content（作品视角 vs 营销转化视角）；career ↔ ops.hr / recruiter（候选人视角 vs 招聘方视角）；gamedesign ↔ development（设计件 vs 代码实现）；
- **复用成熟机制**：四件套镜像 / handoff / 波次 / stage 预写均为既有能力，零引擎 / 零前端 / 零容器改动；`TOPICS` 追加采用尾插法（detectTopic 顺序匹配，既有任务零回归）。

## 被否决的方案

- **writing 并入 marketing.content（角色补位）**：content 的目标函数是转化（营销视角），长篇创作是作品质量（选题 / 编辑 / 出版链）——并场景会污染协议与角色心智；
- **career 复用 ops.hr**：立场相反不可合并——hr 替公司筛选与沟通候选人，career 替候选人定位与谈薪；「薪资口径」红线也不同（预算框 vs 市场分位）；
- **gamedesign 并入 development**：GDD / 数值表 / 世界观是设计产物而非代码；混入 development 会让「先读代码后写代码 / 最小 diff」的工程协议误导纯设计任务；
- **writing 同波并行出稿**：章节依赖统一视角与语感，并行会拼贴化；串行链 + 首节样例立语感是质量最优解；
- **gamedesign `rounds: true`（设计-验证多轮交替）**：首版设计无需多轮对辩，验证发现问题走 handoff 回交设计者即可；`rounds: false` 保持波次简洁；
- **career 主题词复用「合同」**：产物会生成「简历-合同.md」等不自然文件名；`TOPICS` 新增「求职」使四份产物路径全部通顺（职业规划 / 简历 / 面试手册 / offer评估-求职）。

## 适用与失效条件

- 适用：「先出成品再谈发布」类创作场景可复制写作链模板（选题 → 主笔 → 编辑 → 出版）；「个人目标 + 逐棒陪跑」类场景可复制 career 模板（定位 → 材料 → 演练 → 决策）；「多线设计 + 收口验证」可复制 gamedesign 模板（循环先行 → 三路并行 → 验证）；跨领域回填台账模式（handoff 目标延后到目标场景落地后回填）继续适用；
- 失效条件：M52-B 点亮 `dock` stage 后须复核三场景会话渲染（形态消费端替换预写声明）；`TOPICS` 演示词表再扩展须检查词序（detectTopic 顺序匹配，新词只能追加尾部）并跑全量 eval 复核零回归；
- 测试镜像面：`server/tests/mock-coverage.test.ts`（全量角色守护自动纳入 12 新角色）；`server/tests/m21.test.ts`（25 场景 / 97 角色 / 21 预设 / 协议断言）；`evals/tasks/24-career.json`（4 回合链路 + 4 交付件 + turns_lte 5）、`evals/tasks/25-gamedesign.json`（4 回合链路 + 4 交付件 + turns_lte 5）。
