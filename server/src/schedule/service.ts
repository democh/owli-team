/**
 * M35：定时任务服务（tick 轮询 → 到期触发 → 结算；HTTP 接口与 Agent 工具共用同一层语义）。
 *
 * 触发语义（设计见 design.md §50）：
 * - **run**：向目标成员注入用户消息（挂 schedule_id 徽章）→ engine.launch 启动协作运行，
 *   天然复用会话级互斥 / 审批门 / 接力链路；
 * - **remind**：落一条 system 事件条（不进上下文，零 token）+ 提醒通知，不发起 Run；
 * - **忙时跳过**：会话已有活跃 Run 时不在队列里堆积——推进 next_run_at 并留痕（skipped-busy），
 *   用户操作（runNow）不跳过，直接报「会话正忙」；
 * - **补跑窗口**：tick 发现到期任务的延迟超过 catchupMs（如服务停机）按 skipped-missed 跳过，
 *   只推进不引爆（默认窗口 10 分钟）；
 * - **失败护栏**：注入失败连续 failLimit 次自动暂停（paused），需人工或 Agent resume。
 *
 * 循环依赖解法：Engine 先建 → 本服务引用 engine.launch / activeRunOf 闭包 → engine.setScheduleService
 * 回填（沿用 streamHub 先例；本文件不 import engine，依赖为函数类型）。
 */
import type { ChatMessage, NotifyType, ScheduleActionKind, ScheduleNotifyAction, ScheduleSpec, ScheduledTask } from '@multi-agent/shared'
import { isValidTimezone, nextScheduleAt, serverTimezone, validateScheduleSpec } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { getLogger } from '../logger.js'
import type { ScheduleStore } from '../store/schedules.js'
import type { SessionStore } from '../store/sessions.js'

export interface ScheduleNotifyPort {
  publish(input: { type: NotifyType; sessionId: string; payload: Record<string, unknown> }): unknown
}

export interface ScheduleServiceDeps {
  cfg: AppConfig
  schedules: ScheduleStore
  sessions: SessionStore
  notify: ScheduleNotifyPort
  /** 引擎启动闭包（延迟绑定避免 Engine ↔ Service 循环依赖） */
  launch: (sessionId: string, userMessageId: string) => { runId: string }
  /** 会话忙判定（engine.activeRunOf 闭包） */
  isBusy: (sessionId: string) => boolean
}

export interface ScheduleCreateRequest {
  sessionId: string
  title: string
  kind: ScheduleActionKind
  instruction: string
  /** run 专用：@ 目标成员 id（须为会话成员） */
  targetAgentId?: string
  spec: ScheduleSpec
  /** 'user' 或 agentId */
  createdBy: string
}

export interface ScheduleUpdateRequest {
  title?: string
  instruction?: string
  targetAgentId?: string | null
  spec?: ScheduleSpec
}

export interface ScheduleOpResult {
  ok: boolean
  error?: string
  task?: ScheduledTask
  runId?: string
  messageId?: string
  /** 触发被跳过的原因（busy = 会话忙；missed = 超出补跑窗口） */
  skipped?: 'busy' | 'missed'
}

const TITLE_MAX = 80
const INSTRUCTION_MAX = 2_000

export class ScheduleService {
  private timer?: ReturnType<typeof setInterval>
  private ticking = false
  /** 默认时区非法只告警一次（配置错误不刷日志） */
  private tzWarned = false

  constructor(private readonly deps: ScheduleServiceDeps) {}

  // ---------- 生命周期 ----------

