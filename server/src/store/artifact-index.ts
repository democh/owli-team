/**
 * 交付件索引（M87）：把「工作区有哪些产物」从每次全量扫盘收敛为「写时登记 + 低频校准」。
 *
 * 设计要点：
 * - 正文唯一真相仍在磁盘；本表只存元数据（kind / size / mtime / 作者 / 归属 / 分层）；
 * - 写路径一律 write-through（工具落地 / 上传 / 画布素材 / 媒体产物），扫描只用于会话首次访问
 *   与面板显式刷新时的校准，且受条目数与时间预算约束；
 * - 会话内 `revision` 单调递增：列表 / 增量 / ETag 共用同一版本号，扫描无变化不推进；
 * - repo / worktree 模式不遍历仓库，改由注入的 changedArtifacts 提供 git 变更集（与交付件语义一致）；
 * - 软删保留墓碑（deleted_at），供 `changes(since)` 增量同步删除事件。
 */
import fsp from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import type { Artifact, ArtifactKind, ArtifactOrigin, DeliveryClass } from '@multi-agent/shared'
import { classifyKind, type ArtifactStore } from './artifacts.js'
import type { AppDb } from './db.js'

/** 校准扫描预算：超出后截断（面板仍可用，后续刷新继续收敛） */
const SCAN_MAX_ENTRIES = 3_000
const SCAN_BUDGET_MS = 300
/** 校准新鲜期：面板打开时的自动校准间隔 */
const SCAN_TTL_MS = 10 * 60_000
/** 扫描失败后的退避窗口（防坏盘 / 权限问题导致每次请求重试） */
const SCAN_RETRY_MS = 30_000
/** 单次列表 / 增量硬上限 */
const LIST_MAX = 2_000
const CHANGES_MAX = 500
/** 过程产物目录（路径首段命中即判过程产物；金融快照与通用中间态） */
const PROCESS_DIRS = new Set(['charts', 'data', 'raw', 'cache', 'tmp', 'temp', 'logs'])

export interface ArtifactIndexInput {
  /** 工作区相对路径 */
  path: string
  size?: number
  mtimeMs?: number
  kind?: ArtifactKind
  authorAgentId?: string
  origin?: ArtifactOrigin
  runId?: string
  messageId?: string
  gitStatus?: string
  version?: number
}

export interface ArtifactEntry extends Artifact {
  dir: string
  deliveryClass: DeliveryClass
  origin: ArtifactOrigin
  runId?: string
  messageId?: string
  version: number
  revision: number
  firstSeenAt: string
}

export interface ArtifactChanges {
  revision: number
  upserts: ArtifactEntry[]
  deletes: string[]
}

interface ArtifactRow {
  session_id: string
  path: string
  kind: string
  size: number
  mtime_ms: number
  dir: string
  author_agent_id: string | null
  origin: string
  delivery_class: string
  git_status: string | null
  run_id: string | null
  message_id: string | null
  version: number
  revision: number
  first_seen_at: string
  updated_at: string
  deleted_at: string | null
}

interface IndexStateRow {
  revision: number
  last_full_scan_at: string | null
}

/**
 * 分层判定（服务端单点）：uploads/ = 附件，canvas/ = 媒体素材，过程目录 = 过程产物，其余 = 结论性交付。
 * 路径约定优先于来源（历史数据 / 外部投放同样能正确归层）。
 */
function deliveryClassOf(relPath: string): DeliveryClass {
  const first = relPath.split('/')[0] ?? ''
  if (first === 'uploads') return 'attachment'
  if (first === 'canvas') return 'media'
  if (PROCESS_DIRS.has(first)) return 'process'
  return 'final'
}

/** 工作区相对路径归一（POSIX 分隔；拒绝绝对路径与 .. 逃逸） */
export function normalizeRelPath(value: string): string | undefined {
  const rel = value
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return undefined
  return rel
}

function rowToEntry(row: ArtifactRow): ArtifactEntry {
  return {
    path: row.path,
    size: Number(row.size),
    mtime: Number(row.mtime_ms),
    kind: row.kind as ArtifactKind,
    ...(row.author_agent_id ? { authorAgentId: row.author_agent_id } : {}),
    updatedAt: row.updated_at,
    ...(row.git_status ? { gitStatus: row.git_status } : {}),
    origin: row.origin as ArtifactOrigin,
    deliveryClass: row.delivery_class as DeliveryClass,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.message_id ? { messageId: row.message_id } : {}),
    version: Number(row.version),
    revision: Number(row.revision),
    firstSeenAt: row.first_seen_at,
    dir: row.dir,
  }
}

