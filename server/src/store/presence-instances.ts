/**
 * M79-L：跨实例 presence 计数存储（多实例演进；仅 NOTIFY_BUS=db 启用）。
 *
 * - 每实例维护 (instance_id, user_id) → 本实例连接数（0 = 删行）；
 * - 行 updated_at 由实例心跳刷新（touchInstance）；stale 行（实例死亡）按过期忽略并清理；
 * - 离线广播判定：全局合计（忽略 stale）> 0 → 不广播（防「A 断开但 B 仍有连接」误判离线）；
 * - 单实例 memory 模式不使用本存储（零变化）。
 */
import type { AppDb } from './db.js'

export class PresenceInstanceStore {
  constructor(private readonly db: AppDb) {}

  /** 写入本实例计数（0 → 删行） */
  setCount(instanceId: string, userId: string, count: number): void {
    const ts = new Date().toISOString()
    if (count <= 0) {
      this.db.run('DELETE FROM presence_instances WHERE instance_id = ? AND user_id = ?', instanceId, userId)
      return
    }
    this.db.run(
      `INSERT INTO presence_instances (instance_id, user_id, conn_count, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(instance_id, user_id) DO UPDATE SET conn_count = excluded.conn_count, updated_at = excluded.updated_at`,
      instanceId,
      userId,
      count,
      ts,
    )
  }

  /** 全局合计（忽略 stale 行——实例心跳过期的计数视为 0） */
  globalCount(userId: string, staleMs: number): number {
    const cutoff = new Date(Date.now() - staleMs).toISOString()
    const row = this.db.get<{ total: number | null }>(
      'SELECT SUM(conn_count) AS total FROM presence_instances WHERE user_id = ? AND updated_at >= ?',
      userId,
      cutoff,
    )
    return row?.total ?? 0
  }

  /** 实例心跳：刷新本实例全部行的 updated_at（长期连接不变的场景防误判 stale） */
  touchInstance(instanceId: string): void {
    this.db.run('UPDATE presence_instances SET updated_at = ? WHERE instance_id = ?', new Date().toISOString(), instanceId)
  }

  /** stale 行清理（实例死亡后回收） */
  pruneStale(staleMs: number): number {
    const cutoff = new Date(Date.now() - staleMs).toISOString()
    return this.db.run('DELETE FROM presence_instances WHERE updated_at < ?', cutoff).changes
  }

  /** 观测：本实例行数 / 全局行数 */
  size(): { instances: number; rows: number } {
    const inst = this.db.get<{ n: number }>('SELECT COUNT(DISTINCT instance_id) AS n FROM presence_instances')
    const rows = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM presence_instances')
    return { instances: inst?.n ?? 0, rows: rows?.n ?? 0 }
  }
}
