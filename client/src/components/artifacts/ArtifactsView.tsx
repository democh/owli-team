/**
 * 交付件浏览器（§22.4）：左文件树（按目录分组）+ 右预览
 * （Markdown 渲染 / shiki 代码高亮 + 复制 / 图片直出 / 二进制下载引导）。
 * 刷新触发：artifactVersion（SSE + WS 双通道）、会话切换、chip 跳转。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  BarChart3,
  Copy,
  Download,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  FolderOpen,
  Frame,
  Globe,
  Image as ImageIcon,
  Loader2,
  PackageOpen,
  Quote,
  RefreshCw,
  Table2,
  Video,
} from 'lucide-react'
import type { Artifact, ArtifactKind } from '@multi-agent/shared'
import { measureDoc } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { artifactContentUrl, extOf, isChartJson, isPreviewableOffice, isTextKind, langForFile } from '../../lib/artifacts'
import { highlightCode } from '../../lib/shiki'
import { humanSize, timeAgo } from '../../lib/time'
import { cn } from '../../lib/utils'
import { useAgentStore } from '../../stores/agent-store'
import { useCanvasStore } from '../../stores/canvas-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { AgentAvatar } from '../agents/AgentAvatar'
import { Markdown } from '../chat/Markdown'
import { ChartBlock } from '../chat/md-ext/ChartBlock'
import { MermaidBlock } from '../chat/md-ext/MermaidBlock'
import { CsvPreview } from './CsvPreview'
import { DiffView } from './DiffView'
import { HtmlPreview } from './HtmlPreview'
import { OfficePreview } from './OfficePreview'
import { PdfPreview } from './PdfPreview'

interface ContentResponse {
  path: string
  kind: ArtifactKind
  size: number
  truncated: boolean
  content: string
}

const KIND_ICON: Record<ArtifactKind, React.JSX.Element> = {
  markdown: <FileText className="size-3.5 shrink-0 text-blue-600" />,
  code: <FileCode2 className="size-3.5 shrink-0 text-emerald-600" />,
  html: <Globe className="size-3.5 shrink-0 text-cyan-600" />,
  chart: <BarChart3 className="size-3.5 shrink-0 text-violet-600" />,
  data: <Table2 className="size-3.5 shrink-0 text-amber-600" />,
  image: <ImageIcon className="size-3.5 shrink-0 text-pink-600" />,
  video: <Video className="size-3.5 shrink-0 text-rose-600" />,
  office: <FileSpreadsheet className="size-3.5 shrink-0 text-orange-600" />,
  pdf: <FileType2 className="size-3.5 shrink-0 text-red-600" />,
  other: <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />,
}

/** 「源码」视图仅对带富预览形态的文本类有意义（code 预览本身即源码，不提供切换） */
function hasSourceView(kind: ArtifactKind): boolean {
  return kind === 'markdown' || kind === 'html' || kind === 'chart' || kind === 'data'
}

/** 预览是否依赖内联内容（html / image / office / pdf 直出，不因内容加载而卸载预览） */
function contentDriven(kind: ArtifactKind): boolean {
  return kind === 'markdown' || kind === 'code' || kind === 'chart' || kind === 'data'
}

/** 工具条模式按钮（预览 / 源码 / Diff 同款） */
function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-2 py-0.5 text-[11px] transition-colors',
        active ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent/70',
      )}
    >
      {children}
    </button>
  )
}

/** 交付规格体检条（与 server write_file 落盘体检同口径 measureDoc）：仅 Markdown 预览展示 */
function DocMetricsBar({ content }: { content: string }): React.JSX.Element {
  const m = React.useMemo(() => measureDoc(content), [content])
  const charsText = m.chars >= 10_000 ? `${(m.chars / 1000).toFixed(1)}k` : String(m.chars)
  return (
    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/70">交付体检</span>
      <span>{charsText} 字</span>
      <span>{m.sections} 章节</span>
      <span>表格 {m.tables}</span>
      <span>来源 {m.sources}</span>
      {m.placeholders > 0 && (
        <span className="font-medium text-amber-600">⚠ 占位残留 {m.placeholders} 处，交付前应清理</span>
      )}
    </div>
  )
}

