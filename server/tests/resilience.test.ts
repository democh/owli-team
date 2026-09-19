/**
 * M4 LLM 韧性单测：错误分类（429 Retry-After / 5xx / 网络码 / context_length / 致命）、
 * 流式重试（仅首增量前安全重试）、超时分层（首 token / 空闲）、父级中断语义、并发信号量。
 *
 * 注：部分测试替身故意在产出任何增量前抛错/挂起，用于覆盖失败路径。
 */
/* eslint-disable require-yield -- 测试替身：故意在输出前抛错或挂起 */
import { describe, expect, it } from 'vitest'
import { abortError, type LlmChunk } from '../src/llm/provider.js'
import {
  LlmSemaphore,
  LlmTimeoutError,
  classifyLlmError,
  isContextLengthError,
  resilientStream,
  type ResilientStreamOptions,
} from '../src/llm/resilience.js'

function httpError(status: number, message: string, headers?: unknown): Error {
  return Object.assign(new Error(message), { status, ...(headers !== undefined ? { headers } : {}) })
}

function netError(code: string, message = 'network failure'): Error {
  return Object.assign(new Error(message), { code })
}

function baseOpts(overrides: Partial<ResilientStreamOptions> = {}): ResilientStreamOptions {
  return {
    maxAttempts: 3,
    baseDelayMs: 1,
    firstTokenTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    jitter: 'none',
    ...overrides,
  }
}

