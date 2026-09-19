# ADR 0054：工具按需发现（渐进披露）与 MCP JSON 直配

- 状态：Accepted
- 引入：M28
- 相关：[design.md §44](../design.md)、ADR 15（Skill 渐进式披露：先行决策）、design.md §21（工具系统与 Harness）、ADR 47（向量记忆：嵌入服务复用）、ADR 53（MCP 接入：JSON 直配为配置通道扩展）、ADR 11（异步通知通道）

## 背景

- 每回合把该 Agent 可见的全部工具 schema（内置 48 个 + N 台 MCP 服务器的工具）注入 `ChatRequest.tools`：工具定义随 MCP 接入线性膨胀（Claude Code 实测 50 工具 ≈ 10–20K token），持续挤占 60K 上下文预算；MCP 服务器越多，前缀越不稳定（prompt cache 每次抖动）。
- 参考实现（已调研定案）：Anthropic Tool Search Tool（`defer_loading` / auto=10% 阈值 / 每次最多 5 个 / alwaysLoad 豁免）、Claude Code（`ENABLE_TOOL_SEARCH=auto`、核心内置不计阈值、搜索匹配 name+description）、Pi agent（核心工具极致精简）、LangGraph BigTool（检索元工具返回工具 ID 后动态绑定）。
- 同时：MCP 配置目前只有「管理台 CRUD + `MCP_SERVERS` env 种子」两条通道；生态事实标准是 `mcpServers` JSON（Claude Desktop / Claude Code 配置可直接拷贝），需要打通文件直配。
- 硬约束：
  1. **零新增依赖**：检索排序自实现（BM25），不引入分词 / 检索库；
  2. **向后兼容**：未标注 tier 的工具行为零变化；`TOOL_SEARCH_MODE=off` 一键回到现状；E2E mock 仅调核心工具——既有 29 条链路不受影响；
  3. **嵌入可缺省**：M25 嵌入服务未配置 / 失败 → 静默退化为纯词法检索；
  4. **防误删纪律**：mcp.json 是运维真相源，任何解析异常都不得清空既有服务器。

## 决策

1. **tier 元数据**：`AgentTool.tier?: 'core' | 'deferred'`（缺省视为 core）。内置工具常驻 21 个（文件 / 检索 / 范式三件套 / 记忆协作 / `tool_search`），重型连接类 27 个延迟（web×2 + run_command + git×6 + db×4 + browser×13 + ssh×1）；MCP 工具注册时 `tier = 服务器 config.eagerLoad === true ? 'core' : 'deferred'`。白名单语义不变：`forAgent` 先定「可发现范围」，延迟只影响「初始可见性」，不影响权限。
2. **混合检索**（`server/src/tools/discovery.ts`，纯函数可测）：BM25（k1=1.2 / b=0.75；name 命中权重 ×3 = token 重复注入；中文按 2-gram + 单字；查询整体子串命中工具名给强先验 0.9）打底；配置了 M25 嵌入时叠加语义（query / 条目向量 cosine，融合 `0.65*词法 + 0.35*语义`；条目向量内存缓存按 name+description hash 失效）；嵌入不可用 / 失败 → 静默纯 BM25。
3. **`tool_search` 元工具**（core，readOnly）：参数 `query`（必填，中英文均可）+ `limit`（1–10，默认 `TOOL_SEARCH_LIMIT`=5）；执行 = 排序 + 写入 `RunRecord.activatedTools`（**Run 级生命周期：跨回合保留、不跨 Run**）+ 返回激活清单；无命中兜底返回类别概览（防死路）。
4. **auto 激活判定**（每回合，基于该 Agent 实际可延迟集合）：`deferrableCount >= TOOL_SEARCH_MIN`（默认 10）或 deferred schema token ≥ `TOOL_SEARCH_TOKEN_PCT%`（默认 10%）上下文预算 → 本回合启用搜索；否则全量加载（小集合行为与现状完全一致）。`TOOL_SEARCH_MODE=on|off` 强制开关。
5. **schema 重算移入工具循环**：激活发生在子轮之间，下一子轮即时生效（`toolCandidates` 计算前移到 `prepareTurn` 之前，供 discovery 概览复用）。
6. **执行门**：`tier='deferred'` 且未激活的工具被直接调用 → 不执行，返回 `{ ok:false, summary:'该工具未加载，请先调用 tool_search 检索激活' }`（审批门之前拦截）。
7. **L3 discovery 区块**：启用搜索时注入 `<tool_discovery>`（类别概览 + 「用 tool_search 检索激活」提示，约 150 token）；未启用不注入。
8. **`load_skill` 未命中优化**：回灌 top-3 相近候选（复用 discovery 排序，技能 name+description）替代全部技能名。
9. **MCP JSON 直配**（`server/src/mcp/json-config.ts`）：`mcp.json`（相对仓库根，`MCP_CONFIG_FILE` 可覆盖），生态标准 `{ "mcpServers": { "<slug>": {...} } }`；字段映射 stdio `{command,args,env,cwd}` / http `{type:"http"|"streamable-http",url,headers}` + 扩展 `{enabled,displayName,eagerLoad,timeoutMs,approvalPolicy,readOnlyOverride}`；未知字段忽略 + 告警；字符串 `${VAR}` / `${VAR:-default}` 展开（args/env/url/headers/cwd）；未定义且无默认 → 条目跳过。
10. **文件权威同步语义**：触发 = 启动同步（**先于** `MCP_SERVERS` env 种子）→ mtime 轮询（`MCP_CONFIG_POLL_MS` 默认 5000，0=关）→ API 手动同步；upsert（新增创建 + 连接；transport/config/enabled/secret 解密后深比较变更 → 更新 + 重连）；删除仅限「文件成功解析且缺失」的 `source='json'` 服务器（断开 + 移除 + 级联解绑）；**防误删**：解析失败 / 文件缺失 / 结构非法 → 整次同步跳过（绝不删库）+ 告警 + 广播；条目级失败不影响其他条目，且 `declaredNames`（含解析失败条目的合法 slug 白名单）保留不触发删除；DB 同名 `source≠'json'` → 跳过 + 告警。secret 走 SecretVault（与路由同一拆分通道），对外脱敏。
11. **source 三值与只读保护**：`'env' | 'ui' | 'json'`；`source='json'` 的服务器在管理台 / API **只读**（编辑 / 删除 / 启停返回 409 或禁用，提示「由 mcp.json 管理」）。
12. **API 与审计**：`GET /mcp/json-config`（状态）、`POST /mcp/json-config/sync`（手动同步）、`POST /mcp/json-config/import`（粘贴导入 → 校验 → 创建为 **ui 源**，同名冲突跳过并报告）；审计 `mcp.json-sync` / `mcp.json-import`；同步结果复用 `notify:mcp-changed` 广播（UI 自动刷新）。

