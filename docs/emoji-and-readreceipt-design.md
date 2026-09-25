# 表情体系与已读回执专项设计（M80）——表情选择器 · 消息表情回应 · 已读/未读展示

> **文档定位**：设计方案 + 实施记录。**状态：已实施（M80-A/B/C 全量落地，2026-09-22；收口 2026-09-23）**
> 实际落位：迁移 **v28**（v27 已被 spaces 批占用，让位顺延）· 表情数据集 `shared/src/emoji-data.ts` · 测试 `server/tests/m80-reactions.test.ts`（4 例）+ `client/tests/m80-emoji.test.ts`（3 例）全绿
> 实施注记：已读回执广播下沉 `createInboxRouter` 依赖（`readReceiptAllowed` / `publishReceipt`），WS `read` 帧经 `getSocialDeps().showReadReceipts` 同口径；reactions 广播帧 mine=false 由客户端按 userIds 本地推导
> 收口落位（2026-09-23，编号按仓库实况核对）：里程碑 **M80** · ADR **0206–0208** · design.md **§116** · `docs/api.md` §3/§4/§17/§24 · `docs/operations.md` §9 · E2E `m80-reactions` / `m80-readreceipt`（auth 项目）
> 收口修订（对等双向补全）：原实现只做了「关闭者不投影 / 不广播」（单向）；现补全「关闭者也看不到他人已读」——服务端对请求者空投影（`memberReads: []`）+ 客户端门（`authStore.readReceiptsOn`）双保险；另对软限口径按实况修正（同消息同用户 ≤8 种，而非时间窗限次）。
> 收口修订（两处缺陷修复）：① 已读徽章判据——原扫描取「会话最后一条人类消息」（不限本人），对方后续发言会使己方最新一条的徽章消失；修为仅扫描本人发言（已由 E2E 步骤 3→5 锁定）；② 表情选择器键盘导航（↑↓←→ 移动 / Enter 插入）为收口期补全（原实现仅 Esc / 搜索光标），E2E 以「搜索「火箭」Enter 插入」路径锁定。
> 范围：Composer 表情选择器（内置流行默认表情库）· 消息表情回应（reactions）· 私聊/群聊已读未读展示 · 配套隐私开关
> 关联：M79 社交协作（docs/social-collab-design.md，§114 / ADR 0188–0201）· M57 已读存储 `session_reads` · WsHub 用户/会话主题（§18.3）
> 现状基线（规划时仓库快照）：迁移至 v26、design.md 至 §115、docs/adr 至 0205；头像已支持 emoji（`HumanAvatar`），消息侧无任何表情能力；`last_read_seq` 仅本人多端同步、刻意不回执对方（M79 §2.5「有意不做」，本专项经需求方确认后翻案）

---

## 1. 背景与问题

### 1.1 现状（代码核实）

| 能力 | 现状 | 位置 |
| --- | --- | --- |
| 头像 emoji | 支持（`UserAvatar.kind='emoji'`，≤2 码点） | `shared/src/types.ts:1849` · `chat/HumanAvatar.tsx` |
| 消息内 emoji | 只能手打系统输入法，无选择器 | `chat/Composer.tsx`（1037 行，无表情入口） |
| 表情回应 | 无（消息模型无 reactions 字段） | `store/sessions.ts` messages 表 |
| 已读 | `session_reads.last_read_seq` 服务端权威，仅 `publishToUser` 本人多端同步 | `store/session-reads.ts` · `ws.ts` `read` 帧 |
| 对方已读 | **刻意不做**（M79 §2.5 / §19「隐私争议」） | social-collab-design.md |

### 1.2 缺口

1. **表达工具贫瘠**：纯文本 + Markdown，聊天语境下缺少轻量情绪表达；头像已是 emoji，消息侧断层明显；
2. **无表情回应**：群聊里「收到 / 同意 / 点赞」必须发整句，刷屏且触发语义噪音（team 会话 auto 模式下还会误唤起 AI）；
3. **消息状态不可见**：发出去的消息对方看没看完全不知道，协作催办场景（waitingOn 持球）只能盲等；
4. **翻案依据**：M79 否决对方已读回执的理由是「隐私争议」，解法不是不做，而是**显式 opt-out + 会话类型分级**（§4 决策 3）。

---

## 2. 目标与验收

