/**
 * BrowserRuntime（M22）：浏览器会话注册表与生命周期编排。
 *
 * 职责：
 * - ensureForSession：懒启动（managed/local）或接入（remote）；同会话并发只建一次；
 * - 持久化：browser_sessions（状态/端点/控制器）+ browser_steps（动作时间轴 + 截图证据）；
 * - 帧/事件分发：发布到 StreamHub topic `browser:<id>`（帧 + 状态 + 步骤）；
 * - 关闭语义：close 会清理「本进程启动的」浏览器进程；remote/复用实例只断开 CDP。
 */
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { BrowserSessionInfo, BrowserState, BrowserStepInfo } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { getLogger } from '../logger.js'
import type { AppDb } from '../store/db.js'
import type { AuditStore } from '../store/audit.js'
import type { ConnectionStore } from '../store/connections.js'
import { CdpClient, resolveCdpEndpoint } from './cdp.js'
import { killLaunchedBrowser, launchBrowser, openInSystemBrowser } from './launcher.js'
import {
  BrowserSession,
  type BrowserSessionCallbacks,
  type BrowserFrame,
  type BrowserStepRecord,
} from './session.js'

export interface BrowserEnsureOptions {
  /** 显式指定 chrome 类型连接（其 config 提供 backend/executable/endpoint/startUrl） */
  connectionId?: string
  startUrl?: string
  backend?: 'managed' | 'local' | 'remote'
  headless?: boolean
}

/** 帧写库节流间隔（帧流持续产出，last_frame_at 仅作展示用，无需每帧落库） */
const FRAME_WRITE_INTERVAL_MS = 5_000

export interface BrowserRuntimeDeps {
  cfg: AppConfig
  db: AppDb
  audit: AuditStore
  connections: ConnectionStore
  /** 帧/步骤/状态发布（StreamHub）；topic = `browser:<browserSessionId>` */
  publish: (topic: string, message: Record<string, unknown>) => void
  /** 会话级通知（notify:op / notify:browser-status 由 index.ts 注入） */
  notify?: (event: { sessionId: string; type: 'browser-status' | 'op'; payload: Record<string, unknown> }) => void
}

interface BrowserSessionRow {
  id: string
  session_id: string
  connection_id: string | null
  backend: string
  state: string
  controller: string
  viewport_w: number | null
  viewport_h: number | null
  endpoint: string | null
  external_pid: number | null
  created_at: string
  closed_at: string | null
  last_frame_at: string | null
}

interface BrowserStepRow {
  id: number
  browser_session_id: string
  session_id: string
  run_id: string | null
  agent_id: string | null
  seq: number
  actor: string
  action: string
  args: string | null
  url: string | null
  screenshot_path: string | null
  ok: number
  duration_ms: number | null
  detail: string | null
  ts: string
}

export class BrowserRuntime {
  private readonly sessions = new Map<string, BrowserSession>()
  /** 业务会话 → 当前浏览器会话（一个业务会话同时一个浏览器） */
  private readonly byBusinessSession = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<BrowserSession>>()
  /** 帧写库节流：browserSessionId → 上次落库时间 */
  private readonly lastFrameWriteAt = new Map<string, number>()

  constructor(private readonly deps: BrowserRuntimeDeps) {}

  // ---------- 查询 ----------

  /** 业务会话的活跃浏览器（不存在返回 undefined） */
  activeFor(sessionId: string): BrowserSession | undefined {
    const id = this.byBusinessSession.get(sessionId)
    return id ? this.sessions.get(id) : undefined
  }

  get(browserSessionId: string): BrowserSession | undefined {
    return this.sessions.get(browserSessionId)
  }

