/**
 * BrowserRuntime（M22 / M62）：浏览器会话注册表与生命周期编排。
 *
 * 职责：
 * - ensureForSession：懒启动（managed/local）或接入（remote）；同会话并发只建一次；
 * - 持久化：browser_sessions（状态/端点/控制器/归属/关闭原因）+ browser_steps（动作时间轴 + 截图证据）；
 * - 帧/事件分发：发布到 StreamHub topic `browser:<id>`（帧 + 状态 + 步骤）；
 * - 关闭语义：close 会清理「本进程启动的」浏览器进程；remote/复用实例只断开 CDP。
 *
 * M62 多用户治理（owner 存在才生效；兼容模式行为与旧版一致）：
 * - 归属隔离：Profile 按 owner 命名空间（`browser-profile/u_<userId>/`），复用实例校验注册表归属；
 * - 实例注册表 `.ma-instance.json`：崩溃恢复（pid 命令行双校验）/ 观测 / 复用防御；
 * - 页面分治：同实例多会话各持自有管理页（占用表 + forceFreshTarget + isForeignTarget）；
 * - 配额（先回收再拒绝）与空闲回收（人工接管 / 等待人工 / 有订阅者豁免）；
 * - 关闭链路：会话删除 / 用户删除 / 服务重启 / 启动对账（僵尸行 + 孤儿进程 + 临时目录）；
 * - 连接线：remote 独占租约（shareInstance 显式放开）、重连端点再解析、连接健康回写（30s 节流）、
 *   最小权限复核（会话绑定 + member_use）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildProcess } from 'node:child_process'
import type { BrowserBackend, BrowserSessionInfo, BrowserState, BrowserStepInfo } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { getLogger } from '../logger.js'
import type { AppDb } from '../store/db.js'
import type { AuditStore } from '../store/audit.js'
import type { ConnectionStore } from '../store/connections.js'
import { CdpClient, resolveCdpEndpoint } from './cdp.js'
import { probeEndpoint, readDevToolsActivePort } from './discover.js'
import {
  clearInstanceInfo,
  clearStaleActivePort,
  killLaunchedBrowser,
  killProcessIfOwned,
  launchBrowser,
  openInSystemBrowser,
  readInstanceInfo,
  removeProfileDir,
  writeInstanceInfo,
  type KillOutcome,
  type LaunchResult,
} from './launcher.js'
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
/** M62：连接健康回写节流（同一连接 30s 内至多一次，避免高频抖动） */
const CONNECTION_HEALTH_THROTTLE_MS = 30_000

