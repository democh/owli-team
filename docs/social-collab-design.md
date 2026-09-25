# 社交协作专项设计（M79）——好友 · 私聊/群聊 · 真人入会话与 @ 调度 · 实时通道稳定化

> **文档定位**：最终设计与实施文档（含前端交互设计、触发判断专题、批次任务分解）。**状态：已实施（M79 批次 A–E 全量落地；F–Z 补批收口；2026-09-20 收口）**
> 实际落位（2026-09-20 复核）：里程碑 **M79** · ADR **0188–0201** · design.md **§114** · 迁移 **v21–v26**（编号让位：M78 / ADR 0187 / §113 已被塔罗批次占用；ADR 0186 为输出完整性治理批占用）· E2E `m79-social.spec.ts` / `m79-realtime.spec.ts` 已落地
> 范围：用户画像 · 好友关系图 · 私聊与群聊（人物会话）· 真人驻 Agent 会话与 @ 真人调度 · **触发判断体系** · 通知/未读/在线状态的 WebSocket 稳定化基座
> 关联：ADR 0134（M57 多用户基座，§90）· M57 P2 会话共享（ADR 0142）· M48 平台路由步 PRS（ADR 0101）· WsHub（§18.3）· StreamHub（M22）· M62 连接线治理（ADR 0139–0141）
> 现状基线（规划时仓库快照，数字以开工复跑为准）：迁移 **v20** · design.md **§112** · docs/adr 至 **0185** · 三 WS 通道并存：`/ws`（通知总线）/ `/ws/stream`（浏览器帧）/ `/ws/ssh`（终端）

---

## 1. 背景与问题

### 1.1 已具备（M57 沉淀，本专项的直接基座）

| 能力 | 现状 | 位置（代码核实） |
| --- | --- | --- |
| 账号与认证 | 邀请制账号、admin/member、首登改密、API Key、禁用即时吊销 | M57 P1（ADR 0134） |
| 会话 ACL | owner / editor / viewer 三角色；读 404 不泄漏存在性、写 403 分级 | `server/src/auth/access.ts` |
| 会话共享 | `/sessions/:id/shares` 邀请 / 改角色 / 移出 / 自助退出 + `notify:share-changed` | `server/src/routes/shares.ts` · `store/session-members.ts` |
| 人类署名 | 消息 `userId` + 列表预览 `userName` + 上下文 label resolver（四处统一） | M57 P3（§99） |
| 通知总线 | `/ws` 会话主题 + 环形重放（200/会话）+ `since` 游标补发 + REST 降级轮询 + 30s 心跳 | `server/src/ws.ts` · `client/src/lib/ws.ts` |
| 空编制会话 | M48 平台路由：无 @ 消息交给平台组队（可零成员创建） | `schemas.ts` · `engine.ts` 首发队列 / `routeByPlatform` |
| 运行归属 | Run 记录 `triggerUserId`（触发者）；配额按触发者归因 | `engine.launch`（M57 P2/P3） |

### 1.2 缺口（代码核实结论）

| # | 缺口 | 证据（现状） | 本需求下的后果 |
| --- | --- | --- | --- |
| 1 | **无用户级实时通道** | WsHub 主题仅「会话 id / `__` 全局前缀（admin-only）」；`canSubscribe` 见 `ws.ts:236` | 好友请求、被邀请、被 @ 等个人事件无法实时到达；**M57 P2 邀请只广播到会话主题——被邀请人此刻尚未订阅该会话，只能刷新后才发现**（E2E 中 bob 需 reload 的根因） |
| 2 | **无持久收件箱** | 重放缓冲仅内存（200/会话），无用户维度投递记录 | 离线期间个人事件永久丢失；多端各自为政；无「待处理」权威清单 |
| 3 | **未读计数纯客户端** | `client/src/stores/ws-store.ts` `unread` 内存态、notify 驱动 | 刷新即丢、多端不一致；聊天语境不可接受 |
| 4 | **人类不可被 @ 寻址** | `buildMentionTokens` 只吃 agent 成员；parser 仅识别行首 `@用户/@user/@你` 泛指 | agent 无法把任务交给具体的人；用户之间无法互相点名；无「待你回复」语义 |
| 5 | **Agent 收尾「交还用户」无目标** | `engine.finishRun` 只 publish `notify:awaiting-user`（无 targets；客户端 toast「成员已交还，等待你的指示」） | 多人会话中没人知道球在谁手里 |
| 6 | **无用户画像** | `users` 表仅 `username/display_name`；无头像 / 头衔 / 简介 | 真人成员呈现贫瘠（纯文本名 + 首字母头像） |
| 7 | **无社交关系** | 无好友 / 联系人任何表与端点；用户搜索仅 admin 的 `GET /users` | 私聊、邀请、可见性缺前置关系图 |
| 8 | **私聊 / 群聊无承载** | 会话以 agent 编制为核心（`participantIds` 为 agent 成员键）；空编制消息走 PRS 自动组队 | 纯人聊天会被平台当作「待组队需求」派发 agent，语义冲突 |
| 9 | **WS 无背压 / 无连接上限 / 无缺口检测** | `publish` 直接 `send`；无每用户连接数限制；客户端不做 seq 缺口判断 | 慢客户端积压、标签页泄漏、断线后静默丢事件 |
| 10 | **无在线状态** | 无 presence 任何机制 | 联系人 / 邀请 / 协作缺「谁在线」判断 |
| 11 | **无触发判断（本需求核心缺口）** | 现状语义 = 「一切无 @ 消息都假定为对 AI 说的」→ 一律 PRS 组队（`engine.ts:337` `needsRouting`） | 多人会话中真人之间的讨论会被 AI 误响应；插话会污染 agent 上下文；必须建立显式触发体系（§8 专题） |

---

## 2. 专业评估（结论先行）

### 2.1 可行性结论：**高**

- **基座完整度高**：认证 / ACL / 共享 / 署名 / 通知管线五件套已由 M57 打完，本专项是「在既有会话模型上叠加社会层」，不是新建 IM 系统；
- **「一切皆会话」使私聊 / 群聊零平行栈**：消息存储、SSE 运行流（纯人会话不启 Run）、WS 通知、附件、搜索、交付件、Markdown 渲染全部复用——与自研 IM 相比是数量级的工作量差异；
- **WS 扩展是增量而非重构**：主题模型加一类 `u:<userId>`、投递加一张持久表、补齐背压 / 上限 / 缺口检测三处，`/ws` 协议向后兼容（新帧可被旧客户端忽略）；
- **引擎改动可控**：真人 @ 调度不引入「人类回合范式」，只做「触发门控 + 持球方 + 通知 + 上下文提示」，与 ADR 0101（调度上收平台）零冲突；
- **触发判断有清晰的显式化路径**：不依赖 LLM 意图分类，用「定向信号 + 会话级策略」两层显式规则覆盖全部场景（§8），可测、可审计、可解释。

### 2.2 与既有架构的契合点

1. **显式成员模型**（ADR 0082 精神）：人类**不进** `participantIds`（那是 agent 编制键空间，牵连队列不变量 / 记忆归属 / 编制链 / M77 分身键），人类经 `session_members` 承载——权限矩阵、署名、通知沿用现轨；
2. **三层守卫先例**（M57 个人 MCP）：画像 / 好友 / 收件箱同样「数据层 → 路由层 → 可见性层」分层；
3. **就低改造**：会话列表 / ChatArea / Composer / 消息气泡均为增量扩展；`kind='team'` / `route_mode='auto'` 默认值使存量会话零迁移、零行为变化；
4. **触发判定单一实现**：服务端唯一执行者（`POST /messages` + `engine.inject` 入口），客户端只做 UI 预测提示——杜绝「前端判一套、后端判一套」的双份漂移。

### 2.3 关键评估结论（风险与边界，详见 §20）

- **隐私边界（最重要）**：M57 现状 admin 对全部会话可见（`ownsOrAdmin`）。聊天语境下这敏感，但改动会破坏既有运维 / 审计语义与 WS 订阅 ACL 全链。**本稿决定：v1 保持现状并明示为已知边界**，预留 `DM_ADMIN_VISIBLE=false` 后续开关（见 ADR 0191 边界）；
- **误触发 vs 零回归的取舍**：team 会话 `routeMode` 默认 `auto`（零回归红线）；多人协作场景通过「邀请第二位人类时的引导提示 + 头部一键切换」治理；不采用 LLM 自动意图分类（不可见 / 不可审计，违反「不做隐藏路由器」既有纪律）；
- **通知风暴**：群聊 + 多端 + presence 三者叠加可能放大帧量；对策 = 聚合节流 + 每用户连接上限 + 背压 resync + inbox 保留期；
- **双人 E2E 并发**：沿用 `m57-auth` 双浏览器上下文先例 + 独立实例端口 + `PW_OUTPUT_DIR` 隔离；
- **单进程边界**：服务端为单进程单实例部署（本地优先），本设计不做分布式投递；多实例演进路径见 §9.7。

### 2.4 工作量总账（评估）

| 批次 | 主题 | 估时 |
| --- | --- | --- |
| M79-A | 实时通道稳定化基座 | 2–2.5 天 |
| M79-B | 用户画像与呈现升维 | 1 天 |
| M79-C | 好友体系与在线状态 | 1.5 天 |
| M79-D | 人物会话（私聊 / 群聊） | 2 天 |
| M79-E | 真人入会话与 @ 调度（触发判断体系） | 2.5–3 天 |
| 收口 | 文档 / ADR / 镜像面 / 全量门禁 | ~1 天 |
| **合计** | | **≈ 11–12 天**（对标本仓 M62 节奏，每批独立过门禁） |

### 2.5 明确不做（v1 边界）

端到端加密 · 已读回执（不向对方显示）· typing 指示 · 消息撤回 / 转发 · 图片头像上传（v1 用色块 + 首字 / emoji）· 跨实例集群 · 移动推送 · 语音视频 · 群公告 / 群成员角色细分 · 免打扰 / 会话静音 · @全体 · 「拍一拍」真人版。

---

## 3. 目标与验收

| 目标 | 验收标准 |
| --- | --- |
| 好友闭环 | 搜索 → 请求 → 接受 / 拒绝 / 拉黑 → 解除全链实时（≤1s 送达在线端）且离线可靠（重连补收，零丢失） |
| 私聊与群聊 | 任意两好友可开私聊（全局唯一不重复）；可建群、邀请、退群、隐藏；纯人会话**永不触发 Run** |
| 真人入会话 | 人类可在 agent 会话中被 @、被派活、收到「待你回复」；agent 行首 @某人 = 交球给该人；球权在会话头部可见 |
| **触发判断可控** | 人类之间的对话（@人 / 静默模式）**零误触发**；@agent / 被点名回复**必定触发**；全部判定可解释（矩阵单一实现） |
| 画像 | 显示名 / 头衔 / 简介 / 头像色可在设置维护；消息气泡、共享弹窗、联系人、@ 候选处处一致 |
| 实时可靠 | 多端未读一致；断线重连零丢失（游标 + 缺口补齐）；慢客户端 resync 断开不拖累他人；在线状态由心跳推导（±1min） |
| 权限不变量 | 私聊仅两成员可读；非成员一律 404（不泄漏存在性）；admin 语义保持现状并在本文档与 ADR 明示 |
| 零回归 | 单用户兼容模式（`auth.multiUser=false`）全功能隐藏、旧路径零变化；`m57-*` / `m16-*` / `m22-*` / `m24-*` 套件全绿 |
| 门禁全绿 | 四包 typecheck / lint / 双端 vitest / build / eval 基线 / 相关 E2E 全绿（含计数镜像面核对） |

---

## 4. 设计原则（红线）

1. **一切皆会话**：人物会话与团队会话同一模型；不建平行 IM 存储 / 平行未读 / 平行渲染。
2. **人不进 agent 编制**：`participantIds` 恒为 agent 成员键空间；人类经 `session_members` 承载。
3. **触发显式化**：触发 AI 的信号永远显式（@agent / 被点名回复 / 会话策略 `auto`）；**绝不做 LLM 隐藏意图分类**；判定单一实现（服务端）。
4. **个人事件三层投递**：WS 用户主题（快路径）+ 持久收件箱（权威）+ REST 降级；客户端只做幂等合并，不做事实来源。
5. **未读单一事实源**：`last_read_seq` 服务端权威；多端广播同步；列表 `unreadCount` 服务端计算。
6. **零 Run 锁**：等待真人**永不挂起 Run**（收束 + 持球方 = 等待语义）；纯人会话零引擎调用。
7. **兼容模式零变化**：`multiUser=false` 时新能力整体隐藏（联系人 tab / 私聊 / 群聊 / 资料卡），旧路径与现状逐字节一致。
8. **隐私明示**：admin 可见性维持现状（明示边界）；拉黑即时四面切断（订阅 / 搜索 / 请求 / 私聊创建）。
9. **审计一致**：好友关系变更、人物会话创建 / 邀请、@ 定向通知、持球写入 / 清除、拉黑等关键动作落 `audit_log`。
10. **编号纪律**：动手前核对最新 ADR / design.md 章节号与里程碑占用（M78 已让位 tarot）；遇并行批次让位 + 双索引对齐。

---

## 5. 核心决策摘要

| # | 决策 | 一句话 |
| --- | --- | --- |
| D1 | 一切皆会话 | `sessions.kind: team/direct/group` + `dm_key` 唯一键；私聊群聊复用消息 / 通知 / 渲染 / 未读 |
| D2 | 人类键命名空间 | 通知与 @ 中以 `u:<userId>` 标识人类；消息新增 `humanMentions: string[]`（与 agent `mentions` 字段隔离，零引擎不变量风险） |
| D3 | @ 真人三层语义 | ①句中提及 = 通知 + 未读；②行首 @人（agent 输出）= 指定交还 + 持球；③`@用户/@user/@你` 泛指 = 现语义兼容 |
| D4 | 持球方模型 | `sessions.waiting_on`（userIds 数组）；收尾写入、回复清除（集合差）、成员变更清洗；经 `notify:session-meta` 激活 |
| D5 | 个人通道 | WsHub 增用户主题 `u:<id>`：握手自动绑定本人（免客户端遗漏）、**他人不可订阅**（admin 亦不可） |
| D6 | 持久收件箱 | `user_inbox`（每用户 `seq` 单调、保留期 30 天）；**仅承载跨会话个人事件**（好友 / 邀请 / @提及 / 持球）；**DM 逐条消息不落 inbox**（未读 + 消息 seq 已足够，防膨胀） |
| D7 | 未读服务端化 | `session_reads` + `/read` 上报 + 多端 `notify:read-state` 广播；`unreadCount` 随会话列表返回 |
| D8 | 好友图 | `friend_links` 单行双向状态机（pending / accepted / blocked）+ 隐私开关（可搜索 / 可被请求） |
| D9 | **触发判断矩阵** | 定向优先：@agent → 触发；@人 / 行首 @用户 → 不触发（仅通知）；无定向 → 由 `routeMode` 决策；**waiting 命中强制触发**（回应 AI 不被静默）（§8 详述） |
| D10 | `routeMode` 会话级策略 | `sessions.route_mode: 'auto' \| 'mention'`；team 默认 auto（零回归）、chat 恒 mention 语义；头部一键切换 |
| D11 | 画像 v1 | `headline/bio/avatar(kind+value)`；头像 = 色块 + 首字 / emoji，不涉上传管道 |
| D12 | 稳定化四件 | 背压（队列上限 → `resync` 断开）、每用户连接上限 8、seq 缺口检测补拉、退避带抖动；presence 聚合节流 |
| D13 | 邀请实时化 | 被邀请人的通知改投用户主题（修复 M57 P2「刷新才发现」缺口）；inbox 留痕 |
| D14 | 群聊邀请放宽 | `shares.ts` 按 `kind` 分流：群聊任何成员可邀请自己的好友；团队会话维持 owner-only |
| D15 | 兼容全隐藏 | 兼容模式（multiUser=false）下新 UI 全部不渲染；旧路径断言进测试 |

---

## 6. 专项总览（批次）

