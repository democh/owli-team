# 运维与配置

> 面向部署、调参与故障排查。接口清单见 [api.md](api.md)；架构与决策记录见 [../design.md](../design.md) 与 [adr/](adr/)。

## 1. 运行形态

| 形态 | 命令 | 说明 |
| --- | --- | --- |
| 开发 | `npm run dev` | 服务端 8787（tsx watch）+ 客户端 5173（Vite HMR，`/api` 与 `/ws` 代理到 8787） |
| 生产（单端口） | `npm run build && npm start` | `server/dist` + `client/dist` 由同一 Express 进程托管（默认 8787，含 API + 静态资源 + SPA 回退） |
| Docker | `docker compose up -d --build` | 见根目录 `Dockerfile` 与 `docker-compose.yml`（挂载 `data/`、`workspace/`，可选 `ALLOWED_ROOTS`） |
| E2E（mock） | `npm run e2e` | Playwright 自动拉起双 mock 实例（LLM_MOCK=true），26 条主链路 |
| 评测（mock） | `npm run eval` | 隔离临时 DATA_DIR，串行跑 `evals/tasks/*.json`，与 baseline 对比，回归则非零退出 |

**环境要求**：Node.js 22.5+（推荐 24，依赖内置 `node:sqlite`；CI 与 Docker 镜像均为 24）、npm 10+、系统 `git`（repo/worktree 模式必需）。

**向量记忆（M25）前置**：`sqlite-vec@^0.1.9` 随 server 依赖安装，平台二进制经其 optionalDependencies 分发（darwin-x64/arm64、linux-x64/arm64、win-x64）；不在覆盖面（含 musl/alpine）或旧 Node（无 `allowExtension`）时自动降级纯 JS 余弦后端——功能完整、大库性能下降，启动日志有告警。Docker 保持 glibc 基础镜像（node:24-slim），勿改 alpine。

### 1.1 Docker 部署要点

- 容器内必须 `BIND_ALL=true`（否则监听 127.0.0.1 无法被端口映射访问）；`AUTH_TOKEN` 由 compose 强制（未设置直接报错）；
- 镜像基于 `node:24-slim` 多阶段构建：构建阶段 `npm ci` + `npm run build`，运行阶段仅生产依赖 + `server/dist` + `client/dist` + `agents/` + `skills/`，并安装 `git`（worktree / Git 工具依赖）；
- 浏览器首次访问 `http://<主机>:<端口>/?token=<AUTH_TOKEN>` → 服务端种 `HttpOnly` cookie 并 302 跳回 `/`，此后页面内 fetch 与 WS 握手自动通过鉴权；token 错误返回 401 且不种 cookie；
- 端口默认仅绑定宿主 `127.0.0.1`（双层防护）；局域网访问改 compose 为 `"8787:8787"`；
- `./data`、`./workspace` 挂载持久化；Linux 宿主首次启动前 `mkdir -p data workspace && sudo chown -R 1000:1000 data workspace`（容器内以 `node` 用户运行，uid=1000）；
- 真实仓库模式：在 compose 中挂载仓库目录（如 `${REPOS_DIR:-./repos}:/repos`）并设 `ALLOWED_ROOTS=/repos`；
- 内置 `HEALTHCHECK`（带 token 探测 `/api/health`），`docker compose ps` 可看健康状态。

无 Docker 环境时可用等价的本地生产形态验证：`npm run build && BIND_ALL=true AUTH_TOKEN=<token> npm start`（浏览器访问 `http://127.0.0.1:8787/?token=<token>`）。

## 2. 数据目录与备份

| 路径 | 内容 | 说明 |
| --- | --- | --- |
| `data/app.db` | SQLite 主库（会话/消息/运行/记忆（含 M25 向量表）/摘要/任务/审批/usage/trace/feedback + FTS） | WAL 模式，备份时连同 `app.db-wal`、`app.db-shm` 一起拷贝 |
| `data/settings.json` | 运行期设置覆盖层（UI 可改） | 原子替换写入 |
| `data/logs/app-<date>.log` | pino 结构化日志（含 traceId=runId） | 跨日自动换文件，保留 7 天 |
| `data/worktrees/<sid>` | git worktree（M6 worktree 模式；M57 新会话落 `u_<uid>/<sid>`，既有目录原位保留） | 删除会话时默认丢弃 |
| `data/canvas/<sid>.json` | 会话级画布文档（M31；JSON 单文档 + `version` 乐观锁；M57 新文档落 `u_<uid>/<sid>.json`） | 原子写（tmp/rename）+ debounce flush；备份直接拷贝 |
| `workspace/<sid>/` | 会话工作区（sandbox 模式交付件 + uploads；M57 新会话落 `workspace/u_<uid>/<sid>/`，历史平面目录兼容回退可读） | 删除会话时可选择保留；删除账号时随 `u_<uid>` 整树清理 |
| `data/sessions/*.json` | v1 旧版 JSON 会话（仅历史遗留） | 启动时一次性幂等导入（`.imported` 标记），原文件保留不删 |
| `data/.connection-key` | 连接中心 / MCP 凭据加密密钥（0600 自动生成） | 备份必带；丢失 / 更换后既有连接与 MCP 凭据不可解密，需重新录入（`CONNECTION_SECRET_KEY` env 优先） |

