/**
 * M79-L：共享通知总线存储（多实例演进；仅 NOTIFY_BUS=db 写入）。
 *
 * - 每实例轮询 id 游标消费「非本实例」行（origin 排除），投递给本地连接；
 * - 本地 seq / 重放缓冲独立分配（跨实例游标不通用——实例切换靠客户端重连 resync + REST 权威层补齐）；
 * - 实例启动游标 = 当前 maxId（不重放历史行：启动前本实例无连接，无投递对象）；
 * - 保留期清理（notifyBusRetentionMinutes；0 = 不清理）。
 */
import type { AppDb } from './db.js'

export interface NotifyBusRow {
  id: number
  origin: string
  /** M79-Y：session/user/revoke/kick（revoke/kick 为跨实例安全条目） */
  kind: 'session' | 'user' | 'revoke' | 'kick'
  target: string
  type: string
  runId?: string
  payload: string
  createdAt: string
}

export interface NotifyBusAppendInput {
  origin: string
  kind: 'session' | 'user' | 'revoke' | 'kick'
  target: string
  type: string
  runId?: string
  payload: string
}

interface RawRow {
  id: number
  origin: string
  kind: string
  target: string
  type: string
  run_id: string | null
  payload: string
  created_at: string
}

export class NotifyBusStore {
  constructor(private readonly db: AppDb) {}

  append(input: NotifyBusAppendInput): number {
    const info = this.db.run(
      `INSERT INTO notify_bus (origin, kind, target, type, run_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      input.origin,
      input.kind,
      input.target,
      input.type,
      input.runId ?? null,
      input.payload,
      new Date().toISOString(),
    )
    return Number(info.lastInsertRowid ?? 0)
  }

  /** 当前最大行 id（新实例轮询游标起点；不重放历史） */
  maxId(): number {
    const row = this.db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM notify_bus')
    return row?.id ?? 0
  }

  /** id 游标增量（排除本实例 origin——防回环） */
  listSince(idExclusive: number, excludeOrigin: string, limit = 200): NotifyBusRow[] {
    const rows = this.db.all<RawRow>(
      `SELECT * FROM notify_bus WHERE id > ? AND origin != ? ORDER BY id ASC LIMIT ?`,
      idExclusive,
      excludeOrigin,
      limit,
    )
    return rows.map((row: RawRow) => ({
      id: row.id,
      origin: row.origin,
      // M79-Y：kind 直传四值（revoke / kick 为跨实例安全条目；未知值回退 session）
      kind: (['user', 'revoke', 'kick'] as const).includes(row.kind as 'user') ? (row.kind as 'user') : 'session',
      target: row.target,
      type: row.type,
      ...(row.run_id ? { runId: row.run_id } : {}),
      payload: row.payload,
      createdAt: row.created_at,
    }))
  }

  /** 保留期清理（分钟；0 = 不清理） */
  cleanup(retentionMinutes: number): number {
    if (retentionMinutes <= 0) return 0
    const cutoff = new Date(Date.now() - retentionMinutes * 60_000).toISOString()
    return this.db.run('DELETE FROM notify_bus WHERE created_at < ?', cutoff).changes
  }
}