| 批次 | 主题 | 规模 | ADR 预定 | 迁移 |
| --- | --- | --- | --- | --- |
| M79-A | 实时通道稳定化基座（用户主题 · 持久收件箱 · 未读服务端化 · 背压/上限/缺口 · presence 推导 · 观测） | 2–2.5 天 | 0187 / 0188 / 0189 | v21 |
| M79-B | 用户画像与呈现升维（画像字段 · 设置卡 · 气泡/共享/成员面渲染） | 1 天 | 0190 | v22 |
| M79-C | 好友体系与在线状态（关系图 · 请求流 · 联系人面板 · 搜索） | 1.5 天 | 0191 / 0192 | v23 |
| M79-D | 人物会话（私聊/群聊 · kind/dm_key · 免路由 · 隐藏/退群 · 列表分区） | 2 天 | 0193 | v24 |
| M79-E | 真人入会话与 @ 调度（触发矩阵 · humanMentions · 持球方 · 通知联动 · 上下文注入 · Composer） | 2.5–3 天 | 0194 / 0195 | v25 |

实施顺序 A → B → C → D → E（A 是 C/D/E 的投递基座；B 是 C/D 的呈现基座；D 的 `kind` 与 E 的触发矩阵在 E 批收口为完整体系——D 批先落「chat 形态零 Run」，E 批补齐 `route_mode` + 定向判定）。每批独立过门禁。ADR 号为预定值，动手前核对最新编号（仓库有并行批次让位先例）。

---

## 7. 数据模型与迁移（v21–v25，按批次分版）

> 迁移纪律：按批次分版落地（A/B/C/D/E 各自迁移），每批可独立回滚理解；全部结构一次设计、分批建表。

### 7.1 v21（M79-A：收件箱与未读）

```sql
CREATE TABLE IF NOT EXISTS user_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,        -- 每用户单调递增（游标依据）
  type TEXT NOT NULL,          -- friend-request | friend-accepted | session-invite | mention | waiting | system
  session_id TEXT,
  actor_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  payload TEXT,                -- JSON 附加（role / messageId 等）
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_user_seq ON user_inbox(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_inbox_user_unread ON user_inbox(user_id, read_at);

CREATE TABLE IF NOT EXISTS session_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
```

### 7.2 v22（M79-B：画像）

```sql
ALTER TABLE users ADD COLUMN headline TEXT;   -- 头衔（如「产品经理」，≤30 字）
ALTER TABLE users ADD COLUMN bio TEXT;        -- 一句话简介（≤120 字）
ALTER TABLE users ADD COLUMN avatar TEXT;     -- JSON：{"kind":"color","value":"#6366f1"} | {"kind":"emoji","value":"🐼"}
```

### 7.3 v23（M79-C：好友）

```sql
CREATE TABLE IF NOT EXISTS friend_links (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- 字典序较小方
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','blocked')),
  requested_by TEXT NOT NULL,
  message TEXT,
  blocked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friend_links_b ON friend_links(user_b, state);
```

### 7.4 v24（M79-D：会话形态与隐藏）

```sql
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'team';  -- team | direct | group
ALTER TABLE sessions ADD COLUMN dm_key TEXT;                        -- direct：排序后两 userId 以 '|' 连接
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_dm ON sessions(dm_key) WHERE dm_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS session_hides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
```

### 7.5 v25（M79-E：触发策略与持球）

```sql
ALTER TABLE sessions ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'auto';  -- auto | mention（M79-E）
ALTER TABLE sessions ADD COLUMN waiting_on TEXT;                          -- JSON string[]：持球方 userIds（M79-E）
```

### 7.6 兼容与清理

- `kind` / `route_mode` 默认值使存量会话行为零变化；`waiting_on` 空。
- 账号删除：`friend_links` / `session_hides` / `session_reads` / `user_inbox` 全部 `ON DELETE CASCADE`，与既有清理链（浏览器 → 连接 / MCP / 素材 → 磁盘 → 删库）自动衔接；`dm_key` 含被删用户 id 的 DM 会话保留给对方（对端显示「（已删除）」——复用 shares 既有投影口径）。
- 消息类型扩展（shared，零迁移）：`ChatMessage.humanMentions?: string[]`；`SessionSummary` 增 `kind?` / `unreadCount?` / `routeMode?` / `waitingOn?: string[]`；`Session` 增 `kind?` / `routeMode?` / `waitingOn?`；`UserInfo` 增 `headline?/bio?/avatar?`。
- `NotifyType` 增：`notify:inbox` / `notify:read-state` / `notify:presence` / `notify:friends-changed` / `notify:session-meta`。

---

## 8. 触发判断与消息路由（核心专题）

> 用户诉求原话「需要考虑会话中与真人对话，触发判断等场景是不是会有问题」——本章逐场景压测「一条消息该不该唤起 AI」，给出单一实现的判定矩阵与全部已知失败模式。

### 8.1 问题定义

「发消息」这一动作在多人会话中承载四种意图，系统**无法从文本可靠区分**：

| 意图 | 期望行为 | 典型文本 |
| --- | --- | --- |
| 对 AI 下指令 / 追问 | 触发 Run（launch 或 inject 插话） | 「帮我修复登录 bug」 |
| 对另一位真人说话 | **不触发**；对方收到通知；不污染 agent 上下文 | 「@张三 你看下这个方案」 |
| 回应 AI 的提问 | **触发**（延续上下文） | 「同意，就按方案 B 做」（被 agent 点名后） |
| 记录 / 闲聊 / 自言自语 | 不触发 | 「先记一下：周三之前定稿」 |

现状（单用户）语义 = 「一切无 @ 消息都假定为对 AI 说的」→ 一律进 PRS 平台路由组队（`engine.ts:337`）。这在多人会话中会把真人讨论误报给 AI。**本设计不引入 LLM 意图分类**（不可见、不可审计、违反「不做隐藏路由器」纪律——ADR 0082 同族否决先例），而是用「定向信号 + 会话级策略 + 持球命中」三层显式规则完整覆盖。

### 8.2 输入信号

判定所需的全量输入（服务端在 `POST /sessions/:id/messages` 解析，单点实现）：

| 信号 | 来源 |
| --- | --- |
| `kind` | 会话形态（team / direct / group） |
| `routeMode` | 会话策略（auto / mention） |
| `@agent 命中` | `parseAllMentions` 中 agent token 命中且 ∈ `participantIds`（既有语义） |
| `@human 命中` / `行首 @用户` | human token 命中（userIds 非空）；行首 `@用户/@user/@你` = 泛指人类定向 |
| 运行态 | `engine.activeRunOf(sessionId)` |
| `waiting 命中` | 发送者 userId ∈ `session.waitingOn` |

### 8.3 触发判定矩阵（单一实现，按优先级自上而下命中即定）

**空闲态（无活跃 Run）**：

| # | 条件 | 行为 | 语义 |
| --- | --- | --- | --- |
| 1 | @agent 命中 | `engine.launch`（现状；mention 队列直达入场） | 明确唤起 |
| 2 | waiting 命中 | `engine.launch`（无 @agent 则进 PRS 组队） | 被点名者的回应（**越过 routeMode**） |
| 3 | @human 命中或行首 @用户（且无 @agent） | 仅存储 + 目标通知（不 launch、不 PRS） | 「这条消息是给人的」 |
| 4 | 无定向 + team + auto | `launch` → PRS 现状（平台组队） | 零回归路径 |
| 5 | 无定向 + team + mention | 仅存储 | 静默协作消息 |
| 6 | 无定向 + direct/group | 仅存储 | 聊天消息（chat 永无 Run） |

**运行态（有活跃 Run）**：

| # | 条件 | 行为 | 语义 |
| --- | --- | --- | --- |
| 1 | @agent 命中 | `engine.inject`（插话，现状） | 补充指令 |
| 2 | waiting 命中 | `engine.inject` | 被点名回应（正常时序下 Run 已收束；共存时为唯一例外） |
| 3 | @human 命中 | **不注入**（仅存储 + 通知） | 人体留言不污染 agent 上下文 |
| 4 | 无定向 + team + auto | `engine.inject`（现状） | 零回归 |
| 5 | 无定向 + mention / chat | 不注入（仅存储） | 静默 |

**四条补充规则**：

1. **waiting 命中优先于一切策略**：被 AI 点名的人作回应，任何模式（mention/auto）都触发——否则「静默模式下 AI 提问无人应答」；
2. **@human 永不触发 PRS**：即使会话处于 auto，明确指向某人的消息不组队（防「@张三 你看下」把 AI 叫出来）；
3. **@agent 与 @human 并存**：@agent 优先级更高 → 触发 Run；被 @ 的人类同样收通知（两者不互斥）；
4. **清除语义**：任何消息（无论哪条路径）只要发送者 ∈ `waitingOn` → 从 `waitingOn` 中清除该发送者（集合差；空则置 null）。

### 8.4 `routeMode` 语义、默认值与切换

- **默认值**：存量与新建 team 会话 = `auto`（零回归红线）；`direct` / `group` = `mention` 语义（chat 无 agent 时天然免判定；混编群创建即 mention）；
- **切换入口**：team 会话语义头部「AI 自动应答」小开关（`PATCH /sessions/:id { routeMode }`，owner / editor 可改；viewer 只读）；chat 形态不渲染开关；
- **引导**：邀请第二位人类加入团队会话成功后（ShareDialog 邀请成功态）附轻提示「多人协作建议开启『仅点名唤起』，避免交流被 AI 误响应」+ 一键切换（写入 `routeMode='mention'`）；
- **发送侧提示**（纯 UI 预测，不构成判定）：mention 模式下输入框无 @ 且会话有 agent 时，发送按钮上方轻提示「本条将作为协作消息发送 · AI 不响应」；auto 模式不提示；
- **审计**：`session.route-mode-set`（actor / from / to）。

### 8.5 场景走查（S1–S12，逐步行为）

| # | 场景 | 行为（逐步） |
| --- | --- | --- |
| S1 | 双人讨论不被 AI 打扰（team + mention） | A「@张三 方案 B 的排期有问题」→ 矩阵③：仅存储 + 张三通知（零 Run）；B「确实，我改一下」→ 矩阵⑤：仅存储。全程零 agent 调用 |
| S2 | 同一会话呼 AI 干活 | A「@艾达 出个接口方案」→ 矩阵①：launch，艾达开工 |
| S3 | 人向人派活 | A「@张三 帮忙确认下原型」→ ③：张三收 inbox「被提及」+ 未读；张三「@李四 你看呢」→ ③：李四收通知 |
| S4 | 回应 AI 的提问（mention 模式） | 艾达行首 @张三「请确认口径」→ Run 收束 + `waiting_on=[张三]` + 张三 inbox「等你回复」；张三回复「按 B 口径」→ 矩阵②（waiting 命中，越过 mention）：launch → PRS 组队续作 |
| S5 | 运行中留言给同事 | Run 活跃，A「我先撤了，张三接手」→ mention：矩阵⑤ 不注入（只是存储）；auto：矩阵④ inject（进 agent 上下文——现状语义，文档明示与建议） |
| S6 | 混编群日常聊天 + 偶尔 @AI | 群（mention）：日常消息零触发；「@艾达 帮查一下」→ launch；艾达收尾 @用户 → 全员收 `notify:awaiting-user` + 头部「等待成员回复」 |
| S7 | 私聊（direct） | 任何消息仅存储 + 未读 + toast；零引擎、零 PRS（会话无 agent，且 direct 无自动应答概念） |
| S8 | 同时 @AI 和 @人 | 「@艾达 @张三 一起看下」→ 矩阵①：launch（艾达）+ 张三收被提及通知 |
| S9 | agent 交球给具体的人 | 艾达行首「@张三 请拍板」→ 收束：`waiting_on=[张三]` + `notify:session-meta` + 张三 inbox；头部琥珀徽章「等待 张三 回复」；张三回复 → 清除（集合差）+ `notify:session-meta` 广播 |
| S10 | agent @用户 泛指 | 艾达行首「@用户」→ 收束 + `notify:awaiting-user`（无 targets，现语义）；头部「等待成员回复」；任一人回复清除 |
| S11 | waiting 对象被移出 / 停用 | 成员变更钩子：`waiting_on` 清洗（移除已不在的人类成员）；账号停用不影响（其行保留，恢复后可见）；账号删除级联行清理 |
| S12 | 编辑 / 删除消息对定向的影响 | 保持现状（M8 编辑只改 content，不重算 mentions / humanMentions）；`waiting_on` 不因编辑回滚（文档明示） |

### 8.6 持球方（waiting_on）生命周期

```
写入：Run 收束（finishRun）时 handedTo 非空 → 过滤（仅保留在场人类成员）→ 与既有值并集写入
      + notify:session-meta 广播 + 每目标 inbox 'waiting'（60s 同会话同目标聚合）
清除：该目标首条消息（任何路径）→ 集合差；空 → null + 广播
清洗：成员变更（移出人类成员）→ 移除；会话删除随行消亡
展示：会话头部琥珀徽章（多目标「等待 张三、李四 回复」）；被等待者 Composer 上方提示条
```

- 与 `handedToUser`（泛指）并存时：**handedTo 优先**（更具体的指定覆盖泛指；`waiting_on` 只写具体人）；
- 写入竞态防御：写 `waiting_on` 前校验「该目标在触发交还的消息之后尚未发言」（比较消息 seq），命中则跳过写入（防「收尾瞬间人已回复」）；
- 不挂起 Run（红线 6）：等待发生在 Run 收束之后，Run 互斥 / 配额 / 插话语义零变化；
- 超时：v1 不做自动催办；inbox `waiting` 项未读留存，徽章常在直至有人回复。

### 8.7 @ 寻址降级链与歧义处理

人类 token 注册优先级（服务端 `buildHumanMentionTokens`）：

| 优先级 | token | 注册条件 | 冲突处理 |
| --- | --- | --- | --- |
| 1 | 显示名 | 与在场 agent 名 / agentId 无冲突，且与其他人类显示名不重复 | 冲突 → 不注册该 token；Composer 标注原因 |
| 2 | `username` | 与在场 agent 名 / agentId 无冲突 | 冲突 → 不注册（该人类在此会话不可点名——极端边界，UI 提示走私聊 / 拍一拍类替代） |
| — | 行首 `@用户/@user/@你` | 恒可用 | 泛指（不指向具体人） |

- Composer 插入策略与解析注册策略同源：正常插入 `@显示名 `；显示名冲突 → 插入 `@username `（候选标注「与他人重名 · 将插入用户名」）；
- 解析：agent token 与 human token 独立注册（互斥），统一「长 token 优先」排序后一次扫描；**同一 token 不可能双命中**（注册期已互斥）；
- agent 幻觉 @ 不存在的人：token 未命中 → 不写 `waiting_on`、不产生定向 → 消息照常收束（现状兜底）；
- 显示名含空格：token 按原样注册（正则转义），Composer 插入完整 token；手输断词导致未命中可接受（username 恒为安全回退）。

### 8.8 LLM 侧协同（软约束，与硬门控配合）

- **`<human_roster>` 注入**（assembler 增可选块；仅当会话有在场人类成员且本回合为 agent 时注入，预估 <300 token）：
  ```
  <human_roster>
  本会话人类成员（可点名交付）：张三（产品经理）· @zhang · 李四 · @li
  人类之间的交流是讨论与协调，无需你响应；仅当被点名或指令明确指向你时行动。
  需要把任务交给具体的人：在回复行首用 @显示名，运行将交还并通知对方。
  </human_roster>
  ```
- **回合指令补充**（收尾段一行，仅有人类成员时）：「可 @具体的人交还任务（行首），或 @用户 泛指交还」；
- 硬门控（8.3 矩阵）保证人类讨论消息**不进入** Run 上下文（不注入 / 不 launch）；软约束进一步降低「历史中的讨论被误读为任务」的概率；
- 上下文预算：+<300 token，随 16k 夹具校准（既有先例）。

### 8.9 边界与失败模式清单（全盘）

