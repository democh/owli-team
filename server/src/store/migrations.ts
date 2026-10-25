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
  {
    version: 13,
    name: 'multi_user_auth',
    sql: `
-- ---------- M57（多用户 P1）：账号与认证（users / auth_sessions / api_keys / user_prefs） ----------
-- 说明：全部新表（认证能力需要持久化主体，确有必要）；无账号时系统处于单用户兼容模式，行为与既有版本一致。
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  status TEXT NOT NULL DEFAULT 'active',
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_login_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  last_login_ip TEXT
);

-- 登录会话（不透明令牌只存 SHA-256 哈希；滑动过期 + 绝对过期 + 显式撤销）
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  absolute_expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, expires_at);

-- CLI / 脚本访问令牌（明文仅在创建时返回一次）
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

-- 个人偏好（白名单字段由服务端 zod 校验；与系统级 settings.json 分离）
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 14,
    name: 'multi_user_ownership',
    sql: `
-- ---------- M57（多用户 P1）：归属与隔离 ----------
-- 归属列：旧行 owner_id 为 NULL（单用户兼容）；创建首个管理员（setup）时一次性回填，
-- 此后新建资源一律落当前用户；无账号期间守卫放行（行为与旧版一致）。
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE sessions ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE projects ADD COLUMN owner_id TEXT REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE runs ADD COLUMN user_id TEXT;
ALTER TABLE messages ADD COLUMN user_id TEXT;
ALTER TABLE approvals ADD COLUMN decided_by TEXT;
ALTER TABLE audit_log ADD COLUMN user_id TEXT;
ALTER TABLE audit_log ADD COLUMN ip TEXT;
ALTER TABLE usage ADD COLUMN user_id TEXT;
ALTER TABLE run_events ADD COLUMN user_id TEXT;
ALTER TABLE feedback ADD COLUMN user_id TEXT;
-- 记忆的用户维度（access 归属）：global scope 的 owner_id 改为用户 id，
-- 其余 scope（session/agent/project）的 owner_id 语义不变（会话/角色/项目 id），用户维度统一由 user_id 承担。
ALTER TABLE memory ADD COLUMN user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, ts);
CREATE INDEX IF NOT EXISTS idx_memory_user ON memory(user_id);

-- ---------- 连接中心：预留 personal 资源维度（P3 开放，P1 管理面仍为 admin-only） ----------
-- 重建原因：SQLite 不能改 UNIQUE 约束；唯一键由 name → (scope, owner_id, name)（表达式索引处理 NULL）。
-- session_connections 外键为 ON DELETE CASCADE：DROP 会级联清子表行，故先备份后回填。
CREATE TABLE connections_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  secret_enc TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  last_checked_at TEXT,
  last_error TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  scope TEXT NOT NULL DEFAULT 'system',
  owner_id TEXT DEFAULT NULL,
  member_use INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO connections_v2 (id, name, kind, config, secret_enc, status, last_checked_at, last_error, enabled, scope, owner_id, member_use, created_at, updated_at)
  SELECT id, name, kind, config, secret_enc, status, last_checked_at, last_error, enabled, 'system', NULL, 1, created_at, updated_at FROM connections;
CREATE TABLE _bak_session_connections AS SELECT * FROM session_connections;
DROP TABLE connections;
ALTER TABLE connections_v2 RENAME TO connections;
INSERT INTO session_connections (session_id, connection_id, granted_at) SELECT session_id, connection_id, granted_at FROM _bak_session_connections;
DROP TABLE _bak_session_connections;
CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_scope_name ON connections(scope, COALESCE(owner_id, ''), name);

