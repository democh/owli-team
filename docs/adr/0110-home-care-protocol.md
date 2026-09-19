# ADR 0110：生活安居协议——置业安家 · 家庭照护（M51-D）

- 状态：Accepted
- 引入：M51-D
- 相关：[design.md §64](../design.md)、[docs/scene-expansion-design.md](../scene-expansion-design.md)、[agents/housing/_group.yaml](../../agents/housing/_group.yaml)、[agents/care/_group.yaml](../../agents/care/_group.yaml)、ADR 0108 / ADR 0109（同批先例）

## 背景

- 场景生态扩展（§5.4）判定两类生活需求无承接场景：① 置业决策（选房 → 贷款 → 装修）散落在 home（日常家务）与 wealth（理财配置），无低频重决策的链式承接；② 家庭照护（照护方案 / 陪诊 / 康养）散落在 health（个人健康管理）——照护对象是「家人」且核心是事务协助而非健康干预，无边界明确的承接场景；
- 两条领域红线各锚定一类高风险失败模式：置业的「超出还款能力的方案与焦虑话术」、照护的「越界医疗判断（诊断 / 用药 / 解读报告）」；
- 两场景均为「低频重决策 / 长线陪跑」形态：需要串行链（后棒依赖前棒产出）而非并行拼盘。

## 决策

1. **两条领域协议**（写进两份 `_protocol.md`，各 11 条 = 铁律 7 + 工具纪律 2 + 交接 / 声明纪律 2）：`housing`「预算纪律」（首付来源与月供 / 收入比如实测算，不鼓励超还款能力方案，建议预留不低于 6 个月家庭开支的应急金；房价 / 利率 / 政策数值注明来源与时效，区分已发生数据与机构预测，不承诺涨跌不制造焦虑；选房按维度打分给排序与理由，拍板权在用户；认购书 / 购房合同关键条款提示逐条核对）；`care`「非医疗诊断」（不做诊断、不开药、不解读检查报告、不替代医生，涉及症状 / 用药 / 治疗方案一律「请遵医嘱」；陪诊边界只做「就医准备 + 过程记录」，医嘱以医生书面 / 当面说明为准只记录不加工；关注信号清单只列「值得留意的变化」与「出现以下情况请及时就医」，不出现病名推断与用药建议；照护方案必须包含照护者排班轮值与自我关怀（喘息安排））；
2. **`housing` 置业安家（3 角色）**：chain `[home-finder, mortgage-advisor, reno-designer]`、`parallel: false`（串行决策链：需求 → 测算 → 落地）、order 114、icon `map`、theme 砖橙——择邻（选房参谋，`docs/选房对比-<主题>.md`）/ 家树（房贷顾问，`docs/贷款方案-<主题>.md`）/ 筑居（装修规划师，`docs/装修方案-<主题>.md`）；
3. **`care` 家庭照护（3 角色）**：chain `[care-planner, care-escort, elder-advisor]`、`parallel: false`（串行照护链）、order 116、icon `heart-handshake`、theme 玫红——顾宁（照护规划师，`docs/照护方案-<主题>.md`）/ 陪安（陪诊助手，`docs/陪诊记录-<主题>.md`）/ 颐和（康养顾问，`docs/康养建议-<主题>.md`）；
4. **技能零新建**：两场景复用既有技能——housing 按角色预载 deep-research / spreadsheet-modeling / financial-modeling / visual-design；care 预载 process-improvement / doc-coauthoring / formal-document / source-verification（生活场景角色不硬配技能库，按需 `load_skill`）；
5. **预设**：`home-purchase`（择邻 · 家树 · 筑居，order 220）、`care-plan`（顾宁 · 陪安 · 颐和，order 230）；
6. **跨场景 handoff**：`mortgage-advisor → [wealth, legal]`（贷款方案延伸理财测算与合同核验）、`home-finder → [mortgage-advisor, reno-designer]`、`reno-designer → [home-finder, mortgage-advisor]`（装修超预算回交复算）；care 三成员回环（`care-escort` / `elder-advisor → care-planner`，陪诊与康养发现回流方案调整）；
7. **镜像面七件套**：mock.ts 四件套 ×6（SCRIPTS / artifactFor 与交付契约对齐 / DISPLAY_NAMES / preferredOf）+ `TOPICS` 演示词表 +2（「购房」「长辈」尾部追加）+ `e2e/helpers.ts` AGENT_NAME +6（全量 103 角色 id→name 逐一相等）+ `m21.test.ts`（27 场景 / 103 角色 / 23 预设 / 协议断言 +2）+ README / CHANGELOG；
8. **stage 预写（M52-B 消费）**：housing `{layout: dock, panel: board}`（对比矩阵 + 预算计算）、care `{layout: dock, panel: coach}`（照护排班表 + 就医清单）；schema 非 strict，形态消费端 M52-B 实现；本批零前端改动。