async function collect(stream: AsyncIterable<LlmChunk>): Promise<LlmChunk[]> {
  const out: LlmChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('M4：LLM 错误分类', () => {
  it('429 → 可重试并解析 Retry-After（Headers.get / 普通对象 / message 兜底）', () => {
    const plain = classifyLlmError(httpError(429, 'rate limited', { 'retry-after': '3' }))
    expect(plain.kind).toBe('retryable')
    expect(plain.status).toBe(429)
    expect(plain.retryAfterMs).toBe(3_000)

    const fetchHeaders = classifyLlmError(httpError(429, 'rate limited', new Headers({ 'retry-after': '2' })))
    expect(fetchHeaders.retryAfterMs).toBe(2_000)

    const fromMessage = classifyLlmError(httpError(429, 'Rate limited, please retry-after 1 seconds'))
    expect(fromMessage.retryAfterMs).toBe(1_000)

    // 无退避信息 → 交给指数退避
    expect(classifyLlmError(httpError(429, 'slow down')).retryAfterMs).toBeUndefined()
  })

  it('408 / 5xx / 网络类错误 → 可重试', () => {
    expect(classifyLlmError(httpError(408, 'request timeout')).kind).toBe('retryable')
    expect(classifyLlmError(httpError(500, 'boom')).kind).toBe('retryable')
    expect(classifyLlmError(httpError(503, 'unavailable')).kind).toBe('retryable')
    expect(classifyLlmError(netError('ECONNRESET')).kind).toBe('retryable')
    expect(classifyLlmError(netError('ETIMEDOUT')).kind).toBe('retryable')
    expect(classifyLlmError(netError('UND_ERR_SOCKET')).kind).toBe('retryable')
    expect(classifyLlmError(new Error('fetch failed')).kind).toBe('retryable')
  })

  it('超时错误可重试；中断错误致命', () => {
    expect(classifyLlmError(new LlmTimeoutError('first-token')).kind).toBe('retryable')
    expect(classifyLlmError(new LlmTimeoutError('idle')).kind).toBe('retryable')
    expect(classifyLlmError(abortError()).kind).toBe('fatal')
  })

  it('400 参数错误 / 401 / 403 → 致命', () => {
    expect(classifyLlmError(httpError(400, 'invalid temperature')).kind).toBe('fatal')
    expect(classifyLlmError(httpError(401, 'unauthorized')).kind).toBe('fatal')
    expect(classifyLlmError(httpError(403, 'forbidden')).kind).toBe('fatal')
  })

  it('400 + 上下文超长提示 → context_length 特判', () => {
    const cases = [
      "This model's maximum context length is 65536 tokens",
      'context_length_exceeded',
      'too many tokens in request',
    ]
    for (const message of cases) {
      const classified = classifyLlmError(httpError(400, message))
      expect(classified.kind).toBe('context_length')
      expect(isContextLengthError(httpError(400, message))).toBe(true)
    }
    expect(isContextLengthError(httpError(500, 'context length exceeded'))).toBe(false)
  })
})

describe('M4：流式重试（仅首增量前）', () => {
  it('429 后自动重试成功，onRetry 报告 Retry-After 延迟', async () => {
    let attempts = 0
    const retries: number[] = []
    const chunks = await collect(
      resilientStream(
        async function* () {
          attempts++
          if (attempts === 1) throw httpError(429, 'rate limited', { 'retry-after': '0' })
          yield { type: 'text', text: 'ok' }
          yield { type: 'done' }
        },
        baseOpts({ onRetry: (info) => retries.push(info.delayMs) }),
      ),
    )
    expect(attempts).toBe(2)
    expect(retries).toEqual([0])
    expect(chunks).toEqual([{ type: 'text', text: 'ok' }, { type: 'done' }])
  })

  it('5xx 按指数退避重试，耗尽后上抛最后一个错误', async () => {
    let attempts = 0
    await expect(
      collect(
        resilientStream(
          async function* () {
            attempts++
            throw httpError(500, `boom-${attempts}`)
          },
          baseOpts({ maxAttempts: 3 }),
        ),
      ),
    ).rejects.toThrow('boom-3')
    expect(attempts).toBe(3)
  })

  it('已产出内容后失败 → 不重试直接上抛（防重复文本）', async () => {
    let attempts = 0
    await expect(
      collect(
        resilientStream(
          async function* () {
            attempts++
            yield { type: 'text', text: '前半段' }
            throw httpError(500, 'mid-stream failure')
          },
          baseOpts(),
        ),
      ),
    ).rejects.toThrow('mid-stream failure')
    expect(attempts).toBe(1)
  })

  it('context_length 与致命错误不重试（交上层决策）', async () => {
    let attempts = 0
    await expect(
      collect(
        resilientStream(
          async function* () {
            attempts++
            throw httpError(400, 'maximum context length exceeded')
          },
          baseOpts(),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 })
    expect(attempts).toBe(1)

    attempts = 0
    await expect(
      collect(
        resilientStream(
          async function* () {
            attempts++
            throw httpError(401, 'unauthorized')
          },
          baseOpts(),
        ),
      ),
    ).rejects.toThrow('unauthorized')
    expect(attempts).toBe(1)
  })

  it('首 token 超时 → 中断单次尝试并重试成功', async () => {
    let attempts = 0
    const chunks = await collect(
      resilientStream(
        async function* (signal) {
          attempts++
          if (attempts === 1) {
            // 模拟服务端迟迟不产出首 token：挂起等待单次尝试被中断
            await new Promise<void>((_, reject) => {
              signal.addEventListener('abort', () => reject(abortError()), { once: true })
            })
          }
          yield { type: 'text', text: 'after-timeout' }
          yield { type: 'done' }
        },
        baseOpts({ firstTokenTimeoutMs: 30 }),
      ),
    )
    expect(attempts).toBe(2)
    expect(chunks[0]).toEqual({ type: 'text', text: 'after-timeout' })
  })

  it('流空闲超时（已产出内容）→ LlmTimeoutError 上抛且不重试', async () => {
    let attempts = 0
    const error = await collect(
      resilientStream(
        async function* (signal) {
          attempts++
          yield { type: 'text', text: '开头' }
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(abortError()), { once: true })
          })
        },
        baseOpts({ firstTokenTimeoutMs: 5_000, idleTimeoutMs: 30 }),
      ),
    ).catch((err: unknown) => err)
    expect(error).toBeInstanceOf(LlmTimeoutError)
    expect((error as LlmTimeoutError).phase).toBe('idle')
    expect(attempts).toBe(1)
  })

  it('父级中断 → 直接上抛不重试；已中断的父级 → 立即拒绝', async () => {
    const parent = new AbortController()
    let attempts = 0
    const running = collect(
      resilientStream(
        async function* (signal) {
          attempts++
          await new Promise<void>((_, reject) => {
            signal.addEventListener('abort', () => reject(abortError()), { once: true })
          })
        },
        baseOpts({ parentSignal: parent.signal, firstTokenTimeoutMs: 5_000 }),
      ),
    )
    setTimeout(() => parent.abort(), 10)
    const error = await running.catch((err: unknown) => err)
    expect((error as { name?: string }).name).toBe('AbortError')
    expect(attempts).toBe(1)

    parent.abort()
    let started = 0
    await expect(
      collect(
        resilientStream(
          async function* () {
            started++
          },
          baseOpts({ parentSignal: parent.signal }),
        ),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(started).toBe(0)
  })

  it('退避抖动确定性开启（jitter=none 时按 2^n 指数）', async () => {
    const delays: number[] = []
    let attempts = 0
    await collect(
      resilientStream(
        async function* () {
          attempts++
          if (attempts < 3) throw httpError(503, 'unavailable')
          yield { type: 'done' }
        },
        baseOpts({ baseDelayMs: 2, onRetry: (info) => delays.push(info.delayMs) }),
      ),
    )
    expect(delays).toEqual([2, 4])
  })
})

describe('M4：并发信号量', () => {
  it('max 内立即获得；超出排队；释放时名额移交队首', async () => {
    const sem = new LlmSemaphore(1)
    const release1 = await sem.acquire()
    expect(sem.running).toBe(1)

    let secondAcquired = false
    const secondPromise = sem.acquire().then((release) => {
      secondAcquired = true
      return release
    })
    await delay(5)
    expect(secondAcquired).toBe(false)
    expect(sem.pending).toBe(1)

    release1()
    const release2 = await secondPromise
    expect(secondAcquired).toBe(true)
    // 名额直接移交：running 不变，pending 清空
    expect(sem.running).toBe(1)
    expect(sem.pending).toBe(0)
    release2()
    expect(sem.running).toBe(0)
  })

  it('release 幂等；等待中断 → AbortError 且不再占用队列', async () => {
    const sem = new LlmSemaphore(1)
    const once = await sem.acquire()
    once()
    once()
    expect(sem.running).toBe(0)

    const keeper = await sem.acquire()
    const controller = new AbortController()
    const blocked = sem.acquire(controller.signal)
    await delay(5)
    expect(sem.pending).toBe(1)
    controller.abort()
    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' })
    expect(sem.pending).toBe(0)
    keeper()
    expect(sem.running).toBe(0)
  })

  it('max>1 时并发获得不阻塞', async () => {
    const sem = new LlmSemaphore(2)
    const a = await sem.acquire()
    const b = await sem.acquire()
    expect(sem.running).toBe(2)
    expect(sem.pending).toBe(0)
    a()
    b()
    expect(sem.running).toBe(0)
  })
})
