# ADR 0191：用户画像 v1——色块 / emoji 与投影面（M79-B）

- 状态：Accepted
- 引入：M79-B（2026-09-20）
- 相关：[docs/social-collab-design.md §10](../social-collab-design.md)、[server/src/store/users.ts](../../server/src/store/users.ts)、[server/src/routes/auth.ts](../../server/src/routes/auth.ts)、[client/src/components/settings/MyProfileCard.tsx](../../client/src/components/settings/MyProfileCard.tsx)、[client/src/components/chat/HumanAvatar.tsx](../../client/src/components/chat/HumanAvatar.tsx)

## 背景

- users 表仅 username / display_name：真人成员呈现贫瘠（纯文本名 + 首字母头像）；多用户协作需要可辨识的个人形象。

## 决策

1. **字段**（迁移 v22）：`headline`（≤30）/ `bio`（≤120）/ `avatar`（JSON：`{"kind":"color","value":"#rrggbb"}` | `{"kind":"emoji","value":"🐼"}`；**`kind:'image'` 预留**）；
2. **维护端点**：`PATCH /api/auth/profile`（本人；null = 清除该字段；色值 `#rrggbb` 校验、emoji 单字符校验、坏 JSON 读取降级）；
3. **投影面**：`/auth/me`（登录态随行）· `/users`（admin 列表）· `ShareDialog`（成员行含头衔）· 会话详情 `humanProfiles`（**humanNames 保留不删**——兼容既有消费链与测试锚点）· @ 候选（M79-E）；
4. **渲染组件** `HumanAvatar`：色块（白字首字）/ emoji（中性底）/ 缺省（主色浅底 + 首字），与 AgentAvatar 同尺寸纪律；
5. **他人人类消息升维**：左对齐 + 头像 + 头衔；**自己的消息维持现状**（右对齐、无头像——「用户不设头像」既有决策在单用户语义下保持）。

## 被否决的方案

- **图片头像上传（v1）**：上传 / 裁剪 / 存储 / 配额一整条管道；色块 + emoji 已满足辨识与个性化；
- **用户（本人）头像回归渲染**：与既有「界面不渲染用户形象」决策冲突（他人消息作者形象例外成立）。
