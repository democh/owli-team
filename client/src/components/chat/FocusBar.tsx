/**
 * M44（AF-1）：核心交付锚定条——会话产出 ≥1 交付件时，对话区左上角常驻轻量药丸：
 * 「核心交付：<名> · vN · 修改者头像流 · 未闭环意见 N」；悬浮展开面板：
 * 版本线（vN + 作者 + 时间 + 体积）· 未闭环意见（可「标记已满意」本地排除）· 钉选切换（多件时）·
 * 操作（查看 Diff / 提意见草稿）。
 * - 锚点：`pickFocusPath`（钉选 localStorage 优先 → 重要度排序首个）；
 * - 未闭环计数：高置信闭环推导（宁缺毋滥；ADR 0080 精神）；低置信不展示；
 * - 无交付件 / 纯列表模式 / 窄屏 → 隐藏（零干扰）；`data-focus-bar / data-focus-version /
 *   data-focus-open-count` 为测试锚点。
 */
import * as React from 'react'
import { MessageSquarePlus, PackageCheck } from 'lucide-react'
import type { AgentDefinition } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useSceneStore } from '../../stores/scene-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { baseName } from '../../lib/artifacts'
import { useArtifactVersions } from '../../lib/artifact-versions'
import {
  closureOf,
  commentDraft,
  loadPinnedPath,
  loadSatisfied,
  pickFocusPath,
  savePinnedPath,
  saveSatisfied,
} from '../../lib/focus-artifact'
import { humanSize } from '../../lib/time'
import { artifactsOf } from '../scene/derive'
import { useSceneCtx } from '../scene/context'
import { useSceneMessages } from '../scene/use-scene-data'
import { AgentAvatar } from '../agents/AgentAvatar'

/** 版本线呈现上限 */
const MAX_VERSIONS = 6
/** 未闭环意见列呈现上限 */
const MAX_OPEN = 3
/** 钉选候选呈现上限 */
const MAX_CANDIDATES = 4

function shortTime(iso: string): string {
  return iso.length >= 16 ? iso.slice(5, 16).replace('T', ' ') : iso
}

