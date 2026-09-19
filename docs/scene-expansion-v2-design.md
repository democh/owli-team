# 场景扩展二批设计（M69）：十个新场景 · 交互与前端蓝图

> 状态：**已实施**（2026-09-19 收口：M69 全量交付，落位 CHANGELOG **v78**；设计蓝图先行落盘后按 §8 批次 B2–B8 逐批兑现）
> 实施落位（2026-09-19 收口）：design.md **§101** / ADR **0166**（0163–0165 被并发批次占用顺延）/ CHANGELOG **v78**；完善批已兑现 §2.6–§2.7、§2.10 的全部交互承诺——卡片双按钮（新种子重掷 / 同种子复现 / 重抽）、牌阵台 CardsBoard 布局（1 居中 / 3 横排 / 5 十字阵 + 点牌高亮 + 关键词横幅 + 双按钮）、汇聚板骰子记录段、论点池（claim → ClaimCard 专业化）、mock 三组触发块与 E2E 定向 `e2e/m69-cards.spec.ts`（断言已同步 CardsBoard 口径；首轮归因并发中间态、待静默复跑）。
> 范围：**10 场景 / 34 角色 / 46 角色（含补强）/ 5 预设 / 7 技能 / 2 工具 / 3 新容器族**（经营创作域 · 实用域 · 玩法域）
> 关联：承接 [scene-expansion-design.md](scene-expansion-design.md)（M51–M52 场景工作区体系：四形态 + 六面板 + 元件库 + 容器族）；资产规范见 [agents/README.md](../agents/README.md)；形态机制见 [ADR 0112](adr/0112-scene-workspace-framework.md)
> 编号口径：**M69**（M60–M68 已占用，仅 M67 空缺避让）；ADR 预定 **0158–0161**；CHANGELOG 实际落 **v78**（v75–v77 被并发批次 M65-A / M64 批一 / M65-B 占用，顺延）；ADR 落位编号待专项收口复核
> 并发避让：`interior`（家装设计）/ M65 3D 工作台为**并行工作流活跃专项**，本专项零触碰
> 仓库无 Git：动手前已做目录快照 `data/m69-backup-2026-09-19/`（agents / skills / scene / md-ext / mock 等）

---

## 1. 场景总账

| # | 场景 | 形态 · 面板 | 角色（暂拟 id） | 新容器 | 红线要点 |
| --- | --- | --- | --- | --- | --- |
| 1 | `ecommerce` 电商经营 | dock · console | category-scout / listing-optimizer / store-operator / shop-support | 复用 | 平台规则合规；不刷单不虚假宣传 |
| 2 | `creator` 自媒体工作室 | dock · board | account-strategist / script-writer / growth-editor / monetizer | 复用 | 平台规则；不编造事实数据 |
| 3 | `legal-personal` 个人法务 | dock · console | rights-advisor / labor-advisor / contract-checker | 复用 | 非正式法律意见声明；重大事项转执业律师 |
| 4 | `academic` 学术论文 | dock · board | lit-reviewer / methodologist / paper-editor / submit-advisor | 复用 | 辅助不代写；引用真实性校验 |
| 5 | `relationship` 情感关系 | dock · coach | rel-coach / date-coach / mediator | 复用 | 不诊断不治疗不教操控；危机转介 |
| 6 | `trpg` 跑团工坊 | roundtable · pool | gm-host / scenario-writer / npc-player / rule-keeper | **roll** | 安全工具（Lines & Veils）；随机可复现 |
| 7 | `tarot` 塔罗研习 | dock · chartboard | tarot-reader / symbol-narrator / tarot-historian | **cards** | 文化研习定位；不承诺预测；不恐吓推销 |
| 8 | `moot-court` 模拟法庭 | arena | plaintiff-counsel / defense-counsel / presiding-judge | 复用（ruling） | 模拟性质声明；不套用真实案件未决信息 |
| 9 | `business-sim` 商业沙盘 | arena | sim-host / market-referee / review-coach | **sim** | 模拟推演声明；非真实经营建议 |
| 10 | `philosophy` 哲学茶室 | roundtable · pool | socratic-host / thought-experimenter / ethics-moderator | 复用 | 多元立场并列；不作意识形态输出 |

