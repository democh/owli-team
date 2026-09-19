/**
 * 会话列表（左栏）：CRUD + 未读角标 + 最近消息预览 + 全文搜索（M9，FTS5）。
 * 搜索：GET /api/search?q=（messages_fts 跨会话检索），命中后跳转会话并定位消息。
 * M50：新建会话改用组队台（CreateSessionDialog）；pendingCreate 通道在此消费后经 initialSource 传入。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { Loader2, MessageSquarePlus, Pencil, Plus, Search, Trash2, X } from 'lucide-react'
import { apiGet } from '../../lib/api'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { timeAgo } from '../../lib/time'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
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
  onSelect: (id: string) => void
}

export function SessionList({ onSelect }: SessionListProps): React.JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const currentId = useSessionStore((s) => s.currentId)
  const loading = useSessionStore((s) => s.loadingSessions)
  const agents = useAgentStore((s) => s.agents)
  const unread = useWsStore((s) => s.unread)

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

  // 输入防抖（250ms）→ FTS 检索；清空恢复会话列表
  React.useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      void apiGet<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}&limit=30`)
        .then((res) => setHits(res.results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [query])

  /** 命中跳转：切到目标会话（异步加载消息）→ 延迟触发消息定位 */
  const jumpTo = (hit: SearchHit): void => {
    setQuery('')
    onSelect(hit.sessionId)
    window.setTimeout(() => useUiStore.getState().focusMessage(hit.messageId), 220)
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
    setCreateSource({ kind: pendingCreate.kind, id: pendingCreate.id })
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
      <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
        <span className="text-[13px] font-semibold">
          会话
          {sessions.length > 0 && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{sessions.length}</span>}
        </span>
        <div className="flex items-center gap-0.5">
          <Button variant="ghost" size="icon-sm" title="新建会话" onClick={openCreate}>
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

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
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {query.trim() ? (
          searching && hits === null ? (
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

        <div className="space-y-1">
          {sessions.map((s) => {
            const isActive = s.id === currentId
            const count = unread[s.id] ?? 0
            const last = s.lastMessage
            const authorName = last
              ? last.role === 'user'
                ? '你'
                : agents.find((a) => a.id === last.agentId)?.name ?? last.agentId
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
                  <span className={cn('min-w-0 flex-1 truncate text-[13px] font-medium', isActive && 'text-primary')}>
                    {s.title}
                  </span>
                  {count > 0 && (
                    <Badge variant="destructive" className="badge-pop h-4 min-w-4 justify-center px-1 text-[10px]">
                      {count > 99 ? '99+' : count}
                    </Badge>
                  )}
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