**备份建议**：停机或以文件级快照方式拷贝上述路径即可；恢复 = 原样放回后启动（迁移器按 `schema_migrations` 幂等推进）。旧 JSON 也可手动导入：`npm run migrate:json`。

## 3. 配置优先级与运行期设置

**优先级**：`data/settings.json`（UI 修改 / `PUT /api/settings`）> 环境变量 > 内置默认值。

- 改 env 需重启；UI 设置面板修改的字段**就地生效、无需重启**；
- 可经 UI 覆盖的字段（`GET /api/settings` 的 `fields`）：`llmModel`、`summaryModel`、`judgeModel`、`temperature`、`temperatureOverride`、`maxTurnsPerRun`、`contextBudgetTokens`、`keepRecentTurns`、`toolResultMaxTokens`、`toolDetailKeep`、`toolTimeoutMs`、`handoffMode`、`approvalMode`、`approvalTimeoutMs`、`allowRunCommand`、`allowSensitive`、`notifyPollMs`、`embeddingConnectionId`、`memoryRecallEnabled`、`memoryRecallTopK`、`memoryRecallMinScore`、`memoryRecallBudgetTokens`、`memoryDigestMode`（末六项为 M25 向量记忆）；
- 启动日志打印生效配置表（`describeConfig`）；非法 env 值「回退默认 + 告警」，但 `BIND_ALL=true` 且无 `AUTH_TOKEN` 会**拒绝启动**。

## 4. 环境变量全表

### 4.1 服务端

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `BIND_ALL` | `false` | `true` = 监听 `0.0.0.0`（暴露局域网），此时强制要求 `AUTH_TOKEN` |
| `AUTH_TOKEN` | 空 | 鉴权令牌（`Authorization: Bearer` 或 cookie `auth_token`）；配置即启用校验；浏览器首次访问 `/?token=<AUTH_TOKEN>` 种 cookie |
| `ALLOWED_ORIGINS` | 空 | CORS / 写请求 Origin 校验白名单（逗号分隔）；留空 = 仅本机来源 |
| `MESSAGE_RATE_LIMIT` | `30` | `/api/sessions/:id/messages` 每 IP 每分钟上限（超限 429） |
| `LOG_LEVEL` | `info` | `trace\|debug\|info\|warn\|error\|silent`（测试环境默认 silent） |

### 4.2 LLM

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点（DeepSeek / OpenAI / Ollama / 自建网关） |
| `LLM_API_KEY` | 空 | **必填**：未配置且未开 `LLM_MOCK` 时拒绝启动 |
| `LLM_MODEL` | `deepseek-flash` | 主模型（角色 front-matter 可覆盖） |
| `LLM_MOCK` | `false` | 显式启用脚本化 Mock Provider（零网络，仅 E2E / 离线演示；生产勿开） |
| `LLM_MOCK_DELAY_MS` | `8` | Mock 分片延时（ms），调大可观察流式 / 插话 / 停止 |
| `LLM_THINKING` | `false` | 思考模式：开启后流式产出 `reasoning` 通道并折叠展示 |
| `LLM_REASONING_EFFORT` | `high` | 思考强度（仅思考模式生效）：`low\|high\|max` |
| `LLM_MAX_OUTPUT_TOKENS` | `8192` | 单次输出上限（`max_tokens` 显式下发；`0` = 交给服务商默认）。流末触顶 → 系统条提示（ADR 0186） |
| `LLM_JSON_MODE` | `json_object` | 结构化输出形态（M2 摘要 / M9 judge）：`json_object\|json_schema\|off` |
| `SUMMARY_MODEL` | 空 | 摘要模型（留空 = 复用 `LLM_MODEL`） |
| `JUDGE_MODEL` | 空 | 评测裁判模型（留空 = 复用摘要模型） |
| `LLM_TEMPERATURE` | `0.6` | 采样温度（角色 front-matter 可覆盖） |
| `LLM_TEMPERATURE_OVERRIDE` | `false` | 统一温度：开启后忽略角色 front-matter 的 `temperature`，全部角色使用 `LLM_TEMPERATURE`（设置面板可热切换） |
| `LLM_MAX_CONCURRENCY` | `3` | 全局并发信号量（超出排队） |
| `LLM_MAX_RETRIES` | `3` | 可重试错误的退避重试次数 |
| `LLM_RETRY_BASE_DELAY_MS` | `500` | 重试基础退避（指数 + 抖动） |
| `FIRST_TOKEN_TIMEOUT_MS` | `30000` | 首 token 超时（超时按可重试处理） |
| `STREAM_IDLE_TIMEOUT_MS` | `60000` | 流空闲超时（两 chunk 间最大间隔） |
| `TURN_TIMEOUT_MS` | `120000` | 单回合总超时 |
| `LLM_PRICING_JSON` | 空 | 单价表覆盖（每 1K token 美元，JSON；合并内置 `DEFAULT_PRICING`） |