/**
 * 交付件索引存储。`artifacts` 仅用于工作区根解析与路径安全；`changedArtifacts` 提供 git 变更集
 * （返回 null = 非 git 模式，走文件校准）。
 */
export class ArtifactIndex {
  /** 在途校准（同会话并发只跑一次） */
  private scans = new Map<string, Promise<void>>()
  /** 最近一次校准失败时刻（退避窗口） */
  private failedAt = new Map<string, number>()

  constructor(
    private readonly db: AppDb,
    private readonly artifacts: ArtifactStore,
    private readonly opts: {
      changedArtifacts?: (sessionId: string) => Promise<Artifact[] | null>
      scanMaxEntries?: number
      scanBudgetMs?: number
      ttlMs?: number
    } = {},
  ) {}

  // ---------- 写路径：登记 / 删除 ----------

  /**
   * 批量登记（一次事务、一次 revision 推进）。未提供 size/mtime 时读磁盘；
   * 磁盘不存在的路径静默跳过（工具声明与实际落盘不一致时不制造幽灵条目）。
   */
  upsert(sessionId: string, inputs: ArtifactIndexInput[]): { revision: number; entries: ArtifactEntry[] } {
    const now = new Date().toISOString()
    const prepared: ArtifactEntry[] = []
    const seen = new Set<string>()
    for (const input of inputs) {
      const relPath = normalizeRelPath(input.path)
      if (!relPath || seen.has(relPath)) continue
      seen.add(relPath)
      const existing = this.rowOf(sessionId, relPath)
      let size = input.size
      let mtimeMs = input.mtimeMs
      if (size === undefined || mtimeMs === undefined) {
        try {
          const stat = fs.statSync(this.artifacts.resolveSafe(sessionId, relPath))
          if (!stat.isFile()) continue
          size = size ?? stat.size
          mtimeMs = mtimeMs ?? stat.mtimeMs
        } catch {
          continue
        }
      }
      const origin = (input.origin ?? existing?.origin ?? 'scan') as ArtifactOrigin
      const deliveryClass = deliveryClassOf(relPath)
      const version = input.version ?? (existing ? Number(existing.version) : 1)
      // mtime 入库取整（stat 浮点亚毫秒值会让“重复登记”误判为新变更）
      const mtimeRounded = Math.round(mtimeMs)
      // 元数据未变化则不推进 revision（校准 / 重复声明零噪声）
      if (
        existing &&
        !existing.deleted_at &&
        Number(existing.size) === size &&
        Number(existing.mtime_ms) === mtimeRounded &&
        existing.kind === classifyKind(relPath) &&
        existing.delivery_class === deliveryClass &&
        Number(existing.version) === version &&
        (input.authorAgentId === undefined || existing.author_agent_id === input.authorAgentId) &&
        (input.runId === undefined || existing.run_id === input.runId) &&
        (input.messageId === undefined || existing.message_id === input.messageId)
      ) {
        continue
      }
      prepared.push({
        path: relPath,
        size,
        mtime: mtimeRounded,
        kind: input.kind ?? classifyKind(relPath),
        authorAgentId: input.authorAgentId ?? existing?.author_agent_id ?? undefined,
        updatedAt: now,
        origin,
        deliveryClass,
        ...((input.runId ?? existing?.run_id) ? { runId: input.runId ?? existing?.run_id ?? undefined } : {}),
        ...((input.messageId ?? existing?.message_id)
          ? { messageId: input.messageId ?? existing?.message_id ?? undefined }
          : {}),
        ...(input.gitStatus ? { gitStatus: input.gitStatus } : {}),
        version,
        revision: 0,
        firstSeenAt: existing?.first_seen_at ?? now,
        dir: relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '',
      })
    }
    if (prepared.length === 0) return { revision: this.stateOf(sessionId)?.revision ?? 0, entries: [] }

    const revision = this.db.tx(() => {
      const rev = this.bumpRevision(sessionId)
      for (const entry of prepared) {
        entry.revision = rev
        this.db.run(
          `INSERT INTO artifacts (
             session_id, path, kind, size, mtime_ms, dir, author_agent_id, origin, delivery_class, git_status,
             run_id, message_id, version, revision, first_seen_at, updated_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(session_id, path) DO UPDATE SET
             kind = excluded.kind,
             size = excluded.size,
             mtime_ms = excluded.mtime_ms,
             dir = excluded.dir,
             author_agent_id = excluded.author_agent_id,
             origin = excluded.origin,
             delivery_class = excluded.delivery_class,
             git_status = excluded.git_status,
             run_id = excluded.run_id,
             message_id = excluded.message_id,
             version = excluded.version,
             revision = excluded.revision,
             updated_at = excluded.updated_at,
             deleted_at = NULL`,
          sessionId,
          entry.path,
          entry.kind,
          entry.size,
          Math.round(entry.mtime),
          entry.dir,
          entry.authorAgentId ?? null,
          entry.origin,
          entry.deliveryClass,
          entry.gitStatus ?? null,
          entry.runId ?? null,
          entry.messageId ?? null,
          entry.version,
          rev,
          entry.firstSeenAt,
          entry.updatedAt,
        )
      }
      return rev
    })
    return { revision, entries: prepared }
  }

