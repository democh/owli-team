/**
 * M34：金融自选列表存储（finance_watchlist 表；迁移 v8）。
 *
 * 语义：
 * - 全局单表（非会话资产）：自选列表跨会话共享，fin_watch 与 REST API 同源；
 * - symbol 唯一：重复添加 = 更新名称 / 备注（upsert），不产生重复行；
 * - sort：展示排序（新添加排最后）；删除为物理删除（轻量用户数据，无需软删）；
 * - finance_meta / 缓存表由 finance/cache.ts 直接读写，本存储只承载 watchlist 的用户可见状态。
 */
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

export interface WatchItem {
  id: string
  /** 展示 symbol（sh600519 / sz159915 / 场外 6 位） */
  symbol: string
  /** 资产类型（stock / etf / fund / index） */
  type: string
  name: string
  note?: string
  sort: number
  createdAt: string
}

interface WatchRow {
  id: string
  symbol: string
  type: string
  name: string
  note: string | null
  sort: number
  created_at: string
}

function rowToItem(row: WatchRow): WatchItem {
  return {
    id: row.id,
    symbol: row.symbol,
    type: row.type,
    name: row.name,
    ...(row.note ? { note: row.note } : {}),
    sort: Number(row.sort),
    createdAt: row.created_at,
  }
}

export interface WatchAddInput {
  symbol: string
  type: string
  name: string
  note?: string
}

export class FinanceStore {
  constructor(private readonly db: AppDb) {}

  /** 全部自选（sort 升序；新添加排最后） */
  list(): WatchItem[] {
    return this.db
      .all<WatchRow>('SELECT * FROM finance_watchlist ORDER BY sort ASC, created_at ASC')
      .map(rowToItem)
  }

  get(symbol: string): WatchItem | undefined {
    const row = this.db.get<WatchRow>('SELECT * FROM finance_watchlist WHERE symbol = ?', symbol)
    return row ? rowToItem(row) : undefined
  }

  count(): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM finance_watchlist')
    return Number(row?.n ?? 0)
  }

  /** 添加（symbol 唯一：已存在则更新名称 / 类型 / 备注；created 标记是否新增行） */
  add(input: WatchAddInput): { item: WatchItem; created: boolean } {
    const existing = this.get(input.symbol)
    if (existing) {
      this.db.run(
        'UPDATE finance_watchlist SET name = ?, type = ?, note = ? WHERE symbol = ?',
        input.name,
        input.type,
        input.note ?? existing.note ?? null,
        input.symbol,
      )
      return { item: this.get(input.symbol)!, created: false }
    }
    const id = newId('fwl')
    const maxRow = this.db.get<{ m: number | null }>('SELECT MAX(sort) AS m FROM finance_watchlist')
    const sort = Number(maxRow?.m ?? 0) + 1
    this.db.run(
      'INSERT INTO finance_watchlist (id, symbol, type, name, note, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      input.symbol,
      input.type,
      input.name,
      input.note ?? null,
      sort,
      nowIso(),
    )
    return { item: this.get(input.symbol)!, created: true }
  }

  remove(symbol: string): boolean {
    return this.db.run('DELETE FROM finance_watchlist WHERE symbol = ?', symbol).changes > 0
  }
}
