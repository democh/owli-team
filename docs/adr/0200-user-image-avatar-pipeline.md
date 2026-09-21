# ADR 0200：真人图片头像——上传管线、安全校验与清理（M79-Q）

- 状态：Accepted
- 引入：M79-Q（2026-09-20）
- 相关：[server/src/auth/avatar.ts](../../server/src/auth/avatar.ts)、[server/src/routes/auth.ts](../../server/src/routes/auth.ts)、[server/src/store/users.ts](../../server/src/store/users.ts)、[server/src/auth/service.ts](../../server/src/auth/service.ts)、[server/tests/m79-avatar.test.ts](../../server/tests/m79-avatar.test.ts)、[client/src/lib/avatar.ts](../../client/src/lib/avatar.ts)、[client/src/components/chat/HumanAvatar.tsx](../../client/src/components/chat/HumanAvatar.tsx)、[client/src/components/settings/MyProfileCard.tsx](../../client/src/components/settings/MyProfileCard.tsx)

## 背景

- M79-B 落地了画像 v1（色块 / emoji），`UserAvatar.kind:'image'` 为预留值；真人无法使用真实照片头像，与「消息气泡 / 联系人 / 成员弹窗处处一致的头像体系」目标存在缺口；
- 图片上传引入新的攻击面（伪造 MIME、SVG 脚本、路径穿越、体积滥用），需要一次性设计定型。

## 决策

1. **客户端先行裁剪**（`cropSquareImage`）：读文件 → 居中正方形裁剪 → 256×256 → WebP(q=0.9)（不支持则回退 PNG，服务端按魔数识别）——体积与形状在源头收敛；
2. **上传通道**：`POST /api/auth/avatar`（raw binary；`express.raw ≤4mb`，业务上限 `AVATAR_MAX_BYTES=2MB`）；**服务端魔数重算格式**（仅 PNG / JPEG / WebP，**拒绝 SVG**——可执行内容 XSS 面），不信 `content-type`；
3. **存储与投影分离**：DB `users.avatar` 存 `{ kind:'image', value:<文件名> }`（文件名一律服务端生成 `<userId>-<ts>.<ext>`，userId 仅作 sanitize 前缀）；**唯一投影点** `toUserInfo` 把文件名映射为公开 URL `/api/avatars/<file>`（含 ts 天然版本化）——/auth/me、users 列表、shares、humanProfiles 全域自动生效；
4. **读取**：`GET /api/avatars/:file` 位于鉴权域内（多用户须登录；兼容模式放行），文件名白名单正则防穿越，`Cache-Control: private, max-age=1y, immutable`（换头像换名 → 天然击穿）；文件缺失 → 404，客户端 `HumanAvatar` `onError` 回退首字；
5. **写入语义**：上传即生效（独立于「保存资料」——`PATCH /auth/profile` 的 avatar schema 保持 color/emoji/null，图片模式保存时不携带 avatar 字段，避免误清除）；任何「显式设置非图片头像」或「删号」都会清理旧图片文件；
6. **兼容模式**：上传端点明确 400（无账号体系）；资料卡本身不渲染（既有 multiUser gate）。首登强制改密闸门期间同样不可上传（M57 白名单语义，不特殊放行）。

## 被否决的方案

- **接受 SVG**：可内嵌脚本（`<script>` / onload），同源 `<img>` 场景仍有历史浏览器差异风险——直接拒绝，收益（矢量头像）不值；
- **信任客户端 content-type**：任意伪装即可绕过格式白名单（存储型 XSS 面）；
- **存原始大图（服务端裁剪）**：上传带宽与磁盘占用成倍；客户端 canvas 裁剪零成本且现代浏览器全覆盖（createImageBitmap）；
- **把图片并入 PATCH /auth/profile**：JSON 传二进制需 base64 膨胀（+33%）且混入资料校验面；独立 raw 通道与 library/attachments 既有模式一致；
- **DB 存 URL / 存 base64**：URL 无法版本化且换图需原地覆盖（缓存不可控）；base64 撑爆 users 行并污染备份。
