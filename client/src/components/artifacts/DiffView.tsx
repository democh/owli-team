/**
 * 交付件 Diff 视图（M8）：
 * - 左：版本选择（from/to 下拉，v0 = 空文件基线）；
 * - 右：unified diff 行级渲染（行号 + 增删色 + 长上下文折叠）；
 * - 数据源：GET /api/sessions/:id/artifacts/versions、GET .../artifacts/diff。
 */
import * as React from 'react'
import { ArrowRight, GitCompareArrows, Loader2, RefreshCw } from 'lucide-react'
import { apiGet } from '../../lib/api'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'

/** 与 server/src/store/artifact-versions.ts 对齐（版本列表不带正文） */
export interface ArtifactVersion {
  id: string
  sessionId: string
  path: string
  version: number
  size: number
  hash: string
  authorAgentId?: string
  messageId?: string
  createdAt: string
}

export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk'
  text: string
  oldNo?: number
  newNo?: number
}

/** 解析 unified diff → 行模型（跳过文件头行；hunk 头记录起止行号） */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldNo = 0
  let newNo = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
      if (m) {
        oldNo = Number(m[1])
        newNo = Number(m[2])
      }
      lines.push({ kind: 'hunk', text: raw })
      continue
    }
    if (
      raw.startsWith('---') ||
      raw.startsWith('+++') ||
      raw.startsWith('Index:') ||
      raw.startsWith('===') ||
      raw.startsWith('\\ No newline')
    ) {
      continue
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), newNo: newNo++ })
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), oldNo: oldNo++ })
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
    // 其余（尾部空行等）忽略
  }
  return lines
}

const COLLAPSE_MIN = 12
const COLLAPSE_EDGE = 3

interface RenderRow {
  key: string
  kind: 'line' | 'collapsed'
  line?: DiffLine
  hidden?: number
  groupStart?: number
}

/** 连续上下文行超过阈值时折叠中段（保留首尾各 COLLAPSE_EDGE 行） */
export function buildDiffRows(lines: DiffLine[], expanded: Set<number>): RenderRow[] {
  const rows: RenderRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.kind !== 'context') {
      rows.push({ key: `l${i}`, kind: 'line', line })
      i++
      continue
    }
    let j = i
    while (j < lines.length && lines[j].kind === 'context') j++
    const len = j - i
    if (len > COLLAPSE_MIN && !expanded.has(i)) {
      const head = i + COLLAPSE_EDGE
      const tail = j - COLLAPSE_EDGE
      for (let k = i; k < head; k++) rows.push({ key: `l${k}`, kind: 'line', line: lines[k] })
      rows.push({ key: `c${i}`, kind: 'collapsed', hidden: tail - head, groupStart: i })
      for (let k = tail; k < j; k++) rows.push({ key: `l${k}`, kind: 'line', line: lines[k] })
    } else {
      for (let k = i; k < j; k++) rows.push({ key: `l${k}`, kind: 'line', line: lines[k] })
    }
    i = j
  }
  return rows
}

interface DiffResponse {
  path: string
  from: number
  to: number
  diff: string
  right: ArtifactVersion
}

