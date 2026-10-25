/**
 * 会话列表（左栏）：CRUD + 未读角标 + 最近消息预览 + 全文搜索（M9，FTS5）。
 * 搜索：GET /api/search?q=（messages_fts 跨会话检索），命中后跳转会话并定位消息。
 * M50：新建会话改用组队台（CreateSessionDialog）；pendingCreate 通道在此消费后经 initialSource 传入。
 * M31 修订：其他会话的 agent 画布写入 → 行内小点（切到该会话即清零）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  EyeOff,
  Loader2,
  Mail,
  MailOpen,
  MessageCircle,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { apiGet } from '../../lib/api'
import { labelOfMemberKey } from '../../lib/members'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore, filterSessions } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { timeAgo } from '../../lib/time'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { useAuthStore } from '../../stores/auth-store'
import { useFriendsStore } from '../../stores/friends-store'
import { ContactsPanel } from '../contacts/ContactsPanel'
// M57 P2：共享角色（列表徽章 / 操作 gating）依赖 SessionSummary.role（服务端下发）
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { CreateSessionDialog, type CreateSource } from './CreateSessionDialog'

type DialogState =
  | { mode: 'rename'; id: string; title: string }
  | { mode: 'delete'; id: string; title: string }
  | null

interface SearchHit {
  sessionId: string
  messageId: string
  content: string
  sessionTitle: string
  /** IM：命中定位所需（旧服务端可能缺省） */
  seq?: number
  createdAt?: string
  senderName?: string
}

