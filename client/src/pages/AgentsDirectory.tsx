import * as React from 'react'
import { ArrowLeft, Search } from 'lucide-react'
import { CATALOG_CATEGORIES } from '@multi-agent/shared'
import { useAgentStore } from '../stores/agent-store'
import { useUiStore } from '../stores/ui-store'
import { resolveIcon } from '../lib/avatar-icons'
import { buildCatalog, catalogHash, searchCatalog, type CatalogEntry, type CatalogKind, type CatalogSource } from '../lib/catalog'
import { AgentAvatar } from '../components/agents/AgentAvatar'
import { CatalogDetail, CatalogList } from '../components/agents/CatalogDetail'
import { Button } from '../components/ui/button'
import { Input } from '../components/ui/input'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'

const labels: Record<CatalogKind, string> = { scene: '场景', agent: '角色', preset: '预设' }

export function AgentsDirectory(): React.JSX.Element {
  const { agents, groups, presets, load, loading, loaded, error, reload } = useAgentStore()
  const [hash, setHash] = React.useState(() => window.location.hash)
  const [compared, setCompared] = React.useState<string[]>([])
  const [comparing, setComparing] = React.useState(false)
  const [notice, setNotice] = React.useState('')
  const opener = React.useRef<HTMLElement | null>(null)
  const params = new URLSearchParams(hash.split('?')[1])
  const tab = params.get('tab') ?? 'scene'
  const kind: CatalogKind = tab === 'agent' || tab === 'preset' ? tab : 'scene'
  const query = params.get('q') ?? ''
  const category = params.get('category') ?? 'all'
  const detail = params.get('detail') ?? ''
  const parent = params.get('parent') ?? ''
  const batch = kind === 'agent' ? 24 : 12
  const count = Math.max(batch, Math.min(10000, Number(params.get('count')) || batch))
  React.useEffect(() => { void load() }, [load])
  React.useEffect(() => {
    const listener = (): void => setHash(window.location.hash)
    window.addEventListener('hashchange', listener)
    return () => window.removeEventListener('hashchange', listener)
  }, [])
  const entries = React.useMemo(() => buildCatalog(agents, groups, presets), [agents, groups, presets])
  const byKey = React.useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries])
  const results = React.useMemo(() => searchCatalog(entries, query, category, kind), [entries, query, category, kind])
  const selected = byKey.get(detail)
  const comparison = compared.map((id) => byKey.get(id)).filter((e): e is CatalogEntry => Boolean(e))
  const update = (values: Record<string, string | undefined>, replace = false): void => {
    const next = catalogHash({ ...Object.fromEntries(params), ...values })
    if (replace) { window.history.replaceState(null, '', next); setHash(next) }
    else window.location.hash = next
  }
  const openDetail = (key: string): void => {
    if (!detail) opener.current = document.activeElement as HTMLElement
    update({ detail: key, parent: detail || undefined })
  }
  const use = (source: CatalogSource): void => {
    const ui = useUiStore.getState()
    // requestCreate 统一负责切回工作台（含未保存修改的离开确认）；被取消时留在目录
    if (!ui.requestCreate(source.kind, source.id, source.draft)) return
    ui.setMainTab('chat')
    window.location.hash = '#'
  }
  const compare = (key: string): void => {
    if (compared.includes(key)) { setCompared(compared.filter((id) => id !== key)); setNotice(''); return }
    if (compared.length >= 3) { setNotice('最多比较三个预设，请先移除一个。'); return }
    setCompared([...compared, key]); setNotice('')
  }
  return <div className="min-h-screen bg-background text-[13px]">
    <header className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
      <Button variant="ghost" size="sm" asChild><a href="#"><ArrowLeft className="size-4" />返回工作台</a></Button>
      <h1 className="text-lg font-semibold">场景与团队</h1>
      <a href="#" className="ml-auto text-primary" onClick={(event) => { event.preventDefault(); use({ kind: 'scene', id: 'blank' }) }}>通用助手 · 一人独立完成</a>
    </header>
    <main className="mx-auto max-w-7xl space-y-5 px-4 py-6 pb-28">
      <div><h2 className="text-2xl font-semibold">从你想完成的任务开始</h2><p className="mt-2 text-muted-foreground">按场景探索专家，或用任务预设快速组队。先了解交付与边界，再决定邀请谁。</p></div>
      <div className="flex flex-wrap gap-2" aria-label="目录页签">{(Object.keys(labels) as CatalogKind[]).map((k) => <Button key={k} aria-pressed={kind === k} variant={kind === k ? 'default' : 'outline'} onClick={() => update({ tab: k, count: undefined, detail: undefined, parent: undefined })}>{labels[k]} · {k === 'scene' ? groups.length : k === 'agent' ? agents.length : presets.length}</Button>)}</div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <div className="relative flex-1"><Search className="absolute left-3 top-3 size-4 text-muted-foreground" /><Input aria-label="搜索场景角色预设" placeholder="搜索任务、职责、能力或交付，例如：经营复盘" value={query} onChange={(e) => update({ q: e.target.value, count: undefined }, true)} className="h-10 pl-9 text-[13px]" /></div>
        <select aria-label="分类筛选" value={category} onChange={(e) => update({ category: e.target.value, count: undefined })} className="h-10 rounded-md border bg-card px-3"><option value="all">全部分类</option>{Object.entries(CATALOG_CATEGORIES).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
      </div>
      <p role="status" className="text-muted-foreground">{loading ? '正在加载资产…' : `找到 ${results.length} 个${labels[kind]}`}</p>
      {error && <div role="alert" className="rounded-lg border p-4">加载失败：{error}<Button variant="outline" className="ml-3" onClick={() => void reload()}>重试</Button></div>}
      {loaded && entries.length === 0 && <p className="rounded-lg border p-8 text-center">暂无可用资产，请在管理控制台添加。</p>}
      {loaded && entries.length > 0 && results.length === 0 && <div className="rounded-lg border p-8 text-center"><p>没有匹配结果，试试其他关键词或分类。</p><Button variant="ghost" onClick={() => update({ q: undefined, category: undefined, count: undefined })}>清除筛选</Button></div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{results.slice(0, count).map((e) => {
        const Icon = resolveIcon(e.group?.icon ?? e.preset?.icon)
        return <article key={e.key} className="flex min-w-0 flex-col rounded-xl border bg-card p-5 shadow-soft" data-catalog-card={e.key}>
          <div className="flex items-center gap-3">{e.agent ? <AgentAvatar agent={e.agent} size={44} animated={false} /> : <span className="rounded-lg bg-muted p-3" style={{ color: (e.group?.theme ?? e.preset?.theme)?.[0] }}><Icon className="size-5" /></span>}<div className="min-w-0"><h3 className="text-base font-semibold">{e.name}</h3><p className="text-muted-foreground">{e.agent?.role ?? CATALOG_CATEGORIES[e.category]}</p></div></div>
          <p className="my-3 leading-6 text-muted-foreground">{e.description}</p>
          {e.agent ? <><p className="mb-2 font-medium">{e.isDefault ? '默认成员' : '扩展专家'}</p><div className="flex flex-wrap gap-1">{e.agent.capabilities.slice(0, 3).map((s) => <span key={s} className="rounded bg-muted px-2 py-1">{s}</span>)}</div></> : <><CatalogList title="交付" items={e.catalog?.outputs.slice(0, 2)} /><p className="mt-3">推荐 {e.members.length} 人{e.group ? ` · 可选专家 ${e.experts.length} 人` : ''}</p>{e.preset && <><p className="mt-1 text-muted-foreground">{e.members.map((a) => a.role).join(' · ')}</p><p className="mt-1 text-muted-foreground">{e.groups.map((g) => g.name).join(' / ')}</p></>}</>}
          <div className="mt-auto flex flex-wrap gap-2 pt-4"><Button size="sm" variant="outline" onClick={() => openDetail(e.key)}>查看详情</Button><Button size="sm" onClick={() => use({ kind: e.kind, id: e.id })}>使用{labels[e.kind]}</Button>{e.preset && <Button size="sm" variant="ghost" aria-pressed={compared.includes(e.key)} onClick={() => compare(e.key)}>{compared.includes(e.key) ? '移出比较' : '加入比较'}</Button>}</div>
        </article>
      })}</div>
      {results.length > count && <div className="text-center"><Button variant="outline" onClick={() => update({ count: String(count + batch) }, true)}>显示更多（已显示 {count} / {results.length}）</Button></div>}
    </main>
    {(compared.length > 0 || notice) && <div className="fixed inset-x-0 bottom-0 z-20 flex flex-wrap items-center justify-center gap-3 border-t bg-card p-3 text-[13px]"><span role="status">{notice || `已选 ${compared.length} / 3 个预设`}</span>{comparison.map((e) => <Button key={e.key} variant="outline" size="sm" onClick={() => compare(e.key)}>{e.name} ×</Button>)}<Button onClick={() => setComparing(true)} disabled={!comparison.length}>比较预设</Button></div>}
    <Dialog open={Boolean(detail)} onOpenChange={(open) => { if (!open) update({ detail: undefined, parent: undefined }) }}><DialogContent aria-describedby={undefined} onCloseAutoFocus={(event) => { event.preventDefault(); opener.current?.focus() }} className="left-auto right-0 top-0 h-dvh w-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto rounded-none p-5 pt-12">
      <DialogTitle>{selected?.name ?? '资产不存在'}</DialogTitle>
      {parent && byKey.has(parent) && <Button variant="ghost" className="my-3" onClick={() => update({ detail: parent, parent: undefined })}><ArrowLeft className="size-4" />返回{byKey.get(parent)?.name}</Button>}
      {selected ? <CatalogDetail key={selected.key} entry={selected} entries={entries} onNavigate={openDetail} onUse={use} /> : <p className="mt-4">该资产不存在或已下线。请关闭详情后重新选择。</p>}
    </DialogContent></Dialog>
    <Dialog open={comparing} onOpenChange={setComparing}><DialogContent aria-describedby={undefined} className="max-h-[90dvh] w-[calc(100%-2rem)] max-w-5xl overflow-y-auto"><DialogTitle>预设比较</DialogTitle><div className="mt-5 grid gap-4 md:grid-cols-3">{comparison.map((e) => <section key={e.key} className="min-w-0 space-y-4 rounded-lg border p-4 text-[13px]"><h3 className="text-base font-semibold">{e.name}</h3><p>{e.description}</p><CatalogList title="准备资料" items={e.catalog?.inputs} /><CatalogList title="产出" items={e.catalog?.outputs} /><CatalogList title={`成员 · ${e.members.length} 人`} items={e.members.map((a) => `${a.name} · ${a.role}${comparison.every((p) => p.members.some((m) => m.id === a.id)) ? '（共同成员）' : ''}`)} /><Button onClick={() => use({ kind: 'preset', id: e.id })}>使用预设</Button></section>)}</div></DialogContent></Dialog>
  </div>
}
