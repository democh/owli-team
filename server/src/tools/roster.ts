/**
 * M46：成员邀请共享内核（inviteMembersCore）—— 成员 API 与 M48 平台召集双入口共用。
 *
 * M48 调度平台化后：原 invite_members 工具随「调度官」角色一并撤销，
 * 未 @ 消息由引擎平台路由步（platform-router）自动召集与派发；
 * 内核保留为平台召集（引擎 enlistByPlatform）与成员 API 的共同落库链路。
 *
 * 纪律：
 * - 与成员 API（POST /sessions/:id/members）共享 inviteMembersCore：校验 / 排序 /
 *   事件条 / 广播全链路一致（措辞区分：用户「邀请了」/ 平台「召集了」），防语义漂移；
 * - 幂等：已在场成员自动跳过（already 列表），不重复落库；
 * - 依赖由调用方显式注入（引擎 / 路由），无工具运行期依赖。
 */
import type { ChatMessage, NotifyType, Session } from '@multi-agent/shared'
import type { PromptLibrary } from '../store/prompts.js'
import type { SessionStore } from '../store/sessions.js'

/** 单次召集上限（对齐成员 API addMembersSchema 的 20 位） */
export const INVITE_MAX_MEMBERS = 20

/** 通知发布端口（NotifyHub / 引擎 NotifyPort 均满足；测试可注入 stub） */
export interface InviteNotifyPort {
  publish(input: { type: NotifyType; sessionId: string; runId?: string; payload: Record<string, unknown> }): unknown
}

export interface InviteMembersCoreDeps {
  sessions: SessionStore
  prompts: PromptLibrary
  notify: InviteNotifyPort
}

export interface InviteMembersCoreInput {
  sessionId: string
  /** 角色 id 列表（同批新成员按编制链排序追加） */
  agentIds?: string[]
  /** 场景 id：整链召集该场景默认编制（chain；脏链条目静默跳过） */
  sceneId?: string
  /** 一句话理由（写入事件条；仅调度官召集传） */
  reason?: string
  /** 事件条措辞（缺省「邀请了」；调度官工具「召集了」） */
  verb?: string
  /** 事件条主语（缺省 = 会话首位成员名；工具调用 = 调度官名） */
  actorName?: string
  /** 附加灵魂（成员 API 专用；工具不传） */
  souls?: Record<string, string>
  /** 灵魂校验回调（返回错误串则整体拒绝；核心不依赖 souls 存储） */
  validateSouls?: (added: string[]) => string | undefined
}

export type InviteMembersCoreResult =
  | { ok: true; session: Session; added: string[]; already: string[]; message?: ChatMessage }
  | { ok: false; error: string; unknown: string[] }

/**
 * 成员邀请共享内核（成员 API 与 M48 平台召集双入口）：
 * 会话存在校验 → id 去重 / 场景整链解析 → 未知校验 → already/added 划分 →
 * 编制链排序 → 灵魂校验（回调）→ setParticipants → 事件条 → notify:members-changed。
 * added 为空（全部已在场）时返回 ok:true + added:[]，由调用方决定语义（路由 400 / 工具幂等回执）。
 */
export function inviteMembersCore(deps: InviteMembersCoreDeps, input: InviteMembersCoreInput): InviteMembersCoreResult {
  const session = deps.sessions.getSession(input.sessionId)
  if (!session) return { ok: false, error: '会话不存在', unknown: [] }
  const byId = new Map(deps.prompts.list().map((a) => [a.id, a]))
  const ids: string[] = (input.agentIds ?? []).map(String)
  // sceneId：整链召集（链内 id 以现存资产为准，脏链条目静默跳过）
  if (input.sceneId) {
    const scene = deps.prompts.groups().find((g) => g.id === input.sceneId)
    if (!scene) {
      const sceneIds = deps.prompts.groups().map((g) => g.id).join('、')
      return { ok: false, error: `场景「${input.sceneId}」不存在。可用场景：${sceneIds || '（无）'}`, unknown: [] }
    }
    ids.push(...scene.chain.filter((id) => byId.has(id)))
  }
  const unique = [...new Set(ids)]
  const unknown = unique.filter((id) => !byId.has(id))
  if (unknown.length > 0) return { ok: false, error: `角色不存在：${unknown.join('、')}`, unknown }
  const already = unique.filter((id) => session.participantIds.includes(id))
  const added = unique.filter((id) => !session.participantIds.includes(id))
  if (added.length === 0) return { ok: true, session, added, already }
  if (added.length > INVITE_MAX_MEMBERS) {
    return {
      ok: false,
      error: `单次召集最多 ${INVITE_MAX_MEMBERS} 位角色（本次合计 ${added.length} 位），请分批召集`,
      unknown: [],
    }
  }
  // 追加顺序确定性：同批新成员按编制链（list() 顺序）排序，既有成员顺序不变
  const order = new Map(deps.prompts.list().map((a, i) => [a.id, i]))
  added.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
  const soulErr = input.validateSouls?.(added)
  if (soulErr) return { ok: false, error: soulErr, unknown: [] }

  deps.sessions.setParticipants(session.id, [...session.participantIds, ...added])
  if (input.souls && Object.keys(input.souls).length > 0) {
    deps.sessions.setMemberSouls(session.id, { ...(session.memberSouls ?? {}), ...input.souls })
  }
  const inviter = input.actorName ?? byId.get(session.participantIds[0])?.name ?? '成员'
  const names = added.map((id) => byId.get(id)?.name ?? id).join('、')
  const reason = input.reason?.trim()
  const message = deps.sessions.appendMessage({
    sessionId: session.id,
    role: 'system',
    agentId: added[0],
    content: `${inviter} ${input.verb ?? '邀请了'} ${names} 加入协作${reason ? `（${reason}）` : ''}`,
    mentions: [],
    status: 'complete',
  })
  const updated = deps.sessions.getSession(session.id) ?? session
  deps.notify.publish({ type: 'notify:members-changed', sessionId: session.id, payload: { session: updated, message } })
  return { ok: true, session: updated, added, already, message }
}
