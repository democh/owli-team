# Prompt / Skill 变更日志

> 规则：**每次修改 `agents/` 下的协议或角色人设（含灵魂），必须在本文件追加一条记录**，并附当次评测结果。
> 评测结果（`npm run eval`）与基线（`evals/baseline.json`）对比无回归，是 prompt 变更合并的准入条件。
> mock 断言看「确定性」列；真实模型 judge 分数看「judge」列（手动 / 夜间跑，仅作趋势参考）。
>
> 说明：v1–v4 为基线建立时的**追溯登记**（按里程碑记录整理）；自 v5 起逐条随改动记录。

## 变更记录

### v109 — 场景资产清理：三席同域重复角色下线（2026-10-25）

- **动因**：全量盘点（41 场景 / 166 角色）后，按 ADR 0212 的「同质化 / 职能重复」口径筛出三席死资产——职责已被同场景主角色覆盖，且未接入任何 `chain` / 预设 / 评测，只在 mock 与名录里占位。
- **下线三席**：`funding/datroom-keeper` 理卷（数据室清单已在 `fundraiser` 职责第 4 条、尽调四线在 `dd-analyst`）· `sre/capacity-planner` 度峰（`sre` 职责明含「容量与性能」）· `bi/viz-designer` 绘数（`bi` 定位含「数据可视化」）。
- **明确保留**：`sre/chaos-officer`（演练设计 ≠ 事故处置）· `ops/trainer`（`hr` 职责写明「培训衔接归 @段言」）· `bi/metric-governor`（口径治理有评测与 handoff 承载）· `marketing/influencer`（红人投放独立职能）。
- **镜像面**：mock 四件套（SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf）· `e2e/helpers.ts` AGENT_NAME · `metric-governor` 的 handoff 收敛为 `[bi]` · `agents/README.md`（bi 预载行 / 41 场景 / 162 业务角色）· 根 README 与 `docs/owli-team-intro.md` 角色计数 166 → 163 · design.md §19.3 设定表三行、图片计数（41 场景 162 张）与 markitdown 授权行。
- **核验**：check:agents **163/163 + 协议 41/41 + 声纹 24/24 ✅**；mock-coverage / m21 / m35 **35/35 ✅**；双端 + e2e typecheck 0 错。
- 相关文档：本文件、`agents/README.md`、`design.md §19`、根 README、`docs/owli-team-intro.md`。

### v108 — bullbear 五席头像批与 M83/M84 审计收口（2026-09-25）