  /** 软删（保留墓碑供增量同步）；不存在的路径忽略 */
  remove(sessionId: string, paths: string[]): number {
    const rels = paths.map(normalizeRelPath).filter((p): p is string => Boolean(p))
    if (rels.length === 0) return this.stateOf(sessionId)?.revision ?? 0
    const now = new Date().toISOString()
    return this.db.tx(() => {
      let revision = this.stateOf(sessionId)?.revision ?? 0
      let touched = false
      for (const relPath of rels) {
        const existing = this.rowOf(sessionId, relPath)
        if (!existing || existing.deleted_at) continue
        if (!touched) {
          revision = this.bumpRevision(sessionId)
          touched = true
        }
        this.db.run(
          'UPDATE artifacts SET deleted_at = ?, revision = ?, updated_at = ? WHERE session_id = ? AND path = ?',
          now,
          revision,
          now,
          sessionId,
          relPath,
        )
      }
      return revision
    })
  }

  /** 会话删除级联清理（artifacts 表本身有 FK 级联；显式清理兼容旧库 / 外键关闭场景） */
  removeSession(sessionId: string): void {
    this.db.run('DELETE FROM artifacts WHERE session_id = ?', sessionId)
    this.db.run('DELETE FROM artifact_index_state WHERE session_id = ?', sessionId)
    this.scans.delete(sessionId)
    this.failedAt.delete(sessionId)
  }

  // ---------- 读路径：列表 / 增量 / 摘要 ----------

