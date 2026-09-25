/**
 * 记忆面板（M8 → M25.3c）：跨 scope 记忆管理。
 * - scope 分段：会话 / 成员 / 项目 / 全局（owner 自动解析：会话 id / 成员 id / 项目 id / global）；
 * - 状态筛选：有效 / 候选 / 归档 / 已取代 / 全部（候选 → 通过 / 忽略审核）；
 * - 语义搜索：POST /api/memories/recall（评分调试，展示混合评分 score）；
 * - supersede：active 条目选择替代者（POST /api/memories/:id/supersede，旧条目转 superseded）；
 * - 会话 scope 保持旧接口兼容（新增 / 编辑 / 删除 + 引用到输入框）；
 * - 数据源：GET /api/memories、PATCH /api/memories/:id/status、POST /api/memories/reindex。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  Archive,
  ArrowLeftRight,
  Ban,
  BrainCircuit,
  Check,
  DatabaseZap,
  Globe,
  Loader2,
  Pencil,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import type { MemoryItem, MemoryKind, MemoryScope, MemoryStatus, RecalledMemory } from '@multi-agent/shared'
import { baseAgentId } from '@multi-agent/shared'
import { apiDelete, apiGet, apiPatch, apiPost } from '../../lib/api'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { useSpaceStore } from '../../stores/space-store'
import { useUiStore } from '../../stores/ui-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'

const KINDS: { value: MemoryKind; label: string }[] = [
  { value: 'decision', label: '决策' },
  { value: 'constraint', label: '约束' },
  { value: 'glossary', label: '术语' },
  { value: 'artifact', label: '交付件' },
  { value: 'fact', label: '事实' },
  { value: 'preference', label: '偏好' },
  { value: 'lesson', label: '经验' },
]

const KIND_BADGE: Record<MemoryKind, 'default' | 'success' | 'warning' | 'outline'> = {
  decision: 'default',
  constraint: 'warning',
  glossary: 'outline',
  artifact: 'success',
  fact: 'default',
  preference: 'success',
  lesson: 'warning',
}

/** M25：关联层级（scope 分段） */
const SCOPES: { value: MemoryScope; label: string }[] = [
  { value: 'session', label: '会话' },
  { value: 'agent', label: '成员' },
  { value: 'project', label: '项目' },
  { value: 'global', label: '全局' },
]

/** M25：状态筛选（候选 → 审核入口） */
const STATUSES: { value: MemoryStatus | 'all'; label: string }[] = [
  { value: 'active', label: '有效' },
  { value: 'candidate', label: '候选' },
  { value: 'archived', label: '归档' },
  { value: 'superseded', label: '已取代' },
  { value: 'all', label: '全部' },
]

const STATUS_LABEL: Record<MemoryStatus, string> = {
  active: '有效',
  candidate: '候选',
  archived: '归档',
  superseded: '已取代',
}

