# ADR 0111：命理占星协议——传统数术 · 星象占星（含排盘工具四件套）（M51-E）

- 状态：Accepted
- 引入：M51-E
- 相关：[design.md §65](../design.md)、[docs/scene-expansion-design.md](../scene-expansion-design.md)、[agents/metaphysics/_group.yaml](../../agents/metaphysics/_group.yaml)、[agents/astrology/_group.yaml](../../agents/astrology/_group.yaml)、[server/src/tools/pan.ts](../../server/src/tools/pan.ts)（工具注册）、[server/src/pan/](../../server/src/pan/)（计算模块：bazi / ziwei / natal / gua）、ADR 0108 / ADR 0109 / ADR 0110（同批先例）

## 背景

- 场景生态扩展（§5.5）判定「传统文化」方向全空白：传统数术（八字 / 紫微 / 六爻 / 大六壬 / 梅花 / 七政 / 奇门）与西方占星均无承接场景；且此类需求的最大风险是高发失败模式——恐吓话术、付费化解暗示、越界结论性建议（医疗 / 投资 / 婚育 / 生死）；
- 与一般「聊天式」文化问答不同，术数研习的核心可信度来自「先盘后论」：盘面必须由工具精确计算（干支 / 星历 / 卦爻），过程可复查、参数可复现——凭空编造盘面是本质性问题；
- 盘面数据量大（四柱十神 / 十二宫 / 行星相位矩阵 / 卦爻装卦），需要结构化呈现（Markdown 容器）而非纯文本堆叠，才能在对话流中被快速阅读与交叉引用。

## 决策

1. **两条领域协议**（写进两份 `_protocol.md`，各 11 条 = 铁律 7 + 工具纪律与协作 4）：`metaphysics`「表述纪律 + 排盘可验」（文化研习与参考定位，不承诺预测准确率；医疗 / 投资 / 法律 / 婚育 / 生死不做结论性建议；禁止恐吓话术与付费化解暗示；结论给「参考区间」不给「必然」；先出盘后解读，禁止心算排盘或编造盘面；术语白话；生辰隐私；时辰存疑给敏感度说明；未工具化门类显式声明；起卦种子可复现）；`astrology`「盘面为据 + 参考不给宿命」（挑战性相位表述为「课题与成长点」；时区显式、高纬降级等宫制如实告警；时间不确定标注「上升与宫位敏感」；合盘需双方知情前提、不做关系走向断言；行运给时间窗不断言事件）；
2. **排盘工具四件套**（注册于 `server/src/tools/pan.ts`，计算模块在 `server/src/pan/`）：`bazi_pan`（四柱 / 十神 / 藏干 / 五行 / 大运流年 / 真太阳时校正告警；lunar-typescript）、`ziwei_pan`（十二宫 / 主星辅星 / 四化 / 五行局 / 大限；iztro）、`natal_pan`（行星 / 宫头 / 相位矩阵 / 四轴；astronomy-engine + 自研 Placidus 与相位算法）、`gua_pan`（六爻 / 梅花，规则代码化 + 种子可复现）；全部 tier=deferred（`tool_search`「排盘 / 命盘 / 星盘」激活）、纯计算只读无审批、失败结构化报错（禁心算兜底）；白名单配给两场景全员；
3. **`::: pan` 容器**（remark-ext 新增 builder + 客户端 PanCard 渲染，design §7.7 契约）：`::: pan <bazi|ziwei|natal|gua> [标题]` + `键：值` 字段行（→ `data-fields`）+ `- 键 | 值` 条目行（→ `data-items`）；降级链：流式直接渲染（同 verdict 档）/ 未知类型通用「盘面」徽标 / 解析失败保持原文；M52-B 升级 PanBoard；
4. **`metaphysics` 传统数术（7 角色）**：chain `[bazi, ziwei, liuyao, meihua, qizheng, daliuren, qimen]`、`parallel: true`（parallelMax 4，多术可同波并行、各自落盘）、order 118、icon `moon`、theme 玄墨金、`defaultSkills: [chinese-metaphysics]`——观复（四柱研习师，`docs/八字命盘-<主题>.md`）/ 星垣（紫微研习师，`docs/紫微命盘-<主题>.md`）/ 灼见（六爻研习师，`docs/六爻卦解-<主题>.md`）/ 溯机（大六壬研习师，`docs/大六壬课解-<主题>.md`）/ 心易（梅花研习师，`docs/梅花卦解-<主题>.md`）/ 步天（七政研习师，`docs/七政星盘-<主题>.md`）/ 奇正（奇门研习师，`docs/奇门局解-<主题>.md`）；
5. **`astrology` 星象占星（4 角色）**：chain `[natal, transit, synastry, horary]`、`parallel: true`（parallelMax 4）、order 120、icon `star`、theme 星夜蓝紫、`defaultSkills: [western-astrology]`——司辰（本命占星师，`docs/本命盘报告-<主题>.md`）/ 星移（行运占星师，`docs/行运报告-<主题>.md`）/ 合璧（关系占星师，`docs/合盘报告-<主题>.md`）/ 问星（卜卦择时师，`docs/择时报告-<主题>.md`）；
6. **技能 2 + 预设 3**：`skills/chinese-metaphysics`、`skills/western-astrology`（新建）；预设 `chart-combo`（命盘合参，order 240）、`oracle-crossread`（卦象互参，order 250）、`full-horoscope`（星盘全解，order 260）；
7. **跨场景 handoff**：`bazi ↔ ziwei`（命盘合参）、`liuyao ↔ meihua`（卦象互参）、`qizheng ↔ natal`（中西星盘互参）、`qimen → horary`（择时联动）；
8. **镜像面七件套**：mock.ts 四件套 ×11（SCRIPTS / artifactFor 与交付契约对齐 / DISPLAY_NAMES / preferredOf）+ `TOPICS` 演示词表 +1（「前程」尾部追加）+ `e2e/helpers.ts` AGENT_NAME +11（全量 114 角色 id→name 逐一相等）+ `m21.test.ts`（29 场景 / 114 角色 / 26 预设 / 协议断言 +2 / 排盘工具绑定 it）+ README / CHANGELOG；
9. **stage 预写（M52-B 消费）**：两场景均 `{layout: dock, panel: chartboard}`（多盘 tab / 轮盘 + 相位表）；schema 非 strict，形态消费端 M52-B 实现。

