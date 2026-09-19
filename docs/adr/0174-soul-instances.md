# ADR 0174：同角多魂——成员分身（成员键 · 多实例同台 · 主实例寻址）

- 状态：Accepted
- 引入：M77
- 相关：[design.md §105](../design.md)、ADR 28、ADR 29、ADR 30

## 背景

灵魂层（ADR 29）支持同一角色挂多套人格，但会话成员身份只到「角色」粒度：`participantIds: string[]`（角色 id）+ `memberSouls: Record<agentId, soulId>` 决定一个角色在一场会话里最多一份成员身份、一个生效灵魂。用户诉求（「不同 soul 性格特点的 agent 是多个 agent」）：同一角色的不同人格应当能以多个实例同时上场（如 卢娜·狂野 + 卢娜·禅意 同台协作），且组建时按具体人格勾选参与、可随时增删与换装。

备选方案：
- 为每种风格复制完整角色目录（ADR 29 已否决：角色爆炸、职责漂移）——不可接受；
- 只做展示层拼接（同一实体渲染成多卡）——成员身份仍是一份，队列/交接/消息归属全错。

## 决策

**成员身份从「角色 id」升级为「成员键（memberKey）」，同角多魂以多实例入编**：

- **键格式**：经典实例 = `agentId`（存量数据天然合法、零迁移）；分身实例 = `agentId~soulId`（自描述；agentId/soulId 字符集 `[a-z0-9-]` 不含 `~`，解析安全）。`memberSouls` 语义不变（经典成员的换装覆盖）。
- **约束**：同角「有效灵魂」去重（分身取键后缀；经典取覆盖 > 默认）；无 souls 角色不可分身；同角实例上限 4；分身键的灵魂必须存在于角色资产。
- **组建（灵活选人格）**：组队台按角色一行，行内「参与性格」多选（勾选 = 该人格入编；全部取消 = 默认单人参与）；编码确定性 —— 集合按角色 souls 声明序，首个人格走经典键（= 默认灵魂则免覆盖），其余为分身键。会话内可经邀请对话框「+ 分身」追加（弹层 Portal 化以避开滚动裁剪与 Dialog 遮罩指针封锁）。
- **@ 寻址（token = 解析 / 展示 / Composer 插入三合一）**：裸名（名字 / agentId）→ 该角色**主实例**（编制序首位；2026-09-19 口径修订，见下方「修订记录」）；`名字·灵魂名`（有效灵魂）→ 指定实例；分身机器键（`luna~zen`）作为别名；token 边界排除 `·`，拼错的分身点名不回落裸名；全伞（同角多位分身同时上场）= **逐一点名**（Composer @候选提供「名字（全部 N 位）」一键插入多 token）。
- **展示口径**：同角多实例在场时标签 = `名字·灵魂名`（否则保持角色名，存量外观零变化）；消息、成员卡、点名 chips、指挥条、图谱节点、规划/任务/评审归属、定时目标全部按成员键归口。
- **数据归口**：`ChatMessage.agentId` 保持基础角色 + 新增 `memberKey`（迁移 v20：`messages.member_key`）；queue/spoken/运行快照/turn 事件/计划/任务用成员键；artifacts 作者、记忆 agent-scope、审批沿用基础角色。
- **换装**：经典 = 会话覆盖 / 恢复默认（现状）；分身 = 键替换（`luna~zen` → `luna~scholar`，运行中同步队列与交接便条、广播 queue:updated）；分身无「恢复默认」；与同角其他实例灵魂冲突时 400。

## 理由

- 键自描述、单源（分身灵魂在键内），冲突可结构性排除；存量会话 / fork / 报名全兼容；
- 复用既有装配链：`PromptLibrary.get/soul` 容忍成员键（按 `~` 取 base），roster / 队列表 / handout 映射一处改造全链受益；
- 保守展示：单实例零外观变化，仅在必然歧义（同角多实例）时加 `·灵魂名` 后缀，回归面最小；
- 灵活组建贴合诉求：不默认全量入编，按人格勾选；运行中可追加 / 换装 / 移除。

## 被否决的方案

- **同角同魂允许重复实例**：无意义（同人格分身行为同构），且使点名 / 展示无法消歧；
- **分身键变更时迁移历史消息归属**（把旧键消息改挂新键）：破坏审计真实性，且键替换仅代表「重塑该分身」，历史发言保留原键标签即可；
- ~~**裸名 @ 只触发主实例**：多实例场景下与「同角多魂同台」的心智不符（用户已明确选择「裸名 = 全伞」）~~ → **已修订采纳**（见下方「修订记录」）；
- **把分身灵魂存进 `memberSouls`（而非键内）**：双源易漂移，且键不自描述、日志/测试可读性差。

## 影响

- shared：`members.ts`（MEMBER_SEP / baseAgentId / soulIdOfMember / memberKeyOf / memberLabel）+ `ChatMessage.memberKey` + turn 事件 memberKey；
- server：迁移 v20；PromptLibrary 容忍成员键；parser 会话向 token 表（buildMentionTokens / parseMentionsWithTokens）；context 装配 roster 实例化（多实例寻址指南 + 身份标识行）；engine 成员键化（queue/spoken/事件/工具 runtime/换装同步 replaceMemberKey/回退排序）；routes 编制校验（lineupError）与三写（PATCH 分身键替换）；roster 内核成员键兼容；mock 按基础角色查表 + memberLabels 转交行点名；
- client：`lib/members.ts`（解析 / 参与性格编解码）；组队台「参与性格」多选（SoulParticipantPicker）；AgentPicker 成员键值域 + 「+ 分身」Portal 弹层；成员卡 / 消息 / 点名 / 指挥条 / 图谱 / 规划任务定时消费端按成员键归口；run-store memberKey 归口；
- 验证：server 新增 `m77-soul-instances`（**17 例**）、client 新增 `m77-soul-instances`（**21 例**）、e2e 新增 `m77-soul-instances`（2 条）；全量单测 / eval / check:agents / check:skills 零回归。

## 修订记录

- **2026-09-19（收口修订）裸名语义切换：全伞 → 主实例**。原「裸名 = 全伞」在收口评审中被替换，判据：① 最小意外——单实例会话的 `@名字` 习惯不应因追加分身而静默变多人触发；② 默认动作代价不对称——误触全伞 = 意外 N 轮/整波并行，误触主实例 = 1 轮可纠偏；③ 显式优于隐式——界面从不展示「裸名触发全员」，全伞改经 Composer 「名字（全部 N 位）」条目一键逐一点名（零新语法）；④ 模型侧寻址指南同步改写。单实例行为零变化；实现落点：`buildMentionTokens` 裸名映射 + Composer 全伞候选 + L3 指南 + 单测断言（全伞用例改双 token，新增裸名主实例用例）。