export interface BrowserRuntimeDeps {
  cfg: AppConfig
  db: AppDb
  audit: AuditStore
  connections: ConnectionStore
  /** 帧/步骤/状态发布（StreamHub）；topic = `browser:<browserSessionId>` */
  publish: (topic: string, message: Record<string, unknown>) => void
  /** 会话级通知（notify:op / notify:browser-status 由 index.ts 注入） */
  notify?: (event: { sessionId: string; type: 'browser-status' | 'op'; payload: Record<string, unknown> }) => void
  /** M62：业务会话归属解析（返回 undefined = 兼容模式：全部多用户治理不生效） */
  ownerOfSession?: (sessionId: string) => string | undefined
  /** M62：帧流订阅计数（空闲回收判定；未注入视为 0） */
  subscriberCount?: (topic: string) => number
  /** M62：管理员判定（member_use 复核；未注入视为 admin） */
  isAdminUser?: (userId: string) => boolean
  /** 测试可注入替身（生产不传）：CDP 客户端工厂（同 BrowserSession.cdpFactory 惯例） */
  cdpFactory?: () => CdpClient
  /** 测试可注入替身（生产不传）：启动器 / 端点解析 / 系统浏览器打开 */
  launcher?: {
    launchBrowser?: typeof launchBrowser
    killLaunchedBrowser?: typeof killLaunchedBrowser
    openInSystemBrowser?: typeof openInSystemBrowser
    resolveCdpEndpoint?: typeof resolveCdpEndpoint
  }
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
  user_id: string | null
  close_reason: string | null
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

/** M62：自启实例的目录清理（managed 删除临时目录；local 保留持久 Profile、清注册表与残留端点） */
function cleanupLaunchedProfile(backend: BrowserBackend, profileDir: string): void {
  clearInstanceInfo(profileDir)
  if (backend === 'managed') removeProfileDir(profileDir)
  else clearStaleActivePort(profileDir)
}

/** 会话截图目录清理（browserStepShots 每个动作一张 JPEG，会话关闭后不再有需要，防磁盘只增不减） */
function removeScreenshotDir(cfg: AppConfig, browserSessionId: string): void {
  try {
    fs.rmSync(path.join(cfg.browserScreenshotDir, browserSessionId), { recursive: true, force: true })
  } catch {
    // 清理失败无妨（目录可能不存在 / 被占用）
  }
}

export class BrowserRuntime {
  private readonly sessions = new Map<string, BrowserSession>()
  /** 业务会话 → 当前浏览器会话（一个业务会话同时一个浏览器） */
  private readonly byBusinessSession = new Map<string, string>()
  private readonly inflight = new Map<string, Promise<BrowserSession>>()
  /** 帧写库节流：browserSessionId → 上次落库时间 */
  private readonly lastFrameWriteAt = new Map<string, number>()
  /** M62：业务会话 → 归属用户（ensure 时登记；undefined = 兼容模式） */
  private readonly owners = new Map<string, string | undefined>()
  /** M62：browserSessionId → profile 目录（自启实例；关闭 / 对账清理用） */
  private readonly profileDirs = new Map<string, string>()
  /** M62：端点 → 管理页占用表（targetId → browserSessionId；同实例多会话页面分治） */
  private readonly pageOwners = new Map<string, Map<string, string>>()
  /** M62：remote 租约（leaseKey → browserSessionId；独占连接防互抢页面） */
  private readonly leases = new Map<string, string>()
  /** M62：连接健康回写节流（connectionId → 上次回写时间） */
  private readonly healthWriteAt = new Map<string, number>()
  private reclaimTimer?: NodeJS.Timeout

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
    return [...this.sessions.values()].map((session) => this.infoOf(session))
  }

  listForSession(sessionId: string): BrowserSessionInfo[] {
    return this.list().filter((s) => s.sessionId === sessionId)
  }

  /** M62：admin 实例总览（含空闲时长 / 订阅数；展示名由路由层 enrich） */
  listDetailed(): Array<BrowserSessionInfo & { idleMs: number; subscribers: number }> {
    const now = Date.now()
    return [...this.sessions.values()].map((session) => ({
      ...this.infoOf(session),
      idleMs: Math.max(0, now - session.lastActiveAt()),
      subscribers: this.deps.subscriberCount?.(`browser:${session.id}`) ?? 0,
    }))
  }

