/**
 * 会话与消息存储（M1：SQLite 落库）。
 *
 * 结构：**内存缓存为读写入口 + SQLite 为真相**。
 * - 引擎在流式期间就地修改消息对象（`message.content += delta`），因此 `messages()` 仍返回活引用；
 * - 脏标记精确到消息：`touch(sessionId, messageId)`，防抖 250ms 内只写变更行（不再全量重写文件）；
 * - 关键节点（创建会话 / Run 结束 / 列表查询）立即 flush。
 */
import { randomUUID } from 'node:crypto'
import type { ChatMessage, MessageAttachment, MessageStatus, Session, SessionAccessRole, SessionSummary, ToolCallRecord } from '@multi-agent/shared'
import { getLogger } from '../logger.js'
import type { AppDb } from './db.js'

export interface StoredSession {
  session: Session
  messages: ChatMessage[]
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`
}

export function nowIso(): string {
  return new Date().toISOString()
}

interface SessionRow {
  id: string
  project_id: string | null
  title: string
  participant_ids: string
  /** M16：会话级灵魂覆盖（agentId → soulId 的 JSON；'{}' = 全默认） */
  member_souls: string
  /** M24：规划先行开关（0/1） */
  plan_first?: number
  /** M46-2：串行执行开关（0/1；1 = 波次逐位出场） */
  serial?: number
  /** M57：会话属主（users.id；NULL = 单用户兼容模式历史数据） */
  owner_id?: string | null
  workspace_dir: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

interface MessageRow {
  id: string
  session_id: string
  run_id: string | null
  turn_index: number
  seq: number
  role: string
  agent_id: string | null
  /** M77：说话成员键（分身实例；存量消息为 NULL） */
  member_key: string | null
  content: string
  mentions: string
  status: string
  artifacts: string
  tool_calls: string | null
  reasoning: string | null
  /** M24：消息范式标记（plan / review；NULL = 执行） */
  mode: string | null
  /** M33：消息附件（MessageAttachment[] JSON；NULL = 无附件） */
  attachments: string | null
  /** M35：定时任务触发注入的消息挂任务 id（NULL = 普通消息） */
  schedule_id: string | null
  /** M57：人类消息作者（users.id；agent / system 消息为空） */
  user_id?: string | null
  created_at: string
}

interface SummaryRow {
  message_count: number
  last_role: string | null
  last_agent_id: string | null
  /** M77：最后一条消息的说话成员键（列表预览署名；历史 / 存量行为 NULL） */
  last_member_key: string | null
  last_content: string | null
  last_created_at: string | null
  /** M57 P3：最后一条人类消息的作者（列表预览署名；历史 / 兼容模式为 NULL） */
  last_user_id: string | null
  last_user_name: string | null
}

/** 列表查询行（list / listForUser 共用；access_role 仅 listForUser 携带） */
type SummaryRowFull = SessionRow & SummaryRow & { access_role?: string | null }

interface Entry {
  session: Session
  messages: ChatMessage[]
  /** 本会话消息最大 seq（压缩水位依据） */
  seq: number
  dirty: Set<string>
  metaDirty: boolean
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToSession(row: SessionRow): Session {
  const memberSouls = parseJson<Record<string, string>>(row.member_souls ?? '{}', {})
  return {
    id: row.id,
    title: row.title,
    participantIds: parseJson<string[]>(row.participant_ids, []),
    ownerId: row.owner_id ?? undefined,
    memberSouls: Object.keys(memberSouls).length > 0 ? memberSouls : undefined,
    planFirst: row.plan_first ? true : undefined,
    serial: row.serial ? true : undefined,
    projectId: row.project_id ?? undefined,
    workspaceDir: row.workspace_dir ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    turnIndex: row.turn_index,
    seq: row.seq,
    role: row.role as ChatMessage['role'],
    agentId: row.agent_id ?? undefined,
    memberKey: row.member_key ?? undefined,
    content: row.content,
    mentions: parseJson<string[]>(row.mentions, []),
    status: row.status as MessageStatus,
    artifacts: parseJson<string[] | undefined>(row.artifacts, undefined) as string[] | undefined,
    toolCalls: parseJson<ToolCallRecord[] | undefined>(row.tool_calls, undefined) as ToolCallRecord[] | undefined,
    reasoning: row.reasoning ?? undefined,
    mode: (row.mode as ChatMessage['mode']) ?? undefined,
    attachments: parseJson<MessageAttachment[] | undefined>(row.attachments, undefined),
    scheduleId: row.schedule_id ?? undefined,
    userId: row.user_id ?? undefined,
    createdAt: row.created_at,
  }
}

export class SessionStore {
  private cache = new Map<string, Entry>()
  private timers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly db: AppDb) {
    this.recoverInterrupted()
  }

  /** 启动恢复：上次进程中断留下的 streaming 消息 → stopped（§8.3） */
  private recoverInterrupted(): void {
    const rows = this.db.all<{ id: string }>(`SELECT id FROM messages WHERE status = 'streaming'`)
    if (rows.length === 0) return
    this.db.run(`UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`)
  }

  // ---------- 读取 ----------

  private entry(id: string): Entry | undefined {
    const cached = this.cache.get(id)
    if (cached) return cached
    const row = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id)
    if (!row) return undefined
    const messages = this.db
      .all<MessageRow>('SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC', id)
      .map(rowToMessage)
    const entry: Entry = {
      session: rowToSession(row),
      messages,
      seq: messages.length > 0 ? (messages[messages.length - 1].seq ?? 0) : 0,
      dirty: new Set(),
      metaDirty: false,
    }
    this.cache.set(id, entry)
    return entry
  }

  /**
   * 会话列表（M57：ownerId 必传——用户 id = 仅本人；null = 系统全量（单用户兼容 / 内部引用统计用））。
   * 参数必传是刻意的：编译期强制每个调用点声明隔离意图，防漏加归属过滤。
   * M57 P2：本方法保持「仅本人」语义（管理 / 统计用）；多用户列表走 listForUser（本人 + 共享）。
   */
  list(ownerId: string | null): SessionSummary[] {
    this.flushAll()
    const ownerFilter = ownerId === null ? '' : 'AND s.owner_id = ?'
    const ownerParams = ownerId === null ? [] : [ownerId]
    const rows = this.db.all<SummaryRowFull>(
      `SELECT s.*,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count,
              lm.role AS last_role, lm.agent_id AS last_agent_id, lm.member_key AS last_member_key,
              lm.content AS last_content, lm.created_at AS last_created_at,
              lm.user_id AS last_user_id,
              (SELECT u.display_name FROM users u WHERE u.id = lm.user_id) AS last_user_name
       FROM sessions s
       LEFT JOIN messages lm ON lm.session_id = s.id AND lm.seq = (
         SELECT MAX(m2.seq) FROM messages m2 WHERE m2.session_id = s.id
       )
       WHERE s.deleted_at IS NULL ${ownerFilter}
       ORDER BY s.updated_at DESC`,
      ...ownerParams,
    )
    return rows.map((row) => this.summarize(row))
  }

  /**
   * M57 P2：用户可见会话列表（本人 + 共享给我），逐行标注 role（owner / editor / viewer）。
   * 单用户兼容模式（无账号体系）走 list(null)。
   */
  listForUser(userId: string): SessionSummary[] {
    this.flushAll()
    const rows = this.db.all<SummaryRowFull>(
      `SELECT s.*,
              CASE WHEN s.owner_id = ? THEN 'owner' ELSE m.role END AS access_role,
              (SELECT COUNT(*) FROM messages m2 WHERE m2.session_id = s.id) AS message_count,
              lm.role AS last_role, lm.agent_id AS last_agent_id, lm.member_key AS last_member_key,
              lm.content AS last_content, lm.created_at AS last_created_at,
              lm.user_id AS last_user_id,
              (SELECT u.display_name FROM users u WHERE u.id = lm.user_id) AS last_user_name
       FROM sessions s
       LEFT JOIN session_members m ON m.session_id = s.id AND m.user_id = ?
       LEFT JOIN messages lm ON lm.session_id = s.id AND lm.seq = (
         SELECT MAX(m3.seq) FROM messages m3 WHERE m3.session_id = s.id
       )
       WHERE s.deleted_at IS NULL AND (s.owner_id = ? OR m.user_id IS NOT NULL)
       ORDER BY s.updated_at DESC`,
      userId,
      userId,
      userId,
    )
    return rows.map((row) => this.summarize(row))
  }

  /**
   * M57 P3：用户会话数（不含已删除；配额校验用——直查库避免 list 的消息聚合开销）。
   */
  countForUser(userId: string): number {
    this.flushAll()
    const row = this.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sessions WHERE owner_id = ? AND deleted_at IS NULL',
      userId,
    )
    return Number(row?.n ?? 0)
  }

  /** 列表行投影（list / listForUser 共用；access_role 仅 listForUser 查询携带） */
  private summarize(row: SummaryRowFull): SessionSummary {
    return {
      ...rowToSession(row),
      messageCount: Number(row.message_count ?? 0),
      ...(row.access_role ? { role: row.access_role as SessionAccessRole } : {}),
      lastMessage: row.last_role
        ? {
            role: row.last_role as 'user' | 'agent' | 'system',
            agentId: row.last_agent_id ?? undefined,
            // M77：说话成员键（分身实例署名；存量行为 NULL → 前端按角色名回退）
            ...(row.last_member_key ? { memberKey: row.last_member_key } : {}),
            content: (row.last_content ?? '').slice(0, 80),
            createdAt: row.last_created_at ?? '',
            // M57 P2/P3：人类消息作者（共享会话列表预览署名；兼容模式缺省）
            ...(row.last_user_id ? { userId: row.last_user_id, userName: row.last_user_name ?? undefined } : {}),
          }
        : undefined,
    }
  }

  get(id: string): StoredSession | undefined {
    const entry = this.entry(id)
    return entry ? { session: entry.session, messages: entry.messages } : undefined
  }

  getSession(id: string): Session | undefined {
    return this.entry(id)?.session
  }

  /** 活引用：引擎在流式期间就地修改消息对象 */
  messages(id: string): ChatMessage[] {
    return this.entry(id)?.messages ?? []
  }

  messageById(sessionId: string, messageId: string): ChatMessage | undefined {
    return this.entry(sessionId)?.messages.find((m) => m.id === messageId)
  }

  countMessages(id: string): number {
    return this.entry(id)?.messages.length ?? 0
  }

  /** 压缩水位之后的全部消息（摘要生成依据） */
  messagesAfter(id: string, seqExclusive: number): ChatMessage[] {
    return this.messages(id).filter((m) => (m.seq ?? 0) > seqExclusive)
  }

  oldestSeq(id: string): number {
    const msgs = this.messages(id)
    return msgs.length > 0 ? (msgs[0].seq ?? 0) : 0
  }

  // ---------- 写入 ----------

  create(
    participantIds: string[],
    title?: string,
    opts: {
      projectId?: string
      workspaceDir?: string
      souls?: Record<string, string>
      planFirst?: boolean
      /** M46-2：串行执行（缺省开启；显式 false 关闭以启用并行成波） */
      serial?: boolean
      /** M57：会话属主（多用户）；缺省 = 单用户兼容模式（NULL） */
      ownerId?: string
    } = {},
  ): Session {
    const ts = nowIso()
    const session: Session = {
      id: newId('s'),
      title: title?.trim() || '新会话',
      participantIds: [...new Set(participantIds)],
      ownerId: opts.ownerId,
      memberSouls: opts.souls && Object.keys(opts.souls).length > 0 ? { ...opts.souls } : undefined,
      planFirst: opts.planFirst ? true : undefined,
      // M46-2：默认串行（逐位出场，便于跟进查看）；显式 serial: false 才关闭
      serial: opts.serial === false ? undefined : true,
      projectId: opts.projectId,
      workspaceDir: opts.workspaceDir,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.run(
      `INSERT INTO sessions (id, project_id, title, participant_ids, member_souls, workspace_dir, plan_first, serial, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.projectId ?? null,
      session.title,
      JSON.stringify(session.participantIds),
      JSON.stringify(session.memberSouls ?? {}),
      session.workspaceDir ?? null,
      session.planFirst ? 1 : 0,
      session.serial ? 1 : 0,
      session.ownerId ?? null,
      ts,
      ts,
    )
    this.cache.set(session.id, { session, messages: [], seq: 0, dirty: new Set(), metaDirty: false })
    return session
  }

  rename(id: string, title: string): Session | undefined {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.session.title = title.trim()
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(id)
    return entry.session
  }

  setWorkspace(id: string, workspaceDir: string): void {
    const entry = this.entry(id)
    if (!entry) return
    entry.session.workspaceDir = workspaceDir
    entry.metaDirty = true
    this.scheduleSave(id)
  }

  setProject(id: string, projectId: string | undefined): void {
    const entry = this.entry(id)
    if (!entry) return
    entry.session.projectId = projectId
    entry.metaDirty = true
    this.scheduleSave(id)
  }

  setParticipants(id: string, participantIds: string[]): Session | undefined {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.session.participantIds = [...new Set(participantIds)]
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(id)
    return entry.session
  }

  /** M16：会话级灵魂覆盖全量写入（agentId → soulId；空 = 全部恢复角色默认） */
  setMemberSouls(id: string, souls: Record<string, string>): Session | undefined {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.session.memberSouls = Object.keys(souls).length > 0 ? { ...souls } : undefined
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(id)
    return entry.session
  }

  /** M24：规划先行开关（会话级持续开关；首波默认进入 plan 范式） */
  setPlanFirst(id: string, planFirst: boolean): Session | undefined {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.session.planFirst = planFirst ? true : undefined
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(id)
    return entry.session
  }

  /** M46-2：串行执行开关（会话级持续开关；开启后波次逐位出场，关闭后场景可并行成波） */
  setSerial(id: string, serial: boolean): Session | undefined {
    const entry = this.entry(id)
    if (!entry) return undefined
    entry.session.serial = serial ? true : undefined
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(id)
    return entry.session
  }

  remove(id: string): boolean {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    this.cache.delete(id)
    const result = this.db.run('DELETE FROM sessions WHERE id = ?', id)
    return result.changes > 0
  }

  appendMessage(
    partial: Omit<ChatMessage, 'id' | 'createdAt'> & Partial<Pick<ChatMessage, 'id' | 'createdAt'>>,
  ): ChatMessage {
    const entry = this.entry(partial.sessionId)
    if (!entry) throw new Error('会话不存在')
    const message: ChatMessage = {
      ...partial,
      id: partial.id ?? newId('m'),
      seq: entry.seq + 1,
      // 约定：用户与系统消息不占用波次序号（-1），Agent 消息缺省为 0（引擎显式传入真实波次号）
      turnIndex: partial.turnIndex ?? (partial.role === 'user' || partial.role === 'system' ? -1 : 0),
      createdAt: partial.createdAt ?? nowIso(),
    }
    entry.seq = message.seq!
    entry.messages.push(message)
    entry.session.updatedAt = nowIso()
    // 首条用户消息自动命名
    if (partial.role === 'user' && entry.session.title === '新会话') {
      const text = partial.content.trim().replace(/\s+/g, ' ')
      // M33：纯附件消息（无文本）用首个附件名命名
      const label = text || partial.attachments?.[0]?.name || '附件'
      entry.session.title = `${label.slice(0, 20)}${label.length > 20 ? '…' : ''}`
      entry.metaDirty = true
    }
    this.insertMessage(message)
    this.indexFts(message)
    this.scheduleSave(partial.sessionId)
    return message
  }

  patchMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): ChatMessage | undefined {
    const entry = this.entry(sessionId)
    if (!entry) return undefined
    const message = entry.messages.find((m) => m.id === messageId)
    if (!message) return undefined
    Object.assign(message, patch)
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    entry.dirty.add(messageId)
    this.scheduleSave(sessionId)
    return message
  }

  clearMentions(sessionId: string, messageId: string): void {
    this.patchMessage(sessionId, messageId, { mentions: [] })
  }

  /** M8：删除单条消息（内存 + 主表 + FTS；seq 水位不回退，避免旧消息复用号段） */
  deleteMessage(sessionId: string, messageId: string): boolean {
    const entry = this.entry(sessionId)
    if (!entry) return false
    const idx = entry.messages.findIndex((m) => m.id === messageId)
    if (idx === -1) return false
    entry.messages.splice(idx, 1)
    entry.dirty.delete(messageId)
    this.db.run('DELETE FROM messages WHERE id = ?', messageId)
    try {
      this.db.run('DELETE FROM messages_fts WHERE message_id = ?', messageId)
    } catch {
      // FTS5 缺失：忽略
    }
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    this.scheduleSave(sessionId)
    return true
  }

  /** 标记会话脏；带 messageId 时精确到该消息（替代早期的「整会话重写」） */
  touch(sessionId: string, messageId?: string): void {
    const entry = this.entry(sessionId)
    if (!entry) return
    entry.session.updatedAt = nowIso()
    entry.metaDirty = true
    if (messageId) entry.dirty.add(messageId)
    this.scheduleSave(sessionId)
  }

  scheduleSave(id: string): void {
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        // 审核 M-1：定时器回调中的落库失败不能成为 uncaught exception（脏数据保留，等待下次触发重试）
        try {
          this.flush(id)
        } catch (err) {
          getLogger().error({ sessionId: id, err }, '会话落库失败（脏数据已保留，等待下次重试）')
        }
      }, 250),
    )
  }

  saveNow(id: string): void {
    const timer = this.timers.get(id)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(id)
    }
    this.flush(id)
  }

  flushAll(): void {
    // 审核 M-1：单会话落库失败不阻断其余会话（close / 列表查询等批量路径）
    for (const id of [...this.cache.keys()]) {
      try {
        this.flush(id)
      } catch (err) {
        getLogger().error({ sessionId: id, err }, '会话落库失败（脏数据已保留，等待下次重试）')
      }
    }
  }

  close(): void {
    this.flushAll()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * M57：外部批量改写（如首启归属回填）后清空内存缓存与定时器。
   * 调用方须保证已先 flushAll（否则未落盘的脏数据会丢失）；清空后下一次读取从库重建。
   */
  invalidateCache(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.cache.clear()
  }

  // ---------- 内部：落库 ----------

  private flush(id: string): void {
    const entry = this.cache.get(id)
    if (!entry) return
    if (!entry.metaDirty && entry.dirty.size === 0) return
    const session = entry.session
    const dirtyMessages = entry.dirty.size
      ? entry.messages.filter((m) => entry.dirty.has(m.id!))
      : []
    // 审核 M-1：先落库成功再清脏标记（tx 失败时脏数据保留，避免静默丢写；下次触发重试）
    this.db.tx(() => {
      this.db.run(
        `UPDATE sessions SET title = ?, participant_ids = ?, member_souls = ?, project_id = ?, workspace_dir = ?, plan_first = ?, serial = ?, owner_id = ?, updated_at = ?
         WHERE id = ?`,
        session.title,
        JSON.stringify(session.participantIds),
        JSON.stringify(session.memberSouls ?? {}),
        session.projectId ?? null,
        session.workspaceDir ?? null,
        session.planFirst ? 1 : 0,
        session.serial ? 1 : 0,
        session.ownerId ?? null,
        session.updatedAt,
        session.id,
      )
      for (const message of dirtyMessages) this.upsertMessage(message)
    })
    entry.dirty.clear()
    entry.metaDirty = false
    for (const message of dirtyMessages) this.indexFts(message)
  }

  private insertMessage(message: ChatMessage): void {
    this.db.run(
      `INSERT INTO messages (id, session_id, run_id, turn_index, seq, role, agent_id, member_key, user_id, content, mentions, status, artifacts, tool_calls, reasoning, mode, attachments, schedule_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         turn_index = excluded.turn_index,
         content = excluded.content, mentions = excluded.mentions, status = excluded.status,
         artifacts = excluded.artifacts, tool_calls = excluded.tool_calls, reasoning = excluded.reasoning, mode = excluded.mode,
         attachments = excluded.attachments, schedule_id = excluded.schedule_id, user_id = excluded.user_id`,
      message.id,
      message.sessionId,
      message.runId ?? null,
      message.turnIndex ?? 0,
      message.seq ?? 0,
      message.role,
      message.agentId ?? null,
      message.memberKey ?? null,
      message.userId ?? null,
      message.content,
      JSON.stringify(message.mentions ?? []),
      message.status,
      JSON.stringify(message.artifacts ?? null),
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.reasoning ?? null,
      message.mode ?? null,
      message.attachments && message.attachments.length > 0 ? JSON.stringify(message.attachments) : null,
      message.scheduleId ?? null,
      message.createdAt,
    )
  }

  private upsertMessage(message: ChatMessage): void {
    this.insertMessage(message)
  }

  /** 全文索引（FTS5 不可用时静默跳过） */
  private indexFts(message: ChatMessage): void {
    if (!message.id) return
    try {
      this.db.run('DELETE FROM messages_fts WHERE message_id = ?', message.id)
      this.db.run('INSERT INTO messages_fts (content, message_id, session_id) VALUES (?, ?, ?)', message.content, message.id, message.sessionId)
    } catch {
      // FTS5 缺失：检索能力不可用，但不影响主流程
    }
  }

  /**
   * 跨会话全文检索（M9；trigram FTS + LIKE 回退）。
   * - M57：ownerId 必传——用户 id = 仅检索本人会话；null = 全量（单用户兼容）。
   * - trigram 分词器需 ≥3 字符：短词（如两字中文词）走 LIKE 子串匹配；
   * - FTS5 缺失（旧构建）或语法异常 → LIKE 回退，检索永不报错。
   */
  search(query: string, limit = 50, ownerId: string | null = null): Array<{ sessionId: string; messageId: string; content: string }> {
    const q = query.trim()
    if (!q) return []
    // M57 P2：access 口径 = 自己 + 共享给我（ownerId 语义升级为“当前用户”；null = 不过滤）
    const ownerClause =
      ownerId === null
        ? ''
        : `AND session_id IN (
             SELECT s.id FROM sessions s
             LEFT JOIN session_members m ON m.session_id = s.id AND m.user_id = ?
             WHERE s.owner_id = ? OR m.user_id IS NOT NULL
           )`
    const ownerParams = ownerId === null ? [] : [ownerId, ownerId]
    const likeRows = (): Array<{ sessionId: string; messageId: string; content: string }> =>
      this.db
        .all<{ session_id: string; message_id: string; content: string }>(
          `SELECT session_id, id AS message_id, content FROM messages
           WHERE content LIKE ? ${ownerClause} ORDER BY created_at DESC LIMIT ?`,
          `%${q}%`,
          ...ownerParams,
          limit,
        )
        .map((r) => ({ sessionId: r.session_id, messageId: r.message_id, content: r.content }))
    if ([...q].length < 3) return likeRows()
    try {
      const phrase = `"${q.replace(/"/g, '""')}"`
      return this.db
        .all<{ session_id: string; message_id: string; content: string }>(
          `SELECT session_id, message_id, content FROM messages_fts
           WHERE messages_fts MATCH ? ${ownerClause} ORDER BY rank LIMIT ?`,
          phrase,
          ...ownerParams,
          limit,
        )
        .map((r) => ({ sessionId: r.session_id, messageId: r.message_id, content: r.content }))
    } catch {
      return likeRows()
    }
  }
}

export type { MessageStatus }
