import type { Response } from 'express'
import type { RunEvent } from '@multi-agent/shared'

export function initSse(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
}

export function writeSse(res: Response, event: RunEvent | Record<string, unknown>): void {
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** SSE 保活注释（25s） */
export function startSseHeartbeat(res: Response): () => void {
  const timer = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n')
  }, 25_000)
  return () => clearInterval(timer)
}
