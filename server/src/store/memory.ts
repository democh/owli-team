/**
 * 记忆存储（M2 L1 → M25 四层 scope）：决策 / 约束 / 术语 / 交付件 / 事实 / 偏好 / 经验。
 *
 * - 四层关联：session（会话）/ agent / project / global，bucket = `scope:ownerId`；
 * - 时间有效性（Zep 轻量版）：status = active | superseded | archived | candidate；
 * - ADD-only + 去重：同 (scope, ownerId, kind, 内容哈希) 唯一；写入即入嵌入队列（近重复合并在 worker）；
 * - FTS 由本类同步维护（与 messages_fts 同模式，无触发器；FTS5 缺失时静默降级）；
 * - vec0 镜像清理为 best-effort（扩展缺失时镜像表不存在，try/catch 忽略；memory_vectors 走 FK 级联）。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { MemoryItem, MemoryKind, MemoryScope, MemoryStatus } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import type { EmbedQueueStore } from './memory-vectors.js'

export const MEMORY_KINDS: MemoryKind[] = [
  'decision',
  'constraint',
  'glossary',
  'artifact',
  'fact',
  'preference',
  'lesson',
]

export const MEMORY_SCOPES: MemoryScope[] = ['session', 'agent', 'project', 'global']

export const MEMORY_STATUSES: MemoryStatus[] = ['active', 'superseded', 'archived', 'candidate']

const KIND_LABEL: Record<MemoryKind, string> = {
  decision: '已确认决策',
  constraint: '约束与口径',
  glossary: '术语表',
  artifact: '交付件索引',
  fact: '事实',
  preference: '偏好',
  lesson: '经验教训',
}

/** 各 kind 的渲染上限（超出按优先级丢弃：先丢术语，最后丢决策） */
const RENDER_CAP: Record<MemoryKind, number> = {
  decision: 40,
  constraint: 40,
  artifact: 40,
  glossary: 20,
  fact: 30,
  preference: 20,
  lesson: 30,
}

/** 低价值 kind 先被丢弃的顺序 */
const DROP_ORDER: MemoryKind[] = ['glossary', 'artifact', 'fact', 'lesson', 'preference', 'constraint', 'decision']

/** 渲染分区顺序（L1 与召回共用） */
const RENDER_ORDER: MemoryKind[] = ['decision', 'constraint', 'artifact', 'preference', 'lesson', 'fact', 'glossary']

/** 渲染时 kind 优先级排序（SQL CASE） */
const KIND_SORT = `CASE kind
  WHEN 'decision' THEN 0 WHEN 'constraint' THEN 1 WHEN 'artifact' THEN 2
  WHEN 'preference' THEN 3 WHEN 'lesson' THEN 4 WHEN 'fact' THEN 5 ELSE 6 END`

interface MemoryRow {
  id: string
  scope: string
  owner_id: string
  /** M57：用户维度（access 归属；global scope 即用户 id，其余 scope 从来源会话推导） */
  user_id?: string | null
  /** 空间域（spaces.id；NULL = 跨域共享全局记忆） */
  space_id?: string | null
  session_id: string | null
  kind: string
  content: string
  hash: string
  source: string | null
  importance: number
  entities: string
  status: string
  supersedes: string | null
  superseded_by: string | null
  valid_from: string
  valid_to: string | null
  source_session_id: string | null
  source_run_id: string | null
  hits: number
  last_used_at: string | null
  created_at: string
  updated_at: string
}

function hashOf(kind: MemoryKind, content: string): string {
  const normalized = content.trim().replace(/\s+/g, ' ')
  return createHash('sha1').update(`${kind}|${normalized}`).digest('hex').slice(0, 16)
}

