# ADR 0181：多 Provider 模型服务——按模型名路由（默认 DeepSeek）

- 状态：Accepted
- 引入：多 Provider 管理（2026-09-19）
- 修订：初版以 Agent front-matter `provider` 显式绑定连接；当日二次修订为**按模型名路由**，最终定为 **`服务名/模型名` 前缀形式**（如 `deepseek/deepseek-flash`；连接名即前缀，兼裸名清单匹配兜底）
- 相关：[server/src/llm/provider-router.ts](../../server/src/llm/provider-router.ts)、[server/src/llm/probe.ts](../../server/src/llm/probe.ts)、[client/src/components/settings/ModelProvidersSection.tsx](../../client/src/components/settings/ModelProvidersSection.tsx)、[client/src/components/console/AgentEditor.tsx](../../client/src/components/console/AgentEditor.tsx)、[agents/README.md](../../agents/README.md)、[server/tests/provider-router.test.ts](../../server/tests/provider-router.test.ts)、[client/tests/llm-providers.test.tsx](../../client/tests/llm-providers.test.tsx)

## 背景

- 现状：LLM 调用走单一全局 OpenAI 兼容端点（env `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`，默认 DeepSeek）；角色 front-matter 的 `model` 只能换「模型名」，不能换接入点与凭据；BYOK（M57 P3）是**用户级**凭据覆盖，非角色级；
- 需求：多 Provider 管理（仅 openai 协议）；未配置时默认 DeepSeek；支持 Agent 选择特定的大模型；**不需要**会话级选择；
- 先例：M56 媒体生成连接（全局共享、不参与会话绑定、管理入口收于「设置」）与 embedding 连接同纪律——LLM provider 与二者同构；
- 关键简化（修订）：Agent 侧不引入新概念——**`服务名/模型名` 即引用**（连接名 = 供应商前缀，全局唯一天然消歧），兼裸模型名按清单匹配；Agent 只写 `model`。

## 决策

1. **Provider 即连接（kind=`llm`）**：复用连接中心存储 / SecretVault 加密 / 审计与 CRUD 路由；仅 admin 可创建与修改（非 admin 403）；不参与会话绑定（绑定接口 `400`，同 embedding / media）；连接中心视图不再呈现（管理入口 =「设置 → 模型与生成 → 模型服务」，对齐 M56 先例）。
2. **Agent 引用格式（front-matter `model`）**：`服务名/模型名`（如 `deepseek/deepseek-flash`，服务名 = 连接名称，全局唯一天然消歧）或清单裸名。解析顺序：① 清单精确匹配（全串；含 `/` 的模型名如 `qwen/qwen2.5` 由此直接引用；同名裸名以创建序先者为准）→ ② `服务名/模型名` 前缀解析（精确优先、大小写不敏感兜底；**命中后把模型改写为去前缀裸名再调用端点**）→ ③ 未命中 / 留空 → 系统默认（env）。连接名不得含 `/`（创建 / 更新校验）。Agent 编辑器「高级」页：model 输入带 datalist 候选（全部启用服务 × 清单模型，value = `服务名/模型名` 全名并标注来源；保留自由输入）。
3. **运行时解析链**：`LlmProviderRouter`（最外层）→ `ByokProvider` → 系统默认。请求 `model` 命中（清单或前缀）→ 以连接 baseUrl / apiKey 构建独立 provider 实例（每连接独立限流闸门与韧性层；按连接 `updatedAt` 缓存失效重建）；未命中 → 静默透传（常规路径）；`LLM_MOCK=true` 恒直通（测试确定性）。
4. **优先级**：`model` 命中模型服务（团队模型服务）> BYOK（用户凭据）> env 默认（DeepSeek）。模型服务是"团队为该模型设计的调用方式"，优先于用户级全局凭据；未命中时不消费连接。
5. **生效模型 = 请求模型（归因保留原值）**：engine 直传 `agent.model`（请求体与 usage / 成本归因同源）；前缀形态下端点收到去前缀裸名，usage 仍记录原值（`deepseek/deepseek-flash`），价格按单价表回退系统默认。
6. **连接测试**：`POST /api/connections/:id/test` 增 llm 分支——openai 协议 `GET {baseUrl}/models` 探活（15s 超时），回报模型数量与样例（`n 个模型：a、b、c 等`）；创建 / 更新时校验 `config.baseUrl` 为合法 http(s) URL（`400`）。
7. **预设与开箱**：新建表单提供预设（DeepSeek 官方 / OpenAI 官方 / 自定义）；未配置任何 llm 连接时全部角色使用系统默认（DeepSeek），**零迁移**——不配置 / 不写模型名的行为与历史完全一致。

