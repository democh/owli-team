/**
 * M46：roster_catalog（可召集角色目录）。
 *
 * M48 起作为平台路由步（PRS）的输入：列出「未在场」角色（按场景分组；场景行含 objective 与默认编制链），
 * 由路由器决定召集名单与任务派发（原调度官回合注入已撤销）。已在场角色不重复列出，控制 token 体积。
 *
 * - 由 PromptLibrary 派生（id / name / role / description 截断；场景 id / name / objective / chain）；
 * - 资产热更新：按（目录签名 + 在场集合）缓存渲染结果（LRU 上限 32），资产变更 → 签名变化 → 重建；
 * - 无未在场角色（全员在场 / 空库）→ 返回空串（不注入）。
 */
import { BLANK_SCENE_ID } from '@multi-agent/shared'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import type { PromptLibrary } from '../store/prompts.js'

/** 角色行 description 截断长度（控制区块体积：目录预估 2–4k token） */
const DESC_MAX = 60
/** 场景行 objective 截断长度 */
const OBJECTIVE_MAX = 60
/** 头部「已在场」明细展示上限（超出折叠为计数） */
const PRESENT_MAX = 10
/** 渲染缓存上限（键 = 目录签名 + 在场集合） */
const CACHE_MAX = 32

const cache = new Map<string, string>()

/** 目录签名：角色与场景关键字段的稳定拼接（内容级热更新判定） */
function signatureOf(agents: AgentDefinition[], groups: AgentGroup[]): string {
  const agentPart = agents.map((a) => `${a.id}|${a.name}|${a.role}|${a.description}|${a.group}`).join(';')
  const groupPart = groups.map((g) => `${g.id}|${g.name}|${g.objective}|${g.chain.join(',')}`).join(';')
  return `${agentPart}#${groupPart}`
}

/** 单行折叠 + 截断（防换行破坏列表结构 / 控制体积） */
function truncate(text: string, max: number): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 场景行 + 成员行渲染 */
function pushGroup(lines: string[], group: AgentGroup | undefined, gid: string, members: AgentDefinition[]): void {
  const bits: string[] = []
  if (group?.objective) bits.push(`objective：${truncate(group.objective, OBJECTIVE_MAX)}`)
  if (group?.chain?.length) bits.push(`编制：${group.chain.join(' → ')}`)
  lines.push(`## ${group?.name ?? gid} ${gid}${bits.length ? `（${bits.join('；')}）` : ''}`)
  for (const a of members) lines.push(`- ${a.id} ${a.name} · ${a.role}：${truncate(a.description, DESC_MAX)}`)
}

/**
 * 构建 <roster_catalog> 区块（未在场角色目录；含场景 objective 与编制链）。
 * @param presentIds 会话在场成员 id（空数组 = 零编制开场，全员可召集）
 */
export function buildRosterCatalogBlock(prompts: PromptLibrary, presentIds: string[]): string {
  // M50：空场景角色不进可召集目录（通用助手不可被平台自动召集；已在场展示不受影响）
  const agents = prompts.list().filter((a) => a.group !== BLANK_SCENE_ID)
  const groups = prompts.groups().filter((g) => g.id !== BLANK_SCENE_ID)
  const present = [...new Set(presentIds)]
  const key = `${signatureOf(agents, groups)}#${[...present].sort().join(',')}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    // LRU 触碰（重插队尾）
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }

  const presentSet = new Set(present)
  const missing = agents.filter((a) => !presentSet.has(a.id))
  let block = ''
  if (missing.length > 0) {
    const nameOf = (id: string): string => prompts.get(id)?.name ?? id
    const shown = present.slice(0, PRESENT_MAX).map((id) => `${nameOf(id)}(${id})`)
    const presentLine =
      present.length > PRESENT_MAX ? `${shown.join('、')}…（共 ${present.length} 位）` : shown.join('、')
    const lines = [
      '<roster_catalog>',
      `你可召集下列未在场角色（已在场：${presentLine}）。按场景分组；scene_id 可整链召集该场景默认编制。`,
    ]
    const byGroup = new Map<string, AgentDefinition[]>()
    for (const a of missing) {
      const list = byGroup.get(a.group)
      if (list) list.push(a)
      else byGroup.set(a.group, [a])
    }
    const seen = new Set<string>()
    for (const g of groups) {
      const members = byGroup.get(g.id)
      if (!members || members.length === 0) continue
      seen.add(g.id)
      pushGroup(lines, g, g.id, members)
    }
    // 兜底：未注册场景（资产异常）不丢角色
    for (const [gid, members] of byGroup) {
      if (!seen.has(gid)) pushGroup(lines, undefined, gid, members)
    }
    lines.push('</roster_catalog>')
    block = lines.join('\n')
  }

  cache.set(key, block)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return block
}