## 理由

- **工具先行是「排盘可验」的物质基础**：四件套把干支 / 星历 / 卦爻计算固化为纯函数（golden 案例 21 例锁定参考值），协议只解决「何时必须用」；先工具后话术——没有工具就没有可信盘面；
- **deferred + 白名单沿用「专业域工具」成熟模式**（fin_* 先例，ADR 0066）：工具中心无噪音、按激活词检索、只读无审批——与本场景零副作用性质一致；
- **容器是盘面的对话流形态**：`::: pan` 把工具输出摘要结构化为字段行 + 条目行，避免大段纯文本；降级链与既有一致（未知类型 → 通用徽标、解析失败 → 原文），流式期间直接渲染（同 verdict 档）；
- **并行按「术数门类无依赖」定**：八字与紫微是同源不同视角、六爻与梅花是两种起卦法，各自落盘后由用户点名者收口，不需要串行依赖；七政 / 大六壬 / 奇门 v1 未工具化，对话推演 + 显式精度声明；
- **两条红线对应文化类内容的两个「最大坑」**：恐吓话术与越界结论（表述纪律）、编造盘面冒充计算（排盘可验）。

## 被否决的方案

- **不做排盘工具、纯对话推演**：盘面数据（干支 / 星历 / 相位）人工心算必然出错且不可复查，「先盘后论」无从谈起——可信度归零；
- **排盘工具设为常驻（非 deferred）**：11 个角色 × 4 工具的 schema 常驻会污染全部会话的工具清单；deferred + 激活词与 fin_* 一致且已被验证；
- **合并为一个「命理」场景（11 角色同场）**：中西方两个知识体系术语与口径差异大，同场会造成术语混战；分场景 + 跨场景 handoff（中西互参按需触发）保持两个独立心智；
- **为每个门类各建一个场景**：7 个术数门类共享「先盘后论 + 表述纪律」协议与大多数方法论，拆分为 7 个场景属过度切分——单场景 7 角色 + parallel 已覆盖；
- **塔罗纳入 astrology**：塔罗无星历 / 宫位计算体系，与占星盘面方法论不同源（已列入储备方向，不在本专项内）；
- **大六壬 / 奇门 v1 硬做排盘工具**：规则复杂度高、正确性无法在批次内充分验证——v1 对话推演 + 显式「未工具化、精度有限」声明，工具化留待后续；
- **`::: pan` 直接升级为 PanBoard 面板**：形态层属 M52 工作区体系专项——本批只落容器与基础渲染，声明预写、M52-B 统一消费。

## 适用与失效条件

- 适用：「专业域工具」模板（deferred + 激活词 + 白名单 + golden 案例）可复制到新的计算型门类；「领域协议红线 + 容器结构化输出」模式继续适用于文化研习类场景；跨场景 handoff 挂接中西互参模式继续适用；
- 失效条件：排盘库升级（lunar-typescript / iztro / astronomy-engine）导致 golden 参考值漂移时，须复核 `server/tests/m51-pan.test.ts` 并更新断言；M52-B 点亮 `dock` stage 后须复核两场景会话渲染（chartboard 面板替换预写声明）；`TOPICS` 演示词表再扩展须检查词序（detectTopic 顺序匹配，新词只能追加尾部）并跑全量 eval 复核零回归；
- 测试镜像面：`server/tests/m51-pan.test.ts`（golden 21 例：八字 / 紫微 / 星盘各 ≥3 例 + 卦固定种子）；`client/tests/m51-md-pan.test.tsx`（容器 10 例：四类型 + 降级链）；`server/tests/mock-coverage.test.ts`（全量角色守护自动纳入 11 新角色）；`server/tests/m21.test.ts`（29 场景 / 114 角色 / 26 预设 / 排盘工具绑定）；`evals/tasks/28-metaphysics.json`（3 回合链路 + 3 交付件 + turns_lte 4）。
