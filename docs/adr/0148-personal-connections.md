# ADR 0148：个人资源——personal 连接与成员可用开关（M57 P3-2）

- 状态：Accepted
- 引入：M57 P3-2（2026-09-19）
- 相关：ADR 0134（多用户基座：scope/owner_id 预留）、[ADR 0147](0147-user-quota-and-usage.md)（P3-1 配额）、[design.md §95](../design.md)、[server/src/store/connections.ts](../../server/src/store/connections.ts)、[server/src/connections/access.ts](../../server/src/connections/access.ts)

## 背景

P1 起连接中心为「管理员统一配置、成员按 member_use 使用」的模型；但两件事一直缺失：① 成员无法使用自己的数据库 / SSH（哪怕只是看自己的测试库）；② system 连接的 `member_use` 开关只有列没有入口（实际恒为开放）。plan P3 第二刀 = 个人资源（v14 已预留 `scope/owner_id`，本批零迁移启用）。

## 决策

1. **personal 连接语义**：`scope='personal' + owner_id` —— 仅属主可见 / 可编辑 / 可绑定 / 可执行；他人（含 admin）在成员视角不可见（admin 在管理台可全量查看，排障需要）；创建者服务端判定（成员创建一律落 personal，不信请求体；admin 仍建 system）。
2. **member_use 开关启用**：`ConnectionDefinition` 暴露 `memberUse`；管理台编辑器提供「允许成员使用」开关；关闭后成员列表即刻隐藏、绑定 403、执行侧拦截（三层一致）。
3. **四层授权一致**：列表（成员 = 可用 system 脱敏 ∪ 本人 personal 完整）、资源级 `ownerOrAdmin`（详情/编辑/删除/测试/终端签发/工作台）、执行侧守卫（`createConnectionUseGuard` 放行 member_use=1 system ∪ 本人 personal）、浏览器 runtime 同口径（`connections.ownerOf` 比对会话属主）。
4. **媒体 / 嵌入连接保持全局单例**：成员创建 403 + 指引（这两类不参与会话绑定，personal 化无意义）。
5. **删除级联**：`connections.owner_id` 无 users 外键 → 账号删除时显式 `removePersonalOf`（会话绑定行随 connection 外键自动清理）。
6. **客户端**：成员在个人设置「我的连接」卡自建自管（紧凑表单：sqlite / pg / mysql / ssh；凭据加密、留空不改）；admin 编辑器增开关；兼容模式不渲染（单用户零变化）。

## 理由

- **服务端定 scope 而非请求体**：成员若可自选 scope=system 等于绕过管理面（越权面）；owner 亦服务端取（身份来源唯一）；
- **成员视角 system 一律 404**：与跨用户 404 口径一致（不泄漏存在性）；成员对自己 personal 的 404 与 200 边界即授权边界；
- **admin 可看 personal（管理台）**：排障与治理需要（与用户管理台可见全部同类）；成员侧仍严格隔离；
- **member_use 三层同源（list / bind / guard）**：与 P2 连接执行复核同一模式（单一 store 判定），避免入口与执行分歧；
- **复用 v14 列零迁移**：scope/owner_id/member_use 及唯一索引 `(scope, owner, name)` 均已就位——P1 预留的「P3 开放个人资源」按计划兑现。

## 被否决的方案

- **成员连接也进 system（人人可见）**：私有凭据泄漏面，且与管理面治理矛盾；
- **admin 建 personal 代管**：属主语义混乱（创建者≠使用者）；如需要走「共享连接」未来迭代；
- **personal 参与 member_use 判定**：personal 无「成员」概念（只读属主），字段语义错位；
- **media/embedding personal 化**：二者是设置页全局单例（不参与绑定），personal 化无消费方；
- **另建 personal 连接表**：双表双守卫维护成本高，v14 单表 + 复合索引已覆盖。

## 影响

- `shared`：ConnectionDefinition 增 `scope/ownerId/memberUse`；ConnectionInput 增 `memberUse`；
- Store：`listForUser / ownsPersonal / ownerOf / removePersonalOf` + create/update 落 scope/ownerId/member_use；路由：`ownerOrAdmin` 替换单资源 adminOnly、创建放行成员（personal 化）、绑定与 `createConnectionUseGuard`、浏览器 runtime 放宽个人属主；users 删除级联清理；
- 兼容零变化：旧库 NULL → system / memberUse=true；成员既有能力（member_use=1 system）不变；新增能力仅为 personal；
- 测试：server `m57-p3-personal.test.ts` 5 例（89 文件 1169 例全绿）；client `m57-p3-personal.test.tsx` 4 例；设计见 design.md §95；
- 后续（P3 剩余）：MCP personal（同表结构已预留，可复用本批四层模式）与 LLM BYOK；「连接共享给指定成员」为更远期议题。
