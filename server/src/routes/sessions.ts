import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { Request, RequestHandler } from 'express'
import type { UserAvatar, MessageAttachment } from '@multi-agent/shared'
import type { Session } from '@multi-agent/shared'
import { MEMBER_SEP, baseAgentId, memberKeyOf, soulIdOfMember, isEmojiLike } from '@multi-agent/shared'
import { findSoulCollision, resolveMembers } from '../orchestration/members.js'
import { buildMentionTokens, parseMentionsWithTokens } from '../orchestration/parser.js'
import { parseSessionHumanMentions, sessionHumans } from '../orchestration/humans.js'
import type { AuthUser } from '../auth/service.js'
import {
  addMembersSchema,
  confirmSchema,
  createSessionSchema,
  dispatchSchema,
  editMessageSchema,
  firstIssue,
  forkSchema,
  memberSoulSchema,
  planEditSchema,
  planResolveSchema,
  reactionSchema,
  renameSessionSchema,
  resumeSessionSchema,
  sendMessageSchema,
  uploadSchema,
} from './schemas.js'
import { classifyKind } from '../store/artifacts.js'
import { inviteMembersCore } from '../tools/roster.js'
import { applySpaceSoulDefaults } from '../store/spaces.js'
import { safeFileName } from '../util/attachments.js'
import { mimeOfExt } from '../util/mime.js'
import type { ApiDeps } from './index.js'