| 场景 | 结论 / 处理 |
| --- | --- |
| 并发消息（A、B 几乎同时发送） | 服务端串行处理（Node 单线程）：先到者按空闲态判定（可能触发 Run），后到者按运行态判定（可能 inject）——现状语义天然定义序，文档明示 |
| 附件消息（content 为空 / 仅有引用） | 按 content 解析定向；无定向 → 矩阵常规路径 |
| 消息含多个 @人 + 无 @agent | 全体目标收通知；零触发 |
| @ 一个不在会话的人 | human token 未注册 → 未命中 → 按「无定向」走矩阵（可能 PRS——auto 模式下用户 @ 外部人又希望 AI 干活，语义合理） |
| waiting 目标在 mention 会话中回复 | 矩阵② 强制触发（越过 mention）——「被点名回复必达」 |
| 被等待者离线 | inbox 持久；上线补收（§9.3） |
| DM 处于隐藏态收到消息 | 自动复现（查询侧 `hidden && unreadCount == 0` 才过滤） |
| 会话同时有 viewer 与 @全体语义 | viewer 只读不可发（现状 403）；@全体 v1 不做 |
| PRS 组队被人类讨论误触发（auto + 无定向） | 这是 auto 的显式语义（零回归）；缓解 = 引导切 mention；不做隐式抑制 |
| 发送者在两个会话各被 waiting | waiting 为 per-session，互不影响 |
| 编辑 / 删除历史消息 | 不重算定向、不回滚 waiting（文档明示，保持现状语义） |
| agent 行首 @agent（handoff）与 @人（交还）并存 | 各行首独立解析：handoff 走既有归属；@人 → `handedTo`；两者同时存在时都生效（handoff 入队 + 交还收束按既有 merge 语义） |

---
## 9. WebSocket 稳定化设计（M79-A 详设）

### 9.1 主题模型（三维）

| 维度 | 主题形 | 订阅规则（`canSubscribe` 扩展） | 用途 |
| --- | --- | --- | --- |
| 会话主题 | `sessionId`（现状） | 归属可见（现状，含共享成员） | Run / 消息 / 审批 / 成员等全量会话事件 |
| **用户主题**（新） | `u:<userId>` | **仅本人**：`client.user.id === 主题内 id`；admin 亦不可代订（防越权读他人私聊信号） | 好友请求 / 被邀请 / 被 @ / 持球提醒 / presence |
| 全局主题 | `__assets__` / `__mcp__`（现状） | admin-only（现状） | 资产 / MCP 多标签同步 |

**自动绑定**：连接握手鉴权通过后，服务端直接把本人用户主题加入 `client.subscriptions`（无需客户端显式 subscribe——防「客户端忘了订」类遗漏；这是 D5 相对「客户端自订」的核心改进）。
**ACL 撤销即时化**：被移出会话 / 被拉黑 / 账号禁用 → 服务端对该用户全部连接主动 `unsubscribe` 对应主题并下发 `{type:'error', code:'acl-changed'}`，客户端收到后本地清理（列表 / 当前会话 / 未读）。

### 9.2 协议新增（帧族）

**server → client**：

| 帧 | 载荷 | 语义 |
| --- | --- | --- |
| `notify:inbox` | `{ item: InboxItem }` | 用户主题实时投递（客户端按 `item.id` 幂等合并；`sessionId` 存在时顺带 `ensureSubscribed`） |
| `notify:read-state` | `{ sessionId, lastReadSeq, ts }` | 本用户其他端已读推进（多端徽章同步；不发给对方——无已读回执） |
| `notify:presence` | `{ users: [{ userId, online, lastSeenAt }] }` | 聚合帧（可见范围：好友 ∪ 共同会话成员；500ms 节流合并） |
| `notify:friends-changed` | `{ userId, action: 'request'\|'accepted'\|'removed'\|'blocked' }` | 关系变化 → 联系人面板 / 候选刷新 |
| `notify:session-meta` | `{ session }` | 会话级元数据变更（`waiting_on` / 标题 / `kind` / `routeMode`） |
| `resync` | `{ reason: 'backpressure' \| 'gap' }` | 断开前通知（对端应立即转 REST 补齐；见 §9.5） |
| `error` | `{ code: 'conn_evicted' \| 'acl-changed', message }` | 连接被顶替 / 权限撤销 |

**client → server**：

| 帧 | 载荷 | 语义 |
| --- | --- | --- |
| `subscribe`（扩展） | `{ sessionIds, cursors }`（现状）+ 允许 `u:<id>` 形式入参（校验失败静默忽略） | 增量订阅（他人用户主题必败） |
| `read`（新） | `{ sessionId, seq }` | 已读上报（落 `session_reads` + 广播 `notify:read-state`） |
| `inbox-ack`（新） | `{ upTo: number }` | 收件箱整段已读（打开联系人 / 请求面板时） |

**向后兼容**：既有客户端不识别新帧 → 忽略（帧族扩展非契约破坏）；`/ws` 协议仍为 v1（`welcome` 帧免改）。

### 9.3 投递与一致性（三层模型）

```
事件产生（好友请求 / 邀请 / @ / 持球）
  → ① 持久化：user_inbox INSERT（每用户 seq 单调）——权威
  → ② 实时：WsHub.publishToUser(userId, { type:'notify:inbox', item })——快路径
  → ③ 兜底：REST GET /api/inbox?since=cursor（重连 / 降级轮询 / 缺口补齐）
```

- **inbox 承载边界（防膨胀）**：仅「跨会话个人事件」入 inbox（好友 / 邀请 / @提及 / 持球）；**DM 与群聊的逐条消息不落 inbox**——消息未读（`unreadCount`）+ toast 已足够，离线补收由消息 `seq` 天然保证；
- **幂等**：客户端按 `item.id` 去重（近 500 条 LRU）；`seq <= expected` 直接丢弃、`seq > expected + 1` 触发 `since=expected` 的 REST 补齐（缺口检测，修复现状缺口 #9）；
- **多端收敛**：同一用户 N 端各自独立游标；已读推进用 `upTo` 语义（区间已读，抗乱序）；
- **保留期**：`INBOX_RETENTION_DAYS=30` 定时清理（启动对账 + 每日一次；参照 M62 启动对账先例），超期仅删已读项，未读恒保留；
- **审计**：`session-invite` / `mention` / 好友变更同时落 `audit_log`（与 inbox 双轨，审计不随保留期清理）。

### 9.4 未读与已读（服务端权威）

- **口径**（单一定义）：`unreadCount = count(messages where seq > last_read_seq and userId != 自己)`——含 agent 与 system 事件条（与现状「notify 计数」精神一致但更准；`session_reads.last_read_seq` 以**消息 seq** 为参照系，非 notify seq）；
- **性能**：messages 表按 `(session_id, seq)` 索引聚合；会话列表一次聚合查询（N 会话单查询，避免 N+1）；
- **上报时机**：① 进入会话（`selectSession`）；② 窗口可见且处于该会话时收到新消息（`visibilitychange` + 事件驱动）；③ 「全部已读」入口；
- **多端同步**：任一端上报 → 广播 `notify:read-state` → 其余端覆盖本地（服务端为准，客户端 `ws-store.unread` 降级为显示缓存）；刷新 / 冷启动由会话列表 `unreadCount` 初始化；
- **迁移**：客户端旧 unread 内存计数数据源切换为服务端值；兼容模式下服务端同样计算（单用户视角行为等价）。

### 9.5 背压、连接上限与重连韧性

| 机制 | 设计 | 依据 / 先例 |
| --- | --- | --- |
| 发送队列上限 | 单连接待发 > `WS_SEND_QUEUE_MAX=256`（按 `socket.bufferedAmount` 判定）→ 发 `resync` 后主动 `terminate`；客户端退避重连并 REST 补齐 | StreamHub 的 pending 合并先例（慢客户端看最新帧）；通知通道不能丢帧 → 转 REST 补齐 |
| 每用户连接上限 | `WS_MAX_CONNS_PER_USER=8`：超限踢最旧连接（`error code='conn_evicted'`） | 防标签页泄漏 / 长尾连接堆积 |
| 心跳与半开 | 服务端 30s `ping`、2 周期剔除（现状保持）；**客户端侧新增** 60s 无任何帧 → 主动 `ping` 探活；`visibilitychange` 转前台且 `readyState != OPEN` → 立即重连（绕过退避） | 现状只有服务端单向心跳；后台标签 timer 节流场景需客户端主动补探 |
| 重连退避 | 指数退避加抖动 `delay * (1 ± 0.2)`；上限不变（`BACKOFF_MAX`） | 防多端同时重连风暴 |
| 建连限速 | 每 IP 每分钟 60 次升级尝试（复用既有 limiter 模式） | 与登录限速同族 |
| 订阅恢复 | 连接 open → 自动重订（现状）+ 用户主题服务端自动绑定（新）+ 每会话游标（现状） | 现状机制全保留 |
| 观测 | `GET /api/ws/stats`（admin）：连接数 / 活跃用户 / 待发队列水位 / 断连与重连计数 / resync 次数；`docs/operations.md` 增运维段 | M62-C admin 观测面先例 |

### 9.6 在线状态（presence）

- **推导**：`online = 活跃连接引用计数 > 0`；最后一条连接关闭 → `lastSeenAt = now`（离线事件延迟 30s 发出，吸收刷新 / 切页抖动）；
- **可见范围**：仅推送给「好友 ∪ 与该用户同会话人类成员」（M79-G 落地的唯一口径：收件人工厂 `createPresenceRecipients`——好友 ∪ 主体所属每个会话的属主与全部人类成员；去重、排除本人；非好友且不同会话的用户不可见）；
- **节流**：变更事件 500ms 聚合为批量帧 `notify:presence { users: [...] }`；
- **边界**：单进程内存态，重启后重建（首帧全量对齐）；不做多实例 presence（§9.7）。

### 9.7 边界与演进（明确后置）

单进程单实例部署（本地优先）为 v1 假定：连接表 / presence / 广播均为进程内存态，与现状一致。多实例部署演进路径（**不在本专项**）：① 粘性会话（LB hash 到实例）+ 会话主题单播；或 ② 引入共享总线（Redis pub/sub / NATS）替换进程内 `publish` 扇出，`user_inbox` 表天然兼容（权威层不变）；③ presence 上收共享缓存。本设计的所有「权威」均落 DB（inbox / reads / links），演进只替换快路径，不改数据契约。

### 9.8 配置新增（`.env.example` / `docs/operations.md`）

```bash
WS_SEND_QUEUE_MAX=256          # 单连接待发队列上限（超限 resync 断开；0=不限）
WS_MAX_CONNS_PER_USER=8        # 每用户并发 WS 连接上限（踢最旧）
INBOX_RETENTION_DAYS=30        # 收件箱保留期（已读项；未读恒保留；0=不清理）
PRESENCE_AGGREGATE_MS=500      # 在线状态聚合窗口
FRIEND_REQUEST_DAILY_LIMIT=20  # 好友请求日限额（每人）
```

### 9.9 测试（M79-A）

- server：`tests/m79-realtime.test.ts`——用户主题 ACL（本人可 / 他人无法订阅 / admin 不可代订）；inbox 投递（实时帧 + 落表 + seq 单调）；游标补齐（since 语义 / 缺口）；幂等（重放不重复计数）；背压（灌满队列 → resync + terminate）；连接上限（第 9 条踢最旧）；未读计算矩阵（自己消息不计 / system 计入 / 多端 read-state 广播）；presence（引用计数 / 聚合 / 可见范围）；ACL 撤销（移出会话 → unsubscribe + error 帧）；保留期清理（假时钟）。
- client：`tests/m79-realtime.test.tsx`——缺口检测补拉；`notify:inbox` 幂等合并；read 上报与多端覆盖；`resync` 转 REST；`conn_evicted` 提示与重连。
- E2E：`e2e/m79-realtime.spec.ts`——双端登录同一账号 → A 端读 → B 端徽章同步清；断线（WS 关闭）→ 事件零丢失重连补齐。

---

## 10. M79-B 用户画像与呈现升维

### 10.1 数据与投影

- `users` 三列（§7.2）；`UserInfo`（shared）增 `headline?/bio?/avatar?: UserAvatar`（`{ kind:'color'|'emoji', value:string }` 联合类型，`kind:'image'` 预留给后续上传）；
- 端点：`GET /api/me`（扩展 `/auth/me` 投影）+ `PATCH /api/me/profile`（本人；zod：displayName ≤60 / headline ≤30 / bio ≤120 / avatar 枚举 + 色值校验）；头像色值白名单（预设 12 色 + `#RRGGBB` 校验，防注入）；
- 投影面：`/users`（admin 列表）、好友列表、`/sessions/:id/shares`、会话 `humanNames` → 扩展 `humanProfiles: Record<userId, { name, headline?, avatar? }>`（**保留 `humanNames` 字段不删**，兼容既有客户端消费链 / 测试锚点）。

### 10.2 呈现升维（复用既有组件纪律）

| 位置 | 改动 |
| --- | --- |
| 消息气泡（MessageItem） | 他人人类消息作者行：头像（色块 + 首字 / emoji）+ 显示名 + 头衔 chip；与 agent 头像体系同尺寸约束；自己的消息维持现状 |
| 共享弹窗（ShareDialog） | 行式布局首字母头像 → 画像头像与头衔（**既有文案锚点全保留**：placeholder / 「邀请」「改为只读」等按钮文案与『@username』锚点不动——m57-shares 测试依赖） |
| 会话列表预览 | 预览署名所用 `userName` → 显示名（数据源扩 `humanProfiles`） |
| 设置页 | 「我的资料」卡（显示名 / 头衔 / 简介 / 头像色盘；保存即生效；见 §14.9） |
| 成员条 / 席位 | chat 会话显示对端人类条（复用成员条位置与视觉口径；见 §14.4） |

### 10.3 测试

server：`m79-profile.test.ts`（校验矩阵 / 投影面 / admin 改他人资料被拒 / 代理画像不含敏感字段）；client：设置卡 + 气泡渲染 + ShareDialog 画像行（锚点回归绿）。

---

## 11. M79-C 好友体系与在线状态

### 11.1 关系模型与状态机

```
无关系 ──request──▶ pending ──accept──▶ accepted ──remove──▶ 无关系
                      │  │
                      │  └─reject──▶ 无关系（行删除，可再申请，受日限流）
                      └─block（任一方）──▶ blocked ──unblock──▶ 无关系
```

- 单行双向：`user_a < user_b`（字典序）；请求方记 `requested_by`；
- `accepted` 唯一判定好友；`pending` 双向可见（收到 / 发出两列表）；`blocked` 对双方呈现「无关系」，被拉黑方发起请求 → 400「对方设置了隐私限制」（不暴露拉黑事实）；
- 解除好友 = 删行；**既有 DM / 群聊会话保留可读写**（关系仅约束「新建私聊 / 默认邀请候选」，避免历史协作链断裂）。

### 11.2 端点、限流与隐私开关

| 端点 | 说明 |
| --- | --- |
| `GET /api/friends` | 好友列表（含 `online/lastSeenAt/headline/avatar` 与最近会话 id，按在线 → 最近活跃排序） |
| `GET /api/friends/requests` | `{ incoming: [...], outgoing: [...] }` |
| `POST /api/friends/requests` | `{ userId?, username?, message? }`；目标不存在 → 404；已是好友 → 409；反向 pending 存在 → 提示可接受；日限流 20 |
| `POST /api/friends/requests/:id/accept` · `/reject` | 收件人专属（`requested_by != me`） |
| `DELETE /api/friends/:userId` | 解除（任一方；删行 + 双向 `notify:friends-changed`） |
| `POST /api/friends/:userId/block` · `/unblock` | 拉黑（隐含解除）；解除拉黑回「无关系」 |
| `GET /api/users/search?q=` | 成员可用；排除自己 / disabled / 已拉黑；隐私开关 `searchable=false` 者仅精确 username 命中（存在性最小暴露）；限流 30/min |

隐私开关（`UserPreferences` 扩展，走既有 `getPrefs/setPrefs`）：`searchable`（默认 true）、`allowFriendRequests`（默认 true，false 时请求 403「对方未开放好友申请」）。

