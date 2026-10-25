import { describe, expect, it, vi } from 'vitest'
import { ContextService, type ContextServiceDeps } from '../src/context/service.js'
import type { CompressionResult } from '../src/context/compressor.js'

const result = { compressed: false, untilSeq: 0, degraded: false } as CompressionResult
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
function make(compress: (...args: unknown[]) => Promise<CompressionResult>) {
  return new ContextService({ compressor: { compress } } as unknown as ContextServiceDeps)
}

describe('上下文压缩的会话队列', () => {
  it('至少三个同会话请求严格串行，不同会话可以并行', async () => {
    const active = new Map<string, number>()
    let maximum = 0
    let global = 0
    let globalMaximum = 0
    const service = make(async (...args) => {
      const { sessionId } = args[0] as { sessionId: string }
      active.set(sessionId, (active.get(sessionId) ?? 0) + 1)
      maximum = Math.max(maximum, active.get(sessionId)!)
      globalMaximum = Math.max(globalMaximum, ++global)
      await sleep(5)
      active.set(sessionId, active.get(sessionId)! - 1)
      global--
      return result
    })
    await Promise.all(['a', 'a', 'a', 'b'].map((sessionId) => service.forceCompress({ sessionId })))
    expect(maximum).toBe(1)
    expect(globalMaximum).toBe(2)
  })

  it('先到者失败不阻塞后到者，队列结束后可继续执行', async () => {
    const compress = vi.fn(async () => result).mockRejectedValueOnce(new Error('压缩失败'))
    const service = make(compress)
    const outcomes = await Promise.allSettled([0, 1, 2].map(() => service.forceCompress({ sessionId: 'a' })))
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'fulfilled', 'fulfilled'])
    expect(await service.forceCompress({ sessionId: 'a' })).toBe(result)
    expect(compress).toHaveBeenCalledTimes(4)
  })

  it('排队中取消不调用压缩器，也不阻塞后继', async () => {
    const compress = vi.fn(async () => { await sleep(5); return result })
    const service = make(compress)
    const first = service.forceCompress({ sessionId: 'a' })
    const controller = new AbortController()
    const waiting = service.forceCompress({ sessionId: 'a', signal: controller.signal })
    const assertion = expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    const last = service.forceCompress({ sessionId: 'a' })
    controller.abort()
    await Promise.all([first, assertion, last])
    expect(compress).toHaveBeenCalledTimes(2)
  })
})