  /** M62：已关闭 / 历史 bsid 的归属用户（回放判定 / 清理兜底） */
  ownerOf(browserSessionId: string): string | undefined {
    try {
      const row = this.deps.db.get<{ user_id: string | null }>(
        'SELECT user_id FROM browser_sessions WHERE id = ?',
        browserSessionId,
      )
      return row?.user_id ?? undefined
    } catch {
      return undefined
    }
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
      ownerId: row.user_id ?? undefined,
      closeReason: row.close_reason ?? undefined,
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
    // M62：多用户治理开关（owner 存在才生效；兼容模式行为与旧版一致）
    const ownerId = this.deps.ownerOfSession?.(sessionId)
    if (connection && ownerId) {
      // 最小权限复核：会话绑定（与 db / mcp 口径一致）+ 成员可用性
      if (!connection.enabled) throw new Error(`连接「${connection.name}」已禁用`)
      if (!connections.isBound(sessionId, connection.id)) {
        throw new Error(`会话未绑定连接「${connection.name}」：请在「连接管理」中绑定后重试`)
      }
      const admin = this.deps.isAdminUser ? this.deps.isAdminUser(ownerId) : true
      // M57 P3：个人连接仅属主可用（会话属主 = 连接属主时放行）
      const ownsPersonal = connections.ownerOf?.(connection.id) === ownerId
      if (!admin && !connections.memberUsable(connection.id) && !ownsPersonal) {
        throw new Error(`连接「${connection.name}」不允许成员使用（请联系管理员开放）`)
      }
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
    // M62：配额（仅多用户治理；先回收本用户空闲实例再拒绝）
    if (ownerId) await this.ensureCapacity(ownerId)
    const id = `bs_${randomUUID().slice(0, 8)}`

    const sessionRef: { session?: BrowserSession } = {}
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
        // M62-B：异常态回写连接健康（真实接入结果 = 连接卡状态）
        if (state === 'error') {
          this.writeConnectionHealth(connection?.id, 'error', sessionRef.session?.getCloseReason() ?? '浏览器会话异常')
        }
      },
      onStep: (step: BrowserStepRecord) => {
        this.persistStep(id, sessionId, sessionRef.session?.context ?? {}, step)
        this.deps.publish(`browser:${id}`, { type: 'step', step: { ...step, browserSessionId: id, sessionId } })
        // 时间轴同步给操作流（右侧面板「操作」页签）
        this.deps.notify?.({
          sessionId,
          type: 'op',
          payload: {
            id: `${id}:${step.seq}`,
            ts: step.ts,
            sessionId,
            runId: sessionRef.session?.context.runId,
            actor: step.actor === 'human' ? 'user' : (sessionRef.session?.context.agentId ?? 'agent'),
            kind: 'browser',
            action: `browser.${step.action}`,
            target: step.url,
            status: step.ok ? 'ok' : 'error',
            durationMs: step.durationMs,
            summary: step.detail,
          },
        })
        // M62-B：自动重连成功 = 连接仍可用（节流回写）
        if (step.action === 'reconnect' && step.ok) this.writeConnectionHealth(connection?.id, 'ok')
      },
      onClosed: (reason: string) => {
        this.deps.db.run(
          "UPDATE browser_sessions SET closed_at = ?, state = 'closed', close_reason = ? WHERE id = ?",
          new Date().toISOString(),
          reason,
          id,
        )
        this.byBusinessSession.delete(sessionId)
        this.owners.delete(sessionId)
        this.profileDirs.delete(id)
        this.releasePageOwnership(endpoint, id)
        this.releaseLease(id)
        removeScreenshotDir(this.deps.cfg, id)
        // M62：重连耗尽（自启实例大概率已死）→ 校验归属后清理进程 / 目录；远程与复用实例不动
        if (child && profileDir) {
          void (async () => {
            const info = readInstanceInfo(profileDir)
            const outcome: KillOutcome = info?.pid
              ? await killProcessIfOwned(info.pid, profileDir).catch(() => 'foreign' as KillOutcome)
              : 'gone'
            if (outcome !== 'foreign') cleanupLaunchedProfile(backend, profileDir)
          })()
        }
        this.deps.publish(`browser:${id}`, { type: 'closed', reason })
        this.deps.audit.record({
          actor: 'system',
          action: 'browser.close',
          userId: ownerId,
          resourceType: 'browser_session',
          resourceId: id,
          sessionId,
          detail: { reason, owner: ownerId },
        })
      },
    }

