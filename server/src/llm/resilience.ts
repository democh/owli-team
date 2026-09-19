/**
 * LLM 接入层韧性（M4）：把「一次抖动就整轮失败」变成可自愈。
 * - 错误分类：可重试（429 尊重 Retry-After / 408 / 5xx / 网络类）/ 致命（400 参数、401/403）/ 上下文超长特判；
 * - 流式重试：仅「首个有效增量之前」的失败可安全重试（已产出内容重放会产生重复文本）；
 * - 静默中止兜底：OpenAI SDK 对 abort 静默结束迭代器（不抛错），循环正常退出前须复核
 *   父级信号与超时相位，否则中断 / 超时会被误判为「正常完成」；
 * - 超时分层：首 token 超时 / 流空闲超时（单次尝试级）；整回合超时由引擎的回合信号负责；
 * - 并发信号量：全局 LLM_MAX_CONCURRENCY 限流（FIFO 队列，名额移交避免惊群）。
 */
import { LlmStreamInterruptedError, abortError, isAbortError, type LlmChunk } from './provider.js'

export type LlmErrorKind = 'retryable' | 'fatal' | 'context_length'

export interface ClassifiedLlmError {
  kind: LlmErrorKind
  message: string
  status?: number
  /** 429 场景下服务端要求的退避（毫秒） */
  retryAfterMs?: number
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
])

const CONTEXT_LENGTH_HINTS = [
  'context_length_exceeded',
  'context length exceeded',
  'maximum context length',
  'too many tokens',
  'reduce the length of the messages',
]

/** 单次尝试级的超时（重试可安全覆盖：已产出内容的超时由 resilientStream 直接上抛） */
export class LlmTimeoutError extends Error {
  constructor(readonly phase: 'first-token' | 'idle') {
    super(phase === 'first-token' ? '等待模型首个响应超时' : '模型流式响应空闲超时')
    this.name = 'LlmTimeoutError'
  }
}

/** 错误分类：决定「重试 / 上抛 / 触发压缩」 */
export function classifyLlmError(err: unknown): ClassifiedLlmError {
  if (err instanceof LlmTimeoutError) return { kind: 'retryable', message: err.message }
  if (err instanceof LlmStreamInterruptedError) return { kind: 'retryable', message: err.message }
  if (isAbortError(err)) return { kind: 'fatal', message: '请求已中断' }

  const anyErr = err as { status?: unknown; code?: unknown; message?: unknown; headers?: unknown; error?: { message?: unknown } }
  const message =
    typeof anyErr?.message === 'string' && anyErr.message
      ? anyErr.message
      : typeof anyErr?.error?.message === 'string'
        ? anyErr.error.message
        : String(err)
  const status = typeof anyErr?.status === 'number' ? anyErr.status : undefined

  if (status !== undefined) {
    if (status === 429) {
      return { kind: 'retryable', status, message, retryAfterMs: parseRetryAfter(anyErr.headers, message) }
    }
    if (status === 408 || status >= 500) return { kind: 'retryable', status, message }
    if (status === 400 && CONTEXT_LENGTH_HINTS.some((h) => message.toLowerCase().includes(h))) {
      return { kind: 'context_length', status, message }
    }
    return { kind: 'fatal', status, message }
  }

  const code = typeof anyErr?.code === 'string' ? anyErr.code : ''
  if (NETWORK_CODES.has(code) || /fetch failed|network error|socket hang up|terminated/i.test(message)) {
    return { kind: 'retryable', message }
  }
  return { kind: 'fatal', message }
}

export function isContextLengthError(err: unknown): boolean {
  return classifyLlmError(err).kind === 'context_length'
}

/** Retry-After：秒数或 HTTP-date；OpenAI SDK 的 APIError.headers 可能是 Headers 或普通对象 */
function parseRetryAfter(headers: unknown, message: string): number | undefined {
  let raw: unknown
  const h = headers as { get?: (name: string) => string | null } | Record<string, unknown> | undefined
  if (h && typeof (h as { get?: unknown }).get === 'function') {
    raw = (h as { get: (name: string) => string | null }).get('retry-after')
  } else if (h) {
    raw = (h as Record<string, unknown>)['retry-after'] ?? (h as Record<string, unknown>)['Retry-After']
  }
  if (typeof raw === 'string' && raw.trim()) {
    const seconds = Number(raw)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
    const date = Date.parse(raw)
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 60_000))
  }
  // 兜底：部分网关把 retry 信息写进 message
  const match = /retry[- ]after[^0-9]*(\d+)/i.exec(message)
  if (match) return Math.min(Number(match[1]) * 1000, 60_000)
  return undefined
}

export interface RetryInfo {
  attempt: number
  delayMs: number
  reason: string
}

