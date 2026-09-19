/**
 * 数据库迁移（M1 数据地基）：版本化 SQL，按序执行并记录 schema_migrations。
 *
 * 约定：
 * - 每个迁移只增不改：新需求追加新版本，不修改历史 SQL（已落库的环境不会重跑）；
 * - 语句幂等（IF NOT EXISTS；`ADD COLUMN` 无 IF NOT EXISTS，由迁移器的 duplicate column 特赦兜底），
 *   保证「从空库」与「从旧库」都能收敛到同一结构；
 * - 本文件建全量结构，后续里程碑只填数据、不再加表（除非确有必要）。
 */

export interface Migration {
  version: number
  name: string
  sql: string
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- ---------- 项目（M6：真实仓库挂载） ----------
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  workspace_mode TEXT NOT NULL DEFAULT 'sandbox',
  base_branch TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- 会话 ----------
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  participant_ids TEXT NOT NULL DEFAULT '[]',
  workspace_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

-- ---------- 消息 ----------
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  turn_index INTEGER NOT NULL DEFAULT 0,
  seq INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL,
  agent_id TEXT,
  content TEXT NOT NULL DEFAULT '',
  mentions TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'complete',
  artifacts TEXT NOT NULL DEFAULT '[]',
  tool_calls TEXT,
  reasoning TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_seq ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id);

-- ---------- 运行（M3：Run 持久化与断点恢复） ----------
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  queue TEXT NOT NULL DEFAULT '[]',
  spoken TEXT NOT NULL DEFAULT '[]',
  turn_index INTEGER NOT NULL DEFAULT 0,
  fallback_used INTEGER NOT NULL DEFAULT 0,
  handed_to_user INTEGER NOT NULL DEFAULT 0,
  pending_user_messages TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, state);

-- ---------- 上下文压缩（M2） ----------
CREATE TABLE IF NOT EXISTS summaries (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  until_seq INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  token_count INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_unique ON memory(session_id, kind, hash);

-- ---------- 任务清单（M3：跨 Run 继承） ----------
CREATE TABLE IF NOT EXISTS task_items (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  owner_agent_id TEXT,
  ord INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_items_session ON task_items(session_id, ord);

-- ---------- 交付件版本（M8：Diff 与回滚） ----------
CREATE TABLE IF NOT EXISTS artifact_versions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  version INTEGER NOT NULL,
  content TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  author_agent_id TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifact_versions ON artifact_versions(session_id, path, version DESC);

-- ---------- 可观测（M9） ----------
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL DEFAULT 0,
  type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_run_events_run ON run_events(run_id, id);

CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'turn',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage(run_id);

CREATE TABLE IF NOT EXISTS tool_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name TEXT NOT NULL,
  ok INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  agent_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tool_metrics_name ON tool_metrics(tool_name, created_at);

-- ---------- 人机协同（M7） ----------
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'pending',
  decision TEXT,
  feedback TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvals_run ON approvals(run_id, status);

-- ---------- 反馈（M9：数据集） ----------
CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);

-- ---------- 通用键值（设置覆盖 / 游标等） ----------
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: 'fts',
    sql: `
-- 全文检索（trigram：支持中文子串匹配）。FTS5 不可用的构建会被迁移器捕获并跳过。
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  message_id UNINDEXED,
  session_id UNINDEXED,
  tokenize = 'trigram'
);
`,
  },
  {
    version: 3,
    name: 'member_souls',
    sql: `
-- M16：会话级灵魂换装（agentId → soulId 的 JSON 映射；空对象 = 全部用角色默认灵魂）
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE sessions ADD COLUMN member_souls TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    version: 4,
    name: 'connections_audit_browser',
    sql: `
-- ---------- 连接中心（M22：数据库 / SSH / 浏览器接入配置；secret_enc 为 AES-256-GCM 密文） ----------
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_checked_at TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- 会话连接绑定（最小权限边界：Agent 只能使用会话绑定的连接） ----------
CREATE TABLE IF NOT EXISTS session_connections (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, connection_id)
);

-- ---------- 操作审计（用户与 Agent 的全量留痕，含手动操作） ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  session_id TEXT,
  run_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  detail TEXT,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id, id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, ts);

