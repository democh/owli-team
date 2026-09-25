# Agent / Skill 创建工作室（Agent Studio）设计

> **文档定位**：设计方案 + 实施记录。**状态：v1 设计定稿并实施（2026-09-23）。**
> 范围：`新建 Agent` 全链路补全——AI 按描述生成 Agent / Skill 草稿 → 结构校验与自动重试 → 预填编辑器 → 既有创建链路落盘 → 热生效。
> 关联：M26 资产控制台（`server/src/assets/manager.ts` / `client/src/components/console/*`）· 资产质量门禁 `check:agents`（六段骨架）与 `check:skills` · `notify:assets-changed` 热生效链路 · PromptLibrary mtime 热重载 · 摘要压缩（`context/compressor.ts`）的服务端一次性 LLM 调用范式。
> 现状基线：161 角色 / 40 场景 / 70 技能；控制台已具备手填式创建 / 编辑 / 校验能力，本次补全「AI 生成」并优化创建体验。

## 1. 现状盘点与缺口

**已有（M26，本次复用不重建）**：
- Agent：新建向导（选场景 / 内联新建场景 → 基本信息 id / name / role / 头像回退 / 正文模板）、编辑（front-matter 全字段 + 正文）、复制、软删除（有引用 409 + force）、头像上传、灵魂 CRUD；
- Skill：新建（name + description → 进编辑器）、编辑、复制、软删除；
- 质量：`POST /api/console/validate` 聚合校验 + `ValidateBanner` 页头徽章；
- 生效：写盘成功 → `notify:assets-changed` 广播 → `agent-store.reload()` / PromptLibrary mtime 热重载（**改完即生效、无需重启**）。

**缺口（本设计补全）**：
1. **AI 生成 Agent**：仅能"手填空骨架"——缺「一句话描述 → 完整草稿」能力；
2. **AI 生成 Skill**：缺「诉求 → SKILL.md 草稿」能力；
3. **生成质量闭环**：缺结构校验回环（六段齐备 / 长度 / id 冲突）与失败自动重试；
4. **创建体验**：手填正文模板过于简陋（用户不知道六段骨架怎么写）；
5. **上下文感知**：新建角色不知道现有场景 / 技能 / 同场景成员，容易重复造轮子。

## 2. 目标与非目标

**目标**：用户输入一句话（如「我要一个专门做小红书种草的运营」「帮我做一个竞品拆解技能」），
**30 秒内得到结构合规、人设专业、可直接落盘**的 Agent / Skill 草稿，且结果可在既有编辑器中继续打磨。

**非目标（v1 边界）**：
- AI 生图头像（v1 用 icon + 渐变建议；生图后续接媒体通道）；
- 多角色批量生成 / 角色市场 / 分享分发；
- 生成结果自动跑 eval 评分（后续批次：生成角色跑一个 golden 任务自评）；
- 生成历史 / 收藏 / 版本管理。

## 3. 架构

```
客户端（控制台）
  AgentConsole「AI 生成」／SkillConsole「AI 生成」
    └─ 描述输入 Dialog ──POST /api/console/generate/agent|skill──┐
                                                                ▼
服务端                                                   Memory only（不落盘）
  routes/console.ts（2 端点，未装配 503）
    └─ AssetGenerator（server/src/assets/generator.ts，新增）
         ├─ 上下文注入：场景清单 / 技能名单 / 同场景成员（PromptLibrary + SkillLibrary）
         ├─ 提示词：六段骨架 + 严格 JSON 输出契约（json_schema）
         ├─ 调用：resilientStream(provider.chatStream)（与摘要压缩同范式）
         ├─ 解析：extractJson（复用 compressor 导出）
         ├─ 后校验：schema / 六段 / 长度 / id 规则 / id·name 冲突
         └─ 重试：≤2 次，把 issues 回注提示词再生成
                                                                │
  生成结果（draft + issues + attempts）◄────────────────────────┘
    └─ 前端预填「新建向导 step2」/「Skill 编辑器」
         └─ 用户可改 → 提交 → 既有 createAgent / createSkill（落盘 + 校验 + 409）
              └─ notify:assets-changed → 全端热生效
```

**分层原则**：
- 生成**只产草稿**（内存），**落盘一律走既有创建链路**（复用校验 / 冲突处理 / 播报，不新增写盘路径）；
- 生成器无状态（每次调用现算上下文），可单测（假 provider）；
- API 未装配（测试夹具）→ 503，行为与现状零差异（与 MCP / 媒体 / 仪式订阅同惯例）。

## 4. 生成契约（严格 JSON）

**AgentDraft**（`generateAgent`）：
```jsonc
{
  "id": "content-ops",              // 小写字母开头，[a-z0-9-]，≤40，全局唯一
  "name": "内容运营", "role": "内容运营专家", "title": "Content Ops",
  "description": "一句话职责（≤60 字）",
  "capabilities": ["…", "…", "…"],  // 3–6 项
  "group": "marketing",             // 建议场景 id（从注入清单中选）
  "icon": "megaphone",              // lucide 名（从已注册名中选，未知名回退默认）
  "gradient": ["#f43f5e", "#fb7185"],
  "handoff": ["content", "brand"],  // 同场景/相邻场景成员 id
  "skills": ["content-marketing"],  // 预载技能（从技能名单选 0–3 个）
  "temperature": 0.6,
  "sections": {                     // 六段骨架（与 check:agents 同源）
    "职责": "…", "专业判断": "…", "工作方式": "…",
    "质量与自检": "…", "交付契约": "…", "协作接口": "…"
  }
}
```
**SkillDraft**（`generateSkill`）：`{ "name": "kebab-case", "description": "触发条件 + 用途（≤80 字）", "tags": ["…"], "body": "Markdown 正文" }`