function parseEntities(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToItem(row: MemoryRow): MemoryItem {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    scope: row.scope as MemoryScope,
    ownerId: row.owner_id,
    userId: row.user_id ?? undefined,
    spaceId: row.space_id ?? undefined,
    kind: row.kind as MemoryKind,
    content: row.content,
    source: row.source ?? undefined,
    importance: Number(row.importance),
    entities: parseEntities(row.entities),
    status: row.status as MemoryStatus,
    supersedes: row.supersedes ?? undefined,
    supersededBy: row.superseded_by ?? undefined,
    validFrom: row.valid_from,
    validTo: row.valid_to ?? undefined,
    sourceSessionId: row.source_session_id ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    hits: Number(row.hits),
    lastUsedAt: row.last_used_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 轻量实体抽取（确定性启发式，零依赖）：英文/数字词 + CJK 双字组，去重取前 32 个。
 * 用于混合评分的 entity 信号（Jaccard），不追求语言学精度。
 */
export function extractEntities(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]+/g)) out.add(m[0].toLowerCase())
  for (const run of text.match(/(?:[\u4e00-\u9fff]+)/g) ?? []) {
    if (run.length === 1) {
      out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2))
  }
  return [...out].slice(0, 32)
}

export interface MemoryUpsertExtra {
  source?: string
  importance?: number
  entities?: string[]
  /** 溯源：来源会话/来源 Run（非 session scope 记忆不落 session_id FK） */
  sourceSessionId?: string
  sourceRunId?: string
  status?: MemoryStatus
  /** M57：用户维度（多用户隔离；单用户兼容模式缺省 = NULL） */
  userId?: string
  /** 空间域（P2：显式指定；缺省时按 sourceSessionId 经 spaceOf 解析器推导；NULL = 跨域共享） */
  spaceId?: string | null
}

export interface MemoryListFilter {
  kind?: MemoryKind
  status?: MemoryStatus
  limit?: number
  /** M57：用户维度过滤（多用户隔离；缺省 = 不过滤） */
  userId?: string
  /** P2：空间域过滤（'shared' = 仅跨域共享条目；具体空间 id = 该空间 + 跨域共享） */
  spaceId?: string
}

/** M25 管理查询过滤（跨 scope 列表接口） */
export interface MemoryQueryFilter {
  scope?: MemoryScope
  ownerId?: string
  kind?: MemoryKind
  status?: MemoryStatus
  /** 内容子串匹配（LIKE %q%） */
  q?: string
  limit?: number
  offset?: number
  /** M57：用户维度过滤（多用户隔离；缺省 = 不过滤） */
  userId?: string
  /** P2：空间域过滤（'shared' = 仅跨域共享条目；具体空间 id = 该空间 + 跨域共享） */
  spaceId?: string
}

/**
 * 渲染一组记忆为文本块（L1 会话记忆与 L1.5 语义召回共用）。
 * 仅调用方保证 active；compact 时按 RENDER_ORDER 截断到高价值 kind。
 */
export function renderMemoryItems(items: MemoryItem[], compact = false): string {
  if (items.length === 0) return ''
  const grouped = new Map<MemoryKind, string[]>()
  for (const item of items) {
    const list = grouped.get(item.kind) ?? []
    list.push(item.content)
    grouped.set(item.kind, list)
  }
  const order: MemoryKind[] = compact
    ? ['decision', 'constraint', 'preference', 'lesson']
    : RENDER_ORDER
  const sections: string[] = []
  for (const kind of order) {
    const contents = grouped.get(kind)
    if (!contents || contents.length === 0) continue
    const capped = contents.slice(0, RENDER_CAP[kind])
    sections.push(`## ${KIND_LABEL[kind]}\n${capped.map((c) => `- ${c}`).join('\n')}`)
  }
  if (sections.length === 0) return ''
  return sections.join('\n')
}

export class MemoryStore {
  constructor(
    private readonly db: AppDb,
    /** M25：写入即入嵌入队列（休眠时仅积累，启用后消费）；测试/无嵌入场景可省略 */
    private readonly queue?: EmbedQueueStore,
    /** P2：空间域解析器（sourceSessionId → spaceId；缺省 = 不推导，记忆跨域共享，行为与旧版一致） */
    private readonly spaceOf?: (sessionId: string) => string | undefined,
  ) {}