### 4.3 编排与上下文工程

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_TURNS_PER_RUN` | `10` | 单 Run 回合上限（= 最大波数，波内人数不额外占配额；触顶走收尾兜底） |
| `PARALLEL_MAX` | `3` | 单波并行成员上限（`1` = 关闭并行；场景可在 `_group.yaml` 用 `parallelMax` 覆盖） |
| `HANDOFF_MODE` | `auto` | 转交机制：`auto`（优先 handoff 工具，回退文本 @）\| `tool` \| `text` |
| `CONTEXT_BUDGET_TOKENS` | `60000` | 上下文预算；压缩触发线 = 预算 × 0.7 |
| `KEEP_RECENT_TURNS` | `6` | 最近 K 个回合保留原文（不参与压缩） |
| `TOOL_RESULT_MAX_TOKENS` | `4000` | 单条工具结果上限（超出截断 + 提示 offset 续读） |
| `TOOL_DETAIL_KEEP` | `6` | 最近 N 条工具结果保留 detail，更早折叠为一行 |

### 4.4 目录

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `AGENTS_DIR` | `agents` | Agent 资产包目录（`<场景>/<角色>/` 单包结构；改完即生效，无需重启） |
| `PROMPTS_DIR` | `prompts` | **兼容回退**：`agents/` 不存在时按旧逻辑加载并启动告警（迁移期保留一个版本周期） |
| `SKILLS_DIR` | `skills` | 技能库目录 |
| `DATA_DIR` | `data` | 数据根（DB / settings / logs / worktrees 的默认父目录） |
| `WORKSPACE_DIR` | `workspace` | 会话工作区根（sandbox 模式） |
| `WORKTREE_DIR` | `data/worktrees` | git worktree 目录 |
| `LOG_DIR` | `data/logs` | 日志目录 |
| `DB_FILE` | `data/app.db` | SQLite 文件路径 |
| `SETTINGS_FILE` | `data/settings.json` | 运行期设置文件 |

### 4.5 工具与安全

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MAX_TOOL_STEPS` | `8` | 单回合工具循环步数上限 |
| `TOOL_TIMEOUT_MS` | `20000` | 单工具超时（超时 abort 工具信号，无遗留副作用） |
| `ALLOW_RUN_COMMAND` | `false` | 是否开放 `run_command` |
| `ALLOWED_COMMANDS` | 空 | `run_command` 白名单前缀（逗号分隔；留空 = 内置安全清单） |
| `ALLOWED_ROOTS` | 空 | 允许挂载为项目根的目录白名单（逗号分隔；留空 = 仅限 `workspace/` 内） |
| `ALLOW_SENSITIVE` | `false` | 放开敏感文件（`.env*` / `.ssh` / `*.pem` / `id_rsa*`）读写；即便放开仍走审批 |
| `WEB_FETCH_ALLOWED_DOMAINS`（已移除） | — | `web_fetch` 已无域名白名单（任意 http/https 地址可抓取；见 ADR 0136） |
| `WEB_SEARCH_ENABLED`（已移除） | — | `web_search` 已无启用开关（始终可用；见 ADR 0136） |
| `BAIDU_SEARCH_API_KEY` | 空 | 千帆「百度搜索」API Key（配置后走官方 API，结构化结果、无风控） |
| `BAIDU_SEARCH_API_URL` | 千帆 web_search 端点 | 官方 API 地址（一般无需修改） |
| `WEB_SEARCH_ENGINES` | 空（内置 `baidu,bing,sogou,so360`） | 免 Key 引擎降级链（逗号分隔；被风控/冷却的引擎自动切换到下一个；见 ADR 0184） |
| `HTTP_USER_AGENT` | 空 | 联网工具浏览器 UA 覆盖（留空 = 内置 Chrome 桌面版） |
| `HTTP_MIN_INTERVAL_MS` | `1200` | 同域名最小请求间隔（反爬限速；`0` = 不限速） |
| `HTTP_TIMEOUT_MS` | `15000` | 单次联网请求超时（毫秒） |
| `ARTIFACT_MAX_BYTES` | `524288` | 交付件文本内联上限（超出引导下载） |