- **动因**：M84 收口审计——补齐 5 席头像资产、落地两处观察项微增强，并修复 M83 审计暴露的块模板解析缺陷；角色人设 / 协议 / 技能零改动（仅资产与客户端）。
- **头像批（5 席）**：bullbear judge 顾鉴 / bull-lead 向阳 / bear-lead 知寒 / bull-quant 陆准 / bear-quant 程实——v3 统一风格前缀 + 七维差异化 + 场景主题色元素（绯红 #dc2626 / 墨绿 #059669 / 靛蓝 #6366f1），512×512 落盘 `agents/bullbear/<id>/avatar.png`；空方证据官首版误出拟人熊形象（bear-side 英文直译），重生成时提示词显式要求 HUMAN / no animal features；design.md §19.1 计数句与 §19.3 设定表五行已同步。
- **M84 观察项落地**（纯客户端，零协议改动）：证据徽标「统计级」——`lib/evidence` 新增 statistical 等级（证据行含 p= / p< / p值 / CI[ / n= / Bonferroni，优先级最高；ClaimTree / StanceCard 共用渲染 + 新增 CSS 变体）；立场互换——`TEMPLATES.swapSides` + ArenaActions「互换立场」动作（回填草稿）+ ArenaStage 计分板备注「含 N 次互换」标记（协议第 6 条可见化）。
- **M83 审计收口**：**块模板 `render` 对象形态解析缺失**修复（`kline-spec` 兼容嵌套 render，主/副图与阶段开关配置此前被静默忽略——修复后 `fin_analyze` / `fin_strategy` 生成的块配置真正生效）；「送上画布」携带 drawings / analysis；`entry` 阶段色板去重（单一来源 `phaseColors`）；E2E `e2e/m83-kline-analysis.spec.ts`（mock「K 线走查」内联块：工具条 / 阶段开关 / 分析面板 / 零取数渲染）；跨端契约 fixture（`client/tests/fixtures/m83-*.json` 由真实 server 引擎产出 + `m83-kline-contract.test.ts`，夹具首跑即暴露上述 render 缺陷）。
- **配套**：mock 新增「K 线走查」触发块（确定性和内联数据）；playwright main testMatch + `m83-.*`；`docs/kline-analysis-dsl-design.md` §7 / `docs/bullbear-arena-design.md` 状态行回写；design.md §124/§125 审计收口行。
- **核验**：check:agents **166/166 + 协议 41/41 + 声纹 24/24 ✅**；check:skills **72/72 ✅**；`npm run eval`（mock 确定性）**56/56 ✅**（本批零 prompt 变更）；server 全量 **1581/1581 ✅**；client 全量 **1388/1388 ✅**（新增 m83-kline-contract 2 例 + m63 统计级/互换 3 例 + spec render 形态 1 例）；E2E **m83 1/1 + m84 1/1 ✅**；双端 + e2e typecheck 0 错。
- 相关文档：design.md **§124/§125/§19.1/§19.3** / `docs/kline-analysis-dsl-design.md` / `docs/bullbear-arena-design.md`。

### v107 — 多空对决场场景与统计举证工具接入（M84）

- **动因**：新场景专项「多空对决场」（M84）落地——专职对抗赛场（多空双阵营立论 / 举证 / 质证 / 结辩 + 裁决长终局裁决），消费 M83 工具链（`fin_analyze` / `fin_strategy` / `fin_backtest(dsl)`）并补齐统计举证层（`fin_stats`）。
- **新增场景（41 个）**：`agents/bullbear/` 五席——judge 顾鉴（裁决长）· bull-lead 向阳（多方主辩）· bear-lead 知寒（空方主辩）· bull-quant 陆准（多方证据官）· bear-quant 程实（空方证据官）；`_group.yaml` arena 布局（seats 左多 / 右空 / 中央）+ parts（round-track / scoreboard / cross-fire / claim-tree / verdicts）；`_protocol.md` 17 条（五拍回合 / 证据纪律 / 容器约定 / 立场互换 / 合规红线）；预设 `bullbear-pk`。
- **工具与技能**：五席绑定 `fin_analyze` / `fin_stats`（证据官另持 `fin_strategy` / `fin_backtest`）；新技能 `skills/quant-evidence`（量化证据与统计检验：口径纪律 / 输出解读 / 降级矩阵 / 证据行铸造）；invest 协议「多空对弈」加一行引导移交（深度对抗 → @顾鉴）。
- **镜像面（v14/v15 纪律）**：mock 四件套补齐（5 角色 SCRIPTS / artifactFor / DISPLAY_NAMES / preferredOf）+ `e2e/helpers.ts AGENT_NAME`；新增触发块「对决走查」（claim ×2 + ruling + verdict + kpi 四容器确定性输出）；各角色落盘路径（`docs/多空对决|多方论证|空方论证|多方证据|空方证据-<主题>.md`）与 AGENT.md 交付契约逐字对齐。
- **核验**：check:agents **166/166 + 协议 41/41 + 声纹 24/24 ✅**；check:skills **72/72 ✅**（+quant-evidence）；`npm run eval`（mock 确定性）**56/56 ✅**（零新增任务口径：mock 走查 + E2E 承接，详情见 ADR 0220）；server 全量 **132 文件 / 1581 用例 ✅**（新增 m84-stats 16 例含真脚本冒烟）；E2E **m84-bullbear 1/1 ✅**；双端 + e2e typecheck 0 错。
- 相关文档：**ADR 0220** / design.md **§125** / `docs/bullbear-arena-design.md`（状态已回写）。

### v106 — K 线分析引擎与 DSL 策略工具接入（M83 批 D）

- **动因**：K 线分析引擎与 DSL 策略引擎（M83）落地后，投研两席接入新工具链——「有据可依」的图表分析（阶段 / 情绪 / 关键位 / 特征 + 落图）与可校验的策略规则化（DSL lint → run → 回测同口径）。
- **工具接入**：`analyst-ta`（雷动）tools + `fin_analyze`（一次取全，返回含阶段色带 + 关键位落图 + 分析面板的 kline 块模板）；`quant`（方程）tools + `fin_strategy`（DSL lint → run → facts 排查 → 落图），并预载新技能 `strategy-dsl`。
- **文案变更**：analyst-ta——专业判断 +「阶段口径」硬规则（置信度 <60 降强度表达；情绪与特征标注「规则口径」）、工作方式数据链与视图承接（`fin_analyze` 落图）、自检项（阶段与关键位禁止目测）；quant——职责（规则化产物优先写 DSL）、专业判断 +「DSL 纪律」硬规则（白名单函数 / 禁 `ref` 负偏移 / stop_target 表达式依据 / 先 lint 后 run）、工作方式 DSL 落地路径（lint → run → `fin_backtest template=dsl` 同口径回测）、数据链、自检项。
- **新增技能**：`skills/strategy-dsl`（88 行：DSL 全字段语法 / 表达式白名单表 / lint→run→回测工作流 / 常见错误与修正表 / 纪律）；投研两席不持有其他技能变更。
- **接口绑定断言**：`server/tests/m21.test.ts` 增加 M83 绑定（`fin_analyze` 归技术面 / `fin_strategy` 归量化 / 其余角色不持有；quant skills 含 strategy-dsl）。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**；check:skills **71/71 ✅**（新增 strategy-dsl）；`npm run eval`（mock 确定性）**56/56 ✅**（本批仅工具白名单 / 技能预载与人设增量，mock 面具零影响）；server 全量 **131 文件 / 1565 用例 ✅**（M83 新增 m83-analysis 15 / m83-dsl 20 / m83-finance-tools 12 / 回测 dsl 通道 1）；client 全量 **126 文件 / 1383 用例 ✅**（新增块 spec 扩展 / 分析面板 / 块级分析渲染 / 面高迁移）；双端 + e2e typecheck 0 错。
- 相关文档：**ADR 0219** / design.md **§124** / `docs/kline-analysis-dsl-design.md`（状态已回写）。

### v105 — 过程叙述通道与 40 场景协议全量铺设（M81 批 B）

- **动因**：Agent 对话啰嗦治理（设计基线 `docs/turn-card-process-design.md` v2）——content 通道补齐第三类可折叠「过程叙述」，与思考 / 工具调用组成 TurnCard 过程区；渲染端同批落地（`::: process` 容器 + ProcessBlock + 过程区重排 + mock「过程走查」触发块 + E2E `m81-turncard-process`）。
- **全局契约**：`_protocol.md` `<style_channels>` 三通道 → 四通道（新增「过程叙述（可折叠）」行：收进 `::: process`、≤3 句、放发言末尾、容器内不写 @）；追加两条红线（复述确认仅对新增信息、同一事实不重复；安全合规提示与交付落盘声明禁止折叠）；工具说明句微调（连续第二句起的自述收进容器）。
- **场景协议（40/40 全量铺设）**：各新增「## 过程叙述约定（界面承接）」段（位于 `## 质量红线` 前，标准 3 条）——A 型 32 场景 = 标准段；B 型 4 场景加「方法性复述豁免」第 4 条（philosophy / metaphysics / moot-court / brainstorm）；C 型 4 场景加「复述去重 + 危机红线置顶」第 4 条（wellness-mind / personal / care / relationship）；tarot 条目 11 改文对齐（过程 `::: details` → `::: process`，`::: details` 保留参考资料类展开）。
- **角色与声纹（3 改 1 免）**：emotion-companion（「每轮先复述」→「仅对新增信息复述」，AGENT.md 3 处 + voice.md 开口句改写 + 容器示例 1 条）；coach（2 处）；rel-coach（1 处）；socratic-host 免改（场景协议显式豁免，机制先例）。审计依据：161 份 AGENT.md 全量 grep「复述」50 处 / 19 角色，仅 3 角色含逐轮复述型指令；24 份声纹「开口先…」11 处仅 emotion-companion 1 处为叙述型；70 技能复述 22 处均为方法本体（保留）。
- **门禁**：check:agents `PROTOCOL_SECTIONS` 增第三段「## 过程叙述约定」（报告行「协议 40/40」含三段；CI 常驻 `QUALITY_STRICT=1` 下与铺设同批落地）；`agents/README.md` 容器清单追加 `::: process`、gate 描述改三段。
- **核验**：check:agents（`QUALITY_STRICT=1`）**161/161 + 协议 40/40 + 声纹 24/24 ✅**；`npm run eval` **56/56 ✅**（mock 基线无回归）；server 全量 **1488 ✅**（context 预算夹具随资产扩容 16k → 17k：实测 16.3k±，夹具注释内登记；M81 批 A 渲染面由 client 测试覆盖）；client 全量 **1367 ✅**；E2E m81 **2/2 ✅**；双端 typecheck 0 错；lint 0 error。

### v104 — 灵魂变体批三：财务 / 投研 / 增长三席（auditor / contrarian / surgeon）

- **产出**：`finance/finance/souls/auditor.md`（数字审计：先口径后数字、差异必追）· `invest/invest-lead/souls/contrarian.md`（逆势验证员：证伪优先、先给失效条件；边界显式保留「不构成买卖指令 / 不预测点位」合规红线）· `marketing/growth/souls/surgeon.md`（增长外科：单点突破、砍无 ROI 动作）；灵魂变体 14 角色 22 条 → **17 角色 25 条**。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**（三席位 souls 解析通过）；本批仅新增灵魂资产与文档行，无角色文案变更（mock 面具零影响）。

### v103 — 灵魂变体批二：研究 / 学习 / 行政三席（first-mover / socratic / precise）

- **动因**：跨空间双人格续批（v102 机制延续）——覆盖研究、学习、行政三条高频工作流，同步扩大「空间默认灵魂」档案卡的可选面。
- **产出**：`research/lead/souls/first-mover.md`（破题急先锋：三假设先发后收）· `learning/tutor/souls/socratic.md`（苏格拉底教练：只问不答、答案由学员说出口）· `ops/assistant/souls/precise.md`（精准秘书：15 分钟颗粒度 + 行动项三要素）；灵魂变体 11 角色 19 条 → **14 角色 22 条**。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**（三席位 souls 解析通过）；本批仅新增灵魂资产与文档行，无角色文案变更（mock 面具零影响）。

### v102 — 灵魂变体补齐：跨空间双人格批次（coach / life-admin / pm）

- **动因**：work-life 专项「双灵魂资产补齐」首批——为高频跨空间角色补第二人格，使「空间默认灵魂」（`spaces.soulOverrides` 档案卡）有足量可选面。
- **产出**：`personal/coach/souls/action.md`（行动督导：目标—行动—结果）· `personal/life-admin/souls/minimalist.md`（极简管家：七天临期清单 + 归档思维）· `development/pm/souls/driver.md`（推进督工：结论先行、日期钉死、反含糊）；灵魂变体 8 角色 16 条 → **11 角色 19 条**。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**（三席位 souls 解析通过）；本批仅新增灵魂资产与文档行，无角色文案变更（mock 面具零影响）。

### v101 — 仪式订阅资产声明：tarot / wellness-mind / personal 三场景 ritual 模板

- **动因**：「工作生活一体」P4-A 仪式订阅（ADR 0215）需场景侧声明模板——`_group.yaml` 新增 `ritual` 块（title / cron / opener / description）。
- **产出**：tarot「每日塔罗」（每晚 22:00）· wellness-mind「每日正念」（每天 08:30）· personal「每周复盘」（周日 20:00）；`PromptLibrary.validate()` 增 ritual 校验（cron 合法性 + members 跨引用，随 check:agents 生效）。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**（40 场景含 ritual 声明解析通过）；本批仅新增声明块与校验，无角色文案变更（mock 面具零影响）。

### v100 — 头像补齐：v99 新增四席 512×512 落盘

- **动因**：v99 新增 funding/dd-analyst（卫衡）与 wellness-mind 三席（听澜 / 安屿 / 知澄）未配头像（check:agents 以头像为可选资产不拦截，角色列表回退渐变图标）。
- **产出**：四席头像按 §19 生成规格（纯白底 #ffffff · 风格化 3D 卡通成人比例约 1:4 · 半身像居中 · 哑光质感 · 场景主题色元素；防幼态：成熟面部结构 / NOT chibi；眼睛具白巩膜 + 虹膜细节）生成并 512×512 落盘——`agents/funding/dd-analyst/avatar.png`、`agents/wellness-mind/{emotion-companion,mindfulness-guide,psycho-educator}/avatar.png`；design.md §19.1/§19.2/§19.3 同步（设定表按成品观测补录四行；图片资产计数 40 场景共 160 张；business-sim 三行随场景下线移除）。
- **核验**：check:agents **161/161 + 协议 40/40 + 声纹 24/24 ✅**（四席 avatar:✓）；eval（mock 确定性）**56/56 ✅**；本批仅新增图片资产与文档行，无角色文案变更（mock 面具零影响）。

### v99 — 场景体系调优：新增心理支持与尽调分析师、下线辩论场与商业沙盘、事实核查收编议题主持

- **动因**：全量盘点（40 场景 / 165 角色）后发现三类问题——心理情绪支持为最大空白（relationship / care 均明确排除诊疗）；funding 缺投资人视角的一级市场尽调；对抗推演域同质化（debate / business-sim 与 negotiation / moot-court / society 重叠）、society/fact-checker 与 research/verifier 职能重复。
- **新增**：`wellness-mind/` 心理支持场景（emotion-companion 听澜 / mindfulness-guide 安屿 / psycho-educator 知澄；协议含危机红线零容忍、非治疗定位、倾听先于建议；串行陪跑链路）；`funding/dd-analyst` 卫衡（四线尽调 / 红旗分级 / 证据三级标注，接入 fundraiser → dd-analyst → ir 链路，fundraiser handoff 同步）。
- **下线**：`debate/` 整场景（4 角色）与 `business-sim/` 整场景（3 角色）；`society/fact-checker`（尚真）。mock.ts 四件套镜像、`交锋走查`（RULING）与 `回合走查`（SIM）触发块、e2e AGENT_NAME 同步移除；预设 `classic-debate` 删除。
- **society 收编**：事实核查职责并入 moderator（齐观）——协议分工改为「主持先行核查事实基线 → 立场 / 政策伦理并行 → 收口」，观察报告新增事实基线章；齐观补挂 `source-verification` 与 web 检索工具；stakeholder / policy-advisor / philosophy 引用改写；预设 `issue-roundtable` 改 3 人链路。
- **配套补强**：组队预设 33 → 43（塔罗三张快解 / 跑团快速开团 / 论文冲刺 / 哲学茶席 / 关系体检 / 家庭一周安排 / 财务体检 / 维权路径评估 / 模拟庭审 / 销售冲刺 / 情绪安顿）；灵魂变体 +6（general 干练·温暖 / 观照 学院派·直觉派 / 马骁 魔鬼教官·温和陪练）；声纹 +3（听澜 / 观照 / 观复；于清声纹沿用 P1 首批）；health 场景补挂孤儿技能 `health-metrics`；README 数字同步（40 场景 / 161 角色 / 59 评测任务）。
- **评测**：eval 任务 39 → 59（健康 / 家庭 / 财富 / 个人 / 学习 / 旅行 / 情感 / 个人法务 / 运营 / 塔罗 / 跑团 / 哲学 / 自媒体 / 电商 / 融资尽调 / 写作 / 模拟法庭 / 心理支持 / 财务法务 / 销售 / 学术全覆盖；23-society 重写为三人链路；21-debate 删除）；eval（mock 确定性）**56/56 ✅** 基线已刷新；mock 镜像覆盖 5/5 ✅；`check:agents` **161/161 + 协议 40/40 + 声纹 24/24 ✅**；typecheck（server + client + e2e）0 错；E2E 受影响 spec（m43-pk 谈判保留 + m52-stage 圆桌 3 席 / arena 改谈判桌）**24/24 ✅**。
- 相关文档：**ADR 0212** / design.md **§118** / `docs/adr/README.md` 索引。

### v98 — 塔罗亲手抽牌台：复现三元组工具扩展与抽牌口径协议同步（M78）

- **动因**：M69 后塔罗抽牌为 AI 单方行为（用户只能看 `::: cards` 卡），与「塔罗研习」的参与感相背（用户诉求：亲手随机选牌 + 完整专业牌面）。本批补齐抽牌台（六阶段仪式：静心 → 洗牌 → 切牌 → 亲手选牌 → 逐张翻牌 → 成阵），并扩展工具复现口径。
- **协议层**：`agents/tarot/_protocol.md` 新增铁律 8（用户亲手抽牌时按复现三元组 seed + cut + picks 原样传入 `tarot_draw` 复算，逐位核对后解读；禁止无视参数另抽，也禁止直接采信用户转述的牌面文字——正式牌面一律以工具复算为准）；铁律 1 与工具纪律第 9 条补参数口径（铁律 8 后工具纪律段序号顺延至 9–12）；`tarot-reader/AGENT.md` 补「亲手抽牌复算」职责一行。
- **工具层**：`tarot_draw` 增可选 `cut`（0/1/2 = 第 c 堆放最上，牌堆旋转）与 `picks`（不重复 0-77 整数，长度 = 牌阵张数）；算法重构为「洗牌 → 78 张逐张定正逆位（牌带正逆位）→ cut 旋转 → picks 取牌」——缺省（0 / [0..N-1]）与旧版逐位一致（m69 golden 原样通过）；summary / detail 追加复现三元组行；`::: cards` 卡模板契约不变。
- **技能层**：`skills/tarot-reading` 补复现三元组（seed + cut + picks）与亲手抽牌复算口径；检查清单加一条。
- 评测：server 全量 **107 文件 / 1345 例 ✅**（含 `m69-tools` 13 例缺省兼容回归 + 新增 `m78-tarot-ritual` 6 例：cut/picks golden / 旋转等价 / 校验 / 工具壳）；client 全量 **109 文件 / 1258 例 ✅**（新增 `m78-deck` 6 例跨端向量字面一致 + `m78-ritual` 10 例；`m69-md-ext` 17 例回归）；E2E 新增 `m78-tarot-ritual` **2/2 ✅**（隔离环境 8795 / e2e-m78）+ 邻回归 `m69-cards` / `m52-stage` **25/25 ✅**；typecheck 全仓 0 错；`check:agents` 165/165 + 协议 41/41 ✅；`check:skills` 70/70 ✅；`eval`（mock 确定性）**36/36 ✅** 无回归。
- 相关文档：**ADR 0187** / design.md **§113** / `docs/tarot-ritual-design.md`（专项设计全量落盘）/ docs/adr/README.md 索引。

### v97 — 输出语言纪律加固：协议输出契约强化 + 回合指令语言行（防英文旁白漂移）

- **动因**：用户截图报障——成员发言出现整句英文旁白（工具调用前的说明句，如 "I'll start by checking the workspace for any existing materials."；同型样本此前已在 m55 测试夹具留档）。定位：该文本由模型实时生成（不在代码内），根因是协议中语言条款过弱（单行「使用简体中文」）+ 回合指令（最强位置的 user 消息）未复述语言纪律，模型在多工具调用场景下漂移为英文旁白。
- **协议层**：`agents/_protocol.md` `<output_contract>` 重写——「全程使用简体中文：发言、分点与工具调用前后的说明句一律用中文成句；禁止整句英文输出（含工具调用前的英文旁白）」+ 例外清单（技术术语 / 工具名 / 文件名 / 命令与路径可保留英文；引用外语原文、翻译语料与代码块不受限）。
- **引擎层**：`context/assembler.ts` `buildTurnInstruction` 三范式（execute / plan / review）统一在首行（「现在轮到你…」）后追加语言纪律行（「全程使用简体中文输出（含工具调用前的说明句）；技术术语 / 工具名 / 文件路径可保留英文。」）——回合级复述以抵消长系统提示下的规则稀释。
- 测试：m48-roster 新增 1 例（三范式回合指令均含语言纪律行）；server 全量 **107 文件 / 1345 例 ✅**（含 context.test 预算夹具无回归）；server typecheck 0 错；check:agents **165/165 + 协议 41/41 ✅**；eval（mock 确定性）**36/36 ✅** 无回归。
- 相关文档：design.md **§40.5**（回合指令模板行更新）。

### v96 — SSH「本地」预置：连接管理新建表单一键填入（连接中心微批；**agents 资产零变更**）

- **动因**：新建 SSH 连接需逐项手填主机 / 端口 / 用户名 / 认证方式；「连本机」是开发与演示的最常见起点，但本机用户名 / 默认私钥路径 / sshd 是否在监听都要人工查（macOS 默认不开启 sshd，需系统设置开「远程登录」）。
- **服务端**：探测 `detectSshLocalPreset`（`connections/ssh/local-preset.ts`）——用户名 `os.userInfo`（极端环境回退 `USER` / `USERNAME`）· 认证优先级 agent（`SSH_AUTH_SOCK`）> key（`~/.ssh` 默认私钥 ed25519 → rsa → ecdsa，`~` 形式回传、连接器既有 `expandHome` 展开）> password · 22 端口 TCP 探测（600ms 超时，connect / timeout / error 三路收敛布尔）；依赖全可注入（homeDir / env / username / probePort）——单测零触网。端点 `GET /api/connections/ssh-preset`（adminOnly；注册先于 `/connections/:id` 防被 id 参数吞没）。
- **前端**：新建 SSH 表单顶部「本地（本机）」chip → 一键回填 name（仅在空时）/ host / port / username / authMethod / privateKeyPath（凭据字段不动）+ 探测结论行内提示（22 端口未监听 → 系统「远程登录」指引）；编辑态不出现；不代建连接（审阅后「保存 / 保存并测试」，`allowExec` 保持默认关）。
- 评测：server 全量 **106 文件 / 1328 例**（1327 ✅；1 例 m42 圆桌例会超时属全量并发负载假失败——单跑 3/3 ✅，与本批无关）；client 全量 **107 文件 / 1237 例 ✅**（m23-frontend 15 例含新增 1 例）；typecheck（server + client + e2e）0 错；agents 资产零变更（eval / check:agents / check:skills 不受影响，未跑）。
- 相关文档：**ADR 0185** / design.md **§112** / docs/adr/README.md 索引 / docs/api.md §11.1。

### v95 — 联网检索反爬专项：web_search 多引擎降级链（百度 → Bing → 搜狗 → 360；协议一行同步）

- **动因**：用户报障（界面截图）——百度检索连续「已触发网站风控，冷却 60s」，免 Key 模式完全无结果；实测出口 IP 对 `www.baidu.com/s` 与 `m.baidu.com/s` 全部 302 到安全验证页（IP 级封锁，Cookie 预热 / UA / 限速等单点对抗全部失效）。
- **协议层（一行）**：全局 `_protocol.md` 联网纪律——「百度检索」改「联网检索：百度/Bing/搜狗/360 多引擎自动降级」；风控纪律不变（被拦截不反复重试）。
- **引擎层**：新增 `tools/search-engines.ts`——4 引擎适配器（URL 构造 / SERP 解析 / 可选预热，统一 SearchItem）+ 注册表；`web_search.ts` 免 Key 模式改引擎链执行（`searchViaEngines`）：按序尝试、被风控/冷却自动跳过、结果标注 `网页抓取·引擎（降级）`、detail 首行附跳过记录、全链失败汇总各引擎原因 + API Key 建议；`parseBaiduSerp` 迁出并 re-export 兼容。
- **传输层**：反爬状态键 hostname → host（含端口；默认端口下行为等价）——多引擎冷却天然隔离；`WEB_SEARCH_ENGINES` 环境变量（空 = 内置链）。
- **质量层**：摘要净化补强——命名/数字实体解码（`&ensp;` / `&#0183;`）、全角标点前空格清除（em 高亮标签边界）。
- 评测：eval（mock 确定性）**36/36 ✅** 无回归；check:agents **165/165 + 协议 41/41 ✅**（报告模式）；server 全量 **106 文件 / 1323 例 ✅**；typecheck（server + client + e2e）0 错；实证：四引擎真实 SERP 抓取与解析回归通过（首选可用直返；风控时段降级引擎正常接管）。
- 相关文档：**ADR 0184**（承接 0035）/ `docs/adr/README.md` 索引 / `docs/operations.md §4.5`（`WEB_SEARCH_ENGINES`）/ `.env.example` / README 工具描述。

### v94 — 批九：dock 右区宽度自适应——默认容器 1/3 · 上限最多一半 · 双击复位回自适应（前端微批；**agents 资产零变更**）

- **动因**：用户实测反馈（两栏 dock 截图）——固定口径不适应窗口（默认 360 宽屏偏窄 / 上限 640 写死），诉求「这种两栏的可以优化下宽度，支持拖动到最大为1半默认可以增大点宽度或者根据实际窗口自适应等等」。
- **宽度口径**（persist.ts）：上限 = 容器一半（`dockMaxW` = max(280, ⌊容器×0.5⌋)，左对话区恒保 ≥50%）· 默认 = 容器 1/3（clamp 380–600，宽屏较旧 360 明显变宽）· `DockPref.width: number | null`（null = 自适应；双击复位回自适应；旧 360 迁移 null）· 存储只做下限护栏、上限渲染期动态收敛（不写回临时值）。
- **宿主与交互**（DockStage）：ResizeObserver 观测 `.scene-dock`（窗口 / 会话栏开合联动）；拖拽 / 键盘 / 双击三入口共用动态口径；把手 aria-valuemax 随容器实时化；`.scene-dock-aside { max-width: 50% }` 硬兜底；决策见 ADR **0183** / design.md **§111**（编号让位：§110 / 0182 / v93 已被并行批「报告专业化」占用）。
- 评测：client `m52-stage` **58 → 62 例 ✅**；E2E `m52-stage` 全量 + 新增「批九」1 例 ✅（隔离环境 8795 / e2e-dockw）；typecheck（client + e2e）0 错。
- 相关文档：**ADR 0183**（修订 0127）/ docs/adr/README.md 索引 / docs/scene-expansion-design.md（§7.2 dock 行 + 头部修订注记）/ design.md §111。

### v93 — 报告专业化：交付规格闭环（协议四档 + report-authoring 技能 + 16 角色契约量化 + 引擎规格注入/体检/append）

- **动因**：用户反馈「交付件不够专业、报告偏短或不完善」——根因定位：①篇幅语义缺位（200 字约束未区分发言与交付件）；②深度标准未量化；③长报告单次成文写不完（无追加工具）；④无质量门禁；⑤素材无沉淀。
- **协议层**：全局 `_protocol.md`——「简短优先」改双轨表述（仅指对话发言；交付件按规格展开）；新增 `<deliverable_spec>` 四档规格（速览 ≤800 / 标准 1500–4000 / 深度 ≥4000 / 专项多件套）+ 档位优先级（用户显式 > 计划验收 > 角色契约默认）+ 分章撰写纪律（骨架占位 → 逐节填充，深度档禁止单次成文）+ 量化自检 + 可独立成立要求。
- **技能层（+1，69 → 70）**：新增 `report-authoring`——四档规格表 / 分章撰写流程 / 六类领域章节库（研究 / 投研 / 行业 / 经营复盘 / 决策方案 / 议题简报）/ 量化自检清单 / 五条反模式。
- **角色层（16 角色）**：research×4 / invest×5 / strategy×4 / bi×3 在「交付契约」追加「默认档 + 量化下限（字数 / 章节 / 证据密度）+ 降档裁剪规则」，front-matter 预载 report-authoring；m21 断言 5 处 + m30 断言 1 处同步。
- **引擎层**：①规格解析 `deliverable-spec.ts`（会话级粘性关键词：速览/简报 vs 深度报告/详细报告 → 回合指令注入档位行，未声明不注入）；②`write_file` 增 `mode=append`（长文档分节撰写，空行衔接；不存在时等价新建）；③落盘体检回灌 `doc-metrics.ts`（非空白字符 / 二级章节 / 表格 / 来源标记 → 工具 detail，模型对照规格自检）；④深度档工具步数上限 8 → 12。
- **评测层**：断言器新增 `min_chars` / `min_sections` / `min_sources`（assertions.ts 四处同改；与体检共用 measureDoc 统一口径）；research / invest golden 任务补规格断言；新增 `tests/deliverable-spec.test.ts`（4 例）+ tools/m9 追加 append/体检/新断言用例。
- **镜像面**：agents/README.md（70 技能分组 + 预载表 4 行更新 + 新增「交付规格与报告写作」节）；context.test.ts 预算夹具 15k → 16k（协议段 + 技能索引增重，实测 15.0k±）。
- **真实模型探针实测（三轮，新增 `--real` 设施）**：eval 支持 `--real`（真实模型执行 `real:true` 探针任务；不参与 mock 基线；`--keep` 保留工作区供复查）+ golden 任务 `depth-report-spec`（research 团队按深度档产出专业长报告）。三轮实测：①10 回合预算耗尽（turn-limit），报告仅骨架 559 字（副发现：关键词表漏「深度档」致规格注入未触发）；②修词表 + 回合 16 → 报告 10279 字 / 8 章，但引用格式 `S-01`（连字符）与 15 处占位残留暴露口径盲区；③修正口径（min_sources 支持 S-01 与裸编号；体检增占位残留警告）→ **全绿**：13947 字 / S01–S20 连续来源链 / 占位 0 / judge 8 分（「六章节完整非提纲、置信度逐条、证据链可追溯」）。三轮成本约 $2（DeepSeek）。
- **探针扩组与编排实测（v93 续）**：新增 `invest-depth-report`（4 人链·宁德时代）与 `bi-monthly-analysis`（3 人链 + `seedFiles` 工作区播种 CSV 数据集）两个真实探针；eval 增 `seedFiles` 字段。实测：投研 **6/7**（报告 13355 字 / 8 章 / 13 表 / 四件交付件齐全；judge 6 扣于「无 fin 数据源时公开资料核验深度」）；BI **5/6**（报告 17847 字 / 10 章 / 23 表 / 口径先行与归因假设完整；judge 6 边际）；三探针组就绪（research 全绿 / 投研与 BI 结构类断言全过）。实测发现三类编排层行为（登记不修，供后续评估）：① PRS 单助手扩编后新成员仅获一棒、探索工具耗尽回合预算而无产出文本（探针以 `MAX_TOOL_STEPS=16` 推进）；②「口径待确认」自锁阻塞下游（任务侧以「不因待确认阻塞」纪律化解）；③偶发英文漂移（规划短句）。
- **交付件体检徽章（v93 续）**：`shared/src/doc-metrics.ts` 单一实现（server write_file / eval 断言 / client 预览三端同口径，原 server 副本删除）；ArtifactsView Markdown 预览新增体检条（字数 / 章节 / 表格 / 来源 / 占位残留警告）；新增组件测试 2 例。
- 评测：eval（mock 确定性）**36/36 ✅** 无回归（3 个探针任务自动跳过）；check:agents（strict）**165/165 + 协议 41/41 ✅**；check:skills（strict）**70/70 ✅**；server 全量 **107 文件 / 1345 例 ✅**；client **108 文件 / 1248 例 ✅**；四包 typecheck 0 错。

### v92 — 外部技能与 MCP 安装批：8 技能 + 9 台免 Key MCP 服务器（资产扩张；角色人设正文零改动）

- **动因**：用户发起——按全部 agent 定义（41 场景 / 165 角色）从 GitHub / 官方生态检索适配的 Skill 与 MCP，**免 Key 口径**（需要 API Key / 身份声明的候选一律不装），逐个安装并逐个验证。
- **技能（+8，61 → 69）**：literature-search（paper-search）/ natural-writing（avoid-ai-writing）/ test-driven-development（superpowers）/ secure-coding（claude-code-owasp + Trail of Bits）/ brand-naming（naming）/ translation-quality（en-zh-translation-polish）/ user-persona（claude-persona）/ health-metrics（Claude-Ally-Health）——全部按 ADR 45 改写为仓内可执行中文方法论（60–150 行）。
- **预载（14 角色，≤4 上限内）**：lit-reviewer / scout × literature-search；editor / content / paper-editor × natural-writing；backend × TDD；security / ai-engineer × secure-coding；brand / account-strategist × brand-naming；localizer / ux-writer × translation-quality；ux-researcher / influencer × user-persona；health-metrics 按需加载（生活场景不硬配）。
- **MCP（9 台，mcp.json 文件权威）**：sequential-thinking / memory / time / weather / markitdown / deepwiki / context7 / arxiv / yfinance（合计 55 工具，全部免 Key）；只读服务器 readOnlyOverride；工具 wildcard（mcp__<slug>__*）接线 50 个角色文件；会话绑定后可见（M27 最小权限语义不变）；安装台账与设计记录见 design.md §109。
- **镜像面**：m21 断言 4 处（security / content / brand / localizer）；context.test.ts 预算夹具 14k → 15k（69 技能索引增重，实测 14.2k±）；m35 运行时绑定用例跳过 MCP 通配条目（格式守卫保留）；agents/README.md 统计与分组表更新（162→164 业务角色、69 技能、预载表 14 行、MCP 工具条目）；命理占星分组补登存量 fengshui。
- 评测：eval（mock 确定性）**36/36 ✅** 无回归；check:skills（strict）**69/69 ✅**；check:agents **165/165 + 协议 41/41 ✅**；server 全量 **103 文件 / 1297 例 ✅**。

### v91 — 批八 M45 轻回放落地：波次回放条（R-1；R-2 条件维持 · R-3 收敛声明）（前端批；**agents 资产零变更**）

- **动因**：全场景深度优化总账最后一批（条件性批次主动推进）——ADR 0081 预定口径正式兑现：**轻回放只做波次级跳转**（不重建历史 UI 状态），全状态时间旅行维持被否决。
- 交付梗概：`client/src/lib/wave-replay.ts` 波次节点派生（waveNodesOf：`waveOf` 唯一 runId~turnIndex 首次序、wave-sep 与成员行同源去重、**单条波次成节**、首条成员消息为锚点）+ 活跃序号（activeWaveIndexOf，与悬浮阶段条同源）+ 尾沿节流（createTrailingThrottle 150ms）；`WaveScrubber` 组件（≥2 波常驻 Composer 之上：数字刻度点选 / prev·next / 计数高亮）；ChatArea 挂载，跳转 = focusMessage 滚动 + 闪光复用；决策见 ADR **0179** / design.md **§108**。
- **R-2 / R-3 处置**：R-2 互动统计后端化触发条件未出现（维持条件性，ADR 0082 路径待命）；R-3 面板联动声明为既有覆盖（定位模式已普遍化）。
- E2E 口径（踩坑沉淀）：并行场景需 `disableSerial`（会话串行默认开启，逐位出场）+ 全员 @ 才收敛严格单波；短会话 align:center 下活跃序号可能钉在第一波——断言以跳转触发 + 闪光为准。
- 评测：见 design.md §108.2 收口账（单测 10 例 + E2E 1/1 + 域回归全绿）。
- 相关文档：design.md §108（含 **8 批总账收官声明**）/ ADR 0179 / `docs/scene-chat-design.md` 头部（编号修订十 + §13 落位注记 + 状态行）/ `docs/adr/README.md` 索引。

### v90 — M66 v3 续完善：叠图自动找正（指北交互 + 快照识别；ADR 0178）

- **动因**：ADR 0175 留「自动识别图纸朝向列 v3 评估」——评估结论：像素级找北需 CV/OCR 依赖（与零依赖纪律冲突）→ 转**交互式找正 + 来源识别**（专业图纸工具通用做法）。
- **指北模式**：工具条「指北」→ stage 提示 + 十字光标；点击后按相对图心方位角 `atan2(nx, −ny)` 计算旋转角（北 0° / 东 90° / 南 180° / 西 270°，1° 圆整）→ 网格北格指向所点方向；与滑条同一 `rot` 状态无缝互用。
- **快照识别**：底图为 `design/snapshot-*`（Studio 快照天然北向上）→ 提示条「工作台快照（已按北向上）」；其余来源显示操作引导。
- **防误触**：指北模式网格 `pointerEvents: none`（格点击让位）；rect 零尺寸防护；另修复 v2 重构时 note 行丢失（升级为动态提示）。
- **测试**：client m66-luopan +2（指北：rect mock → 东 90°/北 0° + 提示显隐 + 滑条联动；快照识别）→ **1195/1195 ✅**；E2E 第二 test +4（指北点击 → rot 80–100° poll → 复位）→ **m66-fengshui 2/2 ✅**（8.3s + 13.6s）。
- 相关文档：**ADR 0178**（0177 已被批六 console 占用）/ docs/adr/README.md 索引 / docs/design-studio-design.md（实施注记 + §10.3 v3 注记）。

### v89 — 批六 console 面板二批：五场景分支落地（客户管道 / 经营指标 / 节奏 / 融资进度与问答 / 主张与依据）（前端批；**agents 资产零变更**）

- **动因**：全场景深度优化批六（M41 §9 边界遗留项「console 面板专业化另批评估」落地）——console 全量场景补齐：sales / ecommerce / marketing / legal-personal / funding（bi / sre 由 M66 已落；finance 为 stream 无 console）。
- 交付梗概：**sales** `::: pipeline` → 客户管道段（阶段列 + 未知归「其他」+ 金额合计可解析才计 + 点卡定位）；**ecommerce** 经营指标（KpiCells 复用）+ 大促节奏；**marketing** 内容节奏；**legal-personal** 案件时间线 + 主张与依据（claim）；**funding** 融资进度 + 投资人问答（ProgressCard / QaCard **同组件渲染**）；通用时间轴让位规则自 sre 扩展至节奏场景；claim 单一解析补全（新导出 `parseClaimLines`，`finalizeClaim` 重构共用——ADR 0144 红线）；KpiCells 提取（bi/sre/ecommerce 三处收敛，DOM 不变）；决策见 ADR **0177** / design.md **§106**。
- **mock 辅助（唯一脚本改动）**：两组触发块——「店铺走查」（store-operator → kpi + timeline）/「案件走查」（rights-advisor → timeline + claim）；marketing 由 content 基础剧本自带 timeline（零改动）；sales / funding 复用 M41 触发块。
- 评测：见 design.md §106.3 收口账（组件 9 例 + 回归 110 例 + E2E 5/5 全绿）。
- 相关文档：design.md §106 / ADR 0177 / `docs/adr/README.md` 索引 / `docs/scene-chat-design.md` §9 落位注记（遗留项闭环）。

### v88 — M66 续完善：择日盘（zeri_pan）· 兼向判定 · 叠图旋转对齐（风水阳宅 v2 三件；ADR 0175）

- **动因**：M66 收官时显式留待 v2 的三项（择日 / 兼向替卦判定 / 叠图旋转对齐）——本批全部落地。
- **历法基础域**：`pan/calendar.ts`——JDN / 日干支（`(JDN+49) mod 60`；golden 双锚点：2000-01-01 戊午 · 2024-01-01 甲子）/ 节气「节」近似 + 月建（节前 / 节后分支）。
- **择日排盘**：`pan/zeri.ts`——建除十二神（月建随节气 + 日支顺推）+ 日支冲煞（冲生肖 / 三合煞方）+ 八类事项 + 1–5 评分 + 推荐序；区间 ≤ 31 天；**破日合规表述「传统列为诸事慎用日」**；`zeri_pan` 工具（deferred 只读；`::: pan zeri` 整卡；tool_search「择日 / 日课 / 吉日 / 黄道 / 建除」）；golden：2026-09-20..28 搬家逐日（满 5 · 成 5 · 定 4 · 破 1）。
- **择日盘（第 11 类 pan 卡）**：`zeri-model` 派生 + `ZeriBoard`（推荐 chips / 星级 / 破日合规注 / 行点击回填 / AskBar：推荐日细节 / 放宽区间）；PAN_KINDS · 双份 PanKind · derive · PanView 全链接线。
- **兼向判定（luopan 扩展）**：`pitchOf`——山中心 ±4.5° 下卦带 / 两侧 3° 兼向带；**仅 A 级启用**（B/C 输出「未判定」）；兼向仅判定 + 声明（替卦排盘需专业复核、本盘按下卦呈现）；盘卡字段行 + 工具文本 + notes 文案同步。
- **叠图旋转对齐**：GridOverlay 对齐滑条 0–359°（格随网格整体旋转——ADR 0171「被否决」判断修正）+ 复位 + 角度显示；测试与 E2E 断言 transform。
- **资产**：司南 AGENT（+择日职责 / capabilities / `zeri_pan` 白名单）、fengshui 协议（容器约定 + 择日纪律 #12）、SKILL（择日速查 + 反模式扩）、blank general 白名单（差集不变式保留）、mock `ZERI_BLOCKS`（建除真值块：丁酉建 / 己亥满 / 辛丑定 / 癸卯破 / 乙巳成）。
- **评测**：server **1294/1294 ✅** · client **1184/1184 ✅** · E2E **m66-fengshui 2/2 ✅**（续完善全链 14.6s：择日卡 → 附件 → 叠图 → 旋转对齐）· check:agents 165+41 · check:skills 61/61 · eval **35/36**（1 红为 M63 外部批「参考声明」中间态欠账，非本批引入。归属记录）。
- 相关文档：**ADR 0175**（0174 已被 M77 同角多魂占用）/ docs/adr/README.md 索引 / docs/design-studio-design.md（实施注记 + §10.1 兼向行升级 + §10.3 叠图对齐修订）。

### v87 — M77 同角多魂 / 成员分身落地：成员键 · 参与性格多选 · 全伞寻址（全栈批；**人设 / 协议 / 灵魂资产零变更**，仅 README 用法补充）

- **动因**：用户「不同 soul 性格特点的 agent 是多个 agent；可以选择具体的性格参与，不是无脑全加入」——同一角色的不同人格需能以多个成员实例同台（如 卢娜·狂野 + 卢娜·禅意），组建时按人格勾选、运行中可增删与换装。
- **成员键（ADR 0174）**：`participantIds` 条目升级为成员键——经典 = `agentId`（存量零迁移），分身 = `agentId~soulId`（自描述）；`memberSouls` 语义不变；同角有效灵魂去重、无 souls 不可分身、同角 ≤ 4；`PromptLibrary.get/soul` 容忍成员键。
- **寻址与展示**：裸名 @ = 该角色**主实例**（编制序首位；2026-09-19 收口修订，原「全伞」口径未上线——判据：最小意外 / 代价不对称 / 显式优于隐式）；`@名字·灵魂名` = 点名实例（token 边界排除 `·`）；全伞 = Composer @候选「名字（全部 N 位）」一键逐一点名（零新语法）；同角多实例在场时统一展示 `名字·灵魂名`（单实例零外观变化）。
- **数据归口**：`ChatMessage.agentId` 保持基础角色 + 新增 `memberKey`（迁移 v20 `messages.member_key`）；queue/spoken/turn 事件/计划/任务用成员键；artifacts/记忆/审批沿用基础角色；分身换装 = 键替换（运行中同步队列/便条）。
- **全栈**：shared `members.ts` → server（parser 会话向 token 表 / 装配 roster 实例化与寻址指南 / engine 成员键化 + `replaceMemberKey` / routes 编制校验与三写 / mock memberLabels 点名）→ client（`lib/members` 参与性格编解码 / 组队台 SoulParticipantPicker / AgentPicker 「+ 分身」Portal 弹层 / 成员卡·消息·点名·指挥条·图谱·面板按成员键归口）。
- **测试**：server `tests/m77-soul-instances.test.ts` 11 例 + client `tests/m77-soul-instances.test.tsx` 9 例 + e2e `m77-soul-instances.spec.ts` 2 条；全量：server 1285/1285、client 1174/1174、e2e 定向 10/10（含 m16-members / m16-soul / m48-routing / relay / right-panel 回归）。**（终账见下「续完善」段：14+14 例 / 1293/1294 / 1184/1184 / e2e 定向 9/9）**
- 评测与门禁：eval **35/35 ✅**（与基线零回归）；check:agents **165/165 + 协议 41/41 ✅**（QUALITY_STRICT）；check:skills **61/61 ✅**；四包 typecheck 0 错误。
- 相关文档：ADR 0174 / design.md §105 / docs/api.md（成员键三写与 souls 约束）/ README.md 核心机制（同角多魂）/ `agents/README.md` 灵魂层用法补充；编号：CHANGELOG v87、ADR 0174（当前最大编号后顺延）。
- **续完善（同批收口）**：
  - **自描述回退标签**：已移除 / 已换键的实例（`luna~zen`）在消息 / 点名 chips / 接力卡 / 路由上下文仍还原 `名字·灵魂名`（client `labelOfMemberKey` / server `memberLabelOf` 同链；经典键不补后缀）；
  - **幽灵补位**：新增 `memberDisplayList(agents, session, extraKeys)`——计划卡 / 任务面板 / 定时面板把已离场引用键补成可读条目（不再裸秀 memberKey）；
  - **实例级统计**：战绩 `computeStats` 按 `memberKey` 归口（分身各自入榜 / 计数 / 被 cue）、迷你档案 MiniDossier 按成员键统计与署名；
  - **测试与验证**：server m77 **14 例**（+并行波多实例同波 / 运行中换装队列同步 / 自描述回退署名）、client m77 **17 例**（+回退标签 / 幽灵补位 / 分身菜单未占用过滤 / 战绩实例归口 / 波次组头与悬浮条实例署名 / 列表预览署名）；全量：server **1293/1294**（仅 1 例 m50-blank 白名单差集红——并发会话新增 `zeri_pan` 工具尚未同步其 blank 白名单，非本批引入，其后已由对方补齐转绿→**1295/1295**）、client **1193/1193**；e2e 定向 **9/9**（m77×2 / m16-members / m16-soul / m24-plan×3 / m48-routing×2）；typecheck 四包 0 错。
  - **UI 打磨**：编制行窄栏换行（`flex-wrap` + `min-w-[104px]`）、名录页灵魂变体区「可同台」提示；单实例 token 口径澄清（`名字·灵魂名` 仅同角多实例时生成）。
  - **展示面兜底（design.md §105.7）**：成员键全消费端审计——波次组头 / 悬浮阶段条 / 消息导航条 / 「下一棒」热身行 / 场景面板（`SceneStage.agentOf` 成员键容忍 + `derive` 容器与取数链归属）/ 定时任务卡目标 / 图谱接力摘要（工件按 base 匹配）/ 会话列表预览（`SessionSummary.lastMessage.memberKey`，迁移 v20 列仅增 SELECT）均按实例署名；对决分侧 / 席位高亮 / 工件作者 / 记忆 / 审批保持基础角色口径。验证：server **1295/1295**、client **1199/1199**、e2e 定向 **30/30**（+m16-parallel / m16-serial / m37×2 / m52-stage×20 / m12×2）。
  - **运行台账与交互面收口（design.md §105.8）**：`replaceMemberKey` 五处同步（+已发言史 spoken 防同席位重复出手 / +未消费交接提案目标改写防幽灵复活）；接力进度链与接力卡按成员键成节点（同角双实例各自成节点且当前高亮可命中）；提意见草稿 @实例署名。验证：server **1296/1296**（m77 16 例）、client **1214/1214**（m77 19 例）、e2e 定向 **7/7**（m77×2 / m16-parallel / **m12-interactions（进度链+迷你档案）** / right-panel×3）。
  - **画布层收口（design.md §105.9，收口横幅扫描补出）**：CanvasComposer 成员召唤条按成员实例（分身键不再被过滤、召唤插入 `@名字·灵魂名`）、运行状态条/最近回复摘要/近期消息浮层署名按实例、运行态徽标改按成员键读 statuses；死代码清理 `instancesOf`/`presentSoulIds`。验证：server **1296/1296**、client **1215/1215**（m77 20 例）、e2e 定向 **6/6**（m31-canvas-agent×3 / m31-canvas-interactions / m77×2）。
  - **口径修订：裸名 @ = 主实例（design.md §105.10）**：`buildMentionTokens` 裸名映射改为编制序首位；Composer @候选增「名字（全部 N 位）」显式全伞条目（一键插入 `@卢娜·狂野 @卢娜·禅意`）且 @token 探测字符集补 `·`/`~`（可连续输入实例标签与机器键）；L3 寻址指南同步改写；e2e 全伞步骤改显式双 token。验证：server **1297/1297**（m77 17 例）、client **1216/1216**（m77 21 例）、e2e 定向（m77×2 / m16-parallel / m12×2 / right-panel×3）。
### v86 — M40 陪跑渲染包（批五）：三轨打卡 / 每日一练 / 情绪签到 / 目标环 / 记账流水 / 行程卡（前端批 + 5 处 AGENT.md 输出约定）

- **动因**：全场景深度优化批五（陪跑域 health / learning / personal / wealth / travel）——M40 原案 HL-1/3/4/5/6/7 全面落地（HL-2/HL-8 收敛：timeline / checklist 复用零新增）；打卡与 streak 本地口径（localStorage `ma:habit:<sid>` 按天、本地日期切算、仅本地可信）同批兑现。
- **角色人设增补（5 个，仅「工作方式」各加一行输出约定，六段骨架与交付契约零改动）**：fitness（`::: tracks` 三轨卡）· tutor（`::: quiz` 每日一练 + 路径 `::: timeline`）· coach（`::: mood` 情绪签到）· wealth（`::: goals` + `::: ledger`）· travel（`::: itinerary` 按天行程，日期 YYYY-MM-DD）。**零协议新增**（按原案 §8.4 口径）。
- 交付梗概：`habit.ts` 本地打卡库（按天集合 / 周一锚定周网格 / streak 今天或昨天起算 / 补记与取消）· 六容器 + 六卡片（共享 finalizeRowSet 收尾与降级链；ProgressRing 复用）· 三处草稿回填（quiz「我的答案：X。」/ mood「今日状态：N/5」/ 无直发，ADR 0064）；决策见 ADR **0172–0173** / design.md **§104**。
- **mock 辅助（唯一脚本改动）**：五组触发块——「打卡走查」（fitness）/「出题走查」（tutor）/「签到走查」（coach）/「理财走查」（wealth）/「行程走查」（travel，日期为动态相对值）；同既有触发块先例，块内不写 @。
- 评测：check:agents（strict）**165/165 + 协议 41/41 ✅**（含本批 5 处追加）；其余门禁见 design.md §104.5 收口账。
- 相关文档：design.md §104 / ADR 0172–0173 / `docs/scene-chat-design.md` 头部（编号修订九 + §8 落位注记）/ `docs/adr/README.md` 索引。

### v85 — M66-B 罗盘第五盘卡与九宫叠图落地：三环罗盘 / 双盘切换 / 合规色带 / 户型叠图（M66 批二 · 前端批；**agents 资产零变更**）

- **动因**：M66-A 的 `::: pan luopan` 卡此前走 PanCard 未知 kind 降级（通用表格）——本批升级为第五盘卡（ADR 0171 / docs/design-studio-design.md §10.2 + §10.3）。
- **派生层**：`pan/luopan-model.ts`（卡内文本 → LuopanModel：坐 / 向 / 周天度数 / 宅卦 / 东西四宅 / 八宫吉与慎用 / 运盘 / 流年星级 / 九宫飞布 / 数据等级；口径：不重算、不预测——与四件套同纪律）；必需门失败 → 回退静态表格（零回归路径）。
- **注册路径**：`PAN_KINDS` + `'luopan'`（第 10 类；徽标「罗盘」）+ pan/model 独立 PanKind 同步 + derive 分派 + PanView lazy 分派（ChartboardPanel 零改动承接）。
- **三环罗盘**（自绘静态 SVG，零依赖）：外环二十四山（15° 扇区）/ 中环后天八卦 / 内层九宫格（正北在上）+ 坐向指针（坐虚线 / 向实线）。
- **双盘切换 + 合规联动**：八宅游年（吉 = 青绿 / 慎用 = 琥珀色带）/ 流年飞星（星号名；五黄走慎用色）；宫位详情条（参考语统一「传统观点列为慎用方位」）+ 「深入 / 依据核对」回填草稿。
- **九宫叠图**（§10.3 v1 修订）：会话最近图片附件 + SVG 网格叠加（去文字防拉伸，宫位信息走 SVG title）；游年 / 飞星 mini 切换；无图空态含前提声明；**v1 固定正北**（偏转对齐列 v2）；入口 = 盘卡 tab（**不设独立触发块**——mock 触发块维持 2 组）。
- 评测：client 全量 **1160/1160 ✅**（102 文件，+m66-luopan 4 例）；E2E **m66-fengshui 1/1 ✅**（8.1s：盘卡 → 八宅（伏位 / 慎用详情）→ 飞星（中宫一白）→ 叠图空态）；typecheck / lint 0 错；server 不受影响（1285/1285 基线）。
- 相关文档：**ADR 0171**（0169/0170 已被 M41 批占用，实施时全仓复核让位）/ docs/adr/README.md 索引 / docs/design-studio-design.md（实施注记 + §10.2 / §10.3 修订 + §13.1）。

### v84 — M41 服务型渲染包（批四）：客户管道 / 测算表 / 风险色带 / 进度卡 / 问答卡 / 口径校验徽章（前端批；**agents 资产零变更**）

- **动因**：全场景深度优化批四（服务域 sales / finance / funding / ops）——M41 原案 SA-1/FI-1/2/3/FU-1/2 全面落地（决策项 0071 业务容器族 v2 语法归一同批兑现）；OP-1 纪要（M42 minutes）/ OP-2 SOP（M37 checklist）由既有批次覆盖，OP-3 招聘管道 = SA-1 复用。本批零协议 / 零人设（按批次登记纪律照记）。
- 交付梗概：`::: pipeline` / `::: figures` / `::: risk` / `::: progress` / `::: qa` 五容器 + 五卡片（共享 `finalizeRowSet` 收尾与 rawh 兜底降级链）· FI-2 口径校验徽章（`calcExpressionOf` → 消息头部「已核算」，title 携表达式）· 点卡回填「跟进 <客户>：」草稿；决策见 ADR **0169–0170** / design.md **§103**。
- **mock 辅助（唯一脚本改动）**：三组触发块——「管道走查」（sales → pipeline）/「财务走查」（finance → figures + risk + **脚本化 calc 调用**，供 FI-2 徽章走查）/「融资走查」（fundraiser → progress + qa）；同既有触发块先例，块内不写 @。
- 评测：见 design.md §103.5（eval 零回归；域内 E2E 3/3 + 回归 5/5 全绿）。
- 相关文档：design.md §103 / ADR 0169–0170 / `docs/scene-chat-design.md` 头部（编号修订八 + §9 落位注记）/ `docs/adr/README.md` 索引。

### v83 — M66-A 堪舆阳宅资产落地：fengshui 场景两角色 + 技能 + 预设 + luopan_pan 工具 + mock 触发块（M66 批一 · 资产侧）

- **动因**：家装设计工作室与风水阳宅专项（ADR 0168 / docs/design-studio-design.md §5.2 + §10）——堪舆（风水）独立成场景（评审已决：与 metaphysics 论命区隔），罗盘排盘工具化（对齐排盘四件套范式）。
- **新场景与角色（2 角色，六段骨架 + 头像 512px）**：`fengshui`（堪舆阳宅，order 123 显式让位 122 撞号；dock · chartboard；先解析后判读严格串行）；察隅（plan-surveyor 户型解析师，三态标注 + 坐向分级采集）/ 司南（yangzhai-master 阳宅堪舆师，先盘后论 + 四维评述 + 改善参考）。
- **场景协议**（六段式）：合规红线（不承诺吉凶必应 / 禁恐吓与商业化 / 医疗·投资·法律·婚育·生死不做结论）+ 先盘后论 + **精度分级 A/B/C** + 流派口径（八宅·坐山派；玄空·下卦）+ 「渲染容器约定」（::: pan luopan / score / checklist）。
- **技能 1（60 → 61）**：`fengshui`（定向分级 / 盘面口径 / 四维评述框架 / 改善四类 / 速查表 / 合规红线 / 反模式）。
- **预设 1（32 → 33）**：`move-in-check`（入宅联审：察隅解析 → 司南点评 → 筑居装修避让，跨场景）。
- **工具 `luopan_pan`（新，纯计算只读，deferred）**：二十四山定盘（子山跨 0° 环形区间）/ 八宅坐山派大游年歌（golden：壬山丙向 → 坎宅八宫全表）/ 三元九运 + 流年入中星（公式 golden：2024 三碧 · 2025 二黑 · 2026 一白）+ 洛书顺飞；输出「::: pan luopan」整卡模板；PanError 失败语义；**设计文档 §10.1 原示例「2026 五黄」笔误随批勘误**。
- **mock 镜像四件套 + 触发块**：SCRIPTS 2 角色 / artifactFor 2 交付件（户型解析 / 堪舆点评）/ DISPLAY_NAMES / preferredOf；触发块 2 组（「堪舆走查」→ 司南盘卡；「户型走查」→ 察隅清单——唯一词防碰撞入测）；TOPICS + 「阳宅」。
- **合规测试（4 项）**：协议 / 人设 / 技能 / mock 四层禁词扫描（大凶·血光·破财·化解费，规范句「禁用 / 不写 / 禁词 / 恐吓 / 反模式」豁免）+ 触发词防碰撞 + 工具核心输出契约。
- 评测：eval **35/35 ✅**（+fengshui 任务）；check:agents **165/165 + 协议 41/41 ✅**；check:skills **61/61 ✅**；server 定向（luopan 5 golden + fengshui 5 + m21 + tools + mock-coverage）**60/60 ✅**。
- 相关文档：**ADR 0168** / docs/adr/README.md 索引 / docs/design-studio-design.md（实施注记 + §10.1 勘误 + §13.1）。

### v82 — M65-C 设计容器族与工作台联动落地：三容器 / 三卡片 / 打开通道 / 快照入库 / 打印视图（M65 批三 · 前端批；资产零改动）

- **动因**：家装设计工作室专项 M65-C（ADR 0167 / docs/design-studio-design.md §8 + §7.7）——补齐「对话产设计 → 工作台消费 → 成果回消息」交互闭环。**资产零改动**（interior 已于 v75 落地）。
- **三容器族（remark-ext，单一解析实现）**：`::: layout`（房间三段 + 「方案源：」行）/ `::: styleboard`（色卡三段 + 「质感：」行）/ `::: render`（键值条目，复用 finalizeItemRows）；**懒续行剥离**容错（CommonMark 会把标记行并入列表末项——含空行 / 无空行两写法）。
- **三卡片（v57 五模式）**：LayoutCard（房间表 + 方案源 + 「在 3D 工作台打开」+ 房间行回填）/ StyleBoardCard（色块 + 非法色值降级 + 色值复制 + 按板调整回填）/ RenderCard（产物图 + 元信息 + 再生成回填 seed 提取）；流式禁用、只写草稿、children 兜底。
- **联动**：`STUDIO_OPEN_EVENT` 打开通道（layout 卡 → 工作台加载方案）；快照升级为「下载 + 存工作区」（media/upload；失败降级）+ 「送图生图」回填（lib/ds-templates 模板库 5 纯函数）；方案书打印视图（StudioPrintSheet + @media print；零依赖存 PDF）。
- **服务端**：mock.ts 修正「【用户】前缀匹配」（外部 M77 引入的前导空格 — 会导致**全部触发块失效**；修正 + 注释留痕）。
- 测试：client m65-cards 8 例 + 面板打印 1 例；**client 全量 1107/1107 ✅**；**E2E `m65-studio` 1/1 ✅**（全链 24.3s：layout → 打开工作台 → 平面 → styleboard/render 回填；testMatch 白名单入 `m65-.*`）；E2E 定式：虚拟列表下等底部新卡需轮询「回到最新」浮标（写入 ADR 0167）。
- 相关文档：**ADR 0167** / docs/adr/README.md 索引 / docs/design-studio-design.md（实施注记 + §13.1）。

### v81 — M44 核心交付锚点（批三）：锚定条 / 变更卡 / 意见闭环 / 签收（前端批；**agents 资产零变更**）

- **动因**：全场景深度优化批三（M44 原案 AF-1–AF-5）——长会话失去「核心交付是哪个、改到第几版」的常驻读数；意见与修改之间无闭环可视化；交付缺签收仪式。本批为纯前端 + mock 辅助脚本：**零协议 / 零人设 / 零技能改动**（按批次登记纪律照记）。
- 交付梗概：`focus-artifact`（锚点选择 / 钉选 / 评论与签收模板 / 高置信闭环推导）· `artifact-versions` 共享缓存 · `FocusBar` 锚定条（药丸 + 悬浮面板）· `ChangeCard` 变更卡（ArtifactRow 扩展 vN 徽章与行尾槽位；回应角标）· `MessageActions` 「提意见（对交付件）」菜单项 · 收尾卡签收行（本地按版本签收 + 回填草稿）；决策见 ADR **0163–0165** / design.md **§102**。
- **mock 辅助（唯一脚本改动）**：新增触发词「修订走查」——脚本化 write_file 的交付件内容追加修订段（内容变化 → 版本库哈希去重失效 → 产生新版本），为 E2E「意见 → 修改 → 闭环 → 签收」链路提供确定性数据源（同 M37/M38/M39 触发块先例；块内不写 @）。
- 评测：见 design.md §102.5 / §12.1 收口账（eval 与基线零回归；双端与 E2E 域内回归全绿）。
- 相关文档：design.md §102 / ADR 0163–0165 / `docs/scene-chat-design.md` 头部（编号修订七 + §12 落位注记）/ `docs/adr/README.md` 索引。

### v80 — M66 批二 分析域资产落地：三场景协议「渲染容器约定」+ mock 三组触发块（M66 批二 · 资产侧）

- **动因**：全场景深度优化「对抗 · 博弈 · 分析三域」批二（`docs/pk-game-analysis-design.md` M66 批二）——console（bi / sre）与 pool（society）专业语汇承接（指标口径 / 取数链 / 事故分级 / 立场泳道 / 共识分歧板 / 窄屏收纳，落 design.md §100 / ADR 0160–0162）；**容器格式必须写入资产**（M37 checklist / M38 研讨族先例）。
- **协议增补（三份，仅追加不改旧文，质量红线 / 失败模式结构保留）**：
  - `bi/_protocol.md` 新增「渲染容器约定」段（条目 10–11）：指标卡 `::: kpi` 五列（末列口径，可缺省）；SQL 用 ```sql 围栏（全文留消息内供回溯，结论一句在栏外）；
  - `sre/_protocol.md` 渲染容器约定追加条目 13–14：事故时间轴 `::: timeline` 条目 `- 时间 | 事件 | 等级`（第三列语义 = 等级：P0/P1/P2/观察，容忍严重/高/中/低）；SLO 用 `::: kpi`（口径列写时间窗与加权）；
  - `society/_protocol.md` 新增「渲染容器约定」段（条目 14–15）：立场卡 `::: stance <立场方>`（主张 / 核心关切 / 被忽视视角 + 依据带等级词）；共识分歧板 `::: split`（共识 / 分歧 / 存疑三类并列，分歧不得抹平）；事实基线用 `::: sources`。
- **mock 三组触发块**（`server/src/llm/mock.ts`，唯一触发词，块内不写 @）：「指标走查」→ bi（kpi 双行含口径 + 单条 ```sql）；「事故走查」→ sre（四级 timeline + SLO kpi 双行）；「立场走查」→ stakeholder（两席 stance）+ moderator（split）——既有剧本零改动（触发词与既有 eval 语料零碰撞）。
- **同批前端 / 面板（与设计 §100 对应）**：kpi 五列口径徽章（kpiRowOf 单一解析）· ConsolePanel bi 分支（指标区 + 取数链 SQL ×N）· sre 分支（分级事故时间轴 + 筛选 + SLO 区）· `::: stance` / `::: split` 两容器族（StanceCard / SplitCard）· pool 立场泳道（6 色相）与共识分歧板段 · arena 窄屏洞察收纳（U5）· verdict/ruling/split 收尾合并（finalizeItemRows）。
- **评测（合并态核验分级）**：eval **34/34 ✅**；check:agents **163/163 + 协议 40/40 ✅**；check:skills **60/60 ✅**；client 全量 **95 文件 / 1107 例 ✅**（含本批 `tests/m66-analysis-console.test.tsx` 14 例；1 例 unhandled error 归并发域 SessionResourcesDialog，已登记）；server 全量 1245/1249——**4 红为并发批次工具注册计数漂移（m28 / m47：57→58 / 56→57），非本批域**（本批 server 侧仅 mock 触发块；定向 m21 / mock-coverage 23 例 ✅）；双端 typecheck 0 错；定向 ESLint 0 错。
- **E2E 全绿 8/8 ✅**（静默窗口补跑）：批二 `m66-analysis-console` **3/3**（商业智能指标走查 / 站点可靠性事故走查 / 议题圆桌立场走查）+ 批一 `m43-pk` **2/2**（交锋走查全链 / 报价走查折线与基准线）+ `m34-invest` **3/3**（含四路观点卡与走子板）；补跑期间修复共享 helper 两处（`createSession` 同名来源行 `.first()` / 新增 `backToChat` 回对话），首轮并发假失败（90s 预算 / 报价点数浮动 / 交付件视图无 Composer）已全部归因消解。
- 相关文档：design.md §100 / ADR 0160–0162 / `docs/pk-game-analysis-design.md`（批一 + 批二全量收口） / `docs/adr/README.md` 索引。

### v79 — 用户素材库（M68）：per-user 私人素材 + 独立菜单管理页面（服务端 / 前端批；**agents 资产零改动**）

- **动因**：M31 预留「全局素材库扩展位」落地——现有一切媒体资产绑定会话工作区（换会话即归零，「下载→重传」高频摩擦）；M57 多用户下细化为 **per-user 私人库**（用户明确要求「单独菜单页面管理」）。设计与必要性评估见 [docs/material-library-design.md](../docs/material-library-design.md)，决策见 **ADR 0158**；本批不涉 prompt / 协议 / 人设，eval 不涉及。
- **服务端**：迁移 **v19**（materials 表）+ `MaterialStore`；`LibraryService`（上传白名单 / 行+文件双清 / content 解析 / copy-on-use 入仓 / 账号级联）+ 6 端点（列表 / 上传 / 内容流 / to-canvas / 删除 / 容量）；owner 服务端取（兼容模式 'local'；非属主 404）；存储 `workspace/_library/u_<uid>/`（配额统计增计 + `assertUserStorageAllowed` 用户级闸门）；账号删除级联。
- **前端**：`library-store` + `MaterialsConsole`（网格缩略图 / 预览灯箱 / 搜索 / 类型筛选 / 容量条 / 拖拽上传 / hover 操作：放入画布 · 下载 · 删除）；ActivityRail「素材库」**全员可见**入口 + AppLayout 主区视图 + 命令面板同源；「放入画布」复用 `sendArtifact` 落节点（副本存会话工作区 `library/ref-*`）。
- **测试**：server `m68-library` **8/8**（属主隔离 / 白名单 / 配额透传 / 双清 / copy-on-use / 级联）；client `m68-materials` **7/7**（store 四链路 + 页面空态 / 网格 / 筛选 / 入画布）；E2E `m68-library` **2/2**（隔离环境 8795：管理页面全流程 / 入仓断言）；store 迁移期望同步至 v19——双端 typecheck 0 错误。
- 相关文档：**ADR 0158** / docs/material-library-design.md / docs/api.md §23 / design.md §49 注记与 §12.1 账本 / docs/adr/README.md 双索引。

### v78 — 场景扩展二批（M69）：十场景 / 46 角色 / 2 工具 / 7 技能 / 3 容器族（资产 + 工具 + 技能 + 前端 + 镜像面）

- **动因**：用户全量盘点后选定十场景实施（经营创作 · 实用 · 玩法三域），明确「着重交互与前端设计」与「新增 skill / tool 自行查找实现」；设计蓝图先落 [docs/scene-expansion-v2-design.md](../docs/scene-expansion-v2-design.md)（交付前已做目录快照 `data/m69-backup-2026-09-19/`）。编号说明：v75 / v76 / v77 被并发批次（M65-A / M64 批一 / M65-B）占用，本批顺延 v78。
- **场景资产（10 场景 / 34 角色 + 补强 12 角色）**：新场景 ecommerce 电商经营 / creator 自媒体工作室 / legal-personal 个人法务 / academic 学术论文 / relationship 情感关系 / trpg 跑团工坊 / tarot 塔罗研习 / moot-court 模拟法庭 / business-sim 商业沙盘 / philosophy 哲学茶室（六段骨架 1410–1640 字符；协议 10 份均含质量红线 + 典型失败模式）；既有场景补强 travel（通境 / 寻巷）/ wealth（保宁 / 慎衡）/ funding（衡价 / 理卷）/ bi（正尺 / 绘数）/ sre（度峰 / 试雷）/ personal（立习）/ ops（执证）——补强角色不进 chain（镜像面口径）。
- **工具（2，场景玩法）**：`dice_roll`（骰式解析 + mulberry32 确定性 PRNG 种子回显，同种子逐位复现；输出 `::: roll` 骰卡模板）/ `tarot_draw`（78 张全表：22 大阿卡纳 + 4 花色 × 14 阶；正逆位 50%；输出 `::: cards` 牌阵卡模板）；tier=deferred + readOnly，registry / categories（新分类「场景玩法」）登记；golden 测试 13 例（m69-tools）。
- **技能（7）**：trpg-hosting / tarot-reading / ecommerce-operations / creator-economy / academic-writing / relationship-communication / philosophy-dialogue（均含常见的坑 / 检查清单 / 工具接入口径；check:skills 60/60）。
- **前端交互（新容器族 + 卡片）**：remark-ext 新增 roll / cards / sim 三容器（builder + finalizeFieldsAndItems 复用）；卡片组件 RollCard（骰面方块 + 总值 + 种子徽章 + 再掷回填）/ CardsCard（牌位行 + 正逆位标记 + 深入解读回填）/ SimCard（决策 / 反馈 / 指标三段 + chips + 下回合回填）；Markdown.tsx 分派 + index.css 样式；面板场景文案（pool +2 / board +2 / coach +1）；测试 11 例（m69-md-ext：渲染 + 纯函数 + 回填 + fail-safe）。
- **镜像面（四件套全量同步）**：mock.ts DISPLAY_NAMES / preferredOf / SCRIPTS / artifactFor × 46 角色；e2e/helpers.ts AGENT_NAME；m21 计数升级（40 场景 / 163 角色 / 32 预设 / 35 stage 声明 / 十场景特性断言）；README 统计（40 场景 / 162 业务角色 / 60 技能 17 组 / 预载表 +11 行）。
- **评测**：check:agents **163/163（六段 163/163 + 正文 163/163）+ 协议 40/40** ✅；check:skills **60/60** ✅；m69-tools **13/13**；m69-md-ext **11/11**；mock-coverage **4/4**（全量角色四件套）；m21 **19/19**；**server 全量 1247/1249**（存 2 例为并发批次 M77 中间态：m42 例会回交文案在成员标签/spoken 改造后缺失，非本批引入、待其收口）；**client 全量 1107/1107（95 文件）**；server / client typecheck 0 错误。测试基线同步升级：M35 定时持有者 8→10（habit-coach / license-keeper，含正文 tool_search 引导与 manage_schedule）；M28 / M47 引擎清单计数 52→57 / 51·52→56·57（两边新工具：dice_roll·tarot_draw + daliuren 等）；context 压缩预算夹具 13.2k→14k（随资产扩容，实测 13.6k±）。
- **并发避让**：interior（M65）/ 盘面深化（M63）为并行工作流活跃专项，本批零触碰；预设 order 与 home-makeover 错位（270 vs 320–360）。
- **完善批次（同日续）**：① 卡片交互补全——RollCard 双按钮（再掷一次＝**换新种子** / 复现本次＝**同种子重掷**，seed 缺省不渲染）、CardsCard 双按钮（重抽一组＝新种子 / 深入解读）；② **tarot 牌阵台**——ChartboardPanel 新增 cards 区（复用 CardsCard，面板与消息同组件；计数 = pan + cards；**tarot 场景隐藏「亲手摇卦」** + 空态文案场景化；pan 路径零变化）；③ mock 触发块三组（「骰子走查」gm-host /「牌阵走查」tarot-reader /「回合走查」sim-host——E2E 与 eval 确定性通道）；④ 文档落位——**ADR 0166**（0163–0165 已被并发批次占用，取 0166）/ design.md **§101** / docs/adr/README 索引；⑤ E2E 定向 `e2e/m69-cards.spec.ts`（2 条：骰卡+双按钮回填 / 牌阵卡+牌阵台）+ playwright testMatch `m69-.*`。
- **完善批验证**：m69-md-ext **14/14**（新增面板牌阵台 2 例与双按钮用例）；m54-pan-boards / m63-pan-boards-v2 / m54c-pan-archive / m52-stage 定向 **111/111**（chartboard 改动零回归）；server 定向（m69-tools / mock-coverage / m42）**20/20**；client 全量 **1122/1126**（余 3 例为并发批次灵魂选择 UI 重构中间态（m16/m48-frontend）、1 例抖动，均非本批域）；双端 typecheck 0 错误。**E2E 定向两轮归因**：首轮失败根因 = 并发 M65-C mock 中间态（`userText` 提取 `startsWith(' 【用户】')` 前导空格——影响一切触发块）；已用 tsx 双重自证**我方触发块本体正确**（无空格前缀 → HAS_ROLL_BLOCK true；带空格 → false）；次轮复跑遭并发 m65-studio E2E 活跃窗口互踩（webServer 复用 + test-results 文件竞争），**待静默窗口复跑**。
- **完善批·续（同日二轮）**：① **牌阵台布局化**——新元件 `CardsBoard`（parts）：张数自适应（1 居中 / 3 横排 / 5 十字阵（grid-areas）/ 其余两列；窄屏 <900px 退化两列）+ **点牌高亮 + 关键词横幅**（再点收起 `aria-pressed`）+「深入解读」回填；ChartboardPanel cards 区改用 CardsBoard（parseCards 复用，§2.7 承诺全量兑现）；② **汇聚板骰子记录段**——PoolPanel 新增 `[data-pool-rolls]` 段（roll 容器按消息序聚合：`骰式 = 总值 · 种子`；点条目定位来源；roll 入 NON_GENERIC 防卡墙重复——§2.6 承诺兑现）；③ 设计文档实施落位注记（三账对齐）；④ E2E 复跑窗口说明：client dist 为并发共享产物（重建会干扰并发 E2E 窗口），定型流程：静默后 `npm run build -w @multi-agent/client` → `PW_OUTPUT_DIR=/tmp/pw-m69 npx playwright test e2e/m69-cards.spec.ts`（独立输出目录，`PW_OUTPUT_DIR` 为 M57 既有并发隔离能力）。
- **完善批·续验证**：m69-md-ext **16/16**（+2：牌阵台 is-3 布局/点牌高亮/再点收起/回填 + 骰子记录段）；PoolPanel 相邻套件定向（m38-cards / m66-analysis-console）**35/35** 零回归；面板全家定向（m52-stage / pan 系列×4 / live-panel）**全绿**；client typecheck 0 错误。
- **完善批·三轮（同日）**：① **论点池专业化**——`claim` 入 PoolPanel 的 SPECIAL_CARDS（不再走通用卡墙）→ 主张卡与消息内同组件（ClaimCard）；扩展字段（视角/倾向/置信度）经 `claimMetaOf` **单一解析**（lib/pk，与 remark 收尾同源）；细节行提取 + 论据经 `claimReasonsOfLines`；兑现设计 §2.10「汇聚板（论点池）：论点卡（claim 派生）」（philosophy / society 受益）；② **牌阵台双按钮对称**——CardsBoard 补「重抽一组」（新种子回填；与消息卡 CardsCard 对齐）；③ 头像缺口核查：新场景/补强 46 角色暂无 avatar.png（存量 116 张；无批量生成脚本，历史来源为 `client/public/avatars/` 人工物料）——登记为专项待办（统一 prompt 模板 + 视觉走查的批量生成批），本轮不碰。
- **完善批·三轮验证**：m69-md-ext **17/17**（+1：论点池 claim 专业化）；m38-cards / m66-analysis-console / m52-stage 定向 **93/93** 零回归（claim 入池零影响面）；client typecheck 0 错误。
- **完善批·四轮（同日·头像批）**：**M69 全量 46 角色头像落地**——10 场景 34 角色 + 补强 12 角色，统一风格前缀 v3（半写实 3D 卡通 / 成人比例约 1:4.5 / NOT chibi / 纯白背景 / 哑光质感 / 中等大眼——三版模板迭代防幼态），逐张七维设定差异化（年龄 / 面孔 / 发型 / 服装 / 道具）；ImageGen 1024 生成 → `sips -z 512` 压缩 → `agents/<场景>/<id>/avatar.png` 自动发现（**零代码改动**）；抽检 6 张跨批质量通过、全量尺寸校验 512×512 零异常；文档面同步——design.md §19.1 计数句更新 + **§19.3 设定表补录 46 行**（批次注记：M51 批 40 / `interior` 批以成品为准）；`interior` 三角色暂缺（回退渐变占位、待其专项）。
- **终验账刷新（同日收口）**：client 全量 **1155/1155（100 文件）** ✅（并发中间态已随对方批次收口）；server 全量 **1285/1285** ✅（m47 工具计数短暂漂移随并发批次修复）；头像拼图验收 **46/46**（`data/m69-avatar-review.png`，8 列缩略全量目视通过）。
- 相关文档：docs/scene-expansion-v2-design.md（§1 场景总账 / §2 交互细化 / §3 容器族 / §4 工具 / §5 技能 / §7 镜像面清单）；design.md §101；ADR 0166。

### v77 — M65-B 3D 基座落地：DesignScene 契约 · 场景渲染 · 工作台面板 · design-scenes 通道（M65 批二 · 前端/服务端；资产零改动）

- **动因**：家装设计工作室专项 M65-B（ADR 0159 / docs/design-studio-design.md §6–§7）——studio 工作台从注册骨架升级为可用 3D 闭环：加载 agent 产出的场景 JSON → 3D·平面双视图 → 编辑 → 保存回工作区。**资产零改动**（interior 已于 v75 落地），本批不涉 prompt/协议/人设，eval 不涉及。
- **契约（shared）**：DesignScene v1（rooms 多边形 / openings 门窗 / furniture 13 类程序化族 / materials 命名材质板 / lights 日光）+ `DESIGN_SCENE_VERSION` + `FURNITURE_KINDS`。
- **模型层**：`design-scene-model`（宽容解析——顶层错报错·条目级过滤计数 / 鞋带面积 / 包围盒 / 俯视 SVG 几何 / 不可变编辑操作 50mm·15° 吸附）+ `furniture-parts`（13 类 part 表）。
- **渲染层**：StudioCanvas scene 驱动（外露墙带 + 地板 / 门窗贴墙标记板 / 家具几何族 / 日光球坐标 / 选中 wireframe / `preserveDrawingBuffer` 快照）；three 栈懒加载边界不变（首屏零增量）。
- **面板层**：StudioPanel 完整版（方案列表 = 工作区文件 ∪ layout 容器声明 / 3D·平面双视图 / 选中操作条（移动·旋转·删除）/ 家具·材质·光照三工具组 / 快照导出 / 保存 dirty 高亮 + 409 提示）。
- **服务端**：`design-scenes` 路由（GET 列表 / PUT 保存；前缀白名单 + 2MB 上限 + 配额闸门 + mtime 乐观锁 + artifact 广播）；读复用 artifacts content（零新通道）。
- **工具链**：@types/three 归一 0.186（消除与根部的双份名义类型冲突——全量构建验证）。
- 测试：client 新增 12（model 6 / panel 6）+ B0 更新（3）；**client 全量 1079/1079 ✅**（92 文件）；**server design-scenes 5/5 ✅**；双端 typecheck + 本批文件 lint 0。
- 相关文档：**ADR 0159** / docs/design-studio-design.md（§7 实施修订 + §13.1 状态回写）/ docs/adr/README.md 双索引。

### v76 — M64 批一 对抗博弈主面资产落地：三场景协议「渲染容器约定」+ 6 角色输出约定 + mock 三组触发块（M64 批一 · 资产侧）

- **动因**：全场景深度优化「对抗 · 博弈 · 分析三域」批一（`docs/pk-game-analysis-design.md` M64 批一）——arena（debate / negotiation）与 versus（invest）主面深化（交锋计量板 / 交锋看板 / 轮次判定 / 参与仪式 / 报价折线 / 博弈走子板 / 四路观点卡，落 design.md §98 / ADR 0154–0156）在前端落地；**容器格式与轮次节奏必须写入资产**（M37 checklist / M38 研讨族先例），否则面板段永不出现。
- **协议增补（三份，仅追加不改旧文，质量红线 / 失败模式结构保留）**：
  - `debate/_protocol.md` 条目 14（渲染容器约定）：证据文本必须带等级词（官方 / 学术 / 权威媒体 / 待核实——无等级会被提示补标）；每轮交锋结束 judge 输出 `::: ruling <正方|反方|僵持> 第 N 轮小结`（条目 `- 亮点 | …` / `- 未决点 | …`）——回合轴色点与轮次分依据，终局仍以 `::: verdict` 四要素为准；
  - `negotiation/_protocol.md` 条目 12：首轮报价容器必含 `目标：` / `底线：` / `BATNA：` 三字段（折线基准线依据）；每轮 `报价：` 必填，让步补 `让步：<幅度与理由>`（让步刻度依据，幅度扩大会被标红）；
  - `invest/_protocol.md` 新增「渲染容器约定」段（条目 15–16）：四路分析收口各出 `::: claim <一句话结论>`（字段行 `视角 / 倾向 / 置信度` + 依据行）；走子输出 ```game 块（`title` + `seed`，快照路径进交付件），逐轮记录局势可选 `::: ruling`。
- **角色人设增补（6 个，仅「工作方式」各 +1 行，六段骨架与交付契约零改动）**：judge（ruling 输出约定）、negotiator（offer 三桩字段与让步字段）、analyst-fa / analyst-ta / analyst-news / quant（视角 claim 输出约定；quant 兼走子 ```game 块约定）。
- **mock 三组触发块**（`server/src/llm/mock.ts`，唯一触发词，同 M37 checklist / M54 pan 先例；块内不写 @）：「交锋走查」→ judge（ruling）+ affirmative（带等级证据 claim）；「报价走查」→ negotiator（三桩齐备 offer）+ counterpart（反出价 offer）；「四路走查」→ 四分析师（四路 claim）+ quant（量化 claim + ```game 块）——既有剧本零改动（触发词与既有 eval 语料零碰撞）。
- **同批前端 / 面板（与设计 §98 对应）**：交锋计量板（`duelTally` 增 claims）· 交锋看板 CrossFire（arena 六件套 parts + 汇聚板红队段）· `::: ruling` 判定卡与回合轴色点 · 对抗参与条与终局结论条 · 报价折线与让步刻度（SVG 自绘）· 博弈走子板与「发起多空对弈」· 四路观点卡 · `lib/evidence.ts` 证据等级徽标（ClaimTree 补证据 / 假设回填）· claim 扩展字段单一解析。
- **评测**：eval **32/32 ✅**（与基线零回归）；client 全量 **85 文件 1034 例 ✅**（含本批新增 `tests/m63-pk-arena.test.tsx` 22 例；受影响既有套件 m43-cards / m43-pk / m52-stage / markdown-ext / m38-cards / m60-arena-live 定向复跑 **203 例 ✅**）；server 定向 m21 / mock-coverage / m5 **44 例 ✅**；四包 typecheck 0 错；定向 ESLint（本批改动文件）0 错；check:skills **60/60 ✅**；check:agents 本批落位时点 **114/114 + 协议 29/29 ✅**（合并态复跑遇并发批次新场景目录中间态 `agents/business-sim/market-referee`（目录已建、AGENT.md 未写）——非本批域，待并发批次收敛后复验）；E2E 扩展用例（`m43-pk` 交锋走查 / 报价走查 + `m34-invest` 四路走查）与全量 server 套件待静默窗口补跑（并发会话持续占用 8788 端口与共享工作区；debug 链路已验证触发块 / 轮次色点 / 交锋看板 / 结论条 / 参与条实渲染）。
- 相关文档：design.md §98 / ADR 0154–0156 / `docs/pk-game-analysis-design.md`（批一已实施、批二 M66 待实施） / `docs/adr/README.md` 索引。

### v75 — M65-A 家装设计工作室资产落地：interior 场景三角色 + 技能 2 + 预设 + mock 触发块（M65 批一 · 资产侧）

- **动因**：家装设计工作室与风水阳宅专项（docs/design-studio-design.md，设计定稿 v1.2）M65-A 批——interior 场景（需求研判 → 空间规划 → 3D 效果图）资产落地；设计容器族（layout / styleboard / render）与 studio 3D 工作台面板（第 7 类，注册骨架）以本批为前置。
- **新场景与角色（3 角色，六段骨架 + 头像 512px）**：`interior`（家装设计工作室，order 119，dock · studio 面板，parallel 2）；成竹（interior-designer 主案设计师）/ 规方（space-planner 空间规划师）/ 塑光（visualizer 3D 可视化设计师）——职责边界与 housing.reno-designer（装修工程）显式切割（预算回交）。
- **场景协议**：`interior/_protocol.md`（铁律含尺度合规区间与效果示意声明；新增「渲染容器约定」段：layout / styleboard / render 三容器语法与资产输出约定；质量红线 + 典型失败模式两段齐备）。
- **技能 2**（51 → 53）：`interior-design`（需求四问 / 风格四要素 / 尺度合规表 / 灯光三层 / 材质选择 / 交付纪律）；`3d-visualization`（DesignScene 契约 / prompt 六要素 / 快照→图生图工作流 / 迭代控制 / 常见修正）。
- **预设 1**（26 → 27）：`home-makeover`（家装全案设计：成竹 → 规方 → 塑光逐棒）。
- **mock 镜像四件套 + 触发块**：SCRIPTS 三角色剧本 / artifactFor 三交付件（设计方案 / 空间规划 / 出图说明）/ DISPLAY_NAMES / preferredOf（与 AGENT.md handoff 对齐）；触发块三组（「布局走查」→ space-planner layout 卡；「风格走查」→ interior-designer styleboard 卡；「出图走查」→ visualizer render 卡——唯一触发词零碰撞）；TOPICS + 「家装」（eval 主题词）。
- **面板注册（第 7 类）**：shared `STAGE_PANELS + 'studio'`；client 注册表 + `StudioPanel`（方案选择 + three 栈懒加载面）+ `panelReady('studio')`（layout 容器或 .scene.json）；avatar-icons +4 图标（armchair / pencil-ruler / ruler / box）。
- **3D 基座 B0（同批前置）**：three@0.175.0 + @react-three/fiber@8.18.0 + @react-three/drei@9.122.0（React 18 锁线）+ @types/three；vite `three-stack` 独立 chunk（gzip 实重 230.82KB ≤ 240KB 预算）；首屏零增量（懒加载边界 studio-lazy）；vitest/jsdom mock Canvas 策略 3 例。
- 评测：eval **33/33 ✅**（+interior 任务；与基线零回归）；check:agents **117/117 + 协议 30/30 ✅**（QUALITY_STRICT）；check:skills **53/53 ✅**；client 全量 **1053/1053 ✅**（88 文件）；server 本批相关面（m21 / mock-coverage）**23/23 ✅**。
- 并发注记（收口窗口实测）：外部批次两条线在收口窗口内活跃——① M63 盘面深化线（v74 登记）落盘 tarot / dice 工具（`server/src/tools/tarot.ts` / `dice.ts`），tools.test 工具计数（59→63 / 38→42）待其同步；② 新场景 `creator` 批次（account-strategist / growth-editor / monetizer / script-writer，20:01 落盘）处收口中间态，其 mock 镜像四件套尚未配置（mock-coverage 4 例红）且 m21 计数待续同步（本批已落 30 场景 / 117 角色，其收口后为 31 / 121）；另 `e2e-probe-3` 空壳残留一度致全量资产加载异常（已清）。上述均为外部批次中间态（非本批引入），由其各线收口；本批资产 / mock 四件套 / 面板注册面在隔离窗口验证全绿（m21 + mock-coverage 23/23）。
- 相关文档：docs/design-studio-design.md（设计基线；编号让位段已按开工实测回写：ADR 自 0154 / §98+ / CHANGELOG 自 v75；§13.3 B0 实测纪要）。

### v74 — 盘面深化落地（M63 批一至批六）：八字神煞·柱间·小运·流月 / 紫微流年层 / 六爻伏神·月日·回头 / 行运扫描 / 合盘矩阵 / 大六壬天地盘课传 / 奇门九宫局盘 / 七政四余宫位盘 / F 收口（E2E 七例 + 印章 + 修复链）（工具侧 + 前端 + 资产）

- **动因**：用户「针对命理相关场景做进一步深度优化，达到专家级/生产级/专业级」（三项决策：全量工具化 / 现代专业 + 传统点缀 / 设计文档先行）。设计基线 `docs/metaphysics-deepening-design.md`（四类缺口全景）；本批收口 M63-A（既有四工具深化）+ B（占星行运×合盘工具化）+ C（大六壬）+ D（奇门遁甲）+ E（七政四余）——**metaphysics 7 角色与 astrology 4 角色实现全量排盘工具化（零空手）**。
- **八字 v2（`server/src/pan/bazi_extra.ts` 新建 + bazi.ts）**：神煞 18 种（日干起 8 / 月支起 2 / 三合局起 6（年支日支双起）/ 三会方起 2；逐柱命中制「名（起法→命中柱）」）；柱间关系（天干五合·相冲 + 地支六合·六冲·相害·相刑·相破·半合·三合·三会 + 自刑 + 运岁作用大运/流年对四柱）；小运（`DaYun.getXiaoYun` 同源）；流月（`liuYueOf` 参数触发 12 条，五虎遁验证：丙年正月庚寅）。
- **紫微 v2（ziwei.ts）**：`horoscopeYear` 参数触发流年层（iztro horoscope yearly——流年干支 / 流年命宫按 yearly.index 落本命宫 / 流年四化禄权科忌序；丙年四化 天同天机文昌廉贞 实测验证）。
- **六爻 v2（gua.ts）**：伏神（本宫首卦所缺之亲伏于首卦同亲爻位）；月日关系（月破 / 静爻与日辰相冲：旺相暗动·衰囚日破；旺相休囚死简档）；回头生克（变爻对动爻：回头生 / 回头克 / 回头泄——只标注结构不出吉断）。
- **行运盘（M63-B，`server/src/pan/transit.ts` 新建 + `transit_pan`）**：行运行星（落本命宫 / 逆行）+ 行运→本命十星与四轴 cross-aspects（orb ≤ 6°、按 orb 升序）+ 时点扫描（`scanFrom/scanTo`，步长 1 天 + 二分细化至分钟（容差 0.01°）；外行星×十星与四轴 + 内行星×四轴（月亮×四轴因高频排除）；输出「精确时点 + 影响窗」参考区间；全年扫描实测 117ms。
- **合盘（M63-B，`server/src/pan/synastry.ts` 新建 + `synastry_pan`）**：双侧行星（带 A/B 侧前缀）/ 双盘 cross-aspects（A星×B星 + A星×B轴 + B星×A轴；orb ≤ 8°；对称去重；按 orb 升序）/ 元素互补（一方 ≤1 且另一方 ≥3）/ 组合盘中点（mode=composite；组合宫位 v1 显式不提供）；卡面含知情声明行；交换 A/B 镜像一致性 golden 断言。
- **大六壬（M63-C，`server/src/pan/daliuren.ts` 新建 + `daliuren_pan`）**：天地盘（月将加时十二神）/ 四课（日干寄宫逐层取上神）/ 三传（九宗门完整——贼克·比用·涉害（归地·顺数计克）·遥克（蒿矢/弹射）·昴星（虎视/冬蛇掩目）·别责·八专·伏吟·反吟，含课体与依据；中末递取 / 特殊课专属规则（昴星中支上末干上、别责八专中末皆干上、伏吟反吟刑取·自刑取冲））/ 十二天将（昼贵夜贵 + 贵人临亥子丑寅卯辰顺布 / 巳午未申酉戌逆布）/ 旬遁天干与旬空；2026 全年 720 例扫描九宗门全覆盖（重审 195 / 涉害 131 / 元首 94 / 遥克 76 / 比用 71 / 伏吟 60 / 反吟 60 / 昴星 14 / 八专 10 / 别责 9）；卡面口径声明「时家·中气换将·贵人顺逆法·涉害归地比较」。
- **奇门遁甲（M63-D，`server/src/pan/qimen.ts` 新建 + `qimen_pan`）**：时家转盘·拆补法——七十二局表（冬至起阳遁 / 夏至起阴遁）/ 符头（甲己日）定元（子午卯酉上中下元）与符头-节气先后定属（符头后于节气用当前气 / 先则归上一气，天数差随卡声明）/ 地盘三奇六仪（戊己庚辛壬癸丁丙乙，阳顺阴逆宫数循环）/ 值符值使（旬首仪落宫 → 原生星 / 门）/ 天盘（值符随时干——甲用旬首仪——圆盘同序旋转，禽随芮）/ 八门飞宫（值使随时支旬内序数，阳顺阴逆含中宫寄坤）/ 八神（值符神随值符星落宫，阳顺阴逆）/ 旬空宫标注；**基准例（阴五局）全盘逐项手工验算通过**（地盘逆飞 / 转盘 k=7 逆一位 / 八神逆布）；全年扫描 18 个局键全覆盖（阳 1-9 / 阴 1-9）；卡面口径声明「时家转盘·拆补法·中宫寄坤」。
- **七政四余（M63-E，`server/src/pan/qizheng.ts` 新建 + `qizheng_pan`）**：七政（太阳 / 太阴 / 水金火木土：黄经 / 落宫 / 逆行，与本命盘同源）+ 四余（罗睺 / 计都 = 月球平交点 Ω 与 Ω+180°（Meeus 平根数）、月孛 = 平远地点、紫炁 = 古法线性（28 年周天、甲子历元锚定）——每行显式近似等级）+ 十二宫（命宫起：宫支 / 星座 / 宫主（古典守护）/ 落宫星曜）+ 七政庙旺 + 口径声明（v1 不列二十八宿度）；命宫 = 太阳过宫 + 生时推移（卯时同太阳宫）——**基准例命宫输出（巳/处女）与该盘真实上升逐字一致（强校准）**。
- **卡与派生（零契约破坏）**：旧 kind 仅追加可选字段行与条目（神煞 / 柱间 / 运岁 / 小运 / 流月：…/ 流年 / 扫描 / 口径 / 注）；爻行尾注追加（伏神 / 月日 / · 回头X）；新 kind 五类（transit / synastry / daliuren / qizheng / qimen）入 PAN_KINDS 白名单；**必需门冻结**（旧卡派生路径零改动）；客户端 `derive.ts` 新增 5 类可选解析 + 5 类新 kind 派生（含「cross 行被行星正则抢匹配」修复：行星正则排除 `-`）；旧卡零回归断言全覆盖。
- **前端盘面（现代专业 + 传统点缀）**：BaziBoard（神煞 chips 点击请教 / 柱间 chips 点击高亮两柱 + 请教 / 小运条 / 流年选中展开 12 流月·无则补算草稿）；ZiweiBoard（流年开关（朱砂令牌）→ 流年命宫环标 + 12 宫名角标（前端逆布，与 iztro palaceNames 逐字吻合）+ 流 禄/权/科/忌 徽标 + 补算次年草稿）；GuaBoard（月日 chips / 伏神详情段 / 回头标注 / 「请教此爻」草稿）；**TransitWheel**（星座环 + 行运十星（0° 白羊置左）/ 行星↔相位清单双向联动 / 扫描 ribbon + 关注时点草稿）；**SynastryBoard**（10×10 交角矩阵（点格高亮 + 相位色）/ 轴相位与全量清单 / 组合盘开关 / 元素行 / 知情脚注）；**DaliurenBoard**（天地盘三层圆盘（午上子下：外圈地盘 / 中圈天盘 / 内圈天将）/ 四课板书（右起）/ 三传卡列；天将层开关 / 宫位详情 / 请教课传）；**QizhengBoard**（十二宫圆盘（外圈宫名 / 中圈宫支 / 内圈宫主；落星宫朱砂标）/ 政余表（11 行：宫位度数 / 逆行 / 近似角标）/ 庙旺行 / 宫与星双路请教）；**QimenBoard**（九宫格（洛书布局：巽离坤 / 震中兑 / 艮坎乾）——五层堆叠（八神 / 九星 / 八门 / 天盘干 / 地盘干）/ 值符值使角标 / 旬空虚线格 / 定局条 / 宫详情与用神请教）；样式块 M63-A–E 新增 `--pn-cinnabar`（quiet-mode 退前景色）与五类 kind 色相（transit/synastry/daliuren/qizheng/qimen）；PanView 分发扩展至九类。
- **资产**：`metaphysics/_protocol.md` #6（大六壬 / 奇门 / 七政四余从「未工具化 / 近似声明」全面移除，**全门类工具化完成**；改为「口径声明——各门类算法口径随盘声明、近似与争议口径如实标注」）#8（工具清单加大六壬 / 奇门 / 七政四余）与交付契约行；bazi/ziwei/liuyao/meihua「专业判断」各 +1 行；大六壬「溯机」/ 奇门「奇正」/ 七政「步天」角色全面工具化（职责 / 专业判断 / 工作方式 / 自检 / 反模式）；`astrology/_protocol.md` #8/#9（三工具分工 + cross 必须出自工具 + orb 口径声明）；transit/synastry 角色数据源行级更新；两技能工具表更新（含检查清单两项“未工具化”表述升级）；**11 角色（metaphysics 7 + astrology 4）白名单追加 transit_pan / synastry_pan / daliuren_pan / qizheng_pan / qimen_pan**；general 白名单同步（含 M69 批 dice_roll/tarot_draw 补缺，差集语义「仅 handoff」恢复）；mock 八组触发块（「八字深走查」「卦深走查」「流年走查」「行运走查」「合盘走查」「六壬走查」「七政走查」「奇门走查」，卡文本取自工具实测输出）；eval 新增 `33-metaphysics-transit-synastry`（行运扫描 × 合盘矩阵，已 1/1 通过）；tools 清单计数同步（all 66 / deferred 45，含并发批增量）。
- **测试**：server `m63-pan-v2` 16 例 + `m63-transit-synastry` 10 例 + `m63-daliuren` 12 例（九宗门十例全谱锁值）+ `m63-qimen` 7 例（阴五局全盘逐项手工验算 + 伏吟 + 拆补接气）+ `m63-qizheng` 6 例 + `m53-pan-card` 契约 +8 例（九类 kind 线）；client `m63-pan-v2` 7 例 + `m63-pan-boards-v2` 9 例 + `m63-transit-synastry` 8 例 + `m63-daliuren` 5 例 + `m63-qimen` 4 例 + `m63-qizheng` 4 例（全交互链 + 旧卡零渲染/回退断言）；四包 typecheck 0 错误（M63 文件面；client 全局有并发批 scene/studio 中间态）。
- **F 收口（批六）**：① **E2E 四条 spec**（`m63-transit-synastry` 行运星环/相位/扫描 ribbon + 合盘矩阵/组合盘；`m63-daliuren-qimen` 天地盘/四课/三传/天将层 + 九宫/值符值使/旬空；`m63-qizheng-bazi2` 十二宫/政余表/庙旺 + 神煞/柱间两柱高亮/小运/流月；`m63-ziwei-yearly` 流年开关/流年命宫/流四化徽标/复原——**7/7 全绿**，卡文本均取工具实测输出）；② **eval 任务 35**（六壬×奇门，1/1；34 已被风水批占用）；③ **`.pn-seal` 印章**（卡头右端 2 字口径缩写 · quiet-mode 隐藏 · aria-hidden）；④ **修复链（E2E 实测发现，均为真实缺陷）**：a) **CommonMark lazy continuation 救援**（remark-ext finalizeFieldsAndItems：列表末条后紧邻段落被 mdast 并条 → 条目值首个换行截断 + 尾段逐行分派——**同时恢复六壬课体/贵人/天将与七政庙旺等尾段字段行达位**，此前真实消息链下不可达）；b) **合盘行前缀固定 A/B**（自定义 label 时附「A = 甲 ｜ B = 乙」映射行——derive 依赖）；c) **数字年份宽容**（liuYueOf / horoscopeYear 收 number | string——模型常传数字）；d) **mock 落盘模板与话术同步工具化口径**（六壬/奇门/七政「未工具化」表述全清除，落盘模板含「参考声明」节）；⑤ **ADR 0176**（M63 全批）落位（ADR 0148/0175 依次被并发批占用而让位）；⑥ **收官走查两项**：**mock 走查回复路径 E2E**（`m63-mock-walks` 3 例：八组深走查触发词经真实角色回复路径（@召唤 → 派单 → mock 块回复 → 渲染）全绿——此前回复内卡的渲染链未被覆盖）；**档案对照通用化**（`diffPan` 仅覆盖四旧盘 → ArchiveDrawer 回退「条目级通用 diff"（同 kind 逐行对齐），新 kind 对照出差异块 `.pn-diff`；`m54c-pan-archive` 新增六壬回看/对照用例）；⑦ **Almanac 行运泳道**（§5.4 扩展落地）：transit 卡扫描 hits → 年龄轴 ◆ 节点（虚岁 = 年份 − 出生年 + 1，与卡内流年岁数同口径）；节点点击 → 只读详情（含「参考时点，非事件断言」）；**同期（同年）多时点水平错开 22px/序**（修复重叠遮挡不可点）；缺出生年 / 无扫描 → 零渲染不虚构；触发路径 = 组队台跨场景加「星移」（角色池全量可选）；`m54c-pan-almanac` +3 例（泳道/节点交互/零渲染）· E2E `m63-mock-walks` 第 4 例完整链路（组队台 → 三盘入面板 → 第三泳道 → 节点详情）；⑧ **v2 增强与中西对照**：a) **SynastryBoard 双环同心图**（外环 A / 内环 B，0° 白羊置左与轮盘同约定；矩阵点格 / 悬停 → 双点高亮 + 连线，色随相位类型；轴相位不入环）——组件测 +1；b) **中西对照 toggle**（§7 F-t1：会话内可派生 bazi + natal（或 qizheng）→ 面板顶部 toggle → 并排双盘（仅并置、不做数据融合）+ 出生参数一致性提示 + 口径注）；mock `PAN_BLOCKS` 新增 natal 块（同参卡）；E2E `m63-mock-walks` 第 5 例（组队台跨场景加司辰 → 并排双盘 + 一致提示）；**E2E m63 扩至 12 例全绿**；排查注记：手动 E2E server 陈旧进程（启动早于 mock 编辑）→ 旧代码持续服务导致「mock 直调正确但页面行为不符」——已入经验记忆（进程启动时间核对）；⑨ **TransitWheel 双环（v2 收尾）**：`transit_pan` 卡新增本命十星行（内环基准；文本区 + 卡；旧卡无此段 → 单环零回归）；`TransitModel.natalPlanets` 解析；轮盘内环三档（58/50/42，与外环同档位垂直对应）；选中 cross → 外环行运点 + 内环本命点高亮 + 连线（轴相位不入环）；legend 条件项；契约 +2 断言（本命行 10 条 / 位于行运行星前）；组件测 +1（双环/联动/轴不入环/旧卡零回归）；⑩ **奇门口径考据与如实化**：拆补/置闰差异规则完成三源考据（《易学象数论》原文 + 两篇分类文：上元符头 = 子午卯酉之甲己日；超神 = 符头先于节气且差距累积；**超九日于芒种/大雪置闰 = 重复该节三元十五日**，符头由超转接）；v1 实现为「符头候简化」——卡面口径行如实标注「拆补法（符头候简化）」；卡口径文案全链统一（工具 / mock / 契约 / E2E fixture）；⑪ **奇门双口径落地（续完善收尾）**：按考据实现**置闰对照口径**（检查点窗口：芒种/大雪「上元符头超前量 ≥9 日」（超神九日）时，其后 15~30 天为闰元 = 重复该节三元十五日；`zhirunOf` 自然历法判定无历史依赖）；`ding.zhirun`（dun/ju/qi/yuan/leap/note）随计算结果输出——**仅两口径不同局时**卡内加「对照：置闰法 …」字段行（基准例 2026-11-05 两口径一致——零回归）；QimenBoard meta 显示对照行；**探针验证**：2022/2025 芒种与 2027 大雪窗口 d=11（置闰间隔 2-3 年与常识吻合）；golden +2（2022-06-25 拆补阴 9 / 置闰阳 6·闰；2027-12-28 阴 7·闰）+ 契约 +1（窗口卡有对照行/基准卡无）+ 组件 +1（对照行 meta）；**M63 遗留清单至此全清账**（仅跨年累积顺延为文档级口径）。
- **评测与账目**：eval **36 任务**（F 批新增 35 六壬×奇门 1/1 通过；33 行运×合盘已 1/1）；check:agents **协议 41/41**；check:skills **61/61**；server 定向面（m63 全套 + tools + m50 + mock-coverage）**124/124 全绿**；client 定向面（M51/M54/M63 全套）**全绿**；**E2E m63 五文件 10 例全绿**（四条贴卡 spec 7/7 + 走查回复路径 3/3；PW_OUTPUT_DIR 隔离运行，会话间 test-results 竞态已有先例备忘）；并发批遗留失败已甄别归属、非本批引入。
- **相关文档**：`docs/metaphysics-deepening-design.md`（M63 设计基线；实施注记 + 收口注记已回写：M63-A/B/C/D/E/F 实施 + 修复链 + 明确遗留）；编号：CHANGELOG v74（v73 已由并发 M39 占用）；批次 M63（pk-game 批二已实际落为 M64、场景玩法批 M69——M63 专属本专项）；**ADR 0176 已落位**（索引已联动；design.md 专章待 S96 窗口）。

### v73 — M39 生产型渲染包资产落地：sre 协议「渲染容器约定」条目 12 + mock 两组触发块（M39 批 · 资产侧）

- **动因**：全场景深度优化批二（生产域 development / bi / sre / marketing）——M39 渲染包（ADR 0149–0151 / design.md §97）落地：SR-3 复盘容器与 DEV-3 验收单均为**派生式**渲染，容器格式（postmortem）与输出格式（验收判定句式）必须写入资产，否则复盘卡与验收徽章在真实链路永不出现（与 M38 同口径：容器格式写入资产是面板出现的前提）。
- **协议增补（一处，仅追加不改旧文，质量红线 / 失败模式结构保留）**：`sre/_protocol.md` 新增「渲染容器约定（复盘卡）」条目 12：`::: postmortem <标题>`——字段行「分级 / 时间线 / 归因」（多时点时间线用「→」串联，时点与证据出处同源）；条目行 `- 改进项 | <行动> | <owner> · <期限>`（验证方式可括注），与《事故复盘》改进项表逐项对应；容器内不写 @。
- **mock 两组触发块**（唯一触发词，同 M38 先例；块内不写 @）：「验收走查」→ qa（「验收判定：通过（2 项未决）。」+ 两条未决条目——DEV-3 `acceptanceOf` 派生数据源）；「复盘走查」→ sre（`::: postmortem` 复盘卡块：分级 / 时间线 / 归因 + 改进项两条——SR-3 E2E 数据源）。既有剧本零改动（触发词与 eval 语料零碰撞）。
- **同批相邻项（非 agents 资产，登记备查）**：服务端工具记录 meta 扩增（db_query 行预览 ≤5 行 / ssh_exec 输出 ≤2000 字符与截断标记）——为 BI-1 / SR-2 两张场景工具卡提供持久化数据源（ADR 0150 / design.md §97.4）。
- 评测：eval **32/32 ✅**（与基线零回归）；check:agents **114/114 + 协议 29/29 ✅**（QUALITY_STRICT）；check:skills **51/51 ✅**；server **1174/1174 ✅**。
- 相关文档：design.md §97 / ADR 0149–0151 / `docs/scene-chat-design.md` 头部（编号修订六 + §7 落位注记）/ `docs/adr/README.md` 索引。

### v72 — M38 研讨容器族资产落地：三场景协议「渲染容器约定」+ 5 角色输出约定 + mock 三组触发块（M38 批 · 资产侧）

- **动因**：全场景深度优化批一（研讨域 brainstorm / research / strategy P0）——M38 研讨容器族（idea / phase / score / sources / decision，ADR 0144 / design.md §92）在前端落地；**容器格式必须写入资产**（M37 checklist / M54 pan 先例），否则卡片与面板永不出现。
- **协议增补（三份，仅追加不改旧文，质量红线 / 失败模式结构保留）**：
  - `brainstorm/_protocol.md` 新增「渲染容器约定」段（条目 12–14）：点子卡 `::: idea <编号> <标题>`（状态枚举 候选 / 入选 / 被毙；编号与《点子池》逐字一致）、阶段条 `::: phase`（发散 → 收敛）、ICE 评分卡 `::: score`（总分 = 三项乘积，与《评分矩阵》同序）；
  - `research/_protocol.md` 新增「渲染容器约定」段（条目 9–10）：来源卡 `::: sources`（`- 标题 | URL | 日期 | 要点 | 高|中|低`，五要素与《来源清单》一致）、论断标注 `::: claim`（三分归类与置信度写入细节行）；
  - `strategy/_protocol.md` 新增「渲染容器约定」段（条目 10–11）：决议卡 `::: decision`（背景 / 决策 / 后果，与《经营简报》决策记录段同源）、权衡矩阵 `::: score`（非 ICE 场景显式「总分」列）与 `::: option` 表态。
- **角色人设增补（5 个，仅「工作方式」各加一行输出约定，六段骨架与交付契约零改动）**：facilitator（phase）/ ideator（idea）/ refiner（score）/ scout（sources）/ chief（decision）。
- **mock 三组触发块**（server/src/llm/mock.ts，唯一触发词，同 M37 checklist / M54 pan 先例；块内不写 @ 防误判转交）：「点子走查」→ facilitator / ideator / refiner；「来源走查」→ scout / verifier；「决议走查」→ chief——既有剧本零改动（触发词与 eval 语料零碰撞）。
- 评测：eval **32/32 ✅**（与基线零回归）；check:agents **114/114 + 协议 29/29 ✅**（QUALITY_STRICT）；check:skills **51/51 ✅**；mock-coverage 四件套 **4/4 ✅**。
- 相关文档：design.md §92 / ADR 0144–0145 / `docs/scene-chat-design.md` 头部（编号修订五 + §6 落位注记）/ `docs/adr/README.md` 索引。

### v71 — 悬浮阶段条重塑：顶部方位条 + 贴顶边上移 · 轻量药丸 · 「共 N 波」读数（波次条续修订批 · 纯前端）

- **动因**：用户实测截图（arena：谈判桌）红框两轮反馈——①「重新优化」：药丸与消息头部同排交错（药丸「第 1 波 · 谭成」与消息头「13:25 你」并列，视觉上像消息的一部分）；②二轮「红框中的内容需要上移」：药丸下探到首条消息（气泡顶边/正文被压）。v70 三轮仅间距微调（top-2 → top-3.5 / 「太靠着了」），本批按「重塑 + 贴顶」两轮收口。
- **变更一（顶部渐隐遮罩）**：新增 `data-wave-scrim` 渐隐层（`h-12`，`from-background via-background/80 to-transparent`，`aria-hidden`）——滚过顶端的内容在边缘自然淡出，药丸不再与任何消息头部文字同排交错。
- **变更二（药丸轻量化）**：`shadow-lg shadow-slate-900/5` → `shadow-sm`、`border` → `border-border/70`、`bg-card/90` → `bg-card/95`、`text-[11.5px]` → `text-[11px]`、`py-1` → `py-0.5`、`gap-2` → `gap-1.5`——降低悬浮体量，与遮罩合成「边缘读数」而非「漂浮物」。
- **变更三（共 N 波读数）**：`ChatArea` 新增 `waveTotal`（`waveOf` 按 `runId~turnIndex` segKey 去重——同 key 中续段不重复计数）经 `total` prop 传入；总数 ≥2 才显示「· 共 N 波」（与波次分隔行同门限），单波 / 缺省不显示。
- **变更四（贴顶边上移，二轮实测）**：药丸偏移 `top-3.5` → `top-1`（14 → 4px）——贴顶边后不再下探到首条消息；形态已由「空中漂浮物」变为「渐隐区内的边缘读数」，v70 的 14px 间距判定被本批覆盖。
- **锚点与订阅零改动**：`data-wave-strip`（E2E 锚点）/ `title` 跳转提示 / 点击 `focusMessage(memberIds[0])` 不变；成员头像订阅仍为 primitive key（流式增量不触发重渲染）。
- **测试**：新增 `client/tests/wave-strip.test.tsx` 3 例（锚点药丸 + 名字 + 遮罩锚点；「共 N 波」≥2 门限；点击 onJump）；client 全量 **909/909 ✅**（73 文件；窗口内含并发批次增量）；client typecheck / ESLint 0 错误；E2E 定向 `m37-scene-chat` **2/2 ✅**（7.8s / 9.2s）+ 临时视觉核验 1/1（谈判桌 arena：滚顶 / 中段截图 `data/wave-strip-vis-top.png` / `wave-strip-vis-mid.png`——贴顶边 + 渐隐区内读数 + 「共 3 波」实证；核验后临时 spec 已删）。
- 相关文档：ADR 0065（决策 4 续修订两轮）、`docs/scene-chat-design.md` §5.3 / §5.4 ⑧、design.md §81.2 续修订四轮、`docs/adr/README.md` 索引。

### v70 — arena 中轴空间优化：侧栏宽度回调 22% / 340px · 顶部条带瘦身 · 悬浮阶段条间距（M60 续修订三轮 · 纯前端微调）

- **动因**：用户实测三轮反馈（arena：谈判桌）——「中间内容有点小，导致看不完整一个消息」（两侧 24% 侧栏挤压中轴 + 顶部条带占高）；「第二张图太靠着了」（悬浮阶段条 WaveStrip 与上方固定条带贴近）。
- **变更一（侧栏让宽）**：`.scene-arena-side` `clamp(164px, 24%, 360px)` → `clamp(164px, 22%, 340px)`——两侧仍同值严格一致（等宽 + `scrollbar-gutter: stable` 口径不变）；中轴宽度占比 +4%。
- **变更二（顶部条带瘦身）**：`.scene-arena-center` / `.scene-arena-track` padding 0.4rem → 0.25rem；`.scene-arena-insights`（博弈面板）max-height 190 → 150px（可内部滚动）——为中轴消息区让渡纵向空间（约 45px）。
- **变更三（悬浮阶段条间距）**：`WaveStrip` 悬浮条 `top-2` → `top-3.5`（8 → 14px）——缓和与上方固定条带的贴近观感（ADR 0065 续修订）。
- **测试**：E2E `m52-stage.spec.ts` 宽度断言公式同步（`Math.max(164, Math.min(340, 宿主 22%))`）；组件测注释口径同步（`m60-arena-live.test.tsx`）；client 定向 `m60-arena-live` + `m52-stage` **61/61 ✅**。
- 评测：E2E 定向 `m52-stage` arena 用例 **1/1 ✅**（25.3s；22%/340 新公式 + 左右等宽 + 滚动条占位一致性断言同跑通过；环境类假失败甄别：并发会话服务器关闭尾竞态 → SQLite database is locked 致 webServer 启动失败，非代码问题，重跑即绿）；
- 相关文档：ADR 0129（续修订三轮）、ADR 0065（决策 4 续修订）、design.md §81.2、`docs/adr/README.md` 索引。

### v69 — 联网工具去除访问限制：web_fetch 域名白名单机制移除 · web_search 退出环境门控

- **动因**：用户实测截图（调研会话）——`web_fetch` 连续两次被拒「域名不在白名单：baijiahao.baidu.com / zhuanlan.zhihu.com（允许：joinquant / ricequant / myquant）」，明确诉求「不要限制请求的url，所有的url」；随后进一步要求「所有调用网络部分都不需要限制」。既有 `WEB_FETCH_ALLOWED_DOMAINS`（白名单）与 `WEB_SEARCH_ENABLED`（启用开关）使「先搜后抓」链路的可访问性绑定到配置维护，调研任务频繁红卡。
- **机制移除（访问限制归零）**：`WEB_FETCH_ALLOWED_DOMAINS` 配置 / `domainAllowed` 白名单匹配 / 首次 + 重定向两处校验整体删除（任意 http/https 地址可抓取）；`WEB_SEARCH_ENABLED` 与运行时 `webSearch.enabled` 删除（web_search 始终可用；API / HTML 模式仍按 apiKey 自动选择）；`toolUnavailableReason` 仅保留 run_command；两处 DISABLED_SUMMARY 文案删除；`.env` / `.env.example` 两变量移除。
- **保留保护性机制（非访问限制）**：http/https 协议校验、反爬栈（限速 / 429 退避 / 风控识别与冷却 / GBK / 超时；`HTTP_MIN_INTERVAL_MS=0` 可关闭限速）、体积上限（web_fetch 512KB / web_search 2MB）与回灌上限（8000 / 4000 字符）——防封禁与防上下文爆炸。非本批范围：`ALLOW_RUN_COMMAND`（本地命令）、`FINANCE_ENABLED`（金融模块功能开关，当前已开启）、浏览器导航协议白名单（本地资源访问）。
- **资产变更**：`_protocol.md <tool_policy>` 联网条目删「工具未启用」；`research/_protocol.md` 无外网条件改为「被风控拦截或网络不可用」；`deep-research` 技能「方法与限制」与接入口径同口径修订（scout 人设上批已修订为「抓取来源页面正文」）。
- 评测：eval **32/32 ✅**（mock；与基线零回归）；check:agents 协议质量 29/29 ✅（114/115 达标，1 例为 E2E 临时 agent 残留、非本批引入）/ check:skills 51/51 ✅；server 全量 **1118/1118 ✅**（83 套件）；server typecheck 0 错误。
- 相关文档：ADR 0136《联网工具去除访问限制》（修订 ADR 0035 白名单边界 / ADR 0099 两条联网门控；README 双索引登记 Amended）、design.md §56.2 修订注记与 §12 非目标、`docs/operations.md §4.5`；测试更新：m5（用例收敛「无白名单任意抓取」）/ m47（门控单测收敛、清单计数 51、发现区块「联网（2 个）」）/ web-search（未启用用例删除）/ m28 / m50（门控 pin 清理）/ 全仓测试替身字段清理（15 文件）。
- 编号说明：v67 / v68 被并发批次（工具系统全量审计 / 场景交互深化）占用，本批顺延 v69。

### v68 — 场景交互深化：arena parts 精细化与首批场景声明（29 场景全量走查批）

- **动因**：用户要求「当前所有的场景深度优化（含交互）」——对 29 场景 × 四形态（5 stream / 18 dock / 4 roundtable / 2 arena）× 六面板 × 12 元件全量走查，处理真实缺口。
- **走查结论（零缺口面）**：dock（拖宽 / 折叠 / 关闭 / 窄屏抽屉）/ roundtable（席位回填 / 议程定位 / 顶区收起 / 汇聚板折叠）/ 空态链（guide + agenda chips + 成员 chips）/ 场景×面板适配矩阵（18 dock 场景面板逐一合理）——均完整无缺口。
- **缺口一（名实漂移，已修）**：`PART_NAMES` 登记 12 个幽灵 parts 名，实际受控仅 ArenaStage 四区块；`partEnabled` 零消费。收敛为 **arena 五件套**（round-track / scoreboard / verdicts / claim-tree / offers）——insights 拆为 claim-tree + offers 两个独立 parts、verdict 单复数修正；`on()` 改用 `partEnabled`（单一事实来源）；数据属性契约不变（既有测试零改动）。
- **缺口二（语义失真，已修）**：negotiation 无胜负计分语义但 Scoreboard 恒显 0:0（失真实显）——**首批 parts 声明落地**：`negotiation: [round-track, verdicts, claim-tree, offers]`（去计分板保报价流）；`debate: [round-track, scoreboard, verdicts, claim-tree]`（对齐设计原意；去报价流）；invest 默认全启用（向后兼容）。
- 文档：design.md §66.3 修订注记 + **§87**（v68 专章）；docs/scene-expansion-design.md §7.8 落位注记。
- 评测：client 全量 **888/888 ✅**（m52-stage +1：两场景 parts 裁剪矩阵）；m43-cards / m60-arena-live 零改动通过；lint 零新增。
- **验收发现与修复（同日终验）**：① m21 回归——stage 的 toEqual 精确断言撞上新 parts 字段（已升级为含 parts 的完整期望，断言强度反增）；② e2e stop/reload 锚点失真——v66 成员条常驻后 page 级 `getByText('费利')` 先命中成员条（早于消息产出），已改为 `[role="log"]` 消息区锚点；③ 全量 E2E 终验：**79/81 → 2 条失败经鉴定修复/复跑全过**（stop 为锚点失真·已修；interject 为高负载偶发·隔离复跑通过），本批相关定向 **34/34 ✅**（stop + interject + m43-pk + m52-stage + m54-pan）；期间 webServer 启动 exit 2 为端口释放竞态（基础设施偶发，非代码，重跑即过）。

### v67 — 工具系统全量审计与升级优化（安全罩补齐 + 描述增强 + 零缺口核验）

- **动因**：用户要求对现有 tool 做升级优化（不新增工具）——先全量审计 71 个工具的分类 / 测试 / 可达性 / 描述 / 能力声明一致性 / 安全罩，再按清单处理。
- **安全升级（P1）**：`git_restore` 纳入 `APPROVAL_MODE=risky` 强制审批（engine 审批门 + 差异化的挂起文案：staged / 丢弃工作区两态）——丢弃未提交改动不可逆，此前仅 `git_commit` 拦截而 restore 裸奔；工具描述补「该操作需要用户审批」（与 git_commit 口径对齐）；`approval.ts` / `design.md`（§6.2 / §45.6）审批名单同步。
- **描述增强（P2，模型选型面）**：`browser_scroll`（全库最短 31 字 → 补「何时用 + 滚动后重新快照」纪律）/ `browser_navigate`（补与 browser_open 职责边界：未开用 open 一步到位）/ `browser_fill`（补「selector 取自 snapshot，勿猜 CSS」纪律）/ `git_branch`（补「切换前先 git_status」纪律）。
- **审计结论存档（零缺口）**：① 分类完备——71 工具 × 47 显式键 + 前缀规则，零未分类零悬空；② 测试引用 71/71；③ 可达性——114 角色 × 71 工具零绑定缺口（写类/范式工具绑定数符合设计）；④ calc 21 函数与资产引用零漂移；`date_calc` 工作日能力与「含工作日顺延」声明逐字一致；⑤ pan / fin / db / media 组描述为「唯一口径 + 禁令 + 引导」高水准；错误引导体系（M47）单一事实来源；⑥ `manage_schedule` / 媒体 / 画布写类按「最小干预」有意不拦截（结论记录，非缺口）。
- 评测：m7 审批套件 +2 例（git_restore 批准后还原 / 拒绝后保留）；server 全量 **1119/1119 ✅**；typecheck ✅。
- 编号说明：v66 被并发批次（成员条统一常驻）占用，本批顺延 v67。

### v66 — 成员条统一常驻：输入条成员条全场景一致展示 · 撤销席位让位判定（成员条统一批，纯前端批次）

- **动因**：用户实测双会话截图对比（谈判 arena 会话 vs 投资研究 dock 会话）红框标注 Composer 上沿成员条区域并追问「为什么有的会话里面有，有的会话里面没有」，明确诉求「请统一下 / 所有的对话都需要统一」——M52-G（v49）的「席位覆盖时让位」判定对用户不可见、跨会话不可预期。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。（编号让位：v63–v65 由并发批次——P4 协议 / arena 续修订 / P6 评测——占用，本批顺延 v66。）
- **收口口径**：输入条成员条全场景恒展示（arena 全员入席 / roundtable 不再让位，与席位同屏并存——席位 = 结构可视化、成员条 = Composer 常驻操作面）；标题栏头像组移除维持。
- **实现**：`Composer` 删除 `poolHidden` useMemo 与 `resolveStage` / `useSceneStore.listMode` 两处依赖引入；渲染条件回归 `{!disabled && poolSorted.length > 0}`；席位与 @ 菜单链路零改动。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 114/114 达标 / check:skills 51/51；client 69 文件 / 877 测试全绿（M52-G 用例改写为统一常驻五态：arena 全员 / arena 部分 / roundtable 新增 / stream / 纯列表）；全仓 typecheck 0 错误；改动文件 ESLint 0 错误（1 条存量 warning——apiPost 未使用，非本批引入）；client build 通过（本批窗口产物 `index-BqaYPHmG.js` 1,276.21 kB）；E2E `m52-stage` 21/22 + 隔离复跑 1/1 + `m43-pk` 2/2 ✅（唯一失败为 dock·console 收尾 trace ENOENT 基建抖动——该场景成员条改前改后同为展示，隔离复跑通过；补跑窗口遭遇并发会话 server 中间态，判定非本批回归）。

### v65 — 评测扩展与专家级路线全量验收收口（P6：调度专项 golden 任务 + 全仓终验）

- **动因**：专家级路线最后一站 P6——调度能力（M61 D1–D7）与资产体系（Agent 114 / 技能 51 / 协议 29）需纳入 eval 回归门禁并完成全仓终验。
- **断言矩阵 +2**（`assertions.ts`）：新增 `scheduling` 聚合断言（routes / handoffAccepted / waves / parallelWaves 下限 + stall / 写冲突上限，与 `RunEventStore.schedulingStats` 同口径的纯函数 `schedulingCounts`）与 `no_stall`（停滞抑制回归守卫）；m9 断言矩阵 +3 例与新聚合单测（server 1116 → 1117）。
- **mock 路由剧本扩展**（`routeScript`）：财务 / 税务类需求 → 召集财务法务编制（finance / tax / legal，首棒 finance）——跨场景路由的确定性镜像面（研发链默认分支不变，18-platform-routing 不受影响）。
- **eval runner 增强**（`eval.ts`）：任务级 `serial:false`（并行守卫任务）与 `DEBUG_DUMP=1` 轨迹转储（调试用）；`--tasks=` 过滤 / `--update-baseline` 既有能力复核。
- **新增 4 个调度专项 golden 任务**（28 → 32）：`routing-finance`（跨场景路由 + 平台派单回执 ≥1）/ `handoff-receipts`（文本双棒链 + 转交回执落库）/ `scheduling-guards`（3 波接力零停滞零写冲突·D3/D5 回归守卫）/ `parallel-guard`（并行波 + 零停滞零写冲突·M16 并行回归守卫）；baseline 刷新至 32 任务。
- **口径更正（本批校准）**：① D4 接单回执的真实触发面——平台派单与工具交接（`handoffNotes`），文本 @ 接力链不经便条不落回执（断言按此校准）；② 角色显示名映射校正（backend=马克斯 / analyst-fa=秦砚），golden 任务提示词按真实名书写。
- **全仓终验（全绿）**：eval **32/32 ✅**（baseline 已刷新）｜ server 全量 **1117/1117 ✅** ｜ client **887/887 ✅** ｜ check:agents strict **114/114 ✅** ｜ check:skills strict **51/51 ✅** ｜ server typecheck ✅。
- **协议质量门禁（v63 配套落地）**：`check:agents` 新增「协议质量报告」——29 份 `_protocol.md` ≥28 行且含「## 质量红线」「## 典型失败模式」两段，同 strict 口径进 CI；实测 **29/29（100%）✅**；README 门禁说明同步。
- **镜像面全量核验**：114 角色名与 mock `DISPLAY_NAMES` 逐一比对——零缺失零偏差；29 场景 `_group.yaml` 的 guide / agenda 字段全量在场。
- **design.md 数字刷新**（§12.1 / 命令表）：服务端 1031→1117 例 / 75→83 套件；客户端 659→887 例 / 56→70 套件；E2E 43 条→81 条用例 / 36 个 spec；评测 22→32 个 golden 任务（附录 v65 调度专项说明）。
- **专家级路线全量收口宣告**：Agent 114/114 + 技能 51/51 + 协议 29/29 + 调度 D1–D7 + 评测 32/32 —— 三层资产与调度能力均已进入 CI 门禁与 eval 回归保护。
- 编号说明：v64 被并发批次（arena 侧栏宽度续修订）占用，本批顺延 v65。

### v64 — arena 侧栏宽度续修订：clamp 20% / 280px → 24% / 360px · 滚动条占位一致性（M60 续修订 · 纯前端微调）

- **动因**：用户实测二轮反馈（arena：谈判桌）——两侧席位发言流侧栏「可以在宽一点」，随后复核「两边宽度一致吗 / 请将宽度设置为一致的」；M60（v53）`clamp(164px, 20%, 280px)` 在中大屏下仍偏窄（原 280px 上限即 ADR 0129 注明的「4K 重估点」，本次按实测提前重估）。
- **变更一（宽度上调）**：`.scene-arena-side` `width: clamp(164px, 20%, 280px)` → `clamp(164px, 24%, 360px)`——窄宿保底 164px 与窄屏（<900px）降级口径不变；24% 相对宿主（非 vw）、360px 封顶（中轴仍保宿主 ≥52%）。
- **变更二（滚动条占位一致性）**：`.scene-arena-side` 追加 `scrollbar-gutter: stable`——两侧恒预留滚动条槽位：经典滚动条（鼠标模式）只占溢出的一侧，会令左右内容区标尺差 ~15px（即「两边宽度不一致」观感的来源：外框实测本就亚像素相等，内容区因滚动条占位而差）；stable 后两侧内容宽度严格一致，overlay 模式无副作用。纯 CSS 两处，零服务端 / 零资产 / 零协议 / 零组件改动。
- **测试**：E2E `m52-stage.spec.ts` arena 用例宽度断言公式同步（`Math.max(164, Math.min(360, 宿主 24%))`，误差 <2px；视口放宽变宽断言不变）＋ 追加「左右两栏等宽」与「滚动条占位一致性」核验（等宽断言带数值消息输出；两侧 `scrollbar-gutter` computed = stable + `clientWidth` 严格一致）；组件测注释口径同步（`m60-arena-live.test.tsx`）。
- 评测：E2E 定向 `m52-stage` arena 用例 **1/1 ✅**（复核跑 26.7s；实测 1280 视口 body 720.66 / 左右各 172.953125，1728 视口左右各 235.75——亚像素相等；滚动条占位一致性断言同跑通过）＋ 两次环境类假失败甄别（① 并发会话清理 test-results → trace 归档 ENOENT；② 紧邻复跑承接上一轮服务器回收 → ERR_CONNECTION_REFUSED——均非断言问题，错峰复跑即绿）；client 定向 `m60-arena-live` **3/3 ✅** / `m52-stage` **57/57 ✅**；e2e tsconfig typecheck 0 错误；零资产 / 零协议变更。
- 相关文档：ADR 0129（续修订）、design.md §81.2 / §81.3、`docs/adr/README.md` 索引（M60 续修订）、`docs/scene-expansion-design.md` 头部修订注记。

### v63 — 场景协议专家化全量收口：29 份协议补「质量红线 / 典型失败模式」（P4）

- **动因**：专家级路线 P4——29 份场景协议行数参差（16–35 行），普遍缺「不可妥协的完成定义（质量红线）」与「本场景特有协作失败及处置（典型失败模式）」两段；对齐 invest 协议（35 行）最高标准。
- **升级内容（29 份全部 ≥28 行）**：统一在「## 交付」前插入两段——`## 质量红线`（3 条本场景不可妥协的完成定义）+ `## 典型失败模式`（3 条场景特有失败及处置）；blank 16→28 / development 18→30 / ops 22→34 / finance·home·learning·research·sales 23→35 / bi·funding·health·personal·travel·wealth 24→36 / marketing·strategy 25→37 / sre 26→38 / care·housing·negotiation 27→39 / career·gamedesign·writing 28→40 / society 29→41 / astrology·brainstorm·debate 30→42 / metaphysics 34→46 / invest 35→47（协议总行数 744 → 1092）。
- **关键定制**：finance「合规兜底 + 数字可复算」、sales「报价守线 + 跟进闭环」、sre「先止血后根因 + 改进闭环」、bi「三要素可追溯 + 脱敏底线」、invest「免责完备 + 禁用必涨词」、health「渐进不可跳档 + 医疗零越界」、metaphysics「先盘后论 + 恐吓话术零容忍」、astrology「口径成节 + 合盘知情」、development「代码可跑 + 最小改动」、society「中立底线 + 分歧不抹平」等。
- **零破坏约束**：仅在「## 交付」前插入新段，原有铁律 / 协作 / 交付文本一字未动——全部测试断言关键词（development 7 词 / sales 报价纪律 / m21 六场景词 / m30 bi 六词 / m32 sre 八词 + marketing 实验纪律 / m35 三场景词）逐一核验在场。
- 评测：断言相关测试 **69/69 ✅**（m21 / m29 / m30 / m32 / m35-bindings）；eval **28/28 ✅**；check:agents strict **114/114 ✅**；check:skills strict **51/51 ✅**。
- **专家级路线资产层收口**：Agent 114/114 + 技能 51/51 + 协议 29/29 全量达标；余项：P6 评测扩展与全量验收收口。

### v62 — 技能库专家化全量收口：22 个低深度技能补齐 + 技能质量门禁（P3）

- **动因**：专家级路线 P3——全库 51 技能中有 22 个低于规范 60 行（最短 api-design 27 行），缺「反模式 / 检查表 / 工具接入」等专家级要素；与 Agent 体系（v56–v61）对齐。
- **升级内容（22 个，全部 ≥60 行）**：api-design 27→72 / brainstorm-facilitation 33→87 / test-plan 34→80 / content-marketing 37→71 / business-review 44→70 / deep-research 46→82 / game-theory-trading 49→75 / investment-strategy 49→83 / contract-review 52→61 / financial-modeling 52→61 / strategic-planning 52→61 / chinese-metaphysics 54→63 / market-news-analysis 55→64 / technical-analysis 55→64 / mcp-server-building 56→65 / system-design 56→65 / react-performance 57→66 / skill-authoring 57→66 / fundamental-analysis 58→67 / western-astrology 58→67 / nl2sql 59→65 / visual-design 59→68。
- **升级模式**：保留原 front-matter（name / description / tags 零改动）；正文补「**常见的坑**」（每技能 6 条反模式，按「会怎么做错 → 影响」句式）、补齐「检查表 / 输出模板 / 工具接入口径（本仓真实工具与容器）/ 协作衔接」；关键定制：api-design 四类响应 + 错误语义分级（越权统一 404）、test-plan 设计方法速查 + 缺陷分级口径、deep-research 论断×来源矩阵、investment-strategy 未来函数/样本外、metaphysics/astrology 口径红线（先盘后论 / 未工具化声明 / 知情前提）。
- **技能质量门禁**：`check:skills` 新增行数质量报告（正文 ≥60 行；>150 行仅提示拆分）；`SKILL_STRICT=1` 切 CI 强制——`ci.yml` agents job 双门禁（`QUALITY_STRICT` + `SKILL_STRICT`）；README 与 skill-authoring 校验说明同步。
- 评测：**SKILL_STRICT 退出码 0（51/51 达标）** ✅；eval **28/28 ✅**；server 全量 **1114 passed / 1 failed**（唯一失败 m34-finance-tools 属并发会话 finance 改动域，本批零回归）。
- 后续（专家级路线余项）：P4 场景协议深化（29 份补质量红线与失败模式）/ P6 评测扩展。

### v61 — Agent 专家级体系第三、四批：生活安居与命理占星全量收口（114/114 全达标 + CI 门禁切换）

- **动因**：专家级六段骨架体系（v56/v60）收官批次——W3 生活安居 20 角色（health 3 / home 4 / learning 3 / travel 1 / wealth 1 / personal 2 / care 3 / housing 3）+ W4 命理占星 11 角色（metaphysics 7 / astrology 4）+ blank/general 1。
- **升级模式**：每角色补写「专业判断」（硬规则）+「质量与自检」（核对清单 + 反模式）+ 协作接口补「交接品质标准」；front-matter 与交付契约路径文本零改动。
- **关键定制**：fitness「单变量调整 / 安全红线」、nutrition「节食底线（低于基础代谢不给）」、wellness「渐进每周一档」、chef「备菜纪律 / 剩菜 48h」、home「样本间先行 / 维持成本优先」、parenting「今晚可试判据」、pet「拿不准就转（兽医）」、tutor「费曼验收」、language「纠错配额两处」、reading「输出要求（改变哪个判断）」、travel「留白纪律 / 官方渠道」、wealth「应急金前置 / 纪律而非标的」、coach「不替决定 + 危机红线」、life-admin「隐私纪律（证件号不进工作区）」、care-planner「非诊断边界 + 排松不排崩」、care-escort「只记录不解读」、elder-advisor「安全第一 + 改造复盘」、home-finder「打分透明 + 不制造焦虑」、mortgage-advisor「假设先行 + 完整性纪律」、reno-designer「预算优先 + 好住优先」、metaphysics 全体「先盘后论 + 表述克制 + 未工具化 / 近似口径显式声明 + 可复现参数」、astrology 全体「口径注明（orb / 宫位制）+ 挑战相位=课题 + 合盘知情前提 + 时间窗参考区间」、blank/general「单助手纪律 + 可验证交付」。
- **里程碑：check:agents 质量报告 114/114（100%）全达标**（六段齐备 114/114 + 正文达标 114/114）——专家级路线四批（W1 55 + W2 27 + W3 20 + W4 12）全量收口。
- **CI 门禁切换**：`.github/workflows/ci.yml` 的 agents job 启用 `QUALITY_STRICT=1`（未达标即失败）；`agents/README.md` 校验说明同步更新。
- 评测：check:agents **strict 退出码 0** ✅；eval **28/28 ✅**；mock-coverage + m29 定向 **15/15 ✅**。
- 后续（专家级路线余项）：P3 技能补齐（22 个低于 60 行规范）/ P4 场景协议深化（29 份补质量红线与失败模式）/ P6 评测扩展。

### v60 — Agent 专家级体系第二批：对抗 / 研讨 / 创作场景深化（W2 全量收口，20 角色）

- **动因**：专家级六段骨架体系（v56）继续推进——W2 余下 20 个角色升级（society 4 / gamedesign 4 / writing 4 / career 4 / brainstorm 4），**W2 全量 27 角色收口**（含 v56 已完成的 debate 4 / negotiation 3）。
- **升级模式**：每角色补写「专业判断」（硬规则）+「质量与自检」（核对清单 + 反模式）+ 协作接口补「交接品质标准」；front-matter 与交付契约路径文本零改动（受 mock-coverage / e2e 断言保护）。
- **关键定制**：fact-checker「同尺纪律」（对各方同一标准核查 / 修正公开）、stakeholder「代言纪律」（不虚构极端主张 / 匿名化）、policy-advisor「移植纪律」（国际经验注适用条件 / 区间四元组）、moderator「主持中立」（争议拆事实 / 价值两类）、game-designer「支柱裁决」与「循环先行」、balance-designer「拒绝魔数」、narrative-designer「咬合优先」（删不删以机制动机为准）、playtester「可测边界」（好玩是假设 / 小样本只出观察）、storyline「三问门槛」、author「语感先行」、editor「边界铁律」（改语言护内容 / 最小必要改动）、publisher「不可承诺」（版权只给方向性提示）、career-advisor「框架不拍板」（代价 / 概率 / 底线三件套）、resume-coach「真实红线」（优化 = 突出真实亮点 + 表达升级）、interview-coach「不代答」、comp-advisor「策略三要素」（目标 / 底线 / 交换）、facilitator「不做裁决者」（只调度不代劳）、ideator「手法交替 / 不评判 / 不炒冷饭」、challenger「修补即完成 / 强度分级」、refiner「冲突优先修正分数 / 合并留痕」。
- **评测**：check:agents 质量报告达标 **80/114（70%）**；eval **28/28 ✅**（零回归）；mock-coverage 4/4 ✅（交付件路径全量对齐）。
- **进度**：W1（55）+ W2（27）= **82 个业务角色全达标**；余下 W3 生活安居 23 / W4 命理占星 12（含 blank/general）→ 完成后切 `check:agents --strict` 门禁。

### v59 — 多 Agent 调度增强：路由简报 · 停滞抑制 · 写冲突防护 · 接单回执 · 调度指标（M61，引擎批次）

> 编号说明：v58 / ADR 0132 已由并发批次（头像统一圆角）占用，本批顺延 v59 / ADR 0133。

- **动因**：专家级路线的多 Agent 调度短板清单（D1–D7）——路由输入薄（仅最近 4 条 ×160 字符）、降级只到编制首位、循环检测无「实质进展」语义、并行写冲突只有协议约束、交接无闭环证据、调度无聚合指标。用户确认「全面实施 D1–D7」。**agents 资产零变更**（引擎 / 存储 / 指标 / 面板批次）。
- **D1 PRS v2**（platform-router + engine）：路由输入新增 `<session_state>` 简报（阶段 opening/ongoing + 最近接手者 + 已有交付件清单 ≤30 条 / 600 字符；空段不注入保持输入零差异）；输出 schema 增 `assignments[].mode`（execute/plan/review 软建议，白名单容错）；ROUTE_SYSTEM 增复杂度分级 / 去重 / 阶段三纪律；模式建议注入任务便条（「平台建议：先 write_plan…」；不强制切换范式）。
- **D2 阶段化派发**：提示词级「跨阶段只派第一阶段」纪律（接手方自行转交，不一次派全链）。
- **D3 实质进展停滞抑制**：新 `write-tracking.ts`（write_file/edit_file/apply_patch 成功动作 → 路径提取；apply_patch 从补丁头解析）+ `detectStall`（**同签名**两波零写动作 + 文本相似 >0.9 → 提前抑制，比内容级循环 4 波更早更准；多人轮转仍交内容级循环，职责不重叠）；`mergeWaveSchedule` 输入增 `waveWriteCounts?`（缺省不检测，既有调用零差异）、输出增 `stallSuppressed`（与 loopSuppressed 同走抑制路径，TraceDrawer 分开标注「停滞抑制」）。
- **D4 交接接单回执**：接收方消费交接便条即记 `handoff:accepted` trace（审计交接链闭环；纯观测）。
- **D5 并行写冲突防护**：波末两两路径重叠检测 → `wave:write-conflict` trace + 系统事件条（「并行写冲突提醒：X 与 Y 均修改了 <path>。请收敛方核对合并」；单成员波 / 无重叠零开销）。
- **D6 调度指标**：`RunEventStore.schedulingStats()` 聚合（路由 / 降级 / 波次 / 并行 / 循环抑制 / 停滞抑制 / 写冲突 / 接单）+ `GET /api/metrics/scheduling?sinceMs=` + 指标面板「调度健康」分区（summary 同窗并行拉取）。
- **D7 链路降级升级**：路由失败接手从「编制首位」升级为「场景链首」在场成员（`fallbackOrder`：按所属场景 chain 位置排序，未在链上者靠后；development chain 下 [backend, qa] 顺序与既有测试一致）。
- **测试与评测**：新增 `m61-dispatch.test.ts` 13 例（写目标提取 / detectStall 矩阵 / merge 集成 / mode 容错 / schedulingStats 聚合 / D5 引擎端到端）；m3 内容循环与 context 预算夹具按资产扩容上调（12k → 13.2k，与 M23→M29 惯例一致）；**eval 28/28 ✅**；client **876/876 ✅**（m9 面板窗口断言适配双端点）；server 定向（scheduler / m48 / m61 / m3 / context / run-events）全绿；**E2E 定向 6/6 ✅**（m48-routing ×2 / m16-parallel / m16-serial ×2 / m42-roundtable；新构建）。
- **归属说明**：server 全量余 7 个失败（m25-embed ×2 / m35 ×5）位于并发会话改动域（connections / routes/schedules.ts 未提交），非本批回归；本批引入的 2 处（m3 停滞判定交集 / context 预算）已修复清零。
- 相关文档：ADR 0133、design.md §84、docs/api.md（新端点）。

### v58 — 头像统一圆角：组件内置 25% 等比圆角 · 全站调用方去显式类（纯前端批次）

- **动因**：用户实测截图反馈（未选择会话欢迎页头像行，原话「**用圆角，所有的头像展示都需要用圆角**」）——欢迎页头像行（34 / 44px）呈直角方形；全量盘点 37 文件 62 处头像调用确认圆角形态漂移——无圆角 2 处（欢迎页头像行 / roundtable 迷你席位）、`rounded`（4px）、`rounded-md`（8px）、`rounded-lg`（10px）、`rounded-xl`（12px）、全圆（约 24 处）六种形态并存 + CSS 场景席位 `border-radius: 999px`。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **组件内置统一圆角（单一来源）**：`AgentAvatar` 根节点默认类内置 `rounded-[25%]`（等比圆角，任意尺寸圆润度一致：12px→3px / 34px→8.5px / 96px→24px；内部三层渲染沿用 `rounded-[inherit]` 继承；调用方 className 可覆盖）——圆角从「调用方自觉」改为「组件默认事实」，新增调用不再可能遗漏（欢迎页即此类缺失）。
- **调用方去显式类**：37 文件 62 处调用移除全部显式圆角类（`rounded` / `rounded-md` / `rounded-lg` / `rounded-xl` / `rounded-full`），`ring-*` 描边 / `shrink-0` / 动画类全部保留；CSS 场景席位（`.scene-sr-avatar` / `.scene-rt-mini-seat`）`999px → 25%` 对齐。
- **决策**：ADR 0132（修订 ADR 0013「调用方圆角裁切」口径）；design.md §10.6 / §19.2 / §19.5 口径同步。
- 评测：client 876/876 全绿（69 文件）；client typecheck 0 错误；正则核验全部头像调用零显式圆角残留；E2E 无头像类名选择器（零结构影响）。

### v57 — Markdown 卡片交互一致性增强 + 任务列表样式修复（报价复制 / 缺陷回填 / 派活回填 / 裁决复制 / 纪要复制 / GFM 任务列表样式，纯前端批次）

- **动因**：用户要求「交互上或前端展示、Markdown 扩展等优化展示」——全量盘点 16 类容器交互矩阵后确认五处缺口：报价卡读数无复制（谈判比价高频动作）、缺陷编号无回填入口（与配对机制脱节）、时间轴负责人无派活入口（与纪要待办不一致）、裁决卡零操作（决策收口无法引用）、纪要卡无复制（转发 / 存档靠手选）；另实测确认正文 GFM 任务列表（`- [ ]`，资产中 213 处使用）渲染为原生 disabled checkbox + 圆点双重符号、无样式适配。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **OfferCard**：值可点复制（与 KpiItem 同模式：1.6s 勾选反馈；`cursor: copy` + hover 底色）；`md-offer-value` span → button（保持类名与文本，样式 reset，CSS 兼容原视觉）。
- **FindingsCard**：点「缺陷 N」→ 回填「回应缺陷 N：」草稿（ADR 0064 只写草稿；发送后由配对机制点亮「已响应」，形成闭环）；流式禁用。
- **Timeline**：负责人 chip 可点 → 回填 `@负责人 `（与纪要待办派活同语义）；流式禁用。
- **VerdictCard**：卡头新增「复制裁决」（结构化 markdown：`《标题》（状态）` + 条目列表，便于转发 / 引用）；无 label/title 时 head 不渲染，`:empty` 兼容由 CSS 兜底（`.md-verdict > .md-verdict-body:first-child`）。
- **MinutesCard**：卡头新增「复制纪要」（markdown 分栏：标题 + 决议 / 待办 / 风险；未识别键归决议，与渲染同口径）。
- **任务列表（GFM `- [ ] / - [x]`）样式修复**：`li.task-list-item` 去圆点（list-none）+ 自定义 checkbox（13px 圆角描边；完成态主色填充 + 白勾）+ 完成项 muted 删除线——与 `::: checklist` 卡片同款状态标记；定位为**静态展示**（checkbox 表达内容声明的完成状态；可勾选 / 可回填的清单仍走 `::: checklist` 容器）。
- 评测：client 875+/875 全绿（本批新增 6 例：m43-cards +2 / markdown-ext +2 / m42-meeting +1 / markdown +1）；client typecheck 0 错误；ESLint 改动文件 0 错误；client build 通过；E2E 结构性断言全兼容（无类名与文本变更，定向回归 m42-roundtable / m43-pk / markdown-ext 7/7）。
- 相关文档：design.md §30（Markdown 渲染扩展）口径沿用；不改协议与角色资产。

### v56 — Agent 专家级体系：六段骨架标准 + 业务核心与对抗场景深化（生产级→专家级第一批）

- **动因**：用户要求「针对多 agent 相关和每一个 agent 进一步的分析和优化，将 agent 做到生产级、专业级、专家级程度，调度等亦然」——全量盘点确认：114 角色虽四段骨架齐备，但正文深度中位仅 785 字符、普遍缺「专业判断规则 / 质量自检 / 反模式」；据此确立专家级六段骨架标准并分批升级（方案：标准先行 + 全量分批 + 调度 D1–D7 全面实施）。
- **标准落地**：
  - `agents/README.md` 新增「正文规范：专家级六段骨架」——`## 职责`（末条固定职责边界）→ `## 专业判断`（3–5 条硬规则：阈值 / 取舍 / 分支）→ `## 工作方式`（SOP + 工具口径）→ `## 质量与自检`（交付前核对清单 + 反模式）→ `## 交付契约`（路径与 mock.ts 逐字一致 + 完成定义）→ `## 协作接口`（含交接品质标准）；正文目标 1200–2400 字符。
  - `check:agents` 新增专家级质量报告（六段齐备 + 正文 ≥1200 字符；默认报告模式，`--strict` / `QUALITY_STRICT=1` 切门禁——全量升级完成后切换为 CI 强制）。
- **角色升级（W1 业务核心 55 + W2 对抗场景 7，共 62 角色）**：development 13 / marketing 10 / sre 1 / bi 1 / invest 5 / finance 5 / strategy 4 / research 4 / sales 4 / ops 6 / funding 2 / debate 4 / negotiation 3。
- **升级模式**：每角色补写「专业判断」（如 pm 优先级三因子与范围变更三选一规则、backend 错误语义（越权统一 404）与幂等判据、sre SEV 分级与可逆优先、quant 过拟合红线与五件套门槛、legal 高风险置顶与措辞可粘贴、debate 裁决口径公开与证据门槛）+「质量与自检」（交付前核对清单 + 2–3 条反模式）+ 协作接口补「交接品质标准」；**front-matter 与交付契约路径文本零改动**（受 mock-coverage / e2e 测试断言保护）。
- **评测**：eval 28/28 ✅（mock；与基线零回归）；check:agents 质量报告达标 60/114（六段齐备 62/114，W1+W2 已完成部分全绿）；mock-coverage 4/4 ✅（交付件路径全量对齐）；server 定向测试（mock-coverage / m29-code-bindings）15/15 ✅。
- **后续批次**：W2 余下（society / gamedesign / writing / career / brainstorm 20 角色）→ W3 生活安居 23 → W4 命理占星 11 + blank → P3 技能补齐（22 个低于 60 行技能专家化）→ P4 场景协议深化（29 份补质量红线与失败模式）→ P5 调度增强 D1–D7 → P6 评测扩展与全量验收。

### v55 — 可玩盘面：四张排盘卡的交互化与参与式游戏化（M54，纯前端批次 + metaphysics 协议 #14 一条）

- **动因**：用户原话「不要只是简单的表格，可以增加交互和游戏性，让用户参与感更强」——M53 交付后四张盘（八字 / 紫微 / 星盘 / 卦）信息已专业化，但呈现仍是静态行渲染（`PanCard` 字段行 / `PanBoard` 静态行），阅读单向零交互；关键机会：盘面数据已全量在卡内且卡格式被契约测试（`m53-pan-card`）锁定——交互化可做到纯前端派生、零工具、零协议变更。本批按设计基线 `docs/pan-interactive-design.md`（947 行 v2）三分期一次收口：M54-A 基座 / M54-B 盘面 / M54-C 参与层。**agents 侧仅 metaphysics 协议 #14 一条**（M54-A / B 纯前端，本批一并登记）。
- **派生层与视图切换（M54-A）**：`model.ts` + `derive.ts` 从 `::: pan` 卡文本全量派生交互模型，必需门（八字 = 四柱 + 五行 + 日主 + ≥1 大运；紫微 = 12 宫全项）不过 → 回退静态表格（表格为回退终点，`PanCard` 不替换）；`PanView` 统一入口（kind 分发 + ErrorBoundary + Suspense——四盘板懒加载单 chunk，失败回退表格）；默认盘面 + 视图切换记忆 `ma:pn:view:<sid>:<mid>`（session）；流式期回退表格（半截卡不派生）。
- **四盘交互（M54-A / B）**：`BaziBoard`（四柱点看 / 五行能量 / 大运轨道 scrub / 流年条 / 请教草稿）；`ZiweiBoard`（4×4 宫格 / 三方四正 `.is-rel` / 大限巡游 `.is-current` / 四化双编码）；`GuaBoard`（装卦回放 / 变卦剧场 / 错·综预览 / 世应空亡 / 爻详情随选切换 / 无动爻禁用态）；`NatalWheel`（轮盘 10 行星 / 16 弦 / 12 宫 / ASC·MC 轴，行星浮标 + 详情、弦提示与中选、相位筛选 16 ⇄ 12、矩阵互跳）；键盘可达（行星 Enter / 矩阵方向键）+ reduced-motion 直出终态。
- **摇卦台与报数（M54-C）**：`TsToss`——公开仪式种子（crypto）+ `mulberry32(seed)` 现推六爻（与 `gua_pan`（method=coin）同源表逐位一致，单测断言）；存储 `ma:pn:toss` 只存 `{seed, question, done, startedAt}`（结果恒现推）；「以此卦请解」草稿携种子与 `gua_pan（method=coin，seed=…）` 参数入 Composer（不发送）；报数起卦页签草稿携两数与 `method=number`——不本地预测卦名（卦名唯一来源工具复算）。
- **档案 · 合参 · 研习足迹（M54-C）**：档案 `ma:pn:archive:<sessionId>`（聊天卡 ⭐ 与面板统一入口，上限 20 FIFO，本地私密不落库；同型盘差异高亮、异类盘仅并排）；时间轴合参 `Almanac`（统一年龄轴 0 → 两盘最晚终限，八字大运 × 紫微大限双泳道，出生年已知同轴标年份、缺失只显年龄；点选联动高亮 + 只读详情；面板头部「合参」toggle）；研习足迹 `ma:pn:trail:<sessionId>`（去重计数页脚只读小字，无任何成瘾机制——合规红线）。
- **协议 #14（metaphysics `_protocol.md`）**：新增「摇卦复算核对」——用户以摇卦台 / 报数起卦发来的草稿（含种子 / 两数）必须先经 `gua_pan` 复算，禁止直接采信草稿中的卦名与动爻结论；解读前复述本卦 / 变卦 / 动爻 / 世应并核对一致，不一致以工具结果纠正并说明（与第 9 条「起卦可复现」呼应）。
- **面板接入与 E2E（M54-C）**：`ChartboardPanel` / `PanBoard` 多盘 tabs；面板补合参 toggle 与档案抽屉；mock 新增触发词「盘面走查」（`PAN_TRIGGER`：bazi / ziwei 剧本追加可派生盘卡，E2E 固定剧本口径同 M37 checklist 先例）；E2E `m54-pan-interactive` 6 例（卦盘 / 星盘主路径 + reduced-motion + 键盘走查 + 摇卦台全链 + 面板双盘合参档案）。
- **收口期补强（同日）**：mock 盘卡对齐真实全格式（藏干 / 纳音 / 地势 / 胎元 / 命宫 + 10 流年——面板合参可全量派生）；E2E 补四盘主路径全覆盖 2 例（八字盘点柱详情（十神 / 藏干 / 纳音）+ 大运 scrub 空态补算；紫微盘点宫三方四正（设计 §7.8 口径②）+ 四化定位 + 大限巡游 + 请教草稿）——`m54-pan-interactive` 6 → 8 例；相邻回归 E2E 28/28 全绿（2.5m：`markdown-ext` 4 含盘面卡渲染 / `m52-stage` 22 场景工作区 / `m37-scene-chat` 2）。
- **视觉走查修复（收口后同日）**：临时 Playwright 走查 spec 全量复现（17 张截图：四盘桌面 / 详情 / 窄屏 + 参与层 + 面板 + 弹窗）→ 修复 2 项真实缺陷：① `TsToss` 摇卦台未 Portal 化——遮罩在消息虚拟列表行内被行 `transform` 封层（stacking context），实际层级 ≈ 0，被「波次条（z-30）/ 回到最新（z-20）」盖过并劫持点击（模态性破坏；`elementsFromPoint` 命中栈实证）→ `createPortal(mask, document.body)` + 组件测容器改 `baseElement`（8 例不变）；②「回到最新」胶囊 `justify-center` 居中线遮挡卡片底部操作区（窄屏「请教大运」按钮 / 表格回退态流年行实锤）→ 贴右下（`justify-end` + `pr-2`；m12 以 `title` 定位零改动）。走查另澄清 3 项为设计内行为（合参段截断 / 轨道横滚 / 足迹计数）不修。复验：走查复截零遮挡 + 定向 E2E 11/11（`m12-interactions` / `m37-scene-chat` / `m54-pan-interactive`）+ client 68 文件 / 866 全绿 + typecheck / ESLint 0 错误。
- **模态性深化修复（二次续完善，探针驱动）**：临时探针实测发现 2 项确凿缺陷 + 1 项设计缺口：① **Tab 焦点逃逸**（14 步实测 12 步逃出弹窗——自定义弹窗无焦点约束）；② **虚拟列表行回收卸载弹窗**（滚动 1800px 后 `.pn-toss` 消失、滚回不恢复——宿主在 `PanView` 消息行内，行被 `@tanstack/react-virtual` 回收即卸载；重开可恢复为存储兜底）；③ §5.1「chartboard 面板头部同按钮」未实现（面板无摇卦入口）。修复三位一体：**宿主提升**——`ui-store` 新增 `panToss` 请求态（`PanTossRequest {compare, sessionId}` + `openPanToss` / `closePanToss`），`TsToss` 宿主自消息行内上提为 AppLayout 级唯一 `PanTossHost`（overlays 区恒挂载，与任何局部卸载解耦；请解草稿仍走 `insertToComposer` 全局通道，成卦 / 请教程在宿主落账）；`trail.ts` 新增 `subscribeTrail` 订阅（宿主不在 PanView 内时的页脚跳组件刷新——E2E `摇卦 1 次` 断言链路保持）；**焦点约束**——`TsToss` 加轻量 trap（document `keydown` 捕获：Tab 首尾环回弹 / 焦点在台外拉入 + `focusin` 逃逸拉回；面板为 portal 末尾元素，浏览器无自然环回）；**面板入口补齐**——`ChartboardPanel` 头部「亲手摇卦」（`.pn-toss-enter` 独立类名免 `.pn-alm-toggle` 单元素定位冲突；首个可派生卦盘作对照基线，无卦盘 `compare=null` 也摇）。复验：探针复跑逃逸 **12/14 → 0/14**（Tab 全环在台内）、滚动 1800 前后与滚回 `.pn-toss` 恒为 1（小视口 900×560 / 窄屏 375 弹窗存续可测，截图 `data/m54w-small-*.png` / `m54w-narrow-done.png`）；`m54c-pan-toss` +1（Tab 首尾环回 + 逃逸拉回）/ 新建 `m54d-pan-toss-host` 3 例（请求驱动开合 / 请解草稿 + 请教足迹 / 对照快照 + 摇卦足迹 + 无会话降级）→ client 69 文件 / 870 全绿；E2E `m54-pan-interactive` 8/8（含面板摇卦入口新增断言）+ 相邻回归 28/28（`markdown-ext` / `m37-scene-chat` / `m52-stage`）；全仓 typecheck / ESLint 0 错误；client build 通过。
- 评测：eval 28/28 ✅（mock；含 metaphysics 3 回合；仅协议 #14 一条 agents 变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试全绿；client 68 文件 / 866 测试全绿（M54 专项 87 例：derive 25 / boards 33 / toss 8 / archive 11 / almanac 5 / diff 5；窗口内含并发批次合流）；全仓 typecheck 0 错误；ESLint 0 错误（既有 warning）；client build 通过（主包 `index-CjG-CB_G.js` 1,286.59 kB / gzip 354.98 kB；含并发批次合流，点记录）；E2E 定向 `m54-pan-interactive` 8/8 全绿（2.0m；四盘主路径全覆盖：M54-B 6 + M54-C 2）。
- 相关文档：ADR 0131、design.md §83、`docs/adr/README.md` 索引、`docs/pan-interactive-design.md` 头部实施落位注记（v3 收口；§8 / §9 预测编号更正；v3.2 走查修复补记；v3.3 模态性深化补记）、`docs/scene-expansion-design.md` 头部落地修订注记（M54）。

### v54 — roundtable 顶区重设计与汇聚板收起：俯视圆桌 · 横向步骤条 · 折叠 / 关闭（M59，纯前端批次）

- **动因**：用户实测截图反馈（三处红框：顶区席位环 + 议程清单 / 含状态字区域 / 议程列表特写）——roundtable（社会议题研讨）顶区「太丑了，专业的角度设计下」，明确否决上批纵向议程清单（原话「不要用这个列表」）；并质疑空面板（原话「还有空的面板？可以展示和收起」）。上批 M52-H（v51）「大环 + 纵向清单」设计被整体否定，本批重做顶区；「空面板」经核为用户所持 v50（M58）前版本——就绪判定（ADR 0127）已保证无数据不渲染（roundtable 无产物不渲染汇聚板），本批补全 roundtable 汇聚板收起能力。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **顶区卡片带（RoundtableStage）**：`.scene-rt-top` 由透明条带改浅灰圆角卡片带（`hsl(var(--muted) / 0.4)` + `border-radius 0.8rem` + 外留白）——席位环与议程步骤条同行居中，内容由卡片边界收束、与消息流分层；窄屏（column）沿用降级。
- **席位环 v3 俯视圆桌（SeatRing）**：重写为俯视圆桌——头像 26px / 环半径 40 / 实心桌面 56px（inset 描边）；名字**径向朝外四向锚定**（`data-dir` up / right / down / left + CSS 属性选择器；上下向左内居中、左右向侧边居中，越界省略），**去掉底色**，消除与桌面 / 头像交叉及「贴纸」感；发言席主色描边 + 外光环（双层 box-shadow）；席位盒 = 头像盒（M52-H 几何对位口径沿用），环容器 176 × 138 恰容纳四向名字。
- **议程横向步骤条 v3（AgendaTrack）**：纵向清单（v51 形态）整体替换为横向 stepper——节点三态（完成实心 / 进行中实心 + 光环 / 待办空心）+ 连线（随前步着色）+ 标签；状态字（已完成 / 进行中 / 待办）删除，状态语义由节点 / 标签 / 连线着色承担；摘要改贴卡片带右端（`margin-left auto` + 省略），不再逐行重复、不再铺满余宽。**连线连续性**：为消除「连线被标签空白切断成短划线」观感（浏览器实测甄别），连线实现为节点两侧半线（`::before` / `::after`）+ 相邻步骤间隙段 `scene-ag-link` 拼接（节点 `z-index` 盖线端、标签空白区由半线贯穿），done 段三段同色（含相邻选择器）；交互与断言面不变（`role` / `.scene-ag-*` / `[data-ag-heading]` / onPick 语义零改动）。
- **汇聚板折叠 / 关闭（RoundtableStage + persist）**：口径同 dock（ADR 0127）——`PanelChromeProvider` 注入折叠（ChevronRight）/ 关闭（X）钮到汇聚板标题行（窄屏抽屉不注入——抽屉自带收起）；折叠 → 34px rail（展开钮 + 竖标「汇聚板」）；关闭 → 浮动恢复胶囊（`.scene-rt-reopen`）；偏好 `ma:sc:rt`（`RtPref {collapsed, closed}`）localStorage 全局记忆（与 `ma:sc:dock` 同族）。
- **实现期修复一项**：`nameDir` 方位整体偏 90°——落位公式 `rotate(θ) translateY(−R)` 使 θ=−90 落位在正左（而非正上），页面方位角实为 θ − 90°（加偏移修正；修正后实测四向正确：上席名字在上 / 右席在右 / 下席在下 / 左席在左）。
- **测试**：`m52-stage.test.tsx` 新增「M59 汇聚板收起（折叠 / 展开 / 关闭 / 恢复）」1 例全链（折叠 → rail 且面板卸载 → 展开归位 → 关闭 → 胶囊恢复；含 `ma:sc:rt` 清理）；E2E 断言面零改动（`.scene-agenda` / `.scene-ag-step` / `[data-ag-heading]` 文案 / `.scene-seat-ring` / role 全保留）。
- **续修订（同日，用户实测反馈二轮）**：① **顶区内容组整体居中**（`.scene-rt-top` `justify-content: center`；议程不再撑满余宽——`flex: 1 → 0 1 auto`、摘要 `margin-left: auto → 0` 跟随步骤条构成连续居中组；实测 1600 两侧留白 72px = 72px / 1280 16px = 16px 对称）；② **摘要收缩优先级提高**（`flex-shrink: 99`，空间不足时摘要先让位、省略号）+ 步骤条轨道 `overflow: hidden` 兜底——修复中等宽度（1280）下「摘要与末步标签重叠」（轨道收缩后内容溢出绘制所致）；③ **顶区可收起/展开**：展开态右上角悬浮收起钮 → 单行迷你条（小头像堆叠 + 摘要 + 展开钮），`RtPref.topMini` 落 `ma:sc:rt`（旧值向后兼容）；窄屏迷你条保持单行；reduced-motion 收敛登记 `.scene-rt-top-toggle`。测试：m52-stage 57 例（新增顶区收起全链 1 例）；全量 client 68 文件 / 866 测试全绿；E2E 临时 spec 实测全链（顶区收起/展开 + 汇聚板折叠/展开/关闭/恢复 + 1600/1280 双宽度布局测量：零重叠 / 留白对称）15.6s 通过后清理。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 68 文件 / 866 测试全绿（本批新增 2 例：汇聚板收起 + 顶区收起全链；窗口内含并发批次增量）；client typecheck 0 错误；ESLint 0 错误（6 条既有 warning）；client build 通过（主包 gzip 350.87 kB；含并发批次合流，点记录）；E2E 定向 `m52-stage` + `m42-roundtable` 23/23 全绿（含会议全链「议题 4/4 · 已全部议决」回归）；视觉核验截图 `data/m59-vis-top-done.png` / `m59-vis-ring.png` / `m59-vis-full.png` / `m59-vis-rail.png` 等 6 张；续修订实测截图 `data/m59c-3-top.png`（居中）/ `m59c-5-top-mini.png`（迷你条）/ `m59c-6-top-1280.png`（中等宽度降级）。
- 相关文档：ADR 0130（0128 → Amended）、design.md §82、`docs/adr/README.md` 索引、`docs/scene-expansion-design.md` 头部修订注记。

### v53 — arena 席位发言流实时化与侧栏宽度自适应：双源接入 · clamp 宽度（M60，纯前端批次）

- **动因**：用户实测反馈——arena（辩论场 / 谈判桌）两侧席位发言流「不是实时展示的，等输出结束再展示」；「全屏展示时两侧太窄」（固定 164px 与宽宿主中轴失衡）。决策见 ADR 0129；设计落位 design.md §81。
- **双源接入**：`useSceneLiveMessages`（use-scene-data.ts）——与冻结通道 `useSceneMessages` 同构同节流（500ms）、仅移除流式冻结；ArenaStage 冻结 `messages`（裁决流 / 论断树 / 报价流 / 回合定位，零改动）与实时 `liveMessages`（SideFeed 两席）并存——实时仅限纯文本投影面，容器解析面半截不进派生（ADR 0114 口径不变）。
- **流式态表达**：SideFeed 条目 `data-streaming`（描边高亮 + `caret-blink` 闪烁光标，reduced-motion 关闭）；空正文 → 「发言中…」；首 delta 后 500ms 内入流、随发言增长，收束后去标记、条目保持。
- **宽度自适应**：`.scene-arena-side` 固定 `164px` → `width: clamp(164px, 20%, 280px)`——窄宿保底不变，宽宿（含全屏 / 大屏）随宿主按比例放宽、280px 封顶；窄屏（<900px）降级路径不变。
- **测试**：组件测 `m60-arena-live.test.tsx` 新建 3（流式即时入流 + 增量节流刷新 + 收束去标记 / 空正文占位 / 冻结面边界：流式 `::: claim` 不进论断树、收束后出现）；E2E `m52-stage.spec.ts` arena 用例 +2 断言（run 收束前侧栏 `data-streaming` 条目可见；宽度 = clamp(164px, 宿主 20%, 280px) 误差 <2px + 视口放宽随宿主变宽）。
- 评测：eval 28/28 ✅（mock；零资产 / 零协议变更）；check:agents 29 场景 / 114 角色 / 26 预设（零资产变更）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增）；client 65 文件 / 842 测试全绿（本批新增 1 文件 3 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（主包 `index-DU8GPVTx.js` 1,244.16 kB / gzip 354.02 kB；含并发批次合流，点记录）；E2E 定向 `m52-stage` + `m43-pk` 24/24 全绿（2.2m——含 arena 新断言与 m43 arena 回归）。
- 相关文档：ADR 0129、design.md §81、`docs/adr/README.md` 索引、`docs/scene-expansion-design.md` 头部修订注记。

### v52 — 多方 PK 范式：对决组 · 配对卡 · 判定卡与 arena 合流（M43，协议 / mock / 前端混合批次）

- **动因**：M37–M45「场景聊天体系」专项（`docs/scene-chat-design.md` §11）第四批「高阶交互范式」——把「对抗 / 博弈」实现为 **arena 形态（M52-A，ADR 0112）+ 协议容器族**，全量兑现 `docs/scene-expansion-design.md` §7.2 目标形态（对决组 PK-1 / 缺陷-修补配对卡 PK-2 / 评审判定卡 PK-3 / 裁决卡 PK-4 / 计分板 PK-5 + 中轴「裁决流 / 论断树 / 报价流」三面板）；决策见 ADR 0117–0119；编号让位：原规划 §58 / ADR 0075–0077 → 实际 §72 / ADR 0117–0119。
- **协议（agents 三份）**：debate 条款 13——`::: claim` 主张展开（论据挂证据）/ `::: findings` 缺陷-修补方向（**编号稳定 + 回应复用「缺陷 N」**，前端配对点亮）/ `::: verdict` 终局裁决容器（容器内不写 @）；negotiation 条款 11——`::: offer` 报价容器（字段行 + 报价流按数值自动对比让步幅度）+ `::: verdict` 复盘；brainstorm 条款 11——challenger `::: findings` + ideator / refiner 复用编号响应 + 收敛 `::: claim`。
- **容器族与卡片**：remark-ext 四 builder（`mdClaim` / `mdFindings` / `mdOffer` / `mdDebate`，条目统一转 `data-items`）+ 四卡——`ClaimCard`（主张 / 细节 / 论据树 + 点论据回填补证模板）/ `FindingsCard`（缺陷行三列 + 「N/M 已响应」派生点亮）/ `OfferCard`（`is-price` 报价行高亮）/ `DebateCard`（题面 + 双方立场）；fail-safe（未闭合容器无卡片壳 / 解析失败 raw 静态兜底 / 名严格匹配）。
- **PK 判定与对决布局**：`client/src/lib/pk.ts` 纯函数族（findings 行轻量解析 / 「缺陷 N」编号扫描（排除定义行）/ 已响应签名（MessageLookup 入参不跨层依赖 store，跨消息即时点亮）/ `duelSides` 分侧 / `duelPhaseOf` 阶段 / `duelTally` 计分 / `verdictTemplates` 四模板回填）；WaveGroup duel 变体（ADR 0118）——单行二栏（left / right 纵向堆叠）+ center 席居后 + 阶段徽章（立论 / 反驳 / 修补）+ `DuelMeter` 计分条（发言数 / 被响应数 vs 中轴）、不成立 / 窄屏降级普通并行组零回归；裁决卡（PK-4）——最新波且非运行中 → 四按钮（采纳「正」/ 采纳「反」/ 两案并保留 / 再来一轮）→ composerInsert 只写草稿不直发、运行中禁用；评审判定卡（PK-3）——`mode='review'` + `usePlanStore.reviews` 命中 → `ReviewVerdictCard`（verdict 徽章 pass / conditional / fail + target 引用 + findings + 证据计数；fail 附「关联步骤 / 计划已阻塞」状态联动）。
- **arena 中轴合流（ArenaStage）**：裁决流 `[data-verdict-flow]`（`::: verdict` 消息按时间投影 chips + 点击 `ctx.focus` 定位）/ 论断树 `[data-insight="claims"]`（claim 投影 ClaimTree + 论据回填）/ 报价流 `[data-insight="offers"]`（`offerAmount` 数值化 + 相邻 delta `is-down` / `is-up`）；回合轴与席位发言流照常并接收容器数据增强。
- **mock 剧本**：affirmative `::: claim`（三条论据挂证据与置信度）/ negative `::: findings`（三缺陷 + 修补方向）/ negotiator · counterpart `::: offer`（98 万 ↔ 68 万）/ judge `::: verdict 正方 辩论裁决（3 轮制）` / tactician `::: verdict 未成交 谈判复盘`；evidence 按「缺陷 1/2/3」逐条回补（配对全量点亮「3/3 已响应」）；`writePlanCall` 评审步骤（用户点名「评审」→ 三步计划 + `mode='review'` + `reviewSignal` 分支——m24 判定卡 E2E 链路同构）。
- **实施期修复两项**：① remark-ext finalize 补 `mdDebate` 分支（曾遗漏 → DebateCard 无 `data-items`，组件测甄别）；② `duelSides` 收窄「无站位成员不成对决」——姿态兜底曾将头脑风暴全员同波（facilitator / ideator / challenger / refiner）误判为对决（二栏拆散并行圆桌，`m16-brainstorm` 全量 E2E 甄别），修复后 `m16-brainstorm` / `m43-pk` / `m52-stage` 定向 25/25 全绿。
- **测试**：client `m43-pk.test.ts` 新建 16 + `m43-cards.test.tsx` 新建 19（+2 文件 35 例）；E2E `m43-pk.spec.ts` 新建 2（辩论场全链：对决组 → 配对卡「3/3 已响应」→ 裁决流 chip；谈判桌：报价卡 + 报价流 ↓30 万色标）+ `m24-plan.spec.ts` +1（规划带「评审」→ 批准执行 → PK-3 判定卡 `data-verdict=pass`）。
- 评测：eval 28/28 ✅（mock；三份协议变更走既有断言面，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设（协议更新三份）；check:skills 51；server 81 文件 / 1088 测试全绿（本批零净增）；client 63 文件 / 830 测试全绿（本批新增 2 文件 35 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（主包 gzip 350.45 kB；含并发批次 M52-G/H、M58 合流，点记录）；E2E 全量多轮账目 + 隔离复跑归因（批次外运行收束竞态）+ 标准环境收口复跑 8/8 全绿——详见 design.md §72.8。
- 相关文档：ADR 0117–0119、design.md §72、`docs/adr/README.md` 索引、`docs/scene-chat-design.md` §11 落位注记、`docs/scene-expansion-design.md` §7.2 / §7.9 注记。

### v51 — 席位环几何修正与议程清单化：头像精确落位 · 桌面坐沿 · 顶区左右平衡（M52-H，纯前端批次）

- **动因**：用户实测反馈（截图）——社会议题研讨（roundtable·pool）顶部区域「效果有问题」；浏览器实测测量确认四项缺陷：① 名字标签与虚线圆交叉不对称（顶席「尚真」深入圆内 14.3px、左右席临界相切 0.4px、底席在圆外 18px）；② 座位盒「头像 + 名字」整体居中定位 → 头像视觉中心偏高 8.3px（几何正圆却视觉偏心、圆穿左 / 右 / 下三个头像）；③ 底席「允中」名字下沿溢出 `scene-rt-top` 2.1px 被消息区覆盖；④ 宽屏（1600）顶区右侧 322px 全空（约 34% 宽度），议程条 23.6px 单行与 148px 席位环失衡。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **席位环几何修正（SeatRing）**：座位盒 = 头像盒（`64 × 30`，名字绝对定位不参与盒居中）——头像中心精确落位环周（回归测量 4 席半径 54±0.05 / 角度精确 0°/90°/180°/270°）；桌面由虚线圆环改**实心圆面**（`inset 38px` 半径 38 与头像内缘 39 相切坐沿，头像不再被弧线穿切）；名字绝对定位在头像下 2px、带底色（不与圆面交叉）；底席名字固定外溢约 13px 由顶区 `padding-bottom` 承接（不再被消息区覆盖）。
- **议程清单化（AgendaTrack）**：单行 chips（含 12px 连接线）改**纵向清单**——与席位环等高并排（align-stretch + 内部居中）、撑满余宽（宽屏右侧不再留白）；每步「状态点 + 标签 + 状态字（已完成 / 进行中 / 待办）」；竖向轨道线串联（端点收束首末点、单项隐藏）；长标签单行省略；点击语义（onPick 回填 / 定位）与 `.scene-ag-*` 类名、`[data-ag-heading]` 不变（测试面零改动）。
- **顶区布局**：`.scene-rt-top` align-items `center → stretch`、padding-bottom `0.2rem → 0.9rem`（承接名字外溢）、gap `1.1rem → 1rem`；窄屏（column）沿用；顶区高度 159 → 174.4px（+15px）。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 830 测试全绿（本批零新增测试——视觉几何面由既有 `.scene-seat-ring` / `.scene-ag-*` 断言与 E2E 走查覆盖；`m52-stage.test.tsx` + `m42-meeting.test.tsx` 67 例先行复跑全绿）；client typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（`index-ClLPFCs9.js` 1,233.68 kB / gzip 350.44 kB）；E2E `m52-stage` 22 例 + `m42-roundtable` 全绿（并发窗口实测）；视觉核验截图 `data/social-issue-ring-2p4x.png` / `data/social-issue-topreg-full-1p25x.png`。
- 相关文档：ADR 0128、design.md §80、`docs/scene-expansion-design.md` 头部修订注记、`docs/adr/README.md` 索引。

### v50 — 场景工作区就绪判定与面板标题合行：无数据不展示 · 折叠 / 关闭钮注入 · dock 拖拽增强（M58，纯前端批次）

- **动因**：用户实测截图（传统数术 dock·chartboard 八字盘面）——面板标题行（「盘面面板」+ 徽标）与右上角折叠 `>` / 关闭 `×` 分居两行；诉求原话「右侧面板 做成标题，放到 header 上，与关闭一行，整体优化设计i下，右侧面板没数据的时候可以先不展示，有内容之后在展示，并调整合理的宽度等，交互详细设计优化下」。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **无数据不展示（`panel-ready.ts` 新建）**：`panelReady(panel, { containers, verdicts, messages })` 纯函数六口径（chartboard = `::: pan` / pool = 结构化行或带标题容器 / versus = `::: verdict` / board = 成员标题或交付件 / console = 成员消息、管道列、交付件 / coach = `::: checklist`；口径「宁可多显示不可漏显示」——防「有数据但工作区不出现」）；`useScenePanelReady` hook（useSceneMessages 同源节流 + useMemo 派生 containersOf / verdictsOf）；SceneStage 接入——未就绪 `panel` 不下传：dock 直通纯对话流（`.scene-dock` 骨架零渲染）/ roundtable 无汇聚板 aside / 窄屏无抽屉；就绪自动出现（挂载即真实数据，无空态闪变）；closed 态尊重用户意图（有数据后显示 reopen 而非自动弹出）；组件级 PanelEmpty 保留为兜底（测试双层口径：宿主断言「不渲染」/ 组件断言「空态」）。
- **标题合行与面板壳收口**：`PanelChromeContext`（panels/chrome.tsx 新建）——宿主把折叠 / 关闭钮注入面板标题行（PanelShell 统一「图标 + 标题 + 徽标（贴左）+ 操作区右推」，`actions` prop 可覆盖）；`.scene-dock-bar` 独立操作条删除；滚动下沉至 `.scene-panel-body`（标题行固定 + border-bottom），右区 / 抽屉 / 汇聚板三宿主同构（`.scene-drawer-body` 改 overflow hidden 防双重滚动）；aside 入场动画 `scene-aside-in`（0.18s；quiet / reduced-motion 全关）。
- **dock 宽度与拖拽增强**：默认 340 → 360px、clamp 260–520 → 280–640px（persist.ts）；拖拽零 React 渲染（`widthRef` + `asideRef.current.style.width` 直改，抬手一次 commit 落态 + 落盘）；双击把手复位默认宽；把手键盘可达（← → 16px / Shift 48px、`role=separator` + aria-valuenow·min·max）；pointercancel 回滚起始宽（不落盘）；拖拽态 `.scene-dock-resizing`（全域 col-resize + 把手高亮 + user-select none）；卸载清理 body 光标 / 选择态。
- **测试**：`m52-stage.test.tsx` 46 → 55 例（SceneStage 宿主重写 4 → 6：无数据不渲染 / 有数据渲染 + 标题合行（`.scene-panel-actions` 双钮 + title）/ 窄屏有数据抽屉 / 窄屏无数据 / listMode；M52-B roundtable 汇聚板 1 → 2：有产物渲染 / 无产物不渲染；新增 `M58 panelReady` 六口径 6 例）；E2E `m52-stage` 22 例断言全面改写（约 20 处空态断言 → 「不渲染」）+ 两条有数据路径（窄屏 SRE 发消息 → 抽屉出现；融资资本发消息 → 工作区出现 → 标题行折叠 / 关闭钮 → 折叠竖条 → 展开 → 关闭 → 「显示工作区」恢复全链）；chartboard 无 E2E 有数据路径（mock 不触发 pan 工具调用）由单测覆盖。
- 评测：eval 28/28 零回归（mock；零 agents 资产变更，沿用基线）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 830 测试全绿（本批 m52-stage 净增 9 例）；typecheck 0 错误（client + e2e）；ESLint 改动文件 0 错误；client build 通过（E2E webServer 构建 + 单端口托管实测）；E2E `m52-stage` 22 + `m42-roundtable` 1 + `m34-invest` 3 = **26/26**（首轮 1 例 close 阶段 trace ENOENT（并发 test-results 写入环境噪声，断言全过），单跑复验通过）。
- 相关文档：ADR 0127、design.md §79（含 §66.2 修订注记）、`docs/scene-expansion-design.md` §7.2 / §7.3、`docs/adr/README.md` 索引（0112 → Amended）。

### v49 — 成员展示去重：标题栏头像组移除 · 输入条成员条席位让位（M52-G，纯前端批次）

- **动因**：用户实测截图（谈判 arena 场景）红框标注两处成员表达并追问「是不是重复了，且输入框中的有必要展示吗」——① ChatArea 标题栏右侧头像组（纯装饰无交互）；② 输入条上方成员条（M11 指挥台 chips）；叠加 M52 场景工作区体系（ADR 0112）落地后的 arena 席位卡 / roundtable 席位环（同载「点击 @ 召唤 + speaking/waiting 状态」），同一会话内成员三处重复表达。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **收口口径（用户选定「席位覆盖时隐藏」）**：标题栏头像组删除；输入条成员条在「场景席位已覆盖全员」时让位隐藏；stream / dock / 纯列表等无席位载体场景照常展示（成员入口不缺失）；窄屏 BottomMemberBar 与右栏 TeamPanel 不在本批范围。
- **实现**：`ChatArea` 删除 `participants.slice(0, 7)` 头像堆叠（注释留档）；`Composer` 新增 `poolHidden`（useMemo——参与者空 / listMode / fallback 不隐藏；roundtable 恒隐藏；arena 全员入席（left/right/center 并集）才隐藏；有未入席成员保留保证可见可召唤）；渲染条件仅加 `!poolHidden`，@ 菜单与插入链路零改动。
- **测试**：`composer.test.tsx` 新增 4 例（arena 全员入席隐藏但 @ 菜单可用 / 未入席成员保留 / stream 保留 / 纯列表恢复）。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 63 文件 / 820 测试全绿（本批新增 4 例；窗口内含并发批次增量）；全仓 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；client build 通过（本批窗口产物 `index-fBAX0Wfp.js` 1,231.13 kB；dist 窗口内后随并发批次重建，数值仅作点记录）；E2E `m52-stage` 22 例 + `m43-pk` 2 例 24/24 全绿（2.2m）；视觉核验截图 `data/m52g-negotiation-arena.png`（标题栏头像组消失 / 成员条让位 / 三张席位卡保留）。
- 相关文档：ADR 0126、design.md §78、`docs/adr/README.md` 索引。

### v48 — 交付清单分层默认：最终交付优先 · 过程产物折叠 · 整体可收起（M37-6 续修订，纯前端批次）

- **动因**：用户实测截图反馈——投资研究会话收尾卡「本轮交付 14 件」8 行展示中 12 件为 `charts/` 行情快照，2 份 docs/ 结论报告被淹没，底部「还有 N 件 · 打开交付件面板查看全部」虚线按钮语义不清（全展示还是跳面板？）；诉求：默认只展示最终交付（最重要的几个文件），其余收进「其他」组，组头即箭头开关（全展示 / 收起）；续修（用户二次反馈「是整个都可以收起隐藏」）：整清单亦可整体收起，收起后仅留概要行与快捷继续。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **分层口径（`client/src/lib/delivery.ts` 新建）**：过程产物判定 = 路径首段命中 `charts` / `data` / `raw` / `cache` / `tmp` / `temp` / `logs`（`charts/` 为金融行情与博弈快照落盘约定；实测 `*.json` 快照 kind=code 与源码同 kind 不可分，故不用 kind 判定）；重要度分层 = 文档（md/office/pdf）> 图示与页面（html/mmd）> 媒体 > 源码文本 > 数据（csv/json）；`partitionDelivery` 纯函数——非过程产物按（层级，原序）稳定排序取前 5 为主区，其余（过程产物 + 溢出）进「其他」。
- **卡片形态（CloseoutCard）**：主区分组渲染（`data-delivery-group="primary"`）；「其他 · N 件」组头即箭头开关（ChevronRight rotate-90 / `aria-expanded` / `data-delivery-toggle`），全展示与收起双向切换；折叠态 `null = 未操作`（默认口径：有最终交付则折叠、主区为空自动展开——卡片不空），新尾条（指纹变化）重置；原「≤8 行 + 还有 N 件」形态撤销，面板入口收敛为头部 PackageOpen 按钮；`data-delivery-row` 锚点不变（既有 E2E 断言沿用）。
- **整体折叠（续修）**：头部左簇（图标 + 标题 + 件数 + 波次 + ChevronRight）即整体开关（`data-delivery-collapse` / `aria-expanded`）——收起后隐藏全部文件行（主区 + 「其他」组），仅留概要行与底部快捷继续；与「其他」组相互独立（整体收起再展开，「其他」保持原状态）；默认展开、新尾条重置。
- **测试**：`delivery.test.ts` 新建 6 例（过程产物判定含嵌套目录与 docs/charts 反例 / 重要度分层 / 分层稳定排序与上限 / 溢出顺序 / 默认上限 5 / 全过程产物边界）；`closeout.test.tsx` 相关 3 例重写 + 整体折叠 1 例新增（共 8 例：分层默认 13 件 = 5 主区 + 8 折叠，箭头全展示·收起双向 / 重要度排序与过程目录折叠 / 全为过程产物自动展开 / 整体折叠与「其他」状态保留）。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；client 全量 63 文件 / 830 测试全绿（本批新增：delivery 6 例 + closeout 净增 3 例（5→8）；全量首跑曾遇 3 例 SessionList 超时（m16-frontend ×2 / opc-frontend ×1）为并发负载假失败——隔离复跑 42/42 全绿；窗口含并发批次增量）；client typecheck 0 错误；ESLint 改动文件 0 错误；client build 通过（主包 gzip 350.44 kB，`index-ClLPFCs9.js` 含本批全部锚点；重建前先在临时 outDir 做零干扰构建验证，窗口腾出后正式重建）；E2E `m37-scene-chat` 两轮复跑全绿（分层默认后 2 例 19.6s / 整体折叠后 2 例 17.2s——均在并发 run 窗口间隙以临时隔离配置（独立端口 8791 / 8793 + 独立 data + 不 build 复用 dist + 独立 outputDir）单点复跑，清单卡断言 `[data-delivery-row]` 首行可见零回归；跑毕清理临时配置）。
- 相关文档：ADR 0123、design.md §52.4 续修订、`docs/scene-chat-design.md` §5.4 / §5.5、`docs/adr/README.md` 索引（0092 → Amended）。

### v47 — 媒体生成迁入设置——全局连接 · IA 收口（M56，服务端 / 前端混合批次）

- **动因**：用户实测反馈（截图）——「连接管理 → 新建连接」出现媒体生成类型（ComfyUI / SD WebUI / OpenAI 兼容 / 任务模板）不合理（「这些应该放在设置里面，而不是连接管理」）；根因是 M31 起媒体连接沿用**会话绑定**语义（「连接管理建 → 会话绑定 → 才能生成」三跳），与「连接管理 = 按会话授予外部系统凭据」的心智（ADR 0042）冲突；媒体生成本质是**全局能力配置**（对齐 M25 embedding 先例：全局共享 / 不参与会话绑定 / 设置中启用）。**agents 资产零变更**（分批登记纪律照记）。
- **服务端全局化**：`MediaService.providersOf()` 无参（全局启用连接清单；生成面板与工具共用）；`resolveConnection(connectionId?, capability)` 在全局启用连接中解析（缺省取首个启用；未配置引导「请到「设置 → 媒体生成」创建并启用连接」/ 指定 id 不可用「指定的媒体连接不存在或未启用」）；`GET /media/providers` 去 sessionId；绑定守卫 media → `400`（与 embedding 守卫同构相邻）；画布 `mediaBound` 改全局语义（全局存在启用中的媒体连接）；Agent 媒体工具（media_generate / media_video）引导文案同步。
- **客户端 IA 收口**：新建 `settings/MediaConnectionsSection`（清单 / 新建 / 编辑 / 测试 / 删除 / 启用开关；设置页分组 +1 共 9 组；计数「已配置 N 个连接 · 启用即全场景可用（无需会话绑定）」）；`ConnectionsConsole` 媒体全量移除（清单过滤 / 新建 chips / 绑定按钮；+11/-299 行）；`GenerationPanel` 空态引导与铅笔直达编辑改跳「设置 → 媒体生成」（`settingsFocus('media')` + `pendingEditId` 直达编辑消费迁移）；`media-store` 去 sessionId；`canvas-store` mediaBound 全局口径。
- 评测：eval 28/28 ✅（mock；零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试、client 63 文件 / 816 测试全绿（复跑快照；本批面 = m31-media / m31-tools 改写 + m25-embed +1 例 + m36-frontend +3 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 348.90 kB；窗口点记录，含并发批次增量）；E2E `m25-memory` 2/2 全绿（首轮 1 例 trace ENOENT 录制噪声（并发 test-results 争用），复跑干净）；client 全量复跑首轮另遇 m48 / m50 组队台 3 例满载超时波动（未改动面），隔离复跑与全套件复跑均全绿。
- 相关文档：ADR 0124、design.md §76（含历史章节修订注记：§49.3 / §51.3）、`docs/adr/README.md` 索引、`docs/api.md` §11 / §16。

### v46 — 裁决条目多空侧归因：翻盘条件归败方 · 阵营词归各方 · 方向兜底（M52-F，纯前端批次）

- **动因**：用户实测追问「多方无数据？」——v44（M52-E）修复裁决状态容错后，投资研究（dock·versus）多空对弈会话（真实裁决 `::: verdict 空方领先`）局面头与空方列已有数据，多方列仍恒「暂无信号」；根因是信号列归因「按裁决方向整列倾泻」（short 裁决时全部非元条目进空方列，多方列仅「多方胜裁决」才会有数据），而条目本身有方向语义——「翻盘条件」= 败方翻盘路径（真实会话该条目内容全为多方条件：周线站上 1355 / 站上 1292 / 底背离 / 公告利好；mock 对称：多方领先裁决的翻盘条件为空方条件）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **条目归因（lib/verdict 扩展）**：`verdictItemSide(label, status)` → long | short | draw | meta——元信息（胜负 / 置信度 / 声明 前缀）→ meta（v44 口径延续）；显式阵营词（多方 / 多头 / 正方 / 看多 ↔ long；空方 / 空头 / 反方 / 看空 ↔ short）**优先**；「翻盘条件」→ 败方（空方领先归多方、多方领先归空方、僵持归中立区、none 归 meta）；其余条目 → 裁决方向侧；none → meta（不进信号列，裁决卡全量兜底）；`META_LABEL_RE` 由面板迁入本模块（单一事实来源）。
- **面板分列（VersusPanel）**：`buildModel` 信号列构造由整列倾泻改为逐条归因分侧（`signalRowsOf` 移除）；跨轮累计口径不变（每轮裁决按各自方向归因）；效果：两列不再恒空——真实数据多方 1 条（翻盘条件）/ 空方 2 条（核心依据 + 空方失效条件），mock 多方 1 条 / 空方 1 条；「暂无信号」空态仅在该侧确无条目时出现。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1088 测试、client 61 文件 / 785 测试全绿（本批更新 1 例 + 新增 2 例；窗口内含并发批次增量）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（server tsup；主包 gzip 349.35 kB，并发窗口含 M54 增量，仅作点记录）；E2E `m34-invest` 3 例 + `m52-stage` 22 例 25/25 全绿（56.2s；首轮 1 例 close 阶段 trace ENOENT 为并发 test-results 争用环境噪声——断言全过、截图实锤交付件齐全；窗口内有并发多轮 run 无法独占，以临时隔离配置（独立端口 / data / workspace / outputDir）复跑全绿，跑毕清理临时配置与构建产物）。
- 相关文档：ADR 0122、design.md §74、`docs/adr/README.md` 索引。

### v45 — 模型输出净化与落盘声明审计：仿写日志块剥离 · 协议标记泄漏清理 · 双端兜底（M55，服务端 / 前端 / 共享层混合批次）

- **动因**：用户实测截图反馈「工具调用展示有问题」——聊天气泡出现 `[工具调用]` 文本块、`ziwei_pan({...})` 原始 JSON 参数与「紫微排盘完成」摘要；会话存档实锤 ziwei 消息 tool_calls 为空、run 事件零工具调用，正文却「记录」了调用（模型仿写上下文投影格式：`server/src/context/assembler.ts` 注入的 `[工具调用]\n- 名称(参数) → 摘要`）；同会话另一条消息两处声称 write_file「已写入 3.9KB」且无任何成功写调用（编造落盘声明），并泄漏全角竖线包裹的 `｜｜DSML｜｜` 协议标记——M53 已立「记录真实性」prompt 红线（§68 / ADR 0113），实测不可靠，需代码级兜底。**agents 资产零变更**（协议红线沿用 M53 条款，分批登记纪律照记）。
- **净化函数（shared）**：新建 `shared/src/sanitize.ts`——`sanitizeModelText`（规则宁窄勿宽 · 半截流式安全 · 幂等：① `[工具调用]` 独立行 + 后续连续空行 / 列表行 / 缩进续行序列，仅当含 ≥1 条带箭头（→ / -> / =>）日志行时整块删除；无日志行 = 流式半截保持原文，待补齐整体命中；无标题行时单靠箭头不剥离；② 协议标记行整行删除（半截不匹配待补齐）；③ 空行归一 + 尾部空白去除；无命中快速短路）+ `extractDeliveredPaths`（完成态声明锚 + 60 字符窗口路径提取去重，仅供审计）。
- **服务端收尾净化与审计（engine）**：`sanitizeAndAudit`（幂等）挂 6 处收尾点——executeTurn 的 parseMentions 前（仿写块内可能出现伪 @ 交还标记）与 catch 开头、finishTurn（波级收尾）、续写 / 重生成完成、异常 / 中断 catch 两处——内存对象即净 → 落库 / FTS / 记忆沉淀 / 下一回合装配全干净（防模型看到自己脏文本自我强化）；命中 trace `content:sanitized`（before/after 字符数）；落盘声明文件名 vs 成功写调用（status=ok 的 args.path / args.output）不符 → trace `delivery:unverified` + warn 留痕（不阻断、不改正文）。
- **前端展示兜底（session-store）**：toStores（加载 / 全量刷新）与 upsertMessage 对 role=agent 净化（存量消息历史回看直接干净，不动数据库）；流式 appendDelta 保留原始累积缓冲（rawStreams）对「原始全文」求净化写回 content（若对已净化文本增量拼接，块内后续日志行会失去标题锚点成为孤行）；turn:start（续写 / 重生成复用消息 id）重置缓冲、回合收尾释放、会话切换清空；用户消息豁免（引用系统格式属正常输入）；消息气泡 / 画布舞台 / 侧栏发言流等全部 store 消费方一致受益。
- **测试**：`server/tests/m55-sanitize.test.ts` 9 例（真实样本：ziwei 编造调用记录 / bazi 协议标记泄漏；含半截保持、幂等、零拷贝、声明提取）+ `client/tests/m55-sanitize.test.ts` 5 例（跨分片块剥离与孤行回归 / 协议标记补齐 / 用户豁免 / 存量 upsert / 重生成缓冲重置）。
- 评测：eval 28/28 ✅（agents 资产零变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 81 文件 / 1087 测试、client 62 文件 / 790 测试全绿（本批新增：server 9 例 + client 5 例）；全仓 typecheck 0 错误；改动文件 ESLint 0 错误；client build 通过（主包 gzip 347.11 kB；构建窗口含并发 M54 中间状态，数值仅作点记录）；E2E：全量 71/76——本批主链路 relay / reload / interject 等全绿，stop 隔离复跑 26.4s 通过；失败 5 例（m54-pan-interactive ×3 / right-panel / stop 长跑）中，前两文件为运行窗口内被并发开发中的 M54 批次修改 + trace ENOENT / 浏览器会话关闭等基础设施抖动，判定非本批回归。
- 相关文档：ADR 0125、design.md §77、`docs/adr/README.md` 索引。

### v44 — 裁决状态容错与局势面板局面头——自然语言前缀 · 置信度加权 · 元条目剔除（M52-E，纯前端批次）

- **动因**：用户实测反馈（截图）——投资研究（dock·versus）多空对弈会话出现「面板上方多方 0 / 空方 0 / 暂无信号，下方裁决卡完整」的割裂；根因是裁决容器首参数的**自然语言首词**（真实模型输出 `::: verdict 空方领先`，会话存档实锤）未命中精确状态词表（多方 / 空方 / 僵持）→ 派生层判 none → 全部条目被丢弃（不落任何列）；即使命中，面板也缺「胜负 / 置信度」一等公民表达、局势条只看条目数差（多数场景全偏 ±100）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **裁决状态容错（lib/verdict 单一事实来源）**：新建 `client/src/lib/verdict.ts`——`matchVerdictStatus`（精确或前缀命中：「空方领先」「多方占优」→ 对应状态；正反方同构）/ `parseVerdictArg`（非标准首词无剩余标题 → 保留原文为标题）/ `verdictStatusFromItems`（条目「胜负」值前缀兜底）/ `verdictConfidenceOf`（显式百分比直取；定性词低 30 / 中 60 / 高 80 仅驱动幅度、展示保留原词）；`scene/derive.ts` 与 `md-ext/remark-ext.ts` 镜像面同口径接入（后者本地 `VERDICT_STATUS_MAP` / `VerdictStatus` 移除）；未知首词仍降级无状态标题卡（零回归）；ArenaStage 裁决流 / WaveGroup 对决徽章自动受益。
- **局势面板信息架构**：局面头（胜负「多方领先 / 空方领先 / 僵持」+ 置信度 chip；色板同 md-verdict 族）+ 局势条改「方向 × 置信度」加权（§7.6 置信度聚合口径；无置信度条目满偏兜底）+ 信号列剔除元信息条目（胜负 / 置信度 / 声明——面板头 / 裁决卡 / 信号列不再三处重复）。
- 评测：eval 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 80 文件 / 1078 测试、client 60 文件 / 767 测试全绿（本批新增：`m52-stage.test.tsx` +2 / `markdown-ext.test.tsx` +1）；四包 typecheck 0 错误；ESLint 0 错误（本批引入的 1 条 warning 修复后）；build 通过（主包 gzip 346.50 kB；较 v43 收尾 335.05 kB +11.45 kB 含中间批次增量，本批为容错面 + 局面头 + 置信度映射净增）；E2E `m34-invest` 3 例 + `m52-stage` 22 例 25/25 全绿（含对弈用例新局面头断言；首轮残留旧 server / 并发 artifacts 环境噪声清场后复跑全绿）。
- 相关文档：ADR 0121、design.md §73、`docs/adr/README.md` 索引。

### v43 — 圆桌会议范式：会议容器族 · 议题进度容器化 · 派活确认制 · 纪要 @ 转交豁免（M42，协议 / 引擎 / 前端混合批次）

- **动因**：M37–M45 专项（`docs/scene-chat-design.md §10`）圆桌会议范式（RT-1..RT-5）实施——M52-A 已交付 roundtable 形态但议程仅有波次进度，会议语义（声明 / 推进 / 收尾 / 派活）无承载；实施中甄别出引擎侧语义缺陷：`parseMentions` 把 `::: minutes` 待办行的 `@负责人`（派活锚点）当作即时应答转交 → owner 重新入队、波次外扩（brainstorm 例会实测 5 → 8 波，eval `turns_lte 5` 失败）——非 mock 专属（真实模型按协议输出同构待办同样触发）。
- **协议更新（agents/）**：`strategy/_protocol.md` 条款 8（例会纪律：chief 开场输出 `::: meeting <标题>` 并逐字列出议题；成员完成本人议题后在发言尾以 `- [x] <议题原文>` 回标；末位回交主持人）+ 条款 9（纪要收尾：`::: minutes` 三栏——决议 / 待办 / 风险；待办行 `- 待办 | @负责人 事项` 的 @ 是派活锚点、**不构成即时应答转交**；收尾发言需另行单独一行给出转交，议毕即 `@用户` 交还）；`brainstorm/_protocol.md` 新增「圆桌例会纪律」8 / 9 / 10（facilitator 开场声明与阶段顺序 / 纪要三栏与派活锚点 / 回标不抢跑）；两侧交付段补「两会卡是消息内呈现，纪要卡不代替落盘」。
- **容器族与卡片（前端）**：`::: meeting`（标题 + `- [x]/[>]/-` 三态议题）/ `::: minutes`（`- 键 | 值` 三栏纪要，未知键归决议）remark-ext builder + `MeetingCard` / `MinutesCard`；fail-safe（未闭合无卡片壳 / 解析失败 raw 兜底）；议题进度容器化（`lib/meeting.ts` 纯函数族 + 本地勾选 store `ma:meeting:<sid>`；`RoundtableStage` 容器合并驱动「议题 x/n · 当前：XXX」/「已全部议决」+ 点击定位；无容器回退波次驱动零回归）；派活确认制（待办 @ 回填 `@负责人 ` 草稿，ADR 0064）；散会胶囊（尾条指纹派生，运行收束后静态展示）。
- **引擎语义（ADR 0116）**：`parser.ts` 新增 `stripMinutesBlocks`（与 remark-ext 容器正则同源、栈式深度匹配、未闭合 fail-safe 不剥离）——`parseMentions` 先剥离再解析成员提及与「交还用户」判定（返回 `text` 仍为原文，渲染 / 存档零感知）；仅豁免 minutes 容器，其余容器内文本照常解析。
- **mock 链路**：`MEETING_TRIGGER='例会'` + 主持人在场（chief 优先，其次 facilitator）→ 开场声明（`::: meeting` 四议题）→ 成员逐项回标 → 全体议毕回交主持人（「请主持收尾并出纪要」）→ 主持人收尾（minutes 三栏 + 自议题回标 + `@用户` 交还）；首 / 收尾判定走请求历史扫描去重（不依赖 spokenTimes）；eval 13 `opc-weekly-review`（turns_lte 5 临界 / 交还用户 / 无循环）同构。
- 评测：mock 28/28 ✅（含 13 临界 5 回合）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 78 文件 / 1067 测试、client 57 文件 / 703 测试全绿（本批新增：`parser.test.ts` +4 / `m42-meeting.test.ts` 新建 3 例 / `m42-meeting.test.tsx` 新建 21 例 / `m52-stage.test.tsx` +3 / `markdown-ext.test.tsx` +2）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 335.05 kB，较 v42 收尾 332.61 kB +2.44 kB = 会议卡族 + 进度容器化 + 散会胶囊净增）；全量 E2E 69/69 全绿（7.7m；新增 `m42-roundtable.spec.ts` 13.8s）。
- 相关文档：ADR 0115 / 0116、design.md §71、`docs/adr/README.md` 索引、`docs/scene-chat-design.md §10` 落位注记。

### v42 — arena 席位发言流 · 运行中回合号回填 · 贴底跟随末端锚定 · 运行流订阅晚到兜底（M52-D，纯前端批次）

- **动因**：用户实测反馈「辩论两侧是空的」——arena v1（ADR 0112）左右席仅席位卡、两侧留白，`docs/scene-expansion-design.md §7.2` 目标形态「左 = 左席发言流 / 右 = 右席发言流」未兑现；同期三处实时性缺陷：① 运行中回合号缺省（计分板「未开赛」/ 回合轴不动 / 发言流无轮次徽标，刷新才恢复）；② 贴底跟随被虚拟列表测量调整打断（流式收尾后视口偶停「距底几百像素」/ 误离底翻转）；③ 运行流订阅晚到（短 Run 高负载下 attach 跑输 Run 生命周期 → `/api/runs/:id/stream` 404 → 事件链整体缺失、UI 永停过期快照——全量 E2E 甄别出的**产品缺陷**，真实用户弱机 / 高负载同样可复现）。**agents 资产零变更**（纯前端批次，分批登记纪律照记）。
- **席位发言流投影（SideFeed）**：arena 左右席卡片下栏——该席成员消息投影为条目（最新在上 + 轮次徽标「第 N 轮」+ `excerptOf` 摘录 + 点击定位原消息 + 空态「该席发言将显示在这里」）；投影而非拆流（复用 `useSceneMessages` 500ms 节流 + 流式冻结），不复制数据层、不触虚拟列表结构键契约；零编制席位栏保持空；窄屏沿用单流 + 席位横条降级。
- **运行中回合号回填**：`run-store` 的 `turn:start` 归约回填 `event.turnIndex`（服务端 / 重放路径本就同口径，仅归约层缺失）——计分板 / 回合轴 / 发言流轮次 / M16 并行成组运行中即推进，不再等 run:end 全量刷新。
- **贴底跟随末端锚定**：虚拟化器启用 `anchorTo:'end'` + `followOnAppend` + `scrollEndThreshold`（库层按总量差补偿，不产生瞬时 gap）；手写补正层（多帧 rAF + `ResizeObserver` + `pinnedTopRef` 回声守卫）降为兜底；容器 `[overflow-anchor:none]` 消解浏览器原生滚动锚定竞争——流式收尾 / 收尾清单撑高后视口稳定贴底。
- **运行流订阅晚到兜底**（产品缺陷修复）：补全 `sse.ts` 既有契约（「404 交由调用方刷新会话兜底」）——HTTP 非 ok 且未见 `run:end`（闭包 `sawEnd`）且非主动取消（本流 controller 未 abort）时，走 `run:end` 同一口径本地收尾（`endRunLocally`：全量刷新 + 运行态清理；不伪造 `lastEndReason`）；「200 流异常自然结束」保持旧行为（真实链路 run:end 必达；vitest 镜像面「200 + 非 SSE 体」不误触发）。
- **E2E 口径与基建**：断言「流上方」文本先滚入渲染窗口（虚拟剪枝为正确行为；reload 走「滚顶 + 短断言」重试）；`m16-members` 邀请链路移出运行收束窗口（落库时序 +3.0s → ~+1.1s）；`playwright.config.ts` mock 节奏 `LLM_MOCK_DELAY_MS` 20→30ms/片（整轮 ~3.2s→~4.8s，系统性放宽运行收束竞态窗口；对等待式断言无影响）。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 677 测试（本批新增：run-events 5 例 / m52-stage SideFeed 4 例）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 332.61 kB，较 M52-C 收尾 +0.30 kB = SideFeed + 兜底 + 回合号回填净增）；全量 E2E 六轮收口至 68/68 全绿（第五轮 7.3m；兜底收窄复验后第六轮 7.5m——账目见 design.md §70.6）。
- 相关文档：ADR 0114、design.md §70、`docs/adr/README.md` 索引。

### v41 — 既有场景接入：14 场景 stage 声明合入（M52-C，声明 / 验证批次）

- **动因**：M52-A 框架（§66）与 M52-B 点亮（§67）后，M51 既有 14 个场景（研讨 3 / 工作 6 / 生活 5）仍以 stream 形态运行——工作区收益未覆盖既有场景；本批按 `docs/scene-expansion-design.md §7.10` 逐场景接入，**零资产改动原则**（仅追加 `stage` 声明，不新增角色 / 技能 / 预设 / 协议）。**agents 资产零变更**（分批登记纪律照记）。
- **声明合入（14/14）**：C1 研讨域 `brainstorm` / `research` / `strategy`（roundtable·pool ×3，与 society 共用形态与面板）；C2 工作域 `sre` / `bi` / `marketing` / `sales` / `funding`（dock·console ×5）+ `invest`（dock·versus ×1）；C3 生活域 `health` / `learning` / `travel` / `wealth` / `personal`（dock·coach ×5）。至此 29 场景中 24 场景已声明，仅余 stream 四场景（development / finance / ops / home）零改动。
- **镜像面断言**：`m21.test.ts` 新增「M52-C 既有场景接入：14 场景声明合入」分组逐字段断言 + 全量总账（24 组已声明）；「stream 四场景缺省」断言同步。
- **E2E**：`e2e/m52-stage.spec.ts` 7 → 22 例（+15）：C1 ×3（席位环 4/4/3 席 + 议程 + 汇聚板）/ C2 ×6（console 五场景 + invest versus）/ C3 ×5（coach 五场景）/ roundtable 窄屏（席位横条 + 抽屉）。
- **逐场景细化（补 §67.2 遗留，收尾补办）**：面板空态文案逐场景化——board ×3（gamedesign「设计文档与数值表」/ writing「文稿结构与版本」/ housing「方案对比与预算测算」）+ coach ×7（health「打卡与周计划」/ learning「学习路径与打卡」/ travel「行程与预算」/ wealth「预算与目标进度」/ personal「事务清单与提醒」/ career「求职进度与产出物」/ care「照护排班与清单」），未收录场景均落中性默认；coach 内容区兜底标题同步场景化（checklist 容器无标题时按场景落「打卡 / 学习 / 行程 / 目标 / 事务 / 求职 / 照护清单」，未收录场景落中性「清单」）；组件测试补相应空态 / 兜底覆盖（`m52-stage.test.tsx` +5 → 34 例）；E2E 六处 coach 空态断言随场景语汇同步（用例数不变）。**测试覆盖补缺（收尾续办）**：面板内容态组件测试补齐——console 空态（原零覆盖）与管道/时间轴、board 目录树/版本线、versus 多空列/裁决卡、chartboard 盘面 tabs（`m52-stage.test.tsx` +5 → 39 例），兜底标题断言扩为 7 场景全轮询。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1056 测试（m21 +1）、client 56 文件 / 660 测试（细化后 673，含并发会话增量；本批净 +10）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 331.29 kB，较 M52-B +0.39 kB 系并发会话 client 改动所致，本批零 src 变更）；E2E `m52-stage.spec.ts` 22/22 全绿（14 场景 + 窄屏 + A/B 回归）。
- **相邻回归说明（m16-serial，非本批）**：m16-brainstorm / m21-opc（×2）/ relay 全绿；m16-serial「默认串行」干净环境通过、「关闭串行」4 次复跑均失败（最近 2 次为无并发干净环境）——服务端 Run 全部正常收束（done + handed_to_user=1 + 完整消息落库），失败面为前端运行态滞留致尾条消息未进视口渲染（「你的回合」随之不渲染）；判定非本批回归（零 src 变更、改动零交集），引入点在并发会话 client UI 改动窗口内。**收尾复验：并发会话后续改动落盘后 2/2 全绿（27.5s），账目闭合；收尾门禁（逐场景细化后）：client 56/668、typecheck / lint / build 均通过，E2E `m52-stage.spec.ts` 22/22 全绿（复用并发会话 webServer 实例；coach 语汇同步后 50.6s、兜底标题后 55.0s 两轮复跑）；测试补缺后复验：client 56/673、typecheck / lint（0 错 13 警）通过，补缺为零 src 变更（仅测试文件与注释），build / E2E 结论沿用上轮实测。**
- 相关文档：design.md §69。（无新 ADR：本批为既有框架的声明接入，ADR 0112 决策覆盖。）

### v40 — 专业排盘卡增强：四张盘面卡专业化 · 契约测试 · 协议记录红线（M53，工具 / 协议批次）

- **动因**：用户反馈排盘输出信息量不足（紫微 tab 仅命宫 3 行、八字 tab 仅 5 行），要求「专业命理师」级盘面丰富度；同期两处关联问题——盘面卡无标题使多盘 tab 区分退化（两个卦盘均显示类型名「gua」）、模型仿写 `[工具调用]` 日志与虚假落盘声明——本批为四张专业盘面卡重写（计算层扩展 + 卡模板 + 契约测试）与协议纪律加固；零新增依赖（复用既有 lunar-typescript / iztro / astronomy-engine）。
- **计算层扩展**（`server/src/pan/`，纯函数）：bazi 补旬空 / 地势（十二长生）/ 胎元 · 胎息 · 命宫 · 身宫（含纳音）/ 生肖星座 / 起运交运日期与大运流年当前标记；ziwei 补四柱干支 / 生肖星座 / 来因宫 / 生年四化 / 十二长生 / 杂曜 / 当前大限标记；natal 补元素（火土风水）与模式（基本固定变动）分布；gua 补卦气（起卦四柱 / 日辰旬空 / 农历）/ 错卦综卦 / 卦体上下卦（卦象 · 五行）/ 旬空爻标记 / 动爻变爻（干支五行六亲）。
- **四张盘面卡重写**（`server/src/tools/pan.ts`；卡头标题 + `键：值` 字段行 + 单一连续 `- 键 | 值` 条目列表，与 remark-ext / chartboard 解析规则同源）：`四柱 庚午 辛巳 丁丑 丁未` / `紫微 土五局 ｜ 命宫 丙戌` / `本命盘 <出生时刻>` / `天雷无妄 → 天火同人`——卡头标题消解多盘 tab 退化（两个卦盘以卦名区分）；八字卡 11 字段 + 大运 8 步 + 流年 10 条（含当前标记）、紫微卡 6 字段 + 12 宫条目（主星亮度四化 · 辅星 · 杂曜 · 长生 · 大限）、星盘卡 3 字段 + 38 条目（10 行星 + 12 宫头 + 16 相位）、卦卡 9 字段 + 六爻条目（六神六亲 · 旬空 · 动爻变爻）；统一引导句「盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）」；四件套工具描述升级为「唯一口径」表述（盘面数据必须出自工具、禁止心算或凭记忆推算）。
- **契约测试**：新建 `server/tests/m53-pan-card.test.ts` 4 例（与 remark-ext 解析规则同源的卡格式不变量：卡头 kind / 标题非空 / 单一列表连续性 / 字段行正则 / 条目行格式 + 四卡丰富度基线）；`server/tests/m51-pan.test.ts` 21 例断言扩展（旬空 / 地势 / 胎元四宫 / 生肖 / 大运 toMatchObject / 生年四化 / 元素模式 / 卦气旬空 / 空亡爻 / 变爻）——两文件合计 25 例全绿。
- **协议纪律**（agents/）：`_protocol.md` tool_policy 新增「记录真实性（红线）」；`metaphysics` / `astrology` 协议 8 号追加盘面卡「整卡原样复制」（含卡头标题行，勿增删字段与条目——盘面板 tab 区分依赖它），新增 12（卡面复用：同参数不重复起卦 / 排盘，先查历史；多成员同波先声明分工）与 13（记录真实红线）。
- 评测：mock 28/28 ✅（协议追加条款不影响脚本链路，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 77 文件 / 1060 测试、client 56 文件 / 660 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；E2E `markdown-ext.spec.ts`（含盘面卡渲染用例）4/4 全绿。
- 相关文档：ADR 0113、design.md §68、`docs/adr/README.md` 索引。

### v39 — 新场景点亮走查：十个声明场景渲染验证（M52-B，验证 / 测试批次）

- **动因**：M52-A 交付场景工作区框架（design.md §66）后，M51 各批预写的十个 `stage` 声明（arena 2 / roundtable 1 / dock 7）需逐一实测「声明即渲染」；本批为**验证 + 测试批次**：零 src / 零资产 / 零协议改动（仅 `e2e/m52-stage.spec.ts` 与 `client/tests/m52-stage.test.tsx` 增补）。**agents 资产零变更**（分批登记纪律照记）。
- **点亮核对（10/10）**：arena `debate` / `negotiation`——席位分栏 + 计分板 + 回合轴随消息推进；roundtable `society`——席位环 4 席 + 议程波次 + 汇聚板；dock 7——board（`gamedesign` / `writing` / `housing`）/ coach（`career` / `care`）/ chartboard（`metaphysics` / `astrology`）工作区开合 / 拖宽 / 折叠记忆与面板渲染；同形态同面板组合以代表场景 E2E 全链 + 全量 yaml 静态核对（§7.5 矩阵逐字段）闭环。
- **E2E**：`e2e/m52-stage.spec.ts` 2 → 7 例（+5：roundtable 席位环与议程推进 / arena 全链「发消息 → 计分板轮次 + 回合轴 + 交还用户」/ dock·board / dock·coach / arena 窄屏 SeatStrip 与单流降级）。
- **vitest**：`client/tests/m52-stage.test.tsx` 22 → 25 例（+3 组件级走查：arena 席位分栏与计分板 / seats 成员不在场兜底「左席 · 右席 · 未开赛」/ roundtable 席位环 + 议程推进 + 汇聚板空态）。
- **走查发现**（均测试侧处理，零资产变更）：①「议题圆桌」为唯一预设（`issue-roundtable`）× 场景（`society`）同名对——创建对话框两来源区按钮 aria-label 相同，E2E 以场景行独有「∥ 并行协作」特征文案精确定位；② board 空态文案「文稿结构与版本将在这里显示」偏 writing 语境（三场景共用），记入 M52-C 逐场景细化事项。
- 评测：mock 28/28 ✅（零 agents 资产变更，baseline 未动、与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试、client 56 文件 / 656 测试（+3）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 330.90 kB，较 M52-A 持平——本批零 src 变更）；E2E `m52-stage.spec.ts` 7/7 + 相邻回归 relay / m21-opc / m16-serial（m16-serial 1 例浏览器会话崩溃偶发，复跑 2/2 全绿澄清非回归）。
- 相关文档：design.md §67（新章）、§66.5 指引更新、`docs/scene-expansion-design.md` §7、`e2e/m52-stage.spec.ts`。

### v38 — 场景工作区体系框架：四形态容器 · 六面板 · 12 元件库（M52-A，纯前端 / 类型批次）

- **动因**：场景生态（`docs/scene-expansion-design.md` §7）判定 29 场景共用同一种「聊天流」——对弈看不到席位与回合、圆桌看不到波次、工作型场景的产物散落；M51 各批已预写 `stage` 声明（arena 2 / roundtable 1 / dock 7）但消费端为零；本批落地框架，声明从注释语义变为运行时渲染。**agents 资产零变更**（协议 / 角色 / 预设未动，因分批登记纪律照记）。
- **类型层**：`GroupStageSchema`（layout 四枚举 / panel 六枚举 / seats left·center·right / parts 12 元件，全部可选）+ `AgentGroupSchema.stage`（未声明即 stream）；seats 引用角色存在性校验（m21 正负例 +2）。
- **四形态容器**：stream 零结构直通 / dock（右工作区 340px 拖宽 260–520 折叠关闭，`ma:sc:dock` 记忆）/ roundtable（席位环 + 汇聚板 + 波次进度）/ arena v1（席位分栏 + 回合轴 + 计分板，§7.9 口径）；`resolveStage` 降级链：未声明 / 非法 / arena 缺席位 / listMode → stream。
- **六面板 + 12 元件**：pool（条目卡墙 + 深入回填）/ versus（多空信号 + 裁决卡）/ board（目录树 + 版本线 + 交付件）/ console（看板 + 时间轴）/ coach（进度环 + 勾选）/ chartboard（多盘 tabs + PanBoard）；元件库 12 件（PART_NAMES 注册，空声明 = 全启用；空态统一 PanelEmpty）；纯前端派生（容器 / 盘行 / 裁决 / 清单 / 标题 / 波次）。
- **交互与性能**：面板 tabs / 勾选 sessionStorage（`ma:sc:*`）；「切回纯列表」开关（ChatArea 标题栏）；composerInsert 回填 + requestArtifact 打开交付件；500ms 节流 + 流式冻结 + 原始值 selector（流式 delta 不触发宿主重渲染）；quiet / reduced-motion 收敛；窄屏（<900px）抽屉 + 席位横条。
- 评测：mock 28/28 ✅（零 agents 资产变更，与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设；check:skills 51；server 76 文件 / 1055 测试（+2 seats 校验正负例）、client 56 文件 / 653 测试（+22 m52-stage）全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过（主包 gzip 330.91 kB，存量欠账持续关注）；E2E `m52-stage.spec.ts` 2/2 + 相邻回归 5/5（relay / m21-opc / m16-serial）。
- 相关文档：ADR 0112、design.md §66、`docs/scene-expansion-design.md` §7、`docs/adr/README.md` 索引。

### v37 — 命理占星专线：传统数术 · 星象占星两场景 + 排盘工具四件套与 `::: pan` 容器（M51-E，工具 / 容器 / 资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.5）判定「传统文化」方向全空白（传统数术与西方占星均无承接场景），且术数类内容的可信度来自「先盘后论」——盘面必须工具计算、参数可复现；本批落地第 28-29 个场景（`metaphysics` / `astrology`，11 新角色），把「表述纪律 / 排盘可验」两条领域红线写进协议，并新增排盘工具四件套与 `::: pan` 容器。
- **排盘工具四件套**（`server/src/tools/pan.ts` 注册 + `server/src/pan/` 计算模块）：`bazi_pan`（四柱 / 十神 / 藏干 / 五行 / 大运流年 / 真太阳时校正告警）/ `ziwei_pan`（十二宫 / 主星辅星 / 四化 / 五行局 / 大限）/ `natal_pan`（行星 / 宫头 / 相位矩阵 / 四轴；高纬降级等宫制）/ `gua_pan`（六爻 / 梅花，种子可复现）——全部 tier=deferred（`tool_search`「排盘 / 命盘 / 星盘」激活）、纯计算只读无审批、失败结构化报错（禁心算兜底）；golden 测试 `server/tests/m51-pan.test.ts` 21 例（八字 / 紫微 / 星盘各 ≥3 例 + 卦固定种子）。
- **`metaphysics` 传统数术（7 角色）**：order 118 / icon `moon` / theme 玄墨金 / `parallel: true`（parallelMax 4，多术可同波并行、各自落盘）/ `defaultSkills: [chinese-metaphysics]`——观复（四柱研习师 → `docs/八字命盘-<主题>.md`）/ 星垣（紫微研习师 → `docs/紫微命盘-<主题>.md`）/ 灼见（六爻研习师 → `docs/六爻卦解-<主题>.md`）/ 溯机（大六壬研习师 → `docs/大六壬课解-<主题>.md`）/ 心易（梅花研习师 → `docs/梅花卦解-<主题>.md`）/ 步天（七政研习师 → `docs/七政星盘-<主题>.md`）/ 奇正（奇门研习师 → `docs/奇门局解-<主题>.md`）；协议「表述纪律 + 排盘可验」（参考区间 / 禁恐吓话术与付费化解暗示 / 禁心算排盘或编造盘面 / 术语白话 / 生辰隐私 / 时辰存疑给敏感度说明 / 未工具化门类显式声明 / 起卦种子可复现）；`stage: {layout: dock, panel: chartboard}`。
- **`astrology` 星象占星（4 角色）**：order 120 / icon `star` / theme 星夜蓝紫 / `parallel: true`（parallelMax 4）/ `defaultSkills: [western-astrology]`——司辰（本命占星师 → `docs/本命盘报告-<主题>.md`）/ 星移（行运占星师 → `docs/行运报告-<主题>.md`）/ 合璧（关系占星师 → `docs/合盘报告-<主题>.md`）/ 问星（卜卦择时师 → `docs/择时报告-<主题>.md`）；协议「盘面为据」（时区显式 / 高纬降级等宫制如实告警 / 挑战相位表述为课题与成长点 / 合盘需知情前提 / 行运给时间窗不断言事件）；`stage: {layout: dock, panel: chartboard}`。
- **`::: pan` 容器**：remark-ext 新增 builder（`::: pan <bazi|ziwei|natal|gua> [标题]` + `键：值` 字段行 → `data-fields` + `- 键 | 值` 条目行 → `data-items`）+ 客户端 `PanCard` 渲染（四类型徽标 / 字段行 / 条目行 / raw 恒等兜底）；降级链：流式直接渲染（同 verdict 档）/ 未知类型通用「盘面」徽标 / 解析失败保持原文；M52-B 升级 PanBoard。
- **技能与预设**：新增 `skills/chinese-metaphysics`、`skills/western-astrology`；预设 `chart-combo`（order 240，观复 · 星垣）、`oracle-crossread`（order 250，灼见 · 心易）、`full-horoscope`（order 260，司辰 · 星移 · 合璧）。
- **镜像面七件套**：mock.ts 四件套 ×11（SCRIPTS 11 条 / artifactFor 11 case 与交付契约对齐 / DISPLAY_NAMES 11 / preferredOf 11）+ `TOPICS` 演示词表 +1（「前程」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +11（全量 114 角色 id→name 逐一相等）+ `m21.test.ts`（29 场景 / 114 角色 / 26 预设 / 协议断言 +2 / 排盘工具绑定 it）+ `agents/README.md`（统计与预载表 +2 行）。
- 评测：mock 28/28 ✅（新增 `28-metaphysics`：四柱 → 紫微合参 → 本命盘（3 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 29 场景 / 114 角色 / 26 预设（11 新头像 ✓）；check:skills 51 通过；server 全量 76 文件 / 1053 测试、client 全量 55 文件 / 631 测试全绿（含 m51-pan 21 例 / m51-md-pan 10 例）；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 8/8 全绿（m12-interactions / m16-members / m21-opc / markdown-ext，含盘面卡用例）。
- 相关文档：ADR 0111、design.md §65、`docs/scene-expansion-design.md` §5.5、`docs/adr/README.md` 索引、`agents/README.md`。

### v36 — 生活安居专线：置业安家 · 家庭照护两场景落地（M51-D，资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.4）判定「置业决策链 / 家庭照护支持」两类需求无承接场景（置业散落在 home / wealth，照护散落在 health 但主体是家人且核心是事务协助而非健康干预）；本批落地第 26-27 个场景（`housing` / `care`，6 新角色），把「预算纪律 / 非医疗诊断」两条领域红线写进协议。
- **`housing` 置业安家（3 角色）**：order 114 / icon `map` / theme 砖橙 / 串行决策链（需求 → 测算 → 落地）——择邻（选房参谋 → `docs/选房对比-<主题>.md`）/ 家树（房贷顾问 → `docs/贷款方案-<主题>.md`，handoff → wealth / legal）/ 筑居（装修规划师 → `docs/装修方案-<主题>.md`）；协议「预算纪律」（月供收入比如实测算 / 数据来源与时效 / 决策框架不替拍板 / 合同条款提示）；`stage: {layout: dock, panel: board}`。
- **`care` 家庭照护（3 角色）**：order 116 / icon `heart-handshake` / theme 玫红 / 串行照护链——顾宁（照护规划师 → `docs/照护方案-<主题>.md`）/ 陪安（陪诊助手 → `docs/陪诊记录-<主题>.md`）/ 颐和（康养顾问 → `docs/康养建议-<主题>.md`）；协议「非医疗诊断」（不做诊断 / 不开药 / 不解读报告 / 异常症状直接建议就医；陪诊只做就医准备 + 记录；照护者不透支）；`stage: {layout: dock, panel: coach}`。
- **技能与预设**：零新建技能（按角色预载 deep-research / spreadsheet-modeling / financial-modeling / visual-design / process-improvement / doc-coauthoring / formal-document / source-verification）；预设 `home-purchase`（order 220，择邻 · 家树 · 筑居）、`care-plan`（order 230，顾宁 · 陪安 · 颐和）。
- **镜像面七件套**：mock.ts 四件套 ×6（SCRIPTS 6 条 / artifactFor 6 case 与交付契约对齐 / DISPLAY_NAMES 6 / preferredOf 6）+ `TOPICS` 演示词表 +2（「购房」「长辈」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +6（全量 103 角色 id→name 逐一相等）+ `m21.test.ts`（27 场景 / 103 角色 / 23 预设 / 协议断言 +2）+ `agents/README.md`（统计与预载表 +2 行）。
- 评测：mock 27/27 ✅（新增 `26-housing`：选房 → 贷款 → 装修（3 回合，3 交付件）/ `27-care`：照护方案 → 陪诊准备 → 康养建议（3 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 27 场景 / 103 角色 / 23 预设（6 新头像 ✓）；check:skills 49 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0110、design.md §64、`docs/scene-expansion-design.md` §5.4、`docs/adr/README.md` 索引、`agents/README.md`。

### v35 — 工作创作专线：创作工作室 · 职业发展 · 游戏工坊三场景落地（M51-C，资产 / 技能 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.3）判定「长篇创作链 / 求职陪跑 / 游戏内容设计」三类需求无承接场景（写作散落在 marketing.content / ops.assistant，求职与 hr 视角相反，游戏设计与 development 工程实现不同）；本批落地第 23-25 个场景（`writing` / `career` / `gamedesign`，12 新角色），把「原创底线 / 履历真实 / 核心循环先行」三条领域红线写进协议。
- **`gamedesign` 游戏工坊（4 角色）**：order 108 / icon `flame` / theme 紫粉 / chain `[game-designer, balance-designer, narrative-designer, playtester]` / `parallel: true`（parallelMax 3，三路设计并行 + 验证收口）/ `rounds: false`——游心（玩法策划 → `docs/游戏设计文档-<主题>.md`）/ 千衡（数值策划 → `docs/数值平衡表-<主题>.md`）/ 织境（叙事策划 → `docs/世界观设定-<主题>.md`）/ 百试（玩法验证 → `docs/玩法测试报告-<主题>.md`）；`_protocol.md` 11 条（铁律 7 + 工具 2 + 交接 / 声明 2）；`stage: {layout: dock, panel: board}`。
- **`writing` 创作工作室（4 角色）**：order 110 / icon `pen-tool` / theme 纸墨褐 / 串行创作链——曲径（选题策划 → `docs/选题大纲-<主题>.md`）/ 文藻（主笔 → `docs/文稿-<主题>.md`）/ 锦言（编辑 → `docs/定稿-<主题>.md`）/ 书远（出版顾问 → `docs/出版方案-<主题>.md`，handoff → ip / pr）；协议「原创底线」+ 编辑边界（不越权改写）；`stage: {layout: dock, panel: board}`。
- **`career` 职业发展（4 角色）**：order 112 / icon `target` / theme 青绿 / 串行陪跑——程途（职业顾问 → `docs/职业规划-<主题>.md`）/ 履新（简历顾问 → `docs/简历-<主题>.md`）/ 问达（面试教练 → `docs/面试手册-<主题>.md`）/ 薪言（薪酬顾问 → `docs/offer评估-<主题>.md`，handoff → negotiator / career-advisor）；协议「履历真实」+ 候选人视角；`stage: {layout: dock, panel: coach}`。
- **技能与预设**：新增 `skills/game-design`（设计分层 / 核心循环画法 / 数值体系 / 叙事咬合 / 玩法验证）；预设 `writing-sprint`（order 190，曲径 · 文藻 · 锦言）、`job-hunt-sprint`（order 200，程途 · 履新 · 问达 · 薪言）、`game-kickoff`（order 210，游心 · 千衡 · 织境 · 百试）。
- **回填台账关闭**：`tactician.handoff` 追加 `comp-advisor`（AGENT.md + mock preferredOf + m21 断言三处同步）——谈薪彩排从职业发展转谈判桌；M51 回填台账全部关闭。
- **镜像面七件套**：mock.ts 四件套 ×12（SCRIPTS 12 条 / artifactFor 12 case 与交付契约对齐 / DISPLAY_NAMES 12 / preferredOf 12）+ `TOPICS` 演示词表 +1（「求职」，尾部追加既有任务零回归）+ `e2e/helpers.ts` AGENT_NAME +12（全量 97 角色 id→name 逐一相等）+ `m21.test.ts`（25 场景 / 97 角色 / 21 预设 / 协议断言 +3）+ `agents/README.md`（统计与预载表 +3 行）。
- 评测：mock 25/25 ✅（新增 `24-career`：定位 → 简历 → 面试 → offer 评估（4 回合，4 交付件）/ `25-gamedesign`：核心循环 → 数值 → 世界观 → 玩法验证（4 回合，4 交付件）；`--update-baseline` 后与基线零回归）；check:agents 25 场景 / 97 角色 / 21 预设（12 新头像 ✓）；check:skills 49 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；ESLint 0 错误（13 条既有 warning）；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0109、design.md §63、`docs/scene-expansion-design.md` §5.3、`docs/adr/README.md` 索引、`agents/README.md`。

### v34 — 议题圆桌：社会研讨协议与第 22 场景落地（M51-B，资产 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2 §5.2）判定「一个社会议题想看全」无承接场景（辩论场做对抗裁决、深度研究做单一课题查证）；本批落地第 22 个场景 `society`（4 新角色），把「事实核查 + 立场图谱 + 政策伦理」的多视角研讨落成可交付成果，收敛口径为「共识与分歧 + 可行建议区间」（并列收敛，不判胜负）。
- **`society` 议题圆桌（4 角色）**：order 106 / icon `globe` / theme 青蓝青绿 / chain `[moderator, fact-checker, stakeholder, policy-advisor]` / rounds + parallel（parallelMax 2）——齐观（议题主持 → `docs/议题观察报告-<主题>.md` 开场版 + 终局收口）/ 尚真（事实核查 → `docs/事实基线-<主题>.md`，skills source-verification）/ 方衡（立场图谱 → `docs/立场图谱-<主题>.md`，含间接相关方与沉默方，skills deep-research）/ 允中（政策伦理 + 可行建议区间并入观察报告终局版，skills formal-document）；`_protocol.md` 铁律 9 条 + 工具纪律 4 条（议题边界红线 / 事实分级 / 立场并列 / 政策伦理三框架 / 收敛口径 / 模拟声明）。
- **观察报告两版覆盖**：moderator 开场版（议题与边界 / 研讨轮次记录 / 共识与分歧初稿 / 模拟声明）→ policy-advisor 收口版（议题与边界 / 共识与分歧 / 政策伦理 / 可行建议区间 / 模拟声明）后者覆盖前者；mock `artifactFor` 两处同路径，eval 以「政策伦理」「可行建议区间」校验终局版。
- **回填台账关闭**：`judge.handoff` 追加 `moderator`（AGENT.md + mock preferredOf + m21 断言三处同步）——辩论需要多方视角时按 handoff 转 @齐观（议题圆桌）组织多方研讨；`tactician → career.comp-advisor` 仍待 M51-C 回填。
- **镜像面七件套**：mock.ts 四件套（SCRIPTS 4 条 / artifactFor 4 case / DISPLAY_NAMES 4 / preferredOf 4）；`e2e/helpers.ts` AGENT_NAME +4（全量 85 角色 id→name 逐一相等）；`m21.test.ts`（22 场景 / 85 角色 / 18 预设 / 协议断言 +1）；`agents/README.md`（统计与预载表 +1 行）。
- **`stage` 预写（M52-B 消费）**：`{layout: roundtable, panel: pool}`——围桌研讨语义区别于 arena 对席；本批零前端 / 零引擎改动。
- 评测：mock 23/23 ✅（新增 `23-society`：事实核查 → 立场图谱 → 政策伦理收口（4 回合，3 交付件）；`--update-baseline` 后与基线零回归）；check:agents 22 场景 / 85 角色 / 18 预设（4 新头像 ✓）；check:skills 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；build 通过；相邻 E2E 回归 4/4 全绿（m12-interactions / m16-members / m21-opc）。
- 相关文档：ADR 0108、design.md §62、`docs/scene-expansion-design.md` §5.2、`docs/adr/README.md` 索引、`agents/README.md`。

### v33 — 辩论场与谈判桌：PK 对弈协议泛化与双场景落地（M51-A，资产 / 技能 / 镜像面修订）

- **动因**：场景生态扩展（`docs/scene-expansion-design.md` v1.2）判定 invest 的「多空对弈」玩法（回合制对抗 + 证据挂载 + `::: verdict` 终局裁决，M34）未泛化——通用议题的观点对抗（辩论）与利益博弈（谈判彩排）无承接场景；本批把对弈协议泛化为三场景共用模板，落地首批双场景（第 20 / 21 个场景，7 新角色）。
- **`debate` 辩论场（4 角色）**：order 102 / icon `scale` / 红蓝对撞 / chain `[judge, affirmative, negative, evidence]` / rounds + parallel（正反同波立论）——立言（正方辩手 → `docs/正方立论-<主题>.md`，skills 含 red-team）/ 砺锋（反方辩手 → `docs/反方立论-<主题>.md`）/ 昭实（证据官，中立供弹药 → `docs/证据清单-<主题>.md`）/ 明断（裁判 → `docs/辩论裁决-<主题>.md`）；`_protocol.md` 铁律 8 条（观点与证据分离 / 对事不对人 / 不偷换概念 / 回合纪律 / 诚实边界 / 中立纪律 / 模拟声明 / 议题边界）。
- **`negotiation` 谈判桌（3 角色）**：order 104 / icon `handshake` / `parallel: false`（严格串行出价）——谭成（谈判手 → `docs/谈判策略-<主题>.md`，handoff → legal / finance）/ 祁弈（对手模拟，按设定立场真实还价 → `docs/对手档案-<主题>.md`）/ 苏纵（教练复盘 → `docs/谈判复盘-<主题>.md`）；`_protocol.md` 铁律 7 条（三桩先行 / 严格串行 / 每轮记录 / 对手真实 / 模拟声明 / 合规边界 / 隐私纪律）。
- **对弈五条（三场景共用）**：回合制（默认 3 轮、每轮必须回应上一轮、禁复读）/ 挂证据与置信度 / `::: verdict` 终局复用（辩论「胜负 + 置信度 + 核心依据 + 翻盘条件」；谈判「成交区间（ZOPA）+ 得失评分 + 改进点」）/ 模拟推演声明与统一收尾 / 并行纪律按场景定；`stage: {layout: arena, seats}` 预写（M52-A 消费，零前端改动）；头像 ×7（512px 风格化 3D 卡通 v2）。
- **handoff 台账**：辩论转 `research.scout`（补证据）、谈判转 `legal` / `finance`（条款与金额）本批落地；`judge → society.moderator`（M51-B 后）、`tactician → career.comp-advisor`（M51-C 后）延后回填（validate 全局校验，先写可用目标）。
- **技能与预设**：`skills/debate`（立论反驳模板 / 逻辑谬误清单 / 裁判裁量口径）、`skills/negotiation`（三桩 / ZOPA 与锚定 / 让步纪律 / 对手建模）；预设 `classic-debate`（order 160，明断 · 立言 · 砺锋 · 昭实）、`negotiation-rehearsal`（order 170，苏纵 · 谭成 · 祁弈）。
- **镜像面**：mock.ts 四件套（SCRIPTS 7 条 / artifactFor 7 case / DISPLAY_NAMES 7 / preferredOf 7）；`e2e/helpers.ts` AGENT_NAME +7（全量 81 角色 id→name 相等）；`m21.test.ts`（21 场景 / 81 角色 / 17 预设 / 协议断言 +2）；`agents/README.md`（统计与本包预载表 +2 行）。
- 评测：mock 22/22 ✅（新增 `21-debate`：正反交锋 → 证据归拢 → 裁决（4 回合）/ `22-negotiation`：三桩 → 还价 → 复盘（3 回合）；`--update-baseline` 后与基线零回归）；check:agents 21 场景 / 81 角色 / 17 预设 通过；check:skills 48 通过；server 全量 75 文件 / 1031 测试、client 全量 54 文件 / 621 测试全绿；四包 typecheck 0 错误；build 通过；相邻 E2E 回归 7/7 全绿（m16-members / m21-opc / m26-console / m48-routing / m50-blank）。
- 相关文档：ADR 0107、design.md §61、`docs/scene-expansion-design.md` §5.1 / §5.6、`docs/adr/README.md` 索引、`agents/README.md`。

### v32 — 空场景专项：单 Agent 直聊模式全链落地（M50，资产 / 引擎 / 前端 / 评测修订）

- **动因**：用户需求「空场景指的是不引入任何角色 agent，只使用一个通用的 harness agent 对话，单 agent 模式」——M48 空编制创建是「交给平台组队」（多 Agent），业务角色单聊又携带业务人设，两条路径均不满足「不要角色分工、一个人干完」；新增第 19 个场景 `blank`「空场景」与第 74 个角色 `general`「通用助手」，补齐「零选择」路径的第三种形态（空编制 = 交给平台组队；空场景 = 一个人干完）。
- **资产**：`agents/blank/` 三件套——`_group.yaml`（order 1 / `chain: [general]` / guide「直接说出你的需求，由通用助手独立完成」/ 4 条 agenda）；`general/AGENT.md`（无业务人设 / 无 souls / 无 `handoff`，白名单 = 全量 − `handoff`：54 精确项 + `fin_*` / `mcp__*` 通配；运行时复用 M28 分层：20 项 core 常驻 + 34 项 deferred 经 `tool_search` 按需激活，零新增机制）；`_protocol.md`（单助手规则：独立完成 / 工具直用 / 交付清晰 / 收尾直接 / 汇报诚实）；`agents/README.md` 计数与 handoff 说明适配（`general` 为唯一无 handoff 例外）。
- **引擎**：`shared` 导出 `BLANK_SCENE_ID`；`launch()` 单助手直通——编制恰为 `[general]` 且场景 blank 时未 @ 消息直达本人（跳过 PRS：零 `routing:dispatched` / 零 `__router__` 用量；实时派生，加人即退出）；三层隔离——`buildRosterCatalogBlock` 目录不列 / `knownIds` 丢弃幻觉召集 / `resolveAgent` 拒「不在场」（用户手动邀请保留）；收尾零改动（单成员波波末兜底 → `turn:end.mentions=['user']` + `notify:awaiting-user`）。
- **前端**：组队台「来源」栏顶部「空场景」独立卡（微标「单 Agent · 1 位成员」）+「按场景组队」列表过滤 blank（去双入口）；命令面板 / @ 列表 / 成员选择器零特判（资产型自然生效）。
- **mock / eval**：范式信号适配（bug 修复）——`write_plan` / `submit_review` 分支原以「工具清单含该工具」判定 M24 规划 / 评审范式，而 general 白名单常驻这两者（core 分层不折叠）→ 普通消息被误判 → 发出 `write_plan` 挂起、Run 永不结束（eval `artifact_exists` 失败根因）；修复为范式信号仅对业务角色成立（`meta.agentId !== 'general'`），业务角色语义零变化；剧本镜像面（SCRIPTS / artifactFor / DISPLAY_NAMES / e2e AGENT_NAME 的 general 条目）已随 v31 登记；eval 断言器新增 `no_invite`（「`routing:dispatched` 轨迹中不存在 members 非空条目」，覆盖 PRS 召集与 handoff 增援）；新增 `evals/tasks/20-blank-scene.json`。
- 评测：mock 20/20 ✅（含新增 `20-blank-scene`：单助手直聊 → 交付件 → 交还用户；与基线对比无回归）；check:agents 19 场景 / 74 角色 通过；server 全量 75 文件 / 1031 测试全绿（含新增 `m50-blank` 9 例）；client 全量 54 文件 / 621 测试全绿（含 `m50-blank-frontend` 5 例）；E2E 新增 `m50-blank` 全绿（独立卡 → 直聊 → 反向断言无「平台 召集了 …」→ 收尾与交付件），对照回归 `m48-routing` 全绿；全量 E2E 43 条全绿（4.2m）——`m27-mcp` 三处断言按 M50 新语义适配（`general` 的 `mcp__*` 通配使「N 个工具零可达」警示对新增服务器不再出现：改反向断言 + 授权矩阵命中徽章）；四包 typecheck 0 错误。
- 相关文档：ADR 0103–0106、design.md §60、docs/blank-scene-design.md、agents/README.md。

### v31 — Mock 镜像面全量对齐：74 角色剧本与交付件补齐、防回归守护建立（实现层适配）

- **动因**：用户要求「所有的 agent 都应该符合 harness agent 的实现标准」——对全量角色做实现层镜像面审计（`server/src/llm/mock.ts` 测试替身 + `e2e/helpers.ts` 转交断言镜像），发现两类历史失配：① v14 / v15 / v16 扩张引入的 34 个角色缺 SCRIPTS 演示剧本与 artifactFor 交付件——静默走 backend 兜底（非研发角色口吐「接口我定了 3 个端点」，交付件路径缺省为通用工作笔记）；② `sre`（v16 / M32）另有三处缺失（DISPLAY_NAMES / preferredOf / e2e AGENT_NAME），五处镜像全缺。
- **mock.ts 补齐（35 角色）**：SCRIPTS 补 35 条专属剧本（development 补位 6：security / tech-writer / ai-engineer / data-engineer / ux-researcher / ux-writer；生活与职能 28：quant 之后的全部角色；blank 空场景 general——单助手直聊、无 handoff）；artifactFor 补 35 个 case，交付路径逐一与该角色 `AGENT.md`「交付契约」对齐（如 `docs/安全审计报告-<主题>.md` / `docs/事故复盘-<主题>.md` / `docs/交付件-<主题>.md`）；DISPLAY_NAMES 补 `sre: 江屿`、`general: 通用助手`；preferredOf 补 `sre: [devops, backend, qa]`（缺表条目时转交随成员顺序漂移）。
- **e2e 镜像**：`e2e/helpers.ts` 的 AGENT_NAME 补 `sre` / `general`，与 74 角色 id→name 全量相等（转交断言字面量镜像的中文名单一事实源）。
- **防回归守护（新建 `server/tests/mock-coverage.test.ts`，4 例）**：断言动态取 `lib.list()` 全量角色（不写死计数，新角色自动纳入）——① artifactFor 命中专属交付件且路径与 AGENT.md 契约对齐（占位符 `<主题> / <议题> / <课题>` 兼容）；② SCRIPTS 输出不含 backend 兜底特征串、单成员编制交还用户；③ preferredOf 正 / 逆序注入转交不漂移、首选属 handoff 且显示中文名（DISPLAY_NAMES 生效）；④ E2E AGENT_NAME 与角色 id→name 逐一相等。
- **空场景配套**：`agents/blank/general/AGENT.md` 交付契约补充默认路径 `docs/交付件-<主题>.md`（与 mock 镜像一致）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 19 场景 / 74 角色 通过；server 全量 75 文件 / 1030 测试全绿（含本批新增 mock-coverage 4 例）。
- 相关文档：agents/README.md（交付件命名规范章节增补一致性守护）、design.md §7.3（镜像面标准固化）。

### v30 — Agent 级工具可达性修复与「工具-正文-协议」三方对齐（人设修订）

- **动因**：v29 场景层专业化落盘后，对全部 73 角色做双向工具审计——正向（正文提及工具但白名单未授权）与反向（白名单持有但正文未形成使用纪律）双查，消除「工具在手不知道怎么用」与「正文声明了却拿不到」两类静默失配；审计口径升级为三方对齐（角色正文 ↔ tools 白名单 ↔ 场景协议）。
- **白名单修复（13 角色）**：invest 全组 5 角色（invest-lead / analyst-fa / analyst-ta / analyst-news / quant）补画布 / 媒体四件套（canvas_read / canvas_write / media_generate / media_video；v25 多空对弈「送上画布」链路依赖）；ux-researcher / ip / fundraiser / brand / assistant / recruiter 6 角色补工具可达性缺口；fitness / wellness 补 calc（训练容量 / 睡眠债核算口径）。
- **「工具-正文」对齐（约 33 文件 / 36 处）**：把白名单已授权但正文未形成纪律的工具写进「工作方式」段，例——legal「法律依据先 web_search 找官方入口、web_fetch 拉取原文核对」；bd「合作方背景先 web_search 核实，谈判节点 date_calc 排期，合作方案 template_fill 渲染」；fitness「训练容量（组 × 次 × 负重）与热量估算用 calc 核算」；travel「预算表用 csv_analyze 汇总」；ux-writer「无障碍用词与平台文案规范先 web_search / web_fetch 核实并标注来源」。
- **审计终态**（三方口径全量复跑）：反向残留仅 canvas / media 四件套（平台系统面——引擎注入的画布与媒体能力，全员持有、按需使用，不逐一人设声明）与 10 处场景协议覆盖项（marketing 数据来源条款 ×6 / invest 数字纪律 ×3 / ops 时间纪律 ×1）；正向残留仅 bi「只读取数不写库（无 db_execute）」职责边界声明（有意为之）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 18 场景 / 73 角色 / 15 预设 通过；server 全量 73 文件 / 1018 测试全绿。
- 相关文档：本日志 v29（场景层同批）、agents/README.md 工具白名单章节。

### v29 — 场景资产全量专业化：18 场景协议补齐与描述 / 引导 / 议程细化（资产修订）

- **动因**：用户要求「列举所有支持的场景，对每个场景进行专业化、细化、丰富的优化」。横向对标发现专业化程度参差：8 个场景有专属协议（strategy / development / sre / brainstorm / research / finance / invest / bi），其余 10 个场景仅有元数据无协议；部分场景 description 偏简、agenda 仅 3 条、guide 未场景化。
- **场景协议补齐（10 新增，18/18 全量具备）**：对齐既有「铁律 / 协作 / 交付」三段式，逐场景定制——funding（材料真实性 / 披露纪律 / 估值与条款 / 沟通节奏 / 数字纪律 / 不越权承诺）、marketing（指标口径先行 / 数据与来源 / 合规红线 / 品牌一致性 / 实验纪律 / 发布节奏）、health（医疗红线 / 渐进原则 / 不承诺数字 / 数字纪律 / 安全查证 / 隐私保护）、home（安全第一 / 清单化 / 预算意识 / 家庭协作 / 低负担 / 隐私）、learning（目标先行 / 输出检验 / 循序渐进 / 练习设计 / 正向反馈 / 内容准确性）、ops（流程可执行 / 时间纪律 / 承诺边界 / 隐私保护 / 数据纪律）、sales（承诺边界 / 报价纪律 / 客户信息保护 / 服务口径 / 跟进纪律 / 数据真实）、personal（陪谈边界 / 不评判 / 最小行动 / 隐私保护 / 事务可闭环 / 提醒纪律）、travel（时效信息必核实 / 不代办预订 / 预算透明 / 节奏留白 / 安全预案）、wealth（不推产品 / 不承诺收益 / 风险匹配先行 / 数字纪律 / 财务隐私 / 边界声明）；每份协议含成员分工、跨场景交接与成员各自落盘的交付件路径。
- **_group.yaml 细化（17 个）**：description 全量充实（18 场景统一切面：定位 + 能力清单 + 原则 / 边界）；guide 空态引导场景化（如「开始第一次研发接力」「说说你的健康目标与现状」「交办一件家里的事」）；agenda 议程 3→4 条、prompt 专业化细化（覆盖各场景高频任务；development 首条「需求澄清」原文保留以兼容 e2e 断言）。
- **角色人设专业化（13 个）**：ux-researcher / ip / fundraiser / fitness / wellness / brand / assistant / recruiter 与 invest 五角色（invest-lead / analyst-fa / analyst-ta / analyst-news / quant）的 description 与职责条目细化（补齐工具纪律、职责边界与协同接口）。
- **镜像面适配**：`agents/README.md` 场景协议条目更新为「本包 18 场景已全量具备」；`server/tests/m21.test.ts` 协议断言 +sales（报价纪律）；m29 / m30 回归断言 +sales，m32 / m35 回归断言 +marketing（实验纪律）。
- 评测：mock 19/19 ✅（与基线对比无回归）；check:agents 18 场景 / 73 角色 / 15 预设通过；server 73 文件 / 1018 测试、client 51 文件 / 602 测试全绿（含协议断言 m21 / m29 / m30 / m32 / m35 / m48-roster）；E2E `m37-scene-chat` 2/2 通过（议程 chips / 结构化容器断言兼容）。
- 相关文档：agents/README.md、design.md §52（场景资产 guide / agenda 机制）。

### v28 — 调度平台化：撤销调度官「知舟」，调度上收引擎（M48，资产 / 引擎 / 接口 / 前端修订）

- **动因**：用户反馈——调度官「引入了一个新角色，感觉怪怪的」；原则「所有 agent 都应是单一业务 harness agent」——意图识别与阵容召集是**平台能力**，不应人格化为资产角色；M46 系列的 `dispatch` 特例税（资产 schema / 校验 / 控制台 round-trip / 前端徽标）与机制噪音（接手护栏 / 恒 execute / 收口波等三轮补丁）同步清零。
- **资产修订**：删 `agents/harness/`（「智能协作」场景 + 「知舟」人设）；`dispatch` front-matter 字段从 `AgentDefinition`（shared）/ `check:agents` 校验 / 控制台编辑 round-trip 全链移除；计数 19→18 场景、74→73 角色；`_presets.yaml` 无引用（预设 15 不变）。
- **引擎修订**：新模块 `server/src/orchestration/platform-router.ts`（**平台路由步 PRS**）——未 @ 消息 / 空编制开场由引擎执行一次结构化 LLM 调用（json_schema `platform_route`、`__router__` 哨兵、`kind='turn'` 用量、非角色回合：不产生消息 / 不占波次 / 不进交接队列），输出「members 召集 + assignments 派发（1–4 位有序）+ reason」；启动三分支（@ 直达 / 显式 plan·review 直投编制首位 / 路由）；引擎应用 = 召集先落库（`inviteMembersCore`，actor「平台」）+ 任务便条注入（from「平台」）+ 队列填充；降级（有编制 → 在场首位接手；空编制 → 系统事件条提示收尾，绝不静默）；handoff 未在场目标**自动召集**（source='handoff'）；trace `routing:dispatched` 三形状（召集 / 派发 / 降级），复用 ADR 87 目录注入与 ADR 89 惰性 participants。
- **接口 / 工具面**：`POST /sessions` 空编制合法（`participantIds: []` 不再填充调度官）；`invite_members` 工具移除（56→55）；召集三路（PRS / handoff 增援 / 成员 API）共用 `inviteMembersCore`。
- **前端**：删 `DispatchBadge` 与调度官预选；空编制建会话流（0 人提交 = 「空编制创建 · 交给平台组队」，提示「未选成员：首条消息将由平台自动组队并派发任务」）；CommandPalette 快捷新建直建空编制会话；空态引导「直接描述你的需求，平台将自动组队并派发任务」；TraceDrawer 三形状渲染。
- **影响面**：`agents/` 资产、`server` 引擎（platform-router 新建 + engine / assembler / registry 清理）、`shared` 类型、`client` 组件与测试、`evals`（任务重写）、`e2e`；M46 系列 ADR 82–91 / 95 中 8 条 Superseded、3 条 Amended（见 ADR 0101）。
- 评测：mock 19/19 ✅（`18-platform-routing`：零编制三回合——平台召集 → 接力 → 交付；与基线对比无回归）；check:agents 18 场景 / 73 角色 通过；check:skills 46 通过；server 1018 / client 602 测试全绿（新增 `m48-routing` / `m48-roster` / `m48-frontend`）；E2E 全量 41 条全绿（`m48-routing` 2 条）；四包 typecheck 0 错误。
- 相关文档：ADR 0101、design.md §57、docs/harness-dispatch-design.md（收档注记）。

### v27 — 工具可用性门控与失败语义收敛（M47，引擎 / 工具层修订）

- **动因**：生产库 `tool_metrics` 全量取证（593 次调用 / 17 次失败）定位六类系统性失败根因——环境未启用但清单可见（web_search / web_fetch）、整组关闭 + 泛化「未知工具」（fin_*）、正常态被记为失败（tool_search）、中断被计入失败（write_file / remember）、报错不可行动（calc）、负向业务结果（write_plan，保持原语义）。用户侧表现为网络工具与 fin_* 反复红卡失败、停止运行也算「工具失败」。
- **可用性门控**（`server/src/tools/availability.ts` 新建）：`toolUnavailableReason` 集中判定 web_search / web_fetch / run_command 三类环境门（统一 DISABLED_SUMMARY 文案含「改哪个配置后重启」指引）；`GIT_TOOL_NAMES` / `isGitToolName` 供会话模式门复用；引擎清单过滤——未启用工具不进模型 schema 与 `tool_search` 可发现范围（执行期守卫保留作双保险）。
- **引擎修订**：`EngineDeps.isGitMode` 会话模式门（sandbox 无仓库 → git 6 工具不进清单；缺省 = 不判定，eval / 单测零差异）；`discoveryGate` 仅对本回合可发现范围内的延迟工具给检索引导；中断语义收敛——新增 `'stopped'` 状态（用户停止 / 回合超时：不落失败指标 + trace `aborted:true`），停止导致的审批取消同归，用户驳回 / 审批超时仍为 `error`。
- **registry 修订**：`markUnavailable`（整组关闭登记「已知但未启用」→ 执行期返回精确配置指引）、`unavailableNames`（控制台白名单校验合并该清单，编辑引用 `fin_*` 的角色不再误报）、`describeParamIssue`（zod 必填中文化）；`tool_search` 未装配 / 发现未启用 → `direct:true` 非失败语义；`calc` 函数报错附 usage 签名（参数个数类错误一步自愈）。
- **共享类型与前端**：`ToolCallRecord.status` 新增 `'stopped'`（shared）；ToolCard 琥珀 `CircleSlash` 呈现（不再是红卡）；`index.ts` 装配 isGitMode 与控制台 toolNames 合并。
- **影响面**：`server` 引擎 / registry / 工具层与 `shared` / `client` 共享类型；**未触碰 `agents/` 资产与提示词**（check:agents 19 场景 / 74 角色 / 预设 15、check:skills 46 均通过，不受影响）。
- 评测：mock 19/19 ✅（与基线对比无回归）；server 全量 1027 测试全绿（新增 `m47-tool-availability` 9 例，m28 / m7 适配）；client 571 全绿；E2E 全量 41 条全绿；四包 typecheck 0 错误。
- 相关文档：ADR 0099、design.md §56。

### v26 — 撤除主区「行情」Tab（M34 呈现形态修订，纯前端）

- **动因**：承接 v25 / ADR 97「独立面板是功能孤岛」的复盘结论——「行情」Tab 的自选列表与盯盘轮询发生在会话之外，与「证据 → 讨论 → 交付件」协作主线无交集；K 线的看盘诉求已由会话 ```kline 块 / 画布 KlineNode / Agent canvas_write 三形态覆盖。用户明确要求删除行情面板。
- **前端**（无 agents 资产变更）：移除 `FinanceView` / `KlinePanel` / `trading-hours` 组件与 AppLayout Tab 触发（含懒加载）、Command Palette「行情 / 自选」入口、`MainTab` 的 `'finance'`、`.finance-kline-canvas` 样式；`finance-api` 收缩为仅 runGame 通道（面板专用端点封装与 `useFinanceEnabled` 移除）；面板单测删除、runGame 契约测试迁移至 `m34-finance-api.test.ts`。服务端网关 / `fin_*` 工具 / `finance_watchlist` 存储 / `FINANCE_ENABLED` 门控原样保留（`fin_watch` 工具文案同步去掉「行情 Tab」字样）。
- 评测：纯前端视图层收缩，未触碰 agents/ 资产与提示词；check:agents / eval mock 基线不受影响（未重跑）。
- 相关文档：ADR 0098、design.md §53.3 修订注记、docs/finance-invest-design.md §6.2、README。

### v25 — M34 呈现形态修订：K 线 / 博弈入会话与画布、多空对弈协议链路（协议 / 预设修订）

- **动因**：产品形态纠偏——K 线 / 博弈应是 chat / 画布上的特殊交互（不是单独面板、不是单机沙盘），博弈要让 agent 之间真实对抗、输出可追责的终局结果。原主区「博弈」Tab + GameLab 面板是功能孤岛（结果要人肉搬回对话、无 agent 参与），**修订**为：撤「博弈」Tab 与 GameLab；K 线 / 博弈收敛为「会话内块 × 画布节点 × Agent 通道」三形态（块含「送上画布」，节点含 GameNode / KlineNode，通道为 canvas_write 的 game / kline 类型）；博弈升级为协议驱动的 agent 对抗链路。
- **协议修订**（`agents/invest/_protocol.md` +4 条「多空对弈」）：① 触发与阵容——fa 持多方 × ta 持空方正面对抗；news 只供双方证据弹药（附信源等级）不站队、不预判；quant 用 `fin_game` 逐轮量化走子；lead 终局裁决；② 回合纪律——每轮 = 多方立论 → 空方立论 → quant 走子 → lead 记录；立论须挂证据与置信度、回应对方上一轮论据；默认 3 轮，可指定轮数或叫停；③ 走子口径——取双方认可参数（对抗收益 matrix / 攻守次序 sequence / 筹码情绪 evolve·simulate），争议按区间或情景双跑并列，附种子复现；④ 终局裁决——胜负（多方 / 空方 / 僵持）+ 置信度 + 核心依据 + 翻盘条件，以 `::: verdict` 容器落卡并声明「模型推演，非涨跌预测」。
- **资产修订**（`agents/invest/`）：`_group.yaml` agenda 增「多空对弈」入口；`_presets.yaml` 预设 14 → 15 增 `bull-bear-duel`「多空对弈」（五角色全链，order 150）；无角色人设改动。
- **mock 剧本**（`server/src/llm/mock.ts`）：新增 `DUEL_SCRIPTS` 对弈专属剧本（多方 / 空方立论对峙、证据弹药按双方归堆、走子「对抗矩阵 0.62:0.38 + 序贯逆向归纳」、主管 verdict 裁决卡）与「博弈推演」交付件（`docs/博弈推演-<主题>.md`）。
- **工具面**：`canvas_write` / `canvas_read` 支持 `game` / `kline` 节点类型（zod 枚举 + 摘要 digest：博弈「有结果 / 配置态」、K 线「标的 / 名称 / 周期 / 根数」）——Agent 可把 `fin_game` / `fin_kline` 产物直接落画布。
- **前端**：画布新增 `GameNode`（配置态：模型 / 标的 / 话题 / 场景预设 / 高级参数（种子 + 模型参数）→「运行推演」直连纯计算；结果态与消息块共用 `GameResultView`内核；agent 或「送上画布」写入自动切结果态）与 `KlineNode`（空态「拉取行情」/ 结果态周期复权切换 + 刷新，写回节点）；创建菜单 +2（博弈推演 / K 线行情）；GameBlock / KlineBlock 工具条新增「送上画布」；新增 `::: verdict` 终局裁决卡（remark 解析 + VerdictCard 渲染 + raw 兜底）；撤「博弈」Tab 与 GameLab（AppLayout / CommandPalette / ui-store 同步，测试适配）。
- 评测：mock 19/19 ✅（新增 `19-bull-bear-duel`：三路交锋并行 → 量化走子 → 终局裁决，turns_lte 7；断言含 5 交付件 / 翻盘条件 /「模型推演」标注；与基线对比无回归）；check:agents 19 场景 / 74 角色 / 预设 15 通过；check:skills 46 通过；E2E 全量 41 条全绿（m34-invest 3 条 + markdown-ext verdict 用例，真实浏览器）；四包 typecheck 0 错误；server 1017 / client 583 测试全绿。
- 相关文档：design.md §53（修订注记）、docs/finance-invest-design.md §6.4、ADR 0097、README。

### v24 — 调度派发修复、收口波与串行执行（M46-2，协议 / 人设修订）

- **动因**：M46 上线后的真实故障修复批次（头脑风暴会话连续三次复现，run_7b3fda05 / run_43713c38 / run_78ecb13b）——调度官同一条消息「先派发成员、末尾 @用户 报备」被波合并误判为全员交还，accepted 静默丢弃、Run 结束、交付件从未产出（用户反馈「没有汇总给我」）。
- **协议修订**（`agents/harness/_protocol.md` 调度纪律第 5 条）：收口语义对齐收口波机制——业务收尾由成员各自完成，全链交还用户后调度官还会收到一次「收口汇总」回合（核对关键交付件、向用户交摘要并以 @用户 结尾）；收口回合不再派发新任务。
- **人设修订**（`agents/harness/harness/AGENT.md`）：职责段收口汇总同步（系统追加「收口汇总」回合的语义）；协作接口段新增「用户交互节奏」行——确认（我理解的任务）→ 派发（谁来做）→ 收口（做完了什么）。
- **引擎侧**（同批落地，见 ADR 94–96）：派发优先于交还报备（mergeWaveSchedule 先收集 accepted 再判交还）；调度收口波（engine `maybeAppendDispatchCloseout` + assembler【收口汇总】指令 + `dispatch:closeout` trace，每 Run 一次）；会话级串行执行默认开启（迁移 v12 + PATCH API + TaskView 芯片）。
- 评测：mock 19/19 ✅（`harness-dispatch` 剧本更新为含收口波的 5 回合链路，turns_lte 8；与基线对比无回归）；`check:agents` 19 场景 / 74 角色通过；server 1017 / client 583 测试全绿（含 `applySession` 缺省语义字段回归 1 例）；E2E 新增 `m16-serial` 2 条 + `m46-harness` 增收口波与交付件断言 + 并行专项 `disableSerial` 适配（全量 41 条全绿）；四包 typecheck 0 错误。
- 相关文档：design.md §55、ADR 0094–0096。

### v23 — 调度官头像资产（M46 收尾）

- **新增 `agents/harness/harness/avatar.png`**：512×512，v2 风格化 3D 卡通口径（成人比例约 1:4 / 半身像居中 / 纯白背景 / 柔和棚拍光 / 哑光黏土质感）——35 岁东亚男 · 从容沉着；黑色利落短发（清爽侧分）、深灰西装 + 靛蓝衬衫 + 挂绳工牌，持节点连线平板；靛蓝主题色 `#4f46e5` 呼应 harness 场景（`waypoints` 图标同源）。
- **同步资产面**：design.md §19.3 设定表新增 `harness · harness` 行；§19.1 / §19.2 计数同步（19 场景 74 角色、头像 74/74 齐备，暂缺标记移除）。
- **评测**：头像为静态图片资产、不入提示词（v17 先例）；`npm run check:agents` 19 场景 / 74 角色通过。

### v22 — 投研协作链修订与 golden 任务（M34 批 D）

- **动因**：把投研小队从「资产就位」推进到「协作链可验证」——两条预设链路（投研快评 / 策略研究）全部脚本化，进入 eval 与 E2E 常驻基线。
- **协作编排修订**：`invest/_group.yaml` 增 `parallelMax: 4`（四路分析同波上限 = 全组）；`_presets.yaml` 两条预设 prompt 重写——分析师显式 @（快评 = 雷动 + 闻笛两路；策略研究 = 秦砚 + 雷动 + 方程三路），主管不由 @ 入波、独立成收敛波，并内嵌主题词（「业绩增长」/「增长主线」）使 mock topic 提取稳定命中。
- **mock 剧本（确定性基线）**：`server/src/llm/mock.ts` 新增 5 角色剧本与 5 份交付件 case（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案，路径与 AGENT.md 交付契约一致）。
- **golden 任务（15 → 17）**：invest-quick-review（3 回合：主管 → 技术面 → 舆情面 → 交还；turns_lte 4）、invest-strategy-research（4 回合：主管 → 基本面 / 技术面 / 量化 → 交还；turns_lte 5）；断言链含交付件存在 / 关键节 / handoff_targets / 无回环。
- **E2E 新增 `m34-invest`（2 条）**：preset 建会 → 草稿预填 → 两路 / 三路并行（并行协作组「雷动、闻笛」/「秦砚、雷动、方程」）→ 主管收口 → 交还用户 → 3 / 4 份交付件；`openApp` 增首载兜底（webServer 冷启动竞态重载一次）。
- 评测：mock 17/17 ✅（新增 2 任务，基线已刷新）；check:agents 19 场景 / 74 角色通过；check:skills 46 技能通过；server 987 测试全绿；E2E 全量 34 条全绿。

### v21 — 通用调度官与意图路由（M46，+1 场景 / +1 角色 / +1 工具）

- **动因**：M46 通用调度官与意图路由专项上线——新会话可不选成员直接开聊，由「调度官」接手意图识别、阵容召集与任务派发；此前无 @ 消息盲投编制链首位（engine.ts 首发队列），不做任何意图识别。
- **新增场景 harness（智能协作，order 1 置顶）**：单角色编制「知舟（总调度 / Dispatcher）」——持 `dispatch: true`（新增 front-matter 字段，全局至多一个，`validate()` 与 `check:agents` 双层校验）；四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）+ `_protocol.md` 调度纪律 6 条（意图四分类 / 最少必要召集 / 派发必附期望产出 / 闲聊直答交还 / 不越权替成员干活 / 调度说明 ≤120 字）。
- **工具白名单（最小协作集）**：只读检索（`tool_search` / `memory_search`）+ 协作原语（`handoff` / `invite_members` / `remember` / `write_todos` / `request_approval` / `load_skill`）；不持写类与业务工具（`calc` / `template_fill` / 文件写类等一律不给），确保调度官不越权产出业务交付件。
- **dispatch 字段全链路**：`AgentDefinition.dispatch?: boolean`（shared 类型）→ AGENT.md schema（prompts.ts）+ 唯一性校验 → 控制台字段序与 round-trip 保留（编辑不丢 / 复制不继承，manager.ts）→ `check:agents` 输出 `dispatch:✓`。
- **引擎路由（四分支）**：@ 直达（零变化）→ 消息级显式 plan / review 直投首位业务成员 → 无 @ 交调度官 → 兜底编制链首位；插话补位同优先级（@ > 调度官 > 首位未发言者 > 编制链首位）；调度波恒 execute（planFirst 顺延业务首波消费）；接手护栏同 Run ≤3 次，超出按缺席路径兜底、不中断 Run。
- **召集闭环**：新工具 `invite_members`（core tier，仅调度官白名单可见；`agent_ids` ≤20 / `scene_id` 整链，已含成员幂等跳过）+ 共享内核 `inviteMembersCore`（与成员 API 同源：校验 / 排序 / 事件条 / 广播；措辞「召集了」）；工具运行时惰性 `participants`（getter）支持同回合「先召集后派发」；调度官回合注入 `roster_catalog`（未在场角色目录，LRU 32 + 内容签名热更新）。
- **前端**：三步流默认预选调度官（可取消；0 人提交「交给调度官 · 0 位成员」）；CommandPalette「新会话」由全量编制改为仅调度官（修复 68 人全会话缺陷）；`DispatchBadge`「调度」徽标四处复用（AgentPicker / 三步流提示条 / 成员卡 / 消息头）。
- **影响面**：`agents/harness/` 三资产新建；`server/tests/m21.test.ts`（场景 19 / 角色 74 / 协议断言 / M46 dispatch 唯一性两用例）；`agents/README.md`（dispatch 字段说明 + 74 角色协作基线 + 技能表 harness 行）；`client/src/lib/avatar-icons.ts`（waypoints 图标注册）；无既有角色 / 协议 / 技能改动。
- **测试**：server 2 套件 34 例（`m46-dispatch` 12：四分支路由矩阵 / planFirst 顺延 / 接手护栏 / 成员增援回路；`m46-roster` 22：内核分支 / 工具契约 / 目录渲染与缓存 / 调度回合指令与成员增援行）；client 1 套件 9 例（`m46-frontend`：三步流 / CommandPalette / 徽标）；e2e `m46-harness` 2 条；tools 计数 56（core 22 / deferred 34）。
- 评测：mock 18/18 ✅（新增 18-harness-dispatch：调度官召集 → 三交付件 → 交还；基线已刷新）；check:agents 19 场景 / 74 角色通过；check:skills 46 通过；server 1012 / client 572 测试全绿；E2E 全量 36 条全绿；四包 typecheck 0 错误。
- 相关文档：design.md §54、ADR 0082–0091、docs/harness-dispatch-design.md。

### v20 — 投研场景与角色资产（M34，+1 场景 / +5 角色 / +5 技能 / +2 预设）

- **动因**：M34 金融投研专项上线（`fin_*` 12 工具 + 行情 Tab + 博弈实验室），需要一支投研小队把工具链沉淀为「四路独立分析 → 交叉检验 → 主管收口」的协作资产，产出数据可溯、观点与事实分离的投研成果。
- **新增场景 invest（投资研究，order 62，finance 之后 bi 之前）**：theme `#dc2626`（A 股涨色，与 finance 绿区分），`parallel: true`（四路分析可同波并行），chain `[invest-lead, analyst-fa, analyst-ta, analyst-news, quant]`；场景协议「投研纪律九条」（数据可溯 / 不臆造 / 观点与事实分离 / 概率思维 / 风险先行 / 免责声明 / 工具纪律 / 分工与裁决 / 模拟推演不越界）。
- **新增 5 角色**：invest-lead 祝衡（投研主管，报告收口）、analyst-fa 秦砚（基本面）、analyst-ta 雷动（技术面）、analyst-news 闻笛（舆情面）、quant 方程（量化策略师：策略回测 + 博弈推演）；四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）+ 独立交付件（投研报告 / 基本面分析 / 技术面分析 / 舆情简报 / 策略方案·博弈推演）。
- **工具绑定（可达性纪律）**：12 个 `fin_*`（tier=deferred，经 `tool_search` 检索激活）按职责分权——invest-lead 全量 12 个；analyst-fa 7 个（fundamental/fund 子集）；analyst-ta 6 个（indicator 子集）；quant 9 个（indicator/backtest/screen/fund/game）；analyst-news 4 个；全部含协作基线 `handoff`，正文带「先 `tool_search` 检索激活」引导。
- **新增 5 技能（41 → 46）**：technical-analysis（K 线语言 / 指标误区 / 多周期共振）、fundamental-analysis（三表 / 估值三口径 / 排雷清单）、investment-strategy（规则化 / 回测口径七要素 / 参数敏感性）、market-news-analysis（事件分级 / 预期差 / 信源等级）、game-theory-trading（博弈映射 / 纳什速算 / ABM 参数化 / 反模式）。
- **新增 2 预设（12 → 14）**：invest-review「投研快评」（invest-lead + analyst-ta + analyst-news）、strategy-research「策略研究」（quant + analyst-fa + analyst-ta + invest-lead）。
- **头像 5 张**：512×512，v17 风格化 3D 卡通（祝衡深蓝西装 + 趋势线平板 / 秦砚金丝眼镜 + 财报册 / 雷动卫衣 + K 线平板 / 方程黑框眼镜 + 回测曲线 / 闻笛耳麦 + 快讯屏）；客户端图标注册表新增 `candlestick-chart` / `calculator` / `newspaper`。
- **影响面**：`server/src/llm/mock.ts`（DISPLAY_NAMES +5、preferredOf +5，与 AGENT.md handoff 一致）；`server/tests/m21.test.ts`（场景 18 / 角色 73 / 预设 14 + M34 工具绑定断言）；`agents/README.md`（统计与预载表）；无既有角色 / 协议 / 技能改动。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 18 场景 / 73 角色通过；check:skills 46 技能通过；server typecheck 0 错误。

### v19 — 8 角色定时任务能力绑定（M35）

- **动因**：M35 会话级定时任务上线（创建 / 查看 / 管理三件套 + 右栏「定时」面板 + 到点注入消息的「定时」徽章），让「到点自动推进」成为协作原语；时间敏感型角色按可达性纪律获得调度能力。
- **绑定角色（8）**：ops/assistant（日程与催办）、ops/ops（例会与检查点）、sre（观察窗口与巡检）、finance/compliance（申报与整改节点）、marketing/content（发布节奏与定稿审查）、sales/success（续费窗口与陪跑节点）、research/scout（长周期课题巡检）、personal/life-admin（账单与证件到期）——tools 追加 `schedule_task` / `list_schedules` / `manage_schedule`（插入于 `load_skill` 前）；其余 60 角色不持有（能力不扩散：deferred 可发现范围 = 白名单）。
- **工具语义**：`schedule_task` 建任务（run = 到点让目标成员开工，目标须为会话内成员；remind = 纯提醒零 token）；`list_schedules` 清单（只读）；`manage_schedule` pause / resume / remove / run_now。三者 `tier=deferred`（经 `tool_search` 检索激活，渐进披露）。
- **护栏**：每次触发 / 变更发 `notify:schedule-changed` 与 `notify:schedule-reminder`（右栏面板实时可见，透明可审计）；cron 最小间隔 5 分钟（高频轮询拒绝）；会话忙时自动 skip 留痕、连续失败 3 次自动暂停；跨会话任务一律拒绝。
- **引导（三处，对齐 v16 ssh 先例）**：① 8 角色正文各补一句场景化用法 + 「先 `tool_search` 检索激活」；② 全局协议 `<tool_policy>` 补定时任务纪律（激活方式 / 最小间隔 / 与 `write_todos` 区隔——会话内待办用 todos、跨时间的自动化用定时）；③ 场景协议 sre（观察窗口纪律）/ finance（申报与整改节点）/ research（长周期课题）各补一条场景化纪律（编号顺延）。
- **影响面**：8 角色 tools 字段 + 3 项与正文职责句；`agents/_protocol.md` + 1 条；3 个场景协议各 + 1 条；无角色职责边界、人设与 handoff 变化。
- **测试**：新增 `m35-schedule-bindings.test.ts`（11 断言：白名单可达性 / 持有者集合精确匹配 / 非绑定角色抽查 / deferred 与只读契约 / 正文·全局·场景三处引导在场 / 运行时绑定 / plan 范式收敛）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；server typecheck 0 错误。

### v18 — 全角色工具白名单补入画布创作四件套（M31）

- **动因**：M31 无限画布与媒体创作工作台上线（会话级画布 Tab / 脑图工坊 / 媒体生成面板），新增 4 个工具 `canvas_read` / `canvas_write` / `media_generate` / `media_video`；协作与创作能力为场景无关，按可达性纪律补入全部 68 角色 tools 白名单（含后续里程碑新增角色）。
- **工具语义**：`canvas_read` 读画布摘要（节点 / 连线 / 单节点详情）；`canvas_write` ops 批量写入（add_node / update_node / remove_node / connect / remove_edge，经 CanvasStore 版本化落盘并广播前端合流）；`media_generate` 文生图・图生图；`media_video` 文生・图生・首尾帧视频。四者 `tier=deferred`（经 `tool_search` 检索激活，渐进披露）。
- **护栏**：媒体创作以「会话显式绑定媒体连接」为最小权限前提——未绑定 / 未声明能力时工具返回「去连接中心绑定」引导（与画布生成面板同一纪律）；任务可见可取消（生成面板进度 / 取消 / 再生成），生成量由用户控制；输入素材限定工作区相对路径且必须真实存在；媒体任务「创建即返回」（异步长任务不经工具通道同步等待），产物落位由任务 canvasTarget 驱动前端自动放置。
- **影响面**：68 角色 tools 字段统一追加 4 项（插入于 `load_skill` 前）；无角色职责、协议与人设正文变化。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；server typecheck / lint 0 错误。

### v17 — 全角色头像重设计：风格化 3D 卡通（68 张）

- **动因**：后续批次新增角色面部同模（同一「大眼 + 光滑脸 + 微笑」模板），「很多脸都长的一样」；全量升级为更卡通、更可辨的第二版形象系统（风格与设定表见 design.md §19）。
- **风格升级（v2）**：从「准写实 3D 电影质感」重设计为「风格化 3D 卡通」——成人比例（约 1:4 头身，非 Q 版）、五官圆润简化、眼神略夸张、哑光黏土质感、色彩明快；统一纯白底 + 半身构图（头部占画面高约 55%）+ 柔和棚拍光，16–96px 小尺寸可辨识性提升。
- **脸部差异化**：以「年龄 × 性别 × 脸型 × 发色发型 × 眼镜 / 胡须 × 肤色 × 职业道具」七维设定逐一区分（68 角色设定表已同步 design.md §19.3）；西式命名角色保持欧美面孔、中文命名角色保持东亚面孔，年龄带 24–52 岁错开。
- **覆盖范围**：17 场景 68 张全量替换（含 M32 新增 sre/江屿——炭灰技术卫衣 + 青柠挂饰 + 脉冲监控手持终端，替换 v16 初版形象）；无图 / 加载失败仍回退渐变 + 图标，回退链不变。
- **资产与备份**：512×512 PNG（1024px 生成后压缩）；`agents/<场景>/<id>/avatar.png` 自动发现与 `/api/agents/:id/avatar` 直出不变；旧头像备份于 `data/avatar-backup-2026-09-17/`（本仓无 Git，替换不可逆，清理前先确认范围）。
- 评测：mock 15/15 ✅（与基线无回归；头像为静态资产、不入提示词）；check:agents 17 场景 / 68 角色通过；client 头像组件测试 5/5 全绿。

### v16 — SRE 场景与 SSH 事故响应管道（M32，+1 角色 / +1 场景）

- **新场景 sre（站点可靠性）**：单角色编制「江屿（SRE 工程师 / Site Reliability Engineer，temperature 0.3）」——把 M23 已建成的 SSH 远程执行能力（会话绑定 / allowExec 开关 / 审批门 / 30s 超时与输出截断）组合为 **生产事故响应管道**（分级 → 止血 → 证据采集 → 定位 → 修复验证 → 复盘）；交付件 `docs/事故复盘-<主题>.md`（时间线含证据出处）与 `docs/可靠性方案-<主题>.md`（SLI / SLO / 容量）；与 devops（发布交付）/ backend（代码修复）/ qa（回归验证）职责切割（运行态保障归 sre、变更交付归 devops、代码修复归 backend、回归验证归 qa）。
- **工具白名单（运行态只读边界）**：`ssh_exec`（远程诊断核心通道）+ `run_command` + git 只读三件套 `git_status` / `git_diff` / `git_log`（变更定位；不含写类——SRE 不提交代码）+ 文件集 + `calc` / `date_calc` / 检索 + 协作基线；handoff `[devops, backend, qa]`；不持 `db_*`（取数归 bi 场景）。
- **场景协议 `sre/_protocol.md`**（第五个场景协议）：七条铁律 + 协作三条（证据先行 / 止血优先变更报批 / SSH 使用纪律 / 变更即可疑 / 时间线纪律 / 复盘无责 / 数据安全脱敏 / 分工 / 与 development 交接 / 数据丢失风险先 @用户）；含 `ssh_exec`「先 `tool_search` 激活」的引导条（deferred 工具在角色正文 / 协议 / 技能三处引导）。
- **新技能 incident-response**（41 技能库）：事故响应手册——SEV1-3 分级表 + 五步响应 + SSH 诊断命令库（systemctl / journalctl / df / free / dmesg / top / ss / curl / lsof）+ 定位检查表 + 时间线与度量（MTTD / MTTA / MTTR）+ 无责复盘模板 + SLO / 错误预算基础 + 反模式；sre 预载 `[incident-response, debugging]`（debugging 复用 M29 缺陷定位六步法）。
- **预设 +1**：incident-response（线上故障响应：sre 止血 → devops 回滚 → backend 修复 → qa 回归），预设 11 → 12 条。
- **图标注册表 +1**（avatar-icons.ts）：activity；sre 头像 512×512 3D 卡通（深色夹克 + lime 内搭 + 手持监控仪表盘笔记本，主题色 lime `#84cc16`）。
- **测试**：新增 `m32-sre.test.ts`（16 断言：白名单可达性 / 只读边界 / deferred 契约 / 运行时绑定与范式收敛 / 方法论文档在场 / devops 发布通道不回退）；`m21.test.ts` 适配 17 场景 / 68 角色 / 12 预设 / 场景协议断言 +sre。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 17 场景 / 68 角色通过；check:skills 41 技能；server + client 测试全绿。

### v15 — BI 场景与 NL2SQL 取数管道（M30，+1 角色 / +1 场景）

- **新场景 bi（商业智能）**：单角色编制「沈析（BI 分析师 / BI Analyst，temperature 0.3）」——把 M22/M23 的数据库连接能力（连接中心 / 只读护栏 / 审批门）与 M21 业务工具（csv_analyze / calc）组合为 **NL2SQL 取数管道**（口径 → 库表探索 → SQL → 校验 → 解读）；交付件 `docs/BI分析-<主题>.md`（附录含 SQL 原文与口径，可复现）；与 insight（经营解读）/ finance（财务口径）/ data-engineer（管道治理）职责切割（取数归 bi、解读归 insight、治数归 data-engineer、财务口径归 finance）。
- **工具白名单（只读取数）**：db 只读三件套 `db_list_connections` / `db_schema` / `db_query`（不含 `db_execute`，与 qa 同先例）+ 文件集 + `csv_analyze` / `calc` / `date_calc` + 协作基线（`handoff` / `remember` / `request_approval` / `write_todos` / `load_skill`）；handoff `[insight, finance, data-engineer]`。
- **场景协议 `bi/_protocol.md`**（第四个场景协议）：取数纪律六条铁律（口径先行 / 只读取数 / SQL 纪律 / 结果校验 / 数据安全脱敏 / 可复现）；含 db 工具「先 `tool_search` 激活」的引导条（deferred 工具在角色正文 / 协议 / 技能三处引导）。
- **新技能 nl2sql**（40 技能库）：NL2SQL 取数手册——六步法 + SQL 生成规范（显式列 / JOIN 验键 / 时区 / LIMIT）+ 执行校验清单（行数 / 交叉 / NULL / 去重 / 单位 / 边界）+ 常见陷阱表 + 工具衔接；bi 预载 `[nl2sql, data-visualization, spreadsheet-modeling]`。
- **预设 +1**：data-briefing（数据快报：bi 取数 → insight 解读 → finance 核口径），预设 10 → 11 条。
- **图标注册表 +1**（avatar-icons.ts）：database；bi 头像 512×512 3D 卡通（粉西装 + 手持图表平板，主题色 pink `#ec4899`）。
- **测试**：新增 `m30-bi-nl2sql.test.ts`（12 断言：白名单可达性 / 只读边界 / deferred 契约 / 方法论文档在场）；`m21.test.ts` 适配 16 场景 / 67 角色 / 11 预设 / 场景协议断言 +bi。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 16 场景 / 67 角色通过；check:skills 40 技能；server + client 测试全绿。

### v14 — 全域扩展：生活场景与职能角色（+32 角色 / +6 场景）

- **场景与角色扩张**：9 场景 34 角色 → **15 场景 66 角色**。① 生活侧新增 6 个场景（health 健康生活 / learning 学习成长 / travel 出行旅行 / wealth 财富管理 / home 家庭生活 / personal 个人管理）与 14 角色（fitness / nutrition / wellness / tutor / language / reading / travel / wealth / chef / home / pet / parenting / coach / life-admin）；② 工作侧补位 18 角色：研发与产品（ux-researcher / ux-writer / ai-engineer / data-engineer / security / tech-writer）、商业洞察（insight）、市场增长（ads / pr / social / video / influencer / localizer）、销售客户（bd）、组织人事（hr / trainer）、合规与知产（compliance / ip）。全部四段骨架并新增 32 种不重叠交付件（如训练计划 / 学习计划 / 行程计划 / 人事方案等），统一 `docs/<文档类型>-<主题>.md`。
- **默认编制保持核心主路径**：六场景 chain 不变（chain = 建会话默认预选 + 接力主路径，纳入全部新角色会使默认会话过重并打散接力叙事）；新角色经「成员微调」按需勾选；生活 6 个新场景 chain = 全成员。
- **预设扩至 10 条**：新增 health-sprint（健康打卡方案）/ learning-season（学习成长季）/ trip-planning（出行规划）/ growth-localization（出海本地化）。
- **白名单可达性**：新角色 tools 均含 `handoff`（对齐 M29 协作基线，66/66）；生活角色不硬配技能预载（39 技能库均为工作向方法论，按需 `load_skill`），travel / wealth 例外（spreadsheet-modeling / financial-modeling）。
- **图标注册表 +23**（avatar-icons.ts）：megaphone / message-circle / video / star / globe / users / clipboard-check / stamp / dumbbell / apple / moon / graduation-cap / languages / piggy-bank / utensils / house / paw-print / baby / brain / calendar-check / heart-pulse / plane / coins。
- **新头像 32 张**（512×512，统一 3D 卡通风格；缺失时回退 gradient + icon）。
- **测试夹具适配**：context 端到端验收夹具预算 10k → 12k（M29 新增 development 场景协议后系统层实测 ~9.8k，10k 已无窗口余量）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 15 场景 / 66 角色通过；server 604 + client 373 测试全绿。

### v13 — 研发场景能力强化与编码代理能力基线（M29）

- **可达性修复**：`handoff` 补入全部 34 角色白名单（此前零绑定——ADR 2 的「工具优先、文本 @ 回退」在 execute 范式下实际只剩文本回退，`reason` / `expected_output` 指派闭环与多目标 fan-out 从未在真实运行中触达）；`remember` 补入研发 7 角色（对齐其余 6 场景与协议 `<context_semantics>`）。白名单语义不变：先定可发现范围，`tier='deferred'` 只影响初始可见性。
- **研发 7 角色能力矩阵**（ADR 55）：pm + `calc` / `date_calc`（排期与指标口径）；designer + 浏览器只读子集（`browser_open` / `navigate` / `snapshot` / `screenshot` / `console` / `wait` / `close`，走查取证不操作页面）；frontend / backend + `run_command` + 写类 git（`git_branch` / `git_commit`，审批门）；qa + `run_command` + db 只读三件套（`db_list_connections` / `db_schema` / `db_query`，不含 `db_execute`）；devops 补齐 `remember` / `handoff`。职责边界不变：designer 只「看」、qa 只「查」、发布仅 devops。
- **场景协议**：新增 `agents/development/_protocol.md`（六条工程纪律：代码改动纪律 / 共享文件所有权 / 验证闭环 / 缺陷回交 / 提交与发布纪律 / 依赖与配置纪律）。
- **技能层**：新增 `skills/debugging`（缺陷定位六步法，预载 frontend / backend / qa）；`code-review` 升级为完整评审手册（六组清单 + 严重度口径 + 输出模板，维持按需加载）；技能库 38 → 39。
- **零工具代码改动**：全部为授权接通与资产更新；`run_command` 仍受 `ALLOW_RUN_COMMAND` 开关 + 审批 + 白名单前缀三重约束；默认命令白名单不扩展（`npx <任意包>` 供应链风险，改用 package.json scripts）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 39 通过；新增 `server/tests/m29-code-bindings.test.ts` 可达性断言；server 604 + client 373 测试全绿（context 预算夹具随系统层扩容上调 10k→12k：39 技能索引 + development 场景协议约 1.2k 后系统层约 9.8k）。
- 相关文档：design.md §45、ADR 55、agents/README.md「研发场景能力基线」、`development/_protocol.md`。

### v12 — 数据库与 SSH 工具对 Agent 开放（可达性修复 + SQL 护栏加固）

- **可达性修复**：`backend` 白名单新增 `db_list_connections` / `db_schema` / `db_query` / `db_execute` 四个数据库工具，`devops` 新增 `ssh_exec`。此前 34 角色零绑定（`agents/` 全目录无 `db_*` / `ssh_exec` 引用），M22 / M23 建成的 Agent 侧能力（会话绑定 + 只读护栏 + 允许写入 / 允许执行开关 + 审批门）从未真正接通；对齐分工：backend = 数据模型与 SQL 实现（先 `db_schema` 核对表结构再写查询），devops = 运行手册与日志排查（`ssh_exec` 查看服务状态 / 拉取日志 / 部署脚本）。其余 32 角色白名单不变；plan / review 范式下 `db_*` 只读工具按只读集合自动可见。
- **SQL 护栏加固**（`guard.ts`，三项绕过修复）：① 危险关键字匹配大小写不敏感（此前小写 `delete` / `into` 等可绕过骨架检测，在「允许写入」连接上经 `db_query` 免审批执行写）；② PRAGMA 赋值判定覆盖任意大小写与括号赋值形式（`pragma writable_schema=1` / `PRAGMA journal_mode(wal)`），只读名单外一律按写拒绝；③ MySQL / MariaDB 可执行注释（`/*!` / `/*M!`）内容改为按代码参与分析（服务器会真实执行，不得当普通注释剥离）。
- **纵深防御**（`manager.ts`）：`mode='query'` 恒按只读执行——即使连接开启「允许写入」，也只读事务（PostgreSQL `BEGIN READ ONLY` / MySQL `START TRANSACTION READ ONLY`）/ 执行层写拒绝兜底，`db_query` 的只读契约不再依赖单一护栏。
- **可观测性**（`sqlite.ts`）：SQLite 只读打开失败回退读写打开时输出告警日志（此前静默降级）；清理 `mysql.ts` 两处死导入（lint 警告）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38 通过；server 546/547（唯一失败为 M27 外部 MCP 迁移计数遗留，与本批无关）+ client 343 全绿（新增 m22 护栏绕过回归 + m21 backend/devops 绑定断言）。

### v11 — 浏览器工具对 Agent 开放（M22 可达性补强 + 控制台采集）

- **可达性修复**：`qa` / `frontend` 白名单新增 13 个 `browser_*` 工具。此前 34 角色零绑定——`webapp-testing` 技能以「若工具未接入」降级描述等待接入，从未真正接通；本次接通后定位：qa = 浏览器自动化实测（功能验证 / 缺陷复现 / 截图取证），frontend = 页面改完自测。其余 32 角色白名单不变；plan / review 范式下按只读集合自动可见 `browser_snapshot` / `browser_console`。
- **控制台能力补齐**（此前完全缺失）：浏览器会话采集 `Runtime.consoleAPICalled` / `Runtime.exceptionThrown` / `Log.entryAdded` → 环形缓冲（`console.clear` 与主帧导航清空），新增只读工具 `browser_console`（level / limit 过滤，输出 `[时间] [级别] 文本`）——Agent 排查页面报错、验证前端脚本行为的第一手段。
- **输入链路缺陷修复**（session.ts）：① `fill` 全选清空失效——带修饰键的 'a' 误走 `insertText` 插入字符，从未触发 Meta/Ctrl+A（修正为带修饰键走 `dispatchKeyEvent`）；② `type='char'` 只触发 keypress 不触发 keydown 监听器（React onKeyDown / 表单 Enter 提交会漏，改走 keyDown + text）；③ `fill submit` 缺 keyUp（补成对 keyDown/keyUp）；④ `press` 键名大小写不敏感（'enter' → Enter）。
- **工具行为对齐**（browser.ts）：`browser_open` 复用已有会话时按目标 URL 对齐（此前 `startUrl` 被静默忽略，Agent 以为打开了新页面）；`browser_snapshot` 新增 `include_text`（读页面正文文本，读长文 / 列表不用 `browser_eval`）。
- 技能同步：`skills/webapp-testing/SKILL.md` 侦察步骤补 `browser_console`（页面报错先看控制台）与 `include_text` 用法；工具族清单补 `browser_console`。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38 通过；server 497 + client 343 测试全绿（新增 `tests/browser-console.test.ts` 16 条回归 + qa/frontend 绑定断言）。

### v10 — 协作范式（规划 / 执行 / 评审）与计划审批（M24）

- `_protocol.md` 新增 `<paradigm_modes>` 协议段：三范式契约，**与角色正交**、工具白名单即范式边界（看不见 `write_plan` 说明本轮不是规划范式）、Agent 无权重自行切换。规划（plan）范式只读 + `write_plan` —— 提交后本回合挂起等待用户批准 / 驳回，驳回按反馈修订后重提（新版本并再次等待），批准后引擎按步骤负责人派发；评审（review）范式只读 + `submit_review` —— 对 `plan:` / `step:` / `artifact:` / `message:` 目标给出 pass / conditional / fail 判定与发现、证据，fail 阻塞对应步骤或计划（修复后可复审）；执行（execute）范式为默认零差异行为，收到「你负责的计划步骤」时用 `update_plan_step` 汇报进度（blocked 必须给 note），全部步骤完成 / 跳过后计划作者获得一次收口回合。
- `agents/README.md` 新增「协同范式（M24）」小节：触发规则（显式 opt-in——Composer 消息级选择 > 会话「规划先行」开关 > 计划步骤声明 mode > 默认 execute）；34 个 AGENT.md 无需逐个修改（范式与角色正交，registry 白名单交集自动生效：plan / review = 只读工具 ∪ `write_plan`|`submit_review`，写工具与审批门自然不触发）。
- 评测：mock 15/15 ✅（与基线无回归）；check:agents 34 / check:skills 38；server 469 + client 332 测试全绿；E2E 26 条全绿（新增 m24-plan 2 条）。
- 相关文档：design.md §40 / §41、ADR 48 / 49、docs/api.md §3.1、agents/README.md「协同范式」。

### v9 — 技能库扩展：外部源适配 + 全角色预载（M23）

- 技能库 9 → 38（新增 29）：① 官方与社区源适配 25 个职能技能（skill-authoring ← skill-creator、deck-authoring ← pptx、formal-document ← docx、spreadsheet-modeling ← xlsx、comms-writing ← internal-comms、brand-system ← brand-guidelines、visual-design ← canvas-design、doc-coauthoring / webapp-testing / frontend-design / mcp-server-building 等）；② UI 四件套（design-system / interaction-motion / ui-review ← Vercel 界面指南 + AccessLint、react-performance ← Vercel react-best-practices）；业务向技能（销售 / 客服 / 招聘 / 采购 / SEO 等）来自社区职能库。pdf 技能因无二进制解析能力弃用。
- 34 角色全部显式配置 `skills:`（1–4 个/角色）：research 4 角色共用 deep-research 底线；designer 四件套（visual-design / design-system / interaction-motion / ui-review）；frontend 增 react-performance；qa 增 ui-review；marketing 组 content-marketing 显式化继承（brand 改配 brand-system + visual-design）；组 `defaultSkills` 仅作兜底。
- 存量复检：13 个技能文件补工具兜底（如 recruiter / supply 无 date_calc → 「如可用」；webapp-testing 未接入浏览器 → 人工步骤单降级模式）。
- 技能纪律：单文件中文 60–150 行；只引用真实工具与 Markdown 容器（::: kpi / timeline / mail / option / cols / details、chart / mermaid）；交付路径统一 `docs/<文档类型>-<主题>.md`。
- 断言同步：`tests/m21.test.ts` 技能断言更新为新映射；`tests/context.test.ts` 预算夹具 6k → 10k（38 技能索引 + pm 预载后系统层实测 8.3k）。
- 评测：mock 14/14 ✅（与基线无回归）；check:skills 38 / check:agents 34 / server 369 + client 258 测试全绿。
- 相关文档：design.md §37、ADR 45、agents/README.md「技能库与预载」。

### v8 — OPC 业务场景扩展与业务工具纪律（M21）

- 新增 6 个业务场景（strategy 商业战略 / marketing 市场增长 / sales 销售客户 / finance 财务法务 / ops 运营行政 / funding 融资资本）与 19 个角色（全局 9 场景 34 角色）；全部四段骨架，交付契约统一 `docs/<文档类型>-<主题>.md`（经营简报 / 商业分析 / 定价方案 / 增长方案 / 内容日历 / 搜索投放 / 品牌规范 / 销售话术 / 客户成功 / 客服手册 / 财务测算 / 税务清单 / 合同审阅 / 运营SOP / 会议纪要 / 招聘方案 / 供应链方案 / 融资材料 / 投资人简报），与 mock 剧本 / 评测基线三方对齐。
- `_protocol.md <tool_policy>` 新增业务纪律四条：金额 / 比例 / 利率必须 `calc`（禁止心算）；日期与排期必须 `date_calc`；表格数据必须 `csv_analyze`（禁止目测汇总）；合同 / 报价 / 邮件等批量文档走 `template_fill`。
- 场景协议：`strategy/_protocol.md`（例会纪律：数字口径以 finance 为准 / 方案带成本与优先级 / 决策记录留痕）与 `finance/_protocol.md`（合规红线：不背书法律意见 / 风险三级标注 / 敏感信息不外发 / 不臆造法规条款）。
- 灵魂 4 个：chief advisor（谋士）/ steward（管家）、content muse（灵感）/ data（数据派）；技能 4 个：business-review / content-marketing（marketing 场景 defaultSkills）/ financial-modeling（finance、tax、pricing 预载）/ contract-review（legal 预载）。
- 快速组队预设资产 `agents/_presets.yaml`（6 条跨场景编制：周经营例会 / 内容营销战役 / 产品发布冲刺 / 报税合规检查 / 融资冲刺 / 外包与招聘）；`check:agents` 增加预设校验与清单打印。
- 新头像 19 张（统一提示词模板批次生成，512×512）；生成失败回退 gradient + icon。
- 评测：mock 14/14 ✅（新增 13-opc-weekly-review / 14-content-campaign 两个 golden 任务；baseline 12 → 14）

### v7 — 逐角色专业化设计（职责 / 方法 / 交付契约 / 协作接口）

- 全部 15 个角色（development 7 + brainstorm 4 + research 4）人设正文升级为四段骨架：`## 职责`（含职责边界）→ `## 工作方式`（可执行步骤与决策规则）→ `## 交付契约`（产物路径 + 章节结构 + 完成定义）→ `## 协作接口`（上游 / 下游 / 升级路径）；front-matter 的 description / capabilities 同步专业化。
- 交付件路径规范化并与 mock 剧本 / 评测基线对齐：`docs/<文档类型>-<主题>.md`（需求 / 架构设计 / 交互设计 / 接口设计 / 测试计划 / 创意方案 / 点子池 / 红队报告 / 评分矩阵 / 研究报告 / 交叉分析 / 核查记录）、`deploy/部署说明-<主题>.md`、`web/src/README-实现说明.md`、`docs/来源清单.md`；补齐此前缺失的独立交付件约定（点子池 / 红队报告 / 评分矩阵 / 交叉分析 / 核查记录，保证并行波不写同一文件）。
- 方法论细节新增：pm 用户故事与优先级口径；architect 架构驱动与决策记录（背景 / 决策 / 后果）；designer 状态矩阵与可访问性底线；frontend 接口对接与自测清单；backend 端点四类响应与安全约定；qa 必测五类与发布判定；devops 环境矩阵与渐进发布；brainstorm 停车场机制与 ICE 信心校准；research 证据分级与引用对照。
- backend `skills: [api-design]` 预载（接口契约主责）；其余角色维持按需 `load_skill`。
- `agents/README.md`：正文骨架规范升级，新增「交付件命名规范」小节；brainstorm / research 场景协议「交付」节补充成员独立交付件清单。
- 评测：mock 12/12 ✅（与基线一致，无回归）

### v6 — 联网检索授权与反爬协议（M20）

- 新增 `web_search` 工具（百度检索，双模式：官方 API / 结果页抓取 + 反爬）：6 个持有 `web_fetch` 的角色（architect / backend / devops / frontend / qa / scout）同步授权。
- `_protocol.md <tool_policy>`：新增联网规则——获取外部资料先 `web_search` 再对具体页面 `web_fetch`（限白名单）；未启用 / 被风控拦截 / 被拒时不反复重试，如实说明限制并改用工作区材料。
- `research/_protocol.md`：「来源可追溯」与「无外网检索条件」口径纳入 `web_search`（含被风控拦截的降级路径）。
- scout 人设：检索流程改为「先 `web_search` 拿候选来源 → 对白名单域名再 `web_fetch` 抓正文」；抓取/检索失败如实记录不编造。
- 评测：mock 12/12 ✅

### v5 — Agent 包化与多场景扩展（M15–M18）

- 目录重构：`prompts/*.md` 平铺 → `agents/<场景>/<agent>/` 自包含包（AGENT.md + souls/ + avatar.png），新增 `agents/README.md` 操作手册；`migrate:agents` 幂等迁移，`check:prompts` 升级为 `check:agents`（旧名保留别名）；加载器双轨回退一个版本周期。
- 场景分组：新增 `brainstorm`（头脑风暴，4 角色：facilitator / ideator / challenger / refiner）与 `research`（深度研究，4 角色：lead / scout / analyst / verifier）；`_group.yaml` 场景元数据（chain / parallel / rounds / defaultSkills）。
- 协议分层：全局协议 + 场景协议（`<scene_protocol>` 追加在全局之后）+ 灵魂层（可选）；全局协议新增 `<parallel_waves>` 并行协作约定与 `<soul_priority>` 灵魂优先级护栏。
- 灵魂层：ideator `wild` / `zen` / `scholar`（默认 wild）、facilitator `energetic`、qa `strict` / `friendly`（默认 strict）；会话内可 PATCH 随时换装（成员事件条可见）。
- 新技能：`brainstorm-facilitation`（发散引导 + ICE 打分）、`deep-research`（研究流程 + 来源与置信度规范）。
- 新头像：8 张 AI 生图形象照（白板马克笔 / 灯泡 / 靶心 / 清单 / 地图 / 望远镜 / 图表 / 放大镜+印章），与前 7 张同风格。
- 评测：mock 脚本覆盖 15 角色（含灵魂风格变体与并行剧本）；golden 任务扩展到 12 个（brainstorm / research 各 1 个，详见 evals/）。

### v4 — 工具与安全语义补齐（M5–M7）

- `_protocol.md <tool_policy>`：补充「覆盖写优先 apply_patch/edit_file、`dry_run` 预览、敏感文件拒绝不绕路、高风险操作走审批、被拒后不重试同一动作、repo/worktree 模式先 `git_status`」。
- `_protocol.md <safety>`：补充 `git_restore` 仅限单文件、禁止 `git push` / 强制重置 / 越界访问。
- 评测：mock 10/10 ✅ · judge 待跑（无外网模型 key）

### v3 — 记忆与压缩语义（M2）

- `_protocol.md` 重写为标签分层：`<role_contract>` / `<collaboration_rules>` / `<context_semantics>` / `<output_contract>` / `<tool_policy>` / `<safety>`。
- 新增 `<context_semantics>`：明确「历史会被摘要替代；关键约束/口径/决策必须 `remember` 或写入文件」。
- `<tool_policy>` 写入反模式：大文件分页读、先 `grep` 再 `read`、小改用 `apply_patch`、不重复读自己刚写的文件。
- 新增 `remember` / 技能加载 / 工具报错自我修正（连续两次失败换思路）规则。
- 评测：mock 10/10 ✅（基线初建于本版本之后）

### v2 — 交付件主通道（M6）

- `<tool_policy>`：明确「正式成果用 `write_file` 写入工作区、相对路径、先看后写避免覆盖他人成果」。
- repo / worktree 模式提示接入工具集（`git_status` / `git_diff` / `git_commit`）。
- 评测：未留档（评测框架 v4 起建立）

### v1 — 初始版本

- 单文件 `_protocol.md`（协作协议）+ `agents/<role>.md`（7 角色人设：pm / architect / designer / frontend / backend / qa / devops）。
- 转交规则：行首 `@id` / `@名字`；交还用户 `@用户`；不 @ 自己、不空转。
- 校验：`npm run check:prompts`（front-matter 与结构校验，CI 常驻）

## 当前基线

| 项 | 值 |
| --- | --- |
| 基线文件 | `evals/baseline.json` |
| 模式 | mock（确定性断言，CI 常驻） |
| 结果 | 22/22 通过（22 个 golden 任务） |
| 运行方式 | `npm run eval`（回归则非零退出码） |
| 刷新基线 | `npm run eval -- --update-baseline` |
| judge 评分 | `npm run eval -- --judge`（需 `LLM_API_KEY`，手动 / 夜间） |