## 理由

- **串行按工序依赖定**：买房决策是链式推进——贷款方案依赖选房预算、装修规划依赖贷款后的资金总盘；照护同理——陪诊准备与康养建议围绕照护方案展开，三棒串行保证口径一致（先立总盘再算分项）；
- **两条红线对应两个领域的「最大坑」**：置业的超能力购房与焦虑营销、照护的越界医疗判断——协议第一条铁律即该领域最重护栏；
- **与相邻场景显式区隔（写入 _group.yaml description）**：housing ↔ home（日常家务 vs 置业专项决策）、housing ↔ wealth（理财配置 vs 购房负债测算）；care ↔ health（自我健康管理 vs 家人照护事务）；
- **复用成熟机制**：串行链 / handoff / stage 预写均为既有能力，零引擎 / 零前端 / 零容器改动；`TOPICS` 追加采用尾插法（detectTopic 顺序匹配，既有任务零回归）。

## 被否决的方案

- **housing 并入 home**：home 是三口之家的日常家务（做饭 / 宠物 / 育儿），置业是低频重决策——链路（选房 → 贷款 → 装修）与红线（预算纪律）完全不同，并场景会稀释两组心智；
- **housing 并入 wealth**：wealth 的目标函数是资产配置（收益 / 风险），购房是负债决策（月供承受力与居住约束）——「理财收益最大化」心智会污染「买得起、住得好、预算不失控」；
- **care 并入 health**：health 是「用户自己的健身 / 营养 / 身心管理」，care 的主体是家人（长辈）且核心红线是非医疗诊断——照护事务（排班 / 陪诊 / 适老化）不是健康干预；
- **care 增设用药提醒角色**：用药建议处于医疗红线的灰色地带，角色边界无法干净划分——3 角色（方案 / 陪诊 / 康养）边界清晰且覆盖完整；
- **housing 装修置链首（先定装修再算账）**：顺序错——装修预算的前提是贷款后的资金盘子，链序必须是「需求 → 测算 → 落地」；
- **care 主题词不做新增（复用「财务」等既有词）**：产物会生成「照护方案-财务.md」等不自然文件名；`TOPICS` 新增「购房」「长辈」使两场景六份产物路径全部通顺。

## 适用与失效条件

- 适用：「低频重决策链」模板（需求梳理 → 测算 → 落地）可复制 housing；「照护事务 + 非医疗边界」模板可复制 care；跨场景 handoff 挂接专项能力（wealth / legal）模式继续适用；
- 失效条件：M52-B 点亮 `dock` stage 后须复核两场景会话渲染（形态消费端替换预写声明）；`TOPICS` 演示词表再扩展须检查词序（detectTopic 顺序匹配，新词只能追加尾部）并跑全量 eval 复核零回归；
- 测试镜像面：`server/tests/mock-coverage.test.ts`（全量角色守护自动纳入 6 新角色）；`server/tests/m21.test.ts`（27 场景 / 103 角色 / 23 预设 / 协议断言）；`evals/tasks/26-housing.json`（3 回合链路 + 3 交付件 + turns_lte 4）、`evals/tasks/27-care.json`（3 回合链路 + 3 交付件 + turns_lte 4）。