**服务端组装**：`body = 六段 sections 按序拼接`（每段 `## <名>` 标题 + 内容），连同其它字段构成可直接喂给 `POST /api/console/agents` 的 `AgentCreateInput` 形状。

## 5. 提示词策略

- **系统提示**（中文，固定）：定位 =「角色资产架构师」；声明六段骨架各自的写法要求与**每段 ≥60 字、正文总长 ≥900 字**；要求输出**单个 JSON**（字段与类型逐条列出）；禁止输出 JSON 之外的任何解释文字。
- **上下文注入**（每轮现算）：
  - 现有场景清单：`- <id>：<name>`（一行一个，含 objective 摘要截断）——生成器不得重复建已有场景；
  - 现有技能名单：`name（description 截 40 字）`——供 `skills` 预载建议；
  - 同场景（或全量前若干）成员：`- <id>：<name>（<role>）`——供 `handoff` 建议，仅可引用名单内 id。
- **参数**：`temperature 0.4`（稳定优先）· `responseFormat = json_schema`（name `agent_draft` / `skill_draft`）· 模型 = `cfg.llmModel`。
- **重试**（≤2 次）：JSON 解析失败 / 后校验失败 → 下一轮把**上一轮输出 + issues 清单**作为 user 附加段回注（「修正以下问题后重新输出完整 JSON」）。

## 6. 校验与质量闭环

**服务端后校验**（生成即验，问题进 `issues` 并不阻断返回——由前端决定重生成或手改）：
1. 结构：zod schema（字段类型 / 枚举 / 长度）；
2. 六段：六段标题齐备且各段正文 ≥60 字；正文总长 ≥900 字；
3. 命名：`id` 正则 + 与现有角色 id 冲突检测；`name` 冲突仅提示；
4. 引用：`group` 必须命中现有场景 id 或提供 `newGroup`；`handoff` / `skills` 只允许名单内 id（服务端过滤越界项）；
5. 硬失败（无法组 JSON）→ HTTP 502（附最后一次原始输出截断）；校验失败但有可用草稿 → HTTP 200 + `issues`。

**落盘时**：既有 `createAgent` / `createSkill` 再校验（zod + 冲突 409），生成层校验不是唯一防线。

## 7. UI 交互设计

- **AgentConsole**：页头「AI 生成」按钮 → 对话框：
  - 描述输入（textarea + 3 条示例占位符，如「做一个专门拆解竞品的分析师」「财务对账助理」）；
  - [生成] → loading（禁用 + 文案「正在生成（约 10–30 秒）」）→ 成功：`issues` 非空时黄条列出，主按钮「填入新建向导」→ 打开既有向导 step2 且全字段预填（含正文），用户可改后提交；失败：错误条 + [重试]。
  - 「再生成一次」直接重调（保留描述）。
- **SkillConsole**：新建对话框增「AI 生成」区块（描述 → 生成 → 预填 name / description / tags / body）→ 既有创建（成功即进编辑器）。
- **一致原则**：生成器不替代编辑器——**生成是"起草"，编辑器是"定稿"**。

## 8. API 登记

| 方法 | 路径 | 说明 | 响应 |
| --- | --- | --- | --- |
| POST | `/api/console/generate/agent` | 按描述生成 Agent 草稿（不落盘；未装配 503） | `{ draft, issues, attempts, model }` |
| POST | `/api/console/generate/skill` | 按诉求生成 Skill 草稿（不落盘；未装配 503） | `{ draft, issues, attempts, model }` |

请求体：`{ description: string(1..2000), sceneHint?: string }`（Agent）/ `{ requirement: string(1..2000) }`（Skill）。

## 9. 测试与验证

- **server**（`tests/asset-generator.test.ts`）：假 provider 场景——正常 JSON 一次通过 / 首轮坏 JSON 次轮修正 / 六段缺失进 issues / id 冲突进 issues / handoff·skills 越界过滤 / 硬失败 502；路由级——未装配 503、成功 200 形状、坏请求 400。
- **client**（`tests/console-generate.test.tsx`）：console-store 两方法（POST 断言）/ AgentConsole 生成→预填向导断言 / SkillConsole 生成→预填断言。
- **全量回归**：typecheck / lint / server / client 全绿；**冒烟**：dev 服务经 UI 生成一个角色 → 出现在 `/api/agents`（热生效）。

## 10. 边界与后续（v2 候选）

- AI 生图头像（接 `media_generate` / 图像模型）；生成角色自动跑 golden 任务自评（eval 探针闭环）；
- 灵魂 / 场景 / 技能的"整套生成"（描述 → 新场景 + 角色 + 技能包）；
- 生成历史与 A/B（多候选对比）；生成结果一键"加入 presets 组队预设"；
- 安全：生成提示词注入防护（用户描述作为数据段注入，不拼接指令级文本）；生成输出仅内存流转。
