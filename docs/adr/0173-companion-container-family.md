# ADR 0173：陪跑容器族——tracks / quiz / mood / goals / ledger / itinerary 与 HL-2/HL-8 收敛

- 状态：Accepted
- 引入：M40 陪跑渲染包（2026-09-19）
- 相关：[design.md §104](../design.md)、[docs/scene-chat-design.md §8](../scene-chat-design.md)（M40 原案 HL-1/3/4/5/6/7/8 落位）、ADR 0169（业务容器族 v2 语法归一——本批沿用）、ADR 0172（打卡本地口径）、[client/src/components/chat/md-ext/remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[client/src/components/chat/md-ext/TracksCard.tsx](../../client/src/components/chat/md-ext/TracksCard.tsx)、[client/src/components/chat/md-ext/QuizCard.tsx](../../client/src/components/chat/md-ext/QuizCard.tsx)、[client/src/components/chat/md-ext/MoodCard.tsx](../../client/src/components/chat/md-ext/MoodCard.tsx)、[client/src/components/chat/md-ext/GoalsCard.tsx](../../client/src/components/chat/md-ext/GoalsCard.tsx)、[client/src/components/chat/md-ext/LedgerCard.tsx](../../client/src/components/chat/md-ext/LedgerCard.tsx)、[client/src/components/chat/md-ext/ItineraryCard.tsx](../../client/src/components/chat/md-ext/ItineraryCard.tsx)

## 背景

- M40 原案（scene-chat-design §8）定义陪跑型场景包（health / learning / personal / wealth / home / travel）：
  HL-1 三轨打卡卡 · HL-2 学习路径 · HL-3 每日一练 · HL-4 情绪签到 · HL-5 目标进度环 · HL-6 记账流水 · HL-7 行程卡 · HL-8 清单汇总条；
- 「容器约定以渲染层支持 + 相应 AGENT.md 工作方式各加一行输出约定为主；不新增 `_protocol.md`」（原案 §8.4）；
- 现状：陪跑场景消息只有散文与通用 checklist 卡——轨道打卡、练习选项、情绪档位、目标环、流水、按天行程均无可视结构。

## 决策

1. **六个新容器（v2 语法：`::: <name>` + 条目行 `- 字段 | …`）**：
   - `::: tracks [标题]`（HL-1）——条目 `- 轨道 | 计划摘要`；周网格（周一锚定 7 日）+ 逐格打卡（含补记，ADR 0172）+ streak 徽标 + 周进度环；
   - `::: quiz [标题]`（HL-3）——条目 `- A | 选项文本`；选项本地单选 + 「提交给成员」回填「我的答案：X。请批改并讲解。」（ADR 0064 只写草稿）；
   - `::: mood [标题]`（HL-4）——无条目（固定 1–5 档 + 档位词）；「提交签到」回填「今日状态：N/5（档位词）。请据此调整今日建议。」；
   - `::: goals [标题]`（HL-5）——条目 `- 目标 | 当前 | 目标值`；数值解析支持「万」后缀；逐行进度环（缺数值 → 退化为文本，不猜）；
   - `::: ledger [标题]`（HL-6）——条目 `- 日期 | 项目 | 金额`；金额列右对齐（tabular-nums），负数（支出）色标；脏值不猜正负；
   - `::: itinerary [标题]`（HL-7）——条目 `- 日期 | 交通 | 住宿 | 安排`；按天分组（首次出现序）+ 日期头（含周几）+ **今天高亮**（本地日期比对）+ 三行图标；非日期首列 → 「未标日期」组。
2. **共享收尾与降级链**：五类行集容器复用 `finalizeRowSet`（`data-rows` + `data-count` + `data-raw`）；mood 为无列表卡（默认收尾，children 原样）；解析失败 → raw 静态兜底 / 未闭合 → 去壳展开（既有口径）。
3. **HL-2 / HL-8 收敛声明（不重复造卡）**：
   - HL-2 学习路径 = 既有 `::: timeline` 复用（阶段-里程碑竖向线已由 timeline 卡承担；tutor AGENT.md 补一行输出约定，无新容器）；
   - HL-8 清单汇总条 = 既有 checklist 卡自带「已完成 x/y」计数条与进度条（M37-4 已覆盖）——**零新增**。
4. **资产落地（按原案 §8.4：AGENT.md 各加一行输出约定，不新增协议）**：fitness（tracks）· tutor（quiz + 路径 timeline）· coach（mood）· wealth（goals + ledger）· travel（itinerary，日期 YYYY-MM-DD）。

## 理由

- **沿用 v2 语法（ADR 0169）**：六个容器与 kpi/timeline/pipeline 同构（条目行 + | 分隔）——一个解析收尾函数（finalizeRowSet）全覆盖，模型侧单一心智模型；
- **交互三件套（quiz / mood / tracks）全走草稿回填**：统一 ADR 0064 语义（用户确认后才发送）；卡上完成「选择」这个动作，提交文案由角色继续处理；
- **进度环复用 scene/parts 的 ProgressRing**：与 coach 面板同一元件（一处样式，两处呈现）；goals/tracks 不必新造环；
- **「万」后缀与负数色标是中文理财语汇的底线**：「1.5万」「-5200」是最常见写法——不解析这两类等于卡不成立；脏值一律不猜（退化文本）；
- **HL-2/HL-8 收敛优先于新造**：timeline / checklist 已表达同等结构——新增容器将造成「同一语义两张卡」。

## 被否决的方案

- **HL-1 波次组附属聚合卡（原案字面形态）**：当前架构下波次组聚合需跨消息扫描 + 完成态挂载机制，成本远高于收益；改用「消息内 tracks 卡 + 本地打卡」同样达成「三轨 + 打卡 + streak」的用户价值（口径已在 §104 记录）；
- **quiz 提交直发消息**：违背 ADR 0064（用户确认后才发送）；
- **mood 免提交、点选即回填**：点选误触会污染输入框；显式「提交签到」按钮保持「选择 → 确认」两步；
- **goals 自动合计 / ledger 自动合计**：原案明确「原表 / 表格」呈现——自动合计属于业务计算（应由 calc / 角色承担），渲染层不做算术；
- **itinerary 直接复用 timeline 卡**：timeline 不支持按天分组 / 今天高亮 / 三行图标语义（原案的「timeline 扩展」在实现上即为独立卡）。

## 边界与失效条件

- 六个测试锚点族（`data-tracks-card` / `data-quiz-card` / `data-mood-card` / `data-goals-card` / `data-ledger-card` / `data-itinerary-card` 及子属性）为渲染契约；
- 数值解析（numberWithSuffix）为单点实现（remark-ext 导出）——金额 / 目标值共用，口径变更须同步单测；
- 打卡本地态边界见 ADR 0172；若真实使用需要「跨设备同步」或「服务端习惯统计」，本批容器保留、仅数据源升级。