    // 启动 / 接入
    let endpoint: string
    let child: ChildProcess | undefined
    let external = false
    let pid: number | undefined
    let profileDir: string | undefined
    let leaseKey: string | undefined
    let resolveEndpoint: (() => Promise<string | undefined>) | undefined
    if (backend === 'remote') {
      const rawEndpoint =
        (typeof config.endpoint === 'string' && config.endpoint) ||
        (connection ? String(this.deps.connections.getSecret(connection.id)?.endpoint ?? '') : '')
      if (!rawEndpoint) throw new Error('remote 模式需要配置 CDP 端点（config.endpoint）')
      const resolve = this.deps.launcher?.resolveCdpEndpoint ?? resolveCdpEndpoint
      try {
        endpoint = await resolve(rawEndpoint)
      } catch (err) {
        this.writeConnectionHealth(connection?.id, 'error', (err as Error).message)
        throw err
      }
      external = true
      pid = undefined
      // M62-B：remote 独占租约（默认独占；连接 config.shareInstance=true 显式放开并发接入）
      if (config.shareInstance !== true) {
        leaseKey = connection ? `conn:${connection.id}` : `endpoint:${endpoint}`
        this.acquireLease(leaseKey, id, connection ? `「${connection.name}」` : `（${endpoint}）`)
      }
      // M62-B：端点再解析（http(s) 形式可重新探测；ws:// 无再解析余地）
      if (/^https?:\/\//i.test(rawEndpoint)) {
        resolveEndpoint = async () => await resolve(rawEndpoint)
      }
    } else {
      const profileRoot = this.profileRootFor(ownerId)
      const launch = this.deps.launcher?.launchBrowser ?? launchBrowser
      let launched: LaunchResult
      try {
        launched = await launch({
          backend,
          profileRoot,
          executable:
            (typeof config.executable === 'string' && config.executable) || cfg.browserExecutable || undefined,
          headless,
          viewport: { width: cfg.browserViewportWidth, height: cfg.browserViewportHeight },
          startUrl: startUrl ?? 'about:blank',
        })
      } catch (err) {
        this.writeConnectionHealth(connection?.id, 'error', (err as Error).message)
        throw err
      }
      endpoint = launched.endpoint
      child = launched.child
      external = launched.external
      pid = launched.pid
      profileDir = launched.profileDir
      // M62：复用实例归属防御（同 Profile 目录的注册表必须属于当前用户；缺失按既有语义放行）
      if (launched.external && ownerId && profileDir) {
        const info = readInstanceInfo(profileDir)
        if (info?.userId && info.userId !== ownerId) {
          throw new Error('本机持久浏览器配置已被其他账号的实例占用：请等待其退出或联系管理员清理后重试')
        }
      }
      if (!launched.external && profileDir) {
        this.profileDirs.set(id, profileDir)
        writeInstanceInfo(profileDir, {
          v: 1,
          browserSessionId: id,
          sessionId,
          userId: ownerId,
          backend,
          pid,
          endpoint,
          headless,
          startedAt: new Date().toISOString(),
        })
      }
      // M62-B：端点再解析（local：读 DevToolsActivePort 重新探测；managed 临时实例无复用场景）
      if (profileDir && backend === 'local') {
        const dir = profileDir
        resolveEndpoint = async () => {
          const active = readDevToolsActivePort(dir)
          if (!active?.wsPath) return undefined
          const probed = await probeEndpoint(active.port, 600)
          return probed?.url
        }
      }
    }

    const cdp = this.deps.cdpFactory ? this.deps.cdpFactory() : new CdpClient()
    try {
      await cdp.connect(endpoint)
    } catch (err) {
      this.killChild(child)
      this.profileDirs.delete(id)
      this.releaseLease(id)
      if (child && profileDir) cleanupLaunchedProfile(backend, profileDir)
      this.writeConnectionHealth(connection?.id, 'error', (err as Error).message)
      throw err
    }

