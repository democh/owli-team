/**
 * M31：脑图工坊对话框（P4）—— 五来源 AI 生成（对话 / 计划 / 任务 / 记忆 / 主题），
 * 或粘贴 Markdown 大纲直接成图；落位 dagre 布局后关闭并提示。
 *
 * 生成走 `POST /sessions/:id/canvas/mind`（只读调用；落画布由本组件收口，
 * 避免服务端写文档与用户编辑互撞乐观锁）；生成中骨架呼吸（canvas-breath，响应安静模式）。
 */
import * as React from 'react'
import {
  Brain,
  ChevronDown,
  FileText,
  Lightbulb,
  ListChecks,
  ListTodo,
  Loader2,
  MessagesSquare,
  Sparkles,
  Waypoints,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import type { MindGenerateResponse, MindSource, MindTreeNode } from '@multi-agent/shared'
import { mindTreeInserts, parseMindOutline } from '../../lib/mind'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/dialog'

const SOURCES: Array<{ id: MindSource; label: string; desc: string; icon: LucideIcon }> = [
  { id: 'conversation', label: '对话', desc: '从最近聊天提炼结论与待办', icon: MessagesSquare },
  { id: 'plans', label: '计划', desc: '计划的目标 / 步骤 / 风险', icon: ListChecks },
  { id: 'tasks', label: '任务', desc: '任务清单铺成阶段视图', icon: ListTodo },
  { id: 'memory', label: '记忆', desc: '启用的会话记忆聚类', icon: Brain },
  { id: 'topic', label: '主题', desc: '输入任意主题自由展开', icon: Lightbulb },
]

export interface MindDialogProps {
  /** 落位原点（画布坐标：打开对话框时的视野中心） */
  origin: { x: number; y: number }
  onClose(): void
}

export function MindDialog({ origin, onClose }: MindDialogProps): React.JSX.Element {
  const sessionId = useCanvasStore((s) => s.sessionId)
  const [source, setSource] = React.useState<MindSource>('conversation')
  const [topic, setTopic] = React.useState('')
  const [generating, setGenerating] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [outlineOpen, setOutlineOpen] = React.useState(false)
  const [outline, setOutline] = React.useState('')

  /** 树 → 画布节点（dagre 落位 → 提示 → 关闭） */
  const place = (tree: MindTreeNode, message?: string): void => {
    const { nodes, edges } = mindTreeInserts(tree, origin)
    if (nodes.length === 0) return
    useCanvasStore.getState().addNodes(nodes, edges)
    toast(message ?? `脑图已落位：${nodes.length} 个节点`)
    onClose()
  }

  const generate = async (): Promise<void> => {
    if (!sessionId || generating) return
    if (source === 'topic' && !topic.trim()) {
      setError('先输入一个主题')
      return
    }
    setGenerating(true)
    setError(undefined)
    try {
      const res = await fetch(`/api/sessions/${sessionId}/canvas/mind`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source, topic: source === 'topic' ? topic.trim() : undefined }),
      })
      const data = (await res.json().catch(() => ({}))) as Partial<MindGenerateResponse> & { error?: string }
      if (!res.ok || !data.tree) throw new Error(data.error ?? `生成失败（HTTP ${res.status}）`)
      place(data.tree)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  const fromOutline = (): void => {
    const tree = parseMindOutline(outline)
    if (!tree) {
      setError('大纲没有内容：每行一条，用缩进（两空格）表示层级')
      return
    }
    setError(undefined)
    place(tree, '已从大纲创建脑图')
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        className="max-w-lg"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            void generate()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[14px]">
            <Waypoints className="size-4 text-primary" aria-hidden />
            脑图工坊
          </DialogTitle>
        </DialogHeader>

        <div className="mt-3 grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="脑图来源">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={source === s.id}
              className={cn(
                'flex items-start gap-2 rounded-lg border p-2 text-left transition-colors hover:bg-accent',
                source === s.id && 'border-primary/60 bg-primary/5',
              )}
              onClick={() => setSource(s.id)}
            >
              <s.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0">
                <span className="block text-[12px] leading-4">{s.label}</span>
                <span className="mt-0.5 block text-[10px] leading-3.5 text-muted-foreground/70">{s.desc}</span>
              </span>
            </button>
          ))}
        </div>

        {source === 'topic' && (
          <input
            autoFocus
            value={topic}
            placeholder="输入主题，例如「给新用户的引导旅程」"
            className="mt-2 w-full rounded-md border bg-transparent px-2 py-1.5 text-[12px] outline-none placeholder:text-muted-foreground/50 focus:border-primary/50"
            onChange={(e) => setTopic(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
                e.preventDefault()
                void generate()
              }
            }}
          />
        )}

        {generating && (
          <div className="mt-3 space-y-1.5 rounded-lg border border-dashed p-3" aria-label="生成中">
            {[68, 46, 82].map((w, i) => (
              <div
                key={i}
                className="canvas-breath h-2.5 rounded-full bg-muted"
                style={{ width: `${w}%`, animationDelay: `${i * 160}ms` }}
              />
            ))}
            <p className="pt-0.5 text-[10px] text-muted-foreground/70">正在梳理素材，生成结构化树…</p>
          </div>
        )}

        {error && !generating && <p className="mt-2 text-[12px] text-rose-600">{error}</p>}

        <div className="mt-3 flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground/60">⌘Enter 快速生成</span>
          <button
            type="button"
            disabled={generating || (source === 'topic' && !topic.trim())}
            className="flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            onClick={() => void generate()}
          >
            {generating ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Sparkles className="size-3.5" aria-hidden />}
            {generating ? '生成中…' : 'AI 生成脑图'}
          </button>
        </div>

        <div className="mt-4 border-t pt-2.5">
          <button
            type="button"
            className="flex w-full items-center justify-between text-[12px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setOutlineOpen((v) => !v)}
          >
            <span className="flex items-center gap-1.5">
              <FileText className="size-3.5" aria-hidden />
              或粘贴 Markdown 大纲直接成图
            </span>
            <ChevronDown className={cn('size-3.5 transition-transform', outlineOpen && 'rotate-180')} aria-hidden />
          </button>
          {outlineOpen && (
            <>
              <textarea
                rows={5}
                value={outline}
                placeholder={'- 中心主题\n  - 分支甲\n    - 要点\n  - 分支乙'}
                className="mt-2 w-full resize-none rounded-md border bg-transparent p-2 font-mono text-[11px] leading-5 outline-none placeholder:text-muted-foreground/40 focus:border-primary/50"
                onChange={(e) => setOutline(e.target.value)}
              />
              <div className="mt-1.5 flex justify-end">
                <button
                  type="button"
                  disabled={!outline.trim()}
                  className="rounded-md border px-2.5 py-1 text-[11.5px] transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
                  onClick={fromOutline}
                >
                  从大纲创建
                </button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