### 11.3 通知联动（依赖 M79-A）

- 请求 → 目标 inbox `friend-request`（实时 `notify:inbox` + `notify:friends-changed`）；
- 接受 → 双方 inbox `friend-accepted` + 双方连接 `notify:friends-changed`；
- 全部动作落 `audit_log`（`friend.request/accept/reject/remove/block`）；
- 在线状态：见 §9.6；联系人列表首帧由 `GET /api/friends` 返回快照，增量由 `notify:presence` 维护。

### 11.4 测试

server：`m79-friends.test.ts`——状态机全链（请求 / 重复请求 409 / 反向并存 / 接受 / 拒绝后重发 / 拉黑四面切断（搜索 / 请求 / 私聊创建 / 邀请候选）/ 解除拉黑）；限流（日界）；隐私开关矩阵；审计行。client：联系人面板（请求操作 / 搜索 / 在线点 / 兼容模式隐藏）。

---

## 12. M79-D 人物会话（私聊 / 群聊）

### 12.1 会话形态与语义

| kind | 成员 | participantIds | 引擎行为 | 标题 |
| --- | --- | --- | --- | --- |
| `team`（存量） | owner + shares 成员（任意） | agent 成员键 | 现状（@ 直达 / PRS 路由） | 存储标题 |
| `direct`（新） | 双方（editor） | 恒空 | **永不启 Run**（无 agent + kind 门控） | 动态 = 对端画像显示名（不落库，防改名过期） |
| `group`（新） | 创建人 + 受邀者（editor） | 空（v1）；**可后加 agent**（邀请即混编，§13.6） | 默认免路由（mention 语义）：仅 @agent 唤起 | 存储标题（可改名） |

- **创建私聊**：`POST /api/chats/direct { userId }` → 校验（好友 / 非自己 / 目标 active；admin 同规不豁免）→ `dm_key = [min,max].join('|')` → 命中既有则复用（并清除双方隐藏行）→ 否则建 `kind='direct'`，`owner_id` 仅记录创建人（**不做属主特权**：DM 无「仅属主」操作），双方写 `session_members(role='editor')`，首条 system 事件条「X 与 Y 开始了对话」；
- **并发创建竞态**：`dm_key` 唯一索引兜底——插入冲突（SQLITE_CONSTRAINT）→ 降级为查询命中复用；
- **创建群聊**：`POST /api/chats/group { title, memberIds[] }`（1–50 人；成员须为创建人好友，v1）→ `kind='group'`，创建人 owner + 其余 editor，system 事件条「X 创建了群聊并邀请 A、B」；
- **消息行为**：对 chat 形态 `POST /sessions/:id/messages` 无 @agent 时 append + 会话主题广播刷新（**不调用 engine.launch**——D 批先落「chat 零 Run」；含 @agent 且 `participantIds` 非空 → 走 launch，E 批收口完整触发矩阵）；
- **工作区**：chat 会话照常分配沙盒工作区（复用现有创建路径，**零特判**——消息附件上传 / 交付件 / 搜索链零改动，避免「无工作区会话」特例扩散）；
- **免路由由 kind 派生**（chat 恒 mention 语义，无独立列）；team 的 `route_mode` 列在 E 批引入。

### 12.2 隐藏 / 退群 / 删除

| 操作 | direct | group | team |
| --- | --- | --- | --- |
| 隐藏会话 | `POST /sessions/:id/hide`（仅本人列表；收到新消息自动复现 = 查询侧 `hidden && unreadCount == 0` 才过滤） | 同左 | 不提供（现状删除语义保留） |
| 退出 | 不支持（只有隐藏；对方不受影响） | `POST /sessions/:id/leave`（复用现状）→ 退出后成员不可见、历史保留 | owner 不可退（现状） |
| 删除整会话 | 不支持（避免单方删掉对方历史） | owner：`DELETE /sessions/:id`（现状语义） | 现状 |

### 12.3 邀请与群管理

- 群聊邀请：**任何成员可邀请自己的好友**（`shares.ts` 按 `session.kind` 分流：`group` 时 `assertSessionOwner` → `assertSessionWrite` + 目标须为邀请者好友）；被邀请人实时收 inbox `session-invite`（D13，修复 M57 缺口）；团队会话维持 owner-only；
- owner 可移出成员 / 改群名 / 删群（复用 shares DELETE / `PATCH /sessions/:id` 扩展 title 对 group 放开给 owner）；
- viewer 角色对 chat 形态不开放（邀请入群恒 editor；只读共享仅团队会话语义）。

**实施注记（M79-AA，ADR 0201）**：退出 / 解散入口落地「成员」弹窗（行内二次确认；成员「退出群聊」/ 群主「解散群聊」，chat 形态此前无入口）；退出与移出补系统事件条留痕（group「群聊」/ team「协作」+ turn-end 广播）；群名 `PATCH title` 收紧为 **owner-only**（editor 403）；`/leave` 对 direct 400 防护；解散广播 `notify:session-deleted` payload 增 `kind`（成员端「群聊已被解散」文案）；会话列表行补群聊重命名入口（owner 可见）。

### 12.4 列表与未读

- `GET /sessions` 增 `kind` + `unreadCount`（服务端计算）；客户端会话列表：团队 / 聊天同列按更新时间（kind 图标区分：Users / MessageCircle）+ 顶部筛选 chip「团队 / 聊天」（**默认选中第一个「团队」**，点选过滤 / 再点取消回全部——2026-09-20 修订移除「全部」项 + 默认首项；见 §14.1）；
- 未读徽章 = 服务端值（D7）；会话头部：`direct` 显示对端画像行（名 + 头衔 + 在线点）；`group` 显示成员头像组（人类）+ 人数。

### 12.5 测试

server：`m79-chats.test.ts`——DM 唯一（并发创建竞态：dm_key 唯一索引兜底 + 命中复用）；隐藏 / 复现；群创建 / 邀请（好友校验）/ 移出 / 退群 / owner 删群；**免路由矩阵**（chat 无 @ → 零 Run；chat @agent → Run；team 现状零变化）；消息发送对 chat 的跳过引擎断言（engine.launch spy）。client：创建入口（联系人 / 好友行）/ 列表分区 / 隐藏交互 / 群管理菜单 / 未读徽章。

---

## 13. M79-E 真人入会话与 @ 调度（引擎实现）

### 13.1 解析层（服务端）

- 新函数 `buildHumanMentionTokens(members: HumanMemberInfo[])`：按 §8.7 注册规则产出 `{ token, userId }[]`；
- 新函数 `parseAllMentions(text, agentTokens, humanTokens)`：两表合并统一「长 token 优先」匹配，返回 `{ mentions(agentKeys), humanMentions(userIds), handedToUser, handedTo(userIds) }`；行首判定：`@具体人` → `handedTo`；`@用户/@user/@你` → `handedToUser`（现语义保持）；
- 既有 `parseMentionsWithTokens` 零改动（`parseAllMentions` 内部复用其匹配逻辑，避免双实现）；`stripMinutesBlocks` / 边界（`MEMBER_BOUNDARY`）同源生效；
- 持久化：`ChatMessage.humanMentions`（D2）——agent `mentions` 字段语义零变更。

### 13.2 触发门控（`POST /messages` 入口，矩阵 §8.3 单点实现）

```ts
// 伪码：engine 边界之外的路由层判定（与 inject 入口共用同一判定函数）
const signals = resolveTriggerSignals({ session, parsed, senderId, activeRun })
switch (signals.action) {
  case 'launch':  engine.launch(session.id, message.id, { mode }); break   // ① @agent ② waiting
  case 'inject':  engine.inject(session.id, message.id); break             // 运行态 ① @agent ② waiting ④ auto 无定向
  case 'store':   /* 仅存储 + 广播 + 通知；引擎零调用 */ break             // ③ @human ⑤ ⑥ 静默
}
if (signals.clearWaiting) sessions.clearWaitingOn(session.id, senderId)   // 集合差清除（任何路径）
```

- `resolveTriggerSignals` 为纯函数（输入信号 → 动作），单测直接覆盖矩阵全表（§8.3 每行一例）；
- `inject` 分支需扩展：当前 `inject` 无「仅存储」概念——新增 route 层分支（`engine.inject` 不被调用即为 store；不改 inject 本身）；
- `launch` 分支的 PRS 路径仅在「无 @agent 且 waiting 命中且 team」时进入（现状 `needsRouting` 判定保持，但上方已过滤 @human / mention 无定向两类）。

### 13.3 收尾与持球（finishRun 扩展）

- `RunRecord` / 波末 merge 增 `handedTo: string[]`（波内多 agent 的 handedTo 按并集合并，与 `handedToUser` 的 OR 语义同族——`mergeWaveSchedule` 扩展一行）；
- `finishRun`：
  1. `handedTo` 非空 → 过滤（仅在场人类成员）→ 写入 `sessions.waiting_on`（并集；写前校验目标在该消息 seq 后未发言——§8.6 竞态防御）；
  2. `notify:awaiting-user` payload 增 `targets: userIds`（无非 targets 时兼容现状）；
  3. publish `notify:session-meta`（携带最新 session）；
  4. 每目标 inbox `waiting`（「X 在会话「Y」等你回复」；60s 同会话同目标聚合——聚合键 `sessionId+targetId`，窗口内重复跳过）；
  5. `handedToUser`（泛指）单独存在时：不写 `waiting_on`，仅现有 `notify:awaiting-user`（零变化）。

### 13.4 通知联动（用户消息 @人）

- store 路径中：`humanMentions` 非空 → 每目标（排除发送者自己）inbox `mention`（「X 在会话「Y」提到了你」；60s 聚合）+ 未读推进（目标端会话 unreadCount 自然增长）；
- 发送者在线视角无额外 toast（安静原则）；目标端：非当前会话 → toast「张三 提到了你」+ 列表徽章；
- 审计：`session.mention`（actor / targets / messageId）。

### 13.5 成员变更钩子（waiting 清洗）

- `shares.ts` DELETE / leave / 成员移出路径 → `sessions.clearWaitingForUsers(sessionId, removedUserIds)`（best-effort）；
- 账号删除（`DELETE /users/:id`）→ 其参与的会话 `waiting_on` 清洗（复用同一函数，在删库前执行）；
- 清洗后如有变化 → `notify:session-meta` 广播。

### 13.6 群聊加 agent（反向邀请）

- 群聊通过既有成员 API（`POST /sessions/:id/members`）把 agent 加入 `participantIds` → 群变混编；权限：群内任意 editor 可拉 agent 进群（`members` 路由按 kind 分流：group 放宽；team 维持 owner 语义——与 shares 同一分流点）；
- 混编群 @agent → 唤起 Run；agent 收尾交还按 §13.3；
- 事件条文案：「张三 邀请 艾达 加入协作」（复用既有文案内核）。

### 13.7 测试（M79-E）

server：`m79-trigger.test.ts`（矩阵全表逐行——空闲 / 运行 × @agent / @human / 行首 @用户 / 无定向 × auto / mention × team / chat）+ `m79-human-mention.test.ts`（解析矩阵：裸名 / username / 冲突降级链 / 行首 vs 句中 / minutes 容器兼容 / 幻觉 @）+ `m79-waiting.test.ts`（收尾写入 / 并集合并 / 竞态防御 / 集合差清除 / 成员清洗 / inbox 聚合 / session-meta 广播）+ `m79-chats` 扩展（混编群 @agent）；client：@ 候选人类条目 / 冲突标注 / 头部徽章 / 提示条 / chips；E2E：`m79-social.spec.ts`（双浏览器全链，见 §17）。

---
## 14. 前端交互设计（M79 全批）

> 原则：沿用既有组件与视觉口径（紧凑布局 / 文案失焦 / 动效克制）；**兼容模式下（multiUser=false）本章全部 UI 不渲染**；既有文案锚点（m57-shares / e2e 依赖）一律保留。

### 14.1 信息架构与入口

```
左栏（会话轨，宽 ~200px）
┌─────────────────────────┐
│ [会话 | 联系人]  ← 顶部 Tabs（新增；仅 multiUser 渲染）
│ ── 会话模式（现状）───────
│  头部：会话 N + ＋新建 / 搜索框（现状）
│  筛选 chip（新增）：团队 | 聊天（默认选中「团队」；点选过滤 / 再点取消 = 全部）
│  会话行：kind 图标 + 标题 + [协作/只读徽章] + 未读[服务端] + 预览
│   direct 行标题 = 对端显示名；副信息 = 在线点 + 最近消息
│ ── 联系人模式（新组件 ContactsPanel）────
│  请求区（有 incoming 时置顶）→ 搜索 → 好友列表 → 新建群聊
└─────────────────────────┘
```

**2026-09-23 视觉收口（左栏头部）**：会话模式头部由四行收敛为三行，且首行与主区页签行等高对齐（分隔线跨栏贯通）——
`① 页签行（h-11）`：`[会话 | 联系人]` 分段控件（灰轨道 + 白色激活块，与主区「对话 / 画布」同款视觉语言）+
右端「新建会话」＋（不再单占一行标题；仅会话页签渲染）；`② 筛选行`：团队 / 聊天 chip + 过滤后计数右对齐
（`visibleSessions.length`，随筛选实时变化）；`③ 搜索行`（占位与锚点不变）。`①②` 之间不设分隔线（同一工具区块），
仅搜索行下缘一条分隔线；兼容模式（multiUser=false）仍保留原「会话 N + ＋新建」头部不变。

- Tabs 在「联系人」上有未处理请求数角标（红色小徽章，复用 badge-pop 样式）；
- 会话筛选 chip：仅过滤本列表显示（不影响未读总计）；**默认选中第一个「团队」**（无「全部」项，点选过滤 / 再点取消回全部——2026-09-20 修订：移除「全部」项 + 默认首项）；状态存 ui-store（会话级内存，不持久化）；
- kind 图标：team = 无图标（现状）；direct = `MessageCircle`；group = `Users`（12–13px，置于标题左侧，与画布小点同排纪律）；
- 命令面板（CommandPalette）同步增「打开联系人」「新建群聊」两个条目（沿用现有条目样式）。

### 14.2 联系人面板（新组件 `ContactsPanel.tsx`）

**结构（自顶向下）**：

1. **请求区**（`incoming` 非空时显示，否则整区隐藏）：
   - 区标题「好友请求」（带数字）；
   - 请求行：头像 + 显示名 + 附言（截断一行） + 「接受」（主色按钮） + 「拒绝」（幽灵按钮）；
   - 操作后行内移除；全处理完 → 区消失（布局不下跳：占位高度收缩动画克制，无新动画库）；
   - `outgoing` 折叠行：「已发出 N 条请求」→ 展开列出（可撤销 = 删除请求，调 reject 同语义端点）。
2. **搜索框**：placeholder「搜索用户（用户名 / 昵称）」；250ms 防抖 → `GET /users/search`；结果行：头像 + 显示名 + @username + 头衔 + 关系态按钮：
   - 无关系 → 「加好友」；
   - `pending outgoing` → 「已申请」（禁用）；
   - `pending incoming` → 「接受」；
   - `accepted` → 「私聊」；
   - 空结果 → 「未找到匹配用户」；限流 429 → toast「搜索过于频繁，请稍后再试」。
3. **好友列表**：行 = 头像（含在线点：绿/灰，`aria-label` 在线态） + 显示名 + 头衔徽章 + 副行（最近活跃时间 / 最近会话名）；排序 = 在线优先 → 最近活跃；hover 显示两个图标按钮：
   - 「私聊」（`MessageCircle`）：`POST /chats/direct` → 成功 `selectSession(id)`；已存在直接切；
   - 「邀入当前会话」（`UserPlus`，仅当有当前 team 会话且本人为 owner 时显示；否则隐藏）→ 复用 `POST /sessions/:id/shares` → toast「已邀请「张三」」；
   - 行点击主体 = 同上「私聊」行为（减少寻靶成本。现微信式直觉）。
4. **底部**：「新建群聊」（`Users` 图标 + 文字按钮，全宽虚线边样式，与空态卡风格同族）。