  // ---------- 读取 ----------

  /** 会话（session scope）记忆清单（兼容旧接口；不筛状态，管理视图可见全部） */
  list(sessionId: string, limit = 500): MemoryItem[] {
    return this.db
      .all<MemoryRow>(
        `SELECT * FROM memory WHERE scope = 'session' AND owner_id = ?
         ORDER BY ${KIND_SORT}, created_at ASC LIMIT ?`,
        sessionId,
        limit,
      )
      .map(rowToItem)
  }

  count(sessionId: string): number {
    return this.countScoped('session', sessionId)
  }

  countScoped(
    scope: MemoryScope,
    ownerId: string,
    filter: Pick<MemoryListFilter, 'kind' | 'status' | 'userId'> = {},
  ): number {
    const where = ['scope = ?', 'owner_id = ?']
    const params: Array<string | number> = [scope, ownerId]
    if (filter.kind) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.userId) {
      where.push('user_id = ?')
      params.push(filter.userId)
    }
    return Number(
      this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM memory WHERE ${where.join(' AND ')}`, ...params)?.n ?? 0,
    )
  }

  get(id: string): MemoryItem | undefined {
    const row = this.db.get<MemoryRow>('SELECT * FROM memory WHERE id = ?', id)
    return row ? rowToItem(row) : undefined
  }

  /** 按 scope/owner 列出（管理接口与召回取行共用；M57：userId = 多用户隔离过滤） */
  listScoped(scope: MemoryScope, ownerId: string, filter: MemoryListFilter = {}): MemoryItem[] {
    const where = ['scope = ?', 'owner_id = ?']
    const params: Array<string | number> = [scope, ownerId]
    if (filter.kind) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.userId) {
      where.push('user_id = ?')
      params.push(filter.userId)
    }
    params.push(filter.limit ?? 500)
    return this.db
      .all<MemoryRow>(
        `SELECT * FROM memory WHERE ${where.join(' AND ')} ORDER BY ${KIND_SORT}, created_at ASC LIMIT ?`,
        ...params,
      )
      .map(rowToItem)
  }

  /** 按 id 批量取行（向量检索结果取回内容；M57：userId 提供时严格按用户过滤——NULL 行不返回，安全侧默认） */
  rowsByIds(ids: string[], userId?: string): MemoryItem[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    const rows = userId
      ? this.db.all<MemoryRow>(
          `SELECT * FROM memory WHERE id IN (${placeholders}) AND user_id = ?`,
          ...ids,
          userId,
        )
      : this.db.all<MemoryRow>(`SELECT * FROM memory WHERE id IN (${placeholders})`, ...ids)
    return rows.map(rowToItem)
  }

  /** 全局统计（管理接口） */
  countByScope(): Array<{ scope: string; status: string; count: number }> {
    return this.db
      .all<{ scope: string; status: string; count: number }>(
        'SELECT scope, status, COUNT(*) AS count FROM memory GROUP BY scope, status',
      )
      .map((r) => ({ scope: r.scope, status: r.status, count: Number(r.count) }))
  }

  /** M25 管理查询（跨 scope 列表；q 为内容子串匹配；按 kind 优先级 + 时间倒序） */
  query(filter: MemoryQueryFilter = {}): MemoryItem[] {
    const where: string[] = []
    const params: Array<string | number> = []
    if (filter.scope) {
      where.push('scope = ?')
      params.push(filter.scope)
    }
    if (filter.ownerId) {
      where.push('owner_id = ?')
      params.push(filter.ownerId)
    }
    if (filter.kind) {
      where.push('kind = ?')
      params.push(filter.kind)
    }
    if (filter.status) {
      where.push('status = ?')
      params.push(filter.status)
    }
    if (filter.q) {
      where.push('content LIKE ?')
      params.push(`%${filter.q}%`)
    }
    if (filter.userId) {
      where.push('user_id = ?')
      params.push(filter.userId)
    }
    // P2：空间域过滤（'shared' = 仅跨域共享；否则 = 同空间 + 跨域共享）
    if (filter.spaceId === 'shared') {
      where.push('space_id IS NULL')
    } else if (filter.spaceId) {
      where.push('(space_id = ? OR space_id IS NULL)')
      params.push(filter.spaceId)
    }
    params.push(Math.max(1, Math.min(filter.limit ?? 200, 1000)))
    const tail = filter.offset ? ' LIMIT ? OFFSET ?' : ' LIMIT ?'
    if (filter.offset) params.push(Math.max(0, filter.offset))
    return this.db
      .all<MemoryRow>(
        `SELECT * FROM memory ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY ${KIND_SORT}, created_at DESC${tail}`,
        ...params,
      )
      .map(rowToItem)
  }

  /** 命中统计（管理接口：active 总数 / 被召回过的条目数 / 累计命中次数 → 命中率） */
  hitSummary(): { active: number; hitItems: number; totalHits: number } {
    const row = this.db.get<{ active: number; hit_items: number; total_hits: number }>(
      `SELECT COUNT(*) AS active,
              COALESCE(SUM(CASE WHEN hits > 0 THEN 1 ELSE 0 END), 0) AS hit_items,
              COALESCE(SUM(hits), 0) AS total_hits
       FROM memory WHERE status = 'active'`,
    )
    return {
      active: Number(row?.active ?? 0),
      hitItems: Number(row?.hit_items ?? 0),
      totalHits: Number(row?.total_hits ?? 0),
    }
  }

  // ---------- 写入 ----------

  /** 幂等写入：内容哈希命中则返回已有条目（added=false） */
  upsert(
    sessionId: string,
    kind: MemoryKind,
    content: string,
    source?: string,
  ): { item: MemoryItem; added: boolean } | undefined {
    return this.upsertScoped('session', sessionId, kind, content, { source, sourceSessionId: sessionId })
  }

  /** M25 通用写入入口（四层 scope；写入即入嵌入队列并同步 FTS） */
  upsertScoped(
    scope: MemoryScope,
    ownerId: string,
    kind: MemoryKind,
    content: string,
    extra: MemoryUpsertExtra = {},
  ): { item: MemoryItem; added: boolean } | undefined {
    const text = content.trim()
    if (!text) return undefined
    const hash = hashOf(kind, text)
    // P2：空间域推导——显式指定优先；否则按来源会话解析；解析不到 = NULL（跨域共享全局记忆）
    const sourceSid = extra.sourceSessionId ?? (scope === 'session' ? ownerId : undefined)
    const spaceId = extra.spaceId !== undefined ? extra.spaceId : sourceSid ? (this.spaceOf?.(sourceSid) ?? null) : null
    const existing = this.db.get<MemoryRow>(
      "SELECT * FROM memory WHERE scope = ? AND owner_id = ? AND kind = ? AND hash = ? AND COALESCE(space_id, '') = COALESCE(?, '')",
      scope,
      ownerId,
      kind,
      hash,
      spaceId,
    )
    if (existing) return { item: rowToItem(existing), added: false }
    const now = new Date().toISOString()
    const row: MemoryRow = {
      id: `mem_${randomUUID().slice(0, 8)}`,
      scope,
      owner_id: ownerId,
      user_id: extra.userId ?? null,
      space_id: spaceId,
      // 仅 session scope 落 session_id（FK 级联）；agent/project/global 在源会话删除后仍存活
      session_id: scope === 'session' ? ownerId : null,
      kind,
      content: text,
      hash,
      source: extra.source ?? null,
      importance: Math.min(5, Math.max(1, Math.round(extra.importance ?? 3))),
      entities: JSON.stringify(extra.entities ?? extractEntities(text)),
      status: extra.status ?? 'active',
      supersedes: null,
      superseded_by: null,
      valid_from: now,
      valid_to: null,
      source_session_id: extra.sourceSessionId ?? null,
      source_run_id: extra.sourceRunId ?? null,
      hits: 0,
      last_used_at: null,
      created_at: now,
      updated_at: now,
    }
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO memory (id, scope, owner_id, user_id, space_id, session_id, kind, content, hash, source, importance, entities,
           status, supersedes, superseded_by, valid_from, valid_to, source_session_id, source_run_id, hits, last_used_at,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        row.id,
        row.scope,
        row.owner_id,
        row.user_id ?? null,
        row.space_id ?? null,
        row.session_id,
        row.kind,
        row.content,
        row.hash,
        row.source,
        row.importance,
        row.entities,
        row.status,
        row.supersedes,
        row.superseded_by,
        row.valid_from,
        row.valid_to,
        row.source_session_id,
        row.source_run_id,
        row.hits,
        row.last_used_at,
        row.created_at,
        row.updated_at,
      )
      this.indexFts(row.id, text)
      this.queue?.enqueue(row.id)
    })
    return { item: rowToItem(row), added: true }
  }

  /** 修改内容（重算哈希/实体，重新入队嵌入，同步 FTS） */
  patch(id: string, content: string): MemoryItem | undefined {
    const text = content.trim()
    if (!text) return undefined
    const existing = this.db.get<MemoryRow>('SELECT * FROM memory WHERE id = ?', id)
    if (!existing) return undefined
    const kind = existing.kind as MemoryKind
    this.db.tx(() => {
      this.db.run(
        'UPDATE memory SET content = ?, hash = ?, entities = ?, updated_at = ? WHERE id = ?',
        text,
        hashOf(kind, text),
        JSON.stringify(extractEntities(text)),
        new Date().toISOString(),
        id,
      )
      this.indexFts(id, text)
      this.queue?.enqueue(id)
    })
    return this.get(id)
  }

  /** 状态流转（审核候选 / 归档；管理接口）。流转回 active 时重新入队（候选审核通过需要有向量） */
  setStatus(id: string, status: MemoryStatus): MemoryItem | undefined {
    const changes = this.db.run('UPDATE memory SET status = ?, updated_at = ? WHERE id = ?', status, new Date().toISOString(), id)
      .changes
    if (changes > 0 && status === 'active') this.queue?.enqueue(id)
    return changes > 0 ? this.get(id) : undefined
  }

  /**
   * P5 前置：提升为跨域共享（空间私有 → 全局记忆；space_id 置 NULL，幂等）。
   * 权限与审计在路由层（仅条目归属者；`memory.elevate` 审计留痕）。
   */
  elevateToShared(id: string): MemoryItem | undefined {
    const changes = this.db.run('UPDATE memory SET space_id = NULL, updated_at = ? WHERE id = ?', new Date().toISOString(), id)
      .changes
    return changes > 0 ? this.get(id) : undefined
  }

  /**
   * 时间有效性替代（Zep 轻量版）：旧条目 → superseded + valid_to；新条目记 supersedes。
   * 近重复合并（worker cos ≥ 0.92）也走这里。
   */
  markSuperseded(oldId: string, newId: string): boolean {
    const now = new Date().toISOString()
    return this.db.tx(() => {
      const a = this.db.run(
        `UPDATE memory SET status = 'superseded', superseded_by = ?, valid_to = ?, updated_at = ? WHERE id = ?`,
        newId,
        now,
        now,
        oldId,
      )
      if (a.changes === 0) return false
      this.db.run('UPDATE memory SET supersedes = ?, updated_at = ? WHERE id = ?', oldId, now, newId)
      return true
    })
  }

  remove(id: string): boolean {
    return this.db.tx(() => {
      this.removeFts(id)
      this.removeVecMirror(id)
      return this.db.run('DELETE FROM memory WHERE id = ?', id).changes > 0
    })
  }

  clear(sessionId: string): void {
    this.db.tx(() => {
      this.clearFts(sessionId)
      this.clearVecMirrors(sessionId)
      this.db.run(`DELETE FROM memory WHERE scope = 'session' AND owner_id = ?`, sessionId)
    })
  }

  // ---------- 渲染 ----------

  /**
   * 渲染 L1 层文本块（仅 active）。`compact` 用于预算紧张时：截断到高价值 kind。
   */
  render(sessionId: string, compact = false): string {
    const items = this.db
      .all<MemoryRow>(
        `SELECT * FROM memory WHERE scope = 'session' AND owner_id = ? AND status = 'active'
         ORDER BY ${KIND_SORT}, created_at ASC LIMIT 500`,
        sessionId,
      )
      .map(rowToItem)
    const body = renderMemoryItems(items, compact)
    return body ? `<session_memory>\n${body}\n</session_memory>` : ''
  }

  /** 供压缩器把摘要中的结论提升为长期记忆（幂等） */
  promote(sessionId: string, kind: MemoryKind, contents: string[], source: string): number {
    let added = 0
    for (const content of contents) {
      const result = this.upsert(sessionId, kind, content, source)
      if (result?.added) added++
    }
    return added
  }

  /** 召回命中回写（hits / last_used_at，供 recency 评分与统计） */
  updateHitStats(ids: string[]): void {
    if (ids.length === 0) return
    const now = new Date().toISOString()
    this.db.tx(() => {
      for (const id of ids) {
        this.db.run('UPDATE memory SET hits = hits + 1, last_used_at = ? WHERE id = ?', now, id)
      }
    })
  }

  // ---------- 全文检索（trigram；FTS5 缺失时静默降级） ----------

  /** 全文检索 id（trigram phrase 优先，<3 字符或 FTS 缺失走 LIKE） */
  searchIds(query: string, limit = 100): string[] {
    const q = query.trim()
    if (!q) return []
    const likeRows = () =>
      this.db.all<{ id: string }>('SELECT id FROM memory WHERE content LIKE ? LIMIT ?', `%${q}%`, limit).map((r) => r.id)
    if ([...q].length < 3) return likeRows()
    try {
      const phrase = `"${q.replace(/"/g, '""')}"`
      return this.db
        .all<{ memory_id: string }>(
          'SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT ?',
          phrase,
          limit,
        )
        .map((r) => r.memory_id)
    } catch {
      return likeRows()
    }
  }

  private indexFts(id: string, content: string): void {
    try {
      this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', id)
      this.db.run('INSERT INTO memory_fts (content, memory_id) VALUES (?, ?)', content, id)
    } catch {
      // FTS5 缺失：keyword 检索能力不可用，但不影响主流程
    }
  }

  private removeFts(id: string): void {
    try {
      this.db.run('DELETE FROM memory_fts WHERE memory_id = ?', id)
    } catch {
      // 同上
    }
  }

  private clearFts(sessionId: string): void {
    try {
      this.db.run(
        'DELETE FROM memory_fts WHERE memory_id IN (SELECT id FROM memory WHERE scope = ? AND owner_id = ?)',
        'session',
        sessionId,
      )
    } catch {
      // 同上
    }
  }

  // ---------- vec0 镜像 best-effort（扩展缺失时表不存在） ----------

  private removeVecMirror(id: string): void {
    try {
      this.db.run('DELETE FROM memory_vec_index WHERE memory_id = ?', id)
    } catch {
      // 扩展未加载：镜像表不存在，BLOB 规范副本走 FK 级联
    }
  }

  private clearVecMirrors(sessionId: string): void {
    try {
      this.db.run(
        'DELETE FROM memory_vec_index WHERE memory_id IN (SELECT id FROM memory WHERE scope = ? AND owner_id = ?)',
        'session',
        sessionId,
      )
    } catch {
      // 同上
    }
  }
}

/** 丢弃顺序（测试与预算裁剪共享） */
export function memoryDropOrder(): MemoryKind[] {
  return [...DROP_ORDER]
}
