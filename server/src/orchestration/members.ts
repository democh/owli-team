/**
 * 会话成员实例解析（M77 · 同角多魂/分身）：成员键 → 展示标签 / 有效灵魂的唯一事实源。
 *
 * - 成员键：经典实例 = agentId；分身实例 = `agentId~soulId`（见 shared/src/members.ts）；
 * - 有效灵魂：分身 = 键后缀；经典 = memberSouls 覆盖 > 角色默认 > 无；
 * - 展示标签 label：同角多实例在场时 = `名字·灵魂名`（歧义消解），否则 = 名字（存量外观零变化）；
 * - 供三处共用：@ 解析 token 表（parser）、roster 行（context/assembler）、工具在场名单（engine liveRoster）。
 */
import type { AgentDefinition, Session } from '@multi-agent/shared'
import { baseAgentId, memberLabel, soulIdOfMember } from '@multi-agent/shared'
import type { PromptLibrary } from '../store/prompts.js'

export interface MemberInfo {
  /** 成员键（participantIds 条目） */
  key: string
  /** 基础角色 id */
  agentId: string
  agent: AgentDefinition
  /** 有效灵魂 id（无 = undefined） */
  soulId?: string
  /** 有效灵魂展示名（无 = undefined） */
  soulName?: string
  /** 展示 token（多实例时含 `·灵魂名` 后缀；@ 点名与 UI 展示共用） */
  label: string
  /** 同角在场实例数（≥2 即多魂同场；展示/寻址歧义判定依据） */
  siblingCount: number
}

/** 会话成员实例清单（按编制顺序；角色不存在的成员键静默跳过） */
export function resolveMembers(session: Session, prompts: PromptLibrary): MemberInfo[] {
  const counts = new Map<string, number>()
  for (const key of session.participantIds) {
    const base = baseAgentId(key)
    counts.set(base, (counts.get(base) ?? 0) + 1)
  }
  const out: MemberInfo[] = []
  for (const key of session.participantIds) {
    const agent = prompts.get(key)
    if (!agent) continue
    const doc = prompts.soul(key, session.memberSouls?.[key])
    const soulId = doc?.meta.id ?? soulIdOfMember(key)
    const siblingCount = counts.get(agent.id) ?? 1
    const info: MemberInfo = {
      key,
      agentId: agent.id,
      agent,
      // 标签口径：同角多实例在场时 = 名字·灵魂名（消歧）；单实例保持角色名（存量外观零变化）
      label: siblingCount > 1 ? memberLabel(agent.name, doc?.meta.name) : agent.name,
      siblingCount,
    }
    if (doc?.meta.id) info.soulId = doc.meta.id
    if (doc?.meta.name) info.soulName = doc.meta.name
    // 多实例但灵魂解析失败（如灵魂资产被删除）→ 回退基础名，避免标签空后缀
    if (!doc && soulId) info.label = agent.name
    out.push(info)
  }
  return out
}

/**
 * 分身实例的「同名同魂冲突」判定：返回与给定 (agentId, 有效灵魂) 冲突的既有成员键。
 * 规则：同一角色的两个实例不得具有相同的有效灵魂（含「都无灵魂」这一退化情形）。
 */
export function findSoulCollision(
  session: Session,
  prompts: PromptLibrary,
  agentId: string,
  soulId: string | undefined,
  excludeKey?: string,
): string | undefined {
  for (const info of resolveMembers(session, prompts)) {
    if (info.agentId !== agentId || info.key === excludeKey) continue
    if ((info.soulId ?? undefined) === (soulId ?? undefined)) return info.key
  }
  return undefined
}