**空态**（无好友）：居中虚线卡（复用 ShareDialog 空态样式）：「还没有好友」+ 「搜索用户名添加好友」；「新建群聊」仍可用（群成员需为好友——无好友时按钮禁用 + tooltip）。

**加载态**：请求区 / 好友列表各自骨架行（2 行灰条）；错误态：区级重试按钮（重拉 `GET /friends`）。

### 14.3 创建流

- **发起私聊**：§14.2 行内动作；已存在 DM → 直接切换；不存在 → 创建后切换；目标已停用 / 拉黑关系 → 错误 toast（透出服务端文案）；
- **新建群聊对话框**（`CreateGroupDialog.tsx`）：
  - 群名输入（placeholder「群聊名称」；留空 → 默认「A、B 的群聊」）；
  - 好友多选列表（搜索过滤 + 勾选；已选头像排列在输入区上方，可点 × 移除）；
  - 底部：「创建」（主按钮，≥1 名成员可提交） + 「取消」；
  - 提交 → `POST /chats/group` → 关闭 + `selectSession` + toast「群聊已创建」；
- **邀人入群**：群会话头部「成员」按钮 → 群成员弹窗（见 §14.4）；团队会话「共享」按钮 → ShareDialog 现状；
- **邀请第二位人类入团队会话（引导）**：ShareDialog 邀请成功态附一行轻提示「多人协作建议开启『仅点名唤起』，避免交流被 AI 误响应」+ 「开启」按钮（`PATCH /sessions/:id { routeMode:'mention' }`，成功后 toast「已切换为仅点名唤起」；仅 owner 显示该按钮）。

### 14.4 聊天会话视图（ChatArea 复用与分支）

| 区域 | direct | group | team（现状） |
| --- | --- | --- | --- |
| 头部标题 | 对端显示名 + 在线点（副行：头衔） | 群名 + 「N 人」 | 现状 |
| 头部按钮 | 「成员」（查看成员弹窗） | 「成员」（成员管理 + 邀请）+ owner「群设置」 | 「共享」「资源」现状 |
| 「AI 自动应答」开关 | 不渲染 | 不渲染（恒 mention） | 渲染（auto/mention 切换；owner/editor 可点） |
| 「等待 X 回复」徽章 | 不适用 | 渲染（waiting_on 非空） | 渲染 |
| 消息区 | 同构（人类气泡升级 §14.6） | 同构 | 现状 |
| 输入区成员条 | 人类成员条（头像 + 在线点 + 名字） | agent + 人类并排（人类带在线点；分组序：agent 编制序 → 人类） | 现状（agent 条） |
| 输入框 placeholder | 「发消息…（@ 可点名）」 | 「发消息…（@ 可点名成员或 AI）」 | 现状 |
| Composer 其他 | 无持球提示（无 agent） | mention 提示条（§14.5） | routeMode=mention 时提示条；waiting 提示条 |

**成员弹窗（群 / direct）**：行式布局（复用 ShareDialog 行纪律）：人类成员（头像/名/头衔/在线点）+ 群 owner 菜单（移出、转让？v1 不做转让）+ 底部「邀请好友」按钮 → 好友选择器（复用 CreateGroupDialog 的多选组件）；被邀者实时收 inbox。

### 14.5 Composer 扩展（`Composer.tsx`）

- **@ 候选分组**（自顶向下）：「成员」（agent，现状分组） → **「协作成员」（人类，新增）** → 「文件」 → 「技能」（后两类现状：仅输入查询词时显示）；
- 人类候选条目：头像 + 显示名 + 头衔 hint；重名冲突时 hint 变「与他人重名 · 将插入 @username」；
- 插入策略：正常 `@显示名 `；冲突 / 含空格显示名用户主动选择时插入 `@username `（与解析注册策略同源，§8.7）；
- **mention 提示条**（仅 team + routeMode=mention + 输入非空且无 @agent / @human 命中时显示）：输入框上方一行浅灰小字「未点名成员：本条将作为协作消息发送（AI 不响应）」；
- **waiting 提示条**（自己 ∈ waiting_on 时，优先级高于 mention 提示条，二者互斥）：浅琥珀底「艾达 在等你回复」；
- 发送行为不变（Enter / 附件 / 停止）；发送失败（网络 / 403）沿用现状错误 toast；
- 键盘导航：候选列表 ↑↓ / Enter / Esc / Tab 全沿用现状实现（人类条目复用同一数据结构）。

### 14.6 消息渲染（MessageItem 扩展）

- **他人人类消息**：头像（色块 + 首字 / emoji，取 `humanProfiles`，缺省回退首字母头像现状） + 显示名 + 头衔（浅色小字） + 时间；气泡样式与 agent 消息对齐但保留人类区分口径（现状人类消息已有独立样式——只换头像/署名区，气泡本体不动）；
- **humanMentions chips**：正文中 `@名字` 高亮渲染（复用 agent 点名 chip 的样式类；点击 v1 无操作，悬停 tooltip「协作成员」）；
- **system 事件条**：不动（“开始了对话 / 创建了群聊 / 邀请…加入协作 / 等待已清除”等复用现状渲染）；
- 搜索命中跳转（M9 FTS）对 chat 会话同样生效（搜索为全消息级，零改动）。

### 14.7 持球与等待 UI

- **头部件徽章**：`waiting_on` 非空 → 琥珀描边圆角徽章「等待 张三 回复」（多目标逗号分隔，超 2 人「等待 张三 等 3 人」；tooltip「成员已被点名，等待其回复；任何人回复即清除」）；点击 → v1 仅 tooltip（不跳转）；
- **被等待者提示条**：§14.5；回复发送成功（服务端返回）即消失（本地先行隐藏 + `notify:session-meta` 到端纠正）；
- **其他成员视角**：徽章可见（知道球在谁手上）；无额外打扰。

### 14.8 未读与通知

- 列表未读徽章：服务端 `unreadCount`；当前会话可见时自动上报已读（静默）；
- 浏览器标题 / 总徽章（`syncBadge`）数据源切换为服务端未读汇总；
- **toast 策略**（克制）：
  - 好友请求：`toast`「张三 请求添加你为好友」（点击文案不跳转；V1 只有文案）；联系人 Tab 角标同步 +1；
  - 被邀请入会话：`toast`「张三 邀请你加入「会话名」」；
  - @我（非当前会话，消息通知）：「张三 在「会话名」提到了你」（点击 toast 不可交互，V1 不跳转）；
  - DM 新消息（非当前会话）：「张三：截断预览」；
  - 上述 toast 与既有 run 类 toast 同族（同位置、同时长、同去重节流）；
- **多端同步**：`notify:read-state` 到端 → 徽章即时清零；
- 通知权限：沿用现有 `Notification.permission` 请求（无新流程）。

**M79-I 补注（通知中心）**：持久收件箱的 UI 落点——顶栏「通知」按钮 + 未读徽章；面板按 seq 新在上列出跨会话个人事件（好友申请 / 已同意 / 会话邀请 / @提及 / 等你回复 / 系统）；点击条目 = **单项已读**（`POST /inbox/read { ids }`）+ 跳转（会话类打开会话并订阅；好友类切联系人页签）；「全部已读」= `upTo`。**ack 语义收敛**：打开联系人面板仅将「好友申请」类置为已读（内容已在请求区可视），邀请 / 提及 / 持球保留未读交由通知中心复看——替换原设计「打开联系人即整段已读」（`inbox-ack` 整段语义仍保留给「全部已读」动作）。

### 14.9 设置页（成员视角）

- 新「我的资料」卡（置顶于成员设置页；`client/src/components/settings/` 新增 `MyProfileCard.tsx`）：
  - 预览行：头像（实时预览） + 显示名 + 头衔；
  - 字段：显示名（必填）/ 头衔（≤30）/ 简介（≤120，多行）/ 头像：色盘（12 预设色）+ emoji 输入框（单个字符校验）二选一（分段控件）；
  - 「保存」：`PATCH /api/me/profile` → toast「已保存」；失败 toast 透出；
- 隐私开关区（同卡下方或新「隐私」卡）：两个 Switch：「允许他人搜索到我」「允许好友申请」（写入 user prefs）；
- 管理面（admin）的「用户管理」列表行头像升级为画像（有则用）。

### 14.10 状态、边界与响应式

- **兼容模式（multiUser=false）**：左栏 Tabs / 联系人 / 私聊 / 群聊 / 筛选 chip / 资料卡 / 隐私开关 / 在线点全部不渲染；team 路径与现状逐字节一致；
- **窄屏（<900px）**：左栏自身已是抽屉——抽屉内同样呈现 Tabs 与联系人面板；无需额外适配；私聊头部按钮≤2 个（成员）保证 390px 不溢出；
- **超级长文本**：群名 / 显示名截断规则沿用现状（会话标题截断）；
- **错误态文案**：好友请求 429「今日好友申请已达上限，请明日再试」；非好友建 DM 403「仅好友之间可以发起私聊」；被拉黑建 DM 400「对方设置了隐私限制」；发送失败沿用现状；
- **加载骨架**：联系人首拉骨架（§14.2）；会话列表沿用现状；
- **动效克制**：零新动画库；新交互复用既有 `badge-pop` / hover 过渡类。

### 14.11 交互细节清单（验收用）

| 项 | 要求 |
| --- | --- |
| 键盘 | @ 候选导航不变（↑↓/Enter/Esc/Tab）；联系人搜索框 Enter 不提交（即时搜索） |
| 焦点 | 新建群聊弹窗打开时焦点入群名输入框；对话框关闭焦点回归触发按钮（沿用 Radix Dialog 默认） |
| ARIA | 在线点 `aria-label`（在线 / 离线）；未读徽章 `aria-label`（N 条未读）；联系人 Tab 角标含语义 |
| 文案 | 全站精简口径（无感叹号、无营销词）；空态逗号句式与现状一致 |
| 三态 | 每个新面（联系人 / 群管理 / 资料卡）必须有加载 / 空 / 错误三态实现与测试 |
| 反馈 | 设置保存 / 邀请成功均有 toast 反馈；列表内操作就地更新（不整屏刷新）|

---
## 15. API 总览（新增 / 变更）

| 方法 | 路径 | 权限 | 批次 | 说明 |
| --- | --- | --- | --- | --- |
| GET | `/api/inbox?since=&limit=` | 本人 | A | 收件箱增量（游标） |
| POST | `/api/inbox/read` | 本人 | A | 整段已读（`upTo` / `ids`） |
| POST | `/api/sessions/:id/read` | 会话可见者 | A | 已读上报（`seq`） |
| GET | `/api/ws/stats` | admin | A | 连接 / 队列 / 断连观测 |
| GET | `/api/me` | 本人 | B | 画像投影（原 `/auth/me` 兼容保留） |
| PATCH | `/api/me/profile` | 本人 | B | 画像维护 |
| GET | `/api/users/search?q=` | 成员 | C | 用户搜索（限流） |
| GET | `/api/friends` · `/api/friends/requests`（GET/POST） | 成员 | C | 好友列表 / 请求收发 |
| POST | `/api/friends/requests/:id/accept` · `/reject` | 收件人 | C | 请求处理 |
| DELETE | `/api/friends/:userId` | 任一方 | C | 解除 |
| POST | `/api/friends/:userId/block` · `/unblock` | 本人 | C | 拉黑 / 解除 |
| POST | `/api/chats/direct` | 成员（好友校验） | D | 私聊创建 / 复用 |
| POST | `/api/chats/group` | 成员 | D | 群聊创建 |
| POST · DELETE | `/api/sessions/:id/hide` | 会话可见者 | D | 隐藏 / 取消 |
| GET | `/api/sessions`（变更） | 现状 | D/A | 增 `kind` / `unreadCount` / `routeMode` / `waitingOn` |
| PATCH | `/api/sessions/:id`（变更） | owner/editor | E | 接受 `routeMode`（group 群名改写扩展） |
| POST | `/api/sessions/:id/messages`（变更） | editor+ | E | 触发矩阵接入 + `humanMentions` 解析 + 通知 |

`docs/api.md` 增「§23 社交协作」章节（实施批收口时同步；本表为契约先行依据）。

---

## 16. 权限矩阵（新增面）

| 操作 | admin | 会话 owner | editor | viewer | 非成员 |
| --- | --- | --- | --- | --- | --- |
| 查看私聊（direct） | 现状可见（**明示边界**） | — | 双方 | — | 404 |
| 发起私聊 | 须为好友 | — | — | — | 须为好友 |
| 创建群聊 | ✓ | — | — | — | ✓ |
| 群聊邀请 | — | ✓（任意好友） | ✓（自己的好友） | — | ✗ |
| 团队会话邀请 | — | ✓ | ✗ | ✗ | ✗ |
| 切换 routeMode | — | ✓ | ✓ | ✗ | ✗ |
| @真人 | 会话内 | ✓ | ✓ | ✗（只读） | ✗ |
| agent 拉人进群（members API） | — | ✓ | ✓（group）/ ✗（team） | ✗ | ✗ |
| 隐藏会话 | 本人 | 本人 | 本人 | 本人 | — |
| 收件箱 | 本人 | 本人 | 本人 | 本人 | 本人 |
| 在线状态可见 | 好友 ∪ 同会话 | 同左 | 同左 | 同左 | ✗ |
| **M79-AF 补充行（操作面写闸门：可读不可写 → 403，不可读 → 404）** | | | | | |
| 浏览器接管 / 归还 / 关闭 / takeover token | — | ✓ | ✓ | ✗ | 404 |
| 定时任务 改 / 删 / 立即触发 / 启停 | — | ✓ | ✓ | ✗ | 404 |
| 媒体任务 取消 / 重试 | — | ✓ | ✓ | ✗ | 404 |
| 运行 停止 / 指挥台重排 | — | ✓ | ✓ | ✗ | 404 |
| **审批 批准 / 拒绝（决定与读面同口径：触发者 ∪ 属主）** | — | ✓（属主兜底） | 仅本 Run 触发者 | ✗ | 404 |
| 交还提示（awaiting-user toast） | — | 属主收到 | 持球 targets 收到 | 非持球不收 | — |

---

## 17. 测试与验收总账

| 面 | 内容 |
| --- | --- |
| server 单测（新 6 文件） | `m79-realtime`（§9.9）· `m79-profile` · `m79-friends` · `m79-chats` · `m79-trigger`（矩阵全表）· `m79-human-mention` / `m79-waiting`（可并为 `m79-human`）| 
| server 回归 | `m57-multiuser` / `m57-p2-shares` / `m57-p3-*` / `m16` / `m22` / `m24` / ws 相关全绿；**兼容模式断言**（multiUser=false 旧路径零变化）；**零回归门**：team+auto 路径行为快照对比（store 级）| 
| client 单测 | `m79-realtime`（§9.9）· 联系人面板（三态 / 请求操作 / 搜索关系态）· 资料卡 · 会话列表（分区 / kind 图标 / 未读）· Composer（人类候选 / 冲突标注 / 提示条两态）· 气泡 / 头部徽章 / 群管理弹窗；**既有锚点回归**（m57-shares / m57-auth 不动）| 
| E2E | 新 `m79-social.spec.ts`（双浏览器，独立实例端口，幂等自清理）：① admin 建 bob → 互搜加好友（请求 / 接受 / 角标 / toast）② 发起私聊 → 双端消息与未读 ③ 建群（含 bob）→ 群消息 ④ 团队会话邀 bob 入会（inbox 实时到达，不再依赖 reload）⑤ @真人（bob 收通知 / 零 Run）⑥ 切 mention 后无 @ 消息零 Run ⑦ @agent 唤起 → agent 收尾 @bob → 头部徽章 + bob 提示条 → bob 回复徽章消失；新 `m79-realtime.spec.ts`（§9.9）；`m57-auth` 回归 | 
| eval | 不涉 agent 资产（check:agents 零变更）；MockProvider 剧本扩 @真人 / waiting 场景（E2E 固定剧本依赖）；eval 基线复跑 | 
| 门禁 | 每批：四包 typecheck / lint + 双端 vitest + 定向 E2E（PW_OUTPUT_DIR 隔离）+ 计数镜像面；收口：全量 + eval 基线 + 文档三索引对齐 | 