| 目标 | 验收标准 |
| --- | --- |
| 表情选择器 | Composer 一键唤起；内置流行默认库（≥8 分类 / ≥500 字符）；中英文关键词搜索；最近使用置顶；全程离线可用（零 CDN / 零图片资源） |
| 表情回应 | 任意消息可挂 / 摘 emoji 回应；同消息同 emoji 聚合计数；实时同步（≤1s）；悬停可见回应者名单 |
| 已读展示 | 私聊：己方最后一条消息显示「已读 / 未读」；群聊：显示「N 人已读」+ 悬停名单；viewer 只读不计入 |
| 隐私可控 | 设置项 `showReadReceipts`（默认开）；关闭后本人已读不对外展示（只保留本人多端同步）；兼容模式整体隐藏 |
| 零回归 | `multiUser=false` 路径逐字节不变；agent 会话渲染不受 reactions 干扰；M79 套件全绿 |

---

## 3. 设计原则（沿用 M79 红线 + 新增）

1. **一切皆会话 / 零平行栈**：reactions 挂消息行、已读复用 `session_reads`，不建新栈；
2. **权威在服务端**：reactions 落库（权威）+ 会话主题广播（快路径）；已读水位仍由 `last_read_seq` 单一推导，**不引入逐条消息已读表**；
3. **离线可用**：表情库内置打包、系统字体渲染，不引 emoji-mart 等外部依赖的图片 CDN 模式（本地优先纪律）；
4. **隐私显式化**：已读对外展示 = opt-out 开关，默认开（聊天场景主流预期；微信/WhatsApp 同口径默认开或提供开关）；
5. **兼容模式零变化**：`multiUser=false` 时表情选择器可用（纯本地功能），reactions / 已读展示整体隐藏。

---

## 4. 核心决策摘要

| # | 决策 | 一句话 |
| --- | --- | --- |
| 1 | 表情库形态 | **Unicode 原生 emoji + 系统字体渲染**，内置按流行度排序的精选数据集（§5.1），不引图片表情 CDN |
| 2 | 默认库选源 | 以 Unicode 官方 emoji frequency + Emojipedia 流行榜为基准，**Top 48 直达网格** + 全量 8 分类 |
| 3 | 已读语义 | 水位推导：`last_read_seq >= message.seq` 即已读；私聊展示二态，群聊展示计数 + 名单 |
| 4 | 已读隐私 | `users.show_read_receipts`（默认 1）；关闭者其已读不投影给他人，也不看到他人的（对等原则，WhatsApp 同制） |
| 5 | reactions 存储 | `message_reactions(message_id, user_id, emoji)` 三列唯一约束；计数随消息投影返回 |
| 6 | 广播通道 | reactions / 已读水位变更走**会话主题**（成员可见）；不新增帧类型之外的主题 |

---

## 5. 表情体系设计

### 5.1 默认表情库（内置数据集）

新建 `shared/src/emoji-data.ts`，纯数据、零依赖、可 tree-shake：

- **直达网格「常用 48」**（打开即见，按全球使用频次排序，括号内为分组）：
  😂 🤣 😊 😍 😘 🙂 😉 😎 🤔 😅 😭 😤 😡 🥺 😴 🤗 👍 👎 👏 🙏 💪 🤝 👌 ✌️ ❤️ 🔥 ✨ 🎉 💯 🎂 🍀 🌹 ☀️ 🌙 ⭐ ⚡ ☕ 🍺 🚀 ✅ ❌ ❓ ❗ 💡 📌
- **全量 8 分类**（每类 60–80 个，合计约 560）：笑脸与情感 / 人物与手势 / 动物与自然 / 美食饮品 / 活动与运动 / 旅行与地点 / 物品与符号 / 旗帜（仅常用 12 面）；
- **搜索索引**：每个 emoji 带 `keywords: string[]`（中英双语，如 😂 → `["笑","笑哭","笑死","joy","lol","xiao"]` 含拼音首字母），客户端内存索引，零服务端往返；
- **最近使用**：`localStorage` 每端 24 槽（纯本地偏好，不落库、不同步——多端各自习惯）；
- **肤色变体**：v1 不做（仅手势类默认黄皮），数据结构预留 `skins?: string[]`。

> 否决项：① 引入 `emoji-mart`（体积 ~300KB+，默认走图片 CDN，违反本地优先；其数据格式可参考但自产）；② 自定义图片表情 / 表情包上传（v1 边界外，存储与审核管道不成比例）。

### 5.2 Composer 集成

- 输入框工具条左侧加 😊 按钮（现有工具条纪律内插位）；弹出面板 320×360，顶部搜索框 + 分类 tab + 网格，键盘 `↑↓←→` 导航、`Enter` 插入、`Esc` 关闭；
- 插入行为：光标处插入 Unicode 字符（**纯文本，无短代码 `:smile:` 体系**——避免双轨渲染，Markdown 管线零改动）；
- `@` 候选面板与表情面板互斥（同层 popover，一次只开一个）。