### 4.6 审批（HITL）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APPROVAL_MODE` | `risky` | `off` \| `risky`（仅高风险工具：`git_commit` / `run_command` / 覆盖写 / 敏感文件）\| `all` |
| `APPROVAL_TIMEOUT_MS` | `600000` | 审批超时（超时视为拒绝并回灌「用户未响应」） |
| `APPROVAL_TOOLS` | 空 | 额外强制审批的工具名（逗号分隔） |
| `PLAN_REVIEW_TIMEOUT_MS` | `0` | 计划审批挂起等待时长（毫秒；`0` = 无限等待，M24） |

### 4.7 通知与运行

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `WS_HEARTBEAT_MS` | `30000` | WebSocket 心跳间隔 |
| `WS_REPLAY_BUFFER` | `200` | 断线重连的环形重放缓冲条数 |
| `RUN_DETACH_ON_DISCONNECT` | `true` | 断开连接后 Run 继续执行（后台执行语义） |
| `ASYNC_RUN_MAX` | `3` | 后台异步 Run 并发上限 |
| `NOTIFY_POLL_MS` | `5000` | WS 降级轮询间隔（经 `/api/health` 下发给前端） |

### 4.8 向量记忆（M25）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EMBEDDING_CONNECTION_ID` | 空 | 连接中心 embedding 连接 id（env 后备；「设置 → 向量记忆」选择优先且可热切换） |
| `EMBEDDING_BASE_URL` | 空（= 官方 OpenAI） | OpenAI 兼容 /embeddings 端点（Ollama / 自建网关填本地地址） |
| `EMBEDDING_API_KEY` | 空 | 嵌入端点密钥（推荐在连接中心录入，SecretVault 加密落库） |
| `EMBEDDING_MODEL` | 空 | 嵌入模型名（与连接二选一；均未配置 → 模块休眠） |
| `EMBEDDING_DIM` | `0` | 向量维度（0 = 首次调用自动探测） |
| `EMBEDDING_BATCH_SIZE` | `16` | 单次批量嵌入条数（1–128） |
| `EMBEDDING_TIMEOUT_MS` | `15000` | 单次嵌入请求超时 |
| `MEMORY_RECALL_ENABLED` | `true` | 语义召回（L1.5 注入）开关 |
| `MEMORY_RECALL_TOPK` | `8` | 单次召回条数上限 |
| `MEMORY_RECALL_MIN_SCORE` | `0.25` | 混合评分门槛（低于不注入） |
| `MEMORY_RECALL_BUDGET_TOKENS` | `600` | 注入 token 预算（贪心截断） |
| `MEMORY_RECALL_TIMEOUT_MS` | `300` | 召回超时（超时静默跳过，不阻塞回合） |
| `MEMORY_DIGEST_MODE` | `off` | Run 后自动沉淀：`off` / `session`（仅主 Run）/ `all`（含轻量 Run）；产物为候选态待审 |
| `CONNECTION_SECRET_FILE` | `data/.connection-key` | 连接中心凭据加密密钥文件（0600 自动生成；`CONNECTION_SECRET_KEY` 优先；备份必带） |

- **休眠语义**：未配置 embedding 连接且无 `EMBEDDING_*` → 模块整体休眠（零网络零调用）；「设置 → 向量记忆」选择 / 清空连接即时生效；
- **模型 / 维度切换**：切换后执行 `npm run memory:reindex`（清旧模型向量 → 缺失补账 → 消费队列；队列持久化，中断可重跑，见 §7）；
- **降级**：`sqlite-vec` 扩展不可用自动降级 JS 余弦后端（启动告警；`GET /api/memories/stats` 的 `backend: js` 可见）；恢复后重启自动按 BLOB 重建镜像；
- **沉淀审核**：`MEMORY_DIGEST_MODE` 开启后 Run 完成产出候选记忆（「记忆面板 → 候选」显示），审核转 `active` 后才参与召回；
- **凭据安全**：嵌入 Key 经连接中心 SecretVault（AES-256-GCM）加密落库，只写不读（`secretSet` 标记）；密钥文件丢失 / 更换后需重新录入。

### 4.9 MCP 接入（M27）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MCP_SERVERS` | 空 | 启动种子：`name=command args...`（stdio）或 `name=https://host/mcp`（Streamable HTTP），逗号分隔 |