-- ---------- MCP 服务器：同纪律（scope/owner_id 预留；管理面 P1 仍为 admin-only） ----------
CREATE TABLE mcp_servers_v2 (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
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
  scope TEXT NOT NULL DEFAULT 'system',
  owner_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO mcp_servers_v2 (id, name, display_name, transport, config, secret_enc, tools_json, status, last_checked_at, last_error, enabled, source, scope, owner_id, created_at, updated_at)
  SELECT id, name, display_name, transport, config, secret_enc, tools_json, status, last_checked_at, last_error, enabled, source, 'system', NULL, created_at, updated_at FROM mcp_servers;
CREATE TABLE _bak_session_mcp AS SELECT * FROM session_mcp_servers;
DROP TABLE mcp_servers;
ALTER TABLE mcp_servers_v2 RENAME TO mcp_servers;
INSERT INTO session_mcp_servers (session_id, server_id, granted_at) SELECT session_id, server_id, granted_at FROM _bak_session_mcp;
DROP TABLE _bak_session_mcp;
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_scope_name ON mcp_servers(scope, COALESCE(owner_id, ''), name);

-- ---------- 金融自选：按用户（唯一键重建：symbol → (user_id, symbol)） ----------
CREATE TABLE finance_watchlist_v2 (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  note TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  user_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
INSERT INTO finance_watchlist_v2 (id, symbol, type, name, note, sort, user_id, created_at)
  SELECT id, symbol, type, name, note, sort, '', created_at FROM finance_watchlist;
DROP TABLE finance_watchlist;
ALTER TABLE finance_watchlist_v2 RENAME TO finance_watchlist;
CREATE UNIQUE INDEX IF NOT EXISTS idx_watchlist_user_symbol ON finance_watchlist(user_id, symbol);
`,
  },
  {
    version: 15,
    name: 'browser_multiuser_ownership',
    sql: `
-- ---------- M62（多用户浏览器资源治理）：实例归属与关闭原因 ----------
-- 归属列用于：admin 实例观测 / 成员回放自己的历史 bsid / 用户删除清理 / 启动对账。
-- 旧行为 NULL（单用户兼容模式遗留）；回填自 sessions.owner_id（M57 setup 已一次性回填存量归属）。
-- 注意：ADD COLUMN 非幂等；旧库已有该列而缺迁移记录时会报 duplicate column，由迁移器特赦并补记（见 db.ts）
ALTER TABLE browser_sessions ADD COLUMN user_id TEXT;
ALTER TABLE browser_sessions ADD COLUMN close_reason TEXT;
UPDATE browser_sessions SET user_id = (SELECT owner_id FROM sessions s WHERE s.id = browser_sessions.session_id) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_browser_sessions_user ON browser_sessions(user_id, closed_at);
`,
  },
  {
    version: 16,
    name: 'session_sharing_members',
    sql: `
-- ---------- M57 P2（会话共享协作）：共享成员表 ----------
-- 语义：owner 不进此表（由 sessions.owner_id 承载）；role 仅 editor / viewer；
-- 读取权限 = owner ∪ 成员；写权限 = owner / editor（viewer 只读 + 可自助 /leave）；
-- 会话删除级联清成员；用户删除级联清其全部共享记录。
CREATE TABLE IF NOT EXISTS session_members (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  invited_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (session_id, user_id)
);
-- 「与我共享」列表 / WS 可见集过滤
CREATE INDEX IF NOT EXISTS idx_session_members_user ON session_members(user_id, session_id);
`,
  },
  {
    version: 17,
    name: 'user_quotas',
    sql: `
-- ---------- M57 P3：用户配额（NULL 列 = 不限 / 用系统默认） ----------
-- 强制点：launch 并发（max_concurrent_runs 覆盖 RUN_MAX_PER_USER）、波次边界用量（daily_tokens /
-- monthly_cost_usd，基于 usage.user_id 聚合）、会话创建（max_sessions）、上传（max_storage_mb）。
-- 无行 = 全部不限（兼容模式 / 未配置用户零变化）。
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_concurrent_runs INTEGER,
  daily_tokens INTEGER,
  monthly_cost_usd REAL,
  max_sessions INTEGER,
  max_storage_mb INTEGER,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 18,
    name: 'user_llm_credentials',
    sql: `
-- ---------- M57 P3：用户 LLM 凭据（BYOK；SecretVault 加密，密钥永不出库） ----------
-- 解析：按会话属主命中则用用户凭据（模型 / 地址可覆盖），否则系统默认；
-- 成本归因：usage.model 记实际生效模型（BYOK 模型单价）；删除账号随 users FK 级联。
CREATE TABLE IF NOT EXISTS user_llm_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url TEXT,
  model TEXT,
  secret_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`,
  },
  {
    version: 19,
    name: 'materials',
    sql: `
-- ---------- M68：用户素材库（per-user 私人素材；owner 服务端定，兼容模式为 'local'） ----------
-- 文件真相在磁盘（workspace/_library/u_<uid>/<id><ext>），行是索引（删除时调用方负责文件双清）；
-- owner_id 不设 FK（兼容模式无 users 行）：账号删除由路由显式级联 removeOf。
CREATE TABLE IF NOT EXISTS materials (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  name           TEXT NOT NULL,
  kind           TEXT NOT NULL,
  ext            TEXT NOT NULL,
  mime           TEXT,
  size_bytes     INTEGER NOT NULL,
  rel_path       TEXT NOT NULL UNIQUE,
  source         TEXT NOT NULL,
  src_session_id TEXT,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_owner ON materials(owner_id, created_at DESC);
`,
  },
  {
    version: 20,
    name: 'message_member_key',
    sql: `
-- ---------- M77：消息说话成员键（同角多魂/分身：agentId~soulId；NULL = 存量经典消息） ----------
-- 仅记录用途（气泡作者归属 / 统计 / 图谱）；agent_id 仍为基础角色 id（存量消费端零改动）。
ALTER TABLE messages ADD COLUMN member_key TEXT;
`,
  },
  {
    version: 21,
    name: 'user_inbox_and_session_reads',
    sql: `
-- ---------- M79-A：用户收件箱（跨会话个人事件的持久投递；WS 用户主题为快路径） ----------
-- 语义：仅承载「个人事件」（好友请求 / 被邀请 / 被提及 / 持球提醒 / 系统）；DM 与群聊逐条消息不入箱；
-- seq 每用户单调递增（客户端游标 / 缺口检测依据）；保留期清理仅删已读（未读恒保留）。
CREATE TABLE IF NOT EXISTS user_inbox (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  session_id TEXT,
  actor_id TEXT,
  title TEXT NOT NULL,
  body TEXT,
  payload TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_user_seq ON user_inbox(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_inbox_user_unread ON user_inbox(user_id, read_at);
-- ---------- M79-A：会话已读游标（未读服务端权威；多端同步依据） ----------
-- last_read_seq 以「消息 seq」为参照系；未读 = seq > last_read_seq 且非本人消息。
CREATE TABLE IF NOT EXISTS session_reads (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
`,
  },
  {
    version: 22,
    name: 'user_profile',
    sql: `
-- ---------- M79-B：用户画像（头衔 / 简介 / 头像；仅展示用途，零权限语义） ----------
-- avatar 为 JSON：{"kind":"color","value":"#6366f1"} | {"kind":"emoji","value":"🐼"}（NULL = 未设置）；
-- 显示名沿用 users.display_name（改由 PATCH /api/auth/profile 维护，admin 管理面亦可改）。
ALTER TABLE users ADD COLUMN headline TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
`,
  },
  {
    version: 23,
    name: 'friend_links',
    sql: `
-- ---------- M79-C：好友关系（单行双向；user_a < user_b 由应用层保证） ----------
-- 状态机：pending（requested_by 发起）→ accepted / 行删除（拒绝 / 解除）；
--         blocked（blocked_by 拉黑；隐含解除；解除拉黑 → 行删除回「无关系」）。
-- 语义：accepted 唯一判定好友；blocked 对双方呈现「无关系」（被拉黑方不可发起请求 / 私聊 / 邀请）。
CREATE TABLE IF NOT EXISTS friend_links (
  id TEXT PRIMARY KEY,
  user_a TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending','accepted','blocked')),
  requested_by TEXT NOT NULL,
  message TEXT,
  blocked_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_a, user_b)
);
CREATE INDEX IF NOT EXISTS idx_friend_links_b ON friend_links(user_b, state);
CREATE INDEX IF NOT EXISTS idx_friend_links_req ON friend_links(requested_by, created_at);
`,
  },
  {
    version: 24,
    name: 'session_kind_and_hides',
    sql: `
-- ---------- M79-D：会话社会形态（team = agent 编制协作（存量默认）；direct = 私聊；group = 群聊） ----------
-- dm_key：direct 唯一键（排序后两 userId 以 '|' 连接）——并发创建竞态由唯一索引兜底；
-- 免路由：chat 形态（direct/group）无 @agent 时不启 Run（路由层判定，零引擎改动）。
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'team';
ALTER TABLE sessions ADD COLUMN dm_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_dm ON sessions(dm_key) WHERE dm_key IS NOT NULL;
-- ---------- M79-D：会话隐藏（DM「删除」语义 = 仅从本人列表隐藏；新消息自动复现） ----------
-- 复现规则：查询侧「hidden && unreadCount == 0」才过滤（有未读即强制显示）。
CREATE TABLE IF NOT EXISTS session_hides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
`,
  },
  {
    version: 25,
    name: 'session_route_mode_and_waiting',
    sql: `
-- ---------- M79-E：触发策略与持球方（设计 §8） ----------
-- route_mode：'auto'（无 @ 消息交给平台路由组队，存量默认）/ 'mention'（仅点名唤起）；
--              chat 形态（direct/group）恒按 mention 语义（路由层判定，不落列）；
-- waiting_on：JSON string[]——被 agent 行首 @ 点名待回复的 userIds（空 = 无持球）；
--              写入于 Run 收尾（handedTo 非空）；任何目标回复即集合差清除。
ALTER TABLE sessions ADD COLUMN route_mode TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE sessions ADD COLUMN waiting_on TEXT;
-- 消息级人类定向（userIds JSON；与 agent mentions 隔离；NULL = 无）
ALTER TABLE messages ADD COLUMN human_mentions TEXT;
`,
  },
  {
    version: 26,
    name: 'notify_bus_and_presence_instances',
    sql: `
-- ---------- M79-L：多实例演进（共享通知总线 + 跨实例 presence） ----------
-- notify_bus：跨实例通知传输（仅 NOTIFY_BUS=db 写入；每实例轮询消费非本实例行）。
--   kind='session' → target=会话 id（各实例仅投给本地订阅者；本地 seq 独立分配）；
--   kind='user'    → target=userId（各实例仅投给该用户的本地连接）；
--   权威层不变（inbox / session_reads 仍在原表）——总线为快路径传输，缺口由 REST 快照补齐。
CREATE TABLE IF NOT EXISTS notify_bus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notify_bus_id ON notify_bus(id);
-- presence_instances：各实例的本用户连接计数（行心跳刷新；离线广播前合并全局计数，
--   防「A 实例断开但 B 实例仍有连接」被误判离线；stale 行按 updated_at 过期忽略并清理）。
CREATE TABLE IF NOT EXISTS presence_instances (
  instance_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  conn_count INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instance_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_presence_instances_user ON presence_instances(user_id);
`,
  },
  {
    version: 27,
    name: 'spaces',
    sql: `
-- ---------- 空间（Space）：工作生活一体的一级信息架构（docs/work-life-fusion-design.md） ----------
-- 内置三空间：default（我的，存量会话归属）/ work（工作）/ life（生活），builtin=1 不可删除；
-- kind：work / life / personal / custom（内置固定，custom 为用户自建）。
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'custom' CHECK (kind IN ('work','life','personal','custom')),
  icon TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 100,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 内置空间种子（幂等；created_at/updated_at 占位由 SpaceStore.ensureBuiltins 首启校正）
INSERT OR IGNORE INTO spaces (id, name, kind, icon, builtin, sort, created_at, updated_at) VALUES
  ('default', '我的', 'personal', 'home', 1, 0, 'builtin', 'builtin'),
  ('work', '工作', 'work', 'briefcase', 1, 1, 'builtin', 'builtin'),
  ('life', '生活', 'life', 'sparkles', 1, 2, 'builtin', 'builtin');
-- 会话归属空间（NULL / 'default' = 我的空间；存量零迁移、行为零差异；删除空间时外键置空回 default 语义）
ALTER TABLE sessions ADD COLUMN space_id TEXT REFERENCES spaces(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_space ON sessions(space_id);
`,
  },
  {
    version: 28,
    name: 'message_reactions_and_read_receipts',
    sql: `
-- ---------- M80：表情回应 + 已读对外展示开关（docs/emoji-and-readreceipt-design.md） ----------
-- message_reactions：消息表情回应（三元组唯一 = 幂等 toggle；随消息级联删除）。
--   emoji ≤6 码点（服务端 isEmojiLike 校验；库外合法序列如肤色变体放行）。
CREATE TABLE IF NOT EXISTS message_reactions (
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
-- 已读对外展示开关走 user_prefs JSON（M79 allowFriendRequests 同族先例；对等原则：关闭者其水位
--   不投影他人，也看不到他人水位；本人多端同步不受影响）——不新增 users 列。
`,
  },
  {
    version: 29,
    name: 'memory_space_domain',
    sql: `
-- ---------- P2 记忆域隔离（docs/work-life-fusion-design.md §3.2） ----------
-- memory.space_id：空间域标签（spaces.id）。写入时按来源会话解析；NULL = 跨域共享的全局记忆
-- （「我叫 X」这类用户显式共享事实）；召回默认过滤为「同空间 OR 跨域共享」。
-- 存量记忆一律 NULL（跨域共享）——零行为差异，隔离仅对新写入生效。
ALTER TABLE memory ADD COLUMN space_id TEXT;
CREATE INDEX IF NOT EXISTS idx_memory_space ON memory(space_id);
-- 去重维度并入空间域：同内容在不同空间各自成条（COALESCE 表达式索引，NULL 跨域共享条目仍互相去重）；
-- 旧唯一索引 idx_memory_unique_scoped 废弃删除（P2 起唯一性由新索引承载）。
DROP INDEX IF EXISTS idx_memory_unique_scoped;
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_unique_scoped_v2 ON memory(scope, owner_id, kind, hash, COALESCE(space_id, ''));
`,
  },
  {
    version: 30,
    name: 'space_soul_overrides',
    sql: `
-- ---------- P3 空间默认灵魂（docs/work-life-fusion-design.md §3.3） ----------
-- spaces.soul_overrides：JSON（agentId → soulId）。成员入编（创建会话 / 动态邀请）时作为默认值
-- 填充——显式选择的灵魂永远优先；分身键（agentId~soulId）灵魂内嵌不受影响；运行中换装零变化。
ALTER TABLE spaces ADD COLUMN soul_overrides TEXT;
`,
  },
  {
    version: 31,
    name: 'ritual_subscriptions',
    sql: `
-- ---------- P4：仪式订阅（docs/work-life-fusion-design.md §3.4） ----------
-- 场景 _group.yaml ritual 声明经「一键订阅」落库；调度 tick 到点新建会话并注入 opener
-- （走 PRS / 编制语义）；退订删行；按订阅者隔离（user_id；兼容模式 'local'）。
CREATE TABLE IF NOT EXISTS ritual_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  title TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  opener TEXT NOT NULL,
  members TEXT NOT NULL DEFAULT '[]',
  space_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at TEXT,
  last_run_at TEXT,
  last_session_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rituals_user ON ritual_subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_rituals_next ON ritual_subscriptions(next_run_at);
`,
  },
  {
    version: 32,
    name: 'space_owner',
    sql: `
-- ---------- P4：自建空间用户级隔离（docs/work-life-fusion-design.md §3.1 演进项） ----------
-- owner_id：多用户 userId（兼容模式 'local'）；NULL = 内置三空间 / 迁移前历史自建（保持共享，
-- 仅 admin 可改删）。列表按「内置 ∪ 本人」过滤；写操作归属校验在路由层。
ALTER TABLE spaces ADD COLUMN owner_id TEXT;
CREATE INDEX IF NOT EXISTS idx_spaces_owner ON spaces(owner_id);
`,
  },
  {
    version: 33,
    name: 'ritual_system_source',
    sql: `
-- ---------- P5：系统内置仪式（server/src/schedule/system-rituals.ts） ----------
-- ritual_id：存在 = 订阅来自系统清单（如 daily-review），去重键与场景声明的 scene_id 独立，
-- 同场景可并存「场景仪式 + 系统仪式」两类订阅。
ALTER TABLE ritual_subscriptions ADD COLUMN ritual_id TEXT;
`,
  },
  {
    version: 34,
    name: 'session_relay_mode',
    sql: `
-- ---------- M86：接力控制（会话级） ----------
-- relay_mode：auto = 成员可自动转交下一棒（团队协作现状）；manual = 仅用户点按派发才接棒。
-- NULL = 未显式设置，由 resolveRelayMode 按会话形态推导（纯人聊天 / 单助手对话 = manual）。
ALTER TABLE sessions ADD COLUMN relay_mode TEXT;
`,
  },
  {
    version: 35,
    name: 'artifact_index',
    sql: `
-- ---------- M87：交付件索引（写时登记 + 低频校准） ----------
-- 正文唯一真相仍在磁盘；本表只存元数据，供上下文摘要 / 路由去重 / 面板分页 / 增量同步使用。
CREATE TABLE IF NOT EXISTS artifacts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  dir TEXT NOT NULL DEFAULT '',
  author_agent_id TEXT,
  origin TEXT NOT NULL DEFAULT 'scan',
  delivery_class TEXT NOT NULL DEFAULT 'final',
  git_status TEXT,
  run_id TEXT,
  message_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (session_id, path)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_recent ON artifacts(session_id, deleted_at, mtime_ms DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_revision ON artifacts(session_id, revision);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(session_id, run_id);

CREATE TABLE IF NOT EXISTS artifact_index_state (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0,
  last_full_scan_at TEXT
);
`,
  },
  {
    version: 36,
    name: 'session_autonomy',
    sql: `
-- ---------- M88：自动编排策略（会话级） ----------
-- autonomy：auto = 按意图判定（规则 + PRS）；always-plan / never-plan = 用户强制。
-- NULL = auto（存量会话零差异）；plan_first 保留为兼容快捷开关。
ALTER TABLE sessions ADD COLUMN autonomy TEXT;
`,
  },
  {
    version: 37,
    name: 'message_mode_source',
    sql: `
-- ---------- M88：消息级范式来源（可审计：为什么这一棒进了规划/评审） ----------
-- user = 用户显式；rule / router = 自动判定；policy = 会话策略；NULL = 未判定（旧消息）。
ALTER TABLE messages ADD COLUMN mode_source TEXT;
`,
  },
  {
    version: 38,
    name: 'im_reliable_delivery',
    sql: `
-- 消息序号独立于存活消息，删除末条并重启后也不复用序号。
ALTER TABLE sessions ADD COLUMN message_seq INTEGER NOT NULL DEFAULT 0;
UPDATE sessions SET message_seq = COALESCE((SELECT MAX(seq) FROM messages WHERE session_id = sessions.id), 0);
ALTER TABLE messages ADD COLUMN client_message_id TEXT;
-- 接收凭据与消息原子写入；删除消息仍保留凭据，重试不会复活已删除内容。
CREATE TABLE IF NOT EXISTS message_submissions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  message_id TEXT NOT NULL,
  result TEXT,
  PRIMARY KEY (session_id, user_id, client_message_id)
);
-- 收件箱清理不能回退同步水位。
CREATE TABLE IF NOT EXISTS inbox_cursors (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL DEFAULT 0
);
INSERT INTO inbox_cursors (user_id, seq) SELECT user_id, MAX(seq) FROM user_inbox GROUP BY user_id;
`,
  },
  {
    version: 39,
    name: 'run_execution_snapshots',
    sql: `
-- 版本化执行快照：计划派发、意图与循环守卫随 Run 恢复；触发身份独立于会话属主。
ALTER TABLE runs ADD COLUMN trigger_user_id TEXT;
ALTER TABLE runs ADD COLUMN execution_state TEXT;
`,
  },
  {
    version: 40,
    name: 'im_reply_and_session_prefs',
    sql: `
-- 引用回复快照（作者 / 摘要固化，原消息删除后仍可展示）
ALTER TABLE messages ADD COLUMN reply_to TEXT;
-- 会话个人偏好（仅本人可见；不参与 ACL）
CREATE TABLE IF NOT EXISTS session_prefs (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  pinned INTEGER NOT NULL DEFAULT 0,
  muted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_prefs_user ON session_prefs(user_id, pinned);
`,
  },
  {
    version: 41,
    name: 'im_message_lifecycle',
    sql: `
-- 编辑 / 撤回：撤回清空正文与附件但保留行（锚点 / 引用墓碑 / 审计）。
ALTER TABLE messages ADD COLUMN edited_at TEXT;
ALTER TABLE messages ADD COLUMN recalled_at TEXT;
ALTER TABLE messages ADD COLUMN recalled_by TEXT;
-- 仅自己删除：个人视图隐藏，不影响其他成员与消息行。
CREATE TABLE IF NOT EXISTS message_hides (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  hidden_at TEXT NOT NULL,
  PRIMARY KEY (user_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_message_hides_session ON message_hides(session_id, user_id);
`,
  },
  {
    version: 42,
    name: 'session_prefs_archive_unread',
    sql: `
-- IM：归档与手动标记未读（个人偏好，不参与 ACL）。
ALTER TABLE session_prefs ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE session_prefs ADD COLUMN marked_unread INTEGER NOT NULL DEFAULT 0;
`,
  },
]
