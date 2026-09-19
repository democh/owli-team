/**
 * 成员键（memberKey）：同一角色「多魂同时上场」的身份寻址（M77 · 成员分身）。
 *
 * - 经典实例：`agentId`（如 `luna`）——灵魂可换（memberSouls 覆盖，语义与 M16 完全一致）；
 * - 分身实例：`agentId~soulId`（如 `luna~zen`）——灵魂内嵌在键里（自描述、不可与同角其他实例重复灵魂）。
 *
 * 键的字符集约束：agentId / soulId 均为 `^[a-z][a-z0-9-]{0,39}$`（不含 `~`），
 * 故按首个 `~` 切分即可安全还原 base 与灵魂；存量数据（纯 agentId）天然是合法成员键。
 */

/** 成员键分隔符（分身实例：`agentId~soulId`） */
export const MEMBER_SEP = '~'

/** 展示名分隔符（分身展示：`名字·灵魂名`；同时是 @ 点名的规范 token） */
export const MEMBER_LABEL_SEP = '·'

/** 成员键 → 基础角色 id（经典实例返回自身） */
export function baseAgentId(memberKey: string): string {
  const idx = memberKey.indexOf(MEMBER_SEP)
  return idx === -1 ? memberKey : memberKey.slice(0, idx)
}

/** 成员键 → 内嵌灵魂 id（经典实例 = undefined） */
export function soulIdOfMember(memberKey: string): string | undefined {
  const idx = memberKey.indexOf(MEMBER_SEP)
  return idx === -1 ? undefined : memberKey.slice(idx + 1)
}

/** 构造成员键：无灵魂 = 经典实例（agentId）；有灵魂 = 分身实例（agentId~soulId） */
export function memberKeyOf(agentId: string, soulId?: string | undefined): string {
  return soulId ? `${agentId}${MEMBER_SEP}${soulId}` : agentId
}

/** 分身实例展示名（`名字·灵魂名`）；无灵魂 = 名字 */
export function memberLabel(agentName: string, soulName?: string | undefined): string {
  return soulName ? `${agentName}${MEMBER_LABEL_SEP}${soulName}` : agentName
}
