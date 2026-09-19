# ADR 0176：命理盘面深化（M63 全批）——八件套工具 · 五类新卡 · 全角色零空手 · 收口修复链

- 状态：Accepted
- 引入：M63 批一至批五 + F 收口（2026-09-19）
- 相关：docs/metaphysics-deepening-design.md（设计基线）· ADR 0111（M51-E 四工具先例）· ADR 0113（M53 卡契约）· ADR 0131（M54 盘面交互先例）· CHANGELOG v74

## 背景

命理占星场景（metaphysics 7 + astrology 4 角色）经 M51-E 后仍有四类缺口：占星行运 / 合盘角色无工具支撑（违反自身协议红线）、六壬 / 奇门 / 七政三角色空手、四件套盘面数据欠深（无神煞 / 流年层 / 伏神等）、前端盘面交互留白。设计文档（`docs/metaphysics-deepening-design.md`）全景盘点后立项「全量专家级」批。

## 决策

1. **工具八件套（全角色零空手）**：`bazi_pan` v2（神煞 18 / 柱间关系 / 运岁 / 小运 / `liuYueOf` 流月）、`ziwei_pan` v2（`horoscopeYear` 流年层）、`gua_pan` v2（伏神 / 月日关系 / 回头生克）、`transit_pan`（cross ≤6° + 扫描时点二分至分钟）、`synastry_pan`（cross ≤8° 对称去重 + 组合盘中点）、`daliuren_pan`（中气换将 / 四课 / 九宗门三传 / 十二天将 / 旬遁——720 例扫描九宗门全覆盖）、`qimen_pan`（拆补定局 / 地盘三奇六仪 / 值符值使 / 转盘天盘 / 八门飞宫 / 八神——基准例全盘手工验算）、`qizheng_pan`（七政同源星历 / 四余近似分级 / 十二宫 / 庙旺——命宫输出与真实上升逐字一致）。
2. **卡协议（零契约破坏）**：旧 kind 纯追加可选字段行与条目（字段行一律在条目区**前**）；新 kind 五类（transit / synastry / daliuren / qimen / qizheng）入 PAN_KINDS；必需门冻结（旧卡派生路径零改动）；未知 kind 仍回退表格。
3. **前端七视图**：BaziBoard / ZiweiBoard / GuaBoard 增强 + TransitWheel / SynastryBoard / DaliurenBoard / QimenBoard / QizhengBoard 新建；`--pn-cinnabar` 朱砂点缀 + 五类 kind 色相 + `.pn-seal` 印记（2 字口径缩写 · quiet-mode 隐藏 · aria-hidden）。
4. **口径一等公民**：各盘算法口径随卡面声明（六壬涉害归地 / 奇门拆补中宫寄坤 / 七政命宫生时推移 / 四余近似等级逐行）；争议口径不隐去不淡化；近似与工具输出不混同。
5. **F 收口修复链（实测发现）**：
   a) **CommonMark lazy continuation 救援**（remark-ext `finalizeFieldsAndItems`）：列表末条后紧邻段落行会被 mdast 并进末条 item——带来两类故障（末条 value 锚尾失配丢条目 / 尾段字段行不达 derive）。修复：条目值按首个 `\n` 截断、尾段逐行分派（字段行回收 fields / 其余保留段落）。此修复同时使六壬「课体 / 贵人 / 天将」与七政「庙旺」等**尾段字段行**恢复达位。
   b) **合盘行前缀固定 A / B**（`synastry_pan`）：自定义 label 时行前缀仍为 A/B（derive 依赖），卡内补「A = 甲 ｜ B = 乙」映射行。
   c) **数字年份宽容**：`liuYueOf` / `horoscopeYear` 收 number 或 string（模型常传数字，字符串专收会崩）。
   d) **E2E 四条 spec**（transit-synastry / daliuren-qimen / qizheng-bazi2 / ziwei-yearly，7 例全过）+ eval 任务 35（六壬×奇门 1/1）+ mock 落盘模板与话术同步工具化口径。
6. **编号让位**：CHANGELOG v74（v73 被 M39 占）；ADR 本号（0148/0175 依次被占）；eval 35（34 被风水占）；批次 M63（pk-game 让出为 M64）。

## 理由

- 工具化是合规红线的工程落点：「盘面数据必须出自工具、禁止心算」需要先有工具；
- 单口径锁定 + 卡面声明：争议流派（拆补 / 涉害 / 命宫算法）不追求唯一正确答案，追求**可复查的锁定口径**；
- 卡协议纯追加 + 必需门冻结：M51-M54 既有盘卡零回归（全部旧断言原样通过）。

## 被否决

- **多口径并行输出**（拆补 + 置闰同排）：v1 单口径 + 声明；**2026-09-19 续完善已落地**：拆补/置闰差异规则经三源考据（《易学象数论·超神接气直指》原文 + 分类文两篇）后实现**置闰对照口径**——检查点窗口（芒种/大雪「上元符头超前量 ≥9 日」超神九日 → 其后 15~30 天重复该节三元十五日；`zhirunOf` 自然历法判定、无历史依赖），`ding.zhirun` 仅两口径不同局时随卡输出「对照」行（探针验证 2022/2025/2027 置闰点、间隔 2-3 年与常识吻合）；跨年累积顺延为文档级口径（v1 窗口口径）；
- **心算兜底 / 「近似替代」表述**：与红线冲突——否决；
- **宽断言 E2E 免修**（对 lazy continuation 沉默）：其掩盖的是真实渲染缺陷（六壬盘此前不可达字段行）——以根因修复替代断言绕行。

## 影响

- 服务端：`pan/` 新增 bazi_extra / transit / synastry / daliuren / qimen / qizheng（+3 已有文件 v2）；`tools/pan.ts` 9 工具；`llm/mock.ts` 八组触发块 + 落盘模板同步；
- 客户端：`pan/` 5 新组件 + derive 五类新派生 + PanCard 印章；`remark-ext` 救援逻辑；
- 测试：server 51 新例 + client 37 新例 + 契约 +8 例 + E2E 7 例 + eval 35；
- 资产：协议 #6（全门类工具化完成）/ #8、奇正 / 溯机 / 步天角色工具化、技能表、11 角色白名单。