  start(): void {
    if (!this.deps.cfg.scheduleEnabled) {
      getLogger().info('定时任务已关闭（SCHEDULE_ENABLED=false）')
      return
    }
    this.repairMissingNext()
    // 启动即补一轮（停机期间错过的触发按补跑窗口处理）
    const catchupMs = this.deps.cfg.scheduleCatchupMs
    void this.tick()
    this.timer = setInterval(() => void this.tick(), this.deps.cfg.scheduleTickMs)
    this.timer.unref?.()
    getLogger().info(
      { tickMs: this.deps.cfg.scheduleTickMs, timezone: this.defaultTimezone(), catchupMs },
      '定时任务调度已启动',
    )
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** 单轮调度：到期任务逐个触发（串行防重入；fire 内部完成结算与推进） */
  async tick(): Promise<void> {
    if (!this.deps.cfg.scheduleEnabled || this.ticking) return
    this.ticking = true
    try {
      for (const task of this.deps.schedules.due(new Date().toISOString())) {
        try {
          this.fire(task)
        } catch (err) {
          getLogger().error({ taskId: task.id, err: (err as Error).message }, '定时任务触发失败（下轮重试）')
        }
      }
    } finally {
      this.ticking = false
    }
  }

  // ---------- 查询与 CRUD ----------

  list(sessionId: string): ScheduledTask[] {
    return this.deps.schedules.listBySession(sessionId)
  }

  get(id: string): ScheduledTask | undefined {
    return this.deps.schedules.get(id)
  }

  create(req: ScheduleCreateRequest): ScheduleOpResult {
    const { cfg, sessions, schedules } = this.deps
    if (!cfg.scheduleEnabled) return { ok: false, error: '定时任务未启用（SCHEDULE_ENABLED=false）' }
    const session = sessions.getSession(req.sessionId)
    if (!session) return { ok: false, error: '会话不存在' }
    const title = req.title.trim()
    if (!title) return { ok: false, error: '任务标题不能为空' }
    if (title.length > TITLE_MAX) return { ok: false, error: `任务标题过长（上限 ${TITLE_MAX} 字）` }
    const instruction = req.instruction.trim()
    if (!instruction) return { ok: false, error: '任务指令不能为空' }
    if (instruction.length > INSTRUCTION_MAX) return { ok: false, error: `任务指令过长（上限 ${INSTRUCTION_MAX} 字）` }
    if (req.kind !== 'run' && req.kind !== 'remind') return { ok: false, error: `未知任务类型：${req.kind}` }
    if (req.kind === 'run') {
      const target = req.targetAgentId?.trim()
      if (!target) return { ok: false, error: 'run 类型任务必须指定目标成员（targetAgentId）' }
      if (!session.participantIds.includes(target)) {
        return { ok: false, error: `目标成员「${target}」不在会话成员中` }
      }
    }
    if (schedules.countBySession(req.sessionId) >= cfg.scheduleMaxPerSession) {
      return { ok: false, error: `本会话定时任务已达上限（${cfg.scheduleMaxPerSession} 个）` }
    }
    const validation = validateScheduleSpec(req.spec, {
      defaultTz: this.defaultTimezone(),
      minGapMs: cfg.scheduleMinGapMs,
    })
    if (!validation.ok || !validation.next) return { ok: false, error: validation.error ?? '调度规格非法' }

    const task = schedules.create({
      sessionId: req.sessionId,
      title,
      kind: req.kind,
      instruction,
      targetAgentId: req.kind === 'run' ? req.targetAgentId?.trim() : undefined,
      spec: req.spec,
      timezone: validation.timezone ?? this.defaultTimezone(),
      createdBy: req.createdBy,
      nextRunAt: validation.next.toISOString(),
    })
    this.publish(task, 'created')
    return { ok: true, task }
  }

  update(id: string, patch: ScheduleUpdateRequest): ScheduleOpResult {
    const { schedules, sessions } = this.deps
    const task = schedules.get(id)
    if (!task) return { ok: false, error: '定时任务不存在' }
    const session = sessions.getSession(task.sessionId)
    if (!session) return { ok: false, error: '会话不存在' }

    const title = patch.title === undefined ? task.title : patch.title.trim()
    if (!title) return { ok: false, error: '任务标题不能为空' }
    if (title.length > TITLE_MAX) return { ok: false, error: `任务标题过长（上限 ${TITLE_MAX} 字）` }
    const instruction = patch.instruction === undefined ? task.instruction : patch.instruction.trim()
    if (!instruction) return { ok: false, error: '任务指令不能为空' }
    if (instruction.length > INSTRUCTION_MAX) return { ok: false, error: `任务指令过长（上限 ${INSTRUCTION_MAX} 字）` }

    let targetAgentId = patch.targetAgentId === undefined ? (task.targetAgentId ?? null) : patch.targetAgentId
    if (task.kind === 'run') {
      if (!targetAgentId?.trim()) return { ok: false, error: 'run 类型任务必须指定目标成员（targetAgentId）' }
      if (!session.participantIds.includes(targetAgentId.trim())) {
        return { ok: false, error: `目标成员「${targetAgentId}」不在会话成员中` }
      }
      targetAgentId = targetAgentId.trim()
    } else {
      targetAgentId = null
    }

    // 规格变化 → 全量重校验并重算 next；仅文案变化 → 保留原 next（不打乱节奏）
    let nextRunAt: string | undefined
    let timezone = task.timezone
    if (patch.spec) {
      const validation = validateScheduleSpec(patch.spec, {
        defaultTz: this.defaultTimezone(),
        minGapMs: this.deps.cfg.scheduleMinGapMs,
      })
      if (!validation.ok || !validation.next) return { ok: false, error: validation.error ?? '调度规格非法' }
      nextRunAt = validation.next.toISOString()
      timezone = validation.timezone ?? task.timezone
    }

    const updated = schedules.update(id, {
      title,
      instruction,
      targetAgentId,
      spec: patch.spec,
      timezone,
      nextRunAt,
    })
    if (!updated) return { ok: false, error: '定时任务不存在' }
    this.publish(updated, 'updated')
    return { ok: true, task: updated }
  }

  remove(id: string): ScheduleOpResult {
    const task = this.deps.schedules.get(id)
    if (!task) return { ok: false, error: '定时任务不存在' }
    this.deps.schedules.remove(id)
    this.publish(task, 'deleted')
    return { ok: true, task }
  }

  /** 启停；启用时重算 next 并重置失败计数（等价 resume 语义） */
  setEnabled(id: string, enabled: boolean): ScheduleOpResult {
    const { cfg, schedules } = this.deps
    const task = schedules.get(id)
    if (!task) return { ok: false, error: '定时任务不存在' }
    if (!enabled) {
      const disabled = schedules.update(id, { enabled: false })
      if (disabled) this.publish(disabled, 'updated')
      return { ok: true, task: disabled }
    }
    const validation = validateScheduleSpec(task.spec, {
      defaultTz: this.defaultTimezone(),
      minGapMs: cfg.scheduleMinGapMs,
    })
    if (!validation.ok || !validation.next) return { ok: false, error: validation.error ?? '调度规格非法' }
    const resumed = schedules.resume(id, validation.next.toISOString())
    if (resumed) this.publish(resumed, 'updated')
    return { ok: true, task: resumed }
  }

  /** 手动立刻触发一次：不推进 next_run_at（调度节奏不变）；会话忙直接报错（不静默跳过） */
  runNow(id: string): ScheduleOpResult {
    const task = this.deps.schedules.get(id)
    if (!task) return { ok: false, error: '定时任务不存在' }
    return this.fire(task, { manual: true })
  }

  // ---------- 触发内核 ----------

  private fire(task: ScheduledTask, opts: { manual?: boolean } = {}): ScheduleOpResult {
    const { cfg, sessions, schedules } = this.deps
    const session = sessions.getSession(task.sessionId)
    if (!session) {
      schedules.remove(task.id)
      return { ok: false, error: '会话不存在（任务已清理）' }
    }
    const now = new Date()
    const next = opts.manual ? (task.nextRunAt ?? null) : this.nextAfterFire(task, now)

    // 补跑窗口：自动触发时检查延迟；manual 为用户明确意图，不受窗口限制
    if (!opts.manual && task.nextRunAt) {
      const dueMs = Date.parse(task.nextRunAt)
      if (Number.isFinite(dueMs) && now.getTime() - dueMs > cfg.scheduleCatchupMs) {
        const lateMin = Math.round((now.getTime() - dueMs) / 60_000)
        const skipped = schedules.skip(task.id, {
          status: 'skipped-missed',
          note: `错过触发（延迟 ${lateMin} 分钟，超出补跑窗口 ${Math.round(cfg.scheduleCatchupMs / 60_000)} 分钟），已跳过本次`,
          nextRunAt: next,
        })
        this.publish(skipped ?? task, 'skipped-missed')
        getLogger().warn({ taskId: task.id, lateMin }, '定时任务错过触发（超出补跑窗口）')
        return { ok: true, skipped: 'missed', task: skipped }
      }
    }

    // remind：落系统事件条（不进上下文）+ 提醒通知，不发起 Run
    if (task.kind === 'remind') {
      const message = sessions.appendMessage({
        sessionId: task.sessionId,
        role: 'system',
        content: `⏰ 定时提醒：${task.title}\n${task.instruction}`,
        mentions: [],
        status: 'complete',
        scheduleId: task.id,
      })
      const settled = schedules.settle(task.id, { status: 'ok', nextRunAt: next })
      this.publishReminder(settled ?? task, message)
      return { ok: true, task: settled, messageId: message.id }
    }

    // run：目标成员校验（成员可能已被移出会话）
    const target = task.targetAgentId
    if (!target || !session.participantIds.includes(target)) {
      const settled = schedules.settle(task.id, {
        status: 'error',
        error: `目标成员「${target ?? '未指定'}」不在会话成员中`,
        nextRunAt: next,
      })
      return this.finalizeFailure(task, settled)
    }
    // 忙时：自动触发跳过留痕；手动触发明确报错
    if (this.deps.isBusy(task.sessionId)) {
      if (opts.manual) return { ok: false, error: '会话当前有运行中的任务，请稍后再试' }
      const skipped = schedules.skip(task.id, {
        status: 'skipped-busy',
        note: '会话正忙（有运行中的任务），本次触发已跳过',
        nextRunAt: next,
      })
      this.publish(skipped ?? task, 'skipped-busy')
      return { ok: true, skipped: 'busy', task: skipped }
    }

    const message = sessions.appendMessage({
      sessionId: task.sessionId,
      role: 'user',
      // M57：定时触发以会话属主名义注入（多用户署名 / 归因）
      userId: sessions.getSession(task.sessionId)?.ownerId,
      content: `@${target} ${task.instruction}`,
      mentions: [target],
      status: 'complete',
      scheduleId: task.id,
    })
    try {
      const { runId } = this.deps.launch(task.sessionId, message.id!)
      const settled = schedules.settle(task.id, { status: 'ok', runId, nextRunAt: next })
      this.publish(settled ?? task, 'fired', { messageId: message.id, runId, message })
      getLogger().info({ taskId: task.id, runId, target }, '定时任务已触发协作运行')
      return { ok: true, task: settled, runId, messageId: message.id }
    } catch (err) {
      // 注入后的启动失败（如并发竞态）：回收孤立用户消息，保持会话干净
      sessions.deleteMessage(task.sessionId, message.id!)
      const error = err instanceof Error ? err.message : String(err)
      const settled = schedules.settle(task.id, { status: 'error', error, nextRunAt: next })
      return this.finalizeFailure(task, settled)
    }
  }

  /** 失败结算：累计到阈值自动暂停（paused）并广播 */
  private finalizeFailure(task: ScheduledTask, settled?: ScheduledTask): ScheduleOpResult {
    const limit = this.deps.cfg.scheduleFailLimit
    if (settled && settled.failStreak >= limit) {
      const paused = this.deps.schedules.pause(
        settled.id,
        `连续 ${settled.failStreak} 次触发失败，已自动暂停：${settled.lastError ?? ''}`,
      )
      this.publish(paused ?? settled, 'paused')
      return { ok: false, error: settled.lastError, task: paused }
    }
    if (settled) this.publish(settled, 'error')
    return { ok: false, error: settled?.lastError, task: settled }
  }

  // ---------- 内部工具 ----------

  /** 触发后的 next：once 已消费 → null；cron → 从 now 起算的下一次 */
  private nextAfterFire(task: ScheduledTask, from: Date): string | null {
    if (task.spec.kind === 'once') return null
    return this.nextOf(task, from)
  }

  private nextOf(task: ScheduledTask, from: Date): string | null {
    const next = nextScheduleAt(task.spec, from, this.defaultTimezone())
    return next ? next.toISOString() : null
  }

  /** 默认时区：配置优先（非法回退服务器时区并告警一次） */
  defaultTimezone(): string {
    const configured = this.deps.cfg.scheduleTimezone.trim()
    if (!configured) return serverTimezone()
    if (!isValidTimezone(configured)) {
      if (!this.tzWarned) {
        this.tzWarned = true
        getLogger().warn({ tz: configured }, 'SCHEDULE_TZ 非法（需 IANA 时区名），已回退服务器时区')
      }
      return serverTimezone()
    }
    return configured
  }

  /** 启动修复：启用但缺 next_run_at 的循环任务（异常数据）补算，避免静默永不触发 */
  private repairMissingNext(): void {
    const now = new Date()
    for (const task of this.deps.schedules.all()) {
      if (!task.enabled || task.nextRunAt) continue
      const next = this.nextOf(task, now)
      if (next) this.deps.schedules.update(task.id, { nextRunAt: next })
    }
  }

  private publish(task: ScheduledTask, action: ScheduleNotifyAction, extra: Record<string, unknown> = {}): void {
    this.deps.notify.publish({
      type: 'notify:schedule-changed',
      sessionId: task.sessionId,
      payload: { action, task, ...extra },
    })
  }

  /** 提醒通知（前端 toast / Notification + 事件条插入；payload 携带消息实体与最新任务态供列表刷新） */
  private publishReminder(task: ScheduledTask, message: ChatMessage): void {
    this.deps.notify.publish({
      type: 'notify:schedule-reminder',
      sessionId: task.sessionId,
      payload: { task, messageId: message.id, message },
    })
  }
}
