# ADR 0155：轮次判定与对抗参与仪式——`::: ruling` 过程件容器 · 回合轴色点 · 参与条与结论条

- 状态：Accepted
- 引入：M64 对抗博弈主面批一（2026-09-19）
- 相关：[design.md §98](../design.md)、[docs/pk-game-analysis-design.md §4](../pk-game-analysis-design.md)（A4 / A5 / A6 / U3）、ADR 0117（PK 范式）、ADR 0064 / 0118（统一回填：只写草稿不直发）、ADR 0144（单一解析实现）、[remark-ext.ts](../../client/src/components/chat/md-ext/remark-ext.ts)、[RulingCard.tsx](../../client/src/components/chat/md-ext/RulingCard.tsx)、[ArenaActions.tsx](../../client/src/components/scene/parts/ArenaActions.tsx)、[ConclusionBar.tsx](../../client/src/components/scene/parts/ConclusionBar.tsx)

## 背景

- 3 轮辩论是「回合制庭审」节奏，但轮间无判定落点：judge 只有终局 `::: verdict`；回合轴节点仅「第 N 轮」无状态；计分板无过程分；
- 用户在对决中只能发普通消息：无「加一轮 / 叫停并裁决 / 倾向表态」的一键入口（消息流对决组有 `verdictTemplates` 四键先例，arena 未接）；
- 终局结论信息只在裁决 chip / 裁决卡里，无 L1 结论横条（§7.4 分层阅读的 L1 层缺位）。

## 决策

1. **新容器 `::: ruling <正方|反方|多方|空方|僵持> [第 N 轮小结]`**（过程件）：条目 `- 项名 | 内容`（pan 口径）；状态词口径复用 `parseVerdictArg`（lib/verdict 单一实现），`data-head` 保留原始胜方词（正方 / 多方原文展示）；**渲染与终局裁决分离**——RulingCard 轻卡（单行徽标 + 标题 + 条目 chips），裁决流（`scene-verdict-chip`）不含 ruling；
2. **回合轴与轮次分**：`derive.rulingsOf` 派生 → RoundTrack 节点色点（`scene-rt-mark`：long 红 / short 蓝 / draw 灰）+ tooltip「第 N 轮 · 判定：{席名} 胜」；节点点击 → 有 ruling 定位判定消息、否则原波次定位；计分板轮次读数：有 ruling「第 N 轮（进行中）/ 共 N 轮」，无 ruling 回落「第 N 轮」波次口径（E2E `/第 \d+ 轮/` 零变化）；判定的「未决点」条目为「加一轮」模板引用源；
3. **对抗参与条**（`parts/ArenaActions`，裁决流之下，左右席均非空且已开赛时渲染）：五枚药丸按钮 = 加一轮 / 叫停并裁决 / 倾向·左 / 倾向·右 / 倾向·僵持——文案全部出自 `lib/pk.TEMPLATES` 集中注册表（中轴席名注入、未决点引用）；**一切点击只回填 Composer 草稿**（ADR 0064 / 0118），按钮短暂显示「已填入草稿」；
4. **终局结论条**（`parts/ConclusionBar`，计分板下 / 回合轴上）：最新非 none 裁决 → 单行 L1（`结论 · {胜负} · 置信度 {label} · 翻盘条件 {值}`）+「看裁决」+ 关闭；关闭记忆 `ma:sc:concl:<sessionId>`（sessionStorage，本会话已读语义，不落库）；新裁决出现时淡入（quiet / reduced-motion 静态）；
5. **协议与资产**：debate 协议条目 14（渲染容器约定：证据等级词 + ruling 输出时机与条目结构）、judge 人设「工作方式」2 加输出约定；invest 协议条目 16 附「逐轮记录局势可用 ruling（可选）」。

## 理由

- **过程件 ≠ 终局件**：复用 `::: verdict` 出逐轮小结会污染裁决流 chips 与「最新裁决」语义（M52-E 局面头 / 结论条均取最后一条 verdict）；ruling 独立类族是唯一不产生歧义的方案；
- **词表复用而非新造**：状态词解析走 `parseVerdictArg`（单一实现），新增零解析逻辑；
- **模板集中**：A5 五键 / A3 补齐证据 / 让步说明等全部集中于 `TEMPLATES` 常量——组件只引用，单测直测文本，杜绝散落文案漂移；
- **会话级已读**：结论条关闭走 sessionStorage（与 `ma:sc:*` 交互态同口径），不引入任何服务端状态。

## 被否决的方案

- **judge 逐轮小结用普通文本**：无结构化落点，回合轴 / 计分板无法派生（本 ADR 的核心缺口）；
- **ruling 复用 `::: verdict` 容器**：裁决流 chips / 局面头 / 结论条全部失真（见上）；
- **参与条按钮直接发送消息**：违反统一回填语义（用户必须保留编辑权）；
- **结论条常驻不可关闭**：长会话遮挡中轴；已读语义会话级足够。

## 边界与失效条件

- 无 ruling 时不出现任何新 UI（色点 / 轮次分 / 未决点引用均缺省）——全链现行行为零影响；
- 加一轮 / 倾向模板中的 `@中轴席` 为显式提及（mock / 真模型均按正常路由分发）；未决点仅在 ruling 存在时引用；
- 若未来裁决流需要展示过程判定（如逐轮 chip 流），RulingCard 类族可直接扩展，不与 verdict 混用。