/** 命中片段：以关键词为中心截取（去多余空白） */
function snippetOf(content: string, q: string): string {
  const flat = content.replace(/\s+/g, ' ')
  const idx = flat.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return flat.slice(0, 90)
  const start = Math.max(0, idx - 24)
  const end = Math.min(flat.length, idx + q.length + 66)
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`
}

export interface SessionListProps {
  onSelect: (id: string) => void | Promise<void | boolean>
}

export function SessionList({ onSelect }: SessionListProps): React.JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const loading = useSessionStore((s) => s.loadingSessions)
  const agents = useAgentStore((s) => s.agents)
  const unread = useWsStore((s) => s.unread)
  // M57 P3：本人 id（列表预览署名判定「你」/ 昵称）
  const myUserId = useAuthStore((s) => s.user?.id)
  // M79-C：左栏页签（会话 | 联系人；仅多用户模式渲染）与待处理请求角标
  const multiUser = useAuthStore((s) => s.status.multiUser)
  const leftTab = useUiStore((s) => s.leftTab)
  const pendingCount = useFriendsStore((s) => s.pendingCount)
  // M79-F：会话筛选 chip（团队 / 聊天；默认选中第一个「团队」）
  const sessionFilter = useUiStore((s) => s.sessionFilter)
  // IM：归档是独立视图（不混入团队 / 聊天筛选）
  const [showArchived, setShowArchived] = React.useState(false)
  const archivedCount = sessions.filter((s) => s.prefs?.archived).length
  const visibleSessions = React.useMemo(
    // 归档视图不受团队 / 聊天筛选影响，避免“归档里有但看不到”
    () => filterSessions(sessions, showArchived ? 'all' : sessionFilter, { archived: showArchived }),
    [sessions, sessionFilter, showArchived],
  )
  // M31 修订：其他会话的画布写入标记（agent 写入小点；切到该会话即清零）
  // 临时隐藏画布：小点已注释，数据源同步不再订阅
  // const otherCanvasWrites = useUiStore((s) => s.otherCanvasWrites)
  React.useEffect(() => {
    if (currentId) useUiStore.getState().clearOtherCanvasWrite(currentId)
  }, [currentId])

  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [titleInput, setTitleInput] = React.useState('')
  // M50：组队台对话框（来源预选经 initialSource 传入；提交逻辑见 CreateSessionDialog）
  const [createOpen, setCreateOpen] = React.useState(false)
  const [createSource, setCreateSource] = React.useState<CreateSource>()
  const [busy, setBusy] = React.useState(false)
  // M9：全文搜索
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<SearchHit[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [searchAttempt, setSearchAttempt] = React.useState(0)
  /** IM：搜索筛选（我发的 / 含附件 / 时间范围） */
  const [mineOnly, setMineOnly] = React.useState(false)
  const [hasAttachment, setHasAttachment] = React.useState(false)
  const [range, setRange] = React.useState<'all' | 'today' | '7d' | '30d'>('all')

  // 输入防抖（250ms）→ FTS 检索；清空恢复会话列表
  React.useEffect(() => {
    const q = query.trim()
    setSearchError(null)
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    setHits(null)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ q, limit: '30' })
      if (mineOnly) params.set('mine', '1')
      if (hasAttachment) params.set('hasAttachment', '1')
      if (range !== 'all') {
        const from = new Date()
        if (range === 'today') from.setHours(0, 0, 0, 0)
        else from.setDate(from.getDate() - (range === '7d' ? 7 : 30))
        params.set('from', from.toISOString())
      }
      void apiGet<{ results: SearchHit[] }>(`/api/search?${params.toString()}`, { signal: controller.signal })
        .then((res) => { if (!controller.signal.aborted) setHits(res.results) })
        .catch((err: Error) => { if (!controller.signal.aborted) setSearchError(err.message) })
        .finally(() => { if (!controller.signal.aborted) setSearching(false) })
    }, 250)
    return () => { clearTimeout(timer); controller.abort() }
  }, [query, searchAttempt, mineOnly, hasAttachment, range])

  /** 命中跳转：切到目标会话（异步加载消息）→ 延迟触发消息定位 */
  const jumpTo = (hit: SearchHit): void => {
    setQuery('')
    void (async () => {
      const pending = onSelect(hit.sessionId)
      const version = useSessionStore.getState().selectionVersion
      const selected = await pending
      const state = useSessionStore.getState()
      if (selected !== false && state.currentId === hit.sessionId && state.selectionVersion === version && !state.messageLoadError) {
        useUiStore.getState().focusMessage(hit.messageId, hit.seq)
      }
    })().catch((err: Error) => toast.error(err.message))
  }

  const openCreate = (): void => {
    setCreateSource(undefined)
    setCreateOpen(true)
  }

  const openRename = (id: string, title: string): void => {
    setTitleInput(title)
    setDialog({ mode: 'rename', id, title })
  }

  // M21/M50：命令面板入口——打开组队台并按来源预填编制（无效 id 由组队台回退无来源）
  const pendingCreate = useUiStore((s) => s.pendingCreate)
  React.useEffect(() => {
    if (!pendingCreate) return
    useUiStore.getState().consumeCreate()
    setCreateSource(pendingCreate.kind && pendingCreate.id ? { kind: pendingCreate.kind, id: pendingCreate.id, draft: pendingCreate.draft } : undefined)
    setCreateOpen(true)
  }, [pendingCreate])

  const submitRename = async (): Promise<void> => {
    if (dialog?.mode !== 'rename') return
    const title = titleInput.trim()
    if (!title) {
      toast.error('标题不能为空')
      return
    }
    setBusy(true)
    try {
      await useSessionStore.getState().renameSession(dialog.id, title)
      setDialog(null)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const submitDelete = async (): Promise<void> => {
    if (dialog?.mode !== 'delete') return
    setBusy(true)
    try {
      await useSessionStore.getState().removeSession(dialog.id)
      setDialog(null)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* M79-C：左栏页签（会话 | 联系人；仅多用户模式渲染）。
          样式（2026-09-23 视觉收口）：行高 h-11 与主区页签行等高（顶带分隔线跨栏贯通）；页签改用
          主区同款分段控件语言（灰轨道 + 白色激活块），与下方浅蓝筛选 chip 区分层级（页签 = 视图切换 /
          chip = 列表过滤）；「新建会话」＋ 并入页签行右端（仅会话页签），不再单占一行标题。 */}
      {multiUser && (
        <div className="flex h-11 shrink-0 items-center gap-1 border-b px-2">
          <div className="inline-flex h-8 items-center gap-0.5 rounded-md bg-muted/80 p-0.5 shadow-inner">
            {(['sessions', 'contacts'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={cn(
                  'inline-flex h-full items-center gap-1 whitespace-nowrap rounded-[5px] px-2.5 text-[12.5px] font-medium transition-all',
                  leftTab === tab ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => useUiStore.getState().setLeftTab(tab)}
              >
                {tab === 'sessions' ? '会话' : '联系人'}
                {tab === 'contacts' && pendingCount > 0 && (
                  <Badge
                    variant="destructive"
                    className="h-4 min-w-4 justify-center px-1 text-[10px]"
                    aria-label={`${pendingCount} 条好友请求`}
                  >
                    {pendingCount > 99 ? '99+' : pendingCount}
                  </Badge>
                )}
              </button>
            ))}
          </div>
          {leftTab === 'sessions' && (
            <Button variant="ghost" size="icon-sm" className="ml-auto" title="新建会话" onClick={openCreate}>
              <Plus className="size-4" />
            </Button>
          )}
        </div>
      )}
      {multiUser && leftTab === 'contacts' ? (
        <ContactsPanel onSelectSession={onSelect} />
      ) : (
        <>
      {/* 兼容模式（单用户，无页签）：保留「会话 N + 新建」头部 */}
      {!multiUser && (
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[13px] font-semibold">
          会话
          {sessions.length > 0 && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{visibleSessions.length}</span>}
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" title="新建会话" onClick={openCreate}>
            <Plus className="size-4" />
          </Button>
        </div>
      </div>
      )}

      {/* M79-F 修订：筛选 chip（团队 / 聊天；仅多用户模式）——不设「全部」项：默认选中第一个，点选过滤 / 再点取消回全部。
          与搜索同属一个无内部分隔线的工具区块；过滤后计数右对齐于本行（口径 = visibleSessions）。 */}
      {multiUser && (
        <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-1">
          {(
            [
              ['team', '团队'],
              ['chat', '聊天'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] transition-colors',
                sessionFilter === key
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => useUiStore.getState().setSessionFilter(sessionFilter === key ? 'all' : key)}
            >
              {label}
            </button>
          ))}
          {sessions.length > 0 && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">{visibleSessions.length} 个会话</span>
          )}
          <button
            type="button"
            className={cn(
              'flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors',
              showArchived ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:text-foreground',
            )}
            title={showArchived ? '返回未归档会话' : '查看归档会话'}
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
            {showArchived ? '返回' : `归档 ${archivedCount}`}
          </button>
        </div>
      )}

      <div className="shrink-0 border-b px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索全部会话消息…"
            className="h-7 pl-7 pr-7 text-[12px]"
          />
          {query && (
            <button
              type="button"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
              title="清空搜索"
              onClick={() => setQuery('')}
            >
              <X className="size-3" />
            </button>
          )}
        </div>
        {query.trim() && (
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[10.5px]">
            {myUserId && (
              <button
                type="button"
                aria-pressed={mineOnly}
                className={cn(
                  'rounded-full border px-1.5 py-0.5 transition-colors',
                  mineOnly
                    ? 'border-primary/40 bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:text-foreground',
                )}
                onClick={() => setMineOnly((v) => !v)}
              >
                我发的
              </button>
            )}
            <button
              type="button"
              aria-pressed={hasAttachment}
              className={cn(
                'rounded-full border px-1.5 py-0.5 transition-colors',
                hasAttachment
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              onClick={() => setHasAttachment((v) => !v)}
            >
              含附件
            </button>
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as typeof range)}
              className="rounded-full border bg-background px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
              title="时间范围"
            >
              <option value="all">全部时间</option>
              <option value="today">今天</option>
              <option value="7d">近 7 天</option>
              <option value="30d">近 30 天</option>
            </select>
            {(mineOnly || hasAttachment || range !== 'all') && (
              <button
                type="button"
                className="ml-auto text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => {
                  setMineOnly(false)
                  setHasAttachment(false)
                  setRange('all')
                }}
              >
                重置
              </button>
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query.trim() ? (
          searchError ? (
            <div role="alert" className="px-2 py-6 text-center text-[12.5px] text-muted-foreground">
              <p>{searchError}</p>
              <Button size="sm" variant="outline" onClick={() => setSearchAttempt((n) => n + 1)}>重试搜索</Button>
            </div>
          ) : searching && hits === null ? (
            <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              搜索中…
            </div>
          ) : (
            <div className="space-y-1">
              {hits?.length === 0 && (
                <div className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
                  没有匹配「{query.trim()}」的消息
                </div>
              )}
              {hits?.map((hit) => (
                <button
                  key={hit.messageId}
                  type="button"
                  onClick={() => jumpTo(hit)}
                  className="w-full rounded-lg border border-transparent px-2.5 py-2 text-left transition-all hover:border-primary/25 hover:bg-accent/70"
                >
                  <div className="truncate text-[12px] font-medium text-foreground/85">
                    {hit.sessionTitle || '未命名会话'}
                  </div>
                  {(hit.senderName || hit.createdAt) && (
                    <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                      {hit.senderName && <span className="max-w-24 truncate">{hit.senderName}</span>}
                      {hit.senderName && hit.createdAt && <span>·</span>}
                      {hit.createdAt && <span>{timeAgo(hit.createdAt)}</span>}
                    </div>
                  )}
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">
                    {snippetOf(hit.content, query.trim())}
                  </p>
                </button>
              ))}
            </div>
          )
        ) : (
          <>
        {loading && sessions.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            加载中…
          </div>
        )}
        {!loading && sessions.length === 0 && (
          <div className="px-2 py-10 text-center text-[12.5px] text-muted-foreground">
            <MessageSquarePlus className="float-soft mx-auto mb-2 size-6 opacity-60" />
            还没有会话
            <div className="mt-1">
              <Button variant="outline" size="sm" className="mt-2" onClick={openCreate}>
                <Plus className="size-3.5" />
                新建会话
              </Button>
            </div>
          </div>
        )}
        {/* M79-F：筛选后无结果（列表非空） */}
        {!loading && sessions.length > 0 && visibleSessions.length === 0 && (
          <div className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
            {showArchived
              ? '还没有归档会话'
              : archivedCount > 0 && archivedCount === sessions.length
                ? '会话已全部归档（点上方「归档」查看）'
                : `没有匹配「${sessionFilter === 'chat' ? '聊天' : '团队'}」的会话`}
          </div>
        )}

        <div className="space-y-1">
          {visibleSessions.map((s) => {
            const isActive = s.id === currentId
            const count = unread[s.id] ?? 0
            const last = s.lastMessage
            // M57 P2：共享角色（兼容模式缺省 = owner）；viewer 隐藏重命名，非 owner 隐藏删除
            const canWrite = !s.role || s.role !== 'viewer'
            const isOwner = !s.role || s.role === 'owner'
            // M57 P3：预览署名——他人人类消息显示昵称（无昵称回退「成员」），自己 / 兼容模式仍为「你」
            const authorName = last
              ? last.role === 'user'
                ? last.userId && last.userId !== myUserId
                  ? (last.userName ?? '成员')
                  : '你'
                : /* M77：署名按成员实例（分身 = `名字·灵魂名`；存量消息缺省 = 角色名） */
                  labelOfMemberKey(agents, s, last.memberKey ?? last.agentId ?? '')
              : ''
            return (
              <div
                key={s.id}
                className={cn(
                  'group relative cursor-pointer overflow-hidden rounded-lg border px-2.5 py-2 transition-all',
                  isActive
                    ? 'border-primary/25 bg-primary/[0.06] shadow-sm'
                    : 'border-transparent hover:bg-accent/70',
                )}
                onClick={() => onSelect(s.id)}
              >
                {isActive && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-primary" aria-hidden />}
                <div className="flex items-center gap-1.5">
                  {s.kind === 'direct' ? (
                    <MessageCircle className="size-3.5 shrink-0 text-muted-foreground" aria-label="私聊" />
                  ) : s.kind === 'group' ? (
                    <Users className="size-3.5 shrink-0 text-muted-foreground" aria-label="群聊" />
                  ) : null}
                  {s.prefs?.pinned && <Pin className="size-3 shrink-0 text-primary/70" aria-label="已置顶" />}
                  <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', isActive && 'text-primary')}>
                    {s.title}
                  </span>
                  {s.prefs?.muted && <BellOff className="size-3 shrink-0 text-muted-foreground/70" aria-label="免打扰" />}
                  {s.role && s.role !== 'owner' && (
                    <Badge
                      variant="outline"
                      className="h-4 shrink-0 border-primary/30 px-1 text-[10px] text-primary"
                      title={s.role === 'editor' ? '与我共享：可协作（读写）' : '与我共享：只读'}
                    >
                      {s.role === 'editor' ? '协作' : '只读'}
                    </Badge>
                  )}
                  {/* 临时隐藏画布：画布写入小点已注释（恢复时取消本段注释）
                  {otherCanvasWrites[s.id] > 0 && (
                    <span
                      className="size-1.5 shrink-0 rounded-full bg-primary"
                      title="Agent 刚更新了该会话的画布"
                      aria-label="画布有新写入"
                    />
                  )}
                  */}
                  {count > 0 && (
                    <span
                      className={cn(
                        'badge-pop inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-bold leading-none tabular-nums shadow-sm',
                        s.prefs?.muted ? 'bg-muted-foreground/45 text-background' : 'bg-destructive text-destructive-foreground',
                      )}
                      title={`${count} 条未读${s.prefs?.muted ? '（免打扰）' : ''}`}
                      aria-label={`${count} 条未读`}
                    >
                      {count > 99 ? '99+' : count}
                    </span>
                  )}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    {multiUser && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      title={s.prefs?.pinned ? '取消置顶' : '置顶会话'}
                      aria-label={s.prefs?.pinned ? '取消置顶' : '置顶会话'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void useSessionStore.getState().setSessionPrefs(s.id, { pinned: !s.prefs?.pinned }).catch((err: Error) => toast.error(err.message))
                      }}
                    >
                      {s.prefs?.pinned ? <PinOff className="size-3" /> : <Pin className="size-3" />}
                    </button>
                    )}
                    {multiUser && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      title={s.prefs?.markedUnread ? '取消未读标记' : '标记未读（提醒自己回看）'}
                      aria-label={s.prefs?.markedUnread ? '取消未读标记' : '标记未读'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void useSessionStore
                          .getState()
                          .setSessionPrefs(s.id, { markedUnread: !s.prefs?.markedUnread })
                          .then(() => useSessionStore.getState().loadSessions())
                          .catch((err: Error) => toast.error(err.message))
                      }}
                    >
                      {s.prefs?.markedUnread ? <MailOpen className="size-3" /> : <Mail className="size-3" />}
                    </button>
                    )}
                    {multiUser && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      title={s.prefs?.archived ? '取消归档' : '归档会话'}
                      aria-label={s.prefs?.archived ? '取消归档' : '归档会话'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void useSessionStore
                          .getState()
                          .setSessionPrefs(s.id, { archived: !s.prefs?.archived })
                          .then(() => useSessionStore.getState().loadSessions())
                          .catch((err: Error) => toast.error(err.message))
                      }}
                    >
                      {s.prefs?.archived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
                    </button>
                    )}
                    {multiUser && (
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                      title={s.prefs?.muted ? '取消免打扰' : '免打扰（不弹消息提示）'}
                      aria-label={s.prefs?.muted ? '取消免打扰' : '免打扰'}
                      onClick={(e) => {
                        e.stopPropagation()
                        void useSessionStore.getState().setSessionPrefs(s.id, { muted: !s.prefs?.muted }).catch((err: Error) => toast.error(err.message))
                      }}
                    >
                      {s.prefs?.muted ? <Bell className="size-3" /> : <BellOff className="size-3" />}
                    </button>
                    )}
                    {s.kind === 'direct' || s.kind === 'group' ? (
                      // M79-D：chat 形态仅提供「隐藏」（DM「删除」语义；新消息自动复现）；
                      // M79-AA 群管理补全：群聊重命名入口（仅群主——服务端同规收紧，editor 403）
                      <>
                        {s.kind === 'group' && isOwner && (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                            title="重命名群聊"
                            onClick={(e) => {
                              e.stopPropagation()
                              openRename(s.id, s.title)
                            }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                          title="隐藏会话（新消息自动复现）"
                          onClick={(e) => {
                            e.stopPropagation()
                            void useSessionStore.getState().hideSession(s.id)
                          }}
                        >
                          <EyeOff className="size-3" />
                        </button>
                      </>
                    ) : (
                      <>
                        {canWrite && (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                            title="重命名"
                            onClick={(e) => {
                              e.stopPropagation()
                              openRename(s.id, s.title)
                            }}
                          >
                            <Pencil className="size-3" />
                          </button>
                        )}
                        {isOwner && (
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                            title="删除（含工作区）"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDialog({ mode: 'delete', id: s.id, title: s.title })
                            }}
                          >
                            <Trash2 className="size-3" />
                          </button>
                        )}
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="shrink-0">{timeAgo(s.updatedAt)}</span>
                  {last && (
                    <span className="min-w-0 truncate">
                      {authorName}：{last.content.slice(0, 40)}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
            </div>
          </>
        )}
      </div>
        </>
      )}

      {/* 新建（M50 组队台：来源 → 角色池 → 编制，一次成局） */}
      <CreateSessionDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialSource={createSource}
        onCreated={onSelect}
      />

      {/* 重命名 */}
      <Dialog open={dialog?.mode === 'rename'} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>重命名会话</DialogTitle>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <Input
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              placeholder="新标题"
              onKeyDown={(e) => e.key === 'Enter' && void submitRename()}
            />
            <Button className="w-full" disabled={busy} onClick={() => void submitRename()}>
              保存
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 删除确认 */}
      <Dialog open={dialog?.mode === 'delete'} onOpenChange={(v) => !v && setDialog(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>删除会话</DialogTitle>
            <DialogDescription>
              将删除「{dialog?.mode === 'delete' ? dialog.title : ''}」及其工作区全部交付件，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDialog(null)}>
              取消
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void submitDelete()}>
              确认删除
            </Button>
          </div>
        </DialogContent>
      </Dialog>

    </div>
  )
}