- **仅种子语义**：每次启动按 name 补建缺失项（`source='env'`；同名已存在——无论来源——跳过，不覆盖不更新）；**同名项被管理台删除后，重启会按 env 重新导入**——不想要即先从 `MCP_SERVERS` 移除再重启；日常增删改以「MCP 管理」台为准（DB 为唯一真相）；
- **凭据**：stdio `env` / http `headers` 经 SecretVault 加密落库（与连接中心共用密钥文件，见 §2 `data/.connection-key`）；stdio 子进程仅获得 SDK 白名单基座 + 配置 env（**不透传进程 env**，防 `LLM_API_KEY` 泄漏）；
- **进程回收**：优雅退出 `stopAll` 关停全部 stdio 子进程，`process.on('exit')` 同步强杀兜底（崩溃路径不漏）；
- **故障排查**：「MCP 管理」服务器卡展示 `status`（idle / ok / error）与 `lastError`（子进程 stderr 转 `LOG_LEVEL=debug` 日志）；「测试」按钮做真实连接（未连接时建立并注入工具）；调用超时按服务器 `timeoutMs`（缺省 `TOOL_TIMEOUT_MS`）。

### 4.10 工具按需发现与 MCP JSON 直配（M28）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TOOL_SEARCH_MODE` | auto | 工具按需发现：`auto`（阈值自适应）/ `on`（强制启用）/ `off`（回退全量加载，同旧版） |
| `TOOL_SEARCH_MIN` | 10 | auto 阈值一：单个 Agent 可延迟工具数 ≥ 此值即启用 |
| `TOOL_SEARCH_TOKEN_PCT` | 10 | auto 阈值二：可延迟工具 schema 估算 token ≥ 上下文预算的该百分比（%）即启用 |
| `TOOL_SEARCH_LIMIT` | 5 | 单次 `tool_search` 最多激活工具数（1–10） |
| `MCP_CONFIG_FILE` | `mcp.json` | MCP JSON 配置文件（相对仓库根；生态标准 `mcpServers` 格式） |
| `MCP_CONFIG_POLL_MS` | 5000 | mcp.json mtime 轮询间隔（ms；0 = 关闭轮询，仅启动同步 + 手动同步） |

**mcp.json 用法**（生态标准格式，Claude Desktop / Claude Code 配置可直接拷贝）：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/notes"]
    },
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${REMOTE_TOKEN}" }
    }
  }
}
```

- **文件权威**：启动同步（**先于** `MCP_SERVERS` env 种子）→ 每 `MCP_CONFIG_POLL_MS` mtime 轮询 → 管理台「立即同步」；文件增 / 删 / 改 ≤ 一个轮询周期落地（管理台 / 注册表 / 连接状态一致）；
- **防误删**：JSON 解析失败 / 文件缺失 → 整次同步跳过（**绝不删库**），「JSON 配置」卡显示错误与「上次已跳过」提示；删除只认「文件成功解析且缺失」的 `source='json'` 条目（断开 + 注销工具 + 级联解绑）；
- **变量展开**：字符串 `${VAR}` / `${VAR:-默认值}`（args / env / url / headers / cwd）；未定义且无默认 → 条目跳过 + 告警（条目级失败不影响其他条目）；
- **来源与只读**：`source='json'` 的服务器在管理台只读（编辑 / 删除 / 启停禁用；API → `409`）——改动走文件；「粘贴导入」创建为「手动」源（可编辑，同名冲突跳过并报告）；
- **eagerLoad**：条目加 `"eagerLoad": true` → 该服务器全部工具常驻（不参与按需发现阈值，适用于小而常用的服务器）；
- **按需发现**：默认只加载核心工具（约 21 个），重型工具（浏览器 / 数据库 / Git / SSH / 联网 / 命令）与 MCP 工具延迟——模型用 `tool_search` 混合检索（BM25 + 嵌入融合）激活，Run 内持续可用；小集合 Agent（可延迟工具 < 阈值）自动全量加载，行为与旧版完全一致；`TOOL_SEARCH_MODE=off` 全局回退。

### 4.11 定时任务（M35）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SCHEDULE_ENABLED` | true | 总开关（false = tick 不启动、工具与接口返回未装配；纯本地零网络，默认开启） |
| `SCHEDULE_TICK_MS` | 30000 | 调度 tick 轮询间隔（ms；5000–600000） |
| `SCHEDULE_TZ` | （空） | 默认时区（IANA 名；空 = 服务器时区；非法值回退并告警一次） |
| `SCHEDULE_MAX_PER_SESSION` | 20 | 单会话任务数上限（防额度滥用） |
| `SCHEDULE_MIN_GAP_MS` | 300000 | 最小触发间隔（ms；高频护栏，硬下限 60000） |
| `SCHEDULE_CATCHUP_MS` | 600000 | 停机补跑窗口（ms；超窗的错过触发按 skipped-missed 跳过而非引爆） |
| `SCHEDULE_FAIL_LIMIT` | 3 | 连续失败自动暂停阈值（1–10） |

