import * as React from 'react'
import { CATALOG_CATEGORIES } from '@multi-agent/shared'
import type { CatalogEntry, CatalogSource } from '../../lib/catalog'
import { AgentAvatar } from './AgentAvatar'
import { Button } from '../ui/button'

export function CatalogList({ title, items }: { title: string; items?: string[] }): React.JSX.Element | null {
  if (!items?.length) return null
  return <section className="space-y-2"><h3 className="font-semibold">{title}</h3><ul className="list-disc space-y-1 pl-5 text-muted-foreground">{items.map((s) => <li key={s}>{s}</li>)}</ul></section>
}

/** 纯内容视图：目录抽屉与组队台同层详情复用，不自行创建模态框。 */
export function CatalogDetail({ entry, entries, onNavigate, onUse }: {
  entry: CatalogEntry
  entries: CatalogEntry[]
  onNavigate: (key: string) => void
  onUse: (source: CatalogSource) => void
}): React.JSX.Element {
  const [draft, setDraft] = React.useState(entry.preset?.prompt ?? '')
  const byKey = React.useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const { agent, group, preset } = entry
  const related = group ? entries.filter((e) => e.preset && e.groups.some((g) => g.id === group.id)) : []
  const memberLinks = (members: CatalogEntry['members']): React.JSX.Element => <div className="space-y-2">{members.map((a) => <button key={a.id} type="button" onClick={() => onNavigate(`agent:${a.id}`)} className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"><AgentAvatar agent={a} animated={false} /><span className="min-w-0"><span className="font-medium">{a.name} · {a.role}</span><span className="mt-1 block text-muted-foreground">{a.description}</span></span></button>)}</div>
  return <div className="space-y-6 break-words text-[13px] leading-6">
    <div className="space-y-2"><p className="text-muted-foreground">{CATALOG_CATEGORIES[entry.category]}{agent ? ` · ${entry.isDefault ? '默认成员' : '扩展专家'}` : ''}</p><p>{entry.description}</p></div>
    <CatalogList title="准备资料" items={entry.catalog?.inputs} />
    <CatalogList title="你会得到" items={entry.catalog?.outputs} />
    {entry.catalog?.boundary && <section className="rounded-lg border bg-muted/40 p-3"><h3 className="font-semibold">适用边界</h3><p className="text-muted-foreground">{entry.catalog.boundary}</p></section>}
    {agent ? <>
      <CatalogList title="能力与职责" items={agent.capabilities} />
      {agent.handoff.length > 0 && <section><h3 className="mb-2 font-semibold">交接对象</h3><div className="flex flex-wrap gap-2">{agent.handoff.map((id) => <Button key={id} variant="outline" size="sm" onClick={() => onNavigate(`agent:${id}`)} disabled={!byKey.has(`agent:${id}`)}>{byKey.get(`agent:${id}`)?.name ?? id}</Button>)}</div></section>}
      {(agent.skills?.length ?? 0) > 0 && <details><summary className="cursor-pointer font-semibold">技能（高级）</summary><CatalogList title="预载技能" items={agent.skills} /></details>}
      {(agent.souls?.length ?? 0) > 0 && <details><summary className="cursor-pointer font-semibold">表达风格</summary><p className="text-muted-foreground">Soul 只调整表达与互动方式；可在组队台选择多个风格作为分身同台。</p>{agent.souls!.map((s) => <div key={s.id} className="mt-3 rounded-lg border p-3"><h4 className="font-medium">{s.name}{s.id === agent.defaultSoul ? ' · 默认' : ''}</h4><p>{s.tagline}</p><p className="text-muted-foreground">{s.traits.join(' · ')} · {s.tone}</p></div>)}</details>}
    </> : <>
      <section><h3 className="mb-2 font-semibold">{group ? '默认团队' : '成员分工'} · {entry.members.length} 人</h3>{memberLinks(entry.members)}<p className="mt-2 text-muted-foreground">推荐编制不是强制执行顺序，实际协作受会话接力与运行策略控制。</p></section>
      {entry.experts.length > 0 && <section><h3 className="mb-2 font-semibold">扩展专家 · {entry.experts.length} 人</h3>{memberLinks(entry.experts)}</section>}
    </>}
    {preset && <section><h3 className="mb-2 font-semibold">关联场景</h3><div className="flex flex-wrap gap-2">{entry.groups.map((g) => <Button key={g.id} variant="outline" size="sm" onClick={() => onNavigate(`scene:${g.id}`)}>{g.name}</Button>)}</div></section>}
    {related.length > 0 && <section><h3 className="mb-2 font-semibold">关联预设</h3><div className="flex flex-wrap gap-2">{related.map((e) => <Button key={e.key} variant="outline" size="sm" onClick={() => onNavigate(e.key)}>{e.name}</Button>)}</div></section>}
    {!!group?.agenda?.length && <section><h3 className="mb-2 font-semibold">选择示例任务</h3><p className="mb-2 text-muted-foreground">只预填开场草稿，创建后仍需你确认发送。</p><div className="flex flex-wrap gap-2">{group.agenda.map((a) => <Button key={a.label} variant="outline" size="sm" onClick={() => onUse({ kind: 'scene', id: group.id, draft: a.prompt })}>{a.label}</Button>)}</div></section>}
    {preset && <label className="block space-y-2 font-semibold">开场草稿<textarea aria-label="开场草稿" value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-40 w-full rounded-lg border bg-background p-3 font-normal" /><span className="block font-normal text-muted-foreground">可编辑；只在创建成功后预填，不自动发送。</span></label>}
    <div className="sticky bottom-0 border-t bg-card py-3"><Button className="w-full" onClick={() => onUse({ kind: entry.kind, id: entry.id, ...(preset ? { draft } : {}) })}>{agent ? '使用此角色' : preset ? '使用预设' : '使用场景'}</Button></div>
  </div>
}