形态统计（新增）：dock 6（含 tarot）· roundtable 2 · arena 2。**stream 不新增**（玩法域全量进形态体系）。
`blank` 单 Agent 场景不在本专项范围内（沿用 M50 口径）。

---

## 2. 交互与前端细化（重点）

> 通用纪律沿用 scene-expansion-design §3 七条 + §7.3 统一规范：线性主干不变 · 流式纯文本 · 交互只写 Composer 草稿（composerInsert）· 交互态存 sessionStorage（`ma:sc:*`）· 窄屏（<900px）降级 · 空态不空白不报错。

### 2.1 `ecommerce` 电商经营（dock · console）

- **工作区（店铺台）**：① SKU 卡区——商品卡（名称 / 状态泳道：在售·优化中·滞销 / 核心指标：转化率·毛利）；② 经营指标条（GMV / 客单价 / 转化率，kpi 容器派生）；③ 活动节点（报名 / 预热 / 大促节奏，timeline 派生）。
- **交互**：点 SKU 卡「优化 Listing」→ 回填；点指标卡展开口径与 SQL 出处（复用 bi 先例）；活动节点「准备这一步」→ 回填；停滞 SKU 标黄提示「诊断」（回填）。
- **派生来源**：`::: kpi` + `::: checklist`（上新清单）+ 消息内 Listing 文本（取标题 / 卖点结构）。

### 2.2 `creator` 自媒体工作室（dock · board）

- **工作区（内容台）**：① 内容日历（选题 × 平台 × 排期，timeline 派生）；② 账号指标卡（粉丝 / 互动 / 涨粉来源）；③ 选题池（候选状态：储备 → 制作 → 已发布，checklist 派生）。
- **交互**：点日历格回填「写这条选题的脚本」；点选题池条目「开写」→ 回填；点指标卡回填「复盘这个数据」；发布后条目打勾（sessionStorage）。
- **派生来源**：`::: timeline` + `::: checklist` + `::: kpi`。

### 2.3 `legal-personal` 个人法务（dock · console）

- **工作区（案件台）**：① 案件时间线（事件 / 证据 / 节点，timeline 派生）；② 证据清单（勾选式，缺证据标红——checklist 派生）；③ 主张卡（claim 容器派生：主张 → 依据 → 证据）。
- **交互**：点证据项「补证」→ 回填；时间线节点跳来源消息；主张卡「展开论据」；「下一步路径」回填（协商 / 投诉 / 仲裁 / 诉讼分支）。
- **派生来源**：`::: timeline` + `::: checklist` + `::: claim`。

### 2.4 `academic` 学术论文（dock · board）

- **工作区（论文台）**：① 结构树（IMRaD 章节 / 完成状态，checklist 派生）；② 文献库（来源卡：作者 / 年份 / 等级 / 引用位置，sources 容器派生）；③ 修改线（版本节点，timeline 派生）。
- **交互**：点章节「续写这节」→ 回填；文献卡「引用」→ 回填；「查证这篇」→ 回填（联动 verifier 方法）；结构树完成度随消息更新。
- **派生来源**：`::: sources` + `::: checklist` + `::: timeline`。

### 2.5 `relationship` 情感关系（dock · coach）

- **工作区（沟通台）**：① 练习清单（场景演练：表达练习 / 倾听练习 / 边界对话，checklist 派生）；② 沟通要点卡（choice 容器派生：场合二选一——先冷静再谈 / 现在就谈）；③ 进展条。
- **交互**：点练习项「来一轮」→ 回填场景演练；要点卡「选这个」→ 回填；打卡点亮。
- **派生来源**：`::: checklist` + `::: choice`。

### 2.6 `trpg` 跑团工坊（roundtable · pool）

