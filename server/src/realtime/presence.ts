/**
 * M79-A：在线状态推导（单进程内存态；设计 §9.6）。
 *
 * 语义：
 * - online = 该用户活跃 WS 连接引用计数 > 0（多标签页 / 多端各自 +1）；
 * - 最后一条连接关闭 → 延迟 offlineDelayMs 广播离线（吸收刷新 / 切页抖动；期间重连则取消）；
 * - 变更事件按 aggregateMs 聚合为批量帧（onFlush 一次派发，防帧风暴）；
 * - 可见范围（好友 ∪ 同会话成员）与投递由调用方负责（本类只做状态推导与聚合）。
 */
export interface PresenceEvent {
  userId: string
  online: boolean
  /** 离线时的最后活跃时间（ISO；在线事件缺省） */
  lastSeenAt?: string
}

export interface PresenceTrackerOptions {
  /** 聚合窗口（ms） */
  aggregateMs: number
  /** 离线广播延迟（ms；吸收刷新抖动；缺省 30s） */
  offlineDelayMs?: number
  /** 聚合窗口到期派发（批量帧） */
  onFlush: (events: PresenceEvent[]) => void
}

export class PresenceTracker {
  private readonly conns = new Map<string, number>()
  private readonly lastSeen = new Map<string, string>()
  private readonly pending = new Map<string, PresenceEvent>()
  private readonly offlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private flushTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly opts: PresenceTrackerOptions) {}

  /** WS 连接建立（引用计数 +1；离线抖动期内重连则取消待发离线事件） */
  connect(userId: string): void {
    const timer = this.offlineTimers.get(userId)
    if (timer) {
      clearTimeout(timer)
      this.offlineTimers.delete(userId)
    }
    const count = this.conns.get(userId) ?? 0
    this.conns.set(userId, count + 1)
    if (count === 0) this.queue({ userId, online: true })
  }

  /** WS 连接关闭（引用计数 -1；归零延迟广播离线） */
  disconnect(userId: string): void {
    const count = this.conns.get(userId) ?? 0
    if (count <= 1) {
      this.conns.delete(userId)
      const delay = this.opts.offlineDelayMs ?? 30_000
      const existing = this.offlineTimers.get(userId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        this.offlineTimers.delete(userId)
        // 期间重连（connect 已删定时器）不会走到这里
        if (this.conns.has(userId)) return
        this.lastSeen.set(userId, new Date().toISOString())
        this.queue({ userId, online: false, lastSeenAt: this.lastSeen.get(userId) })
      }, delay)
      timer.unref?.()
      this.offlineTimers.set(userId, timer)
      return
    }
    this.conns.set(userId, count - 1)
  }

  isOnline(userId: string): boolean {
    return (this.conns.get(userId) ?? 0) > 0
  }

  /** M79-L：本实例连接数（跨实例计数表写入依据） */
  countOf(userId: string): number {
    return this.conns.get(userId) ?? 0
  }

  /** M79-L：本实例活跃用户列表（心跳刷行用） */
  userIds(): string[] {
    return [...this.conns.keys()]
  }

  lastSeenAt(userId: string): string | undefined {
    return this.lastSeen.get(userId)
  }

  /** 快照（可见范围过滤由调用方做；重启后为空 = 全部离线） */
  snapshot(userIds: string[]): PresenceEvent[] {
    return userIds.map((userId) => ({
      userId,
      online: this.isOnline(userId),
      lastSeenAt: this.lastSeen.get(userId),
    }))
  }

  /** 活跃连接用户数（观测） */
  size(): number {
    return this.conns.size
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    for (const timer of this.offlineTimers.values()) clearTimeout(timer)
    this.offlineTimers.clear()
    this.pending.clear()
  }

  /** 入聚合桶（同用户取最后一次状态；窗口到期批量派发） */
  private queue(event: PresenceEvent): void {
    this.pending.set(event.userId, event)
    if (this.flushTimer) return
    const timer = setTimeout(() => {
      this.flushTimer = undefined
      this.flush()
    }, this.opts.aggregateMs)
    timer.unref?.()
    this.flushTimer = timer
  }

  private flush(): void {
    if (this.pending.size === 0) return
    const events = [...this.pending.values()]
    this.pending.clear()
    try {
      this.opts.onFlush(events)
    } catch {
      // 派发失败（连接层已销毁等）：静默；状态机不因投递失败回滚
    }
  }
}