-- ---------- 浏览器会话（CDP 接入生命周期） ----------
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  connection_id TEXT,
  backend TEXT NOT NULL DEFAULT 'managed',
  state TEXT NOT NULL DEFAULT 'launching',
  controller TEXT NOT NULL DEFAULT 'agent',
  viewport_w INTEGER,
  viewport_h INTEGER,
  endpoint TEXT,
  external_pid INTEGER,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  last_frame_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_session ON browser_sessions(session_id, state);

-- ---------- 浏览器步骤（可视化时间轴 + 截图证据） ----------
CREATE TABLE IF NOT EXISTS browser_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  browser_session_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT,
  agent_id TEXT,
  seq INTEGER NOT NULL,
  actor TEXT NOT NULL DEFAULT 'agent',
  action TEXT NOT NULL,
  args TEXT,
  url TEXT,
  screenshot_path TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  detail TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_steps_bs ON browser_steps(browser_session_id, seq);
`,
  },
  {
    version: 5,
    name: 'plans_reviews',
    sql: `
-- ---------- 协作计划（M24：规划范式产出与生命周期；steps/risks 为 JSON 列） ----------
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  steps TEXT NOT NULL DEFAULT '[]',
  risks TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'submitted',
  version INTEGER NOT NULL DEFAULT 1,
  feedback TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_plans_session ON plans(session_id, status);