### 5.3 消息表情回应（reactions）

**交互**：消息气泡悬停（移动端长按后置）出现「+😊」快捷条（常用 6 个：👍 ❤️ 😂 🎉 👌 🙏 + 「更多」唤起完整面板）；再点自己已挂的 emoji = 摘除（toggle 语义）。

**数据模型**（迁移 v28，v27 让位 spaces 批）：

```sql
CREATE TABLE message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL,           -- ≤4 码点，服务端校验必须是合法 emoji 序列
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_reactions_message ON message_reactions(message_id);
```

**API**：

- `PUT    /api/messages/:id/reactions { emoji }` — 挂（幂等）；权限 = 会话成员（含 viewer？**否**：viewer 只读不可挂，与发言 403 同口径）；
- `DELETE /api/messages/:id/reactions { emoji }` — 摘（仅本人）；
- 消息投影增 `reactions?: Array<{ emoji: string; count: number; userIds: string[]; mine: boolean }>`（`mine` 由服务端按请求者投影，避免客户端再算）。

**实时**：变更后广播 `notify:reaction { sessionId, messageId, reactions }`（全量替换该消息的 reactions 投影——单消息体量小，免 diff）；客户端 `noteIncoming` 同款幂等 upsert。

**与 agent 会话的关系**：reactions 是纯人类元数据，**不进 LLM 上下文装配**（assembler 零改动）、不触发 Run、不进 unread 计数；agent 消息同样可被挂回应（「这条答得好」场景）。

**渲染**：气泡底部聚合条 `[👍 3] [❤️ 1]`，自己挂过的高亮描边；悬停 tooltip 显示回应者显示名（复用 `HumanAvatar` 小圆点）；M19 渲染扩展的容器语法不受影响（reactions 在气泡层，不在 Markdown 层）。

---

## 6. 已读 / 未读展示设计

### 6.1 语义（水位推导，零新表）

消息 `seq`（会话内单调）× 成员 `last_read_seq`（M79 已落库）：

```
message.readBy(userIds) = { uid ∈ members : reads.get(uid, sid) >= message.seq }
```

**不建逐条已读表**（群聊 50 人 × 高频消息 = 写放大不可接受；水位推导等价且 O(1)）。

### 6.2 展示分级

| 会话类型 | 展示 | 说明 |
| --- | --- | --- |
| direct（私聊） | 己方**最后一条**消息右下角：「已读 HH:mm」/「未读」 | 只对最后一条渲染（往前消息状态可推导，逐条渲染是噪音）；对方 `showReadReceipts=0` → 恒「未读」样式降级为「已送达」 |
| group / team（群聊 / 团队） | 己方最后一条：「3/5 人已读」，悬停名单（头像 + 已读时间） | 分母 = 活跃人类成员（剔除停用账号与 viewer）；agent 不计入 |
| 历史消息 | 不渲染状态 | 只对「本人最新一条」渲染——这是 iMessage/钉钉同口径，避免全屏状态噪音 |

**己方消息三态**：发送中（乐观态，已有）→ 已送达（服务端 ack 后）→ 已读（水位命中）。「送达」在无回执语义下 = 服务端持久化成功，不需要对方客户端 ack（不做双灰钩/双蓝钩的图片图标，用文字徽章，与现有气泡风格一致）。

### 6.3 隐私开关（对等原则）

- `users.show_read_receipts INTEGER DEFAULT 1`；设置页「隐私 → 向他人展示我的已读状态」；
- 关闭 = **双向不可见**：他人看不到你的已读，你也看不到他人的（WhatsApp 同制，防「白嫖式隐身」）；本人多端同步不受影响（那是给自己看的）；
- admin 无豁免（与 M79-G「无内容旁路」口径一致）。

### 6.4 服务端投影与广播

- 已读上报入口不变（WS `read` 帧 / REST `POST /sessions/:id/read`）；**新增**：`reads.set` 推进后向**会话主题**广播 `notify:read-receipt { sessionId, userId, lastReadSeq }`（成员可见，不再只发本人主题）；
- 隐私过滤在广播前：`show_read_receipts=0` 的用户不产生 read-receipt 帧；
- 客户端维护 `sessionReadSeqs: Map<userId, seq>`（会话内成员水位表），据此推导己方最后一条消息状态；首帧由 `GET /sessions/:id` 投影新增 `memberReads: Array<{ userId, lastReadSeq }>` 对齐（仅返回开了开关的成员）；
- 节流：连续滚动阅读产生的水位推进按 300ms 聚合（客户端上报已有节流，服务端广播加同口径）。