---

## 18. 实施任务分解（按批次）

> 每批开工前：`git add -A && git commit` 快照 → 核对编号 → 跑基线门禁；每批结束后：本文件状态行回写 + ADR 落盘 + 双索引对齐。

### M79-A 实时通道基座（2–2.5 天，v21，ADR 0187–0189）

| 面 | 文件（新增 ● / 修改 ○） |
| --- | --- |
| server | ○ `ws.ts`（用户主题 / 自动绑定 / `publishToUser` / `read` / `inbox-ack` / 背压 / 上限 / resync / stats）· ● `store/inbox.ts` · ● `store/session-reads.ts` · ● `routes/inbox.ts` · ○ `routes/sessions.ts`（`/read` + 列表 `unreadCount` 聚合）· ● `realtime/presence.ts` · ○ `config.ts`（5 配置）· ○ `store/migrations.ts`（v21）· ○ `index.ts`（装配 / 禁用断连 / 保留期定时） |
| shared | ○ `types.ts`（`InboxItem` / `NotifyType` 扩展 / `SessionSummary`） |
| client | ○ `lib/ws.ts`（缺口检测 / 抖动 / resync / evicted / 前台探活）· ● `stores/inbox-store.ts` · ○ `stores/ws-store.ts`（新帧消费 / unread 服务端化）· ○ `stores/session-store.ts` |
| 测试 | ● `server/tests/m79-realtime.test.ts` · ● `client/tests/m79-realtime.test.tsx` · ● `e2e/m79-realtime.spec.ts` |
| 镜像面 | `.env.example` · `docs/operations.md`（WS 运维段）· `docs/api.md`（§23 起） |

### M79-B 用户画像（1 天，v22，ADR 0190）

| 面 | 文件 |
| --- | --- |
| server | ○ `store/migrations.ts`（v22）· ○ `auth/service.ts`（profile 更新 / 投影）· ● `routes/me.ts`（`GET /me` / `PATCH /me/profile`；或并入 `routes/auth.ts`，落地定）· ○ `routes/shares.ts` / `routes/sessions.ts`（`humanProfiles`） |
| client | ● `lib/avatar.ts`（头像渲染工具）· ● `components/settings/MyProfileCard.tsx` · ○ `MessageItem.tsx` · ○ `ShareDialog.tsx`（画像行）· ○ `SessionList.tsx` / `ChatArea.tsx`（署名）· ○ `stores/auth-store.ts` |
| 测试 | ● `server/tests/m79-profile.test.ts` · ● `client/tests/m79-profile.test.tsx`（含 ShareDialog 锚点回归） |

### M79-C 好友体系（1.5 天，v23，ADR 0191–0192）

| 面 | 文件 |
| --- | --- |
| server | ○ `store/migrations.ts`（v23）· ● `store/friends.ts` · ● `routes/friends.ts`（含 `/users/search`）· ○ `realtime/presence.ts`（可见范围接入）· ○ `middleware.ts`（限流复用） |
| client | ● `components/contacts/ContactsPanel.tsx` · ● `stores/friends-store.ts` · ○ `AppLayout.tsx` / `SessionList.tsx`（左栏 Tabs 容器）· ○ `stores/ui-store.ts`（tab / 筛选 chip）· ○ `CommandPalette.tsx`（两条新命令） |
| 测试 | ● `server/tests/m79-friends.test.ts` · ● `client/tests/m79-contacts.test.tsx` |

### M79-D 人物会话（2 天，v24，ADR 0193）

| 面 | 文件 |
| --- | --- |
| server | ○ `store/migrations.ts`（v24）· ○ `store/sessions.ts`（`kind` / `dm_key` / hides / createChat 助手）· ● `routes/chats.ts` · ○ `routes/sessions.ts`（列表字段 / hide 端点 / 免路由分支）· ○ `routes/shares.ts`（kind 分流） |
| client | ● `components/contacts/CreateGroupDialog.tsx` · ● `components/sessions/ChatMembersDialog.tsx` · ○ `SessionList.tsx`（筛选 chip / kind 图标）· ○ `ChatArea.tsx`（头部分支）· ○ `Composer.tsx`（placeholder）· ○ 成员条（人类条）· ○ `stores/session-store.ts`（createChat / hide） |
| 测试 | ● `server/tests/m79-chats.test.ts` · ● `client/tests/m79-chats.test.tsx` |

### M79-E 触发判断与 @ 调度（2.5–3 天，v25，ADR 0194–0195）

| 面 | 文件 |
| --- | --- |
| server | ○ `store/migrations.ts`（v25）· ○ `orchestration/parser.ts`（`buildHumanMentionTokens` / `parseAllMentions`）· ● `orchestration/trigger.ts`（`resolveTriggerSignals` 纯函数）· ○ `routes/sessions.ts`（触发门控接入 / inbox 通知）· ○ `orchestration/engine.ts`（`handedTo` merge / `finishRun` waiting / routeMode 门控）· ○ `orchestration/members.ts`（`HumanMemberInfo`）· ○ `context/assembler.ts`（`human_roster`）+ 回合指令 · ○ `store/sessions.ts`（`waiting_on` 读写 / `clearWaitingForUsers`）· ○ `routes/shares.ts` / `routes/users.ts`（清洗钩子）· ○ `routes/sessions.ts`（`PATCH routeMode`） | 
| client | ○ `Composer.tsx`（人类候选 / 冲突标注 / mention 提示条 / waiting 提示条）· ○ `ChatArea.tsx`（等待徽章 / routeMode 开关）· ○ `MessageItem.tsx`（chips）· ○ `lib/members.ts`（人类 token 展示）| 
| 测试 | ● `server/tests/m79-trigger.test.ts` · ● `server/tests/m79-human.test.ts`（mention+waiting）· ● `client/tests/m79-trigger.test.tsx` · ● `e2e/m79-social.spec.ts` |

---

## 19. 被否决的方案

| 方案 | 否决理由 |
| --- | --- |
| LLM 意图分类自动判断是否触发 | 不可见 / 不可审计 / 不可测；违反「不做隐藏路由器」既有纪律（ADR 0082 同族否决先例）；用显式信号 + 会话策略取代 |
| 全部会话默认静默（mention） | 变更存量语义（零回归红线破）；存量单用户会话突发「AI 不响应」；已选题面：auto 默认 + 引导切换 |
| 独立 IM 栈（平行消息表 / 独立推送） | 双份未读 / 渲染 / 搜索 / 附件 / ACL；违背「一切皆会话」；工作量翻倍且长期维护分裂 |
| 人类塞进 `participantIds`（agent 键空间） | 污染引擎不变量（`queue ⊆ participants`、编制链、记忆归属、M77 分身键）；测试面全爆 |
| 挂起 Run 等待真人（parked run） | Run 互斥锁被长时间占用（与并发配额冲突）、断线不可控；「收束 + 持球方」等价且零引擎风险 |
| 未读维持客户端自算 | 多端不一致、刷新即丢 |
| 个人事件只走 WS 不落持久表 | 离线丢失、无重放权威、多端收敛无依据 |
| 引入 Redis / 消息队列（本专项） | 单进程本地部署，超需求；演进路径已留（§9.7） |
| admin 可见性在 v1 直接收紧 | 破坏既有运维 / 审计 / WS ACL 全链语义；列为后续开关 |
| 群聊邀请沿用 owner-only | 轻量群协作语境过重；按 kind 分流 |
| 人类头像 v1 做图片上传 | 上传 / 裁剪 / 存储 / 配额一整条管道；色块 + emoji 已满足 |
| DM 单方删除整会话 | 会连带删掉对方历史；改为「隐藏」（新消息自动复现）| 
| typing / 已读回执 / 撤回 / @全体 / 群角色细分 | 通知风暴面扩大或隐私争议；v1 边界外（§2.5）| 

---

## 20. 风险登记

| 风险 | 影响 | 对策 |
| --- | --- | --- |
| auto 默认下的误触发（人类讨论被 AI 响应） | 体验 / 成本 | 显式引导（邀请第二位人类时提示 + 头部一键切换）+ 发送侧提示条；矩阵可解释；不隐式抑制 |
| @ 寻址冲突（重名 / 与 agent 重名） | 误派 | 降级链（§8.7）+ Composer 标注 + 解析单测矩阵；极端情况不可点名（文档明示） |
| waiting 与运行态并发（罕见） | 语义模糊 | waiting 命中优先为 inject（显式例外，单测锁定）；正常时序下 Run 已收束 |
| admin 可见性隐私争议 | 信任 | 文档 + ADR 明示边界；**M79-G 更正**：admin 对成员私有会话本就无内容旁路（owner ∪ 成员唯一事实源；ADR 0197），不需要 `DM_ADMIN_VISIBLE` 开关；拉黑四面切断兜底 |
| 通知风暴（群聊 + 多端 + presence） | 带宽 / 性能 | 聚合节流（presence 500ms / 提及 60s）+ 连接上限 8 + 背压 resync |
| 好友请求 / 搜索滥用 | 骚扰 | 日限流 / 搜索限流 / 拉黑即时生效 / `allowFriendRequests` 开关 |
| 迁移兼容（存量会话） | 回归 | `kind='team'` / `route_mode='auto'` 默认值 + 新列可空 + 兼容模式路径断言进测试 |
| DM 并发创建竞态 | 重复会话 | `dm_key` 唯一索引兜底 + 命中复用 |
| 双人 E2E 并发不稳 | 门禁红 | m57-auth 双上下文先例 + 独立端口 / `PW_OUTPUT_DIR` 隔离 + 幂等自清理 |
| 与并行批次编号冲突 | 文档错乱 | 开工前全仓检索（M78 已被 tarot 预测占用）；让位 + 双索引对齐 |
| 上下文预算（human_roster 注入） | 成本 | <300 token 预算 + 16k 夹具校准 |
| inbox 膨胀 | 存储 | 保留期 30 天 + 仅跨会话个人事件入箱（DM 逐条不入）+ 索引 |
| 会话列表语义膨胀 | 体验 | 分区筛选 chip + kind 图标 + chat 与 team 视觉锚点区分 |

---

## 21. 实施前检查清单

1. **确认门**：本稿经评审确认后开工（本文件头部状态由「等待确认」→「已确认」）；任何批次开工前不落代码；
2. **编号核对**：design.md 最新章节（现 §112）/ docs/adr 最新（现 0185）/ tarot 批（M78 / 0186 / §113 / v97）是否已落——占用则按最新顺延并更新本文件头部；
3. **留底**：`.git` 已初始化——每批动手前 `git add -A && git commit` 快照；
4. **契约先行**：先落 shared 类型（`InboxItem` / `FriendLink` / `UserAvatar` / `kind` / `humanMentions` / 新 `NotifyType`）+ 迁移 + WsHub `publishToUser` 接口，再动行为；
5. **测试先行**：`m79-realtime` / `m79-trigger` 骨架 + 既有 ws / m57 套件回归基线先跑绿；
6. **批次门禁**：四包 typecheck / lint + 双端 vitest + 定向 E2E（`PW_OUTPUT_DIR` 隔离）+ 计数镜像面；
7. **文档收口**：design.md §114+ + ADR 0187–0195 + `docs/adr/README.md` 索引 + `docs/api.md` §23 + `docs/operations.md` + `.env.example` + 本文件状态行回写（实施后按 M62 先例回填落地注记）；
8. **兼容冒烟**：`multiUser=false` 启动跑通首屏 / 会话 / 联系人入口隐藏三断言；
9. **镜像面**：server / client 测试计数、E2E helpers（双用户工具函数）、agents/CHANGELOG（若涉资产协议则登记，否则不登）。

---

## 22. 落地注记（2026-09-20，实施后回填）

**批次与提交范围**：M79-A（实时通道基座）→ B（画像）→ C（好友）→ D（人物会话）→ E（触发判断与 @ 调度）全量落地；迁移 v21–v25；ADR 0188–0196。

**实施期与规划的差异（以代码为准）**：

