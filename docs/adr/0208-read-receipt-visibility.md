# ADR 0208：已读对外展示——水位推导 · 对等双向隐身 · 显式翻案 M79 隐私决策

- 状态：Accepted
- 引入：M80-C（2026-09-22；对等双向补全 2026-09-23 收口）
- 相关：[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[server/src/ws.ts](../../server/src/ws.ts)、[client/src/components/chat/ReadReceipt.tsx](../../client/src/components/chat/ReadReceipt.tsx)、[client/src/stores/auth-store.ts](../../client/src/stores/auth-store.ts)、[server/tests/m80-reactions.test.ts](../../server/tests/m80-reactions.test.ts)

## 背景

M79 §2.5 刻意不做对方已读回执（理由：隐私争议；`last_read_seq` 仅本人多端 `notify:read-state` 同步）。但协作催办场景（waitingOn 持球、审批挂起催办）只能盲等——「对方看没看」是真实需求。本专项经需求方确认后**翻案**：解法不是不做，而是显式 opt-out + 对话类型分级 + 对等原则。

## 决策

1. **水位推导（零新表）**：`last_read_seq >= message.seq` 即已读；复用 M79 的 `session_reads` 单表，**不引入逐条消息已读表**（群聊 N 人 × 高频消息的写放大不可接受；水位推导等价且 O(1)）。
2. **展示分级（只读本人最后一条人类消息）**：历史消息不渲染状态（iMessage / 钉钉同口径，避免全屏状态噪音）；**判据扫描仅限本人发言**（对方后续发言不应使己方最新一条的徽章消失——收口期缺陷修复，2026-09-23）；私聊 = 二态「已读 / 未读」；群聊 / 团队 = 「N/M 人已读」+ 悬停名单（分母 = `memberReads` 投影中的其他成员，服务端已过滤停用账号与关闭开关者）；agent 不计入、viewer 不计入。己方消息三态语义：发送中（乐观态）→ 已送达（服务端持久化成功，不依赖对方客户端 ack）→ 已读（水位命中）——用文字徽章，不引入双钩图标。
3. **隐私开关（对等双向）**：`showReadReceipts`（user_prefs，默认开；管理面 = 设置页「向他人展示我的已读状态」）。关闭 = **双向不可见**：
   - 投影侧：该用户不进 `memberReads`（他人看不到其已读）、其读数推进不广播 `notify:read-receipt`；
   - 消费侧：该用户自身也**看不到他人已读**——服务端对请求者做空投影（`memberReads: []`），客户端门（`authStore.readReceiptsOn`）同时不渲染徽章、不消费入站回执帧（双保险）；
   - 本人多端 `notify:read-state` 同步不受影响（那是给自己看的）；admin 无豁免（沿用 M79-G「无内容旁路」口径）。
4. **广播与投影**：读数推进向**会话主题**广播 `notify:read-receipt { sessionId, userId, lastReadSeq }`（开关过滤在广播前；经 M79-L 总线跨实例自然覆盖）；首帧由 `GET /api/sessions/:id` 的 `memberReads` 投影对齐（仅含开启开关的活跃成员）；客户端维护当前会话的水位表（单调推进、回退忽略，仅当前会话落地）。

## 被否决的方案

- **逐条消息已读表**：群聊写放大；水位推导等价，且复用 M79 已落库的单表。
- **双钩图标（✓✓）**：与气泡极简风格冲突；文字徽章信息密度更高（私聊可带语义、群聊可带名单）。
- **已读默认关**：聊天场景主流预期是默认可见（微信 / WhatsApp 同口径默认开）；争议由 opt-out + 对等原则吸收。
- **单向隐藏（只有我能看你、你看不到我）**：白嫖式隐身，破坏对等信任——WhatsApp 同制否决。
- **admin 内容旁路**：沿用 M79-G 决策（admin 无会话内容特权），不引入 `DM_ADMIN_VISIBLE` 类开关。

## 边界与后续

- 关闭开关的即时性：对他人**存量**已读徽章在下次会话加载（或重新进入）时消失——不做「开关变更广播」（与 WhatsApp 行为一致）；本端徽章即时消失（客户端门）；
- 兼容模式（`multiUser=false`）`memberReads` 恒为空、徽章不渲染，行为与现状零差异；
- 测试：`server/tests/m80-reactions.test.ts`（关闭者不投影 / 不广播；**请求者自身关闭 → 空投影（对等双向）**）；E2E auth 项目 `m80-readreceipt.spec.ts`（私聊已读实时到位 + 关开关对等隐身）。
