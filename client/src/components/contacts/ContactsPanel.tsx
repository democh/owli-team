/**
 * M79-C：联系人面板（左栏「联系人」页签；设计 §14.2）。
 *
 * 结构（自顶向下）：
 * - 请求区（incoming：接受 / 拒绝；outgoing 折叠 + 撤回）；
 * - 搜索（用户名 / 昵称 → 关系态按钮：加好友 / 已申请 / 接受 / 私聊）；
 * - 好友列表（在线点 + 头衔 + 行内动作：私聊 / 移除（确认态含拉黑））。
 *
 * 兼容模式（multiUser=false）由调用方（SessionList）控制不渲染本组件。
 */
import * as React from 'react'
import { Check, Loader2, MessageCircle, Search, UserMinus, UserPlus, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import type { UserSearchHit } from '@multi-agent/shared'
import { apiPost } from '../../lib/api'
import { useFriendsStore } from '../../stores/friends-store'
import { useInboxStore } from '../../stores/inbox-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { HumanAvatar } from '../chat/HumanAvatar'
import { OnlineDot } from '../chat/OnlineDot'
import { CreateGroupDialog } from './CreateGroupDialog'

export interface ContactsPanelProps {
  onSelectSession: (id: string) => void
}

export function ContactsPanel({ onSelectSession }: ContactsPanelProps): React.JSX.Element {
  const friends = useFriendsStore((s) => s.friends)
  const incoming = useFriendsStore((s) => s.incoming)
  const outgoing = useFriendsStore((s) => s.outgoing)
  const loading = useFriendsStore((s) => s.loading)
  const error = useFriendsStore((s) => s.error)
  const [query, setQuery] = React.useState('')
  const [hits, setHits] = React.useState<UserSearchHit[] | null>(null)
  const [searching, setSearching] = React.useState(false)
  const [searchError, setSearchError] = React.useState<string | null>(null)
  const [searchAttempt, setSearchAttempt] = React.useState(0)
  const [outgoingOpen, setOutgoingOpen] = React.useState(false)
  /** 行内确认态（好友行：移出 / 拉黑 二次确认） */
  const [confirming, setConfirming] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  /** M79-D：新建群聊对话框 */
  const [groupOpen, setGroupOpen] = React.useState(false)

  React.useEffect(() => {
    void useFriendsStore.getState().load()
  }, [])

  // M79-I：打开联系人 → 好友申请类通知视为已读（内容已在请求区可视）；
  // 其余类型（邀请 / 提及 / 持球）保留未读，交由通知中心复看（设计 §9.3 的 ack 语义收敛）
  React.useEffect(() => {
    const ids = useInboxStore
      .getState()
      .items.filter((i) => i.type === 'friend-request' && !i.readAt)
      .map((i) => i.id)
    if (ids.length > 0) void useInboxStore.getState().ack(ids)
  }, [])

  // M79-F：命令面板「新建群聊」请求 → 打开对话框
  const groupCreateRequest = useUiStore((s) => s.groupCreateRequest)
  React.useEffect(() => {
    if (!groupCreateRequest) return
    useUiStore.getState().consumeGroupCreate()
    setGroupOpen(true)
  }, [groupCreateRequest])

  // 搜索防抖（250ms；清空恢复列表态）
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
    let alive = true
    const timer = setTimeout(() => {
      void useFriendsStore
        .getState()
        .search(q)
        .then((users) => { if (alive) setHits(users) })
        .catch((err: Error) => { if (alive) setSearchError(err.message) })
        .finally(() => { if (alive) setSearching(false) })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [query, searchAttempt])

  const run = async (action: () => Promise<void>, okText?: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
      if (okText) toast.success(okText)
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  /** 发起私聊（M79-D：POST /chats/direct；命中既有会话直接切换） */
  const openDirect = (userId: string): void => {
    void run(async () => {
      const res = await apiPost<{ session: { id: string } }>('/api/chats/direct', { userId })
      await useSessionStore.getState().loadSessions()
      onSelectSession(res.session.id)
    })
  }

  /** 搜索行主动作（按关系态分流；pending-in 命中请求区 id 直接接受） */
  const searchAction = (hit: UserSearchHit): { label: string; disabled?: boolean; onClick: () => void } => {
    switch (hit.relation) {
      case 'accepted':
        return { label: '私聊', onClick: () => openDirect(hit.userId) }
      case 'pending-out':
        return { label: '已申请', disabled: true, onClick: () => undefined }
      case 'pending-in': {
        const request = incoming.find((r) => r.user.userId === hit.userId)
        return {
          label: '接受',
          disabled: !request,
          onClick: () => request && void run(() => useFriendsStore.getState().accept(request.id), `已添加「${hit.displayName}」`),
        }
      }
      default:
        return {
          label: '加好友',
          onClick: () =>
            void run(
              () => useFriendsStore.getState().request({ userId: hit.userId }),
              `已向「${hit.displayName}」发送好友申请`,
            ),
        }
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 搜索框 */}
      <div className="shrink-0 border-b px-2 py-1.5">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索用户（用户名 / 昵称）"
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
          // ---------- 搜索结果 ----------
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
          ) : hits && hits.length === 0 ? (
            <div className="px-2 py-8 text-center text-[12.5px] text-muted-foreground">
              未找到匹配「{query.trim()}」的用户
            </div>
          ) : (
            <div className="space-y-1">
              {(hits ?? []).map((hit) => {
                const action = searchAction(hit)
                return (
                  <div key={hit.userId} className="flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-primary/20 hover:bg-accent/60">
                    <HumanAvatar avatar={hit.avatar} name={hit.displayName} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium">{hit.displayName}</span>
                        <OnlineDot online={hit.online} />
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        @{hit.username}
                        {hit.headline ? ` · ${hit.headline}` : ''}
                      </div>
                    </div>
                    <Button size="sm" variant={hit.relation === 'accepted' ? 'outline' : 'default'} className="h-6 px-2 text-[11.5px]" disabled={action.disabled || busy} onClick={action.onClick}>
                      {action.label === '加好友' ? <UserPlus className="mr-1 size-3" /> : null}
                      {action.label}
                    </Button>
                  </div>
                )
              })}
            </div>
          )
        ) : (
          // ---------- 请求区 + 好友列表 ----------
          <>
            {incoming.length > 0 && (
              <div className="mb-2 rounded-xl border border-dashed p-2">
                <div className="mb-1.5 flex items-center gap-1.5 px-0.5">
                  <span className="text-[12px] font-medium text-muted-foreground">好友请求</span>
                  <Badge variant="destructive" className="h-4 min-w-4 justify-center px-1 text-[10px]">
                    {incoming.length}
                  </Badge>
                </div>
                <div className="space-y-1.5">
                  {incoming.map((request) => (
                    <div key={request.id} className="flex items-center gap-2 rounded-lg bg-card px-2 py-1.5 shadow-sm">
                      <HumanAvatar avatar={request.user.avatar} name={request.user.displayName} size={28} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] font-medium">{request.user.displayName}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {request.message || `@${request.user.username}`}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        className="h-6 px-2 text-[11.5px]"
                        disabled={busy}
                        onClick={() => void run(() => useFriendsStore.getState().accept(request.id), `已添加「${request.user.displayName}」`)}
                      >
                        <Check className="mr-0.5 size-3" />
                        接受
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[11.5px]"
                        disabled={busy}
                        onClick={() => void run(() => useFriendsStore.getState().reject(request.id))}
                      >
                        拒绝
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {outgoing.length > 0 && (
              <button
                type="button"
                className="mb-2 w-full rounded-lg px-2 py-1 text-left text-[11.5px] text-muted-foreground hover:bg-accent/60"
                onClick={() => setOutgoingOpen((v) => !v)}
              >
                已发出 {outgoing.length} 条请求{outgoingOpen ? '（收起）' : '（展开）'}
              </button>
            )}
            {outgoingOpen && (
              <div className="mb-2 space-y-1">
                {outgoing.map((request) => (
                  <div key={request.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-[11.5px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">@{request.user.username} · 等待对方处理</span>
                    <button
                      type="button"
                      className="rounded p-0.5 hover:text-destructive"
                      title="撤回申请"
                      disabled={busy}
                      onClick={() => void run(() => useFriendsStore.getState().reject(request.id))}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {loading && friends.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                加载中…
              </div>
            ) : error && friends.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-2 py-8 text-center">
                <p className="text-[12.5px] text-muted-foreground">{error}</p>
                <Button size="sm" variant="outline" onClick={() => void useFriendsStore.getState().load()}>
                  重试
                </Button>
              </div>
            ) : friends.length === 0 ? (
              <div className="flex flex-col items-center gap-1.5 rounded-xl border border-dashed px-3 py-6 text-center">
                <UserPlus className="size-5 text-muted-foreground/50" />
                <p className="text-[12px] text-muted-foreground">还没有好友：搜索用户名添加</p>
              </div>
            ) : (
              <div className="space-y-1">
                {friends.map((friend) => (
                  <div
                    key={friend.userId}
                    className="group flex items-center gap-2 rounded-lg border border-transparent px-2 py-1.5 hover:border-primary/20 hover:bg-accent/60"
                  >
                    <HumanAvatar avatar={friend.avatar} name={friend.displayName} size={28} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium">{friend.displayName}</span>
                        <OnlineDot online={friend.online} lastSeenAt={friend.lastSeenAt} />
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {friend.headline ? `${friend.headline} · ` : ''}@{friend.username}
                      </div>
                    </div>
                    {confirming === friend.userId ? (
                      <span className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-6 px-2 text-[11.5px]"
                          disabled={busy}
                          onClick={() => {
                            setConfirming(null)
                            void run(() => useFriendsStore.getState().remove(friend.userId), `已移除「${friend.displayName}」`)
                          }}
                        >
                          确认移除
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-2 text-[11.5px]"
                          disabled={busy}
                          title="拉黑（隐含移除；互不可见与互发请求）"
                          onClick={() => {
                            setConfirming(null)
                            void run(() => useFriendsStore.getState().block(friend.userId), `已拉黑「${friend.displayName}」`)
                          }}
                        >
                          拉黑
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1.5 text-[11.5px]" onClick={() => setConfirming(null)}>
                          取消
                        </Button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 max-md:opacity-100">
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                          title="发起私聊"
                          onClick={() => openDirect(friend.userId)}
                        >
                          <MessageCircle className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-muted-foreground hover:bg-background hover:text-destructive"
                          title="移除好友"
                          onClick={() => setConfirming(friend.userId)}
                        >
                          <UserMinus className="size-3.5" />
                        </button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* M79-D：新建群聊（好友多选；空好友时禁用） */}
      <div className="shrink-0 border-t p-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full border-dashed text-[12px]"
          disabled={friends.length === 0}
          title={friends.length === 0 ? '先添加好友后建群' : '选择好友创建群聊'}
          onClick={() => setGroupOpen(true)}
        >
          <Users className="mr-1 size-3.5" />
          新建群聊
        </Button>
      </div>
      <CreateGroupDialog
        open={groupOpen}
        onOpenChange={setGroupOpen}
        onCreated={(id) => {
          // 列表即时纳入新群聊，再切换视图
          void useSessionStore.getState().loadSessions()
          onSelectSession(id)
        }}
      />
    </div>
  )
}