/** 会话 CRUD + 消息发送（发送即触发一次 Run；运行中再发送 = 插话，§9 / M3） */
export function createSessionsRouter(deps: ApiDeps): Router {
  const router = Router()

  /** M57：当前请求的归属口径（用户 id；单用户兼容模式 null = 不过滤） */
  const ownerIdOf = (req: Request): string | null => {
    const user = (req as Request & { user?: AuthUser }).user
    return user?.id ? user.id : null
  }
  const userOf = (req: Request): AuthUser | undefined => (req as Request & { user?: AuthUser }).user

  /**
   * M79-J（§16 权限矩阵）：成员编制管理（agent 进出场 / 换灵魂）——
   * team（含历史缺省 kind）与 direct 仅 owner；group 允许 editor（混编群协作放宽，与 shares 同分流口径）。
   * viewer / 非成员由会话守卫统一 403 / 404；兼容模式全放行。
   */
  const canManageLineup = (req: Request, session: { kind?: string; id: string }): boolean => {
    if (!deps.access.multiUser) return true
    const user = userOf(req)
    if (!user) return false
    if (session.kind === 'group') return deps.access.canWriteSession(user, session.id)
    return deps.access.sessionRole(user, session.id) === 'owner'
  }

  router.get('/sessions', (req, res) => {
    const uid = ownerIdOf(req)
    // M57 P2：本人 + 共享给我（逐行标注 role：owner / editor / viewer）；兼容模式 = 全量
    const sessions = uid ? deps.sessions.listForUser(uid) : deps.sessions.list(null)
    // M79-A：服务端权威未读（单查询聚合；多端一致；客户端徽章数据源）
    let list =
      uid && deps.reads
        ? (() => {
            const counts = deps.reads.unreadFor(
              uid,
              sessions.map((s) => s.id),
            )
            return sessions.map((s) => ({ ...s, unreadCount: counts.get(s.id) ?? 0 }))
          })()
        : sessions
    if (uid) {
      // M79-D：隐藏过滤（无未读才隐藏；新消息自动复现）
      const hidden = deps.hides?.hiddenFor(uid)
      if (hidden && hidden.size > 0) {
        list = list.filter((s) => !(hidden.has(s.id) && (s.unreadCount ?? 0) === 0))
      }
      // M79-D：direct 标题动态渲染（对端显示名；缺失 =（已删除））
      list = list.map((s) => {
        if (s.kind !== 'direct') return s
        const otherId =
          s.ownerId === uid ? deps.members.list(s.id).find((m) => m.userId !== uid)?.userId : s.ownerId
        const other = otherId ? deps.auth.getUser(otherId) : undefined
        return { ...s, title: other?.displayName ?? '（已删除）' }
      })
    }
    res.json({ sessions: list })
  })

  /** M9：跨会话全文检索（FTS5 trigram + LIKE 回退；sessionId 可选限定单会话；M57：仅检索本人会话） */
  router.get('/search', (req, res) => {
    const q = String(req.query.q ?? '').trim()
    if (!q) return res.status(400).json({ error: 'q 必填（搜索关键词）' })
    const limit = Number(req.query.limit)
    const scoped = String(req.query.sessionId ?? '')
    let results = deps.sessions.search(q, Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 50, ownerIdOf(req))
    if (scoped) results = results.filter((r) => r.sessionId === scoped)
    const titles = new Map(deps.sessions.list(ownerIdOf(req)).map((s) => [s.id, s.title]))
    res.json({ results: results.map((r) => ({ ...r, sessionTitle: titles.get(r.sessionId) ?? '' })) })
  })

  router.post('/sessions', async (req, res) => {
    const parsed = createSessionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    // M57 P3：会话数配额闸门（超限 403；无配额行 / 兼容模式零开销）
    if (deps.quotas && userOf(req)) {
      try {
        deps.quotas.assertSessionCreate(userOf(req)!.id)
      } catch (err) {
        const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 403
        return res.status(status).json({ error: (err as Error).message })
      }
    }
    const body = parsed.data
    // M77：participantIds 条目为「成员键」（经典 = agentId；分身 = agentId~soulId），去重后按基础角色链序稳定排序
    const ids = [...new Set(body.participantIds.map(String))]
    // M48：空选择合法 —— 零编制开场，首条未 @ 消息由平台路由步自动组队与派发（全程自动）
    const order = new Map(deps.prompts.list().map((a, i) => [a.id, i]))
    ids.sort(
      (a, b) =>
        (order.get(baseAgentId(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(baseAgentId(b)) ?? Number.MAX_SAFE_INTEGER),
    )
    const title = body.title?.trim() ? body.title : undefined
    // M6：可选关联项目（未指定 = 会话级沙箱工作区，保持既有行为）；M57：仅可关联本人项目
    const projectId = body.projectId
    if (projectId && !deps.access.canAccessProject(userOf(req), projectId)) {
      return res.status(400).json({ error: '项目不存在' })
    }
    // 空间归属（缺省 = 我的空间；装配了空间存储时校验存在性）
    if (body.spaceId && deps.spaces && !deps.spaces.get(body.spaceId)) {
      return res.status(400).json({ error: '空间不存在' })
    }
    // P3：空间默认灵魂——入编成员未显式选灵魂时按空间绑定填充（显式选择优先；分身键不受影响）
    const space = deps.spaces?.get(body.spaceId ?? 'default')
    const souls = applySpaceSoulDefaults(space, ids, body.souls)
    // M16：创建时可选指定灵魂（校验归属：agent 必须挂有该灵魂）
    const soulErr = soulValidationError(deps, souls, new Set(ids))
    if (soulErr) return res.status(400).json({ error: soulErr })
    // M77：编制合法性（角色存在 / 分身灵魂归属 / 同角有效灵魂去重 / 同角实例上限）
    const lineupErr = lineupError(deps, undefined, ids, souls)
    if (lineupErr) return res.status(400).json({ error: lineupErr })
    const session = deps.sessions.create(ids, title, {
      projectId,
      souls,
      serial: body.serial,
      spaceId: body.spaceId,
      // M57：会话属主（多用户）；单用户兼容模式缺省
      ownerId: userOf(req)?.id || undefined,
    })
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
    // M57 P2：共享会话人类署名表（userId → 昵称；客户端消息气泡 / 列表预览署名；兼容模式为空）
    // M79-B：附加画像投影 humanProfiles（头像 / 头衔）；humanNames 保留不删（兼容既有消费链与测试锚点）
    const humanNames: Record<string, string> = {}
    const humanProfiles: Record<string, { name: string; username: string; headline?: string; avatar?: UserAvatar }> = {}
    if (deps.access.multiUser) {
      const ids = new Set<string>()
      if (entry.session.ownerId) ids.add(entry.session.ownerId)
      for (const member of deps.members.list(entry.session.id)) ids.add(member.userId)
      for (const id of ids) {
        const user = deps.auth.getUser(id)
        if (!user) continue
        humanNames[id] = user.displayName
        humanProfiles[id] = {
          name: user.displayName,
          username: user.username,
          ...(user.headline ? { headline: user.headline } : {}),
          ...(user.avatar ? { avatar: user.avatar } : {}),
        }
      }
    }
    /**
     * 消息分页（2026-09-22）：?limit=N&before=<seq> —— 返回最近 N 条（before = 该 seq 之前的更早一页）。
     * 缺省不带参数 = 全量返回（兼容既有客户端 / 测试锚点零变化）。
     * 分页响应附：hasMore（还有更早）/ totalCount（总条数）/ memberStats（全量口径的成员战绩——
     * 前端只加载了最近一页，但「本会话发言 / 交付」统计须覆盖全部历史，由服务端按缓存全量聚合）。
     */
    const limitRaw = Number(req.query.limit)
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(500, Math.floor(limitRaw)) : 0
    const beforeRaw = req.query.before !== undefined ? Number(req.query.before) : undefined
    // M80-B：表情回应随消息投影（批量聚合，mine 按请求者）
    const meId = userOf(req)?.id
    const withReactions = (messages: typeof entry.messages): typeof entry.messages => {
      if (!deps.reactions) return messages
      const byMsg = deps.reactions.summaryForMessages(messages.map((m) => m.id), meId)
      return byMsg.size > 0 ? messages.map((m) => (byMsg.has(m.id) ? { ...m, reactions: byMsg.get(m.id) } : m)) : messages
    }
    // M80-C：成员已读水位投影（仅开启对外展示开关的活跃成员；关闭者不投影——对等原则）
    const memberReads = (() => {
      if (!deps.access.multiUser || !deps.reads) return []
      // 对等双向：请求者自身关闭开关 → 也看不到他人的已读（空投影；客户端门之外的权威兜底）
      if (meId && deps.users.getPrefs(meId).showReadReceipts === false) return []
      const ids = new Set<string>()
      if (entry.session.ownerId) ids.add(entry.session.ownerId)
      for (const m of deps.members.list(entry.session.id)) ids.add(m.userId)
      const out: Array<{ userId: string; lastReadSeq: number }> = []
      for (const id of ids) {
        const user = deps.auth.getUser(id)
        if (!user || user.status !== 'active') continue
        if (deps.users.getPrefs(id).showReadReceipts === false) continue
        out.push({ userId: id, lastReadSeq: deps.reads.get(id, entry.session.id) })
      }
      return out
    })()
    if (limit > 0) {
      const all = entry.messages
      const upto = beforeRaw !== undefined && Number.isFinite(beforeRaw) ? all.filter((m) => (m.seq ?? 0) < beforeRaw) : all
      const page = upto.slice(-limit)
      const memberStats: Record<string, { speaks: number; artifacts: number }> = {}
      for (const m of all) {
        if (m.role !== 'agent' || !m.agentId) continue
        const key = m.memberKey ?? m.agentId
        const cur = memberStats[key] ?? { speaks: 0, artifacts: 0 }
        cur.speaks += 1
        cur.artifacts += m.artifacts?.length ?? 0
        memberStats[key] = cur
      }
      return res.json({
        session: entry.session,
        messages: withReactions(page),
        latestRun,
        project: project ?? null,
        humanNames,
        humanProfiles,
        memberReads,
        hasMore: upto.length > page.length,
        totalCount: all.length,
        memberStats,
      })
    }
    res.json({ session: entry.session, messages: withReactions(entry.messages), latestRun, project: project ?? null, humanNames, humanProfiles, memberReads })
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
      // M79-Y：计划批准广播（成员计划卡实时更新为已批准；触发者另有 SSE 与之一致）
      deps.notify.publish({
        type: 'notify:plan-updated',
        sessionId: session.id,
        payload: { plan: deps.plans.get(plan.id) },
      })
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
    // M79-AE：会话治理（改名 / 触发策略 / 执行模式）统一仅属主可改——
    // 此前 group 仅限群主、team/direct 为 owner∪editor；现全 kind 收敛为 owner
    const managed =
      parsed.data.title !== undefined ||
      parsed.data.routeMode !== undefined ||
      parsed.data.serial !== undefined ||
      parsed.data.planFirst !== undefined ||
      parsed.data.relay !== undefined ||
      parsed.data.autonomy !== undefined ||
      parsed.data.spaceId !== undefined
    if (managed && deps.access.multiUser) {
      const me = userOf(req)
      if (!me || deps.access.sessionRole(me, session.id) !== 'owner') {
        return res.status(403).json({ error: '仅会话属主可修改会话名称与治理设置' })
      }
    }
    if (parsed.data.title !== undefined) session = deps.sessions.rename(session.id, parsed.data.title) ?? session
    if (parsed.data.planFirst !== undefined) {
      session = deps.sessions.setPlanFirst(session.id, parsed.data.planFirst) ?? session
    }
    if (parsed.data.serial !== undefined) {
      session = deps.sessions.setSerial(session.id, parsed.data.serial) ?? session
    }
    // M79-E：触发策略切换（auto / mention）——广播 session-meta（多端头部开关同步）
    if (parsed.data.routeMode !== undefined) {
      session = deps.sessions.setRouteMode(session.id, parsed.data.routeMode) ?? session
      deps.notify.publish({ type: 'notify:session-meta', sessionId: session.id, payload: { session } })
      deps.audit?.record({
        actor: 'user',
        userId: userOf(req)?.id,
        ip: req.ip,
        action: 'session.route-mode-set',
        resourceType: 'session',
        resourceId: session.id,
        sessionId: session.id,
        detail: { routeMode: parsed.data.routeMode },
      })
    }
    // M86：接力控制（auto / manual / null = 恢复按会话形态推导）——广播 session-meta（多端头部开关同步）
    if (parsed.data.relay !== undefined) {
      session = deps.sessions.setRelay(session.id, parsed.data.relay ?? undefined) ?? session
      deps.notify.publish({ type: 'notify:session-meta', sessionId: session.id, payload: { session } })
      deps.audit?.record({
        actor: 'user',
        userId: userOf(req)?.id,
        ip: req.ip,
        action: 'session.relay-mode-set',
        resourceType: 'session',
        resourceId: session.id,
        sessionId: session.id,
        detail: { relay: parsed.data.relay },
      })
    }
    // M88：自动编排策略（auto / always-plan / never-plan / null = auto）——广播 session-meta（多端同步）
    if (parsed.data.autonomy !== undefined) {
      session = deps.sessions.setAutonomy(session.id, parsed.data.autonomy ?? undefined) ?? session
      deps.notify.publish({ type: 'notify:session-meta', sessionId: session.id, payload: { session } })
      deps.audit?.record({
        actor: 'user',
        userId: userOf(req)?.id,
        ip: req.ip,
        action: 'session.autonomy-set',
        resourceType: 'session',
        resourceId: session.id,
        sessionId: session.id,
        detail: { autonomy: parsed.data.autonomy },
      })
    }
    // 空间变更（治理权限与改名同口径：仅属主；装配空间存储时校验存在性）
    if (parsed.data.spaceId !== undefined) {
      if (deps.spaces && parsed.data.spaceId !== 'default' && !deps.spaces.get(parsed.data.spaceId)) {
        return res.status(400).json({ error: '空间不存在' })
      }
      session = deps.sessions.setSpace(session.id, parsed.data.spaceId) ?? session
      deps.notify.publish({ type: 'notify:session-meta', sessionId: session.id, payload: { session } })
    }
    res.json({ session })
  })

  router.delete('/sessions/:id', async (req, res) => {
    const id = req.params.id
    // M57 P2：仅会话属主可删除（共享成员 / viewer 一律 403；无读权 404）
    try {
      deps.access.assertSessionOwner(userOf(req), id)
    } catch (err) {
      const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 500
      return res.status(status).json({ error: (err as Error).message })
    }
    // 审核 H-2：运行中 / 排队中的会话禁止删除（删除会导致 Run 悬挂、SSE 订阅者收不到 run:end）
    if (deps.engine.activeRunOf(id)) {
      return res.status(400).json({ error: '会话正在运行中，请先停止运行再删除' })
    }
    // M79-AA 群管理补全：删除前记录 kind——广播 payload 供成员端区分文案（「群聊已被解散」）
    const goneKind = deps.sessions.getSession(id)?.kind ?? 'team'
    // M79-AE：删除通知文案需标题——一并缓存（remove 后取不到）
    const removedTitle = deps.sessions.getSession(id)?.title ?? '会话'
    // M79-AE：成员列表须在 remove（级联清理 shares/members）前收集
    const notifyMembers = deps.members.list(id)
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
    // M62：会话删除前先关闭其全部浏览器实例（best-effort，不阻断删除；最小夹具未注入 browser 时跳过）
    await deps.browser?.closeForSession(id, 'user').catch(() => undefined)
    deps.sessions.remove(id)
    if (deleteWorkspace) {
      deps.artifacts.removeSession(id)
      deps.index.removeSession(id)
    }
    // M79-X：群聊式全同步——会话删除广播（共享成员与本人多标签列表即时移除；
    // 成员端后续访问自然 404——访问服务按会话存在性校验）；
    // M79-AA 群管理补全：payload.kind 供客户端区分「群聊已被解散」/「本会话已被删除」文案
    deps.notify.publish({ type: 'notify:session-deleted', sessionId: id, payload: { kind: goneKind } })
    // M79-AE：删除通知共享成员（收件箱 'system'；离线可见；属主自身除外）
    if (deps.deliverInbox) {
      for (const m of notifyMembers) {
        deps.deliverInbox({
          userId: m.userId,
          type: 'system',
          title: '会话已被删除',
          sessionId: id,
          body: `「${removedTitle}」已被属主删除`,
        })
      }
    }
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
    // M79-AE：合并到主仓库（高敏感）→ 仅属主
    deps.access.assertSessionOwner(userOf(req), req.params.id)
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
    if (!canManageLineup(req, session)) return res.status(403).json({ error: '仅会话属主可管理团队成员' })
    const parsed = addMembersSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    // M77：新增条目为成员键（经典 = agentId；分身 = agentId~soulId）；已到场者先剔除再校验证编制
    const unique = [...new Set(parsed.data.agentIds.map(String))]
    const fresh = unique.filter((key) => !session.participantIds.includes(key))
    // P3：空间默认灵魂——邀请时未显式选灵魂的成员按会话所在空间的绑定填充
    const souls = applySpaceSoulDefaults(deps.spaces?.get(session.spaceId ?? 'default'), fresh, parsed.data.souls)
    const lineupErr = lineupError(deps, session, fresh, souls)
    if (lineupErr) return res.status(400).json({ error: lineupErr })
    const result = inviteMembersCore(
      { sessions: deps.sessions, prompts: deps.prompts, notify: deps.notify },
      {
        sessionId: session.id,
        agentIds: parsed.data.agentIds,
        souls,
        validateSouls: (added) => soulValidationError(deps, souls, new Set(added)),
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
  router.delete('/sessions/:id/members/:memberKey', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (!canManageLineup(req, session)) return res.status(403).json({ error: '仅会话属主可管理团队成员' })
    // M77：按成员键（分身实例）移除；至少保留 1 名成员
    const memberKey = req.params.memberKey
    if (!session.participantIds.includes(memberKey)) return res.status(404).json({ error: '该成员不在会话中' })
    if (session.participantIds.length <= 1) return res.status(400).json({ error: '会话至少保留 1 名成员' })
    const active = deps.engine.activeRunOf(session.id)
    if (active && deps.engine.isMemberActive(active.runId, memberKey)) {
      return res.status(400).json({ error: '该成员正在发言，请等待本波结束再移出' })
    }
    if (active) deps.engine.removeFromQueue(active.runId, memberKey)
    // M77：标签必须在变更前取（移除后同角实例数变化，会退回基础名）
    const name = memberLabelOf(deps, session, memberKey)
    deps.sessions.setParticipants(
      session.id,
      session.participantIds.filter((id) => id !== memberKey),
    )
    if (session.memberSouls?.[memberKey] !== undefined) {
      const souls = { ...session.memberSouls }
      delete souls[memberKey]
      deps.sessions.setMemberSouls(session.id, souls)
    }
    const message = deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      agentId: baseAgentId(memberKey),
      content: `${name} 离开了协作`,
      mentions: [],
      status: 'complete',
    })
    const updated = deps.sessions.getSession(session.id)!
    deps.notify.publish({ type: 'notify:members-changed', sessionId: session.id, payload: { session: updated, message } })
    res.json({ session: updated, message })
  })

  /**
   * M16 / M77：切换成员灵魂（经典 = body.soul 覆盖/恢复默认；分身 = 键替换为新灵魂实例）。
   * 校验灵魂归属与同角实例去重；落 system 事件条 + notify:members-changed。
   */
  router.patch('/sessions/:id/members/:memberKey', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    if (!canManageLineup(req, session)) return res.status(403).json({ error: '仅会话属主可管理团队成员' })
    const memberKey = req.params.memberKey
    if (!session.participantIds.includes(memberKey)) return res.status(404).json({ error: '该成员不在会话中' })
    const parsed = memberSoulSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const agent = deps.prompts.get(memberKey)
    if (!agent) return res.status(404).json({ error: '角色不存在' })
    const soul = parsed.data.soul ?? null
    const pinned = memberKey.includes(MEMBER_SEP)
    // ---- 分身实例：键替换（无「默认」态） ----
    if (pinned) {
      if (soul === null) {
        return res.status(400).json({ error: '分身实例不支持恢复默认灵魂：可直接切换其他灵魂或移除该分身' })
      }
      if (soul === soulIdOfMember(memberKey)) return res.status(400).json({ error: '该成员已在使用该灵魂' })
      const doc = deps.prompts.soul(agent.id, soul)
      if (!doc) return res.status(400).json({ error: `灵魂不存在：${agent.id}/${soul}` })
      const collision = findSoulCollision(session, deps.prompts, agent.id, soul, memberKey)
      if (collision) return res.status(400).json({ error: `该灵魂已被同角色的其他实例占用：${collision}` })
      const active = deps.engine.activeRunOf(session.id)
      if (active && deps.engine.isMemberActive(active.runId, memberKey)) {
        return res.status(400).json({ error: '该成员正在发言，请等待本波结束再切换灵魂' })
      }
      const nextKey = memberKeyOf(agent.id, soul)
      // M77：标签必须在变更前取（变更后同角实例数变化，会退回基础名）
      const label = memberLabelOf(deps, session, memberKey)
      deps.sessions.setParticipants(
        session.id,
        session.participantIds.map((key) => (key === memberKey ? nextKey : key)),
      )
      if (active) deps.engine.replaceMemberKey(active.runId, memberKey, nextKey)
      const message = deps.sessions.appendMessage({
        sessionId: session.id,
        role: 'system',
        agentId: agent.id,
        content: `${label} 换上了『${doc.meta.name}』灵魂`,
        mentions: [],
        status: 'complete',
      })
      const updated = deps.sessions.getSession(session.id)!
      deps.notify.publish({ type: 'notify:members-changed', sessionId: session.id, payload: { session: updated, message } })
      return res.json({ session: updated, message })
    }
    // ---- 经典实例：会话覆盖 / 恢复默认 ----
    const current = session.memberSouls ?? {}
    if ((current[memberKey] ?? null) === soul) {
      return res.status(400).json({ error: soul ? '该成员已在使用该灵魂' : '该成员已是默认灵魂' })
    }
    // M77：与同角其他实例的有效灵魂去重（含恢复默认后的默认灵魂）
    const collision = findSoulCollision(session, deps.prompts, agent.id, soul ?? agent.defaultSoul, memberKey)
    if (collision) return res.status(400).json({ error: `该灵魂已被同角色的其他实例占用：${collision}` })
    // M77：同角多实例时事件条用实例标签（单实例 = 角色名，文案零变化）
    const changeLabel = memberLabelOf(deps, session, memberKey)
    let text: string
    if (soul) {
      const doc = deps.prompts.soul(agent.id, soul)
      if (!doc) return res.status(400).json({ error: `灵魂不存在：${agent.id}/${soul}` })
      deps.sessions.setMemberSouls(session.id, { ...current, [memberKey]: soul })
      text = `${changeLabel} 换上了『${doc.meta.name}』灵魂`
    } else {
      const next = { ...current }
      delete next[memberKey]
      deps.sessions.setMemberSouls(session.id, next)
      text = `${changeLabel} 恢复了默认灵魂`
    }
    const message = deps.sessions.appendMessage({
      sessionId: session.id,
      role: 'system',
      agentId: agent.id,
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
    // M79-H：拉黑对消息面切断（仅人物私聊）——拉黑 = 不可联系（既有 DM 历史仍可回看；团队协作不受影响）
    // 文案不泄漏拉黑事实：被拉黑方统一「对方设置了隐私限制」；拉黑方本人给出可操作原因
    if (deps.friends && session.kind === 'direct') {
      const meId = userOf(req)?.id
      const other = meId ? sessionHumans(session, deps.auth, deps.members).find((h) => h.userId !== meId) : undefined
      const link = meId && other ? deps.friends.find(meId, other.userId) : undefined
      if (link?.state === 'blocked') {
        return res.status(403).json({
          error: link.blockedBy === meId ? '你已拉黑对方：解除后可继续聊天' : '对方设置了隐私限制，无法发送消息',
        })
      }
    }
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
      // M57：人类消息作者（多用户署名 / 归因）
      userId: userOf(req)?.id || undefined,
      content,
      mentions: [],
      status: 'complete',
      // M33：附件随消息持久化（多模态通道与消息内渲染依据）
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
      // 约定：用户消息不占用 Agent 回合序号
      turnIndex: -1,
    })

    try {
      // M79-E：触发判断矩阵（设计 §8.3；引擎边界之外的路由层单点实现）
      //   ① @agent → 触发  ② waiting 命中 → 触发（越过策略）  ③ 人类定向（@真人 / 行首 @用户）→ 仅存储
      //   ④ 无定向 + team + auto → 触发（现状；PRS 组队）  ⑤ 无定向 + team + mention / chat → 仅存储
      const isChat = session.kind === 'direct' || session.kind === 'group'
      const routeMode: 'auto' | 'mention' = isChat ? 'mention' : (session.routeMode ?? 'auto')
      const agentParsed = content.includes('@')
        ? parseMentionsWithTokens(content, buildMentionTokens(resolveMembers(session, deps.prompts)))
        : { mentions: [] as string[], handedToUser: false, text: content }
      const agentTargeted = agentParsed.mentions.some((id) => session.participantIds.includes(id))
      const humans = sessionHumans(session, deps.auth, deps.members)
      const humanParsed = parseSessionHumanMentions(session, deps.prompts, humans, content)
      const humanDirected = humanParsed.humanMentions.length > 0 || agentParsed.handedToUser
      const meId = userOf(req)?.id
      const waitingHit = !!meId && (session.waitingOn ?? []).includes(meId)

      // 人类定向随行持久化（@真人 chips 渲染依据）
      if (humanParsed.humanMentions.length > 0) {
        deps.sessions.patchMessage(session.id, message.id, { humanMentions: humanParsed.humanMentions })
      }
      // 持球清除（任何消息；发送者 ∈ waiting_on 即集合差清除 + session-meta 广播）
      if (meId && deps.sessions.clearWaitingOn(session.id, meId)) {
        deps.notify.publish({
          type: 'notify:session-meta',
          sessionId: session.id,
          payload: { session: deps.sessions.getSession(session.id) },
        })
      }
      // @真人通知（inbox 投递；同会话同目标 60s 聚合窗口）
      if (humanParsed.humanMentions.length > 0 && deps.deliverInbox) {
        for (const targetId of humanParsed.humanMentions) {
          if (targetId === meId) continue
          if (deps.inbox?.hasRecent(targetId, 'mention', session.id, meId, 60_000)) continue
          deps.deliverInbox({
            userId: targetId,
            type: 'mention',
            title: session.title,
            sessionId: session.id,
            actorId: meId,
            body: content.slice(0, 120),
            payload: { messageId: message.id },
          })
        }
      }

      const shouldTrigger = agentTargeted || waitingHit || (!humanDirected && routeMode === 'auto')
      if (!shouldTrigger) {
        // 无 SSE 流：向会话订阅者补播（客户端同会话 upsert；跨会话消息计未读 + 列表对账）
        deps.notify.publish({ type: 'notify:turn-end', sessionId: session.id, payload: { message } })
        return res.status(201).json({ message })
      }
      if (deps.engine.activeRunOf(session.id)) {
        // M3：同会话互斥——运行中再发送 = 插话
        const result = deps.engine.inject(session.id, message.id)
        const latest = deps.sessions.messages(session.id).find((m) => m.id === message.id) ?? message
        // M79-W：群聊式全同步——插话消息同样广播给会话订阅者（触发型消息此前只走 SSE 单播，
        // 其他真人成员看不到该消息；客户端按同会话 upsert / 跨会话未读处理）
        deps.notify.publish({ type: 'notify:turn-end', sessionId: session.id, payload: { message: latest } })
        return res.status(201).json({ message: latest, injected: true, position: result.position, runId: result.runId })
      }
      // M24：Composer 消息级范式（仅对本次发送生效；engine.launch 持久化到用户消息，执行后复位）
      const result = deps.engine.launch(session.id, message.id, { mode: parsed.data.mode })
      const latest = deps.sessions.messages(session.id).find((m) => m.id === message.id) ?? message
      // M79-W：群聊式全同步——触发型消息（@agent / 持球命中 / auto 路由）同样广播给会话订阅者
      // （M79-D 补播仅覆盖 !shouldTrigger 分支；此处补齐，客户端同会话 upsert / 跨会话未读）
      deps.notify.publish({ type: 'notify:turn-end', sessionId: session.id, payload: { message: latest } })
      res.status(201).json({ message: latest, ...result })
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /**
   * M86：手动派发下一棒（接力控制 = manual 时的唯一接棒入口）。
   * - 活跃 Run：目标插到队首（不打断当前发言人）；
   * - 空闲：新起一个 Run（队列 = [目标]，不经过平台路由重新组队）。
   * 权限：非 viewer（与发送消息同口径）；目标必须是会话在场成员（支持角色 id / 成员键）。
   */
  router.post('/sessions/:id/dispatch', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const parsed = dispatchSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    if (deps.access.multiUser) {
      const me = userOf(req)
      const role = me ? deps.access.sessionRole(me, session.id) : undefined
      if (!me || !role || role === 'viewer') return res.status(403).json({ error: '只读共享成员不可派发' })
    }
    // 目标归一：成员键（分身）优先，其次基础角色 id
    const raw = parsed.data.agentId.trim().replace(/^@/, '')
    const target =
      session.participantIds.find((key) => key === raw) ??
      session.participantIds.find((key) => baseAgentId(key) === raw)
    if (!target) return res.status(400).json({ error: `目标不在会话中：${raw}` })
    try {
      const result = deps.engine.dispatchTo(session.id, target, {
        note: parsed.data.note,
        byUserId: userOf(req)?.id,
      })
      res.json(result)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message })
    }
  })

  /** M79-D：隐藏会话（仅本人列表；DM「删除」语义——新消息自动复现） */
  router.post('/sessions/:id/hide', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    if (!me) return res.status(400).json({ error: '兼容模式无隐藏语义' })
    if (!deps.hides) return res.status(503).json({ error: '隐藏服务未装配' })
    deps.hides.hide(me.id, session.id)
    res.json({ ok: true })
  })

  /** M79-D：取消隐藏 */
  router.delete('/sessions/:id/hide', (req, res) => {
    const me = userOf(req)
    const session = deps.access.assertSession(me, req.params.id)
    if (!me) return res.status(400).json({ error: '兼容模式无隐藏语义' })
    if (!deps.hides) return res.status(503).json({ error: '隐藏服务未装配' })
    deps.hides.unhide(me.id, session.id)
    res.json({ ok: true })
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
    // M79-X：仅作者本人可编辑（兼容模式 / 历史消息无 userId → 放行）
    const meId = userOf(req)?.id
    if (message.userId && meId && message.userId !== meId) {
      return res.status(403).json({ error: '只能编辑自己发送的消息' })
    }
    const updated = deps.sessions.patchMessage(req.params.id, message.id, { content: parsed.data.content })
    // M79-X：群聊式全同步——编辑结果广播（upsert 语义覆盖更新；其他成员实时可见）
    deps.notify.publish({ type: 'notify:turn-end', sessionId: req.params.id, payload: { message: updated } })
    res.json({ message: updated })
  })

  /** M8：删除单条消息 */
  router.delete('/sessions/:id/messages/:messageId', (req, res) => {
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    if (deps.engine.activeRunOf(req.params.id)) return res.status(400).json({ error: '会话运行中，暂不能删除消息' })
    // M79-X：他人的人类消息仅会话属主可删除（兼容模式 / 历史消息无 userId → 放行；agent/system 消息不受限）
    const target = deps.sessions.messageById(req.params.id, req.params.messageId)
    if (!target) return res.status(404).json({ error: '消息不存在' })
    const meId = userOf(req)?.id
    if (target.role === 'user' && target.userId && meId && target.userId !== meId) {
      try {
        deps.access.assertSessionOwner(userOf(req), req.params.id)
      } catch {
        return res.status(403).json({ error: '只能删除自己的消息（会话属主可删除任意消息）' })
      }
    }
    if (!deps.sessions.deleteMessage(req.params.id, req.params.messageId)) {
      return res.status(404).json({ error: '消息不存在' })
    }
    // M79-X：群聊式全同步——删除广播（同会话成员即时移除）
    deps.notify.publish({ type: 'notify:message-deleted', sessionId: req.params.id, payload: { messageId: req.params.messageId } })
    res.json({ ok: true })
  })

  /**
   * M80-B：消息表情回应（toggle 语义；设计 §5.3）。
   * - 权限：会话写级成员（viewer 403 由会话守卫统一拦截；与发言同口径）；
   * - 幂等：同 (message, user, emoji) 重复 PUT 不动；DELETE 仅摘本人；
   * - 校验：emoji 形态（isEmojiLike，≤6 码点；库外合法序列如肤色变体放行）；
   * - 广播：notify:reaction 全量替换帧（该消息的完整聚合投影，按各接收方无法区分 mine ——
   *   mine 由客户端本地按 userIds.includes(本人) 推导，与投影口径一致）。
   */
  router.put('/sessions/:id/messages/:messageId/reactions', (req, res) => {
    if (!deps.reactions) return res.status(503).json({ error: '表情回应未装配' })
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    const parsed = reactionSchema.safeParse(req.body ?? {})
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const { emoji } = parsed.data
    if (!isEmojiLike(emoji)) return res.status(400).json({ error: '不是合法的表情字符' })
    const message = deps.sessions.messageById(req.params.id, req.params.messageId)
    if (!message) return res.status(404).json({ error: '消息不存在' })
    const me = userOf(req)
    const meId = me?.id ?? ''
    // 兼容模式（无账号）：无归属语义，拒绝（ reactions 需要用户身份；单用户模式无观众）
    if (deps.access.multiUser && !meId) return res.status(401).json({ error: '未登录或登录已失效：请登录后重试' })
    if (!meId) return res.status(400).json({ error: '表情回应需多用户模式（账号体系）' })
    // 软限：单条消息同用户最多 8 种（防刷屏滥用；重复挂同一 emoji 幂等不占额）
    const existing = deps.reactions.summaryFor(message.id, meId)
    const alreadyMine = existing.some((r) => r.emoji === emoji && r.mine)
    if (!alreadyMine && deps.reactions.countOfUser(message.id, meId) >= 8) {
      return res.status(429).json({ error: '同一条消息最多挂 8 种表情' })
    }
    deps.reactions.add(message.id, meId, emoji)
    const reactions = deps.reactions.summaryFor(message.id, meId)
    deps.notify.publish({
      type: 'notify:reaction',
      sessionId: req.params.id,
      payload: { messageId: message.id, reactions: deps.reactions.summaryFor(message.id) },
    })
    res.json({ reactions })
  })

  router.delete('/sessions/:id/messages/:messageId/reactions', (req, res) => {
    if (!deps.reactions) return res.status(503).json({ error: '表情回应未装配' })
    if (!deps.sessions.getSession(req.params.id)) return res.status(404).json({ error: '会话不存在' })
    // DELETE 兼容 query 传参（客户端 apiDelete 无 body 通道）
    const parsed = reactionSchema.safeParse(req.body && Object.keys(req.body).length > 0 ? req.body : { emoji: req.query.emoji })
    if (!parsed.success) return res.status(400).json({ error: firstIssue(parsed.error) })
    const meId = userOf(req)?.id ?? ''
    if (!meId) return res.status(400).json({ error: '表情回应需多用户模式（账号体系）' })
    deps.reactions.remove(req.params.messageId, meId, parsed.data.emoji)
    const reactions = deps.reactions.summaryFor(req.params.messageId, meId)
    deps.notify.publish({
      type: 'notify:reaction',
      sessionId: req.params.id,
      payload: { messageId: req.params.messageId, reactions: deps.reactions.summaryFor(req.params.messageId) },
    })
    res.json({ reactions })
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
      // fork 继承源会话空间归属
      spaceId: entry.session.spaceId,
      // M57：fork 保持属主
      ownerId: entry.session.ownerId,
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
        userId: m.userId,
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
      deps.index.upsert(session.id, [{ path: rel, origin: 'upload' }])
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
 * M16 / M77：校验 souls 映射（经典成员键 = agentId → soulId；分身的灵魂内嵌在键中）：
 * - key 必须在允许范围内（本次加入 / 创建成员）；分身键不得出现在 souls 映射；
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
    if (agentId.includes(MEMBER_SEP)) {
      return `分身实例的灵魂内嵌在成员键中，无需在 souls 中重复指定：${agentId}`
    }
    if (!allowed.has(agentId)) return `灵魂归属错误：${agentId} 不在本次成员范围内`
    const agent = deps.prompts.get(agentId)
    if (!agent) return `角色不存在：${agentId}`
    if (!(agent.souls ?? []).some((s) => s.id === soulId)) return `灵魂不存在：${agentId}/${soulId}`
  }
  return undefined
}

/** 同一角色分身实例上限（M77） */
const MEMBER_MAX_PER_AGENT = 4

/**
 * M77：编制合法性（创建 / 邀请共用）——在「既有成员 + 本次新增」的合并视图上校验：
 * 角色存在；分身键灵魂归属该角色；同角「有效灵魂」去重（含都无灵魂）；同角实例 ≤ 4。
 * 返回首条中文错误（undefined = 通过）。
 */
function lineupError(
  deps: ApiDeps,
  existing: Session | undefined,
  additions: string[],
  souls: Record<string, string> | undefined,
): string | undefined {
  const entries: Array<{ key: string; base: string; soul?: string }> = []
  const collect = (key: string, override?: string | null): string | undefined => {
    const agent = deps.prompts.get(key)
    if (!agent) return `角色不存在：${baseAgentId(key)}`
    const suffix = soulIdOfMember(key)
    const chosen = suffix ?? override ?? undefined
    if (chosen && !(agent.souls ?? []).some((s) => s.id === chosen)) return `灵魂不存在：${agent.id}/${chosen}`
    entries.push({ key, base: agent.id, soul: chosen ?? agent.defaultSoul })
    return undefined
  }
  for (const key of existing?.participantIds ?? []) {
    const err = collect(key, existing?.memberSouls?.[key])
    if (err) return err
  }
  for (const key of additions) {
    const err = collect(key, souls?.[key])
    if (err) return err
  }
  const byBase = new Map<string, Array<{ key: string; soul?: string }>>()
  for (const e of entries) {
    const list = byBase.get(e.base) ?? []
    list.push({ key: e.key, soul: e.soul })
    byBase.set(e.base, list)
  }
  for (const [base, list] of byBase) {
    const name = deps.prompts.get(base)?.name ?? base
    if (list.length > MEMBER_MAX_PER_AGENT) {
      return `同一角色最多 ${MEMBER_MAX_PER_AGENT} 位实例（${name} 已将达 ${list.length} 位）`
    }
    const used = new Map<string, string>()
    for (const item of list) {
      const soulKey = item.soul ?? ''
      const other = used.get(soulKey)
      if (other) {
        return soulKey
          ? `${name} 的多个实例不能使用相同灵魂（${other} 与 ${item.key} 均为「${item.soul}」）`
          : `${name} 的多个实例不能同时不带灵魂`
      }
      used.set(soulKey, item.key)
    }
  }
  return undefined
}

/** M77：成员键 → 展示标签（分身 = 名字·灵魂名；未命中回退角色名 / 键） */
function memberLabelOf(deps: ApiDeps, session: Session, key: string): string {
  return resolveMembers(session, deps.prompts).find((m) => m.key === key)?.label ?? deps.prompts.get(key)?.name ?? key
}
