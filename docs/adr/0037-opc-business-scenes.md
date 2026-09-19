# ADR 0037：OPC 业务场景编制——6 场景 19 角色与业务工具纪律

- 状态：Accepted
- 引入：M21
- 相关：[design.md §31](../design.md)、ADR 28（Agent 包化与场景分组）、ADR 29（灵魂层）、ADR 31（场景协议与技能）、ADR 38（业务工具集）

## 背景

「一人公司」（OPC）运行需要覆盖经营决策、市场增长、销售客户、财务法务、运营行政与融资资本的完整职能，这与既有研发型团队（development / brainstorm / research 3 场景 15 角色）的覆盖面完全不同。业务场景的错误成本结构也不同：金额与比例算错、日期排错、表格汇总错、合同条款臆造，都是高代价错误；且业务成员面向「产出草稿 + 人工审批」的外发路径（邮件 / 合同 / 报价），对确定性与合规口径的要求高于研发场景。

硬约束：资产即数据（新增场景 / 角色只改 `agents/` 与 `skills/` 文件，零代码改动）；包体门槛与全部门禁不回归。

## 决策

**以 6 个独立场景承载 19 个业务角色，并通过协议纪律与工具最小授权控制业务风险**：

- 新增 6 个场景：strategy 商业战略（`rounds: true` + 场景协议「例会纪律」）、marketing 市场增长（`parallel: true` + `parallelMax: 3` + `defaultSkills: [content-marketing]`）、sales 销售客户、finance 财务法务（场景协议「合规红线」）、ops 运营行政、funding 融资资本；`order` 取 5 / 40 / 50 / 60 / 70 / 80，与既有场景排序共存；
- 19 个角色（strategy 3 / marketing 4 / sales 3 / finance 3 / ops 4 / funding 2）沿用四段骨架（职责 / 工作方式 / 交付契约 / 协作接口）；交付契约统一 `docs/<文档类型>-<主题>.md`，与 mock 剧本、评测基线三方对齐；`handoff` 按「同场景接力链 + 跨场景协作」逐角色写定；
- 业务工具纪律写进全局 `_protocol.md <tool_policy>`：金额 / 比例 / 利率必须 `calc`（禁止心算）；日期与排期必须 `date_calc`；表格数据必须 `csv_analyze`（禁止目测汇总）；合同 / 报价 / 邮件等批量文档走 `template_fill`；
- 场景协议：strategy 例会纪律（数字口径以 finance 为准 / 方案带成本与优先级 / 决策记录留痕）；finance 合规红线（不背书法律意见 / 风险三级标注 / 敏感信息不外发 / 不臆造法规条款）；
- 灵魂 4 个（chief advisor/steward、content muse/data）与技能 4 个（business-review / content-marketing / financial-modeling / contract-review）按角色需要预载；
- 19 张头像沿用统一提示词模板批次生成，个别失败回退 front-matter 的 gradient + icon。

## 理由

- **独立场景而非并入 development**：场景 = 目录即分组，自带 theme / chain / parallel / order 语义；业务场景的主题色、接力链与并行需求与研发完全不同，混合目录会让 TeamPanel 分组、图谱配色与 chain 预选全部失真；独立场景同时让「按场景查看编制」自然成立；
- **19 角色最小充分编制**：每个场景 2–4 人覆盖「收敛者 → 专项执行」结构（如 finance 收敛 → tax / legal 专项），再多则超出 OPC 真实协作半径；
- **协议纪律优先于工具能力**：工具授权只解决「能不能用」，协议写清「何时必须用」才能压住心算 / 目测汇总类结构性错误；写类工具（template_fill）保持审批与沙箱约束不变；
- **零代码扩展得到验证**：全部改动落在资产目录，`check:agents` 一次性校验 9 场景 / 34 角色 / 灵魂 / 协议 / 预设引用。

## 被否决的方案

- **并入 development 场景**：chain / theme / 并行语义混杂，TeamPanel 与图谱分组失真；
- **单一 business 大场景容纳 19 人**：`chain` 无法表达 6 条独立接力线，建会话预选退化为「全选或手挑」；
- **给业务角色预载全部工具**：违背最小授权，且单靠工具能力无法约束「何时用」，最终仍需协议纪律；
- **引入外部计算 / 表格服务**：违背「沙箱内 + 零外部依赖」，且离线（LLM_MOCK）路径无法测试。