- 服务端启动时恢复扫描：修复缺 next_run_at 的循环任务 + 立即补一轮 tick（补跑窗口裁决重启期间错过的触发）；shutdown 时清理 timer；
- 触发留痕落库（last_status / last_run_at / run_count / fail_streak），任务面板与 `list_schedules` 可见；失败重试不自动重启（忙时 skip 留痕、连续失败自动暂停）。

### 4.12 金融投研（M34）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `FINANCE_ENABLED` | false | 总开关（false = 主区 Tab 与 12 个 `fin_*` 工具双不注册、`/api/finance/*` 统一 `503`；纯 opt-in） |
| `FINANCE_PYTHON` | 空 | Python 解释器路径（缺省自动探测 `python3` → `python` → `py -3`；无 Python 走纯 Node 源） |
| `FINANCE_PY_TIMEOUT_MS` | 30000 | Python 桥单任务超时（1000–600000；超时 kill 进程组） |
| `FINANCE_PIP_INDEX_URL` | 空 | pip 镜像（缺省官方源；「一键安装」经审批门执行） |
| `FINANCE_MIN_INTERVAL_MS` | 0 | 金融源同域最小请求间隔（0–60000；0 = 复用反爬模块默认 1200ms） |
| `FINANCE_QUOTE_REFRESH_MS` | 10000 | 行情 Tab 轮询间隔（2000–600000；仅交易时段轮询） |
| `FINANCE_KLINE_SNAPSHOT_DIR` | charts | 快照落盘目录（会话工作区内；进交付件体系） |
| `FINANCE_GAME_MAX_PATHS` | 2000 | 博弈 ABM 路径数上限（1–10000 计算护栏；超出按上限截断并在响应 `note` 提示） |
| `FINANCE_GAME_SEED` | 20260918 | 博弈推演默认随机种子（相同 seed + 参数输出逐位一致） |

- **生效方式**：`FINANCE_ENABLED` 与工具注册在启动时判定（改后需重启）；`financeQuoteRefreshMs` / `financeMinIntervalMs` / `financePyTimeoutMs` 进「设置 → 金融投研」运行期覆盖层，网关 getter 热读、保存即生效；
- **Python 桥三档**：探测结果 `ready`（核心包齐）/ `partial`（部分缺，逐能力降级）/ `absent`（无 Python → 全走 Node 源）；缺包经 `GET /api/finance/env` 与设置面板引导安装（可选 `FINANCE_PIP_INDEX_URL` 镜像）；
- **反爬联动**：同一来源连续失败 ≥2 次进入 5 分钟冷却（网关路由自动跳过），成功后清零；冷却状态经 `GET /api/finance/env` 的 `health` 透出（cooling / cooldownUntil / lastError）；
- **数据延迟**：行情结果带 `asOf` 数据时点；非交易时段不轮询（交易日 / 节假日按 `finance_meta` 日历缓存 12h 判定）；降级原因链 `degraded` 与过期回退 `cache: 'stale'` 在响应中显式标注。

### 4.13 多用户（M57；团队部署）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `SESSION_TTL_DAYS` | `30` | 登录会话滑动过期（天；每次访问续期） |
| `SESSION_ABSOLUTE_TTL_DAYS` | `90` | 登录会话绝对过期（天；不可续期上限） |
| `LOGIN_LOCKOUT_THRESHOLD` | `5` | 登录连续失败锁定阈值（次） |
| `LOGIN_LOCKOUT_MS` | `900000` | 登录失败锁定时长（毫秒） |
| `LOGIN_RATE_LIMIT` | `10` | 登录接口 IP 限流（次/分钟） |
| `RUN_MAX_PER_USER` | `2` | 每用户活跃 + 排队 Run 上限（`0` = 不限制） |
| `TRUST_PROXY` | 空 | 反向代理信任（nginx 单跳填 `1`；`true` = 全信任；空 = 关闭）。开启后限流 / 审计取 `X-Forwarded-For` 真实 IP |
| `AUTH_COOKIE_SECURE` | `false` | HTTPS（网关终止 TLS）下置 `true`：`sid` cookie 加 Secure |

