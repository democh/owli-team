/**
 * BrowserSession（M22）：一次浏览器会话的生命周期、帧管线、输入通道与动作编排。
 *
 * 帧管线（对标 agent-browser 生产实践）：
 * - lastFrame 覆盖槽（慢消费者看到的是最新帧，永不积压）；
 * - CDP 帧立即 ack（不等待消费，避免内核侧帧背压）；
 * - seq 单调递增 + ts（客户端据此计算帧年龄 / 丢弃乱序）；
 * - 帧分发为「拉模式 + 推通知」：StreamHub 客户端订阅时先拿 lastFrame 即时出画。
 *
 * 控制权状态机：
 *   launching → ready ⇄ acting
 *   agent 动作在 controller='human' 时等待（排队不丢弃，60s 超时）
 *   human 输入 → controller='human'（人工接管）；release 归还 agent
 *   awaiting_human：Agent 主动请求人工（登录 / 验证码 / 敏感确认）
 *
 * 步骤记录：每个动作落 browser_steps（含截图证据），供时间轴回放。
 *
 * 控制台采集：Runtime.consoleAPICalled / Runtime.exceptionThrown / Log.entryAdded
 * → 环形缓冲（console.clear 与主帧导航时清空），browser_console 工具读取。
 *
 * 页面跟随（多标签页）：Target.setDiscoverTargets 感知全部页面（创建 / 关闭 / 元数据变化），
 * 当前管理页打开的新页（opener 链）与空白页的真实导航自动接管（切换 = 停旧帧流 + attach 新页 +
 * 重启采集）；当前页被关闭时回退到剩余页面。切换在动作边界执行（busy / settle 状态机），
 * 页面级事件按 sessionId 过滤——旧页残留事件不会污染新页上下文。
 *
 * 断线自愈（M22 韧性增强批）：CDP 连接意外断开（崩溃重启 / 睡眠唤醒 / 远程端点静默丢包）先尝试同端点自动重连
 * （退避序列），重挂原管理页（目标仍在时）并恢复域 / 事件 / 帧流；重试耗尽才落 error + onClosed。
 * 重连期间状态为 reconnecting（区别于首次启动的 launching），动作入口（runExclusive / evaluateRaw / input）
 * 等待恢复结果，不产生误导性超时。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { BrowserBackend, BrowserSessionInfo, BrowserState } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { getLogger } from '../logger.js'
import { CdpClient } from './cdp.js'

export interface BrowserFrame {
  seq: number
  /** base64 JPEG */
  data: string
  ts: number
  url?: string
  width?: number
  height?: number
}

export interface BrowserStepRecord {
  seq: number
  actor: 'agent' | 'human'
  action: string
  args?: Record<string, unknown>
  url?: string
  screenshotPath?: string
  ok: boolean
  durationMs?: number
  detail?: string
  ts: string
}

export interface BrowserSessionCallbacks {
  onFrame(frame: BrowserFrame): void
  onState(state: BrowserState, controller: 'agent' | 'human'): void
  onStep(step: BrowserStepRecord): void
  /** 会话意外断开（浏览器崩溃 / 端点关闭） */
  onClosed(reason: string): void
}

export interface BrowserSessionOptions {
  id: string
  /** 业务会话 id（sessions 表） */
  sessionId: string
  connectionId?: string
  backend: BrowserBackend
  endpoint: string
  child?: ChildProcess
  /** 复用实例（不归本进程管理） */
  external: boolean
  cfg: AppConfig
  /** 启动形态：true=无头 / false=打开窗口（信息面展示用） */
  headless?: boolean
  callbacks: BrowserSessionCallbacks
  /** CDP 客户端工厂（断线重连时新建连接；测试可注入替身） */
  cdpFactory?: () => CdpClient
  /** 断线重连退避序列（ms）；重试耗尽后终止会话。测试可注入小值 */
  reconnectDelaysMs?: number[]
}

export interface SnapshotElement {
  index: number
  tag: string
  text?: string
  role?: string
  name?: string
  href?: string
  selector: string
}

/** 控制台条目（browser_console 工具数据源） */
export interface BrowserConsoleEntry {
  seq: number
  level: 'log' | 'info' | 'warning' | 'error' | 'exception'
  text: string
  ts: number
}

/** 控制台环形缓冲上限（超出丢弃最旧） */
const CONSOLE_CAP = 500
/** 单条控制台文本截断长度 */
const CONSOLE_TEXT_MAX = 600

const HUMAN_WAIT_TIMEOUT_MS = 60_000

/** 断线自动重连：退避序列（ms）与单次连接超时 */
const RECONNECT_DELAYS_MS = [300, 1_000, 2_500]
const RECONNECT_CONNECT_TIMEOUT_MS = 6_000

/** 常用键映射（CDP dispatchKeyEvent 需要 code + windowsVirtualKeyCode） */
const KEY_MAP: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
}

/** 键名大小写不敏感索引（'enter' / 'ENTER' → 'Enter'） */
const KEY_LOOKUP = new Map(Object.keys(KEY_MAP).map((key) => [key.toLowerCase(), key]))

function normalizeKeyName(key: string): string {
  return KEY_LOOKUP.get(key.toLowerCase()) ?? key
}

/** 空白页 / 新标签页（Ctrl+T 后未访问）：先观察，真实导航后再跟随 */
function isBlankUrl(url: string | undefined): boolean {
  return (
    !url ||
    url === 'about:blank' ||
    url === 'about:newtab' ||
    url === 'about:home' ||
    url === 'chrome://newtab/'
  )
}

/** 浏览器内部页（不纳入管理：调试器 / 设置 / 扩展页等） */
function isInternalUrl(url: string | undefined): boolean {
  return !!url && /^(devtools|chrome|chrome-extension|chrome-untrusted|edge|view-source):/i.test(url)
}