export function FocusBar(): React.JSX.Element | null {
  const ctx = useSceneCtx()
  const sessionId = useSessionStore((s) => s.currentId)
  const listMode = useSceneStore((s) => s.listMode)
  const messages = useSceneMessages()
  const agents = useAgentStore((s) => s.agents)
  const insert = useUiStore((s) => s.insertToComposer)
  const requestArtifact = useUiStore((s) => s.requestArtifact)
  const sid = sessionId ?? ''

  const paths = React.useMemo(() => artifactsOf(messages), [messages])
  const [pinned, setPinned] = React.useState<string | undefined>(() => (sid ? loadPinnedPath(sid) : undefined))
  React.useEffect(() => {
    setPinned(sid ? loadPinnedPath(sid) : undefined)
  }, [sid])
  const [satisfied, setSatisfied] = React.useState<Set<string>>(() => (sid ? loadSatisfied(sid) : new Set()))
  React.useEffect(() => {
    setSatisfied(sid ? loadSatisfied(sid) : new Set())
  }, [sid])
  const [open, setOpen] = React.useState(false)

  const anchor = pickFocusPath(paths, pinned)
  const versions = useArtifactVersions(anchor)
  const closure = React.useMemo(() => closureOf(messages, paths, satisfied), [messages, paths, satisfied])

  if (!sid || listMode || ctx?.narrow || !anchor) return null

  const latest = versions && versions.length > 0 ? versions[0] : undefined
  const authors: AgentDefinition[] = []
  const seen = new Set<string>()
  for (const v of versions ?? []) {
    if (!v.authorAgentId || seen.has(v.authorAgentId)) continue
    seen.add(v.authorAgentId)
    const agent = agents.find((a) => a.id === v.authorAgentId)
    if (agent) authors.push(agent)
    if (authors.length >= 4) break
  }
  const latestAuthor = latest?.authorAgentId ? agents.find((a) => a.id === latest.authorAgentId) : undefined

  const pin = (p?: string): void => {
    const next = p === pinned ? undefined : p
    setPinned(next)
    savePinnedPath(sid, next)
  }
  const markSatisfied = (id: string): void => {
    const next = new Set(satisfied)
    next.add(id)
    setSatisfied(next)
    saveSatisfied(sid, next)
  }
  const comment = (): void => {
    insert(latestAuthor ? commentDraft(latestAuthor.name, anchor) : `对《${baseName(anchor)}》的意见：`)
    setOpen(false)
  }

  const openCount = closure.openOpinions.length

  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-30"
      data-focus-bar={anchor}
      data-focus-open-count={openCount}
    >
      <div className="absolute left-3 top-1">
        <div
          data-focus-hover=""
          className="pointer-events-auto"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
        >
          <button
            type="button"
            title={`核心交付：${anchor}（点击打开交付件；悬浮展开版本线与未闭环意见）`}
            onClick={() => requestArtifact(anchor)}
            className="flex max-w-[54vw] items-center gap-1.5 rounded-full border border-border/70 bg-card/95 py-0.5 pl-2 pr-2.5 text-[11px] shadow-sm backdrop-blur transition-colors hover:border-primary/40 hover:text-primary"
          >
            <PackageCheck className="size-3.5 shrink-0 text-primary" />
            <span className="shrink-0 font-medium">核心交付</span>
            <span className="min-w-0 truncate text-muted-foreground">{baseName(anchor)}</span>
            {latest ? (
              <span
                data-focus-version={latest.version}
                className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums leading-[1.7] text-muted-foreground"
              >
                v{latest.version}
              </span>
            ) : null}
            {authors.length > 0 ? (
              <span className="flex shrink-0 -space-x-1.5">
                {authors.slice(0, 3).map((a) => (
                  <AgentAvatar key={a.id} agent={a} size={16} animated={false} className="ring-1 ring-card" />
                ))}
              </span>
            ) : null}
            {openCount > 0 ? (
              <span
                data-focus-open=""
                title={`未闭环意见 ${openCount} 条`}
                className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium tabular-nums leading-[1.7] text-amber-600"
              >
                未闭环 {openCount}
              </span>
            ) : null}
          </button>

          {open ? (
            <div
              data-focus-panel=""
              className="absolute left-0 top-full z-40 mt-1 w-80 animate-fade-in rounded-lg border bg-popover p-2 text-[11.5px] shadow-lg shadow-slate-900/10"
            >
              {/* ① 版本线 */}
              <div className="mb-1 px-0.5 font-medium text-muted-foreground">版本线</div>
              {versions && versions.length > 0 ? (
                <div className="space-y-0.5">
                  {versions.slice(0, MAX_VERSIONS).map((v) => {
                    const vAuthor = v.authorAgentId ? agents.find((a) => a.id === v.authorAgentId) : undefined
                    return (
                      <div key={v.id} className="flex items-center gap-1.5 rounded px-0.5 py-0.5">
                        <span className="shrink-0 rounded bg-muted px-1 text-[10px] tabular-nums text-muted-foreground">
                          v{v.version}
                        </span>
                        {vAuthor ? (
                          <AgentAvatar agent={vAuthor} size={14} animated={false} className="shrink-0 ring-1 ring-border" />
                        ) : null}
                        <span className="min-w-0 truncate text-muted-foreground">
                          {vAuthor?.name ?? '—'} · {shortTime(v.createdAt)} · {humanSize(v.size)}
                        </span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <div className="px-0.5 text-muted-foreground/70">版本信息加载中…</div>
              )}

              {/* ② 未闭环意见（可标记已满意） */}
              {closure.openOpinions.length > 0 ? (
                <div className="mt-2 border-t border-border pt-1.5">
                  <div className="mb-1 px-0.5 font-medium text-muted-foreground">未闭环意见 · {openCount}</div>
                  <div className="space-y-0.5">
                    {closure.openOpinions.slice(0, MAX_OPEN).map((o) => (
                      <div key={o.messageId} className="flex items-center gap-1.5 rounded px-0.5 py-0.5">
                        <span className="min-w-0 flex-1 truncate" title={o.excerpt}>
                          {o.excerpt}
                        </span>
                        <button
                          type="button"
                          data-focus-satisfy={o.messageId}
                          title="标记已满意（本地排除出未闭环计数）"
                          onClick={() => markSatisfied(o.messageId)}
                          className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground transition-colors hover:border-emerald-500/40 hover:text-emerald-600"
                        >
                          标记已满意
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ③ 钉选切换（多件时） */}
              {paths.length > 1 ? (
                <div className="mt-2 border-t border-border pt-1.5">
                  <div className="mb-1 px-0.5 font-medium text-muted-foreground">候选交付（点击钉选 / 取消钉选）</div>
                  <div className="space-y-0.5">
                    {paths.slice(0, MAX_CANDIDATES).map((p) => (
                      <button
                        key={p}
                        type="button"
                        data-focus-pick={p}
                        title={p}
                        onClick={() => pin(p)}
                        className={
                          p === anchor
                            ? 'flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-primary'
                            : 'flex w-full items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-muted-foreground transition-colors hover:text-foreground'
                        }
                      >
                        <span className="min-w-0 flex-1 truncate">{baseName(p)}</span>
                        {p === anchor ? <span className="shrink-0 text-[10px]">已钉选</span> : null}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* ④ 操作 */}
              <div className="mt-2 flex items-center gap-1.5 border-t border-border pt-1.5">
                <button
                  type="button"
                  data-focus-action="diff"
                  onClick={() => requestArtifact(anchor)}
                  className="rounded border px-1.5 py-0.5 transition-colors hover:border-primary/40 hover:text-primary"
                >
                  查看 Diff
                </button>
                <button
                  type="button"
                  data-focus-action="comment"
                  onClick={comment}
                  className="flex items-center gap-1 rounded border px-1.5 py-0.5 transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <MessageSquarePlus className="size-3" />
                  提意见
                </button>
                {pinned ? (
                  <button
                    type="button"
                    data-focus-action="unpin"
                    onClick={() => pin(pinned)}
                    className="ml-auto text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    取消钉选
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