- **启用步骤**：启动后浏览器访问 `http://<主机>:<端口>/` → 兼容模式直达应用；点右上角「账号」→「创建管理员并启用多用户」完成首启（存量数据自动回填其名下，之后经登录页登录）；升级前行为与旧版一致（`AUTH_TOKEN` 仍生效）；
- **nginx 网关要点**：`proxy_set_header X-Forwarded-For/X-Forwarded-Proto/Host`；WebSocket 升级需 `proxy_set_header Upgrade/Connection` 且 `proxy_read_timeout` ≥ 心跳间隔；上传通道（`/api/sessions/*/attachments`、`/media/upload`）单请求最大 200MB，需调整 `client_max_body_size`（默认 1m 会拦）；TLS 终止在网关（应用不内置 HTTPS），DNS/HSTS 由网关层负责；
- **防枚举**：登录失败统一文案（用户名错 / 密码错不可区分）；成员/管理员由「用户管理」页维护（邀请制，无开放注册）；禁用 / 重置密码即时吊销全部会话；
- **会话共享（P2）**：会话属主可经 `/api/sessions/:id/shares` 邀请成员（`editor` 可读写 / `viewer` 只读，可自助 `POST /api/sessions/:id/leave` 退出）；共享变更落审计 `session.share-*`；删除账号 / 会话时共享记录级联清理；跨用户不可见性不变（无共享关系一律 404）。
- **连接最小权限（P2）**：成员使用 SSH / 数据库工具时，仅可用 `member_use=1` 的 system 连接（执行侧以「本 Run 触发者」复核，admin / 兼容模式不限；会话绑定不能绕过）；`ssh.exec` / `db.*` 审计含触发者 `userId`。
- **配额（P3）**：用户管理台行内「配额」按钮可设并发 / 日 token / 月成本 / 会话数 / 存储上限（留空 = 不限；日/月按服务器本地时区重置）；超限行为：任务并发 400 / 用量波次边界收束（`run:end reason=quota` + 系统条）/ 建会话 403 / 上传 403；个人「设置 → 我的用量」只读查看；配额变更审计 `auth.quota-set`。
- **个人连接（P3）**：成员可在「设置 → 我的连接」自建数据库 / SSH（仅本人可见可用），在**会话头部「资源」入口**绑定即用（会话资源弹窗：连接 / MCP 两页签，成员自助绑定面；viewer 只读）；管理员在连接编辑器用「允许成员使用」开关控制 system 连接开放度（关后成员列表隐藏 / 绑定 403 / 工具执行拦截）；删除账号自动清理其个人连接。
- **模型直连 BYOK（P3）**：成员可在「设置 → 模型直连（BYOK）」保存自己的 LLM API Key（加密存储、永不回显；baseUrl / model 留空 = 跟随系统默认）；其会话的全部模型调用（含摘要 / 沉淀 / 脑图）走本人凭据，成本仍按本人归因（usage 记录实际模型）；「恢复系统默认」即时清除；`LLM_MOCK=true` 时 BYOK 不参与。
- **个人 MCP（P3）**：成员可在「设置 → 我的 MCP」自建 stdio / http 服务器（仅本人可见；保存即测试连接）；在**会话头部「资源」入口**绑定后即用——其工具在**属主会话内自动授予**（无需管理员编辑 Agent 工具白名单）；system MCP  仍由管理员在 MCP 管理台维护（成员可绑定使用）；删除账号自动断连并清理其 personal 服务器。运维注意：`/mcp/*` 已改为路由级门控（管理面 admin / personal 资源级 ownerOrAdmin），新增子路由必须显式声明权限。
- **兼容与弃用**：`AUTH_TOKEN` 映射最早创建的管理员（弃用告警），下一大版本移除；账号不存在（未 setup）时接口行为与旧版完全一致。

## 5. 安全说明

- **本地即安全**：默认仅监听 `127.0.0.1`；暴露局域网必须 `BIND_ALL=true` + `AUTH_TOKEN`，启动时打印提醒，token 校验覆盖全部 `/api/*` 与 `/ws` 握手；浏览器通过 `/?token=<AUTH_TOKEN>` 一次性种 `HttpOnly` cookie，后续请求自动携带；
- **CORS 收窄**：`ALLOWED_ORIGINS` 白名单；留空时仅放行本机来源，跨站页面无法静默调用 API；
- **写请求 Origin 校验**：非 GET 请求校验 Origin（同源 / 白名单 / 本机来源放行，跨站 403；无 Origin 的 CLI / 测试请求放行）——开发模式经 Vite 代理（5173 → 8787，changeOrigin 改写 Host）开箱即用；
- **限流**：消息发送接口按 IP 限流（`MESSAGE_RATE_LIMIT`），防误触刷爆模型额度；
- **路径白名单**：项目挂载根必须在 `ALLOWED_ROOTS` 内；工具文件访问全部经 `resolveInRoot`（归一化 + 前缀校验 + 符号链接逃逸拦截）；
- **敏感文件**：默认拒绝读写；`ALLOW_SENSITIVE=true` 放开后仍强制审批；
- **Git 注入防护**：全部 git 调用 `execFile('git', [...])` 参数数组，禁止 shell 字符串拼接；`git_commit` 强制审批；
- **worktree 隔离**：Agent 改动只落在 `agent/<sid>` 分支，合并回主仓库需显式 `confirm=true`，可一键丢弃；
- **崩溃兜底**：全局 `unhandledRejection` / `uncaughtException` 捕获落日志；优雅退出（SIGINT/SIGTERM）对活跃 Run 落 checkpoint，等待 ≤10s。