/** Target 事件中的页面元数据（宽松类型：兼容不同 Chrome 版本的字段差异） */
interface TargetInfoLike {
  targetId?: string
  type?: string
  url?: string
  title?: string
  openerId?: string
}

interface ConsoleApiParams {
  type?: string
  args?: Array<{ value?: unknown; description?: string; type?: string }>
}

interface ExceptionParams {
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

interface LogEntryParams {
  entry?: { level?: string; text?: string }
}

/** 控制台参数序列化（CDP RemoteObject → 可读文本） */
function consoleArgsText(args: Array<{ value?: unknown; description?: string; type?: string }>): string {
  return args
    .map((arg) => {
      if (arg && typeof arg === 'object') {
        if (arg.value !== undefined) {
          if (typeof arg.value === 'string') return arg.value
          try {
            return JSON.stringify(arg.value) ?? String(arg.value)
          } catch {
            return String(arg.value)
          }
        }
        if (typeof arg.description === 'string') return arg.description
        if (typeof arg.type === 'string') return `<${arg.type}>`
      }
      return String(arg)
    })
    .join(' ')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ScreencastFrameParams {
  data: string
  sessionId: number
  metadata?: { deviceWidth?: number; deviceHeight?: number }
}

export class BrowserSession {
  readonly id: string
  readonly sessionId: string
  readonly connectionId?: string
  readonly backend: BrowserBackend
  readonly endpoint: string
  readonly createdAt = new Date().toISOString()
  /** 启动形态（无头 / 打开窗口）：信息面展示用 */
  readonly headless: boolean

  state: BrowserState = 'launching'
  controller: 'agent' | 'human' = 'agent'
  currentUrl?: string
  /** 当前动作归属（工具运行时在动作前设置；步骤落库时补齐 run/agent 维度） */
  context: { runId?: string; agentId?: string } = {}

  private readonly cfg: AppConfig
  private readonly callbacks: BrowserSessionCallbacks
  private readonly child?: ChildProcess
  private readonly external: boolean
  private readonly cdpFactory: () => CdpClient
  private readonly reconnectDelaysMs: number[]

  private cdp?: CdpClient
  private closed = false
  private closeReason?: string
  private frameSeq = 0
  private lastFrame?: BrowserFrame
  private lastFrameAt?: string
  private stepSeq = 0
  private consoleSeq = 0
  private consoleBuffer: BrowserConsoleEntry[] = []
  private viewport: { width: number; height: number }
  /** 动作串行链（保证人工接管期间 agent 动作排队而非交错） */
  private opChain: Promise<unknown> = Promise.resolve()
  private stops: Array<() => void> = []

  /** 当前管理页的 target（页面跟随的权威标识） */
  private pageTargetId?: string
  /** 全部已知 page target 元数据（跟随判定与回退用；含未管理页） */
  private readonly knownPages = new Map<string, { url?: string; title?: string }>()
  /** 观察中的空白页（Ctrl+T）：真实导航后再跟随 */
  private readonly blankPages = new Set<string>()
  /** 待执行的页面切换（事件到达时登记，空闲时在动作边界执行） */
  private pendingSwitch?: { targetId: string; reason: string }
  /** 正在执行的切换（动作 / 评估入口先等待其完成） */
  private switching?: Promise<void>
  /** 动作执行中标记（页面切换只在动作边界发生） */
  private busy = false
  /** 断线重连任务（进行中时动作入口等待；同一时刻仅一个） */
  private reconnectTask?: Promise<void>

  constructor(opts: BrowserSessionOptions) {
    this.id = opts.id
    this.sessionId = opts.sessionId
    this.connectionId = opts.connectionId
    this.backend = opts.backend
    this.endpoint = opts.endpoint
    this.cfg = opts.cfg
    this.callbacks = opts.callbacks
    this.child = opts.child
    this.external = opts.external
    this.headless = opts.headless ?? true
    this.cdpFactory =
      opts.cdpFactory ?? (() => new CdpClient({ keepaliveMs: opts.cfg.browserKeepaliveMs }))
    this.reconnectDelaysMs = opts.reconnectDelaysMs ?? RECONNECT_DELAYS_MS
    this.viewport = { width: opts.cfg.browserViewportWidth, height: opts.cfg.browserViewportHeight }
  }

  // ---------- 生命周期 ----------

  async start(cdp: CdpClient, startUrl?: string): Promise<void> {
    await this.attachPipeline(cdp, { startUrl })
    this.setState('ready')
    if (startUrl && startUrl !== 'about:blank') {
      await this.navigate(startUrl)
    }
  }

  /**
   * 建立 CDP 会话干线：attach 管理页 → 域启用 → 事件订阅 → 发现与帧流。
   * start 与断线重连共用；preferTargetId 命中时优先重挂原管理页（重连保留视点），否则按 startUrl 选择。
   */
  private async attachPipeline(
    cdp: CdpClient,
    opts: { startUrl?: string; preferTargetId?: string } = {},
  ): Promise<void> {
    if (this.closed) throw new Error('浏览器会话已关闭')
    // 旧连接的事件订阅先清掉（重连时指向已死连接；初次启动为空）
    for (const stop of this.stops.splice(0)) {
      try {
        stop()
      } catch {
        // 忽略
      }
    }
    this.cdp = cdp

    // 页面清单重建（重连时断线期间用户可能开 / 关过页面；初次启动以当前全量页面为准）
    const pages = await cdp.getPageTargets().catch(() => [])
    this.knownPages.clear()
    this.blankPages.clear()
    for (const page of pages) this.trackPage(page)

    const preferred = opts.preferTargetId
    let attached: { sessionId: string; targetId: string }
    if (preferred && pages.some((page) => page.targetId === preferred)) {
      const sessionId = await cdp.attachToTarget(preferred)
      attached = { sessionId, targetId: preferred }
    } else {
      attached = await cdp.attachToPage(opts.startUrl)
    }
    this.pageTargetId = attached.targetId
    // 初始地址取 attach 目标页；重连时目标页元数据缺失则保留最后已知地址
    this.currentUrl = this.knownPages.get(attached.targetId)?.url ?? this.currentUrl

    await cdp.send('Page.enable', {}, { timeoutMs: 10_000 })
    await cdp.send('Runtime.enable', {}, { timeoutMs: 10_000 })
    try {
      await cdp.send('Log.enable', {}, { timeoutMs: 10_000 })
    } catch {
      // Log 域不可用：控制台仍可经 Runtime 事件采集
    }
    try {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: this.viewport.width,
          height: this.viewport.height,
          deviceScaleFactor: 1,
          mobile: false,
        },
        { timeoutMs: 10_000 },
      )
    } catch {
      // 部分老版本不支持：忽略（screencast 仍可用）
    }

    // 事件订阅（页面级事件按当前 page session 过滤：切换后旧页残留事件不污染新页上下文）
    const forCurrentPage =
      (handler: (params: unknown) => void) =>
      (params: unknown, sessionId?: string): void => {
        if (sessionId && sessionId !== cdp.pageSessionId) return
        handler(params)
      }
    this.stops.push(
      cdp.on(
        'Page.screencastFrame',
        forCurrentPage((params) => this.handleScreencastFrame(params as ScreencastFrameParams)),
      ),
      cdp.on(
        'Page.frameNavigated',
        forCurrentPage((params) => {
          const frame = (params as { frame?: { url?: string; parentId?: string } }).frame
          if (frame?.url && !frame.parentId) {
            this.currentUrl = frame.url
            this.consoleBuffer = [] // 主帧导航后控制台清空（与浏览器行为一致）
          }
        }),
      ),
      cdp.on(
        'Runtime.consoleAPICalled',
        forCurrentPage((params) => this.handleConsoleApi(params as ConsoleApiParams)),
      ),
      cdp.on(
        'Runtime.exceptionThrown',
        forCurrentPage((params) => this.handleException(params as ExceptionParams)),
      ),
      cdp.on(
        'Log.entryAdded',
        forCurrentPage((params) => this.handleLogEntry(params as LogEntryParams)),
      ),
      // 多标签页感知（browser 级事件，不按 session 过滤）
      cdp.on('Target.targetCreated', (params) => this.handleTargetCreated(params)),
      cdp.on('Target.targetDestroyed', (params) => this.handleTargetDestroyed(params)),
      cdp.on('Target.targetInfoChanged', (params) => this.handleTargetInfoChanged(params)),
      cdp.onUnexpectedClose((reason) => this.handleDisconnect(reason)),
    )

    // 先订阅（上方）再开启发现，避免漏事件；发现不可用时仅失去多标签页跟随（降级不致命）
    await cdp
      .send('Target.setDiscoverTargets', { discover: true }, { sessionId: null, timeoutMs: 5_000 })
      .catch(() => undefined)

    // 帧流启动：每客户端 fps 由 StreamHub 控制，这里全速产出 + 覆盖槽
    await cdp.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: this.cfg.browserFrameQuality,
        maxWidth: this.viewport.width,
        maxHeight: this.viewport.height,
        everyNthFrame: 1,
      },
      { timeoutMs: 10_000 },
    )

    // 重连恢复：地址以页面实况对齐（断线期间页面可能已导航）
    if (preferred) {
      const url = await cdp
        .send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          { timeoutMs: 10_000 },
        )
        .then((res) => (typeof res.result?.value === 'string' ? res.result.value : undefined))
        .catch(() => undefined)
      if (url) this.currentUrl = url
    }
  }

  async close(reason = '会话关闭'): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    for (const stop of this.stops.splice(0)) {
      try {
        stop()
      } catch {
        // 忽略
      }
    }
    this.knownPages.clear()
    this.blankPages.clear()
    this.pendingSwitch = undefined
    try {
      await this.cdp?.send('Page.stopScreencast', {}, { timeoutMs: 2_000 })
    } catch {
      // 连接可能已断
    }
    await this.cdp?.close()
    this.setState('closed')
    // 进程清理由 runtime 负责（external 实例不动）
  }

  getChild(): ChildProcess | undefined {
    return this.external ? undefined : this.child
  }

  isClosed(): boolean {
    return this.closed
  }

  // ---------- 断线自愈 ----------

  /**
   * 连接意外断开：登记自动重连（同一时刻仅一个任务）。
   * 由 CdpClient 的 close 事件触发（主动 close 会被抑制，不会到达）。
   */
  private handleDisconnect(reason: string): void {
    if (this.closed) return
    if (this.reconnectTask) {
      getLogger().warn(
        { browserSessionId: this.id, reason },
        '浏览器连接再次断开（重连任务进行中，沿用现有任务）',
      )
      return
    }
    getLogger().warn({ browserSessionId: this.id, reason }, '浏览器 CDP 连接断开，尝试自动重连')
    const task = this.tryReconnect(reason).finally(() => {
      if (this.reconnectTask === task) this.reconnectTask = undefined
    })
    this.reconnectTask = task
  }

  /** 退避重连：新连接重挂原管理页并恢复域 / 事件 / 帧流；重试耗尽才落 error + onClosed */
  private async tryReconnect(reason: string): Promise<void> {
    this.setState('reconnecting')
    const delays = this.reconnectDelaysMs
    for (let attempt = 1; attempt <= delays.length; attempt++) {
      await sleep(delays[attempt - 1] ?? 0)
      if (this.closed) return
      const cdp = this.cdpFactory()
      try {
        await cdp.connect(this.endpoint, RECONNECT_CONNECT_TIMEOUT_MS)
        await this.attachPipeline(cdp, { preferTargetId: this.pageTargetId })
      } catch (err) {
        await cdp.close().catch(() => undefined)
        getLogger().warn(
          { browserSessionId: this.id, attempt, err: (err as Error).message },
          '浏览器重连失败，按退避继续重试',
        )
        continue
      }
      if (this.closed) {
        await cdp.close().catch(() => undefined)
        return
      }
      this.recordStep({ action: 'reconnect', ok: true, detail: `连接已自动恢复（第 ${attempt} 次尝试）` })
      this.setState(this.controller === 'human' ? 'human' : 'ready')
      getLogger().info({ browserSessionId: this.id, attempt }, '浏览器连接已自动恢复')
      return
    }
    if (this.closed) return
    this.closed = true
    this.closeReason = `浏览器连接断开：${reason}`
    this.setState('error')
    getLogger().warn({ browserSessionId: this.id, reason }, '浏览器重连重试耗尽，会话终止')
    this.callbacks.onClosed(this.closeReason)
  }

  /** 重连进行中时动作入口等待恢复结果（重试耗尽后由 closed 检查给出明确错误） */
  private async waitReconnect(): Promise<void> {
    while (this.reconnectTask) {
      await this.reconnectTask.catch(() => undefined)
    }
  }

  info(): BrowserSessionInfo {
    return {
      id: this.id,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      backend: this.backend,
      state: this.state,
      controller: this.controller,
      headless: this.headless,
      external: this.external,
      viewport: { ...this.viewport },
      endpoint: this.endpoint,
      currentUrl: this.currentUrl,
      createdAt: this.createdAt,
      closedAt: this.closed ? new Date().toISOString() : undefined,
      lastFrameAt: this.lastFrameAt,
      topic: `browser:${this.id}`,
    }
  }

  getLastFrame(): BrowserFrame | undefined {
    return this.lastFrame
  }

  private setState(state: BrowserState): void {
    if (this.state === state) return
    this.state = state
    this.callbacks.onState(state, this.controller)
  }

  // ---------- 帧管线 ----------

  private handleScreencastFrame(params: ScreencastFrameParams): void {
    // 立即 ack（不等待消费，避免内核侧背压）
    void this.cdp
      ?.send('Page.screencastFrameAck', { sessionId: params.sessionId }, { timeoutMs: 5_000 })
      .catch(() => undefined)
    this.frameSeq += 1
    const frame: BrowserFrame = {
      seq: this.frameSeq,
      data: params.data,
      ts: Date.now(),
      url: this.currentUrl,
      width: params.metadata?.deviceWidth,
      height: params.metadata?.deviceHeight,
    }
    this.lastFrame = frame
    this.lastFrameAt = new Date().toISOString()
    this.callbacks.onFrame(frame)
  }

  /** 控制台日志读取（level 过滤 + 最近 limit 条；total 为命中总数） */
  consoleLog(
    level: 'all' | 'warning' | 'error' = 'all',
    limit = 50,
  ): { entries: BrowserConsoleEntry[]; total: number } {
    const levels: Array<BrowserConsoleEntry['level']> =
      level === 'error'
        ? ['error', 'exception']
        : level === 'warning'
          ? ['warning', 'error', 'exception']
          : ['log', 'info', 'warning', 'error', 'exception']
    const matched = this.consoleBuffer.filter((entry) => levels.includes(entry.level))
    return { entries: matched.slice(-limit), total: matched.length }
  }

  // ---------- 控制台采集 ----------

  private handleConsoleApi(params: ConsoleApiParams): void {
    const type = String(params.type ?? 'log')
    if (type === 'clear') {
      this.consoleBuffer = []
      return
    }
    const level: BrowserConsoleEntry['level'] =
      type === 'error' ? 'error' : type === 'warning' ? 'warning' : type === 'info' ? 'info' : 'log'
    this.pushConsole(level, consoleArgsText(params.args ?? []))
  }

  private handleException(params: ExceptionParams): void {
    const details = params.exceptionDetails
    this.pushConsole('exception', details?.exception?.description ?? details?.text ?? '未捕获异常')
  }

  private handleLogEntry(params: LogEntryParams): void {
    const entry = params.entry
    if (!entry?.text) return
    const level: BrowserConsoleEntry['level'] =
      entry.level === 'error'
        ? 'error'
        : entry.level === 'warning'
          ? 'warning'
          : entry.level === 'info'
            ? 'info'
            : 'log'
    this.pushConsole(level, entry.text)
  }

  private pushConsole(level: BrowserConsoleEntry['level'], text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (!clean) return
    this.consoleSeq += 1
    this.consoleBuffer.push({
      seq: this.consoleSeq,
      level,
      text: clean.length > CONSOLE_TEXT_MAX ? `${clean.slice(0, CONSOLE_TEXT_MAX)}…` : clean,
      ts: Date.now(),
    })
    if (this.consoleBuffer.length > CONSOLE_CAP) {
      this.consoleBuffer.splice(0, this.consoleBuffer.length - CONSOLE_CAP)
    }
  }

  // ---------- 页面跟随（多标签页） ----------

  /**
   * 空闲时清结待执行的页面切换（动作 / 评估入口调用）。
   * busy（动作执行中）时不抢占——切换只发生在动作边界，保证动作目标页稳定。
   */
  private async settlePages(): Promise<void> {
    if (this.switching) {
      await this.switching.catch(() => undefined)
      return
    }
    if (!this.pendingSwitch || this.closed || !this.cdp) return
    if (this.busy) return
    const target = this.pendingSwitch
    this.pendingSwitch = undefined
    const task = this.doSwitch(target)
    this.switching = task
    try {
      await task
    } finally {
      if (this.switching === task) this.switching = undefined
    }
  }

  private scheduleSwitch(targetId: string, reason: string): void {
    if (this.closed || !this.cdp || targetId === this.pageTargetId) return
    this.pendingSwitch = { targetId, reason }
    void this.settlePages()
  }

  private trackPage(info: TargetInfoLike): void {
    if (!info.targetId) return
    this.knownPages.set(info.targetId, { url: info.url, title: info.title })
  }

  /** 新页出现：无管理页时直接接管；空白页观察；内部页忽略；opener 链 / 非空白新页跟随 */
  private handleTargetCreated(raw: unknown): void {
    const info = (raw as { targetInfo?: TargetInfoLike }).targetInfo
    if (!info || info.type !== 'page' || !info.targetId) return
    this.trackPage(info)
    if (info.targetId === this.pageTargetId) return
    if (!this.pageTargetId) {
      this.scheduleSwitch(info.targetId, '接管可用页面')
      return
    }
    const url = info.url ?? ''
    if (isBlankUrl(url)) {
      // Ctrl+T 空白页：先观察，真实导航后再跟随（避免开个空白页就抢画面）
      this.blankPages.add(info.targetId)
      return
    }
    if (isInternalUrl(url)) return
    if (info.openerId && info.openerId === this.pageTargetId) {
      this.scheduleSwitch(info.targetId, '跟随当前页打开的新页面')
      return
    }
    this.scheduleSwitch(info.targetId, '跟随新打开的页面')
  }

  /** 页面元数据变化：观察中的空白页开始真实访问 → 跟随；当前页地址同步 */
  private handleTargetInfoChanged(raw: unknown): void {
    const info = (raw as { targetInfo?: TargetInfoLike }).targetInfo
    if (!info || info.type !== 'page' || !info.targetId) return
    this.trackPage(info)
    const url = info.url ?? ''
    if (info.targetId === this.pageTargetId) {
      if (!isBlankUrl(url)) this.currentUrl = url
      return
    }
    if (!this.blankPages.has(info.targetId)) return
    if (isBlankUrl(url)) return
    this.blankPages.delete(info.targetId)
    if (isInternalUrl(url)) return
    this.scheduleSwitch(info.targetId, '新标签页开始访问')
  }

  /** 当前管理页被关闭：回退到剩余页面；无剩余页则进入无页状态 */
  private handleTargetDestroyed(raw: unknown): void {
    const { targetId } = raw as { targetId?: string }
    if (!targetId) return
    this.knownPages.delete(targetId)
    this.blankPages.delete(targetId)
    if (targetId !== this.pageTargetId) return
    this.pageTargetId = undefined
    const fallback = [...this.knownPages.keys()].pop()
    if (fallback) {
      this.scheduleSwitch(fallback, '当前页面已关闭，回退到剩余页面')
      return
    }
    this.currentUrl = undefined
    this.recordStep({ action: 'page_closed', ok: true, detail: '所有页面已关闭（浏览器无可用标签页）' })
  }

  /** 切换管理页：停旧页采集 → attach 新页 → 重开采集（帧 / 控制台 / 地址随新页复位） */
  private async doSwitch(target: { targetId: string; reason: string }): Promise<void> {
    const cdp = this.requireCdp()
    const started = Date.now()
    const from = this.currentUrl
    const previousTarget = this.pageTargetId
    try {
      const oldSession = cdp.pageSessionId
      if (oldSession) {
        await cdp.send('Page.stopScreencast', {}, { timeoutMs: 3_000 }).catch(() => undefined)
        await cdp.detachSession(oldSession).catch(() => undefined)
      }
      await cdp.attachToTarget(target.targetId)
      this.pageTargetId = target.targetId
      await cdp.send('Page.enable', {}, { timeoutMs: 10_000 })
      await cdp.send('Runtime.enable', {}, { timeoutMs: 10_000 })
      try {
        await cdp.send('Log.enable', {}, { timeoutMs: 10_000 })
      } catch {
        // Log 域不可用：控制台仍可经 Runtime 事件采集
      }
      try {
        await cdp.send(
          'Emulation.setDeviceMetricsOverride',
          { width: this.viewport.width, height: this.viewport.height, deviceScaleFactor: 1, mobile: false },
          { timeoutMs: 10_000 },
        )
      } catch {
        // 部分老版本不支持：忽略
      }
      this.consoleBuffer = [] // 新页上下文：控制台缓冲区随切换清空
      const url = await cdp
        .send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          { timeoutMs: 10_000 },
        )
        .then((res) => (typeof res.result?.value === 'string' ? res.result.value : undefined))
        .catch(() => undefined)
      this.currentUrl = url ?? this.knownPages.get(target.targetId)?.url
      await cdp.send(
        'Page.startScreencast',
        {
          format: 'jpeg',
          quality: this.cfg.browserFrameQuality,
          maxWidth: this.viewport.width,
          maxHeight: this.viewport.height,
          everyNthFrame: 1,
        },
        { timeoutMs: 10_000 },
      )
      this.recordStep({
        action: 'switch_page',
        args: { from, to: this.currentUrl },
        ok: true,
        durationMs: Date.now() - started,
        detail: `${target.reason}：${this.currentUrl ?? '未知地址'}`,
      })
      getLogger().info(
        { browserSessionId: this.id, from, to: this.currentUrl, reason: target.reason },
        '浏览器管理页已切换',
      )
    } catch (err) {
      // attach 失败：旧 session 已断开且新页未接管 → 置空，让后续新页可重新接管
      if (this.pageTargetId === previousTarget) this.pageTargetId = undefined
      this.recordStep({
        action: 'switch_page',
        args: { target: target.targetId },
        ok: false,
        durationMs: Date.now() - started,
        detail: (err as Error).message,
      })
      getLogger().warn({ err, target: target.targetId }, '浏览器页面切换失败')
    }
  }

  // ---------- 控制权 ----------

  /** 人工接管（面板 watch → takeover；输入开始生效） */
  async takeover(actor = 'human'): Promise<void> {
    this.controller = 'human'
    this.setState('human')
    this.recordStep({ actor: 'human', action: 'takeover', ok: true, detail: `${actor} 接管控制` })
  }

  /** 归还控制权给 Agent */
  async release(actor = 'human'): Promise<void> {
    this.controller = 'agent'
    this.setState('ready')
    this.recordStep({ actor: 'human', action: 'release', ok: true, detail: `${actor} 归还控制` })
  }

  /** Agent 主动请求人工介入（登录 / 验证码 / 敏感确认） */
  async requestHuman(reason: string): Promise<void> {
    this.recordStep({ actor: 'agent', action: 'request_human', ok: true, detail: reason })
    this.setState('awaiting_human')
  }

  /** 人工输入（接管期间由 StreamHub input 频道调用） */
  async handleHumanInput(input: HumanInput): Promise<void> {
    await this.rawInput(input)
  }

  // ---------- 人工输入原语（也用于 agent 输入的底层实现） ----------

  private async rawInput(input: HumanInput): Promise<void> {
    await this.waitReconnect() // 断线重连中：等待恢复结果
    const cdp = this.requireCdp()
    switch (input.kind) {
      case 'mouse': {
        const type =
          input.type === 'down' ? 'mousePressed' : input.type === 'up' ? 'mouseReleased' : 'mouseMoved'
        await cdp.send(
          'Input.dispatchMouseEvent',
          {
            type,
            x: input.x,
            y: input.y,
            button: input.button ?? 'left',
            clickCount: type === 'mouseMoved' ? 0 : 1,
            modifiers: input.modifiers ?? 0,
          },
          { timeoutMs: 5_000 },
        )
        return
      }
      case 'wheel': {
        await cdp.send(
          'Input.dispatchMouseEvent',
          {
            type: 'mouseWheel',
            x: input.x,
            y: input.y,
            deltaX: input.deltaX ?? 0,
            deltaY: input.deltaY ?? 0,
          },
          { timeoutMs: 5_000 },
        )
        return
      }
      case 'key': {
        const mapped = KEY_MAP[input.key]
        const base = {
          key: input.key,
          code: mapped?.code ?? (input.key.length === 1 ? `Key${input.key.toUpperCase()}` : input.key),
          windowsVirtualKeyCode: mapped?.keyCode ?? input.key.toUpperCase().charCodeAt(0),
          modifiers: input.modifiers ?? 0,
        }
        if (
          input.type === 'char' ||
          (input.type === 'down' && !mapped && !input.modifiers && input.key.length === 1)
        ) {
          await cdp.send('Input.insertText', { text: input.key }, { timeoutMs: 5_000 })
          return
        }
        const type = input.type === 'up' ? 'keyUp' : 'keyDown'
        // type='char' 只触发 keypress（不触发 keydown 监听器，React onKeyDown / 表单 Enter 提交会漏）；
        // keyDown + text 同时覆盖 keydown 与字符输入
        await cdp.send(
          'Input.dispatchKeyEvent',
          input.type === 'down' && mapped?.text
            ? { ...base, type: 'keyDown', text: mapped.text }
            : { ...base, type },
          { timeoutMs: 5_000 },
        )
        return
      }
      case 'text': {
        await cdp.send('Input.insertText', { text: input.text }, { timeoutMs: 5_000 })
        return
      }
      case 'paste': {
        await cdp.send('Input.insertText', { text: input.text }, { timeoutMs: 5_000 })
        return
      }
      default:
        throw new Error(`不支持的输入类型：${(input as { kind: string }).kind}`)
    }
  }

  // ---------- Agent 动作（全部经串行链 + 等待人工释放） ----------

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.opChain.then(async () => {
      await this.waitReconnect() // 断线重连中：等待恢复结果
      if (this.closed) throw new Error('浏览器会话已关闭')
      await this.waitForAgentTurn()
      await this.settlePages() // 动作边界清结待执行的页面切换
      this.busy = true
      this.setState('acting')
      try {
        return await fn()
      } finally {
        this.busy = false
        if (!this.closed && this.controller === 'agent') this.setState('ready')
        if (this.pendingSwitch) void this.settlePages()
      }
    })
    this.opChain = task.then(
      () => undefined,
      () => undefined,
    )
    return task
  }

  private async waitForAgentTurn(): Promise<void> {
    const deadline = Date.now() + HUMAN_WAIT_TIMEOUT_MS
    while (this.controller === 'human') {
      if (Date.now() > deadline) throw new Error('人工接管中：Agent 动作等待超时（60s）')
      await sleep(300)
    }
  }

  async navigate(url: string): Promise<{ url: string; title?: string }> {
    return await this.runExclusive(async () => {
      const cdp = this.requireCdp()
      const normalized = normalizeUrl(url)
      const started = Date.now()
      try {
        const load = this.waitEvent('Page.loadEventFired', 15_000)
        await cdp.send('Page.navigate', { url: normalized }, { timeoutMs: 15_000 })
        await load.catch(() => undefined) // 加载超时不致命（SPA / 长轮询页面）
        this.currentUrl = normalized
        const title = await this.evaluate<string>('document.title').catch(() => undefined)
        const detail = title ? `${title}` : undefined
        await this.recordStepWithShot({
          action: 'navigate',
          args: { url: normalized },
          ok: true,
          durationMs: Date.now() - started,
          detail,
        })
        return { url: normalized, title }
      } catch (err) {
        await this.recordStepWithShot({
          action: 'navigate',
          args: { url: normalized },
          ok: false,
          durationMs: Date.now() - started,
          detail: (err as Error).message,
        })
        throw err
      }
    })
  }

  async snapshot(): Promise<SnapshotElement[]> {
    const expression = SNAPSHOT_EXPRESSION
    const raw = await this.evaluate<SnapshotElement[]>(expression)
    return Array.isArray(raw) ? raw : []
  }

  async clickBySelector(selector: string): Promise<void> {
    await this.runExclusive(async () => {
      const started = Date.now()
      try {
        const point = await this.elementCenter(selector)
        await this.rawInput({ kind: 'mouse', type: 'down', x: point.x, y: point.y })
        await this.rawInput({ kind: 'mouse', type: 'up', x: point.x, y: point.y })
        await sleep(120)
        await this.recordStepWithShot({
          action: 'click',
          args: { selector },
          ok: true,
          durationMs: Date.now() - started,
        })
      } catch (err) {
        await this.recordStepWithShot({
          action: 'click',
          args: { selector },
          ok: false,
          durationMs: Date.now() - started,
          detail: (err as Error).message,
        })
        throw err
      }
    })
  }

  async clickAt(x: number, y: number, actor: 'agent' | 'human' = 'agent'): Promise<void> {
    if (actor === 'human') {
      await this.rawInput({ kind: 'mouse', type: 'down', x, y })
      await this.rawInput({ kind: 'mouse', type: 'up', x, y })
      return
    }
    await this.runExclusive(async () => {
      const started = Date.now()
      await this.rawInput({ kind: 'mouse', type: 'down', x, y })
      await this.rawInput({ kind: 'mouse', type: 'up', x, y })
      await sleep(120)
      await this.recordStepWithShot({
        action: 'click_at',
        args: { x, y },
        ok: true,
        durationMs: Date.now() - started,
      })
    })
  }

  async fill(selector: string, value: string, opts: { submit?: boolean } = {}): Promise<void> {
    await this.runExclusive(async () => {
      const started = Date.now()
      try {
        const point = await this.elementCenter(selector)
        await this.rawInput({ kind: 'mouse', type: 'down', x: point.x, y: point.y })
        await this.rawInput({ kind: 'mouse', type: 'up', x: point.x, y: point.y })
        // 全选清空（跨平台快捷键 Meta/Ctrl+A）
        await this.rawInput({
          kind: 'key',
          type: 'down',
          key: 'a',
          modifiers: process.platform === 'darwin' ? 4 : 2,
        })
        await this.rawInput({
          kind: 'key',
          type: 'up',
          key: 'a',
          modifiers: process.platform === 'darwin' ? 4 : 2,
        })
        await this.rawInput({ kind: 'text', text: value })
        if (opts.submit) {
          await this.rawInput({ kind: 'key', type: 'down', key: 'Enter' })
          await this.rawInput({ kind: 'key', type: 'up', key: 'Enter' })
        }
        await sleep(120)
        await this.recordStepWithShot({
          action: 'fill',
          args: {
            selector,
            value: value.length > 80 ? `${value.slice(0, 80)}…` : value,
            submit: Boolean(opts.submit),
          },
          ok: true,
          durationMs: Date.now() - started,
        })
      } catch (err) {
        await this.recordStepWithShot({
          action: 'fill',
          args: { selector },
          ok: false,
          durationMs: Date.now() - started,
          detail: (err as Error).message,
        })
        throw err
      }
    })
  }

  async press(key: string, modifiers = 0): Promise<void> {
    await this.runExclusive(async () => {
      const normalized = normalizeKeyName(key)
      await this.rawInput({ kind: 'key', type: 'down', key: normalized, modifiers })
      await this.rawInput({ kind: 'key', type: 'up', key: normalized, modifiers })
      await sleep(100)
      await this.recordStepWithShot({ action: 'press', args: { key: normalized, modifiers }, ok: true })
    })
  }

  async scroll(deltaX: number, deltaY: number): Promise<void> {
    await this.runExclusive(async () => {
      const x = Math.round(this.viewport.width / 2)
      const y = Math.round(this.viewport.height / 2)
      await this.rawInput({ kind: 'wheel', x, y, deltaX, deltaY })
      await sleep(120)
      await this.recordStepWithShot({ action: 'scroll', args: { deltaX, deltaY }, ok: true })
    })
  }

  async back(): Promise<void> {
    await this.runExclusive(async () => {
      await this.evaluateRaw('history.back()')
      await sleep(500)
      await this.recordStepWithShot({ action: 'back', ok: true })
    })
  }

  async forward(): Promise<void> {
    await this.runExclusive(async () => {
      await this.evaluateRaw('history.forward()')
      await sleep(500)
      await this.recordStepWithShot({ action: 'forward', ok: true })
    })
  }

  async waitFor(opts: { selector?: string; ms?: number; timeoutMs?: number }): Promise<void> {
    await this.runExclusive(async () => {
      const started = Date.now()
      if (opts.ms && opts.ms > 0) {
        await sleep(Math.min(opts.ms, 30_000))
      } else if (opts.selector) {
        const deadline = Date.now() + Math.min(opts.timeoutMs ?? 10_000, 30_000)
        let found = false
        while (Date.now() < deadline) {
          const exists = await this.evaluate<boolean>(
            `Boolean(document.querySelector(${JSON.stringify(opts.selector)}))`,
          ).catch(() => false)
          if (exists) {
            found = true
            break
          }
          await sleep(250)
        }
        if (!found) throw new Error(`等待元素超时：${opts.selector}`)
      }
      await this.recordStepWithShot({
        action: 'wait_for',
        args: { selector: opts.selector, ms: opts.ms },
        ok: true,
        durationMs: Date.now() - started,
      })
    })
  }

  /** 任意 JS 求值（高权限：browser_eval 工具标记敏感，经审批门） */
  async evaluate<T = unknown>(expression: string): Promise<T> {
    return await this.evaluateRaw<T>(expression)
  }

  private async evaluateRaw<T = unknown>(expression: string): Promise<T> {
    await this.waitReconnect() // 断线重连中：等待恢复结果
    await this.settlePages() // 评估前先对齐管理页（切换待执行时在此清结）
    const cdp = this.requireCdp()
    const res = await cdp.send<{
      result?: { value?: unknown; description?: string }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, userGesture: true },
      { timeoutMs: 15_000 },
    )
    if (res.exceptionDetails) {
      throw new Error(
        `页面 JS 异常：${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? '未知'}`,
      )
    }
    return res.result?.value as T
  }

  /** 截图（返回文件绝对路径；用于时间轴证据与人工查看） */
  async screenshot(label = 'shot'): Promise<string> {
    return await this.runExclusive(async () => {
      const started = Date.now()
      const file = await this.captureScreenshot(label)
      await this.recordStep({
        action: 'screenshot',
        args: { label },
        ok: true,
        durationMs: Date.now() - started,
        screenshotPath: file,
      })
      return file
    })
  }

  private async captureScreenshot(label: string): Promise<string> {
    const cdp = this.requireCdp()
    const res = await cdp.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality: this.cfg.browserFrameQuality },
      { timeoutMs: 15_000 },
    )
    const dir = path.join(this.cfg.browserScreenshotDir, this.id)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${String(Date.now())}-${sanitizeLabel(label)}.jpg`)
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'))
    return file
  }

  /** 取得元素中心坐标（不可见 / 不存在时给出明确错误） */
  private async elementCenter(selector: string): Promise<{ x: number; y: number }> {
    const raw = await this.evaluate<{ ok: boolean; x?: number; y?: number; reason?: string }>(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { ok: false, reason: '元素不存在' };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { ok: false, reason: '元素尺寸为 0（不可见）' };
        return { ok: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    )
    if (!raw?.ok || raw.x === undefined || raw.y === undefined) {
      throw new Error(`定位元素失败：${selector}（${raw?.reason ?? '未知原因'}）`)
    }
    return { x: raw.x, y: raw.y }
  }

  // ---------- 步骤与事件辅助 ----------

  private waitEvent(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const cdp = this.requireCdp()
      const timer = setTimeout(() => {
        stop()
        resolve()
      }, timeoutMs)
      const stop = cdp.on(method, (_params, sessionId) => {
        // 只认当前管理页的事件（切换竞态窗口内旧页事件不误触发）
        if (sessionId && sessionId !== cdp.pageSessionId) return
        clearTimeout(timer)
        stop()
        resolve()
      })
    })
  }

  private async recordStepWithShot(input: {
    action: string
    args?: Record<string, unknown>
    ok: boolean
    durationMs?: number
    detail?: string
  }): Promise<void> {
    let screenshotPath: string | undefined
    if (this.cfg.browserStepShots && input.action !== 'screenshot') {
      try {
        screenshotPath = await this.captureScreenshot(input.action)
      } catch {
        // 截图失败不阻断动作
      }
    }
    this.recordStep({ ...input, screenshotPath })
    if (!input.ok) {
      getLogger().warn({ action: input.action, detail: input.detail }, '浏览器动作失败')
    }
  }

  private recordStep(input: {
    actor?: 'agent' | 'human'
    action: string
    args?: Record<string, unknown>
    ok: boolean
    durationMs?: number
    detail?: string
    screenshotPath?: string
  }): void {
    this.stepSeq += 1
    const step: BrowserStepRecord = {
      seq: this.stepSeq,
      actor: input.actor ?? (this.controller === 'human' ? 'human' : 'agent'),
      action: input.action,
      args: input.args,
      url: this.currentUrl,
      screenshotPath: input.screenshotPath,
      ok: input.ok,
      durationMs: input.durationMs,
      detail: input.detail,
      ts: new Date().toISOString(),
    }
    try {
      this.callbacks.onStep(step)
    } catch {
      // 步骤记录失败不影响动作
    }
  }

  private requireCdp(): CdpClient {
    if (!this.cdp) throw new Error('浏览器会话尚未建立 CDP 连接')
    return this.cdp
  }
}

// ---------- 人工输入类型 ----------

export type HumanInput =
  | {
      kind: 'mouse'
      type: 'down' | 'up' | 'move'
      x: number
      y: number
      button?: 'left' | 'right' | 'middle'
      modifiers?: number
    }
  | { kind: 'wheel'; x: number; y: number; deltaX?: number; deltaY?: number }
  | { kind: 'key'; type: 'down' | 'up' | 'char'; key: string; modifiers?: number }
  | { kind: 'text'; text: string }
  | { kind: 'paste'; text: string }

function normalizeUrl(url: string): string {
  const raw = url.trim()
  if (!raw) throw new Error('URL 为空')
  if (raw === 'about:blank') return raw
  const withProto = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`
  const parsed = new URL(withProto)
  if (!['http:', 'https:', 'about:'].includes(parsed.protocol)) {
    throw new Error(`不支持的协议：${parsed.protocol}（仅允许 http/https）`)
  }
  return parsed.toString()
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40)
}

/** 页面可交互元素快照（对 LLM 友好的紧凑结构） */
const SNAPSHOT_EXPRESSION = `(() => {
  const selectors = 'a, button, input, textarea, select, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  const nodes = Array.from(document.querySelectorAll(selectors));
  const visible = nodes.filter((el) => {
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  });
  return visible.slice(0, 120).map((el, index) => {
    const r = el.getBoundingClientRect();
    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const id = el.id ? '#' + CSS.escape(el.id) : '';
    const name = el.getAttribute('name') ? '[name="' + el.getAttribute('name') + '"]' : '';
    let selector = tag + id;
    if (!id && name) selector = tag + name;
    if (!id && !name) {
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
        selector = tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
      }
    }
    return {
      index,
      tag,
      text: text || undefined,
      role: el.getAttribute('role') || undefined,
      name: el.getAttribute('name') || el.getAttribute('aria-label') || undefined,
      href: tag === 'a' ? (el.getAttribute('href') || undefined) : undefined,
      selector,
      _rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
    };
  });
})()`
