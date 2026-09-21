/**
 * M79-G：在线状态可见域（好友 ∪ 同会话人类成员）——presence 扇出收件人计算。
 *
 * 语义（docs/social-collab-design.md §10 / §22 修订）：
 * - 好友：社交面互相关注的双方；
 * - 同会话：与主体同属一个会话的属主与全部人类成员（DM / 群 / 团队一致）——协作者需要彼此可见在线态；
 * - 去重、排除本人；不返回任何无关用户（隐私最小面）。
 */
import type { FriendStore } from '../store/friends.js'
import type { SessionMemberStore } from '../store/session-members.js'
import type { SessionStore } from '../store/sessions.js'

export interface PresenceRecipientsDeps {
  friends: FriendStore
  sessions: SessionStore
  members: SessionMemberStore
}

/** 构造「presence 收件人」查询：入参 userId → 收件人集合（不含本人） */
export function createPresenceRecipients(deps: PresenceRecipientsDeps): (userId: string) => Set<string> {
  return (userId) => {
    const out = new Set<string>()
    for (const f of deps.friends.listFriends(userId)) out.add(f.userId)
    for (const s of deps.sessions.listForUser(userId)) {
      if (s.ownerId) out.add(s.ownerId)
      for (const m of deps.members.list(s.id)) out.add(m.userId)
    }
    out.delete(userId)
    return out
  }
}
