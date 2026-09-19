/**
 * 交付件预览共用件（M49 / ADR 0100）：右栏实况·交付件面复用主区同款预览器。
 *
 * - useArtifactContent：文本类内联读取 + shiki 高亮（contentDriven 判定与主区 ArtifactsView 一致；
 *   image / office / pdf / other 走直出或服务端解析通道，不请求内容）；
 * - ArtifactPreviewBody：各 kind 分派渲染（markdown / code / html / chart / data / image / video /
 *   office / pdf / other），窄栏与主区视觉同构。
 */
import * as React from 'react'
import {
  BarChart3,
  Download,
  File as FileIcon,
  FileCode2,
  FileSpreadsheet,
  FileText,
  FileType2,
  Globe,
  Image as ImageIcon,
  Table2,
  Video,
} from 'lucide-react'
import type { Artifact, ArtifactKind } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { artifactContentUrl, isChartJson, isPreviewableOffice, isTextKind, langForFile } from '../../lib/artifacts'
import { highlightCode } from '../../lib/shiki'
import { humanSize } from '../../lib/time'
import { Button } from '../ui/button'
import { Markdown } from '../chat/Markdown'
import { ChartBlock } from '../chat/md-ext/ChartBlock'
import { MermaidBlock } from '../chat/md-ext/MermaidBlock'
import { CsvPreview } from './CsvPreview'
import { HtmlPreview } from './HtmlPreview'
import { OfficePreview } from './OfficePreview'
import { PdfPreview } from './PdfPreview'

export interface ArtifactContentResponse {
  path: string
  kind: ArtifactKind
  size: number
  truncated: boolean
  content: string
}