- **席位环**：gm-host / npc-player / rule-keeper / scenario-writer——按当前回合高亮（当前发言者）。
- **汇聚板（跑团台）**：① 角色卡区（PC / NPC：名字 / 属性 / 状态）；② 骰子记录（roll 容器按掷序聚合，显示骰式与结果）；③ 线索板（已获线索 / 待解谜题，checklist 派生）。
- **专属交互（重点）**：
  - **骰子卡**：`::: roll` 容器 → 消息内嵌骰卡渲染（骰面 + 总值 + 种子）；卡内「再掷一次」按钮 → 回填（新种子或指定种子）；
  - **种子复现**：骰卡显示种子徽章，「用同种子重掷」回填 `@gm-host 用种子 <seed> 重掷`；
  - quiet / reduced-motion：去骰面动画保留数值；流式期间纯文本降级。
- **派生来源**：`::: roll`（新）+ `::: checklist`（线索）+ 角色卡文本。

### 2.7 `tarot` 塔罗研习（dock · chartboard）

- **工作区（牌阵台）**：① 牌阵区（按牌阵布局渲染：单张 / 三张 / 凯尔特十字——`::: cards` 容器派生，牌位连线）；② 牌义侧栏（点牌显示关键词 / 意象 / 正逆位）。
- **专属交互（重点）**：
  - **抽牌（可复现）**：`tarot_draw` 工具产出（种子 + 牌序）；卡内「重抽」（换种子）/「同种子重抽」；
  - 点牌位高亮 + 跳来源消息；「看综合解读」→ 回填；
  - 与 chartboard 现有盘面 tabs 并置（牌阵为「cards」类 tab，切换不与命理盘冲突——场景级隔离）。
- **派生来源**：`::: cards`（新）。

### 2.8 `moot-court` 模拟法庭（arena）

- **席位**：left `[plaintiff-counsel]`（原告席）｜ right `[defense-counsel]`（被告席）｜ center `[presiding-judge]`。
- **中轴**：庭审阶段轴（开庭 → 举证 → 质证 → 辩论 → 判决，round-track 复用，阶段名判定席切换）+ 论断树（claim-tree）+ 判决流（ruling 容器——复用 M63 已有 ruling 卡渲染）。
- **专属交互**：「传唤下一环节」回填；判决流展示法院判决书结构（主文 / 理由 / 依据）；点论断展开证据。
- **parts 声明**：`[round-track, claim-tree, verdicts]`（无计分板；判决用 ruling，不加报价流）。

### 2.9 `business-sim` 商业沙盘（arena）

- **席位**：left `[sim-host]`（经营席 / 主持）｜ right `[market-referee]`（市场席 / 反馈）｜ center `[review-coach]`（复盘席）。
- **中轴**：回合轴 + **回合结算卡**（`::: sim` 容器：决策 → 市场反馈 → 指标变化 → 教练点评）+ 计分板（经营指标累计：营收 / 现金 / 市占）。
- **专属交互**：结算卡「下个回合」→ 回填决策模板；指标条 hover 展开变化明细；「保存这局复盘」→ 回填收口。
- **parts 声明**：`[round-track, scoreboard, verdicts]`（保留裁决流用于终局）。
- **派生来源**：`::: sim`（新）+ `::: kpi`（指标）。

### 2.10 `philosophy` 哲学茶室（roundtable · pool）

- **席位环**：socratic-host（追问）/ thought-experimenter（思想实验）/ ethics-moderator（伦理梳理）。
- **汇聚板（论点池）**：① 论点卡（主张 → 前提 → 反驳，claim 派生）；② 思想实验卡；③ 结论条（本场收敛的框架：功利 / 义务 / 德性三视角并列）。
- **交互**：点论点「追问下去」→ 回填；思想实验「换个设定」→ 回填；结论条点视角切换高亮。
- **派生来源**：`::: claim` + `::: checklist`。

---

## 3. 新容器族（3 个，remark-ext builder）

> 降级链与现有容器一致：流式 = 纯文本；解析失败 = 原文；quiet = 静态；窄屏 = 折叠。

### 3.1 `::: roll`（掷骰卡，trpg）

```
::: roll 攀爬检定
骰式：d20+3 | 种子：482910
明细：15 | 修正：+3 | 总值：18
:::
```

