# ADR 0209：空间一级信息架构——内置三空间 · 会话归属零迁移 · 视图层实体

- 状态：Accepted
- 引入：工作生活一体 P1（2026-09-23）
- 相关：[docs/work-life-fusion-design.md](../work-life-fusion-design.md)、[server/src/store/spaces.ts](../../server/src/store/spaces.ts)、[server/src/routes/spaces.ts](../../server/src/routes/spaces.ts)、[client/src/stores/space-store.ts](../../client/src/stores/space-store.ts)、[server/tests/spaces.test.ts](../../server/tests/spaces.test.ts)

## 背景

会话列表是单一平铺流——40+ 场景入口无分组，工作 / 生活混杂，首屏噪音大（work-life-fusion §1.3 缺口 1）。需要一层「空间」把场景与会话组织成「上班 / 下班」两个心境入口，但不在本批引入多租户 / 权限域的复杂度。

## 决策

1. **数据模型**（迁移 v27）：新表 `spaces`（`id / name / kind(work|life|personal|custom) / icon / builtin / sort / created_at / updated_at`）+ `sessions.space_id`（FK → `spaces(id)`，`ON DELETE SET NULL`）。内置三空间：`default`（我的，kind=personal，sort 0，存量会话归属）/ `work`（工作）/ `life`（生活）；`ensureBuiltins` 启动时幂等校正名称 / 图标 / 排序（对外常量 `DEFAULT_SPACE_ID`）。
2. **零迁移语义**：`space_id` 为 NULL / `'default'` 一律视为「我的」——投影层不落字段（`rowToSession` 仅非 default 时携带 `spaceId`）；存量会话行为逐字节零差异。
3. **权限与治理口径**：空间归属是治理字段——`PATCH /api/sessions/:id { spaceId }` 与改名同口径（多用户模式仅属主；存在性校验），变更广播 `notify:session-meta`（多端同步）；fork 继承源会话空间。
4. **CRUD（`/api/spaces`）**：列表 / 创建（kind 缺省 custom、sort 递增、名称 ≤40）/ 更新（名称 / 图标 / 排序 / `soulOverrides`；内置空间可改展示元数据、不可改 kind）/ 删除（**内置拒绝**；关联会话经 FK 置空回「我的」，响应附 `sessionsDetached` 供前端提示）。
5. **前端 IA**：左栏会话列表顶部空间切换器（图标 + 名称，仅装配了空间能力时渲染）；会话列表过滤 / `Alt+1..9` 切换 / 启动自动选中均以当前空间为口径；`space-store` 用 localStorage（`owli.currentSpace`）持久所选空间（服务端空间被删 → 回退 default）；新建会话经 CreateSessionDialog 随行提交 `spaceId`（default 不随行——与「缺省不落字段」同口径）。
6. **本批边界**：空间为**个人级视图层实体**——多用户模式暂全实例共享（用户级隔离留待后续批次）；按空间的通知策略 / 时间线首页属 P4 后续批次。

## 被否决的方案

- **工作 / 生活做成两套独立产品形态（独立前端或独立入口）**：违反「同一团队跨心境连续陪伴」产品主张（work-life-fusion §2.1），一体化价值消失。
- **会话按空间物理分库 / 分目录**：迁移与工具沙箱语义大动；空间只是组织维度，收益不成比例。
- **空间即权限域（ACL 级隔离）**：本批消费者是本地单用户语境；先以视图层落地，权限域留待多用户深化批次。
- **「场景平铺 + 标签」替代空间**：首屏入口仍冗余，满足不了「按心境一键切换」。

## 边界与后续

- 测试：`server/tests/spaces.test.ts` 5 例（内置三空间落种幂等 / 自建 CRUD 与排序 / 内置不可删 / 会话归属缺省不落字段与 `setSpace` 往返 / `soulOverrides` 读写）；前端过滤为 store 纯派生（`spaceIdOf`），随既有 client 套件与 M79 社交 E2E 回归覆盖；
- 镜像面：ADR 0210 / 0211（同批）、`docs/api.md` §3/§25、design.md §117、`docs/work-life-fusion-design.md`（头部落位注记）。
