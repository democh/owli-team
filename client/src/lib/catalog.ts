import { baseAgentId, catalogCategory, type AgentDefinition, type AgentGroup, type AssetCatalog, type CatalogCategory, type RosterPreset } from '@multi-agent/shared'

export type CatalogKind = 'scene' | 'agent' | 'preset'
export interface CatalogSource { kind: CatalogKind; id: string; draft?: string }
export interface CatalogEntry {
  key: string
  kind: CatalogKind
  id: string
  name: string
  description: string
  category: CatalogCategory
  catalog?: AssetCatalog
  agent?: AgentDefinition
  group?: AgentGroup
  preset?: RosterPreset
  members: AgentDefinition[]
  experts: AgentDefinition[]
  groups: AgentGroup[]
  isDefault: boolean
  order: number
  primary: string
  secondary: string
  text: string
}

const lower = (text: string): string => text.normalize('NFKC').toLocaleLowerCase()
export function buildCatalog(agents: AgentDefinition[], groups: AgentGroup[], presets: RosterPreset[]): CatalogEntry[] {
  const byId = new Map(agents.map((a) => [a.id, a]))
  const groupById = new Map(groups.map((g) => [g.id, g]))
  const grouped = new Map<string, AgentDefinition[]>()
  const defaults = new Set<string>()
  for (const g of groups) for (const id of [...g.chain, ...(g.ritual?.members ?? []), ...Object.values(g.stage?.seats ?? {}).flat()]) defaults.add(baseAgentId(id))
  for (const p of presets) for (const id of p.members) defaults.add(baseAgentId(id))
  for (const a of agents) grouped.set(a.group, [...(grouped.get(a.group) ?? []), a])
  const membersOf = (ids: string[]): AgentDefinition[] => ids.map((id) => byId.get(baseAgentId(id))).filter((a): a is AgentDefinition => Boolean(a))
  const entry = (kind: CatalogKind, asset: AgentDefinition | AgentGroup | RosterPreset): CatalogEntry => {
    const agent = kind === 'agent' ? asset as AgentDefinition : undefined
    const group = kind === 'scene' ? asset as AgentGroup : undefined
    const preset = kind === 'preset' ? asset as RosterPreset : undefined
    const ownGroup = agent ? groupById.get(agent.group) : group
    const members = agent ? [agent] : membersOf(group?.chain ?? preset?.members ?? [])
    const related = [...new Set(members.map((a) => a.group))].map((id) => groupById.get(id)).filter((g): g is AgentGroup => Boolean(g))
    const catalog = asset.catalog
    return {
      key: `${kind}:${asset.id}`, kind, id: asset.id, name: asset.name, description: asset.description,
      category: catalogCategory(ownGroup?.category ?? preset?.category), catalog, agent, group, preset,
      members, experts: group ? (grouped.get(group.id) ?? []).filter((a) => !group.chain.includes(a.id)) : [],
      groups: ownGroup ? [ownGroup] : related, isDefault: agent ? defaults.has(agent.id) : true,
      order: group?.order ?? preset?.order ?? ownGroup?.order ?? 100,
      primary: lower([asset.name, agent?.role, asset.id].filter(Boolean).join(' ')),
      secondary: lower([...(agent?.capabilities ?? []), ...(catalog?.keywords ?? [])].join(' ')),
      text: lower([asset.description, group?.objective, ...(catalog?.inputs ?? []), ...(catalog?.outputs ?? [])].filter(Boolean).join(' ')),
    }
  }
  return [...groups.map((g) => entry('scene', g)), ...agents.map((a) => entry('agent', a)), ...presets.map((p) => entry('preset', p))]
}

export function searchCatalog(entries: CatalogEntry[], query: string, category = 'all', kind?: CatalogKind): CatalogEntry[] {
  const words = lower(query).trim().split(/\s+/).filter(Boolean)
  return entries.filter((e) => (!kind || e.kind === kind) && (category === 'all' || e.category === category))
    .map((e) => ({ e, scores: words.map((w) => e.primary.includes(w) ? 3 : e.secondary.includes(w) ? 2 : e.text.includes(w) ? 1 : 0) }))
    .filter(({ scores }) => scores.every(Boolean))
    .sort((a, b) => b.scores.reduce<number>((s, n) => s + n, 0) - a.scores.reduce<number>((s, n) => s + n, 0) || a.e.order - b.e.order || a.e.id.localeCompare(b.e.id))
    .map(({ e }) => e)
}

export function catalogHash(values: Record<string, string | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value) params.set(key, value)
  return `#/agents?${params.toString()}`
}
