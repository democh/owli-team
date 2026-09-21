/**
 * M79-E：会话人类成员解析（设计 §8.7）——@ 寻址与「行首 @具体人 = 指定交还」的统一入口。
 *
 * - 会话人类 = owner + 共享成员（多用户模式；兼容模式为空——一切调用返回空集，零回归）；
 * - reserved = 在场 agent 名 / id（人类 token 与之互斥，注册期杜绝双命中）；
 * - 引擎（收尾持球）与路由（触发矩阵 / 持久化）共用本模块，防双实现漂移。
 */
import type { Session } from '@multi-agent/shared'
import type { AuthService } from '../auth/service.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { PromptLibrary } from '../store/prompts.js'
import { resolveMembers } from './members.js'
import { buildHumanMentionTokens, parseHumanMentions, type HumanMentionInfo } from './parser.js'

export type { HumanMentionInfo }

/** 会话人类成员（owner + 共享成员；停用账号剔除） */
export function sessionHumans(
  session: Session,
  auth: AuthService,
  members: SessionMemberStore,
): HumanMentionInfo[] {
  if (!auth.multiUser) return []
  const ids = new Set<string>()
  if (session.ownerId) ids.add(session.ownerId)
  for (const record of members.list(session.id)) ids.add(record.userId)
  const out: HumanMentionInfo[] = []
  for (const id of ids) {
    const user = auth.getUser(id)
    if (!user || user.status !== 'active') continue
    out.push({
      userId: user.id,
      displayName: user.displayName,
      username: user.username,
      // M79-J：头衔随行（human_roster 注入；无头衔不渲染）
      ...('headline' in user && user.headline ? { headline: user.headline } : {}),
    })
  }
  return out
}

/** reserved token（在场 agent 名 / id；小写） */
export function reservedAgentTokens(session: Session, prompts: PromptLibrary): Set<string> {
  const reserved = new Set<string>()
  for (const member of resolveMembers(session, prompts)) {
    reserved.add(member.agent.name.toLowerCase())
    reserved.add(member.agentId.toLowerCase())
  }
  return reserved
}

/** 人类定向解析（humanMentions + 行首指名 handedTo）；无人类时返回空 */
export function parseSessionHumanMentions(
  session: Session,
  prompts: PromptLibrary,
  humans: HumanMentionInfo[],
  text: string,
): { humanMentions: string[]; handedTo: string[] } {
  if (humans.length === 0) return { humanMentions: [], handedTo: [] }
  const tokens = buildHumanMentionTokens(humans, reservedAgentTokens(session, prompts))
  return parseHumanMentions(text, tokens)
}