  /** 交付件列表（mtime 降序；paths 精确查询供消息元数据使用） */
  list(
    sessionId: string,
    opts: { limit?: number; offset?: number; paths?: string[] } = {},
  ): { entries: ArtifactEntry[]; total: number; revision: number } {
    const revision = this.stateOf(sessionId)?.revision ?? 0
    if (opts.paths && opts.paths.length > 0) {
      const rels = opts.paths
        .map(normalizeRelPath)
        .filter((p): p is string => Boolean(p))
        .slice(0, 100)
      if (rels.length === 0) return { entries: [], total: 0, revision }
      const marks = rels.map(() => '?').join(', ')
      const rows = this.db.all<ArtifactRow>(
        `SELECT * FROM artifacts
         WHERE session_id = ? AND deleted_at IS NULL AND path IN (${marks})
         ORDER BY mtime_ms DESC, path ASC`,
        sessionId,
        ...rels,
      )
      return { entries: rows.map(rowToEntry), total: rows.length, revision }
    }
    const limit = Math.min(LIST_MAX, Math.max(1, opts.limit ?? 500))
    const offset = Math.max(0, opts.offset ?? 0)
    const rows = this.db.all<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE session_id = ? AND deleted_at IS NULL
       ORDER BY mtime_ms DESC, path ASC
       LIMIT ? OFFSET ?`,
      sessionId,
      limit,
      offset,
    )
    const count = this.db.get<{ c: number }>(
      'SELECT COUNT(*) AS c FROM artifacts WHERE session_id = ? AND deleted_at IS NULL',
      sessionId,
    )
    return { entries: rows.map(rowToEntry), total: Number(count?.c ?? rows.length), revision }
  }

  /** 最近 N 个交付件（路由去重 / 上下文摘要） */
  recent(sessionId: string, limit = 8): ArtifactEntry[] {
    return this.list(sessionId, { limit }).entries
  }

  /** 指定路径的索引条目（handoff 包校验与展示补全） */
  getMany(sessionId: string, paths: string[]): ArtifactEntry[] {
    return this.list(sessionId, { paths }).entries
  }

  /** 本轮 Run 的产出（按 revision 升序） */
  byRun(sessionId: string, runId: string): ArtifactEntry[] {
    const rows = this.db.all<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE session_id = ? AND run_id = ? AND deleted_at IS NULL
       ORDER BY revision ASC`,
      sessionId,
      runId,
    )
    return rows.map(rowToEntry)
  }

  /** 增量同步：revision > since 的变更（含删除墓碑） */
  changes(sessionId: string, since: number): ArtifactChanges {
    const revision = this.stateOf(sessionId)?.revision ?? 0
    if (!Number.isFinite(since) || since >= revision) return { revision, upserts: [], deletes: [] }
    const rows = this.db.all<ArtifactRow>(
      `SELECT * FROM artifacts
       WHERE session_id = ? AND revision > ?
       ORDER BY revision ASC
       LIMIT ?`,
      sessionId,
      Math.max(0, Math.floor(since)),
      CHANGES_MAX,
    )
    return {
      revision,
      upserts: rows.filter((row) => !row.deleted_at).map(rowToEntry),
      deletes: rows.filter((row) => row.deleted_at).map((row) => row.path),
    }
  }

  // ---------- 校准 ----------

  /**
   * 确保索引可用：
   * - `onlyIfMissing`（上下文装配）：仅在从未校准过时扫描，不给每回合引入延迟；
   * - `force`（面板刷新）：忽略新鲜期，立即校准。
   */
  async ensureReady(
    sessionId: string,
    opts: { onlyIfMissing?: boolean; force?: boolean } = {},
  ): Promise<void> {
    const state = this.stateOf(sessionId)
    const ttl = this.opts.ttlMs ?? SCAN_TTL_MS
    if (!opts.force && state?.lastFullScanAt) {
      if (opts.onlyIfMissing) return
      if (Date.now() - Date.parse(state.lastFullScanAt) < ttl) return
    }
    const failed = this.failedAt.get(sessionId)
    if (failed && Date.now() - failed < SCAN_RETRY_MS) return
    const pending = this.scans.get(sessionId)
    if (pending) return pending
    const task = this.reconcile(sessionId)
      .catch((err) => {
        this.failedAt.set(sessionId, Date.now())
        // 索引失败不阻断协作：读取侧退化为空 / 旧数据，下一次访问重试
        console.warn(`[artifact-index] 校准失败 session=${sessionId}: ${(err as Error).message}`)
      })
      .finally(() => {
        if (this.scans.get(sessionId) === task) this.scans.delete(sessionId)
      })
    this.scans.set(sessionId, task)
    return task
  }

  private async reconcile(sessionId: string): Promise<void> {
    const root = this.artifacts.sessionDir(sessionId)
    const gitChanged = this.opts.changedArtifacts ? await this.opts.changedArtifacts(sessionId) : null
    // repo / worktree：交付件 = git 变更集（不遍历仓库）；D（删除）不登记，交给下方回收
    if (gitChanged) {
      const live = gitChanged.filter((a) => a.gitStatus !== 'D')
      const present = new Set(live.map((a) => a.path))
      this.upsert(
        sessionId,
        live.map((a) => ({
          path: a.path,
          size: a.size,
          mtimeMs: a.mtime,
          kind: a.kind,
          origin: 'git' as const,
          gitStatus: a.gitStatus,
        })),
      )
      const stale = this.db
        .all<{ path: string }>(
          "SELECT path FROM artifacts WHERE session_id = ? AND origin = 'git' AND deleted_at IS NULL",
          sessionId,
        )
        .map((row) => row.path)
        .filter((p) => !present.has(p))
      if (stale.length > 0) this.remove(sessionId, stale)
      this.markScanned(sessionId)
      return
    }

    if (!fs.existsSync(root)) {
      this.markScanned(sessionId)
      return
    }
    const { files, complete } = await this.walk(root)
    this.upsert(
      sessionId,
      files.map((file) => ({
        path: file.rel,
        size: file.size,
        mtimeMs: file.mtimeMs,
        origin: 'scan' as const,
      })),
    )
    // 文件被外部删除：仅在完整扫描时回收（截断扫描不误删）
    if (complete) {
      const present = new Set(files.map((file) => file.rel))
      const stale = this.db
        .all<{ path: string }>(
          'SELECT path FROM artifacts WHERE session_id = ? AND deleted_at IS NULL',
          sessionId,
        )
        .map((row) => row.path)
        .filter((p) => !present.has(p))
      if (stale.length > 0) this.remove(sessionId, stale)
    }
    this.markScanned(sessionId)
  }

  /** 受预算约束的异步遍历（隐藏项 / node_modules 跳过；超出条目或时间即截断） */
  private async walk(root: string): Promise<{
    files: Array<{ rel: string; size: number; mtimeMs: number }>
    complete: boolean
  }> {
    const maxEntries = this.opts.scanMaxEntries ?? SCAN_MAX_ENTRIES
    const budgetMs = this.opts.scanBudgetMs ?? SCAN_BUDGET_MS
    const started = Date.now()
    const files: Array<{ rel: string; size: number; mtimeMs: number }> = []
    const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
    while (queue.length > 0) {
      if (files.length >= maxEntries || Date.now() - started > budgetMs) {
        return { files, complete: false }
      }
      const current = queue.shift()!
      try {
        const entries = (await fsp.readdir(current.dir, { withFileTypes: true })) as unknown as Array<{
          name: string
          isDirectory: () => boolean
          isFile: () => boolean
        }>
        for (const entry of entries) {
          if (files.length >= maxEntries || Date.now() - started > budgetMs) {
            return { files, complete: false }
          }
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
          const full = path.join(current.dir, entry.name)
          if (entry.isDirectory()) {
            if (current.depth < 6) queue.push({ dir: full, depth: current.depth + 1 })
            continue
          }
          if (!entry.isFile()) continue
          try {
            const stat = await fsp.stat(full)
            files.push({
              rel: path.relative(root, full).split(path.sep).join('/'),
              size: stat.size,
              mtimeMs: stat.mtimeMs,
            })
          } catch {
            // 并发删除 / 无权限：跳过
          }
        }
      } catch {
        continue
      }
    }
    return { files, complete: true }
  }

  private markScanned(sessionId: string): void {
    const now = new Date().toISOString()
    this.db.run(
      `INSERT INTO artifact_index_state (session_id, revision, last_full_scan_at) VALUES (?, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET last_full_scan_at = excluded.last_full_scan_at`,
      sessionId,
      now,
    )
  }

  private stateOf(sessionId: string): { revision: number; lastFullScanAt?: string } | undefined {
    const row = this.db.get<IndexStateRow>(
      'SELECT revision, last_full_scan_at FROM artifact_index_state WHERE session_id = ?',
      sessionId,
    )
    if (!row) return undefined
    return {
      revision: Number(row.revision),
      ...(row.last_full_scan_at ? { lastFullScanAt: row.last_full_scan_at } : {}),
    }
  }

  private rowOf(sessionId: string, relPath: string): ArtifactRow | undefined {
    return this.db.get<ArtifactRow>(
      'SELECT * FROM artifacts WHERE session_id = ? AND path = ?',
      sessionId,
      relPath,
    )
  }

  /** 推进会话索引版本（调用方必须处于事务内） */
  private bumpRevision(sessionId: string): number {
    const row = this.db.get<{ revision: number }>(
      'SELECT revision FROM artifact_index_state WHERE session_id = ?',
      sessionId,
    )
    if (!row) {
      this.db.run(
        'INSERT INTO artifact_index_state (session_id, revision, last_full_scan_at) VALUES (?, 1, NULL)',
        sessionId,
      )
      return 1
    }
    const next = Number(row.revision) + 1
    this.db.run('UPDATE artifact_index_state SET revision = ? WHERE session_id = ?', next, sessionId)
    return next
  }
}
