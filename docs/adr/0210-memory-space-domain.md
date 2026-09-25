# ADR 0210：记忆空间域隔离——单一谓词 · 跨域共享 NULL · 唯一索引并入空间域

- 状态：Accepted
- 引入：工作生活一体 P2（2026-09-23）
- 相关：[server/src/store/memory.ts](../../server/src/store/memory.ts)、[server/src/memory/recall.ts](../../server/src/memory/recall.ts)、[server/src/context/service.ts](../../server/src/context/service.ts)、[client/src/components/team/MemoryPanel.tsx](../../client/src/components/team/MemoryPanel.tsx)、[server/tests/memory-space.test.ts](../../server/tests/memory-space.test.ts)

## 背景

四层向量记忆（会话 / 角色 / 项目 / 全局）没有「域」维度——工作内容可能被生活角色召回，用户无法验证「不互通」，信任受损（work-life-fusion §1.3 缺口 2）。缺的不是新系统，而是召回层的一个谓词 + 可见化。

## 决策

1. **存储**（迁移 v29）：`memory.space_id`（NULL = 跨域共享）；写入按**来源会话推导**（有归属会话 → 落域；无来源会话 / 解析失败 → NULL 跨域共享，如「我叫 X」类全局事实）。
2. **隔离谓词单一实现于召回层**：`space_id = :current OR space_id IS NULL`（当前空间 + 跨域共享）；**缺省（未传 spaceId）不过滤**——兼容语义，行为与存量一致；L1.5 注入（`context/service` 以 `session.spaceId ?? 'default'` 入参）与记忆面板 query 同口径，杜绝前后端双判。
3. **唯一索引升级**：`idx_memory_unique_scoped_v2`（`COALESCE(space_id,'')` 表达式索引）取代 `idx_memory_unique_scoped`——唯一性维度并入空间域：同内容在不同空间各自成条（同空间内仍唯一）。
4. **可见化（信任的关键）**：记忆面板（MemoryPanel）随左栏空间切换过滤（`GET /api/memories?spaceId=<id>`；`spaceId=shared` = 仅跨域共享），加「按空间隔离：此处仅显示当前空间与跨域共享的记忆」明示文案。

## 被否决的方案

- **硬隔离（NULL 视为专属当前空间）**：用户显式标记的全局记忆（身份 / 偏好）无处安放，且历史 NULL 行语义突变。
- **跨空间全通 + 手动标记隔离**：默认不隔离 = 信任前提不成立（「工作内容不泄露到娱乐会话」是专项第一优先级风险）。
- **独立记忆表 / 独立库**：召回与面板已是单一数据源 + 谓词即可表达，物理拆分只有维护成本。

## 边界与后续

- 审计页（列出全部全局记忆）与「全局提升审批流」属 P5 后续批次；本批只落谓词 + 面板可见化；
- 兼容模式 / 未装配空间时：`spaceId` 缺省不过滤，测试与既有行为零差异；
- 测试：`server/tests/memory-space.test.ts` 4 例（写入按来源会话分域、同内容跨空间各自成条 / 无来源跨域共享 / query 过滤（具体空间 = 同空间 + 跨域；shared = 仅跨域）/ 召回层过滤）＋ `m25-store` 索引断言对齐 v2；
- 镜像面：ADR 0209 / 0211（同批）、`docs/api.md` §5/§25、design.md §117、`docs/work-life-fusion-design.md`（头部落位注记）。
