/**
 * 浏览器会话测试替身（M22）：以内存模型实现 CdpClient 的受用子集，驱动真实 BrowserSession
 * 而无需本机 Chrome。
 *
 * 能力：
 * - 命令记录（sent / calls）与事件注入（emit，可选 sessionId 模拟多标签页事件源）；
 * - 页面 target 模型（targets）：openTarget / changeTargetUrl / closeTarget 模拟浏览器行为；
 * - 多 session 附加：attachToTarget / detachSession 更新 currentSessionId（页面跟随切换用）；
 * - Runtime.evaluate 结果定制（evaluateResult 函数 / 固定值；未配置时 location.href 回当前页 URL）；
 * - 断线自愈（M22 韧性增强批）：connect 调用记录与失败注入（connectBehavior）、emitClose 模拟连接意外断开。
 */

export type EvaluateResolver = (expression: string) => unknown

export interface FakeTargetInfo {
  targetId: string
  type: string
  url?: string
  title?: string
  openerId?: string
}

export class FakeCdp {
  readonly sent: Array<{ method: string; params: Record<string, unknown> }> = []
  /** Runtime.evaluate 返回值（函数按表达式定制；或固定值；未配置时 location.href 回当前页 URL） */
  evaluateResult: EvaluateResolver | unknown = undefined
  /** 页面 target 模型（含未管理页） */
  readonly targets = new Map<string, FakeTargetInfo>()
  currentTargetId = 'page-1'
  currentSessionId = 'cdp-session-1'
  /** connect 调用记录（断线重连拼接新连接时断言） */
  readonly connectCalls: Array<{ url: string }> = []
  /** 连接行为钩子：第 N 次调用（从 1 开始）可抛错模拟连接失败 */
  connectBehavior?: (attempt: number) => void
  /** close() 调用次数（重连失败的废弃连接应被关闭） */
  closeCalls = 0
  private sessionSeq = 1
  private targetSeq = 1
  private readonly handlers = new Map<string, Set<(params: unknown, sessionId?: string) => void>>()
  private readonly closeHandlers = new Set<(reason: string) => void>()

  constructor(opts: { initialUrl?: string } = {}) {
    this.targets.set('page-1', { targetId: 'page-1', type: 'page', url: opts.initialUrl })
  }

  urlOf(targetId: string = this.currentTargetId): string | undefined {
    return this.targets.get(targetId)?.url
  }

  /** 当前管理页 session（页面级事件过滤用；detach 后为空） */
  get pageSessionId(): string | undefined {
    return this.currentSessionId || undefined
  }

  get pageTargetId(): string | undefined {
    return this.currentTargetId || undefined
  }

  calls(method: string): Array<Record<string, unknown>> {
    return this.sent.filter((item) => item.method === method).map((item) => item.params)
  }

  /** 注入 CDP 事件（sessionId 缺省 = browser 级 / 不指定归属） */
  emit(method: string, params: unknown, sessionId?: string): void {
    const set = this.handlers.get(method)
    if (!set) return
    for (const fn of [...set]) fn(params, sessionId)
  }

  /** 模拟浏览器打开 / 创建新标签页 */
  openTarget(target: { targetId: string; url?: string; openerId?: string; title?: string }): void {
    this.targets.set(target.targetId, { type: 'page', ...target })
    this.emit('Target.targetCreated', { targetInfo: { type: 'page', ...target } })
  }

  /** 模拟标签页导航（地址变化） */
  changeTargetUrl(targetId: string, url: string): void {
    const info = this.targets.get(targetId)
    if (info) info.url = url
    this.emit('Target.targetInfoChanged', {
      targetInfo: this.targets.get(targetId) ?? { targetId, type: 'page', url },
    })
  }

  /** 模拟标签页关闭 */
  closeTarget(targetId: string): void {
    this.targets.delete(targetId)
    this.emit('Target.targetDestroyed', { targetId })
  }

  // ---------- CdpClient 受用子集 ----------

  /** 模拟建立连接（可经 connectBehavior 注入失败；端点由会话层传入） */
  async connect(wsUrl: string): Promise<void> {
    this.connectCalls.push({ url: wsUrl })
    this.connectBehavior?.(this.connectCalls.length)
  }

  /** 模拟连接意外断开（触发会话层自动重连） */
  emitClose(reason = 'socket hang up'): void {
    for (const fn of [...this.closeHandlers]) fn(reason)
  }

  async attachToPage(): Promise<{ sessionId: string; targetId: string }> {
    return { sessionId: this.currentSessionId, targetId: this.currentTargetId }
  }

  async getPageTargets(): Promise<FakeTargetInfo[]> {
    this.sent.push({ method: 'Target.getTargets', params: {} })
    return [...this.targets.values()].filter((info) => info.type === 'page')
  }

  async attachToTarget(targetId: string): Promise<string> {
    this.sent.push({ method: 'Target.attachToTarget', params: { targetId, flatten: true } })
    this.currentTargetId = targetId
    this.sessionSeq += 1
    this.currentSessionId = `cdp-session-${this.sessionSeq}`
    return this.currentSessionId
  }

  /** M62：新建页面 target 并 attach（模拟浏览器 Target.createTarget + attachToTarget） */
  async createTargetAttach(url = 'about:blank'): Promise<{ sessionId: string; targetId: string }> {
    this.targetSeq += 1
    const targetId = `page-${this.targetSeq}`
    this.sent.push({ method: 'Target.createTarget', params: { url } })
    this.openTarget({ targetId, url })
    return { sessionId: await this.attachToTarget(targetId), targetId }
  }

  async detachSession(sessionId: string): Promise<void> {
    this.sent.push({ method: 'Target.detachFromTarget', params: { sessionId } })
    if (this.currentSessionId === sessionId) this.currentSessionId = ''
  }

  async send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      const expression = String(params.expression ?? '')
      const value =
        typeof this.evaluateResult === 'function'
          ? (this.evaluateResult as EvaluateResolver)(expression)
          : (this.evaluateResult ?? (expression === 'location.href' ? this.urlOf() : undefined))
      return { result: { value } } as unknown as T
    }
    if (method === 'Page.navigate') {
      // 导航后立即触发 loadEventFired，让 navigate 内的 waitEvent 即刻返回（不实际等待 15s）
      this.emit('Page.loadEventFired', {})
      return {} as unknown as T
    }
    return {} as unknown as T
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    const set = this.handlers.get(method) ?? new Set()
    set.add(handler)
    this.handlers.set(method, set)
    return () => {
      set.delete(handler)
      if (set.size === 0) this.handlers.delete(method)
    }
  }

  onUnexpectedClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler)
    return () => this.closeHandlers.delete(handler)
  }

  async close(): Promise<void> {
    this.closeCalls += 1
  }
}
