import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { MessageAttachment } from '@multi-agent/shared'
import {
  addMembersSchema,
  confirmSchema,
  createSessionSchema,
  editMessageSchema,
  firstIssue,
  forkSchema,
  memberSoulSchema,
  planEditSchema,
  planResolveSchema,
  renameSessionSchema,
  resumeSessionSchema,
  sendMessageSchema,
  uploadSchema,
} from './schemas.js'
import { classifyKind } from '../store/artifacts.js'
import { inviteMembersCore } from '../tools/roster.js'
import { safeFileName } from '../util/attachments.js'
import { mimeOfExt } from '../util/mime.js'
import type { ApiDeps } from './index.js'

/** 会话 CRUD + 消息发送（发送即触发一次 Run；运行中再发送 = 插话，§9 / M3） */
export function createSessionsRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/sessions', (_req, res) => {
    res.json({ sessions: deps.sessions.list() })
  })

  /** M9：跨会话全文检索（FTS5 trigram + LIKE 回退；sessionId 可选限定单会话） */
  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.status(400).json({ error: 'q 必填（搜索关键词）' })
    const limit = Number(req.query.limit)
    const scoped = String(req.query.sessionId ?? '')
    let results = deps.sessions.search(q, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50)
    if (scoped) results = results.filter((r) => r.sessionId === scoped)
    const titles = new Map(deps.sessions.list().map((s) => [s.id, s.title]))
    res.json({ results: results.map((r) => ({ ...r, sessionTitle: titles.get(r.sessionId) ?? '' })) })
  })

  router.post('/sessions', async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const body = parsed.data
    const ids = [...new Set(body.participantIds.map(String))]
    // M48：空选择合法 —— 零编制开场，首条未 @ 消息由平台路由步自动组队与派发（全程自动）
    const known = new Set(deps.prompts.list().map((a) => a.id))
    const unknown = ids.filter((id) => !known.has(id))
    if (unknown.length > 0) {
      return res.status(400).json({ error: `角色不存在：${unknown.join('、')}` })
    }
    // M15：链序统一为 participantIds 顺序 —— 创建时按场景编制链（list() 已按场景 → chain 排序）落库
    const order = new Map(deps.prompts.list().map((a, i) => [a.id, i]))
    ids.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
    // M16：创建时可选指定灵魂（校验归属：agent 必须挂有该灵魂）
    const soulErr = soulValidationError(deps, body.souls, new Set(ids))
    if (soulErr) return res.status(400).json({ error: soulErr })
    const title = body.title?.trim() ? body.title : undefined
    // M6：可选关联项目（未指定 = 会话级沙箱工作区，保持既有行为）
    const projectId = body.projectId
    if (projectId && !deps.projects.get(projectId)) {
      return res.status(400).json({ error: '项目不存在' })
    }
    const session = deps.sessions.create(ids, title, { projectId, souls: body.souls, serial: body.serial })
    if (projectId) {
      try {
        await deps.workspace.prepare(session)
      } catch (err) {
        // 工作区准备失败（worktree 创建 / 目录校验）→ 回滚会话
        deps.sessions.remove(session.id)
        return res.status(400).json({ error: (err as Error).message })
      }
    }
    res.status(201).json({ session })
  })

  router.get('/sessions/:id', (req, res) => {
    const entry = deps.sessions.get(req.params.id)
    if (!entry) return res.status(404).json({ error: '会话不存在' })
    // M3：附最近一次运行快照（interrupted 时前端展示「从断点继续」）
    const latestRun = deps.runs.latest(entry.session.id) ?? null
    // M6：附项目与工作区模式（前端展示 worktree 面板入口）
    const project = entry.session.projectId ? deps.projects.get(entry.session.projectId) : undefined
    res.json({ session: entry.session, messages: entry.messages, latestRun, project: project ?? null })
  })

  /** 任务清单（M3：write_todos 落库，跨 Run 继承） */
  router.get('/sessions/:id/tasks', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    res.json({ tasks: deps.tasks.list(req.params.id) })
  })

  /**
   * M24：计划面板数据源 —— 会话全部计划与评审记录（任务面板 2.0 / 计划卡）。
   * plans/reviews 未装配（旧数据 / 最小测试环境）→ 空列表，行为与现状零差异。
   */
  router.get('/sessions/:id/plans', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    if (!deps.plans) return res.json({ plans: [], reviews: [] })
    res.json({
      plans: deps.plans.list(req.params.id),
      reviews: deps.reviews?.listBySession(req.params.id) ?? [],
    })
  })

  /**
   * M24：编辑计划（仅 submitted）：改标题 / 目标 / 步骤（改负责人 / 调序 / 增删）；负责人须为会话成员。
   * 供计划卡与任务面板就地编辑；广播 notify:plan-updated。
   */
  router.put('/sessions/:id/plans/:planId', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (!deps.plans) return res.status(400).json({ error: '计划功能未启用' })
    const parsed = planEditSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const plan = deps.plans.get(req.params.planId)
    if (!plan || plan.sessionId !== session.id) return res.status(404).json({ error: '计划不存在' })
    if (plan.status !== 'submitted') {
      return res.status(400).json({ error: `仅「待批准」计划可编辑（当前：${plan.status}）` })
    }
    for (const step of parsed.data.steps ?? []) {
      if (step.ownerAgentId && !session.participantIds.includes(step.ownerAgentId)) {
        return res.status(400).json({ error: `步骤负责人不在会话中：${step.ownerAgentId}` })
      }
    }
    const updated = deps.plans.updateDraft(plan.id, {
      title: parsed.data.title,
      goal: parsed.data.goal,
      steps: parsed.data.steps,
      risks: parsed.data.risks,
    })
    if (!updated) return res.status(400).json({ error: '计划编辑失败' })
    deps.notify.publish({
      type: 'notify:plan-updated',
      sessionId: session.id,
      payload: { plan: updated },
    })
    res.json({ plan: updated })
  })

  /**
   * M24：计划审批（聊天卡 / 任务面板共用）：
   * - 有挂起（Run 存活等待）→ 结算：批准执行 / 驳回（反馈回灌作者，可现场修订 v2）；
   * - 无挂起（运行已停止 / 历史提交）→ 批准 = 稍后批准：新起执行 Run；驳回仅改状态。
   */
  router.post('/sessions/:id/plans/:planId/resolve', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (!deps.plans) return res.status(400).json({ error: '计划功能未启用' })
    const parsed = planResolveSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const { decision, feedback } = parsed.data
    const plan = deps.plans.get(req.params.planId)
    if (!plan || plan.sessionId !== session.id) return res.status(404).json({ error: '计划不存在' })

    // 有挂起：结算（状态迁移 + 唤醒 write_plan 等待；同 Run 其余并行计划由服务自动 superseded）
    if (deps.planReviews?.has(plan.id)) {
      const resolved = deps.planReviews.resolve(plan.id, decision, feedback)
      return res.json({ plan: resolved ?? deps.plans.get(plan.id), launched: null })
    }
    if (plan.status !== 'submitted') {
      return res.status(400).json({ error: `计划状态为 ${plan.status}，无法${decision === 'approve' ? '批准' : '驳回'}` })
    }
    if (decision === 'reject') {
      const rejected = deps.plans.setStatus(plan.id, 'rejected', { feedback: feedback ?? null })
      deps.notify.publish({ type: 'notify:plan-updated', sessionId: session.id, payload: { plan: rejected } })
      return res.json({ plan: rejected, launched: null })
    }
    // 稍后批准：无挂起 → 新起执行 Run（队列 = 步骤负责人；plan→executing）
    try {
      const launched = deps.engine.launchPlanExecution(session.id, plan.id)
      res.json({ plan: deps.plans.get(plan.id), launched })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** 断点继续（M3）：以中断快照启动新 Run */
  router.post('/sessions/:id/resume', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const parsed = resumeSessionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const runId = parsed.data.runId
    try {
      const result = deps.engine.resume(session.id, runId)
      res.status(201).json(result)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** 重命名（M24 扩展：planFirst 会话级「规划先行」开关，默认关闭；M46-2：serial 串行执行开关，默认开启） */
  router.patch('/sessions/:id', (req, res) => {
    const parsed = renameSessionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    let session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (parsed.data.title !== undefined) session = deps.sessions.rename(session.id, parsed.data.title) ?? session
    if (parsed.data.planFirst !== undefined) {
      session = deps.sessions.setPlanFirst(session.id, parsed.data.planFirst) ?? session
    }
    if (parsed.data.serial !== undefined) {
      session = deps.sessions.setSerial(session.id, parsed.data.serial) ?? session
    }
    res.json({ session })
  })

  router.delete('/sessions/:id', async (req, res) => {
    const id = req.params.id
    if (!deps.sessions.get(id)) return res.status(404).json({ error: '会话不存在' })
    // 审核 H-2：运行中 / 排队中的会话禁止删除（删除会导致 Run 悬挂、SSE 订阅者收不到 run:end）
    if (deps.engine.activeRunOf(id)) {
      return res.status(400).json({ error: '会话正在运行中，请先停止运行再删除' })
    }
    // 默认连同工作区删除（§22.1），deleteWorkspace=false 可保留；
    // M6：worktree 会话默认丢弃（删目录 + agent 分支），keepWorktree=true 保留
    const deleteWorkspace = req.query.deleteWorkspace !== 'false'
    const keepWorktree = req.query.keepWorktree === 'true'
    let worktreeDiscarded = false
    if (deleteWorkspace && !keepWorktree) {
      try {
        worktreeDiscarded = await deps.workspace.discard(id)
      } catch (err) {
        // 丢弃失败时保留会话（避免留下无法追踪的 worktree）
        return res.status(500).json({ error: (err as Error).message })
      }
    }
    deps.sessions.remove(id)
    if (deleteWorkspace) deps.artifacts.removeSession(id)
    res.json({ ok: true, deleteWorkspace, worktreeDiscarded })
  })

  /** worktree 状态（M6）：模式 / 分支 / 主仓库信息 + 改动 diff */
  router.get('/sessions/:id/worktree', async (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    try {
      const info = await deps.workspace.info(req.params.id)
      const diff = info.mode === 'worktree' ? await deps.workspace.diff(req.params.id) : undefined
      res.json({ ...info, diff: diff ?? null })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** 合并 worktree 到主仓库当前分支（M6）：需显式 confirm，主仓库与 worktree 均须干净 */
  router.post('/sessions/:id/worktree/merge', async (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    const parsed = confirmSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    try {
      const result = await deps.workspace.merge(req.params.id)
      res.json({ ok: true, detail: result.detail })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** 丢弃 worktree（M6）：删除工作目录 + agent 分支，主仓库不受影响 */
  router.post('/sessions/:id/worktree/discard', async (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    try {
      const removed = await deps.workspace.discard(req.params.id)
      res.json({ ok: true, removed })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /**
   * M16：动态邀请成员（运行中允许；assembler/scheduler 实时读 participantIds，下一回合即生效）。
   * - 去重追加（新成员按场景编制链顺序排在同批内）；souls 可选（邀请时即选风格）；
   * - 落库一条 system 成员事件 + 广播 notify:members-changed，返回 { session, message }。
   * M48：与平台路由步（引擎 enlistByPlatform）共享 inviteMembersCore（校验 / 排序 / 事件条 / 广播单源）。
   */
  router.post('/sessions/:id/members', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const parsed = addMembersSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const result = inviteMembersCore(
      { sessions: deps.sessions, prompts: deps.prompts, notify: deps.notify },
      {
        sessionId: session.id,
        agentIds: parsed.data.agentIds,
        souls: parsed.data.souls,
        validateSouls: (added) => soulValidationError(deps, parsed.data.souls, new Set(added)),
      },
    )
    if (!result.ok) return res.status(400).json({ error: result.error })
    if (result.added.length === 0) return res.status(400).json({ error: '所选成员均已在会话中' })
    res.status(201).json({ session: result.session, message: result.message })
  })

  /**
   * M16：移出成员。
   * - 正在发言（串行 = 当前发言人；并行波次 = 波内任一进行中成员）→ 400 拒绝；
   * - 运行中但仅在队列里 → 同步 engine.removeFromQueue 并广播 queue:updated；
   * - 会话至少保留 1 名成员；落 system 事件条 + notify:members-changed。
   */
  router.delete('/sessions/:id/members/:agentId', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const agentId = req.params.agentId
    if (!session.participantIds.includes(agentId)) return res.status(404).json({ error: '该成员不在会话中' })
    if (session.participantIds.length <= 1) return res.status(400).json({ error: '会话至少保留 1 名成员' })
    const active = deps.engine.activeRunOf(session.id)
    if (active && deps.engine.isMemberActive(active.runId, agentId)) {
      return res.status(400).json({ error: '该成员正在发言，请等待本波结束再移出' })
    }
    if (active) deps.engine.removeFromQueue(active.runId, agentId)
    deps.sessions.setParticipants(
      session.id,
      session.participantIds.filter((id) => id !== agentId),
    )
    if (session.memberSouls?.[agentId] !== undefined) {
      const souls = { ...session.memberSouls }
      delete souls[agentId]
      deps.sessions.setMemberSouls(session.id, souls)
    }
    const name = deps.prompts.get(agentId)?.name ?? agentId
    const message = deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      agentId,
      content: `${name} 离开了协作`,
      mentions: [],
      status: 'complete',
    })
    const updated = deps.sessions.getSession(session.id)!
    deps.notify.publish({ type: 'notify:members-changed', sessionId: session.id, payload: { session: updated, message } })
    res.json({ session: updated, message })
  })

  /**
   * M16：切换成员灵魂（body.soul = soulId 换装；null / 缺省 = 恢复角色默认）。
   * 校验灵魂归属；落 system 事件条「{名} 换上了『{灵魂名}』灵魂」+ notify:members-changed。
   */
  router.patch('/sessions/:id/members/:agentId', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const agentId = req.params.agentId
    if (!session.participantIds.includes(agentId)) return res.status(404).json({ error: '该成员不在会话中' })
    const parsed = memberSoulSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const agent = deps.prompts.get(agentId)
    if (!agent) return res.status(404).json({ error: '角色不存在' })
    const current = session.memberSouls ?? {}
    const soul = parsed.data.soul ?? null
    if ((current[agentId] ?? null) === soul) {
      return res.status(400).json({ error: soul ? '该成员已在使用该灵魂' : '该成员已是默认灵魂' })
    }
    let text: string
    if (soul) {
      const doc = deps.prompts.soul(agentId, soul)
      if (!doc) return res.status(400).json({ error: `灵魂不存在：${agentId}/${soul}` })
      deps.sessions.setMemberSouls(session.id, { ...current, [agentId]: soul })
      text = `${agent.name} 换上了『${doc.meta.name}』灵魂`
    } else {
      const next = { ...current }
      delete next[agentId]
      deps.sessions.setMemberSouls(session.id, next)
      text = `${agent.name} 恢复了默认灵魂`
    }
    const message = deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      agentId,
      content: text,
      mentions: [],
      status: 'complete',
    })
    const updated = deps.sessions.getSession(session.id)!
    deps.notify.publish({ type: 'notify:members-changed', sessionId: session.id, payload: { session: updated, message } })
    res.json({ session: updated, message })
  })

  /** 发送用户消息：无活跃 Run → 启动；运行中 → 插话（回合边界消费，不新建 Run）；M7：限流护栏 */
  const messageGuards: RequestHandler[] = deps.messageLimiter ? [deps.messageLimiter] : []
  router.post('/sessions/:id/messages', ...messageGuards, (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const parsed = sendMessageSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const content = parsed.data.content
    // M33：附件校验——路径归一化后仅允许 uploads/ 前缀，且文件必须真实存在于会话工作区；
    // kind / mime / size 一律以磁盘事实重算（客户端提交的元数据不可信：伪造 size=1 可绕过视觉注入体积护栏）
    let attachments = parsed.data.attachments
    if (attachments && attachments.length > 0) {
      const verified: MessageAttachment[] = []
      for (const att of attachments) {
        // path.normalize 拒绝 `uploads/../x` 类前缀绕过（归一化后必须与原值一致）
        const norm = path.posix.normalize(att.path)
        if (norm !== att.path || !norm.startsWith('uploads/')) {
          return res.status(400).json({ error: `附件路径非法（仅允许 uploads/）：${att.path}` })
        }
        let size: number | undefined
        try {
          const full = deps.artifacts.resolveSafe(session.id, norm)
          const stat = fs.statSync(full)
          size = stat.isFile() ? stat.size : undefined
        } catch {
          size = undefined
        }
        if (size === undefined) return res.status(400).json({ error: `附件不存在：${att.name}` })
        verified.push({
          ...att,
          path: norm,
          kind: classifyKind(norm),
          mime: mimeOfExt(path.extname(norm)),
          size,
        })
      }
      attachments = verified
    }

    const message = deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content,
      mentions: [],
      status: 'complete',
      // M33：附件随消息持久化（多模态通道与消息内渲染依据）
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      // 约定：用户消息不占用 Agent 回合序号
      turnIndex: -1,
    })

    try {
      if (deps.engine.activeRunOf(session.id)) {
        // M3：同会话互斥——运行中再发送 = 插话
        const result = deps.engine.inject(session.id, message.id)
        const latest = deps.sessions.messages(session.id).find((m) => m.id === message.id) ?? message
        return res.status(201).json({ message: latest, injected: true, position: result.position, runId: result.runId })
      }
      // M24：Composer 消息级范式（仅对本次发送生效；engine.launch 持久化到用户消息，执行后复位）
      const result = deps.engine.launch(session.id, message.id, { mode: parsed.data.mode })
      const latest = deps.sessions.messages(session.id).find((m) => m.id === message.id) ?? message
      res.status(201).json({ message: latest, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** M8：编辑用户消息（「编辑重发」：改完内容后对下一条 Agent 消息调 regenerate） */
  router.patch('/sessions/:id/messages/:messageId', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    if (deps.engine.activeRunOf(req.params.id)) return res.status(400).json({ error: '会话运行中，暂不能编辑消息' })
    const parsed = editMessageSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const message = deps.sessions.messageById(req.params.id, req.params.messageId)
    if (!message) return res.status(404).json({ error: '消息不存在' })
    if (message.role !== 'user') return res.status(400).json({ error: '只能编辑用户消息' })
    const updated = deps.sessions.patchMessage(req.params.id, message.id, { content: parsed.data.content })
    res.json({ message: updated })
  })

  /** M8：删除单条消息 */
  router.delete('/sessions/:id/messages/:messageId', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    if (deps.engine.activeRunOf(req.params.id)) return res.status(400).json({ error: '会话运行中，暂不能删除消息' })
    if (!deps.sessions.deleteMessage(req.params.id, req.params.messageId)) {
      return res.status(404).json({ error: '消息不存在' })
    }
    res.json({ ok: true })
  })

  /**
   * M8：从某条消息 fork 新会话（复制 [0..fromMessageId] 消息；新会话为独立沙箱工作区，不带原 worktree）。
   * 不复制运行快照；M33 起消息附件随分支复制文件（缺失则剔除该附件，避免悬空引用）。
   */
  router.post('/sessions/:id/fork', (req, res) => {
    const entry = deps.sessions.get(req.params.id)
    if (!entry) return res.status(404).json({ error: '会话不存在' })
    if (deps.engine.activeRunOf(req.params.id)) {
      return res.status(400).json({ error: '会话运行中，暂不能创建分支' })
    }
    const parsed = forkSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const idx = entry.messages.findIndex((m) => m.id === parsed.data.fromMessageId)
    if (idx === -1) return res.status(404).json({ error: '消息不存在' })
    const title = parsed.data.title?.trim() || `${entry.session.title} · 分支`
    const session = deps.sessions.create(entry.session.participantIds, title, {
      souls: entry.session.memberSouls,
      // M46-2：串行开关随 fork 复制（undefined = 关闭，需显式 false 保留）
      serial: entry.session.serial === true,
    })
    const copiedPaths = new Set<string>()
    for (const m of entry.messages.slice(0, idx + 1)) {
      // M33：附件复制（同一 path 仅复制一次；源文件缺失 → 剔除该附件）
      const kept = (m.attachments ?? []).filter((att) => {
        try {
          if (copiedPaths.has(att.path)) return true
          const src = deps.artifacts.resolveSafe(entry.session.id, att.path)
          if (!fs.existsSync(src)) return false
          deps.artifacts.ensureSessionDir(session.id) // 惰性创建：仅当确有附件需要复制
          const dst = deps.artifacts.resolveSafe(session.id, att.path)
          fs.mkdirSync(path.dirname(dst), { recursive: true })
          fs.copyFileSync(src, dst)
          copiedPaths.add(att.path)
          return true
        } catch {
          return false
        }
      })
      deps.sessions.appendMessage({
        sessionId: session.id,
        turnIndex: m.turnIndex,
        role: m.role,
        agentId: m.agentId,
        content: m.content,
        mentions: m.mentions,
        status: m.status === 'streaming' ? 'stopped' : m.status,
        artifacts: m.artifacts,
        toolCalls: m.toolCalls,
        reasoning: m.reasoning,
        attachments: kept.length > 0 ? kept : undefined,
      })
    }
    res.status(201).json({ session, copied: idx + 1 })
  })

  /** M8：文件 / 图片上传到工作区 uploads/（base64 直传，≤8MB） */
  router.post('/sessions/:id/uploads', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const parsed = uploadSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const buffer = Buffer.from(parsed.data.dataBase64, 'base64')
    if (buffer.length === 0) return res.status(400).json({ error: '文件内容为空' })
    if (buffer.length > UPLOAD_MAX_BYTES) {
      return res.status(413).json({ error: `文件超过 ${Math.round(UPLOAD_MAX_BYTES / 1024 / 1024)}MB 上限` })
    }
    const safeName = safeFileName(parsed.data.name)
    const rel = `uploads/${Date.now()}-${safeName}`
    try {
      const root = deps.artifacts.ensureSessionDir(session.id)
      const full = path.join(root, rel)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, buffer)
      res.status(201).json({ path: rel, size: buffer.length })
    } catch (err) {
      res.status(500).json({ error: `上传失败：${(err as Error).message}` })
    }
  })

  return router
}

/** 上传体积上限（base64 解码后） */
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024

/**
 * M16：校验 souls 映射（agentId → soulId）：
 * - key 必须在允许范围内（本次加入 / 创建成员）；
 * - 角色存在且挂有该灵魂（souls/*.md 解析结果）。
 * 返回首条中文错误（undefined = 通过）。
 */
function soulValidationError(
  deps: ApiDeps,
  souls: Record<string, string> | undefined,
  allowed: Set<string>,
): string | undefined {
  if (!souls) return undefined
  for (const [agentId, soulId] of Object.entries(souls)) {
    if (!allowed.has(agentId)) return `灵魂归属错误：${agentId} 不在本次成员范围内`
    const agent = deps.prompts.get(agentId)
    if (!agent) return `角色不存在：${agentId}`
    if (!(agent.souls ?? []).some((s) => s.id === soulId)) return `灵魂不存在：${agentId}/${soulId}`
  }
  return undefined
}