## 理由

- **上下文收益量化**：默认全量清单（48 + MCP）→ 仅 21 常驻 + `tool_search` ≈ 每回合省 3–5K token，MCP 越多收益越大；延迟工具初始不入上下文 → 前缀稳定（MCP 扩容不再动摇 prompt cache）。
- **BM25 打底 + 嵌入融合**：纯词法对中文短查询（工具名 / 类别词）已足够，2-gram 无须分词依赖；嵌入可用时补语义（「数据库查询」命中 `db_*`），失败静默退化零风险。
- **Run 级激活 + 只增不减**：工具数组只增不减 → 激活造成的 cache 破坏最小化（Run 级收敛）；跨 Run 重置防「上 Run 激活残留让模型困惑」。
- **auto 阈值而非恒定启用**：小集合（如 critic 白名单仅 2 个 MCP 工具）启用搜索反而增加回合开销；「大到值得检索时才检索」对齐 Claude Code 的 auto 语义。
- **文件权威 + 白名单防误删**：mcp.json 是 Claude 生态事实标准（IDE / 版本控制 / 容器挂载的中心）；解析失败绝不删库是硬纪律——运维误编辑不能连带删除服务器与凭据。
- **eagerLoad 豁免**：给「已知小而常用」的服务器（如 filesystem）留常驻口，平衡复杂性与可用性。

## 被否决的方案

- **纯嵌入检索（不设 BM25 打底）**：嵌入休眠 / 失败时无排名 → 工具不可发现；且给每次检索叠加一次网络往返延迟；
- **引入分词库（jieba / segment 等）**：违反零新增依赖纪律；中文 2-gram + 嵌入融合已覆盖工具名 / 描述场景；
- **依赖模型侧原生 defer_loading 字段**：本项目多供应商（OpenAI 兼容 / Anthropic / Ollama）无统一协议字段——本地实现跨供应商通用；
- **每回合重算激活集**：模型看到已用工具消失会困惑、调用被拒；只增不减更稳定；
- **恒定启用搜索（无 auto 判定）**：小集合 Agent 每回合多一次检索往返与 150 token 概览，收益为负；
- **JSON 配置以 DB 为唯一真相（导入后即与文件脱钩）**：生态配置以文件为中心（可用版本控制 / 容器挂载管理）——文件权威 + DB 物化是对齐；
- **支持 sse / ws 传输的 JSON 条目**：与 M27 传输能力不一致（配置能写却连不上）——跳过 + 告警；
- **坏 JSON 时按空清单同步（清库）**：一次误编辑即删除全部 json 源服务器与凭据——整次跳过是硬护栏；
- **文件删除 = 服务器删除**：容器挂载未就绪等瞬态会让服务器「闪删」——缺失同样跳过，删除只认「成功解析且缺失」；
- **管理台可直接编辑 json 源**：双向写会引入「DB 改 vs 文件改」竞态——只读 + 409 强制走文件。

## 适用与失效条件

- 适用：本地单用户部署（与 ADR 42 / 50 / 53 同一产品形态）；Node ≥18；被接入的 MCP 服务器视同不可信第三方代码。
- 失效条件：
  - 引入远程多实例（多进程共享 DB 与 mcp.json）时，文件权威同步需引入单写者 / 分布式锁；
  - 工具总数达到数百且 top-k 检索质量不足时，需引入更强重排（cross-encoder）或层级目录浏览替代单轮检索；
  - 模型 API 原生工具搜索（`defer_loading` 类字段）成为跨供应商标准时应回归协议字段，删减自研排序；
  - 多租户共享实例时 mcp.json 需按租户隔离，或改为每租户独立配置源；
  - 嵌入模型更换（M25 配置变更）时条目向量缓存按 hash 失效即可，但融合权重（0.65/0.35）需在真实语料上重新校准。