## 理由

- **复用连接中心**：加密落库 / `secretSet` 脱敏 / 审计留痕 / ownerOrAdmin 守卫 /「保存并测试」交互全部现成，新概念与维护面最小；
- **`服务名/模型名` 前缀（核心）**：连接名全局唯一 → 显式引用零歧义、自描述（`deepseek/deepseek-flash` 一眼可见通道）、与业界惯例一致（OpenRouter / LiteLLM 风格）、零新增字段（前缀即连接名）；去前缀改写后端点收到的仍是裸模型名；
- **裸名清单匹配兜底**：不写前缀时按各服务 `models` 清单匹配（同名以创建序先者为准）；清单外模型名按既有语义走系统默认端点（不改变历史行为）；
- **解析链包在 BYOK 外层**：BYOK 每用户独立闸门的既有实现零改动；命中优先的语义清晰可解释；
- **未命中静默透传**：默认模型名不在任何清单是常态，不能告警噪声；失效面收敛为"清单不含该名 → 系统默认"；
- **每连接独立 provider 实例**：端点级限流隔离（与 BYOK「每用户独立闸门」同构），跨 provider 并发互不挤占；
- **连接只存引用面**：凭据集中加密存储，资产仓库零密钥泄漏面。

## 被否决的方案

- **Agent front-matter `provider` 显式绑定连接（初版实现，同日修订移除）**：引入两个概念（服务绑定 + 模型名）与悬空引用治理（改名 / 删除后回退与提示、UI 失效态）；用户决策「根据配置的模型名称即可」——路由键收敛为模型名，Agent 侧零配置成本；
- **独立 Provider 表 + 新管理台**：与连接中心能力高度重复（加密 / 审计 / CRUD / 测试 / 脱敏），维护面翻倍；
- **front-matter 内联 baseUrl / key**：凭据入资产仓库（git 泄漏面），与 SecretVault 加密纪律冲突；
- **会话级模型选择**：用户明确排除；选择维度（会话 × 角色 × 模型）组合爆炸，收益比低；
- **让 llm 连接参与会话绑定**：模型服务是全局资源（同 media / embedding），绑定语义会引入「未绑定即不可用」的意外故障面；
- **独立 `slug` / 前缀字段**：连接名已全局唯一且可由表单引导（简短英文），新增 slug 会引入第二套唯一性与冲突规则；名称即前缀最简；
- **同名模型用"最近更新 / 名称排序"决胜**：与前端候选去重口径难对齐；创建序先者（`created_at ASC`）稳定且前后端同源；

## 影响

- **新增**：`server/src/llm/provider-router.ts`（按模型名路由 + 归一函数）、`server/src/llm/probe.ts`（探活）、`client/src/components/settings/ModelProvidersSection.tsx`（管理区块）；
- **变更**：`ConnectionKind` 增 `llm`；engine 三处请求构造保持 `model: agent.model`（直传）；连接路由（kind 枚举 / 非 admin 守门 / 测试分支 / 绑定拒绝 / baseUrl 校验 / **名称不得含 `/`**）；Agent 编辑器 model 输入带 datalist 候选（`服务名/模型名` 全名；`console/fields.tsx` TextInput 增 `list`）；ConnectionsConsole 不再呈现 llm；
- **兼容**：默认（未配置 llm 连接、模型名未命中清单）下所有行为与历史一致；E2E / 单测（`LLM_MOCK=true`）确定性不受影响（路由层直通）。