## 6. LLM_MOCK 与离线演示

`LLM_MOCK=true` 启用脚本化 Mock Provider（`server/src/llm/mock.ts`）：零网络、无需 Key，产出真实的工具调用与分片文本流，覆盖 E2E 与离线演示场景。

```bash
LLM_MOCK=true npm run dev          # 本地离线体验全流程
npm run e2e                        # Playwright 自动用 mock 模式（含审批实例）
```

注意：Mock 仅用于 E2E / 演示；生产环境保持 `LLM_MOCK=false` 并配置真实 `LLM_API_KEY`。

## 7. 常用运维操作

| 操作 | 命令 / 方式 |
| --- | --- |
| 连通性冒烟 | `npm run llm:ping "你好"` |
| 旧 JSON 导入 | `npm run migrate:json`（幂等 + 条数校验） |
| 工作区布局搬迁（M57） | `npm run migrate:workspace`（幂等；`-- --dry-run` 预览；未搬迁数据服务端兼容回退仍可读） |
| 校验 Agent 包 / 技能文档 | `npm run check:agents` / `npm run check:skills` |
| 迁移旧 prompt 资产 | `npm run migrate:agents`（幂等；`--prune` 清理旧文件） |
| 全量门禁 | `npm run typecheck && npm run test && npm run lint` |
| 评测回归 | `npm run eval`（与 `evals/baseline.json` 对比；回归非零退出） |
| E2E + 报告 | `npm run e2e` / `npm run e2e:report` |
| 查看某 Run 轨迹 | `GET /api/runs/:runId/trace` 或前端「战绩 → 查看本次运行轨迹」 |
| 查看指标 | `GET /api/metrics/summary` 或右栏「指标」分段 |
| 导出反馈集 | `GET /api/feedback/export` |
| 记忆向量重建 | `npm run memory:reindex`（模型 / 维度切换后；`-- --force` 重建 vec0 镜像；断点续跑，M25） |

## 8. 故障排查

| 症状 | 排查方向 |
| --- | --- |
| 启动即退出，提示缺少 `LLM_API_KEY` | 配置 Key，或离线场景显式 `LLM_MOCK=true` |
| 启动即退出，提示 `BIND_ALL=true 时必须配置 AUTH_TOKEN` | 配置 `AUTH_TOKEN` 或改回 `BIND_ALL=false` |
| 局域网访问 401 | 浏览器：访问 `http://<主机>:<端口>/?token=<AUTH_TOKEN>` 种 cookie；CLI：加 `Authorization: Bearer <token>` |
| 模型偶发 429 / 5xx / 超时 | 韧性层自动重试（退避 + 尊重 Retry-After）；持续失败看 `data/logs/` 对应 runId 的 trace |
| 超长上下文 400 | 发送前已预算校验 + 自动压缩重试；若仍失败，下调 `CONTEXT_BUDGET_TOKENS` 或缩短任务 |
| worktree 创建失败 | 确认 `rootPath` 是 git 仓库、系统已装 git、目标分支未被占用；失败会回滚会话创建 |
| 交付件列表为空 | repo/worktree 模式下列表 = git 变更集：确认 Agent 确实改动了文件 |
| 端口占用 | 改 `PORT`；E2E 使用 8788/8789，注意避免与本机服务冲突 |
| 数据迁移异常 | 查 `schema_migrations` 表推进状态与启动日志（迁移失败会阻止启动，避免半迁移状态） |
| 召回不生效（L1.5 无注入） | 确认「设置 → 向量记忆」已选连接或配了 `EMBEDDING_*`；新记忆有约 2s 队列补账延迟；`MEMORY_RECALL_ENABLED=false` 时关闭；`GET /api/memories/stats` 看 backend / pending / failed |
| 嵌入连接测试失败 / 凭据不可解密 | 检查端点可达与模型名；`data/.connection-key` 丢失或更换后既有凭据不可解密，需在连接中心重新录入 Key |
