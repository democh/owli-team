# ADR 0211：空间默认灵魂——入编默认值语义 · 显式优先 · 分身跳过

- 状态：Accepted
- 引入：工作生活一体 P3（2026-09-23）
- 相关：[server/src/store/spaces.ts](../../server/src/store/spaces.ts)、[server/src/routes/sessions.ts](../../server/src/routes/sessions.ts)、[server/tests/spaces.test.ts](../../server/tests/spaces.test.ts)

## 背景

灵魂变体（M15–M18）需手动选择与切换，「同一角色上班 / 下班不同人格」的一体化卖点无法自动呈现（work-life-fusion §1.3 缺口 3）。需要把「空间 → 角色 → 默认灵魂」的绑定落成机制，且不改运行期语义。

## 决策

1. **存储**（迁移 v30）：`spaces.soul_overrides`（JSON：`agentId → soulId`；`PATCH /api/spaces/:id { soulOverrides }`，`null` 清除全部绑定；非法条目静默剔除）。
2. **解析语义 = 入编默认值**：`applySpaceSoulDefaults` 在**会话创建**与**成员入编**两处合并（`souls` 入参 → 空间默认）：
   - 仅作用于**经典成员键**（`agentId`）；分身键（`agentId~soulId`）灵魂内嵌，跳过；
   - **显式选择永远优先**（`souls[key]` 已给 → 不覆盖）；
   - 无绑定 / 合并后为空 → 返回入参（`undefined` 语义零差异）。
3. **运行期零变化**：换装、分身同台、删除重入编等既有能力不变；协议优先级永远高于灵魂（M15 不变量）。

## 被否决的方案

- **按空间强制换装（运行中检测空间变化自动切魂）**：运行中行为突变、协议 / 队列状态需重建，风险不成比例；绑定只做「入编默认值」。
- **绑定写进 AGENT 资产（角色声明空间默认魂）**：资产与空间耦合（同一角色在不同部署 / 用户的空间偏好不同），且违反「资产是数据、用户偏好是设置」分层；绑定落在用户侧 `spaces` 行。
- **按 kind 全局映射（work → 某魂）**：粒度不足——默认魂是「角色 × 空间」二维偏好，只能逐空间逐角色声明。

## 边界与后续

- 双灵魂资产补齐（跨域角色工作 / 生活双魂包）与角色档案卡展示属性后续批次；本批只落机制；
- 测试：`server/tests/spaces.test.ts` 中 2 例（`soulOverrides` 读写与清除、非法条目剔除；`applySpaceSoulDefaults` 填充缺省 / 显式优先 / 分身键跳过 / 无绑定零差异）；
- 镜像面：ADR 0209 / 0210（同批）、`docs/api.md` §25、design.md §117、`docs/work-life-fusion-design.md`（头部落位注记）。