export interface ResilientStreamOptions {
  /** 总尝试次数（含首次），来自 LLM_MAX_RETRIES */
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs?: number
  firstTokenTimeoutMs: number
  idleTimeoutMs: number
  /** 回合信号（用户停止 / 整回合超时）：中断即上抛、不重试 */
  parentSignal?: AbortSignal
  onRetry?: (info: RetryInfo) => void
  /** 退避抖动：'full'（默认，0.5~1.0 随机）| 'none'（测试用确定性） */
  jitter?: 'full' | 'none'
}

/**
 * 带重试与超时分层的流式包装：
 * - 首个增量之前失败 → 分类后按指数退避重试（429 尊重 Retry-After）；
 * - 已产出至少一个增量后失败/超时 → 直接上抛（由引擎记录断点，供「继续生成」）；
 * - context_length → 分类结果指引上层「压缩后重试」，本层不重试。
 */
export async function* resilientStream(
  open: (signal: AbortSignal) => AsyncIterable<LlmChunk>,
  opts: ResilientStreamOptions,
): AsyncIterable<LlmChunk> {
  const maxAttempts = Math.max(1, opts.maxAttempts)
  const maxDelay = opts.maxDelayMs ?? 8_000
  let emitted = false
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptController = new AbortController()
    const onParentAbort = (): void => attemptController.abort()
    if (opts.parentSignal?.aborted) throw abortError()
    opts.parentSignal?.addEventListener('abort', onParentAbort, { once: true })

    let timedOutPhase: 'first-token' | 'idle' | undefined
    const firstTimer = setTimeout(() => {
      timedOutPhase = 'first-token'
      attemptController.abort()
    }, opts.firstTokenTimeoutMs)
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const armIdle = (): void => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOutPhase = 'idle'
        attemptController.abort()
      }, opts.idleTimeoutMs)
    }

    try {
      for await (const chunk of open(attemptController.signal)) {
        if (!emitted) {
          emitted = true
          clearTimeout(firstTimer)
        }
        armIdle()
        yield chunk
      }
      // 静默中止兜底（OpenAI SDK：abort 后「exit without throwing」）：循环正常退出也可能是
      // 被中止 / 超时的假象——退出前复核，抛回 catch 路径按「父级中断不重试 / 超时分层」统一处理
      if (opts.parentSignal?.aborted) throw abortError()
      if (timedOutPhase) throw new LlmTimeoutError(timedOutPhase)
      return
    } catch (err) {
      lastError = err
      // 父级中断（用户停止 / 整回合超时）：直接上抛，不重试
      if (opts.parentSignal?.aborted) throw err
      const classified: ClassifiedLlmError = timedOutPhase
        ? { kind: 'retryable', message: new LlmTimeoutError(timedOutPhase).message }
        : classifyLlmError(err)
      // 已产出内容：无法安全重放（会重复文本），交给上层记录断点
      if (emitted) {
        throw timedOutPhase ? new LlmTimeoutError(timedOutPhase) : err
      }
      if (classified.kind === 'context_length') throw err
      if (classified.kind !== 'retryable' || attempt >= maxAttempts) throw err
      const delay = classified.retryAfterMs ?? backoffDelay(opts.baseDelayMs, attempt, maxDelay, opts.jitter !== 'none')
      opts.onRetry?.({ attempt, delayMs: delay, reason: classified.message })
      await sleep(delay, opts.parentSignal)
    } finally {
      clearTimeout(firstTimer)
      clearTimeout(idleTimer)
      opts.parentSignal?.removeEventListener('abort', onParentAbort)
    }
  }
  throw lastError ?? new Error('LLM 流式请求失败')
}

function backoffDelay(base: number, attempt: number, max: number, jitter: boolean): number {
  const exp = Math.min(Math.max(0, base) * 2 ** (attempt - 1), max)
  return jitter ? Math.round(exp * (0.5 + Math.random() * 0.5)) : exp
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  // 竞态兜底：进入退避前父级已被中断（对已 abort 的 signal 注册监听不会补发历史事件）
  if (signal?.aborted) return Promise.reject(abortError())
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 全局并发信号量：FIFO 等待队列；release 时名额直接移交队首（active 不变） */
export class LlmSemaphore {
  private active = 0
  private readonly waiters: Array<() => void> = []

  constructor(readonly max: number) {}

  get running(): number {
    return this.active
  }

  get pending(): number {
    return this.waiters.length
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.max) {
      this.active++
      return this.onceRelease()
    }
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError())
        return
      }
      const waiter = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const idx = this.waiters.indexOf(waiter)
        if (idx >= 0) this.waiters.splice(idx, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push(waiter)
    })
    return this.onceRelease()
  }

  private onceRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) next()
      else this.active--
    }
  }
}