export function MemoryPanel(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useCurrentSession()
  const agents = useAgentStore((s) => s.agents)
  const insertToComposer = useUiStore((s) => s.insertToComposer)

  const [scope, setScope] = React.useState<MemoryScope>('session')
  // P2：空间域（随左栏空间切换；空 = 未装配空间能力不过滤）
  const spaces = useSpaceStore((s) => s.spaces)
  const currentSpace = useSpaceStore((s) => s.currentId)
  /** P2 审计：仅看跨域共享（全局）记忆（服务端 spaceId=shared 语义） */
  const [auditShared, setAuditShared] = React.useState(false)
  const spaceId = spaces.length > 0 ? (auditShared ? 'shared' : currentSpace) : ''
  const [statusFilter, setStatusFilter] = React.useState<MemoryStatus | 'all'>('active')
  const [kindFilter, setKindFilter] = React.useState<MemoryKind | 'all'>('all')
  const [items, setItems] = React.useState<MemoryItem[]>([])
  const [boundKey, setBoundKey] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [reindexing, setReindexing] = React.useState(false)

  // 语义搜索（null = 非搜索模式）
  const [searchQuery, setSearchQuery] = React.useState('')
  const [searching, setSearching] = React.useState(false)
  const [search, setSearch] = React.useState<{ items: RecalledMemory[]; skipped?: string; candidates: number } | null>(
    null,
  )

  // 新增表单（仅会话 scope 提供入口）
  const [adding, setAdding] = React.useState(false)
  const [newKind, setNewKind] = React.useState<MemoryKind>('decision')
  const [newContent, setNewContent] = React.useState('')
  const [savingNew, setSavingNew] = React.useState(false)

  // 内联编辑（仅会话 scope）
  const [editingId, setEditingId] = React.useState<string | null>(null)
  const [editDraft, setEditDraft] = React.useState('')
  const [savingEdit, setSavingEdit] = React.useState(false)

  // supersede：展开选择替代者的条目 id
  const [supersedeFor, setSupersedeFor] = React.useState<string | null>(null)

  // agent scope 的成员选择（默认会话首位成员；M77：按基础角色去重——记忆归属与 remember 工具同为角色级）
  const participantIds = React.useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const key of session?.participantIds ?? []) {
      const base = baseAgentId(key)
      if (seen.has(base)) continue
      seen.add(base)
      out.push(base)
    }
    return out
  }, [session])
  const [agentOwner, setAgentOwner] = React.useState('')
  const participantKey = participantIds.join(',')
  React.useEffect(() => {
    const ids = participantKey ? participantKey.split(',') : []
    if (ids.length === 0) return
    setAgentOwner((prev) => (prev && ids.includes(prev) ? prev : ids[0]!))
  }, [participantKey])

  const owner =
    scope === 'session'
      ? (currentId ?? '')
      : scope === 'agent'
        ? agentOwner
        : scope === 'project'
          ? (session?.projectId ?? '')
          : 'global'
  const ownerUsable =
    owner.length > 0 && (scope !== 'session' || Boolean(currentId)) && (scope !== 'project' || Boolean(session?.projectId))

  const currentKey = `${scope}|${owner}|${statusFilter}|${kindFilter}|${spaceId}`
  const load = React.useCallback(async (): Promise<void> => {
    const key = `${scope}|${owner}|${statusFilter}|${kindFilter}|${spaceId}`
    if (!owner) {
      setItems([])
      setBoundKey(key)
      return
    }
    setLoading(true)
    try {
      const params = new URLSearchParams({ scope, owner })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (kindFilter !== 'all') params.set('kind', kindFilter)
      // P2：空间域过滤（当前空间 + 跨域共享；面板随左栏空间切换）
      if (spaceId) params.set('spaceId', spaceId)
      const res = await apiGet<{ memory: MemoryItem[] }>(`/api/memories?${params.toString()}`)
      setItems(res.memory)
      setBoundKey(key)
    } catch {
      setItems([])
      setBoundKey(key)
    } finally {
      setLoading(false)
    }
  }, [scope, owner, statusFilter, kindFilter, spaceId])

  React.useEffect(() => {
    setSearch(null)
    setSupersedeFor(null)
    void load()
  }, [load])

  const bound = boundKey === currentKey
  const list = React.useMemo(() => (bound ? items : []), [bound, items])
  const counts = React.useMemo(() => {
    const map = new Map<MemoryKind, number>()
    for (const m of list) map.set(m.kind, (map.get(m.kind) ?? 0) + 1)
    return map
  }, [list])
  const activeInScope = React.useMemo(() => list.filter((m) => m.status === 'active'), [list])

  // ---------- 会话 scope 旧接口（新增 / 编辑 / 删除） ----------

  const submitNew = async (): Promise<void> => {
    if (!currentId) return
    const content = newContent.trim()
    if (!content) return
    setSavingNew(true)
    try {
      const res = await apiPost<{ item?: MemoryItem; added: boolean }>(`/api/sessions/${currentId}/memory`, {
        kind: newKind,
        content,
      })
      toast(res.added ? '已添加记忆' : '该内容已存在，未重复添加')
      setNewContent('')
      setAdding(false)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingNew(false)
    }
  }

  const submitEdit = async (id: string): Promise<void> => {
    const content = editDraft.trim()
    if (!content) return
    setSavingEdit(true)
    try {
      await apiPatch<{ item: MemoryItem }>(`/api/sessions/${currentId}/memory/${id}`, { content })
      setItems((prev) => prev.map((m) => (m.id === id ? { ...m, content } : m)))
      setEditingId(null)
      toast('已更新')
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSavingEdit(false)
    }
  }

  const remove = async (id: string): Promise<void> => {
    try {
      await apiDelete(`/api/sessions/${currentId}/memory/${id}`)
      setItems((prev) => prev.filter((m) => m.id !== id))
      toast('已删除记忆')
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // ---------- M25：状态流转 / 审核 / supersede / 重建 ----------

  /** P5 前置：提升为跨域共享（全局记忆）——仅私人条目；服务端留审计；就地重载列表 */
  const elevateItem = async (item: MemoryItem): Promise<void> => {
    try {
      await apiPost(`/api/memories/${item.id}/elevate`, {})
      toast('已提升为跨域共享（全局记忆）')
      void load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const setStatus = async (id: string, status: MemoryStatus, okText: string): Promise<void> => {
    try {
      await apiPatch(`/api/memories/${id}/status`, { status })
      toast(okText)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const supersede = async (oldId: string, newId: string): Promise<void> => {
    try {
      await apiPost(`/api/memories/${oldId}/supersede`, { newId })
      toast('已标记取代（旧条目不再参与召回）')
      setSupersedeFor(null)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const runReindex = async (): Promise<void> => {
    setReindexing(true)
    try {
      const res = await apiPost<{ result: { model?: string; dim?: number; requeued: number } }>(
        '/api/memories/reindex',
        {},
      )
      toast(`已重建：${res.result.model ?? '-'} ${res.result.dim ?? '-'}d，补账 ${res.result.requeued} 条`)
      await load()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setReindexing(false)
    }
  }

  const runSearch = async (): Promise<void> => {
    if (!currentId) return
    const query = searchQuery.trim()
    if (!query) return
    setSearching(true)
    try {
      const res = await apiPost<{
        outcome: { items: RecalledMemory[]; skipped?: string; candidates: number }
      }>('/api/memories/recall', {
        query,
        sessionId: currentId,
        agentId: agentOwner || participantIds[0],
        projectId: session?.projectId,
      })
      setSearch(res.outcome)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSearching(false)
    }
  }

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id

  if (!currentId) {
    return <div className="flex h-full items-center justify-center text-[12.5px] text-muted-foreground">先选择一个会话</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-[11.5px] text-muted-foreground">
        <BrainCircuit className="size-3.5" />
        <span>记忆 {search ? `${search.items.length} 条（语义搜索）` : `${list.length} 条`}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title="重建向量索引（模型/维度切换后补账）"
          disabled={reindexing}
          onClick={() => void runReindex()}
        >
          {reindexing ? <Loader2 className="size-3.5 animate-spin" /> : <DatabaseZap className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="刷新记忆"
          disabled={loading}
          onClick={() => void load()}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
        {scope === 'session' && (
          <Button
            variant="ghost"
            size="icon-sm"
            title={adding ? '收起' : '新增记忆'}
            onClick={() => setAdding((v) => !v)}
          >
            {adding ? <X className="size-3.5" /> : <Plus className="size-3.5" />}
          </Button>
        )}
      </div>

      {/* scope 分段 + owner 提示 */}
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        {SCOPES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setScope(s.value)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              scope === s.value ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent/70',
            )}
          >
            {s.label}
          </button>
        ))}
        {/* P2：空间域可见化 + 跨空间审计——记忆按空间隔离，跨域共享条目（无空间标签）对全空间可见 */}
        {spaceId && (
          <span
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title={
              auditShared
                ? '跨空间审计：仅显示跨域共享（全局）记忆——各空间的私有记忆不在此列出'
                : '记忆按空间隔离：此处仅显示当前空间与跨域共享的记忆'
            }
          >
            空间·{auditShared ? '跨域共享' : (spaces.find((s) => s.id === spaceId)?.name ?? spaceId)}
          </span>
        )}
        {spaces.length > 0 && (
          <button
            type="button"
            className="rounded-full px-1.5 py-0.5 text-[10px] text-primary/80 transition-colors hover:bg-primary/10 hover:text-primary"
            title={auditShared ? '返回当前空间视图' : '跨空间记忆审计：一键查看哪些记忆是跨域共享（全局）的'}
            onClick={() => setAuditShared((v) => !v)}
          >
            {auditShared ? '返回当前空间' : '仅看跨域共享'}
          </button>
        )}
        <span className="ml-auto max-w-[45%] truncate text-[10.5px] text-muted-foreground/80" title={owner}>
          {scope === 'agent'
            ? participantIds.length > 0
              ? agentName(agentOwner)
              : '（无成员）'
            : scope === 'project'
              ? (session?.projectId ?? '（未关联项目）')
              : scope === 'session'
                ? (session?.title ?? '')
                : 'global'}
        </span>
        {scope === 'agent' && participantIds.length > 1 && (
          <select
            aria-label="选择成员"
            value={agentOwner}
            onChange={(e) => setAgentOwner(e.target.value)}
            className="rounded border bg-background px-1 py-0.5 text-[10.5px] outline-none"
          >
            {participantIds.map((id) => (
              <option key={id} value={id}>
                {agentName(id)}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 状态 + kind 筛选 */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setStatusFilter(s.value)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              statusFilter === s.value
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-accent/70',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        <button
          type="button"
          onClick={() => setKindFilter('all')}
          className={cn(
            'rounded-full px-2 py-0.5 text-[11px] transition-colors',
            kindFilter === 'all' ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent/70',
          )}
        >
          全部 {list.length}
        </button>
        {KINDS.map((k) => (
          <button
            key={k.value}
            type="button"
            onClick={() => setKindFilter(k.value)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[11px] transition-colors',
              kindFilter === k.value
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-muted-foreground hover:bg-accent/70',
            )}
          >
            {k.label} {counts.get(k.value) ?? 0}
          </button>
        ))}
      </div>

      {/* 语义搜索 */}
      <div className="flex items-center gap-1.5 border-b px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch()
            if (e.key === 'Escape') setSearch(null)
          }}
          placeholder="语义搜索（回车召回，含评分）"
          className="h-6 min-w-0 flex-1 rounded border bg-background px-2 text-[11.5px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
        />
        {searching && <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />}
        {search && (
          <button
            type="button"
            title="退出搜索"
            onClick={() => setSearch(null)}
            className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>

      {/* 新增表单（会话 scope） */}
      {adding && scope === 'session' && (
        <div className="space-y-2 border-b bg-muted/30 p-2.5">
          <div className="flex flex-wrap gap-1">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => setNewKind(k.value)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  newKind === k.value
                    ? 'border-primary/50 bg-primary/10 font-medium text-primary'
                    : 'border-border text-muted-foreground hover:bg-accent/70',
                )}
              >
                {k.label}
              </button>
            ))}
          </div>
          <textarea
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
            placeholder="例如：接口错误码统一用 { code, message } 结构"
            rows={2}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitNew()
            }}
            className="w-full resize-none rounded-lg border bg-background px-2.5 py-1.5 text-[12px] leading-5 outline-none placeholder:text-muted-foreground/60 focus:border-primary/50"
          />
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[10.5px] text-muted-foreground">⌘/Ctrl+Enter 保存</span>
            <Button variant="outline" size="xs" onClick={() => setAdding(false)}>
              取消
            </Button>
            <Button size="xs" disabled={!newContent.trim() || savingNew} onClick={() => void submitNew()}>
              {savingNew && <Loader2 className="size-3 animate-spin" />}
              添加
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {/* 语义搜索结果（跨 scope，含评分） */}
        {search ? (
          <div className="space-y-1.5">
            {search.skipped && (
              <div className="px-3 py-6 text-center text-[12px] leading-5 text-muted-foreground">
                {search.skipped}
                <br />
                （在设置 → 向量记忆中选择嵌入连接后启用）
              </div>
            )}
            {!search.skipped && search.items.length === 0 && (
              <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                无召回结果（候选 {search.candidates} 条，均低于阈值）
              </div>
            )}
            {search.items.map((item) => (
              <div key={item.id} className="rounded-lg border bg-card px-2.5 py-2 text-[12px] shadow-soft">
                <div className="flex items-center gap-1.5">
                  <Badge variant={KIND_BADGE[item.kind]}>{KINDS.find((k) => k.value === item.kind)?.label}</Badge>
                  <Badge variant="outline">{SCOPES.find((s) => s.value === item.scope)?.label}</Badge>
                  <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                    {item.score.toFixed(3)}
                  </span>
                </div>
                <p className="mt-1 whitespace-pre-wrap leading-5 text-foreground/90">{item.content}</p>
              </div>
            ))}
          </div>
        ) : (
          <>
            {!ownerUsable && (
              <div className="px-3 py-10 text-center text-[12px] leading-5 text-muted-foreground">
                {scope === 'agent' ? '本会话暂无成员' : '本会话未关联项目'}
                <br />
                {scope === 'project' ? '可在会话设置中关联项目后查看项目级记忆' : '邀请成员后可见成员级记忆'}
              </div>
            )}
            {ownerUsable && list.length === 0 && (
              <div className="px-3 py-10 text-center text-[12px] leading-5 text-muted-foreground">
                <BrainCircuit className="mx-auto mb-2 size-6 opacity-50" />
                {statusFilter === 'candidate' ? (
                  '暂无候选记忆（Run 沉淀默认关闭，可在设置中开启）'
                ) : (
                  <>
                    暂无记忆
                    <br />
                    模型调用 remember 或你手动添加后会出现在这里
                  </>
                )}
              </div>
            )}
            <div className="space-y-1.5">
              {list.map((item) => (
                <div key={item.id} className="group rounded-lg border bg-card px-2.5 py-2 text-[12px] shadow-soft">
                  <div className="flex items-center gap-1.5">
                    <Badge variant={KIND_BADGE[item.kind]}>{KINDS.find((k) => k.value === item.kind)?.label}</Badge>
                    {item.status !== 'active' && <Badge variant="outline">{STATUS_LABEL[item.status]}</Badge>}
                    <span className="text-[10.5px] text-muted-foreground">
                      {item.source === 'user' ? '手动' : item.source ?? ''}
                      {item.hits > 0 ? ` · 命中 ${item.hits}` : ''}
                    </span>
                    <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      {item.status === 'candidate' && (
                        <>
                          <button
                            type="button"
                            title="通过（纳入召回）"
                            onClick={() => void setStatus(item.id, 'active', '已通过，纳入召回')}
                            className="rounded p-1 text-muted-foreground/70 hover:bg-emerald-500/10 hover:text-emerald-600"
                          >
                            <Check className="size-3" />
                          </button>
                          <button
                            type="button"
                            title="忽略（归档）"
                            onClick={() => void setStatus(item.id, 'archived', '已忽略')}
                            className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                          >
                            <Ban className="size-3" />
                          </button>
                        </>
                      )}
                      {item.status === 'active' && activeInScope.length > 1 && (
                        <button
                          type="button"
                          title="标记取代（被同 scope 另一条替代）"
                          onClick={() => setSupersedeFor((prev) => (prev === item.id ? null : item.id))}
                          className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                        >
                          <ArrowLeftRight className="size-3" />
                        </button>
                      )}
                      {item.status === 'active' && (
                        <button
                          type="button"
                          title="归档（不再参与召回）"
                          onClick={() => void setStatus(item.id, 'archived', '已归档')}
                          className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                        >
                          <Archive className="size-3" />
                        </button>
                      )}
                      {item.status === 'active' && item.spaceId && !auditShared && (
                        <button
                          type="button"
                          title="提升为跨域共享（全局记忆，全空间可见；留审计）"
                          onClick={() => void elevateItem(item)}
                          className="rounded p-1 text-muted-foreground/70 hover:bg-primary/10 hover:text-primary"
                        >
                          <Globe className="size-3" />
                        </button>
                      )}
                      <button
                        type="button"
                        title="引用到输入框"
                        onClick={() =>
                          insertToComposer(`[记忆·${KINDS.find((k) => k.value === item.kind)?.label}] ${item.content}\n`)
                        }
                        className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                      >
                        <Quote className="size-3" />
                      </button>
                      {scope === 'session' && (
                        <>
                          <button
                            type="button"
                            title="编辑"
                            onClick={() => {
                              setEditingId(item.id)
                              setEditDraft(item.content)
                            }}
                            className="rounded p-1 text-muted-foreground/70 hover:bg-accent/70 hover:text-foreground"
                          >
                            <Pencil className="size-3" />
                          </button>
                          <button
                            type="button"
                            title="删除"
                            onClick={() => void remove(item.id)}
                            className="rounded p-1 text-muted-foreground/70 hover:bg-rose-500/10 hover:text-rose-600"
                          >
                            <Trash2 className="size-3" />
                          </button>
                        </>
                      )}
                    </span>
                  </div>

                  {supersedeFor === item.id && (
                    <select
                      aria-label="选择替代条目"
                      defaultValue=""
                      onChange={(e) => {
                        if (e.target.value) void supersede(item.id, e.target.value)
                      }}
                      className="mt-1.5 w-full rounded border bg-background px-1.5 py-1 text-[11px] outline-none focus:border-primary/50"
                    >
                      <option value="" disabled>
                        选择替代本条的新记忆…
                      </option>
                      {activeInScope
                        .filter((x) => x.id !== item.id)
                        .map((x) => (
                          <option key={x.id} value={x.id}>
                            [{KINDS.find((k) => k.value === x.kind)?.label}] {x.content.slice(0, 60)}
                          </option>
                        ))}
                    </select>
                  )}

                  {editingId === item.id ? (
                    <div className="mt-1.5 space-y-1.5">
                      <textarea
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        rows={2}
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') setEditingId(null)
                          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submitEdit(item.id)
                        }}
                        className="w-full resize-none rounded-md border bg-background px-2 py-1 text-[12px] leading-5 outline-none focus:border-primary/50"
                      />
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="ghost" size="xs" onClick={() => setEditingId(null)}>
                          取消
                        </Button>
                        <Button
                          size="xs"
                          disabled={!editDraft.trim() || savingEdit}
                          onClick={() => void submitEdit(item.id)}
                        >
                          {savingEdit && <Loader2 className="size-3 animate-spin" />}
                          保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="mt-1 whitespace-pre-wrap leading-5 text-foreground/90">{item.content}</p>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
