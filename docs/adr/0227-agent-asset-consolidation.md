# ADR 0227：Agent 资产的合并/去重边界与场景精简策略

- 状态：Accepted
- 引入：M89
- 相关：[ADR 0212](README.md)（场景体系调优）、[ADR 0216](0216-agent-studio-generation.md)（Agent Studio）、[ADR 0223](0223-relay-control-manual-dispatch.md)（接力控制）、[ADR 0226](0226-intent-autonomy.md)（意图判定）

## 背景

- 当前资产规模：**41 场景 / 163 角色 / 72 技能 / 44 组队预设**。用户提出「角色合并/去重、精简场景」，需要先判断"重复"是否真实存在。
- 结论：**不存在可机械合并的重复角色**。以 `role + description` 的中文 2-gram Jaccard 相似度扫描，全部 163×162/2 对中只有 2 对 ≥0.34：
  - `bullbear/bear-quant` × `bullbear/bull-quant`（0.90）
  - `bullbear/bear-lead` × `bullbear/bull-lead`（0.62）
  两对都是**多空对决的对称设计**（同一职责的正反两方），不是冗余。
- 23 个角色不在任何 `chain / preset / ritual / stage.seats` 中（只能手动邀请到达），但其 handoff 入度为 0–2——它们是"可选专家"，不是死代码。

## 决策

1. **不做机械合并 / 删除**。理由：
   - 角色 id 是存量会话 `participantIds` 的引用键；删除角色会让旧会话在下一回合抛「角色不存在」，需要数据迁移。
   - `chain` 是建会话的**默认预选**（`CreateSessionDialog` 直接用 `group.chain` 作为 picked），把支援角色塞进 chain 会让默认会话人数暴涨。
   - 场景不是目录别名，而是承载专属体验：`bi` → 取数管道卡 + KPI/取数链控制台；`sre` → SSH 证据卡 + 事故时间轴/SLO；`fengshui` → chartboard 盘面。删除场景 = 删除这些分支与场景协议。
2. **把"去重"工程化为门禁与报告**：
   - `check:agents` 新增**资产一致性报告**：`tools` 声明必须命中工具注册表（MCP 通配除外）、`skills` 必须存在（strict 时失败）；`formal_document` 这类无效声明由此暴露并已修复为 `template_fill`。
   - 同报告输出**隔离角色清单**（不在 chain/preset/ritual/seats），作为资产精简的输入；
   - 新增角色时若与既有角色相似度 ≥0.85 且非同场景对称设计，必须人工裁决（保留 / 合并 / 改名）。
3. **场景精简走"入口收敛"而非删除**：
   - 41 个场景在资产层保留（各自的 stage / 协议 / UI 分支不动）；
   - 通过 `order`、分组展示与预设入口降低选择成本；
   - 若产品确认下线某场景，走"标记下线 → 观察一个版本 → 删除"的三步，而不是一次性删除。
4. **角色级质量可见**：新增 `GET /api/metrics/agents`（回合 / token / 工具失败 / 步骤完成与阻塞 / 评审未通过），让"哪个角色在拖后腿"可回答。减员决策应以该指标为依据，而不是文本相似度。
5. **评测兜底**：mock 基线新增运行指标（turns / promptTokens），相对基线 +20% 告警、+50% 失败——资产或提示词改动导致成本膨胀会被 CI 拦住。

## 减员候选（数据，不代表立即执行）

23 个隔离角色（按场景）：

| 场景 | 角色（handoff 入度） |
| --- | --- |
| development | ai-engineer(0) · data-engineer(1) · security(0) · tech-writer(0) · ux-researcher(0) · ux-writer(0) |
| marketing | ads(0) · influencer(0) · pr(1) · social(1) · video(1) |
| finance | compliance(1) · ip(1) |
| ops | hr(2) · license-keeper(0) · trainer(0) |
| funding | dd-analyst(1) · valuation-modeler(1) |
| travel | local-curator(1) · visa-advisor(1) |
| personal | habit-coach(0) |
| bi | metric-governor(0) |
| sre | chaos-officer(0) |

处置建议（按入度与独特性）：
- **保留**（独特专业能力，建议补 preset 入口）：security、compliance、ip、hr、dd-analyst、valuation-modeler、local-curator、visa-advisor、chaos-officer、metric-governor。
- **观察**（入度 0 且与主链角色职责邻近）：ai-engineer、data-engineer、tech-writer、ux-researcher、ux-writer、ads、influencer、license-keeper、trainer、habit-coach。
- **不因相似度合并**：bullbear 的两对对称角色。

## 被否决的方案

- **按相似度自动合并**：最高相似对是对称设计；自动合并会同时删掉多空两方。
- **把隔离角色全部并入 chain**：chain 即默认预选，会把 6 人团队变成 13 人。
- **一次性删除薄场景（sre / bi / fengshui）**：专属 UI 与协议无处安放，用户也失去明确入口。
- **把场景协议合并去重**：41 份协议 35–59 行，内容为场景定制；抽取公共段会与 `check:agents` 的三段门禁冲突，收益低于风险。

## 适用与失效条件

- 适用：当前"场景承载 UI + 角色 id 被会话引用"的架构。
- 失效条件：若未来把场景降级为纯标签（UI 分支改为能力注册表）且角色 id 引入别名/墓碑机制，则可以做真正的场景合并与角色下线；届时以本 ADR 的候选清单与 `metrics/agents` 指标为准。