    // M62 页面分治：同端点已有其他活跃会话 → 本会话强制新建自有管理页（不抢页）
    const sharedEndpoint = [...this.sessions.values()].some(
      (existing) => !existing.isClosed() && existing.endpoint === endpoint,
    )
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
      forceFreshTarget: sharedEndpoint,
      isForeignTarget: (targetId) => {
        const owned = this.pageOwners.get(endpoint)?.get(targetId)
        return Boolean(owned && owned !== id)
      },
      onPageChange: (targetId) => this.updatePageOwnership(endpoint, id, targetId),
      resolveEndpoint,
      onEndpointChange: (next) => {
        try {
          this.deps.db.run('UPDATE browser_sessions SET endpoint = ? WHERE id = ?', next, id)
        } catch {
          // best-effort
        }
      },
    })
    sessionRef.session = session
    try {
      await session.start(cdp, startUrl)
    } catch (err) {
      await session.close('启动失败')
      this.killChild(child)
      this.profileDirs.delete(id)
      this.releasePageOwnership(endpoint, id)
      this.releaseLease(id)
      if (child && profileDir) cleanupLaunchedProfile(backend, profileDir)
      this.writeConnectionHealth(connection?.id, 'error', (err as Error).message)
      throw err
    }

    this.sessions.set(id, session)
    this.byBusinessSession.set(sessionId, id)
    this.owners.set(sessionId, ownerId)
    this.deps.db.run(
      `INSERT INTO browser_sessions
         (id, session_id, connection_id, user_id, backend, state, controller, viewport_w, viewport_h, endpoint, external_pid, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      sessionId,
      connection?.id ?? null,
      ownerId ?? null,
      backend,
      session.state,
      session.controller,
      cfg.browserViewportWidth,
      cfg.browserViewportHeight,
      endpoint,
      pid ?? null,
      session.createdAt,
    )
    // M62-B：成功接入 = 连接可用（首写不受节流限制）
    this.writeConnectionHealth(connection?.id, 'ok')
    this.deps.audit.record({
      actor: 'system',
      action: backend === 'remote' ? 'browser.attach' : 'browser.start',
      // M57：归属归因（owner 列 + detail 双记录；兼容模式缺省）
      userId: ownerId,
      resourceType: 'browser_session',
      resourceId: id,
      sessionId,
      detail: {
        backend,
        endpoint: endpoint.replace(/\/devtools\/browser\/.*/, '/devtools/browser/***'),
        external,
        headless,
        owner: ownerId,
      },
    })
    getLogger().info(
      { browserSessionId: id, sessionId, backend, external, headless, owner: ownerId },
      '浏览器会话就绪',
    )
    return session
  }

  /** 关闭浏览器会话（更新表 + 清理进程 + 移除注册；reason 落 close_reason） */
  async close(browserSessionId: string, actor: string, reason = '用户关闭'): Promise<boolean> {
    const session = this.sessions.get(browserSessionId)
    if (!session) return false
    const child = session.getChild()
    const profileDir = this.profileDirs.get(browserSessionId)
    await session.close(reason)
    this.killChild(child)
    if (child && profileDir) cleanupLaunchedProfile(session.backend, profileDir)
    this.sessions.delete(browserSessionId)
    this.lastFrameWriteAt.delete(browserSessionId)
    this.byBusinessSession.delete(session.sessionId)
    this.owners.delete(session.sessionId)
    this.profileDirs.delete(browserSessionId)
    this.releasePageOwnership(session.endpoint, browserSessionId)
    this.releaseLease(browserSessionId)
    removeScreenshotDir(this.deps.cfg, browserSessionId)
    this.deps.db.run(
      "UPDATE browser_sessions SET closed_at = ?, state = 'closed', close_reason = ? WHERE id = ?",
      new Date().toISOString(),
      reason,
      browserSessionId,
    )
    this.deps.audit.record({
      actor,
      action: 'browser.close',
      resourceType: 'browser_session',
      resourceId: browserSessionId,
      sessionId: session.sessionId,
      detail: { reason },
    })
    return true
  }

  /** 关闭业务会话的全部浏览器（会话删除 / 归档时调用） */
  async closeForSession(sessionId: string, actor: string): Promise<number> {
    const ids = this.listForSession(sessionId).map((s) => s.id)
    let closed = 0
    for (const id of ids) {
      if (await this.close(id, actor, '会话删除')) closed++
    }
    return closed
  }

  /** M62：关闭某用户的全部浏览器（用户删除时调用；含 DB 兜底行） */
  async closeForUser(userId: string, actor: string): Promise<number> {
    const ids = [...this.sessions.values()]
      .filter((s) => !s.isClosed() && this.owners.get(s.sessionId) === userId)
      .map((s) => s.id)
    let closed = 0
    for (const id of ids) {
      if (await this.close(id, actor, '用户删除')) closed++
    }
    // DB 兜底：内存不存在的活跃行（历史遗留 / 并发窗口）
    try {
      this.deps.db.run(
        "UPDATE browser_sessions SET closed_at = ?, state = 'closed', close_reason = '用户删除' WHERE user_id = ? AND closed_at IS NULL",
        new Date().toISOString(),
        userId,
      )
    } catch {
      // best-effort
    }
    return closed
  }

  /** 进程退出清理（index.ts shutdown 钩子） */
  async shutdown(): Promise<void> {
    this.stopReclaimLoop()
    const ids = [...this.sessions.keys()]
    for (const id of ids) {
      const session = this.sessions.get(id)
      if (!session) continue
      const child = session.getChild()
      const profileDir = this.profileDirs.get(id)
      await session.close('服务关闭').catch(() => undefined)
      this.killChild(child)
      if (child && profileDir) cleanupLaunchedProfile(session.backend, profileDir)
      try {
        this.deps.db.run(
          "UPDATE browser_sessions SET closed_at = ?, state = 'closed', close_reason = '服务关闭' WHERE id = ?",
          new Date().toISOString(),
          id,
        )
      } catch {
        // 关闭收尾阶段：DB 可能已不可用
      }
    }
    this.sessions.clear()
    this.byBusinessSession.clear()
    this.lastFrameWriteAt.clear()
    this.owners.clear()
    this.profileDirs.clear()
    this.pageOwners.clear()
    this.leases.clear()
  }

  /** 系统默认浏览器打开链接（面板「在系统浏览器打开」） */
  async openExternal(url: string): Promise<void> {
    await (this.deps.launcher?.openInSystemBrowser ?? openInSystemBrowser)(url)
  }

  // ---------- M62：启动对账 / 空闲回收 / 配额 ----------

  /**
   * M62：启动对账（index.ts 装配后调用一次；best-effort，不阻断启动）。
   * 1) DB 僵尸行（closed_at IS NULL）标记 closed（service_restart）；
   * 2) 扫描 profile 目录：注册表 pid 命令行匹配才终止（防误杀）；managed-* 目录删除；
   *    local 目录保留（登录态），仅清注册表与残留 DevToolsActivePort。
   */
  async reconcileOnStartup(): Promise<void> {
    const logger = getLogger()
    try {
      const stale = this.deps.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM browser_sessions WHERE closed_at IS NULL',
      )
      const count = Number(stale?.n ?? 0)
      if (count > 0) {
        this.deps.db.run(
          "UPDATE browser_sessions SET closed_at = ?, state = 'closed', close_reason = 'service_restart' WHERE closed_at IS NULL",
          new Date().toISOString(),
        )
        this.deps.audit.record({
          actor: 'system',
          action: 'browser.reconcile',
          resourceType: 'browser_session',
          detail: { closedRows: count },
        })
        logger.info({ count }, '浏览器启动对账：上次运行遗留的活跃行已关闭')
      }
    } catch (err) {
      logger.warn({ err }, '浏览器启动对账：DB 僵尸行清理失败')
    }
    try {
      const base = path.join(this.deps.cfg.dataDir, 'browser-profile')
      const roots = [base]
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('u_')) roots.push(path.join(base, entry.name))
        }
      } catch {
        // base 不存在：无历史实例
      }
      let killed = 0
      let removedDirs = 0
      for (const root of roots) {
        let entries: fs.Dirent[] = []
        try {
          entries = fs.readdirSync(root, { withFileTypes: true })
        } catch {
          continue
        }
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const managed = entry.name.startsWith('managed-')
          if (!managed && entry.name !== 'local') continue
          const dir = path.join(root, entry.name)
          const info = readInstanceInfo(dir)
          if (info?.pid) {
            const outcome: KillOutcome = await killProcessIfOwned(info.pid, dir).catch(
              () => 'foreign' as KillOutcome,
            )
            if (outcome !== 'foreign') killed++
          }
          if (managed) {
            removeProfileDir(dir)
            removedDirs++
          } else {
            clearInstanceInfo(dir)
            clearStaleActivePort(dir)
          }
        }
      }
      if (killed > 0 || removedDirs > 0) {
        logger.info({ killed, removedDirs }, '浏览器启动对账：孤儿进程 / 临时目录已清理')
      }
    } catch (err) {
      logger.warn({ err }, '浏览器启动对账：目录清理失败')
    }
  }

  /** M62：启动空闲回收循环（BROWSER_IDLE_CLOSE_MS=0 时不启用） */
  startReclaimLoop(): void {
    this.stopReclaimLoop()
    if (this.deps.cfg.browserIdleCloseMs <= 0) return
    const interval = this.deps.cfg.browserReclaimIntervalMs
    this.reclaimTimer = setInterval(() => {
      void this.reclaimIdle().catch(() => undefined)
    }, interval)
    this.reclaimTimer.unref?.()
  }

  stopReclaimLoop(): void {
    if (this.reclaimTimer) clearInterval(this.reclaimTimer)
    this.reclaimTimer = undefined
  }

  /**
   * M62：空闲回收（ownerId 限定时仅该用户；返回回收数量）。
   * 判定：state=ready + controller=agent + 非 busy + 无帧流订阅者 + 距最近活动 ≥ browserIdleCloseMs；
   * awaiting_human / human / 兼容模式（无归属）永不回收。
   */
  async reclaimIdle(ownerId?: string): Promise<number> {
    const idleMs = this.deps.cfg.browserIdleCloseMs
    if (idleMs <= 0) return 0
    const now = Date.now()
    let reclaimed = 0
    for (const [id, session] of [...this.sessions]) {
      if (session.isClosed()) continue
      const owner = this.owners.get(session.sessionId)
      if (!owner) continue
      if (ownerId && owner !== ownerId) continue
      if (session.state !== 'ready') continue
      if (session.controller !== 'agent') continue
      if (session.isBusy()) continue
      if ((this.deps.subscriberCount?.(`browser:${id}`) ?? 0) > 0) continue
      if (now - session.lastActiveAt() < idleMs) continue
      const reason = '空闲超时自动关闭（再次调用 browser_* 会自动重启）'
      if (await this.close(id, 'system', reason)) {
        this.deps.publish(`browser:${id}`, { type: 'closed', reason })
        reclaimed++
      }
    }
    return reclaimed
  }

  /** M62：配额检查（先回收本用户空闲实例再拒绝；0 = 不限） */
  private async ensureCapacity(ownerId: string): Promise<void> {
    const { browserMaxPerUser, browserMaxTotal } = this.deps.cfg
    const activeCount = (): number => [...this.sessions.values()].filter((s) => !s.isClosed()).length
    const userCount = (): number =>
      [...this.sessions.values()].filter((s) => !s.isClosed() && this.owners.get(s.sessionId) === ownerId).length
    const exceeded = (): boolean =>
      (browserMaxTotal > 0 && activeCount() >= browserMaxTotal) ||
      (browserMaxPerUser > 0 && userCount() >= browserMaxPerUser)
    if (!exceeded()) return
    await this.reclaimIdle(ownerId).catch(() => 0)
    if (browserMaxTotal > 0 && activeCount() >= browserMaxTotal) {
      throw new Error(
        `浏览器实例数已达全局上限（${browserMaxTotal}）：请关闭空闲浏览器或稍后重试（空闲实例将自动回收）`,
      )
    }
    if (browserMaxPerUser > 0 && userCount() >= browserMaxPerUser) {
      throw new Error(
        `浏览器实例数已达单用户上限（${browserMaxPerUser}）：请关闭空闲浏览器（面板「关闭」）或稍后重试（空闲实例将自动回收）`,
      )
    }
  }

  // ---------- 内部 ----------

  /** M62：Profile 根（多用户按 owner 命名空间；兼容模式沿用旧布局，零迁移） */
  private profileRootFor(ownerId?: string): string {
    const base = path.join(this.deps.cfg.dataDir, 'browser-profile')
    if (!ownerId) return base
    const safe = ownerId.replace(/[^A-Za-z0-9_-]/g, '_')
    return path.join(base, `u_${safe}`)
  }

  private infoOf(session: BrowserSession): BrowserSessionInfo {
    const info = session.info()
    const ownerId = this.owners.get(session.sessionId)
    return ownerId ? { ...info, ownerId } : info
  }

  /** 本进程自启进程的终止（测试可注入替身；external 实例 child 为空时不动作） */
  private killChild(child: ChildProcess | undefined): void {
    const kill = this.deps.launcher?.killLaunchedBrowser ?? killLaunchedBrowser
    kill(child)
  }

  /** M62-B：remote 租约（同一连接同一时刻仅一个活动会话；占用者仍活跃才拒绝） */
  private acquireLease(leaseKey: string, browserSessionId: string, label: string): void {
    const holder = this.leases.get(leaseKey)
    if (holder && holder !== browserSessionId) {
      const holderSession = this.sessions.get(holder)
      if (holderSession && !holderSession.isClosed()) {
        throw new Error(`远程浏览器${label}正在被其他会话使用：暂不支持并发接入（请先关闭原会话）`)
      }
    }
    this.leases.set(leaseKey, browserSessionId)
  }

  private releaseLease(browserSessionId: string): void {
    for (const [key, holder] of [...this.leases]) {
      if (holder === browserSessionId) this.leases.delete(key)
    }
  }

  /** M62：管理页占用表维护（同端点多会话页面分治；先清本会话旧登记再写新值） */
  private updatePageOwnership(endpoint: string, browserSessionId: string, targetId: string | undefined): void {
    const owners = this.pageOwners.get(endpoint) ?? new Map<string, string>()
    for (const [target, owner] of [...owners]) {
      if (owner === browserSessionId) owners.delete(target)
    }
    if (targetId) owners.set(targetId, browserSessionId)
    if (owners.size > 0) this.pageOwners.set(endpoint, owners)
    else this.pageOwners.delete(endpoint)
  }

  private releasePageOwnership(endpoint: string, browserSessionId: string): void {
    this.updatePageOwnership(endpoint, browserSessionId, undefined)
  }

  /** M62-B：连接健康回写（真实接入结果 = 连接卡状态；30s 节流；仅 connectionId 会话） */
  private writeConnectionHealth(connectionId: string | undefined, status: 'ok' | 'error', error?: string): void {
    if (!connectionId) return
    const now = Date.now()
    const last = this.healthWriteAt.get(connectionId) ?? 0
    if (now - last < CONNECTION_HEALTH_THROTTLE_MS) return
    this.healthWriteAt.set(connectionId, now)
    try {
      this.deps.connections.setStatus(connectionId, status, error)
    } catch {
      // best-effort：状态回写失败不影响会话
    }
  }

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
