/**
 * 实况 · 交付件面（M49 / ADR 0100）：右栏窄栏的「跟最新」流式预览。
 *
 * - 跟随语义：默认跟最新（软跟随路径 > 最近更新 > 列表最新）；点列表项 = 钉住，再点取消回跟随；
 * - 垂直三段：预览区（flex-1 内部滚动）→ 操作行（引用 / 复制 / 下载 / 展开）→ 最近文件列表；
 * - 底栏：实时跟最新 / 已钉住查看；
 * - 数据：/api/sessions/:id/artifacts + artifactVersion 刷新；消息 chip / 附件的
 *   requestedArtifactPath 由 live-panel-store 订阅响应为钉住（openArtifact），本组件消费钉住态。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { ChevronRight, Copy, Download, Maximize2, PackageOpen, Pin, Quote } from 'lucide-react'
import type { Artifact } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { artifactContentUrl, baseName, isTextKind } from '../../lib/artifacts'
import { humanSize } from '../../lib/time'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useLivePanelStore } from '../../stores/live-panel-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { AgentAvatar } from '../agents/AgentAvatar'
import { ArtifactPreviewBody, KIND_ICON, copyArtifact, useArtifactContent } from './ArtifactPreview'

/** 最近文件列表可见行数（超出滚动） */
const RECENT_LIMIT = 5

export function ArtifactFeedView(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const artifactVersion = useSessionStore((s) => s.artifactVersion)
  const lastPath = useUiStore((s) => s.lastArtifactPath)
  const pinnedPath = useLivePanelStore((s) => s.pinnedArtifactPath)
  const followPath = useLivePanelStore((s) => s.followArtifactPath)
  const pinArtifact = useLivePanelStore((s) => s.pinArtifact)
  const agents = useAgentStore((s) => s.agents)

  const [list, setList] = React.useState<Artifact[]>([])
  const [listLoading, setListLoading] = React.useState(false)

  // 列表加载（artifactVersion 双通道刷新；会话切换重取）
  React.useEffect(() => {
    if (!currentId) {
      setList([])
      return
    }
    let alive = true
    setListLoading(true)
    void apiGet<{ artifacts: Artifact[] }>(`/api/sessions/${currentId}/artifacts`)
      .then((res) => {
        if (alive) setList(res.artifacts)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setListLoading(false)
      })
    return () => {
      alive = false
    }
  }, [currentId, artifactVersion])

  // 选中决策：钉住 > 软跟随 > 最近更新 > 列表最新（均为列表内路径，失效自动落回）
  const artifact = React.useMemo(() => {
    if (pinnedPath) return list.find((a) => a.path === pinnedPath)
    const follow = followPath && list.find((a) => a.path === followPath)
    if (follow) return follow
    const last = lastPath && list.find((a) => a.path === lastPath)
    return last || list[0]
  }, [list, pinnedPath, followPath, lastPath])

  const content = useArtifactContent(currentId, artifact, artifactVersion)
  const author = artifact?.authorAgentId ? agents.find((a) => a.id === artifact.authorAgentId) : undefined

  const copyAction = async (): Promise<void> => {
    if (!currentId || !artifact) return
    try {
      if (isTextKind(artifact.kind)) {
        await copyArtifact(currentId, artifact, content)
        toast('内容已复制到剪贴板')
      } else {
        await navigator.clipboard.writeText(artifact.path)
        toast('路径已复制到剪贴板')
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** 展开主区交付件工作台；requestArtifact 供 ArtifactsView 选中同一文件 */
  const expand = (): void => {
    if (!artifact) return
    useUiStore.getState().requestArtifact(artifact.path)
    useUiStore.getState().expandWorkspace('artifacts')
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {artifact && currentId ? (
        <>
          {/* 文件头 */}
          <div className="flex shrink-0 items-center gap-1.5 border-b px-2 py-1">
            {KIND_ICON[artifact.kind]}
            <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium" title={artifact.path}>
              {baseName(artifact.path)}
            </span>
            <span className="shrink-0 text-[9.5px] text-muted-foreground">{humanSize(artifact.size)}</span>
            {author && <AgentAvatar agent={author} size={14} animated={false} className="shrink-0" />}
          </div>

          {/* ① 预览区（flex-1，内部滚动） */}
          <div className="min-h-0 flex-1">
            <ArtifactPreviewBody sessionId={currentId} artifact={artifact} version={artifactVersion} content={content} />
          </div>

          {/* ② 操作行（icon + tooltip） */}
          <div className="flex shrink-0 items-center gap-0.5 border-t px-1.5 py-1">
            <Button
              size="icon-sm"
              variant="ghost"
              title="引用到输入框"
              onClick={() => {
                useUiStore.getState().insertToComposer(`@file:${artifact.path} `)
                toast.success('已引用到输入框')
              }}
            >
              <Quote className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={isTextKind(artifact.kind) ? '复制内容' : '复制路径'}
              onClick={() => void copyAction()}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button size="icon-sm" variant="ghost" asChild title="下载">
              <a href={artifactContentUrl(currentId, artifact.path, { download: true })} download>
                <Download className="size-3.5" />
              </a>
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              className="ml-auto"
              title="在主区展开交付件工作台（文件树 / 源码 / Diff）"
              onClick={expand}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          </div>
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <PackageOpen className={cn('size-5 text-muted-foreground/60', listLoading && 'animate-pulse')} />
          <p className="text-[11.5px] text-muted-foreground">{listLoading ? '正在加载交付件…' : '暂无交付件'}</p>
        </div>
      )}

      {/* ③ 最近文件列表（≤5 行滚动；点列表项钉住 / 取消） */}
      {list.length > 0 && (
        <div className="shrink-0 border-t">
          <div className="max-h-[132px] overflow-y-auto p-1">
            {list.slice(0, RECENT_LIMIT).map((f) => {
              const name = baseName(f.path)
              const isChosen = artifact?.path === f.path
              const isPinned = pinnedPath === f.path
              return (
                <button
                  key={f.path}
                  type="button"
                  title={isPinned ? `取消钉住（回跟最新）：${f.path}` : `钉住查看：${f.path}`}
                  onClick={() => pinArtifact(isPinned ? undefined : f.path)}
                  className={cn(
                    'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-[11px] transition-colors',
                    isChosen ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent/60',
                  )}
                >
                  {KIND_ICON[f.kind]}
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {isPinned && <Pin className="size-2.5 shrink-0 text-primary" />}
                  <span className="shrink-0 text-[9.5px] text-muted-foreground">{humanSize(f.size)}</span>
                </button>
              )
            })}
          </div>
          <button
            type="button"
            title="在主区展开交付件工作台（全部文件与历史版本）"
            onClick={() => useUiStore.getState().expandWorkspace('artifacts')}
            className="flex w-full items-center justify-center gap-1 border-t py-1 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
          >
            全部文件 · {list.length}
            <ChevronRight className="size-3" />
          </button>
        </div>
      )}

      {/* 底栏：跟随状态 */}
      <div className="flex shrink-0 items-center justify-between border-t px-2 py-1">
        <span className="truncate text-[9.5px] text-muted-foreground">{pinnedPath ? '已钉住查看' : '实时跟最新'}</span>
        {pinnedPath && (
          <button
            type="button"
            title="取消钉住，回跟最新"
            onClick={() => pinArtifact(undefined)}
            className="shrink-0 text-[9.5px] text-primary transition-colors hover:underline"
          >
            回跟最新
          </button>
        )}
      </div>
    </div>
  )
}