- 行契约：首行「骰式 | 种子」；次行「明细 | 修正 | 总值」（多骰时明细以 `+` 连接）；
- 前端：骰卡（骰面方块 + 总值放大 + 种子徽章 + 重掷按钮）；
- 数据源：`dice_roll` 工具输出（禁止模型心算造数——协议纪律）。

### 3.2 `::: cards`（牌阵卡，tarot）

```
::: cards 三张牌阵
- 过去 | 节制 | 正位 | 平衡 · 耐心 · 调和
- 现在 | 命运之轮 | 逆位 | 停滞 · 时机未到
- 未来 | 星星 | 正位 | 希望 · 指引 · 疗愈
:::
```

- 行契约：`- 牌位 | 牌名 | 正逆位 | 关键词`；
- 前端：牌阵区按牌位数量渲染（1 张居中 / 3 张横排 / 十字阵），点牌高亮 + 侧栏牌义；
- 数据源：`tarot_draw` 工具输出（种子可复现）。

### 3.3 `::: sim`（回合结算卡，business-sim）

```
::: sim 第 2 回合
- 决策 | 降价 5% 换量 | 反馈 | 需求 +12% 但毛利承压 | 指标 | 营收 ↑3% · 现金 ↓2% · 市占 ↑1%
:::
```

- 行契约：`- 决策 | …… | 反馈 | …… | 指标 | ……`（多行 = 多事件）；
- 前端：结算卡（回合徽章 + 决策 / 反馈 / 指标三段 + 变化箭头着色）；
- 数据源：消息内文本 + calc 验算（禁止心算）。

---

## 4. 新工具（2 个，server/src/tools/）

### 4.1 `dice_roll`（掷骰，种子可复现）

| 项 | 契约 |
| --- | --- |
| 输入 | `{ formula: string }`（如 `3d6+2` / `d100` / `2d10`）、`{ seed?: number }`、`{ label?: string }` |
| 输出 | `{ rolls: number[], modifier: number, total: number, seed: number, formula: string }` |
| 规则 | 骰面上限防护（单骰 ≤ 1000、骰数 ≤ 100）；种子缺省随机生成并回显；同种子同结果 |
| 授权 | trpg 全员 + gamedesign.playtester（模拟验证复用）；deferred 激活词「掷骰 / 骰子」 |
| 安全 | 纯计算只读、无审批、无副作用 |

### 4.2 `tarot_draw`（抽牌，种子可复现）

| 项 | 契约 |
| --- | --- |
| 输入 | `{ spread: 'single' \| 'three' \| 'cross' }`、`{ seed?: number }`、`{ question?: string }` |
| 输出 | `{ spread: string, cards: [{ position, name, orientation, keywords }], seed: number }` |
| 规则 | 78 张全表（22 大阿卡纳 + 56 小阿卡纳）；正逆位各 50%；种子缺省随机并回显；同种子同牌序 |
| 授权 | tarot 全员；deferred 激活词「塔罗 / 抽牌 / 牌阵」 |
| 安全 | 纯计算只读、无审批；与 `gua_pan` 同模式（自研规则代码化） |

---

## 5. 新技能（7 个）

| 技能 | 服务场景 | 主线（60–150 行规范） |
| --- | --- | --- |
| `trpg-hosting` | trpg | GM 技法：回合主持 / 场景调度 / 骰子纪律 / 安全工具（Lines & Veils）/ 剧本结构 |
| `tarot-reading` | tarot | 78 张体系 / 牌阵 / 正逆位 / 解读纪律（文化研习定位、非预测承诺、心理投射说明） |
| `ecommerce-operations` | ecommerce | 选品四维 / Listing 结构 / 大促节奏 / 客服话术 / 平台规则红线 |
| `creator-economy` | creator | 账号定位四问 / 内容矩阵 / 发布节奏 / 数据复盘 / 商业化路径 |
| `academic-writing` | academic | IMRaD / 文献综述方法 / 引用规范 / 投稿与审稿应对 |
| `relationship-communication` | relationship | 依恋理论科普 / 非暴力沟通四步 / 边界设定 / 危机识别与转介 |
| `philosophy-dialogue` | philosophy | 苏格拉底法 / 思想实验库 / 伦理三框架（功利 · 义务 · 德性） |