-- ---------- 评审记录（M24：评审范式结构化判定；findings/evidence 为 JSON 列） ----------
CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT,
  agent_id TEXT NOT NULL,
  plan_id TEXT,
  step_id TEXT,
  target TEXT NOT NULL,
  verdict TEXT NOT NULL,
  findings TEXT NOT NULL DEFAULT '[]',
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reviews_session ON reviews(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reviews_plan ON reviews(plan_id);

-- M24：会话「规划先行」开关（默认关闭；用户未显式指定范式时首波默认进入 plan 范式）
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE sessions ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0;
-- M24：消息范式标记（规划 / 评审消息徽章；NULL = 执行）
ALTER TABLE messages ADD COLUMN mode TEXT;
`,
  },
  {
    version: 6,
    name: 'memory_scopes',
    sql: `
-- ---------- M25：记忆四层 scope（session / agent / project / global）+ 向量规范副本 ----------
-- memory 重建：新增 scope/owner_id/importance/entities/status/时间有效性/溯源/访问统计；
-- session_id 改为可空（仅 session scope 有值，会话删除级联清理；agent/global 记忆在源会话删除后仍存活）。
-- 注意：迁移 SQL 中不得出现 vec0 等扩展对象（扩展缺失时会连本条迁移一起被跳过，见 db.ts 迁移器语义）；
-- 向量镜像表由 MemoryService 运行时幂等创建。
ALTER TABLE memory RENAME TO memory_v1;
CREATE TABLE memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'session',
  owner_id TEXT NOT NULL DEFAULT '',
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  hash TEXT NOT NULL,
  source TEXT,
  importance INTEGER NOT NULL DEFAULT 3,
  entities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  supersedes TEXT,
  superseded_by TEXT,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source_session_id TEXT,
  source_run_id TEXT,
  hits INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO memory (id, scope, owner_id, session_id, kind, content, hash, source, importance, entities, status, valid_from, source_session_id, created_at, updated_at)
  SELECT id, 'session', session_id, session_id, kind, content, hash, source, 3, '[]', 'active', created_at, session_id, created_at, updated_at FROM memory_v1;
DROP TABLE memory_v1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_unique_scoped ON memory(scope, owner_id, kind, hash);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory(scope, owner_id, status, kind);
CREATE INDEX IF NOT EXISTS idx_memory_session_scope ON memory(session_id, status);

-- 向量规范副本（float32 LE BLOB；vec0 镜像可随时由此重建，本表为唯一真相源）
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  norm REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_vectors_model ON memory_vectors(model, dim);

-- 嵌入指纹缓存（跨重启存活；按 model 隔离；容量由 MemoryService 定期修剪）
CREATE TABLE IF NOT EXISTS embedding_cache (
  text_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (text_hash, model)
);
CREATE INDEX IF NOT EXISTS idx_embedding_cache_age ON embedding_cache(created_at);

-- 嵌入队列（写入即入队；worker 批量消费；崩溃后按表内状态自动补账）
CREATE TABLE IF NOT EXISTS memory_embed_queue (
  memory_id TEXT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 7,
    name: 'memory_fts',
    sql: `
-- ---------- M25：记忆全文检索（trigram：中文子串匹配；FTS5 不可用的构建会被迁移器跳过） ----------
-- 变更由 MemoryStore 同步维护（与 messages_fts 同模式，无触发器）
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  content,
  memory_id UNINDEXED,
  tokenize = 'trigram'
);
-- 回填既有记忆（后续增删改由 MemoryStore 同步）
INSERT INTO memory_fts (content, memory_id) SELECT content, id FROM memory;
`,
  },
  {
    version: 8,
    name: 'mcp_servers',
    sql: `
-- ---------- M27：MCP 服务器（外部工具接入；secret_enc 为 AES-256-GCM 密文：stdio env / http headers） ----------
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT,
  transport TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  tools_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'idle',
  last_checked_at TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'ui',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---------- 会话 MCP 服务器绑定（最小权限边界：Agent 只能使用会话绑定的 MCP 工具） ----------
CREATE TABLE IF NOT EXISTS session_mcp_servers (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  granted_at TEXT NOT NULL,
  PRIMARY KEY (session_id, server_id)
);
`,
  },
  {
    version: 9,
    name: 'message_attachments',
    sql: `
-- M33：消息附件（上传的图片 / 视频 / 文档；MessageAttachment[] JSON，NULL = 无附件）
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE messages ADD COLUMN attachments TEXT;
`,
  },
  {
    version: 10,
    name: 'finance',
    sql: `
-- ---------- M34：金融投研（K线缓存 / 快照缓存 / 新闻 / 自选 / 元数据） ----------
-- 说明：均为本地单用户表，无外键依赖；行情数据按 symbol+period+adjust 写覆盖（TTL 逻辑在代码层）

-- K 线缓存（长驻；日线当日内逐日增量由代码层处理，这里存整段快照 JSON）
CREATE TABLE IF NOT EXISTS finance_kline_cache (
  symbol TEXT NOT NULL,
  period TEXT NOT NULL,
  adjust TEXT NOT NULL,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,
  bars INTEGER NOT NULL DEFAULT 0,
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (symbol, period, adjust)
);

-- 实时快照缓存（短 TTL 10s，仅防抖不落盘展示）
CREATE TABLE IF NOT EXISTS finance_quote_cache (
  symbol TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  source TEXT NOT NULL,
  as_of TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

-- 新闻/公告缓存（去重键 URL；scope = symbol | market）
CREATE TABLE IF NOT EXISTS finance_news_cache (
  url TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  title TEXT NOT NULL,
  source TEXT NOT NULL,
  published_at TEXT,
  payload TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_finance_news_scope ON finance_news_cache(scope, scope_key, published_at DESC);

-- 自选列表（全局单表，非会话资产；type = stock | etf | fund | index）
CREATE TABLE IF NOT EXISTS finance_watchlist (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

-- 元数据（证券主数据 / Python 桥探测结果 / 数据源健康度；key-value）
CREATE TABLE IF NOT EXISTS finance_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 11,
    name: 'scheduled_tasks',
    sql: `
-- ---------- M35：定时任务（会话内调度；run = 触发协作运行 / remind = 纯提醒） ----------
-- 说明：next_run_at 为调度索引（enabled=1 AND next_run_at <= now 即到期）；spec 存 JSON（ScheduleSpec）
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  instruction TEXT NOT NULL,
  target_agent_id TEXT,
  spec TEXT NOT NULL,
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  next_run_at TEXT,
  last_run_at TEXT,
  last_run_id TEXT,
  last_status TEXT,
  last_error TEXT,
  run_count INTEGER NOT NULL DEFAULT 0,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_due ON scheduled_tasks(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_session ON scheduled_tasks(session_id);
-- 触发注入的用户消息挂 schedule_id（前端徽章 + 溯源；NULL = 普通消息）
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE messages ADD COLUMN schedule_id TEXT;
`,
  },
  {
    version: 12,
    name: 'session_serial_mode',
    sql: `
-- ---------- M46-2：会话级「串行执行」开关（默认开启：波次逐位出场，便于跟进与查看） ----------
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE sessions ADD COLUMN serial INTEGER NOT NULL DEFAULT 1;
`,
  },
]