export function DiffView({ sessionId, path }: { sessionId: string; path: string }): React.JSX.Element {
  const [versions, setVersions] = React.useState<ArtifactVersion[]>([])
  const [from, setFrom] = React.useState(0)
  const [to, setTo] = React.useState(1)
  const [diffText, setDiffText] = React.useState<string>()
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const [expanded, setExpanded] = React.useState<Set<number>>(new Set())

  // 加载版本列表 → 初始化 from/to 为最近一次改动
  React.useEffect(() => {
    let alive = true
    setDiffText(undefined)
    setError(undefined)
    void apiGet<{ versions: ArtifactVersion[] }>(
      `/api/sessions/${sessionId}/artifacts/versions?path=${encodeURIComponent(path)}`,
    )
      .then((res) => {
        if (!alive) return
        setVersions(res.versions)
        const latest = res.versions[0]?.version ?? 1
        setTo(latest)
        setFrom(Math.max(0, latest - 1))
      })
      .catch((err) => {
        if (alive) {
          setVersions([])
          setError((err as Error).message)
        }
      })
    return () => {
      alive = false
    }
  }, [sessionId, path])

  // 加载 diff
  const loadDiff = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(undefined)
    try {
      const res = await apiGet<DiffResponse>(
        `/api/sessions/${sessionId}/artifacts/diff?path=${encodeURIComponent(path)}&from=${from}&to=${to}`,
      )
      setDiffText(res.diff)
      setExpanded(new Set())
    } catch (err) {
      setDiffText(undefined)
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [sessionId, path, from, to])

  React.useEffect(() => {
    if (versions.length === 0 && !error) return
    if (from > to) return
    void loadDiff()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- versions 就绪后立即首载（v1 单版本时 from/to 与初值相同，不能仅靠 from/to 变化触发）
  }, [from, to, sessionId, path, versions])

  const lines = React.useMemo(() => (diffText ? parseUnifiedDiff(diffText) : []), [diffText])
  const rows = React.useMemo(() => buildDiffRows(lines, expanded), [lines, expanded])
  const stats = React.useMemo(() => {
    let add = 0
    let del = 0
    for (const l of lines) {
      if (l.kind === 'add') add++
      else if (l.kind === 'del') del++
    }
    return { add, del }
  }, [lines])

  const versionOptions = React.useMemo(() => {
    const opts = versions.map((v) => ({ value: v.version, label: `v${v.version}` }))
    opts.push({ value: 0, label: 'v0 · 空文件' })
    return opts.sort((a, b) => b.value - a.value)
  }, [versions])

  if (versions.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
        <GitCompareArrows className="size-8 opacity-50" />
        <p className="text-[12.5px] leading-5">
          {error ?? '该文件暂无版本记录'}
        </p>
        <Button variant="outline" size="sm" onClick={() => setError(undefined)}>
          <RefreshCw className="size-3.5" />
          重新检测
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-1.5 text-[11.5px]">
        <select
          value={from}
          onChange={(e) => setFrom(Number(e.target.value))}
          className="h-6 rounded border bg-background px-1 text-[11.5px] outline-none"
        >
          {versionOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <ArrowRight className="size-3 text-muted-foreground" />
        <select
          value={to}
          onChange={(e) => setTo(Number(e.target.value))}
          className="h-6 rounded border bg-background px-1 text-[11.5px] outline-none"
        >
          {versionOptions
            .filter((o) => o.value > 0)
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
        <span className="text-emerald-600">+{stats.add}</span>
        <span className="text-rose-600">-{stats.del}</span>
        <Button
          variant="ghost"
          size="icon-sm"
          className="ml-auto"
          title="刷新 diff"
          disabled={loading}
          onClick={() => void loadDiff()}
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center gap-2 py-12 text-[13px] text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            生成 diff…
          </div>
        )}
        {!loading && error && (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <p className="max-w-sm text-[12.5px] text-muted-foreground">{error}</p>
          </div>
        )}
        {!loading && !error && diffText !== undefined && rows.length === 0 && (
          <div className="py-12 text-center text-[12.5px] text-muted-foreground">两个版本内容一致</div>
        )}
        {!loading && !error && rows.length > 0 && (
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.7]">
            <tbody>
              {rows.map((row) => {
                if (row.kind === 'collapsed') {
                  return (
                    <tr key={row.key} className="bg-sky-500/10 text-sky-700">
                      <td colSpan={3} className="px-3 py-0.5">
                        <button
                          type="button"
                          className="w-full text-left hover:underline"
                          onClick={() =>
                            setExpanded((prev) => {
                              const next = new Set(prev)
                              if (row.groupStart !== undefined) next.add(row.groupStart)
                              return next
                            })
                          }
                        >
                          ⋯ 展开 {row.hidden} 行未变更内容
                        </button>
                      </td>
                    </tr>
                  )
                }
                const line = row.line!
                if (line.kind === 'hunk') {
                  return (
                    <tr key={row.key} className="bg-sky-500/10 text-sky-700">
                      <td colSpan={3} className="px-3 py-0.5">
                        {line.text}
                      </td>
                    </tr>
                  )
                }
                const add = line.kind === 'add'
                const del = line.kind === 'del'
                return (
                  <tr
                    key={row.key}
                    className={cn(
                      add && 'bg-emerald-500/10',
                      del && 'bg-rose-500/10',
                      !add && !del && 'hover:bg-accent/40',
                    )}
                  >
                    <td className="w-10 min-w-10 select-none border-r px-1.5 text-right text-[10.5px] text-muted-foreground/70">
                      {line.oldNo ?? ''}
                    </td>
                    <td className="w-10 min-w-10 select-none border-r px-1.5 text-right text-[10.5px] text-muted-foreground/70">
                      {line.newNo ?? ''}
                    </td>
                    <td className="whitespace-pre-wrap break-all px-3">
                      <span className={cn(add && 'text-emerald-700', del && 'text-rose-700')}>
                        {add ? '+' : del ? '-' : ' '}
                        {line.text}
                      </span>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