复用不新增：`legal-personal`（contract-review + formal-document）、`moot-court`（debate + formal-document）、`business-sim`（strategic-planning + financial-modeling）。
`dice_roll` / `tarot_draw` 的技能接入按「工具接入口径」写入对应技能。

---

## 6. 既有场景补强与预设

**补强 12 角色**：travel `+visa-advisor / +local-curator` · wealth `+insurance-planner / +big-ticket-advisor` · funding `+valuation-modeler / +datroom-keeper` · bi `+metric-governor / +viz-designer` · sre `+capacity-planner / +chaos-officer` · personal `+habit-coach` · ops `+license-keeper`。

**预设 5 个**（order 自 270 起顺延）：

| id | 名称 | 成员 | 玩法 |
| --- | --- | --- | --- |
| startup-launch | 创业启动 | chief · finance · legal · growth · pm | 想法到第一版计划：四方会审 |
| career-pivot | 职业转型 | career-advisor · wealth · tactician · interview-coach | 定位 → 财务承受力 → 谈薪彩排 |
| annual-review | 年度复盘 | chief · coach · finance · fitness | 经营 / 个人 / 财务 / 健康四维复盘 |
| ecommerce-growth | 电商增长 | category-scout · store-operator · bi · growth | 选品 → 店铺 → 取数 → 投流 |
| content-monetize | 内容商业化 | account-strategist · script-writer · monetizer · finance | 定位 → 脚本 → 变现 → 财务口径 |

---

## 7. 镜像面清单（逐项打勾）

1. `agents/<场景>/`：`_group.yaml`（description / guide / agenda / order / 机制 + stage）+ `_protocol.md`（三段式 + 质量红线 + 典型失败模式，≥28 行）+ 角色 `AGENT.md`（六段骨架，正文 ≥1200 字符）；头像先行缺省（gradient + icon 回退，PNG 后补）；
2. `agents/_presets.yaml`（§6）+ `agents/README.md`（统计与技能预载表）+ `agents/CHANGELOG.md`（v75+ 条目）；
3. `server/src/llm/mock.ts`：DISPLAY_NAMES（46 角色）+ preferredOf + artifactFor（各场景交付件路径）+ 剧本站位；
4. `e2e/helpers.ts`（AGENT_NAME）+ `server/tests/m21.test.ts`（场景数 / 角色数 / stage 声明数 / 预设数断言）+ `server/tests/m29`（handoff 白名单）；
5. `client/src/lib/avatar-icons.ts`（新图标：armchair 已注册? 本批图标清单见实施注记）；
6. 工具：`server/src/tools/dice.ts` + `tarot.ts` + registry / categories / availability 登记 + 测试 `server/tests/m69-tools.test.ts`；
7. 门禁：四包 typecheck / lint / 双端 vitest / `check:agents`（QUALITY_STRICT）/ `check:skills`（SKILL_STRICT）/ eval / E2E 定向。

---

## 8. 批次与验收

| 批次 | 内容 |
| --- | --- |
| B1 | 设计文档（本文）+ 快照 + 编号核对 |
| B2 | 工具：dice_roll / tarot_draw（注册 + 测试） |
| B3 | 技能：7 个（skill-authoring 规范） |
| B4 | 场景资产 A：ecommerce / creator / legal-personal / academic / relationship（18 角色） |
| B5 | 场景资产 B：trpg / tarot / moot-court / business-sim / philosophy（16 角色） |
| B6 | 既有补强 12 角色 + 预设 5 个 |
| B7 | 前端：roll / cards / sim 容器 + 面板场景文案 + registry + parts 声明 |
| B8 | 镜像面（mock / e2e / m21 / README / CHANGELOG / icons）+ 全量验证 |

**验收门禁**：check:agents strict（质量报告全达标）· check:skills strict · 双端 vitest 全量 · typecheck 0 错误 · E2E 定向（m21 / m52-stage 相关）· eval 无回归（mock 基线，如涉及）。
