# ADR 0030：会话动态成员——members API 与 system 消息

- 状态：Accepted
- 引入：M16
- 相关：[design.md §27](../design.md)、ADR 18、ADR 20

## 背景

v1 的会话成员在创建时固定：运行中无法加人 / 移人，「一边干活一边拉人」是协作的常态需求。难点在于：成员变更必须对引擎实时生效（roster / 队列），且变更事实要对用户可见（谁加入了、谁换了风格），还不能污染 LLM 上下文窗口。

## 决策

**成员运行时可变，变更落 `role:'system'` 事件消息**：

- **API**：`POST /api/sessions/:id/members`（加人，去重 + 校验角色存在与 soul 归属，**运行中允许**）；`DELETE /api/sessions/:id/members/:agentId`（移人）；`PATCH /api/sessions/:id/members/:agentId`（换灵魂，ADR 29）；全部返回 `{ session, message }`；
- **运行中语义**：加人后下一回合 roster 即时生效（assembler / scheduler / toolRuntime 实时读 participantIds）；**移人运行中拒绝（400）**——串行时为当前发言人、并行波次下为波内任一进行中成员；若被移者仅在队列中则移出并广播 `queue:updated`；会话至少保留 1 名成员；
- **事件消息**：变更持久化一条 `role:'system'` 消息（`agentId` = 涉事成员，`mentions: []`、`turnIndex: -1`、`status: 'complete'`），如「费利 邀请了 卢娜 加入协作」「诺娃 换上了『亲和』灵魂」；
- **不进 LLM 窗口**：`buildWindow` 过滤 system——变更事实对模型只通过 roster / 装配隐式生效，不占 token、不干扰对话；
- **通道**：WS `notify:members-changed`（payload：session + message）→ 当前会话 `upsertMessage` + 更新 participantIds；其他会话未读角标。

## 理由

- 「变更可见」与「不进窗口」正交：system 消息给用户审计轨迹与回放能力，过滤规则保证模型侧语义干净；
- 实时读 participantIds 让「加人即刻可用」零额外同步逻辑；移人拒绝而非中断当前回合，避免半成品输出；
- 复用既有消息管线（持久化 / 广播 / seq / 导出 / fork）而非旁路事件表，一致性成本最低；
- TS 穷举（`role` 联合收窄）让所有渲染分支由 typecheck 强制补齐，不依赖人工巡检。

## 被否决的方案

- **只在内存中改成员、不落库**：刷新后成员回退、审计缺失、跨端不一致；
- **成员变更写普通 agent 消息**：会进 LLM 窗口污染上下文，且语义错误（不是发言）；
- **运行中允许移人（含当前发言人）**：中断语义复杂（半输出 / 工具副作用），收益低于成本；
- **独立 members_events 表**：与消息流割裂，前端要维护第二条时间线。

## 影响

- `ChatMessage.role` 扩展 `'system'`；MessageItem / MessageActions / 导出 / fork 分支补齐（typecheck 驱动）；
- `NotifyType` 增 `'notify:members-changed'`；`session-store` 增 `addMembers / removeMember / setMemberSoul`；
- 引擎增 `removeFromQueue(runId, agentId)`；运行中加人补测试断言（下一回合 roster 即时生效）。
