/**
 * md 块数据通道（M34 §6.1/§6.4）：内联 data 直接用；否则按 src 取会话交付件内容
 * （GET /api/sessions/:id/artifacts/content?raw=1，M6 通道零新增）。
 * 解析失败 / 取数失败 → 中文错误（调用方渲染错误卡 + 源码回退）。
 */
import * as React from 'react'
import { artifactContentUrl } from '../../../lib/artifacts'
import { useSessionStore } from '../../../stores/session-store'

export type SrcParse<P> = (json: Record<string, unknown>) => { ok: true; payload: P } | { ok: false; error: string }

export interface SrcDatasetState<P> {
  payload?: P
  error?: string
  loading?: boolean
}

export function useSrcDataset<P>(
  src: string | undefined,
  inline: P | undefined,
  parse: SrcParse<P>,
  kindLabel: string,
): SrcDatasetState<P> {
  const sessionId = useSessionStore((s) => s.currentId)
  const parseRef = React.useRef(parse)
  parseRef.current = parse
  // 内联数据同步派生（不经过 state：调用方每次渲染新建对象，入 state 会造成循环更新）
  const hasInline = inline !== undefined
  const [remote, setRemote] = React.useState<SrcDatasetState<P>>(() => (!hasInline && src ? { loading: true } : {}))

  React.useEffect(() => {
    if (hasInline) return // 内联优先：不发起取数
    if (!src) {
      setRemote((prev) => (Object.keys(prev).length === 0 ? prev : {}))
      return
    }
    if (!sessionId) {
      setRemote({ error: `当前无会话上下文，无法读取${kindLabel}文件` })
      return
    }
    let cancelled = false
    setRemote({ loading: true })
    void fetch(artifactContentUrl(sessionId, src, { raw: true }))
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => undefined)) as { error?: string } | undefined
          throw new Error(body?.error ?? `HTTP ${res.status}`)
        }
        return (await res.json()) as Record<string, unknown>
      })
      .then((json) => {
        if (cancelled) return
        const parsed = parseRef.current(json)
        if (!parsed.ok) {
          setRemote({ error: `${kindLabel}内容无效：${parsed.error}` })
          return
        }
        setRemote({ payload: parsed.payload })
      })
      .catch((err) => {
        if (!cancelled) setRemote({ error: `${kindLabel}读取失败：${(err as Error).message}` })
      })
    return () => {
      cancelled = true
    }
  }, [src, hasInline, sessionId, kindLabel])

  return hasInline ? { payload: inline } : remote
}