export const KIND_ICON: Record<ArtifactKind, React.JSX.Element> = {
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

/** 预览是否依赖内联内容（html / image / office / pdf 直出，不因内容加载而卸载预览） */
function contentDriven(kind: ArtifactKind): boolean {
  return kind === 'markdown' || kind === 'code' || kind === 'chart' || kind === 'data'
}

export interface ArtifactContent {
  preview: ArtifactContentResponse | null
  loading: boolean
  error?: string
  html: string
}

/** 内容加载（文本类内联读取）+ shiki 高亮（kind === 'code'） */
export function useArtifactContent(
  sessionId: string | undefined,
  artifact: Artifact | undefined,
  version: number,
): ArtifactContent {
  const [preview, setPreview] = React.useState<ArtifactContentResponse | null>(null)
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [html, setHtml] = React.useState('')

  const path = artifact?.path
  const kind = artifact?.kind

  React.useEffect(() => {
    setError(undefined)
    if (!sessionId || !path || !kind || !isTextKind(kind)) {
      setPreview(null)
      return
    }
    let alive = true
    setLoading(true)
    void apiGet<ArtifactContentResponse>(artifactContentUrl(sessionId, path))
      .then((res) => {
        if (alive) setPreview(res)
      })
      .catch((err) => {
        if (alive) setError((err as Error).message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [sessionId, path, kind, version])

  React.useEffect(() => {
    setHtml('')
    if (!path || kind !== 'code' || !preview) return
    let alive = true
    void highlightCode(preview.content, langForFile(path))
      .then((out) => {
        if (alive) setHtml(out)
      })
      .catch(() => {
        if (alive) setHtml('')
      })
    return () => {
      alive = false
    }
  }, [preview, path, kind])

  return { preview, loading, error, html }
}

/** 复制动作：文本类复制内容（未加载则拉取一次），其余复制路径（便于对话中 @ 引用） */
export async function copyArtifact(sessionId: string, artifact: Artifact, content?: ArtifactContent): Promise<void> {
  const text = content?.preview ?? (await apiGet<ArtifactContentResponse>(artifactContentUrl(sessionId, artifact.path)))
  await navigator.clipboard.writeText(text.content)
}

/** 预览分派（mode 固定为预览态：交付件面无源码 / Diff 切换，深度查看走主区工作台） */
export function ArtifactPreviewBody({
  sessionId,
  artifact,
  version,
  content,
}: {
  sessionId: string
  artifact: Artifact
  version: number
  content: ArtifactContent
}): React.JSX.Element {
  const { preview, loading, error, html } = content

  return (
    <div className="h-full overflow-hidden">
      {loading && contentDriven(artifact.kind) && (
        <div className="flex items-center justify-center gap-2 py-10 text-[12px] text-muted-foreground">
          <span className="size-3 animate-spin rounded-full border border-muted-foreground/40 border-t-transparent" />
          加载中…
        </div>
      )}

      {error && contentDriven(artifact.kind) && (
        <div className="flex flex-col items-center justify-center gap-2.5 py-10 text-center">
          <p className="max-w-xs px-4 text-[11.5px] text-muted-foreground">{error}</p>
          <Button variant="outline" size="sm" asChild>
            <a href={artifactContentUrl(sessionId, artifact.path, { download: true })} download>
              <Download className="size-3.5" />
              下载查看
            </a>
          </Button>
        </div>
      )}

      {artifact.kind === 'markdown' && !loading && !error && preview && (
        <div className="h-full overflow-y-auto">
          <div className="px-3 py-3">
            {preview.truncated && (
              <p className="mb-2 rounded-md bg-amber-500/10 px-2 py-1 text-[11px] text-amber-700">
                文件较大，仅展示前 {humanSize(preview.content.length)} 内容，完整版请下载
              </p>
            )}
            <Markdown content={preview.content} />
          </div>
        </div>
      )}

      {artifact.kind === 'code' && !loading && !error && (
        <div className="h-full overflow-y-auto px-2 py-2">
          {html ? (
            <div
              className="overflow-x-auto rounded-md border text-[11.5px] [&_code]:font-mono [&_pre]:p-2.5 [&_pre]:leading-5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <pre className="overflow-x-auto rounded-md border bg-muted p-2.5 font-mono text-[11px] leading-5">
              {preview?.content ?? ''}
            </pre>
          )}
        </div>
      )}

      {artifact.kind === 'html' && (
        <HtmlPreview
          key={`${artifact.path}-${version}`}
          src={artifactContentUrl(sessionId, artifact.path, { raw: true })}
          title={artifact.path}
        />
      )}

      {artifact.kind === 'chart' && !loading && !error && preview && (
        <div className="h-full overflow-y-auto px-3 py-3">
          {isChartJson(artifact.path) ? (
            <ChartBlock code={preview.content} title={artifact.path} />
          ) : (
            <MermaidBlock code={preview.content} title={artifact.path} />
          )}
        </div>
      )}

      {artifact.kind === 'data' && !loading && !error && preview && <CsvPreview content={preview.content} />}

      {artifact.kind === 'image' && (
        <div className="flex h-full items-center justify-center overflow-auto p-3">
          <img
            src={`${artifactContentUrl(sessionId, artifact.path)}&v=${version}`}
            alt={artifact.path}
            className="max-h-full max-w-full rounded-md border shadow-sm"
          />
        </div>
      )}

      {artifact.kind === 'video' && (
        <div className="flex h-full items-center justify-center overflow-auto p-3">
          {/* 视频直出（服务端 sendFile 支持 Range，可拖拽进度条） */}
          <video
            src={`${artifactContentUrl(sessionId, artifact.path)}&v=${version}`}
            controls
            preload="metadata"
            className="max-h-full max-w-full rounded-md border shadow-sm"
          />
        </div>
      )}

      {artifact.kind === 'office' &&
        (isPreviewableOffice(artifact.path) ? (
          <OfficePreview
            key={`${artifact.path}-${version}`}
            sessionId={sessionId}
            path={artifact.path}
            downloadUrl={artifactContentUrl(sessionId, artifact.path, { download: true })}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2.5 px-4 text-center">
            <FileSpreadsheet className="size-7 text-muted-foreground/60" />
            <p className="text-[11.5px] text-muted-foreground">旧版 Office 格式暂不支持在线预览，请下载后用本地应用打开</p>
            <Button variant="outline" size="sm" asChild>
              <a href={artifactContentUrl(sessionId, artifact.path, { download: true })} download>
                <Download className="size-3.5" />
                下载文件
              </a>
            </Button>
          </div>
        ))}

      {artifact.kind === 'pdf' && (
        <PdfPreview
          key={`${artifact.path}-${version}`}
          src={artifactContentUrl(sessionId, artifact.path, { raw: true })}
          title={artifact.path}
        />
      )}

      {artifact.kind === 'other' && (
        <div className="flex h-full flex-col items-center justify-center gap-2.5 px-4 text-center">
          <FileIcon className="size-7 text-muted-foreground/60" />
          <p className="text-[11.5px] text-muted-foreground">该类型不支持预览，请下载查看</p>
          <Button variant="outline" size="sm" asChild>
            <a href={artifactContentUrl(sessionId, artifact.path, { download: true })} download>
              <Download className="size-3.5" />
              下载文件
            </a>
          </Button>
        </div>
      )}
    </div>
  )
}