  list(): BrowserSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info())
  }

  listForSession(sessionId: string): BrowserSessionInfo[] {
    return this.list().filter((s) => s.sessionId === sessionId)
  }

  /** 从持久化恢复历史（面板展示已关闭会话） */
  history(sessionId: string, limit = 20): BrowserSessionInfo[] {
    const rows = this.deps.db.all<BrowserSessionRow>(
      'SELECT * FROM browser_sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT ?',
      sessionId,
      limit,
    )
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      connectionId: row.connection_id ?? undefined,
      backend: row.backend as BrowserSessionInfo['backend'],
      state: row.state as BrowserState,
      controller: row.controller as 'agent' | 'human',
      viewport:
        row.viewport_w && row.viewport_h ? { width: row.viewport_w, height: row.viewport_h } : undefined,
      endpoint: row.endpoint ?? undefined,
      createdAt: row.created_at,
      closedAt: row.closed_at ?? undefined,
      lastFrameAt: row.last_frame_at ?? undefined,
      topic: `browser:${row.id}`,
    }))
  }

  steps(browserSessionId: string, limit = 200): BrowserStepInfo[] {
    const rows = this.deps.db.all<BrowserStepRow>(
      'SELECT * FROM browser_steps WHERE browser_session_id = ? ORDER BY seq ASC LIMIT ?',
      browserSessionId,
      limit,
    )
    return rows.map((row) => ({
      id: Number(row.id),
      browserSessionId: row.browser_session_id,
      sessionId: row.session_id,
      runId: row.run_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      seq: Number(row.seq),
      actor: row.actor as 'agent' | 'human',
      action: row.action,
      args: row.args ? safeParse(row.args) : undefined,
      url: row.url ?? undefined,
      screenshotPath: row.screenshot_path ?? undefined,
      ok: row.ok === 1,
      durationMs: row.duration_ms ?? undefined,
      detail: row.detail ?? undefined,
      ts: row.ts,
    }))
  }

  // ---------- 生命周期 ----------

  /**
   * 懒启动 / 接入浏览器（同业务会话并发调用合并为一次）。
   * backend 决策：opts.backend → 连接 config.backend → cfg.browserDefaultBackend。
   */
  async ensureForSession(sessionId: string, opts: BrowserEnsureOptions = {}): Promise<BrowserSession> {
    const existing = this.activeFor(sessionId)
    if (existing && !existing.isClosed()) return existing
    const pending = this.inflight.get(sessionId)
    if (pending) return pending
    const task = this.doEnsure(sessionId, opts).finally(() => this.inflight.delete(sessionId))
    this.inflight.set(sessionId, task)
    return await task
  }

  private async doEnsure(sessionId: string, opts: BrowserEnsureOptions): Promise<BrowserSession> {
    const { cfg, connections } = this.deps
    const connection = opts.connectionId ? connections.get(opts.connectionId) : undefined
    if (opts.connectionId && !connection) throw new Error('浏览器连接不存在')
    if (connection && connection.kind !== 'chrome') {
      throw new Error(`连接「${connection.name}」不是浏览器类型（${connection.kind}）`)
    }
    const config = connection?.config ?? {}
    const backend =
      opts.backend ??
      (typeof config.backend === 'string' ? (config.backend as 'managed' | 'local' | 'remote') : undefined) ??
      cfg.browserDefaultBackend
    const startUrl =
      opts.startUrl ?? (typeof config.startUrl === 'string' && config.startUrl ? config.startUrl : undefined)
    // 启动形态决策链：opts.headless → 连接 config.headless → 全局 BROWSER_HEADLESS（默认无头）
    const headless =
      opts.headless ?? (typeof config.headless === 'boolean' ? config.headless : cfg.browserHeadless)
    const id = `bs_${randomUUID().slice(0, 8)}`

    let sessionRef: BrowserSession | undefined
    const callbacks: BrowserSessionCallbacks = {
      onFrame: (frame: BrowserFrame) => {
        this.markFrame(id)
        this.deps.publish(`browser:${id}`, { type: 'frame', ...frame })
      },
      onState: (state: BrowserState, controller: 'agent' | 'human') => {
        this.deps.db.run('UPDATE browser_sessions SET state = ?, controller = ? WHERE id = ?', state, controller, id)
        this.deps.publish(`browser:${id}`, { type: 'state', state, controller })
        this.deps.notify?.({
          sessionId,
          type: 'browser-status',
          payload: { browserSessionId: id, sessionId, state, controller },
        })
      },
      onStep: (step: BrowserStepRecord) => {
        this.persistStep(id, sessionId, sessionRef?.context ?? {}, step)
        this.deps.publish(`browser:${id}`, { type: 'step', step: { ...step, browserSessionId: id, sessionId } })
        // 时间轴同步给操作流（右侧面板「操作」页签）
        this.deps.notify?.({
          sessionId,
          type: 'op',
          payload: {
            id: `${id}:${step.seq}`,
            ts: step.ts,
            sessionId,
            runId: sessionRef?.context.runId,
            actor: step.actor === 'human' ? 'user' : (sessionRef?.context.agentId ?? 'agent'),
            kind: 'browser',
            action: `browser.${step.action}`,
            target: step.url,
            status: step.ok ? 'ok' : 'error',
            durationMs: step.durationMs,
            summary: step.detail,
          },
        })
      },
      onClosed: (reason: string) => {
        this.deps.db.run('UPDATE browser_sessions SET closed_at = ? WHERE id = ?', new Date().toISOString(), id)
        this.byBusinessSession.delete(sessionId)
        this.deps.publish(`browser:${id}`, { type: 'closed', reason })
        this.deps.audit.record({
          actor: 'system',
          action: 'browser.close',
          resourceType: 'browser_session',
          resourceId: id,
          sessionId,
          detail: { reason },
        })
      },
    }

    // 启动 / 接入
    let endpoint: string
    let child: ChildProcess | undefined
    let external = false
    let pid: number | undefined
    if (backend === 'remote') {
      const rawEndpoint =
        (typeof config.endpoint === 'string' && config.endpoint) ||
        (connection ? String(this.deps.connections.getSecret(connection.id)?.endpoint ?? '') : '')
      if (!rawEndpoint) throw new Error('remote 模式需要配置 CDP 端点（config.endpoint）')
      endpoint = await resolveCdpEndpoint(rawEndpoint)
      external = true
      pid = undefined
    } else {
      const profileRoot = path.join(cfg.dataDir, 'browser-profile')
      const launched = await launchBrowser({
        backend,
        profileRoot,
        executable:
          (typeof config.executable === 'string' && config.executable) || cfg.browserExecutable || undefined,
        headless,
        viewport: { width: cfg.browserViewportWidth, height: cfg.browserViewportHeight },
        startUrl: startUrl ?? 'about:blank',
      })
      endpoint = launched.endpoint
      child = launched.child
      external = launched.external
      pid = launched.pid
    }

    const cdp = new CdpClient()
    try {
      await cdp.connect(endpoint)
    } catch (err) {
      killLaunchedBrowser(child)
      throw err
    }

    const session = new BrowserSession({
      id,
      sessionId,
      connectionId: connection?.id,
      backend,
      endpoint,
      child,
      external,
      cfg,
      headless,
      callbacks,
    })
    sessionRef = session
    try {
      await session.start(cdp, startUrl)
    } catch (err) {
      await session.close('启动失败')
      killLaunchedBrowser(child)
      throw err
    }

    this.sessions.set(id, session)
    this.byBusinessSession.set(sessionId, id)
    this.deps.db.run(
      `INSERT INTO browser_sessions
         (id, session_id, connection_id, backend, state, controller, viewport_w, viewport_h, endpoint, external_pid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      connection?.id ?? null,
      backend,
      session.state,
      session.controller,
      cfg.browserViewportWidth,
      cfg.browserViewportHeight,
      endpoint,
      pid ?? null,
      session.createdAt,
    )
    this.deps.audit.record({
      actor: 'system',
      action: backend === 'remote' ? 'browser.attach' : 'browser.start',
      resourceType: 'browser_session',
      resourceId: id,
      sessionId,
      detail: { backend, endpoint: endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/browser/***'), external, headless },
    })
    getLogger().info({ browserSessionId: id, sessionId, backend, external, headless }, '浏览器会话就绪')
    return session
  }

  /** 关闭浏览器会话（更新表 + 清理进程 + 移除注册） */
  async close(browserSessionId: string, actor: string): Promise<boolean> {
    const session = this.sessions.get(browserSessionId)
    if (!session) return false
    const child = session.getChild()
    await session.close('用户关闭')
    killLaunchedBrowser(child)
    this.sessions.delete(browserSessionId)
    this.lastFrameWriteAt.delete(browserSessionId)
    this.byBusinessSession.delete(session.sessionId)
    this.deps.db.run('UPDATE browser_sessions SET closed_at = ? WHERE id = ?', new Date().toISOString(), browserSessionId)
    this.deps.audit.record({
      actor,
      action: 'browser.close',
      resourceType: 'browser_session',
      resourceId: browserSessionId,
      sessionId: session.sessionId,
    })
    return true
  }

  /** 关闭业务会话的全部浏览器（会话删除 / 归档时调用） */
  async closeForSession(sessionId: string, actor: string): Promise<number> {
    const ids = this.listForSession(sessionId).map((s) => s.id)
    let closed = 0
    for (const id of ids) {
      if (await this.close(id, actor)) closed++
    }
    return closed
  }

  /** 进程退出清理（index.ts shutdown 钩子） */
  async shutdown(): Promise<void> {
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue
      const child = session.getChild()
      await session.close('服务关闭').catch(() => undefined)
      killLaunchedBrowser(child)
    }
    this.sessions.clear()
    this.byBusinessSession.clear()
    this.lastFrameWriteAt.clear()
  }

  /** 系统默认浏览器打开链接（面板「在系统浏览器打开」） */
  async openExternal(url: string): Promise<void> {
    await openInSystemBrowser(url)
  }

  // ---------- 内部 ----------

  private markFrame(browserSessionId: string): void {
    // 节流：帧流每秒多帧，last_frame_at 仅作展示，避免每帧一次 SQLite 写
    const now = Date.now()
    const last = this.lastFrameWriteAt.get(browserSessionId) ?? 0
    if (now - last < FRAME_WRITE_INTERVAL_MS) return
    this.lastFrameWriteAt.set(browserSessionId, now)
    this.deps.db.run(
      'UPDATE browser_sessions SET last_frame_at = ? WHERE id = ?',
      new Date().toISOString(),
      browserSessionId,
    )
  }

  private persistStep(
    browserSessionId: string,
    sessionId: string,
    context: { runId?: string; agentId?: string },
    step: BrowserStepRecord,
  ): void {
    try {
      this.deps.db.run(
        `INSERT INTO browser_steps
           (browser_session_id, session_id, run_id, agent_id, seq, actor, action, args, url, screenshot_path, ok, duration_ms, detail, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        browserSessionId,
        sessionId,
        context.runId ?? null,
        context.agentId ?? null,
        step.seq,
        step.actor,
        step.action,
        step.args ? JSON.stringify(step.args).slice(0, 4_000) : null,
        step.url ?? null,
        step.screenshotPath ?? null,
        step.ok ? 1 : 0,
        step.durationMs ?? null,
        step.detail?.slice(0, 1_000) ?? null,
        step.ts,
      )
    } catch (err) {
      getLogger().warn({ err, action: step.action }, '浏览器步骤落库失败')
    }
  }
}

function safeParse(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}