export function ArtifactsView(): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const artifactVersion = useSessionStore((s) => s.artifactVersion)
  const requested = useUiStore((s) => s.requestedArtifactPath)
  const consumeRequest = useUiStore((s) => s.consumeArtifactRequest)
  const lastPath = useUiStore((s) => s.lastArtifactPath)
  const agents = useAgentStore((s) => s.agents)

  const [list, setList] = React.useState<Artifact[]>([])
  const [listLoading, setListLoading] = React.useState(false)
  const [selected, setSelected] = React.useState<string>()
  const [preview, setPreview] = React.useState<ContentResponse | null>(null)
  const [previewLoading, setPreviewLoading] = React.useState(false)
  const [previewError, setPreviewError] = React.useState<string>()
  const [html, setHtml] = React.useState<string>('')
  const [mode, setMode] = React.useState<'preview' | 'source' | 'diff'>('preview')

  // 列表加载
  React.useEffect(() => {
    if (!currentId) {
      setList([])
      setSelected(undefined)
      return
    }
    let alive = true
    setListLoading(true)
    void apiGet<{ artifacts: Artifact[] }>(`/api/sessions/${currentId}/artifacts`)
      .then((res) => {
        if (!alive) return
        setList(res.artifacts)
      })
      .catch((err) => toast.error((err as Error).message))
      .finally(() => alive && setListLoading(false))
    return () => {
      alive = false
    }
  }, [currentId, artifactVersion])

  // chip 跳转
  React.useEffect(() => {
    if (requested) {
      setSelected(requested)
      consumeRequest()
    }
  }, [requested, consumeRequest])

  // 自动选中第一个
  React.useEffect(() => {
    if (!selected && list.length > 0) setSelected(list[0].path)
  }, [list, selected])

  // 刷新列表后若选中项已消失 → 回退
  React.useEffect(() => {
    if (selected && list.length > 0 && !list.some((a) => a.path === selected)) setSelected(list[0].path)
  }, [list, selected])

  const artifact = list.find((a) => a.path === selected)

  // 切换文件时回到预览视图
  React.useEffect(() => {
    setMode('preview')
  }, [selected])

  // 内容加载（仅文本类内联读取：Markdown / 源码 / 图表配置 / CSV / HTML 复制；
  //  image / office / pdf / other 走直出或服务端解析通道，不请求内容）
  React.useEffect(() => {
    setHtml('')
    setPreviewError(undefined)
    if (!currentId || !selected || !artifact || !isTextKind(artifact.kind)) {
      setPreview(null)
      return
    }
    let alive = true
    setPreviewLoading(true)
    void apiGet<ContentResponse>(artifactContentUrl(currentId, selected))
      .then((res) => {
        if (alive) setPreview(res)
      })
      .catch((err) => {
        if (alive) setPreviewError((err as Error).message)
      })
      .finally(() => alive && setPreviewLoading(false))
    return () => {
      alive = false
    }
  }, [currentId, selected, artifact, artifactVersion])

  // 代码高亮（code 预览 / 文本类源码视图共用）
  React.useEffect(() => {
    setHtml('')
    if (!artifact || !preview) return
    if (artifact.kind !== 'code' && mode !== 'source') return
    let alive = true
    void highlightCode(preview.content, langForFile(artifact.path))
      .then((out) => {
        if (alive) setHtml(out)
      })
      .catch(() => {
        if (alive) setHtml('')
      })
    return () => {
      alive = false
    }
  }, [preview, artifact, mode])

  // 目录分组
  const groups = React.useMemo(() => {
    const map = new Map<string, Artifact[]>()
    for (const a of list) {
      const seg = a.path.includes('/') ? a.path.split('/')[0] : '· 根目录'
      const arr = map.get(seg) ?? []
      arr.push(a)
      map.set(seg, arr)
    }
    return [...map.entries()].sort((x, y) => y[1].length - x[1].length)
  }, [list])

  const author = artifact?.authorAgentId ? agents.find((a) => a.id === artifact.authorAgentId) : undefined

  /** 文本类复制内容；二进制 / 图片 / Office / PDF 复制相对路径（便于在对话中 @ 引用） */
  const copyAction = async (): Promise<void> => {
    if (!currentId || !artifact) return
    try {
      if (isTextKind(artifact.kind)) {
        const res = preview ?? (await apiGet<ContentResponse>(artifactContentUrl(currentId, artifact.path)))
        await navigator.clipboard.writeText(res.content)
        toast('内容已复制到剪贴板')
      } else {
        await navigator.clipboard.writeText(artifact.path)
        toast('路径已复制到剪贴板')
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** M31：送上画布并切换（图片 / 视频落为素材节点，其余为交付件引用节点） */
  const openInCanvas = async (): Promise<void> => {
    if (!artifact) return
    const id = await useCanvasStore.getState().sendArtifact(artifact.path)
    if (!id) return
    useUiStore.getState().setMainTab('canvas')
    toast('已在画布打开')
  }

  if (!currentId) {
    return <div className="flex h-full items-center justify-center text-[13px] text-muted-foreground">先选择一个会话</div>
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* 文件树 */}
      <div className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex h-9 shrink-0 items-center justify-between border-b px-3">
          <span className="text-[12px] font-semibold text-muted-foreground">
            工作区 · {list.length} 个文件 {listLoading && <Loader2 className="inline size-3 animate-spin" />}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            title="刷新"
            onClick={() => useSessionStore.getState().bumpArtifacts()}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {list.length === 0 && !listLoading && (
            <div className="px-2 py-10 text-center text-[12px] leading-5 text-muted-foreground">
              <PackageOpen className="mx-auto mb-2 size-6 opacity-60" />
              暂无交付件
              <br />
              成员调用 write_file 后实时出现在这里
            </div>
          )}
          {groups.map(([dir, files]) => (
            <div key={dir} className="mb-2">
              <div className="flex items-center gap-1 px-1.5 py-1 text-[11px] font-medium text-muted-foreground">
                <FolderOpen className="size-3.5" />
                {dir}
              </div>
              <div className="space-y-0.5">
                {files.map((f) => {
                  const name = f.path.split('/').pop() ?? f.path
                  const isSelected = f.path === selected
                  const isFresh = f.path === lastPath
                  return (
                    <button
                      key={f.path}
                      type="button"
                      title={f.path}
                      onClick={() => setSelected(f.path)}
                      className={cn(
                        'flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-[12px] transition-all',
                        isSelected ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-accent/70',
                        isFresh && !isSelected && 'ring-1 ring-primary/30',
                      )}
                    >
                      {KIND_ICON[f.kind]}
                      <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">{humanSize(f.size)}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 预览区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b px-3 py-1.5">
          {artifact ? (
            <>
              <span className="min-w-0 truncate font-mono text-[12px]">{artifact.path}</span>
              <Badge variant="outline">{artifact.kind}</Badge>
              <span className="text-[11px] text-muted-foreground">
                {humanSize(artifact.size)} · {timeAgo(artifact.updatedAt)}
              </span>
              {author && (
                <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <AgentAvatar agent={author} size={16} animated={false} />
                  {author.name}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1.5">
                <div className="flex items-center overflow-hidden rounded-md border">
                  <ModeButton active={mode === 'preview'} onClick={() => setMode('preview')}>
                    预览
                  </ModeButton>
                  {hasSourceView(artifact.kind) && (
                    <ModeButton active={mode === 'source'} onClick={() => setMode('source')}>
                      源码
                    </ModeButton>
                  )}
                  {isTextKind(artifact.kind) && (
                    <ModeButton active={mode === 'diff'} onClick={() => setMode('diff')}>
                      Diff
                    </ModeButton>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  title="引用到输入框"
                  onClick={() => {
                    useUiStore.getState().insertToComposer(`@file:${artifact.path} `)
                    toast('已引用到输入框')
                  }}
                >
                  <Quote className="size-3" />
                  引用
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  title="送上画布（作为素材节点继续创作）"
                  onClick={() => void openInCanvas()}
                >
                  <Frame className="size-3" />
                  画布
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  title={isTextKind(artifact.kind) ? '复制内容' : '复制路径'}
                  onClick={() => void copyAction()}
                >
                  <Copy className="size-3" />
                  复制
                </Button>
                <Button variant="outline" size="xs" asChild>
                  <a href={artifactContentUrl(currentId, artifact.path, { download: true })} download>
                    <Download className="size-3" />
                    下载
                  </a>
                </Button>
              </span>
            </>
          ) : (
            <span className="text-[12px] text-muted-foreground">选择左侧文件查看内容</span>
          )}
        </div>

        {artifact && mode === 'diff' && isTextKind(artifact.kind) ? (
          <div className="min-h-0 flex-1">
            <DiffView sessionId={currentId} path={artifact.path} />
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">
            {!artifact && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <PackageOpen className="float-soft size-10 opacity-50" />
              </div>
            )}

            {artifact && previewLoading && (contentDriven(artifact.kind) || mode === 'source') && (
              <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                加载中…
              </div>
            )}

            {artifact && previewError && contentDriven(artifact.kind) && (
              <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
                <p className="max-w-sm text-[12.5px] text-muted-foreground">{previewError}</p>
                <Button variant="outline" size="sm" asChild>
                  <a href={artifactContentUrl(currentId, artifact.path, { download: true })} download>
                    <Download className="size-3.5" />
                    下载查看
                  </a>
                </Button>
              </div>
            )}

            {/* 源码视图（markdown / html / chart / data） */}
            {artifact && mode === 'source' && !previewLoading && !previewError && (
              <div className="h-full overflow-y-auto px-3 py-3">
                {html ? (
                  <div
                    className="overflow-x-auto rounded-md border text-[12.5px] [&_code]:font-mono [&_pre]:p-3.5 [&_pre]:leading-5"
                    dangerouslySetInnerHTML={{ __html: html }}
                  />
                ) : (
                  <pre className="overflow-x-auto rounded-md border bg-muted p-3.5 font-mono text-[12px] leading-5">
                    {preview?.content ?? ''}
                  </pre>
                )}
              </div>
            )}

            {/* 预览视图（各 kind 分派；直出类不受内容加载态影响，避免闪烁） */}
            {artifact && mode === 'preview' && (
              <>
                {artifact.kind === 'markdown' && !previewLoading && !previewError && preview && (
                  <div className="h-full overflow-y-auto">
                    <div className="mx-auto max-w-3xl px-6 py-5">
                      <DocMetricsBar content={preview.content} />
                      {preview.truncated && (
                        <p className="mb-3 rounded-md bg-amber-500/10 px-2 py-1 text-[11.5px] text-amber-700">
                          文件较大，仅展示前 {humanSize(preview.content.length)} 内容，完整版请下载
                        </p>
                      )}
                      <Markdown content={preview.content} />
                    </div>
                  </div>
                )}

                {artifact.kind === 'code' && !previewLoading && !previewError && (
                  <div className="h-full overflow-y-auto px-3 py-3">
                    {html ? (
                      <div
                        className="overflow-x-auto rounded-md border text-[12.5px] [&_code]:font-mono [&_pre]:p-3.5 [&_pre]:leading-5"
                        dangerouslySetInnerHTML={{ __html: html }}
                      />
                    ) : (
                      <pre className="overflow-x-auto rounded-md border bg-muted p-3.5 font-mono text-[12px] leading-5">
                        {preview?.content ?? ''}
                      </pre>
                    )}
                  </div>
                )}

                {artifact.kind === 'html' && (
                  <HtmlPreview
                    key={`${artifact.path}-${artifactVersion}`}
                    src={artifactContentUrl(currentId, artifact.path, { raw: true })}
                    title={artifact.path}
                  />
                )}

                {artifact.kind === 'chart' && !previewLoading && !previewError && preview && (
                  <div className="h-full overflow-y-auto px-4 py-4">
                    {isChartJson(artifact.path) ? (
                      <ChartBlock code={preview.content} title={artifact.path} />
                    ) : (
                      <MermaidBlock code={preview.content} title={artifact.path} />
                    )}
                  </div>
                )}

                {artifact.kind === 'data' && !previewLoading && !previewError && preview && <CsvPreview content={preview.content} />}

                {artifact.kind === 'image' && (
                  <div className="flex h-full items-center justify-center overflow-auto p-6">
                    <img
                      src={`${artifactContentUrl(currentId, artifact.path)}&v=${artifactVersion}`}
                      alt={artifact.path}
                      className="max-h-full max-w-full rounded-md border shadow-sm"
                    />
                  </div>
                )}

                {artifact.kind === 'video' && (
                  <div className="flex h-full items-center justify-center overflow-auto p-6">
                    {/* M31：视频直出（服务端 sendFile 支持 Range，可拖拽进度条） */}
                    <video
                      src={`${artifactContentUrl(currentId, artifact.path)}&v=${artifactVersion}`}
                      controls
                      preload="metadata"
                      className="max-h-full max-w-full rounded-md border shadow-sm"
                    />
                  </div>
                )}

                {artifact.kind === 'office' &&
                  (isPreviewableOffice(artifact.path) ? (
                    <OfficePreview
                      key={`${artifact.path}-${artifactVersion}`}
                      sessionId={currentId}
                      path={artifact.path}
                      downloadUrl={artifactContentUrl(currentId, artifact.path, { download: true })}
                    />
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                      <FileSpreadsheet className="size-8 text-muted-foreground/60" />
                      <p className="max-w-sm text-[12.5px] text-muted-foreground">
                        旧版 Office 格式（.{extOf(artifact.path)}）暂不支持在线预览，请下载后用本地应用打开
                      </p>
                      <Button variant="outline" size="sm" asChild>
                        <a href={artifactContentUrl(currentId, artifact.path, { download: true })} download>
                          <Download className="size-3.5" />
                          下载文件
                        </a>
                      </Button>
                    </div>
                  ))}

                {artifact.kind === 'pdf' && (
                  <PdfPreview
                    key={`${artifact.path}-${artifactVersion}`}
                    src={artifactContentUrl(currentId, artifact.path, { raw: true })}
                    title={artifact.path}
                  />
                )}

                {artifact.kind === 'other' && (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                    <FileIcon className="size-8 text-muted-foreground/60" />
                    <p className="text-[12.5px] text-muted-foreground">该类型不支持预览，请下载查看</p>
                    <Button variant="outline" size="sm" asChild>
                      <a href={artifactContentUrl(currentId, artifact.path, { download: true })} download>
                        <Download className="size-3.5" />
                        下载文件
                      </a>
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
