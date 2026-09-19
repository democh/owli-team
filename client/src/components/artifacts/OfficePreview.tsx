/**
 * Office 交付件预览（M24）：服务端轻量解析结果渲染。
 * - docx → 语义化 HTML 文章（.off-doc 排版）；
 * - xlsx → 多工作表切换（>1 时显示 sheet 标签）+ DataTable；
 * - pptx → 幻灯片大纲卡片（标题 + 要点行）；
 * - 旧格式（doc/xls/ppt）/ 解析失败 / 超限 → 错误提示 + 下载引导。
 */
import * as React from 'react'
import { Download, FileWarning, Loader2 } from 'lucide-react'
import type { ArtifactPreview } from '@multi-agent/shared'
import { apiGet } from '../../lib/api'
import { artifactPreviewUrl } from '../../lib/artifacts'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { DataTable } from './DataTable'

export interface OfficePreviewProps {
  sessionId: string
  path: string
  /** 下载直链（错误态引导） */
  downloadUrl: string
}

export function OfficePreview({ sessionId, path, downloadUrl }: OfficePreviewProps): React.JSX.Element {
  const [preview, setPreview] = React.useState<ArtifactPreview>()
  const [error, setError] = React.useState<string>()
  const [loading, setLoading] = React.useState(true)
  const [sheet, setSheet] = React.useState(0)

  React.useEffect(() => {
    let alive = true
    setLoading(true)
    setError(undefined)
    setPreview(undefined)
    setSheet(0)
    void apiGet<ArtifactPreview>(artifactPreviewUrl(sessionId, path))
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
  }, [sessionId, path])

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        正在解析文档…
      </div>
    )
  }

  if (error || !preview) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <FileWarning className="size-8 text-muted-foreground/60" />
        <p className="max-w-md text-[12.5px] leading-5 text-muted-foreground">{error ?? '无法解析该文件'}</p>
        <Button variant="outline" size="sm" asChild>
          <a href={downloadUrl} download>
            <Download className="size-3.5" />
            下载文件
          </a>
        </Button>
      </div>
    )
  }

  if (preview.kind === 'docx') {
    // 信任边界：html 仅由服务端 office-preview 解析器生成（标签白名单 h1-h6/p/ul/li/table/strong/em/u，
    // 所有文本经 escapeHtml 转义，不透传原文件的原始标记），前端不做二次 sanitize。
    return (
      <div className="h-full overflow-y-auto">
        <article className="off-doc" dangerouslySetInnerHTML={{ __html: preview.html }} />
        {preview.truncated && (
          <p className="pb-4 text-center text-[11px] text-amber-600">内容较长，仅展示前部分（完整内容请下载）</p>
        )}
      </div>
    )
  }

  if (preview.kind === 'xlsx') {
    const active = preview.sheets[Math.min(sheet, preview.sheets.length - 1)]!
    return (
      <div className="flex h-full min-h-0 flex-col">
        {preview.sheets.length > 1 && (
          <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1">
            {preview.sheets.map((s, i) => (
              <button
                key={`${s.name}-${i}`}
                type="button"
                onClick={() => setSheet(i)}
                className={cn(
                  'shrink-0 rounded-md px-2 py-0.5 text-[11.5px] transition-colors',
                  i === sheet ? 'bg-primary/10 font-medium text-primary' : 'text-muted-foreground hover:bg-accent/70',
                )}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted/40 px-3 py-1 text-[11px] text-muted-foreground">
          <span>
            工作表「{active.name}」· {Math.max(0, active.rows.length - 1)} 行 × {active.rows[0]?.length ?? 0} 列
          </span>
          {(active.truncated || preview.truncated) && (
            <span className="font-medium text-amber-600">超出预览上限，已截断（完整数据请下载）</span>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {active.rows.length > 0 ? (
            <DataTable rows={active.rows} />
          ) : (
            <p className="p-6 text-center text-[12.5px] text-muted-foreground">该工作表为空</p>
          )}
        </div>
      </div>
    )
  }

  // pptx：幻灯片大纲卡片
  return (
    <div className="h-full overflow-y-auto px-4 py-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {preview.slides.map((slide, i) => (
          <section key={i} className="overflow-hidden rounded-lg border bg-card shadow-soft">
            <header className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5">
              <span className="shrink-0 rounded bg-primary/10 px-1.5 py-px text-[10px] font-medium text-primary">
                第 {i + 1} 页
              </span>
              <span className="truncate text-[12.5px] font-medium">{slide.title ?? '（无标题）'}</span>
            </header>
            <ul className="space-y-1 px-4 py-2.5 text-[12.5px] leading-5">
              {slide.lines.map((line, j) => (
                <li key={j} className="flex gap-2">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-primary/50" />
                  <span className="min-w-0 break-words">{line}</span>
                </li>
              ))}
              {slide.lines.length === 0 && (
                <li className="text-[11.5px] text-muted-foreground/70">本页无正文文本（可能为图片版式）</li>
              )}
            </ul>
          </section>
        ))}
        {preview.truncated && (
          <p className="pb-2 text-center text-[11px] text-amber-600">幻灯片较多，仅展示前 {preview.slides.length} 页</p>
        )}
      </div>
    </div>
  )
}
