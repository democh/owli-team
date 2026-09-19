# ADR 0153：模型直连（BYOK）——用户自带 LLM 凭据 · 按会话属主解析 · 成本归因（M57 P3-3）

- 状态：Accepted
- 引入：M57 P3-3（2026-09-19）
- 相关：ADR 0134（usage.user_id 归因）、ADR 0147（P3-1 配额：成本上限依赖正确模型归因）、[design.md §96](../design.md)、[server/src/llm/byok.ts](../../server/src/llm/byok.ts)、[server/src/store/llm-credentials.ts](../../server/src/store/llm-credentials.ts)

## 背景

P1–P3 让团队可以「共用」系统模型：所有人消耗同一份 API Key 与成本池。两类诉求浮现：① 成员希望用自己的模型额度 / 私有网关（合规与配额都指向 BYOK）；② 成本的按人归因在「同一模型」下才准确，用户自定义模型需要实际模型名入账（否则单价错）。plan P3 收官刀 = BYOK。

## 决策

1. **数据模型（迁移 v18）**：`user_llm_credentials(user_id PK REFERENCES users(id) ON DELETE CASCADE, base_url?, model?, secret_enc NOT NULL, updated_at)`；apiKey 经 SecretVault 加密（与连接 / MCP 凭据同源密钥）；`status()` 投影绝不含密钥；解密失败（密钥更换）归一为「未配置」防误认生效。
2. **解析位置 = Provider 包装**：`ByokProvider` 包在系统 provider 外层，按 `ChatRequest.sessionId` → 会话属主 → 用户凭据 → **每用户 provider 实例**（独立限流闸门 + 韧性层），缓存复用、凭据变更 `invalidate` 重建；无凭据 / 无会话上下文 → 直通系统默认。
3. **全覆盖模型调用点**：四个调用点统一携带 `sessionId`——引擎回合、压缩摘要、记忆沉淀、脑图生成（「你发起的会话全走你的 Key」语义完整）。`LLM_MOCK=true` 恒直通（E2E / 测试确定性优先）。
4. **成本归因**：`ByokProvider.modelFor(sessionId)` 注入引擎 `billingModelFor` 与压缩器——usage 记**实际生效模型**（BYOK 模型按 `LLM_PRICING_JSON` 各单价计）；无凭据 = undefined 回退系统模型（零变化）。
5. **自助接口 + UI**：`GET/PUT/DELETE /api/auth/llm-credentials`（PUT：apiKey ≥8 必填、baseUrl http(s)、model 可选；审计 set/clear）；个人设置「模型直连（BYOK）」卡（状态徽章 / 地址·模型回显 / 更新 / 恢复系统默认）；兼容模式 PUT 400 + 卡片不渲染。
6. **凭据语义**：每用户至多一份（覆盖式 upsert）；`baseUrl` / `model` 留空 = 分别跟随系统默认；清除 = 删除行回退系统（非留空值）。

## 理由

- **Provider 包装而非逐调用点传参**：调用点只需带 sessionId（语义本就应有）；覆盖新增调用点零成本；包装层集中处理缓存 / Mock 守卫 / 降级；
- **每用户独立实例**：BYOK 用户不挤占系统并发池，限流与重试语义互不干扰；代价是每用户一份连接池（团队规模下可忽略）；
- **sessionId 而非 userId**：请求构造处天然有会话上下文（引擎 / 压缩器 / 沉淀 / 脑图），无需调用方查属主；共享会话语义 = 「会话属主的 Key」（与成本归属 / 配额口径一致）；
- **Mock 恒直通**：E2E 与单测的剧本输出必须确定性；BYOK 只在真实模型路径消费（与 `LLM_MOCK` 的既有定位一致）；
- **status 归一未配置**：密钥更换后密文不可解，若报「已配置」会让用户误以为生效、排障成本高；归一后前端提示重新保存即可。

## 被否决的方案

- **逐调用点传 apiKey**：四处调用点扩参 + 未来调用点容易漏传；且凭据解析散落各层；
- **BYOK 用户携带自己的 model 名但不改 usage**：单价错（成本看板失真，且配额月上限校验用错值）；
- **全局单例「最近一次凭据」**：并发多用户互相污染（A 的请求用 B 的 Key）；
- **Mock 模式也走 BYOK**：E2E 剧本输出不确定（真实网络依赖），违背 LLM_MOCK 定位；
- **兼容模式允许 BYOK**：单用户部署本就使用系统 Key（无账号主体），允许反而引入「匿名凭据」歧义；统一 400 指引。

## 影响

- 迁移 v18；`shared` 类型新增 `LlmCredentialStatus`；`ChatRequest` 增 `sessionId?`；新文件 `llm/byok.ts`、`store/llm-credentials.ts`、`routes/llm-credentials.ts`；引擎 / 压缩器新增可选 `billingModelFor`（缺省零变化）；审计 `auth.llm-credential-set|clear`；
- 兼容零变化：无凭据 / 无会话 / Mock / 兼容模式 → 全部直通系统 provider（既有测试零回归）；
- 测试：server `m57-p3-byok.test.ts` 5 例（90 文件 1174 例全绿）；client `m57-p3-byok.test.tsx` 3 例；设计见 design.md §96；
- 与配额联动：BYOK 生效模型入账后，§93 的月成本上限对「自定义模型」同样准确；BYOK 用户的成本仍记在其名下（团队可据此结算）。
