/**
 * M57：共享会话人类消息署名解析（上下文装配 / 压缩摘要 / 记忆沉淀 / 列表预览共用）。
 *
 * 语义：会话存在 ≥1 共享成员（owner 之外）→ 返回昵称解析器；否则 undefined = 沿用「用户」/「你」。
 * 昵称缺省回退：message.userId 缺失 / 账号已删 → undefined（调用方回退「用户」）。
 */
import type { ChatMessage } from '@multi-agent/shared'
import type { SessionMemberStore } from '../store/session-members.js'
import type { UserStore } from '../store/users.js'

export type UserLabeler = (message: ChatMessage) => string | undefined

export interface UserLabelDeps {
  members?: SessionMemberStore
  users?: UserStore
}

export function createUserLabelResolver(deps: UserLabelDeps): (sessionId: string) => UserLabeler | undefined {
  return (sessionId) => {
    const { members, users } = deps
    if (!members || !users) return undefined
    if (members.count(sessionId) === 0) return undefined
    return (message) => (message.userId ? users.get(message.userId)?.displayName : undefined)
  }
}
