/**
 * M79-L：DB 轮询版通知总线传输（多实例演进；NOTIFY_BUS=db 启用）。
 *
 * - publish：写 notify_bus 行（origin = 本实例；transport 不做本地下发——本地下发由 NotifyHub 完成）；
 * - start：游标从当前 maxId 起（不重放历史——启动前本实例无连接，无投递对象；实例重启窗口的缺口
 *   由客户端断线重连 resync + REST 权威层（inbox / 会话列表）补齐）；
 * - poll：按 id 游标拉取「非本实例」行 → 回调投递给本地连接（origin 排除防回环）；
 * - stats：观测计数（published / received）。
 */
import type { NotifyType } from '@multi-agent/shared'
import type { NotifyBusRow, NotifyBusStore } from '../store/notify-bus.js'
import type { NotifyBusEntry, NotifyBusTransport } from '../ws.js'

export interface DbNotifyBusDeps {
  store: NotifyBusStore
  instanceId: string
  pollMs: number
}

export class DbNotifyBus implements NotifyBusTransport {
  private cursor = 0
  private timer?: ReturnType<typeof setInterval>
  private onEntry?: (entry: NotifyBusEntry) => void
  private published = 0
  private received = 0

  constructor(private readonly deps: DbNotifyBusDeps) {}

  publish(entry: NotifyBusEntry): void {
    this.deps.store.append({
      origin: this.deps.instanceId,
      kind: entry.kind,
      target: entry.target,
      type: entry.type ?? '',
      ...(entry.runId ? { runId: entry.runId } : {}),
      payload: JSON.stringify(entry.payload),
    })
    this.published += 1
  }

  start(onEntry: (entry: NotifyBusEntry) => void): void {
    this.onEntry = onEntry
    this.cursor = this.deps.store.maxId()
    const timer = setInterval(() => this.poll(), this.deps.pollMs)
    timer.unref?.()
    this.timer = timer
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.onEntry = undefined
  }

  /** 单轮轮询（测试可直接驱动） */
  poll(): void {
    const rows = this.deps.store.listSince(this.cursor, this.deps.instanceId)
    for (const row of rows) this.deliver(row)
  }

  private deliver(row: NotifyBusRow): void {
    this.cursor = Math.max(this.cursor, row.id)
    let payload: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(row.payload) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>
    } catch {
      // 损坏行静默跳过（不阻塞游标推进）
    }
    this.received += 1
    this.onEntry?.({
      kind: row.kind,
      target: row.target,
      ...(row.type ? { type: row.type as NotifyType } : {}),
      ...(row.runId ? { runId: row.runId } : {}),
      payload,
    })
  }

  stats(): Record<string, number | string> {
    return { mode: 'db', instance: this.deps.instanceId, published: this.published, received: this.received }
  }
}