1. **画像维护端点**：规划 `PATCH /api/me/profile` → 实现落 `PATCH /api/auth/profile`（与 `/auth/me`、`/auth/preferences` 同族；`GET /api/me` 复用 `/auth/me` 投影，不另设重复端点）；
2. **presence 可见范围**：规划「好友 ∪ 同会话成员」→ v1 曾收窄为好友面 → **M79-G 已扩展回设计原案**（收件人工厂 `createPresenceRecipients`；见注记 7）；
3. **触发矩阵实现单点**：落于 `routes/sessions.ts` POST /messages 的 `shouldTrigger`（agent 定向 / waiting 命中 / 无定向且 auto）；引擎侧仅补 `handedTo` 累积与收尾写入（`deps.sessionHumans` / `deps.onHandedTo` 注入——测试环境缺省即零差异）；
4. **E2E spec 已补批落地**：`e2e/m79-social.spec.ts`（1 例：好友 UI 全链 → 私聊 → 群聊 → 邀请实时化（M57 缺口修复断言）→ @真人提及 chips → 触发策略零引擎）+ `e2e/m79-realtime.spec.ts`（1 例：多端未读实时增量 + read-state 对账徽章消失）；auth 项目 testMatch 扩展为 `(m57-auth|m79-social|m79-realtime)`，新增 `PW_AUTH_PORT` / `PW_AUTH_DATA_DIR` 隔离参数（默认 8790 / data/e2e-auth 零变化）；默认实例 5/5（m57×3 + m79×2）、隔离实例（8791）两轮连跑 2/2 幂等；
5. **`notify:turn-end` 复用为 chat 补播帧**（payload 携带 message；无 message 时维持原「旁观态轻微信号」语义）。
6. **M79-F 前端收口（设计 §14 补齐）**：群 / 私聊头部「成员」入口替代「共享」（团队保持共享语义）；ChatMembersDialog（成员名单 + 群主移出二次确认 + 「邀请好友」选择器——候选 = 好友 − 已在场，role 恒 editor）；ShareDialog 多人协作静默引导行（owner + 已有成员 + 仍为 auto → 一键切「仅点名唤起」）；会话列表筛选 chip（团队 / 聊天；2026-09-20 修订：移除「全部」项 + 默认选中第一个「团队」——点选过滤 / 再点取消回全部）；命令面板「打开联系人 / 新建群聊」（仅多用户模式）；
7. **M79-G 隐私与可见性收口**：presence 可见域 = 好友 ∪ 同会话人类成员（收件人计算工厂化可测；客户端 `ws-store.presenceMap` 通用面 + `OnlineDot` 抽公共——成员弹窗 / @ 人类候选 / 联系人共用）；**admin 无会话内容旁路**经代码复核确认并回归固化（`m79-privacy.test.ts`：详情 / 写操作 404、列表仅自有、搜索无命中、WS 可见集不含）——本条更正注记此前「admin 对私聊可见」的表述，且**不引入** `DM_ADMIN_VISIBLE`（ADR 0197）；
8. **M79-H 拉黑消息面补完与微体验**：拉黑对在**人物私聊**发新消息 → 403 拒发（落库前，文案分视角不泄漏拉黑事实；团队协作面不受限，历史可回看——ADR 0198）；`.env` 无新增；联系人离线点 tooltip「最后在线：x 分钟前」；E2E 补强：m79-social 增群「成员」弹窗 + 同会话在线点（bob 重连产生确定性 presence 事件）+ 会话筛选 chip 步骤，行定位改「标题精确匹配」（修掉残留群会话预览同名导致的误点）；
9. **M79-I 通知中心（持久收件箱 UI 落点）**：`InboxPanel`（顶栏入口 + 未读徽章 + 类型标签 + 单项已读/全部已读/跳转；兼容模式不渲染）；`inbox-store.ack(ids)` 新增；联系人面板 ack 收敛为「仅好友申请类」；E2E 补通知中心复看步骤；层叠修复：banner `backdrop-blur` 建立的堆叠上下文使面板无法覆盖主区 → header 显式 `relative z-40`；
10. **M79-J 设计对账审计（行级补齐）**：对 §14/§16/§18 逐条核验后补——① §14.9 隐私开关 UI（`MyPrivacyCard`：允许搜索 / 允许好友申请，GET/PUT `/auth/preferences` 即时保存 + 失败回滚）与 admin 用户管理行头像画像；② §14.4 chat 形态头部（direct = 对端名 + 在线点 + 头衔副行；group = 群名 + 「N 人」）+ 输入区人类成员条（头像 + 在线点 + 名字；点击 @显示名，冲突回退 @username）+ chat 专属 placeholder；③ §8.8 `<human_roster>` 软约束注入（assembler L3 + 交还指令行；engine 4 处 prepareTurn 透传；无人类零差异）+ `HumanMentionInfo.headline` 随行；④ §16 矩阵落地：成员编制管理（`POST/DELETE/PATCH /sessions/:id/members*`）team/direct 收紧 owner-only、group 放宽 editor（`canManageLineup` 单点；m57-p2-shares 写探针改用重命名并固化 403 语义）；⑤ §14.11 ARIA（未读徽章「N 条未读」/ 联系人角标「N 条好友请求」）；⑥ 测试账合并说明：`m79-human-mention` / `m79-waiting` 按 §17 许可并入 `m79-trigger`（§13.7 原案允许「可并为 m79-human」）；
11. **M79-K E2E 终账（§17 ⑦ + MockProvider 剧本扩）**：E2E 补第 4c 步——@agent 唤起 → mock 行首 @真人（`[[handoff:姓名]]` 剧本标记）→ `waiting_on` 持球徽章 → 被点名提示条 → 回复即清除（补齐 §17 ⑥⑦ 之间的持球全链）；过程连带修复三处真实缺陷：① **mock 触发块在共享会话静默失效**（`lastUserText` 只认 `【用户】` 前缀，M57 P2 署名后共享会话恒为空 → 一切触发块/标记不生效；改 `【…】` 泛匹配）；② **`notify:session-meta` 客户端零消费**（ws-store 无归约分支——「他人回复清除持球」广播到达但徽章不消失；补 applySession 归并）；③ **`applySession` 空键残留**（waiting_on 清空 / route_mode=auto 时服务端序列化省略键，浅合并保留旧值——含「切回自动应答开关不复位」同因 bug；关键字段显式归一）；E2E 收束等待改用「停止」出现→消失双段（「你的回合」历史胶囊会立即命中，不可作收束信号）；
12. **M79-L 多实例演进（共享总线 / 跨实例 presence）**：`NOTIFY_BUS=db` 启用——NotifyHub 挂载 `DbNotifyBus`（本地下发保持现状；总线行跨实例传输，`kind=session|user`；origin 排除防回环；实例启动游标 = maxId 不重放历史，缺口由重连 resync + REST 权威层补齐）；跨实例 presence 计数表 `presence_instances`（离线广播前合并全局合计、stale 忽略；30s 心跳刷行 + 回收）；迁移 v26；配置 `NOTIFY_BUS` / `NOTIFY_BUS_POLL_MS` / `NOTIFY_BUS_RETENTION_MINUTES` / `INSTANCE_ID`；`ws/stats.bus` 观测；ADR 0199；测试 `m79-multibus`（两实例共享 DB 真 WS 跨实例投递 + 防回环 + 存储/门控单测）；**默认 memory 模式单实例零开销、行为逐字节一致**；
13. **M79-M 聊天模式 @agent 边界澄清与展示面收口**（用户实测反馈）：行为边界（本就如此，经测试固化）——**纯人聊天**（direct/group 无 agent 编制）@agent 名不触发（人类定向语义仅存储，无 runId）；**混编群**（agent 经成员 API 入编）@agent → 正常唤起 Run（m79-chats 增正/反例断言）；展示面修复——Composer 成员条对**人物会话**不再走「全量 agent 兜底」（该兜底为 team/场景空编制的 M48 召唤面，保留不变），纯人聊天不再展示任何 agent 条目（防「可 @」误示）；混编群仅展示在编 agent；@ 候选面板同源自动收敛；客户端 composer 测试增四态用例（direct/group 无编制收口 · 混编群仅在场 · team 空编制兜底回归）；
14. **M79-N 实测反馈三修**：① 他人人类消息气泡加 `w-fit max-w-full`（容器 `flex-1` 致短文本被拉到 82% 全宽——截图实测缺陷；编辑态同修）；② ShareDialog 增「从好友选择」快捷邀请（好友 − 属主 − 已在场，点选即邀 editor，免输用户名——团队模式「加不了真人」的体验根因：原仅用户名输入；团队邀请本不要求好友，功能一直可用）；③ 澄清：私聊不可扩为多人（IM 惯例，ADR 0194）；多人群聊走「新建群聊」多选好友（1–50 人）——当前环境仅 2 账号故候选 1 人；
15. **M79-O 新建会话直接拉真人（一步邀请）**：建会话组队台（`CreateSessionDialog`）编制栏底部新增「协作成员（真人）」好友多选（多用户模式；打开时拉好友，空态提示）；创建成功后对选中好友自动 `POST /sessions/:id/shares { role: editor }`（`Promise.allSettled` 汇总成败，失败不阻塞会话创建）；**纯真人组合（无 agent 编制）自动置 `routeMode=mention`**（防未 @ 消息触发 PRS 组队——UI 内有琥珀提示）且按钮文案计入真人（「创建并进入（N 位成员）」）；E2E 增 5b 步（勾好友 → 填标题 → 创建即进入 → 自动「仅点名唤起」可见 → 对方不刷新实时收到邀请）；两条原生路径并存：聊天形态一步（私聊/群聊创建）· 团队形态一步（本项）· 既有「先建后共享」仍可用；
16. **M79-P 纯人聊天隐藏 AI 状态条**（实测反馈）：Composer 底条对「人物会话且无 agent 编制」隐藏 范式 chips（执行/规划/评审）与右端上下文电池/本 Run 费用/轨迹（`ContextBar`）——判据 `aiBarVisible = !isChatSession || poolMembers.length > 0`（混编群有 agent → 保留；team / 场景含 M48 空编制会 PRS 组队 → 保留）；快捷键提示（Enter 发送 · @ 召唤 · / 命令）保留；composer 测试增三态用例；E2E 私聊处负例 + 团队处正例；
17. **M79-Q 真人图片头像（kind:'image' 实装）**：客户端 `cropSquareImage` 裁 256²（WebP 回退 PNG）→ `POST /api/auth/avatar`（raw ≤2MB；**服务端魔数重算**仅 PNG/JPEG/WebP，拒绝 SVG）→ DB 存文件名 / `toUserInfo` **唯一投影点**转公开 URL（`/api/avatars/<file>`，ts 版本化 + immutable）→ `HumanAvatar` 图片分支（onError 回退首字，全域组件自动生效）；清理三路：换图删旧 / PATCH 显式改色块删旧 / 删号级联；「保存资料」在图片模式不携带 avatar（防清除）；兼容模式 400；E2E 增 5c（设置页上传 → 对端联系人可见）；ADR 0200；
18. **M79-R 团队共享弹窗升级为完整成员管理（与聊天成员弹窗一致）**：邀请区**好友多选批量**（勾选 chips → 「邀请（N 人）」`Promise.allSettled` 汇总成败；按用户名输入保留为兜底路径——团队邀请不要求好友）；成员行**移出二次确认**（点『移出共享』进确认态 → 『确认移出』/『取消』；点即删改为确认后删）；文案锚点全保留（placeholder『用户名（由管理员在「用户管理」创建）』/『邀请成员（按用户名）』/『邀请』/『改为只读』『改为可协作』/『移出共享』标题/『退出共享』——m57-shares 单测与 m57-auth E2E 依赖零破坏，E2E 移出流同步补『确认移出』步）；
19. **M79-S 纯人聊天隐藏右栏（用户确认）**：人物会话（direct/group）且无 agent 编制时——宽屏右栏 Panel 不渲染（`rightVisible = rightPanelOpen && !humanOnlyChat`；布局换算同步口径）、头部右栏显隐按钮隐藏；窄屏「团队」抽屉入口（底部成员条按钮）与团队抽屉整体不渲染、底条对纯人聊天整体隐藏（人类成员 @ 条在 Composer，底条无可展示内容）；**不修改用户偏好**（`rightPanelOpen` 持久化值保留，切到团队/混编群会话即恢复原态）；混编群（有 agent）与 team/场景会话不受影响；E2E 私聊负例 + 团队正例；
20. **M79-U 多真人会话 agent 消息实时补投（缺陷修复）**：缺陷——会话含多个真人时，agent 消息仅经 SSE 推给触发者，其他真人成员（及同账号其他标签页）收不到内容，**刷新后才可见**；根因——engine `finishTurn` 的 `notify:turn-end` 帧**不带 message**（仅元数据），客户端 handler 因无 message 直接忽略，`notify:run-completed` 只做提示与未读聚合；修复——`notify:turn-end` payload 附完整落库消息（与 routes 层补播模式一致；agent 消息收尾唯一路径（串/并行/续写共用 finishTurn）故一处修全链）；客户端既有 handler 同会话 upsert 自动生效（幂等：SSE 端 streaming 消息按 id 合并覆盖）；跨会话 agent 消息维持「不 upsert、不打扰」（未读由 run-completed 聚合）；验证——server `m79-chats`（帧含 message.role=agent / status=complete / messageId 一致）+ client `m79-realtime`（同会话 upsert / 跨会话不处理）+ E2E 4c（bob 触发的 pm 回复经 WS 实时出现在 admin 侧）。
21. **M79-W 群聊式全同步（缺陷修复：触发型消息广播 / 订阅覆盖 / 跨会话全同步）**：症状——多真人会话中 A 触发 B/C 能收到，B 再触发 A/C 收不到需刷新；真人消息推不到其他真人。根因三处——① `POST /sessions/:id/messages` 的 **launch/inject 分支不广播**（触发型人类消息只走 SSE 单播；M79-D 补播仅覆盖 !shouldTrigger 分支）；② 客户端订阅依赖用户点击（ensureSubscribed 只在打开会话/收件箱帧时纳入「当时列表」，新分享会话从未订阅）；③ 跨会话 agent 消息被有意忽略（M79-U 口径）+ run-completed 才计未读（双计）。修复——① 服务端 launch/inject 分支补 `notify:turn-end(message)` 广播；② 客户端列表变化/首载自动全量订阅（ensureAllSubscribed）；③ turn-end 跨会话统一处理：任何消息（human/agent）计未读 + `noteIncoming` 列表行预览即时更新 + 800ms 防抖 `loadSessions` 权威对账（人类消息保持轻提示；自己的多标签消息只更新预览不计未读）；④ run-completed 移除本地 +1（未读归消息级计数，对账兜底）。验证——server `m79-chats` 触发型人类消息帧断言 + client `m79-realtime` 三用例（跨会话 agent/人类/own-human + run-completed 去双计）+ E2E 4e（双向实时气泡 + 跨会话未读徽标 + 轻提示 + active-run 轮询收束）；4d/4e 的「+2 计数」断言同步改「内容气泡 + 尾行锚点」（对话为虚拟列表，DOM 计数随窗口波动，不可作 +N 依据——2026-09-20 修订）。
22. **M79-X 全同步审计收口（消息编辑/删除 · 会话删除 · 权限加固）**：以「真实群聊全同步」为口径逐面审计，补上三处硬缺口——① **消息编辑不广播**（PATCH /messages 只回响应）→ 广播 `notify:turn-end(message)`（upsert 语义天然覆盖内容更新）+ 仅作者本人可编辑（403）；② **消息删除不广播** → 新增 `notify:message-deleted`（同会话即时移除 + 列表对账）+ 权限（他人人类消息仅属主可删）；③ **会话删除不广播** → 新增 `notify:session-deleted`（成员与多标签列表即时移除；当前会话被删回到空态并提示）；另补：同会话 turn-end 同步更新列表行预览（noteIncoming 统一口径）。审计已确认无缺口的同步面：会话元数据（session-meta/applySession 跨会话生效）、成员变更、邀请 inbox→列表即时刷新、已读多端、presence、附件/交付件/画布、审批/计划/任务、运行状态。**有意不做**（IM 可选增强，非同步缺口）：typing 指示、对方已读回执（现设计为仅本人多端同步 + 未读对账）、旁观端逐字流（保持收尾整条以省流量）。验证——server m79-chats 帧断言（编辑/403/删除/会话删除）+ client m79-realtime（两帧处理）+ E2E 4f（编辑与删除跨用户实时）+ 清理步（会话删除成员侧列表即时移除）。
23. **M79-Y 穷举式全量审计（写操作 × 广播矩阵）第二批缺口修复**：以「服务端全部写路由 × 是否广播 × 多实例覆盖 × 客户端消费」穷举核对，补上五处——① **计划批准不广播**（resolve approved 分支无帧，成员计划卡停留 submitted）→ 补 `notify:plan-updated`；② **指挥台重排不广播**（engine.reorderQueue 仅 SSE emit）→ 新增 `notify:queue-updated`（客户端仅本端活跃 Run 生效）；③ **ACL 撤销/踢出不跨实例**（revokeSession/kickUser 未走总线——多实例下被移出者仍收帧/禁用账号连接不断，安全面）→ NotifyBusEntry 扩展 `kind: revoke|kick` + deliverRemote 本地执行 + `listSince` kind 映射修复（原实现把非 user 一律归一 session，导致安全条目被吞）；④ **资料变更不广播**（昵称/头像改后好友列表需刷新）→ `AuthRouterDeps.onProfileChanged` 装配层给好友 `publishToUser(notify:friends-changed)`；⑤ **`notify:context-compressed` 客户端无消费分支** → 补 case（本端活跃 Run 压缩计数对齐）。确认无缺口面：plans 编辑、canvas（124 行）、media/schedules（service 层发布）、inbox/read、friends/shares、会话绑定（publishPanelOp 局部）、connection-status 死类型（无发布点）。**有意缓办**：会话资源绑定（MCP/连接）与记忆变更的成员间实时同步（弹窗打开时 REST 拉取正确，并发概率低）。验证——engine.test（queue 帧）+ m79-multibus 2 例（revoke 跨实例退订与非到达断言 / kick 跨实例断开）+ client m79-realtime（两 case 活跃 Run 语义）+ auth E2E 5/5 回归。
24. **M79-Z 旁观端流式（打字机对齐）**：触发者走 SSE 逐字、旁观者此前仅收尾整条（体验不对称）。实现——engine 流式 delta 三处发出点旁路新增**节流聚合广播**（120ms 窗口合并 → `notify:message-delta`，payload：messageId/agentId/memberKey/delta；帧量 ~8fps/run 远低于 WS 背压阈值）；**顺序保证**：回合收尾前先 flush 残帧再发 turn-end 完整消息（客户端 upsert 按序覆盖为权威终态，丢帧自愈）；收尾后残帧（record 已移除）直接丢弃并回收聚合器（防 Map 常驻）。客户端——新 case：非本端活跃 Run（runId 守卫去重，触发者不重复渲染）且同会话时，首帧自动创建 streaming 占位（成员身份随帧；seq 占位 0，收尾权威覆盖）+ appendDelta（复用 40ms 批量净化管线）；跨会话不渲染（未读仍由 turn-end 计）。多标签同账号同样获得流式（与旁观者同路径）。验证——engine.test（delta 帧存在 + 字段 + **先 delta 后 turn-end** 顺序断言）+ client m79-realtime（首帧建占位/累积/触发者跳过/跨会话忽略）+ E2E 5/5 回归。
25. **M79-AA 交接目标具体化 + 回放条收敛**：① **交接条泛称「你的回合」→ 具体真人渲染**：服务端新增 `record.messageHumanMentions`（per-message 人类交还目标，@具体人精确来源）；`emitTurnEnd` 统一落库 `message.humanMentions`——@用户（无具体 @人名）展开为**全体在场真人**（"所有真人都参加调度"），@具体人沿用解析目标，无人类列表时保底触发者；客户端 HandoffBar 新增 humanMentions 分支：HumanAvatar 头像流 + 具体名字（`data-handoff-targets` 锚）+ 点击头像一键接棒；旧消息（无目标数据）回退「你的回合」；**正文泛称同步展开（2026-09-23 补漏，用户实测）**——agent 正文中的 `@用户` / `@user` chip 与交接条同源展开为具体定向人名（'@你' 保持第二人称；无定向数据 / 兼容模式回退原 token）：`MdMessageInfo` 增 `humanLabels`（MessageItem / CanvasComposer 注入），Markdown remark 插件就地展开（`data-mention` 锚保留原 token）+ 渲染缓存 key 计入展开名。② **波次回放条**：去「回放」文字（cap 改图标开关 `data-wave-toggle`）+ **默认隐藏**、点击展开/收起完整条（is-collapsed 紧凑样式）；m45 E2E 与单测同步适配（默认收起断言 + 展开步）。验证——server m79-chats（@用户 → humanMentions=全员集合断言）+ client handoff-bar（具体名/一键接棒/回退 + MessageItem 集成展开）+ markdown（展开 / 多目标顿号连接 / 回退 / 缓存不串）+ m45-replay（折叠/展开）+ E2E auth 5/5（含交接条名字断言）与 m45 spec 1/1。
26. **M79-AB 断线重连权威补偿（缺陷修复：断线窗口的用户主题帧丢失）**：症状——新建会话邀请对方后"要刷新"才可见。根因（结合 dev 实况数据与日志定位）——邀请/收件箱投递走**用户主题帧**（无游标、无重放缓冲），而**会话主题**有游标补发、**消息**有 REST 兜底；服务重启 / 网络抖动窗口内到达的用户主题帧**重连后无任何补偿**（实测：服务 13:21-13:26 重启，该窗口的邀请帧永久丢失）。修复——① 重连成功（非首次建连）→ REST 权威补偿：收件箱快照（`inbox sync`）+ 会话列表对账（`loadSessions`）；② 降级轮询（WS 不可用）每个 tick 同步补收件箱与会话列表（该例外路径此前同样漏用户主题）。验证——client `m79-reconnect`（重连补偿 +1 且首次建连不重复补偿）+ 全量回归（client 1319）与 E2E auth 5/5。附：member 创建会话链路核查无缺口（无配额限制 / 无首登闸门 / 前端入口无门控 / 历史有 member 成功创建）——"其他人创建不了"建议先刷新旧页面复测。
27. **M79-AC 半开连接自愈闭环（缺陷修复：连接假死只能刷新恢复）**：症状——"连接好像不稳定，过一会要刷新才会恢复"。根因——**半开连接**（TCP 假死：链路已断但浏览器 `readyState` 仍为 OPEN、收不到 close 事件）下，客户端探活只"60s 无帧发一次 ping"，**探测无应答时无任何后续动作**——永久挂在假连接：降级横幅不出现（状态仍是 open）、推送静默丢失，唯一出路是刷新页面。修复（`lib/ws.ts`）——① **探活闭环**：60s 无帧发 ping；持续无应答（≥2× 阈值=120s）判定半开 → `close()` 触发常规重连（退避无限重试）；② 半开关闭握手挂起兜底：8s 后仍未 CLOSED → 弃用旧连接直接重连；③ 旧连接迟到事件（open/message/close）守卫——防双重重连与状态错乱。衔接 M79-AB：重连成功后自动补收件箱 + 会话列表（完整自愈链：断线→探测→重连→补订阅（带游标）→补权威数据，全程无刷新）。验证——client `m79-realtime`（半开用例：90s 探活 ping → 150s 强关 → 退避重连；fake timers 精确时序）+ 全量 1320 例 + E2E auth 5/5（其中 P3 首跑为并发资源竞争假失败，单跑 3/3 甄别）。
28. **M79-AD 工作台打开通道 / 工具按钮 / 审批定向（用户实测三项）**：① **「在 3D 工作台打开」静默失效**（"有的打开了，有的没有"）：原通道为 window 事件——工作台面板尚未挂载时（首次进入/消息未加载完）事件无人接收、点击无反应。修复：迁移为 **ui-store `pendingStudioOpen` 状态通道**（requestStudioOpen → store；StudioPanel 挂载后消费并清空）——无论面板何时渲染，打开请求必被消费并选中方案（时机竞态根治）。② **工作台工具按钮竖排**（窄容器压缩致文字逐字换行）：`.studio-btn` 加 `flex:0 0 auto + white-space:nowrap`；`.studio-panel-btns` 加 `flex-wrap:wrap + justify-content:flex-end`（空间不足整行换行，不挤压）。③ **审批推送范围**：`notify:approval-requested/resolved` 原走会话主题全员广播——改为 **NotifyPort.publishToUser 定向触发者**（`publishApprovalFrame`；无触发者回退广播，兼容零差异）——审批仅发起该轮对话的人（含其多端）可见，会话其他真人不再被他人审批打扰/误批。验证——client m65-cards（点击 → store 通道断言）+ m65-studio-panel（挂载后消费 → 方案加入列表并选中）+ server m7（带触发者 → publishedToUser 含审批帧且会话广播不含；m7 全量 26 例）+ 全量门禁。
29. **M79-AE 操作权限统一治理 + 通知补偿（穷举审计）**：以「会话域全部写操作 × 权限守卫 × 通知收件范围」穷举核对——**地基确认**：`/sessions/:id*` 全局守卫（读=owner∪成员、写=owner/editor、viewer 403、/leave 例外）+ `/runs/:runId` 同款 + 裸路径（schedules `guardTask` / media `guardJob` / memories `ownedByUser`）均有归属校验（兼容模式全放行）。**收敛缺口（治理口径：仅属主）**：① PATCH /sessions/:id 的**改名 / routeMode / serial / planFirst** 由「group 仅群主、team/direct owner∪editor」统一为**全 kind owner-only**（403「仅会话属主可修改会话名称与治理设置」）；② worktree **merge / discard** 收敛为 owner（合并主仓库为高敏感操作）。**通知补偿（收件箱 system 类型）**：① 会话删除 → 共享成员收「会话已被删除」（成员列表须在 remove 级联清理前收集）；② 成员被移出 → 收「你已被移出会话」。**前端口径同步**：ChatArea 触发策略开关由 `!isViewer` 收紧为 `isOwner`（兼容模式视为 owner）；SessionList 改名（group+owner）/删除（owner）gating 既有保持。**有意保持**：内容协作写（消息/画布/附件/记忆/定时任务）= editor+；hide/leave = 本人操作（viewer 例外可退出）；审批 API = owner/editor（UI 已定向触发者，owner 作兜底）；fork = owner/editor。验证——server m79-chats（editor 改名/routeMode 403、owner 200；删除/移出通知 delivered 断言；并行群管理批的「仅群主」断言适配统一文案）+ m57-p2-shares（editor 写探针改「发消息」、viewer 403 经写闸门）+ 全量 1410 + client 1321 + E2E auth 5/5。