---

## 7. 数据与类型契约（shared 增量）

```ts
// shared/src/types.ts
export interface ReactionSummary { emoji: string; count: number; userIds: string[]; mine: boolean }
export interface ChatMessage { /* …既有… */ reactions?: ReactionSummary[] }
export interface MemberReadState { userId: string; lastReadSeq: number }
export type NotifyType = /* …既有… */ | 'notify:reaction' | 'notify:read-receipt'
// users 设置投影
export interface UserSettings { /* … */ showReadReceipts: boolean }
```

迁移 v28：`message_reactions` 表（已读开关改走 user_prefs JSON，与 M79 allowFriendRequests 同族先例——不新增 users 列）。存量消息零迁移（reactions 可空）。

---

## 8. 批次分解

| 批次 | 主题 | 规模 | 交付 |
| --- | --- | --- | --- |
| M80-A | 表情库 + 选择器 | 1–1.5 天 | `emoji-data.ts` 数据集（560 字符 + 中英索引）+ Composer 面板 + 最近使用 + client 测试 |
| M80-B | 消息表情回应 | 1.5 天 | 迁移 v28 + API + 广播 + 气泡聚合条 + server/client 测试 + E2E（双人互挂） |
| M80-C | 已读展示 + 隐私开关 | 1.5–2 天 | read-receipt 帧 + 水位推导 + 三态徽章 + 设置项 + E2E（私聊已读 / 群聊计数 / 关开关对等隐身） |
| 收口 | 文档 / ADR / 门禁 | ~0.5 天 | ADR 0206–0208 · design.md §116 · operations.md 增量 |

**实施顺序 A → B → C**，每批独立过门禁（typecheck / lint / 双端 vitest / build / eval 基线 / 相关 E2E 全绿）。

---

## 9. 风险登记

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| 表情数据集版权 / 体积 | 合规 / 包体 | 只用 Unicode 字符本身（无图片资产）；数据集自产 ≈60KB（gzip 后 ~20KB），随 shared 打包 |
| reactions 帧风暴（大群狂点） | 带宽 | toggle 幂等 + 全量替换帧（体小）；单消息 60s 内同用户 10 次软限 |
| 已读名单泄露会话成员构成 | 隐私 | 名单本就成员可见（成员弹窗同级）；viewer 不计入、关开关者不投影 |
| 群聊水位计算 N×M | 性能 | 客户端只算「己方最后一条」；服务端投影只带原始水位表，O（成员数） |
| 表情面板与 @ 面板互斥态 | UX 回归 | popover 单例管理，Composer 测试锁四态（同 M79-M 先例） |
| 翻案「对方已读」引老用户争议 | 信任 | 默认开但设置页显著提示 + CHANGELOG 明示；对等原则兜底 |

---

## 10. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| 图片表情 CDN（emoji-mart 默认模式） | 离线不可用 + 外网依赖，违反本地优先 |
| 短代码 `:smile:` 双轨体系 | Markdown 管线需双份解析渲染；Unicode 直插零管线改动 |
| 逐条消息已读表 | 群聊写放大；水位推导等价 |
| 双钩图标（✓✓） | 与气泡极简风格冲突；文字徽章信息密度更高（可带时间） |
| reactions 进 LLM 上下文 | 情绪噪音污染 prompt；人类元数据与人类署名同层即可 |
| 已读默认关 | 聊天场景主流预期是默认可见；争议由 opt-out + 对等原则吸收 |

---

## 11. 顺手值得一起做（本专项外，立项候选）

按「与本次改动的耦合度」排序，耦合高的顺手做最省成本：

1. **消息引用 / 回复**（与 reactions 同改消息气泡与投影，同批做省一次迁移与气泡重构）——上一轮审计认定的最大体验空洞；
2. **typing 指示**（复用本次的会话主题节流广播框架，M80-C 落地后增量 <0.5 天）；
3. **DM 聚合提醒 inbox 项**（「X 发来 N 条新消息」，补离线触达短板）；
4. **waitingOn 催办**（已读落地后可做「对方已读 2h 未回复」的精准提醒，比盲催体验好一个量级）；
5. 消息撤回（配合 reactions 的 `notify:message-deleted` 同族帧，窗口 2min）；
6. 头像图片上传（`UserAvatar.kind='image'` 预留位，附件管道复用）。
