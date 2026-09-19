/**
 * 成员实例解析（M77 · 同角多魂 / 分身）：与 server/src/orchestration/members.ts 同口径。
 *
 * - 成员键：经典实例 = agentId；分身实例 = `agentId~soulId`（见 shared/src/members.ts）；
 * - 有效灵魂：分身 = 键后缀；经典 = memberSouls 覆盖 > 角色默认 > 无；
 * - 展示名 label：同角多实例在场时 = `名字 · 灵魂名`（消歧），否则 = 名字（存量外观零变化）；
 * - 组队台「参与性格」编码/解码（encodeParticipation / participationOf）供建会话与邀请复用。
 */
import type { AgentDefinition, Session, SoulMeta } from '@multi-agent/shared'
import { baseAgentId, memberKeyOf, memberLabel, soulIdOfMember } from '@multi-agent/shared'

export interface MemberView {
  /** 成员键（participantIds 条目；@ 寻址与成员操作的主键） */
  key: string
  agent: AgentDefinition
  agentId: string
  /** 有效灵魂（无 = undefined） */
  soul?: SoulMeta
  /** 展示名（多实例 = `名字·灵魂名`；否则 = 名字） */
  label: string
  /** 同角在场实例数（≥2 = 多魂同场） */
  siblingCount: number
  /** 分身实例（键内嵌灵魂；换装 = 键替换） */
  pinned: boolean
}

/** 某实例的有效灵魂 id（分身 = 键后缀；经典 = memberSouls 覆盖 > 角色默认） */
export function soulIdOf(agent: AgentDefinition, key: string, memberSouls?: Record<string, string>): string | undefined {
  const pinned = soulIdOfMember(key)
  if (pinned) return pinned
  return memberSouls?.[key] ?? agent.defaultSoul
}

function viewOf(agent: AgentDefinition, key: string, memberSouls: Record<string, string> | undefined, siblingCount: number): MemberView {
  const soulId = soulIdOf(agent, key, memberSouls)
  const soul = soulId ? agent.souls?.find((s) => s.id === soulId) : undefined
  return {
    key,
    agent,
    agentId: agent.id,
    ...(soul ? { soul } : {}),
    label: siblingCount > 1 ? memberLabel(agent.name, soul?.name) : agent.name,
    siblingCount,
    pinned: key.includes('~'),
  }
}

/** 会话成员实例清单（按编制顺序；角色不存在的成员键静默跳过） */
export function memberViews(agents: AgentDefinition[], session: Session | undefined): MemberView[] {
  if (!session) return []
  const byId = new Map(agents.map((a) => [a.id, a]))
  const counts = new Map<string, number>()
  for (const key of session.participantIds) {
    const base = baseAgentId(key)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const out: MemberView[] = []
  for (const key of session.participantIds) {
    const agent = byId.get(baseAgentId(key))
    if (!agent) continue
    out.push(viewOf(agent, key, session.memberSouls, counts.get(agent.id) ?? 1))
  }
  return out
}

/** 成员键 → 成员视图（未命中回退 undefined） */
export function memberOf(agents: AgentDefinition[], session: Session | undefined, key: string): MemberView | undefined {
  return memberViews(agents, session).find((m) => m.key === key)
}

/**
 * 成员键 → 展示名（自描述回退链）：
 * 在场实例标签 → 键内嵌灵魂还原（历史消息 / 已移除 / 已换键的实例：`名字·灵魂名`）→ 角色名 → 键。
 * 经典键（无内嵌灵魂）不补后缀；灵魂资产已删时回退角色名。
 */
export function labelOfMemberKey(agents: AgentDefinition[], session: Session | undefined, key: string): string {
  const hit = memberOf(agents, session, key)
  if (hit) return hit.label
  const agent = agents.find((a) => a.id === baseAgentId(key))
  if (!agent) return key
  const embedded = soulIdOfMember(key)
  const soul = embedded ? agent.souls?.find((s) => s.id === embedded) : undefined
  return soul ? memberLabel(agent.name, soul.name) : agent.name
}

/**
 * 成员展示清单（面板成员选项统一数据源）：
 * 在场成员实例投影（id = 成员键、name = 标签）+ 「幽灵补位」——把引用到但已离场 / 已换键的成员键
 * （历史计划作者 / 步骤负责人 / 审批人 / 定时目标等）补成可读的临时条目（名单不丢人、不裸秀键）。
 */
export function memberDisplayList(
  agents: AgentDefinition[],
  session: Session | undefined,
  extraKeys: Array<string | undefined> = [],
): AgentDefinition[] {
  const out = memberViews(agents, session).map((m) => ({ ...m.agent, id: m.key, name: m.label }))
  const seen = new Set(out.map((m) => m.id))
  for (const key of extraKeys) {
    if (!key || seen.has(key)) continue
    const base = agents.find((a) => a.id === baseAgentId(key))
    if (!base) continue
    seen.add(key)
    out.push({ ...base, id: key, name: labelOfMemberKey(agents, session, key) })
  }
  return out
}

/** 某角色在当前编制下的「参与性格」集合（灵魂 id；无灵魂参与 = 空集） */
export function participationOf(agent: AgentDefinition, keys: string[], memberSouls?: Record<string, string>): string[] {
  const out: string[] = []
  for (const key of keys) {
    if (baseAgentId(key) !== agent.id) continue
    const soulId = soulIdOf(agent, key, memberSouls)
    if (soulId && !out.includes(soulId)) out.push(soulId)
  }
  return out
}

/**
 * 「参与性格」编码（组队台确定性口径）：S（灵魂集合）→ 成员键 + 经典覆盖。
 * - 空集 = 单人经典参与（无灵魂）；
 * - 非空：按角色 souls 声明序取首个人格走经典键（= 默认灵魂则不加覆盖），其余为分身键。
 */
export function encodeParticipation(
  agent: AgentDefinition,
  soulIds: string[],
): { keys: string[]; soulOverrides: Record<string, string> } {
  const order = new Map((agent.souls ?? []).map((s, i) => [s.id, i]))
  const ordered = [...new Set(soulIds)].sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999))
  if (ordered.length === 0) return { keys: [agent.id], soulOverrides: {} }
  const [first, ...rest] = ordered
  const keys = [agent.id, ...rest.map((soul) => memberKeyOf(agent.id, soul))]
  const soulOverrides: Record<string, string> = {}
  if (first !== agent.defaultSoul) soulOverrides[agent.id] = first
  return { keys, soulOverrides }
}