**门禁快照（含 M79-L 多实例收口）**：server **114 文件 / 1384 例** 全绿（+m79-multibus 5 例）；client **115 文件 / 1290 例** 全绿；`lint` **0 错误**；`npm run eval` 基线 **36/36 通过**；三端 typecheck 0 错；**E2E auth 5/5**（memory 模式零变化回归）+ **main smoke 5/5**；隔离实例 2/2；**`NOTIFY_BUS=db` 装配冒烟通过**（真实启动 + 总线启用日志 + health/stats 200）。

**镜像面**：design.md §114 · docs/api.md §24 · docs/operations.md §9 · .env.example（WS_SEND_QUEUE_MAX / WS_MAX_CONNS_PER_USER / INBOX_RETENTION_DAYS / PRESENCE_AGGREGATE_MS / FRIEND_REQUEST_DAILY_LIMIT）· ADR 0188–0196 / 0203 + docs/adr/README.md 索引。

**后续候选（未实施）**：无——收口清单已全部核销（M78 让位项之外的「多实例演进」已按 M79-L 落地，ADR 0199）。

---

## 23. 全量审计注记（2026-09-20，M79-AF 操作权限收口）

以「多用户 × 多 Agent 同会话」为口径全量审计 **同步展示 / 消息发送 / 调度 / 推送 / 操作** 五面。核心链路结论（正确性）：消息级全同步（turn-end 全分支补播 + 未读服务端权威 + 三重补偿）· 触发矩阵单点 · Run 会话级互斥与排队 · 通知总线（用户主题定向 / 背压 / 多实例）均正确闭环。发现并修复的权限缺口（ADR 0203）：

> 与注记 29（M79-AE）的关系：AE 批将「审批 API = owner/editor」列为**有意保持**（UI 已定向触发者）；本批按用户决策将**决定 / 读面 / SSE 三面**同步收窄为「本 Run 触发者 ∪ 会话属主」——AE 条目中「审批 API = owner/editor」自本批起由本注记取代。

1. **viewer 越权三处（写闸门缺失）**：浏览器 takeover / release / close / takeover token、定时任务改删触发启停、媒体任务取消重试——资源级端点绕过 `/sessions/:id` 守卫且误用读校验；media 另有 `!guardJob(req)` 恒假判定（守卫从未生效）。统一收敛为会话写校验（可读不可写 403 / 不可读 404）；
2. **审批口径四面对齐**（触发者 ∪ 属主）：WS 定向（M79-AD 已有）· SSE 广播与补发过滤（`engine.attach` 带订阅者身份）· 决定端点 403 · 读面空列表——「推送受众 = 操作受众」原则落地；
3. **交还提示定向**：`notify:awaiting-user` 按 targets ∪ 属主客户端 gating（无 targets 保持广播语义）；
4. **前端展示层 gating 双保险**：审批卡 / 指挥台 / 浏览器 / 定时 / 媒体面板按 `role === 'viewer'` 关位（服务端为准）；**消息操作菜单**对齐服务端口径——编辑=作者本人、删除=作者/属主（agent/system 不受限）、重新生成/续写/fork=非 viewer（兼容模式 role/userId 缺省 → 全放行零变化）；**M79-AH 画布只读模式**——store 闸门（mutate/applyLocal/undo/redo 拦截 + save 防御；视口浏览允许且不落盘）· ReactFlow 交互禁用（拖拽/连接/边重连/删除键/右键/双击/拖放）· 工具栏写类按钮禁用 · 只读浮条提示；**计划卡（PlanReviewCard）** 批准/驳回/保存修改禁用 + 只读提示（草稿仅本地）；
5. **平台自动召集豁免明示**：route / handoff 增援属平台调度职责（M48），不纳入编制权限校验（trace 可审计），与 ADR 0101 精神一致——文档定性，不设代码限制；
6. **扫尾补漏（穷举收口）**：对全部路由的权限调用点机械核对（canAccessSession / assert* / 守卫取反目标）后补两处——① **素材入仓（library to-canvas）**：实际为向会话工作区拷贝文件的写操作，但仅校验"可读"→ 路由层补写闸门（viewer 403 / 非成员 404）；② **反馈单条查询（GET /feedback?messageId=）**：跨用户可探测他人消息反馈状态 → 补会话归属（非成员视同未反馈 `item:null`——不泄漏存在性，客户端 `.catch` 语义零变化）。核实无缺口：finance watchlist（按 userId 归属）· memories 状态变更（ownedByUser）· context / memory 端点（/sessions/:id 前缀受守卫）· feedback 全量/导出（admin）· **settings 写（requireAdmin）· ActivityRail 导航（ADMIN_ITEMS 仅 admin + 非 admin 访问管理视图自动回退工作台）· /ws/ssh 握手（登录态 + 流 token 与用户绑定比对）**；
7. **审计连带发现与修复（M79-AG，画布并发合流）**：main E2E 长套件审计中 m31-canvas-agent「落位与写入反馈」两次全量失败、单跑必过——trace 定性为**真实缺陷**：agent 落位写入被客户端「本地优先」409 策略静默覆盖（本地脏 → 保存携带旧 doc → 409 → 原样重 PUT 覆盖服务端新写入）。修复为 409 三方合并「合流重放」（base=lastSyncedDoc；**远端新增不丢** / 本地编辑保留 / 已同步删除尊重 / 双方都改时位置尺寸取本地+其余取远端；详见 [ADR 0204](adr/0204-canvas-merge-on-conflict.md)）；`m31-canvas` 单测 +2 锁定 + E2E 修复后验证。教训固化：**乐观锁冲突在多写入者系统必须三方合并**（「本地优先 / 服务端优先」二元策略都会丢数据）；长套件"固定用例必现 + 单跑必过"先用 trace 定性再判 flaky。

验证：`m79-af-permissions`（server 7 例：三面 viewer 403/editor 放行/非成员 404 + 审批触发者∪属主放行/越权 403/读面空 + 素材入仓写闸门 + 反馈查询归属）· `m7` +1（审批 SSE 定向：实时 / attach 补发 / resolved 三阶段 × 触发者·属主·他人·兼容无身份四方）· client `m79-realtime` +1（awaiting-user gating 四态）+1（pollUrlOf 三态）+ `m9` +3（消息操作菜单写项 gating 三态）。

**门禁快照（M79-AF 收口终版，2026-09-21；含 M79-AH 画布/计划卡只读）**：server **117 文件 / 1420 例** 全绿（+`m79-af-permissions` 7 例 + 游标 2 例 + 审批 SSE 定向 1 例）；client **118 文件 / 1330 例** 全绿（+awaiting-user gating 1 例 + pollUrlOf 1 例 + 菜单 gating 3 例 + 画布 409 合流 2 例 + viewer 只读 2 例）；`lint` **0 错误**；三端 typecheck 0 错；build ✓；**E2E：auth 5/5 · approval 1/1 · main 134/134 双连全绿**（全新数据目录 `PW_DATA_DIR=e2e-gold` 首发 13.8min + 同目录复跑 13.9min，严格单实例零并发）+ M79-AH 定向冒烟 **12/12**（m24-plan ×3 + m31-canvas-agent ×3 + m31-canvas-ux ×6）。
main 长套件失败链的完整根因与修复（多轮 trace 实证）：① **spec 硬编码 `data/e2e-main` 路径**（m26/m27 回收站 / m28 mcp.json）——与轮换目录策略冲突 → 跟随 `PW_DATA_DIR`；② **收束信号被历史 DOM 秒过**（m43：`「你的回合」`旧胶囊命中 → 前一轮 submit 在途时发起下一次发送 → fill 被 `setValue('')` 清空 → 按钮永久 disabled 卡 144.8s）→ 固化 `expectRunSettled`（「停止」出现→消失双段，M79-K 先例）并替换 6 处；③ **点击稳定性饿死**（m31-canvas-ux 菜单项 not stable 卡死）→ `robustClick`（短超时 + DOM click 兜底）；④ **累积数据目录渲染压力**（e2e-main 1700+ 会话致 ux/m77 型卡顿）→ 轮换目录即解（134/134 用时 13.8min vs 累积目录 16-22min）。临时诊断 spec 已全部移除；`playwright.config.ts` 全局预算 120s（注释含先例）。

**审计确认无缺口面**：消息发送（同会话互斥无竞态）· 未读口径（自己消息不计 / 单调推进）· 订阅 ACL（用户主题仅本人、全局主题 admin、会话主题归属可见）· 待决计划/审批的 SSE 重放（attach 快照）· 会话删除 / ACL 撤销的即时退订。**降级轮询增量游标（本批已实施）**：`GET /api/notifications` 增 `cursors`（客户端 `pollUrlOf` 携带 per-session 游标只拉增量，超长 / 非法 / 缺省回退全量）——`NotifyHub.list` 过滤下界 = `cursors[sid] ?? since`。**已知边界（不在本批）**：跨实例 seq 游标不可比（REST 快照补齐，ADR 0199；**全局化方案经评估否决**——全局 id 的分配序与到达序在两实例并发时不守恒，会引入"水位去重丢实时帧"窗口，而现状"远程条目现场分配新 seq"保证实时流严格单调，收益/风险不划算）· admin 对成员私有会话无旁路（M79-G 既定语义，m79-privacy 固化）。
