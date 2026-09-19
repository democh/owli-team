/**
 * Python 桥调用器（M34 §3.2）：固定脚本 + JSON 协议（stdin 参数 / stdout 结果）。
 *
 * - 固定脚本：路径由模块定位（src 态 bridge/py/ 与构建产物 dist/py/ 同一约定），不接受外部路径；
 * - 超时：默认 30s（FINANCE_PY_TIMEOUT_MS），超时直接 kill（脚本不派生子进程）；
 * - 并发：全局信号量 1（baostock 全局登录态冲突规避，多请求自然排队）；
 * - 错误：脚本输出 {ok:false, code, message, detail} 或异常 → BridgeError（结构化错误码）；
 * - 环境：净化 env（不透传 API Key），UTF-8 IO + 北京时间。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { sanitizedEnv } from './env.js'

export type BridgeErrorCode =
  | 'NO_PYTHON'
  | 'DEP_MISSING'
  | 'LOGIN_FAIL'
  | 'TIMEOUT'
  | 'BAD_PARAM'
  | 'SOURCE_ERROR'
  | 'BRIDGE_ERROR'

export class BridgeError extends Error {
  readonly code: BridgeErrorCode
  /** 脚本侧 detail（调试信息 / traceback 摘要） */
  readonly detail: string

  constructor(code: BridgeErrorCode, message: string, detail = '') {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

export interface BridgeRunOptions {
  /** Python 解释器（缺省 'python3'；生产调用应传入探测结果中的路径） */
  python?: string
  /** 脚本路径覆盖（仅测试注入；生产固定 py/fin_bridge.py） */
  scriptPath?: string
  /** 单任务超时（毫秒，默认 30s） */
  timeoutMs?: number
  /** 外部取消信号（工具停止 → kill 并抛 TIMEOUT） */
  signal?: AbortSignal
}

export interface BridgeRunResult<T> {
  data: T
  /** 子进程耗时（毫秒） */
  ms: number
}

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 脚本定位约定：dev（src/finance/bridge/py/）与 dist（tsup onSuccess 拷贝至 dist/py/）同路径 */
export const DEFAULT_BRIDGE_SCRIPT = path.join(HERE, 'py', 'fin_bridge.py')

/** stdout 上限（防异常输出撑爆内存；正常结果 ≤ 数百 KB） */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024

/** 默认超时 */
const DEFAULT_TIMEOUT_MS = 30_000

/** 已知错误码集合（脚本输出未知码 → 归一 BRIDGE_ERROR） */
const KNOWN_CODES: readonly BridgeErrorCode[] = [
  'DEP_MISSING',
  'LOGIN_FAIL',
  'TIMEOUT',
  'BAD_PARAM',
  'SOURCE_ERROR',
  'BRIDGE_ERROR',
]

interface BridgeEnvelope {
  ok: boolean
  data?: unknown
  code?: BridgeErrorCode
  message?: string
  detail?: string
}

/**
 * 解析桥 stdout（取首尾大括号内 JSON，容忍前后杂质日志；缺 ok 字段 → null）。
 */
export function parseBridgeOutput(raw: string): BridgeEnvelope | null {
  const text = raw.trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
    if (typeof obj.ok !== 'boolean') return null
    if (obj.ok === false) {
      const rawCode = typeof obj.code === 'string' ? obj.code : ''
      const code = (KNOWN_CODES as readonly string[]).includes(rawCode) ? (rawCode as BridgeErrorCode) : 'BRIDGE_ERROR'
      return {
        ok: false,
        code,
        message: typeof obj.message === 'string' ? obj.message : '桥任务失败',
        detail: typeof obj.detail === 'string' ? obj.detail : '',
      }
    }
    return { ok: true, data: obj.data }
  } catch {
    return null
  }
}

/** 全局信号量 1：桥任务串行（baostock 登录态全局唯一） */
let chain: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/**
 * 调用桥任务：spawn 固定脚本 → stdin 写入 {params} → 收 stdout JSON → 结构化结果。
 * 成功返回 data；失败抛 BridgeError（code 供工具层转中文提示）。
 */
export async function runBridge<T = unknown>(
  task: string,
  params: Record<string, unknown> = {},
  opts: BridgeRunOptions = {},
): Promise<BridgeRunResult<T>> {
  const python = opts.python?.trim() || 'python3'
  const scriptPath = opts.scriptPath ?? DEFAULT_BRIDGE_SCRIPT
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const started = Date.now()

  return enqueue(
    () =>
      new Promise<BridgeRunResult<T>>((resolve, reject) => {
        const child = spawn(python, [scriptPath, task], {
          env: sanitizedEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
        let stdout = ''
        let stderr = ''
        let settled = false
        let timedOut = false

        const kill = (): void => {
          try {
            child.kill('SIGKILL')
          } catch {
            // 进程已退出
          }
        }
        const cleanup = (): void => {
          clearTimeout(timer)
          opts.signal?.removeEventListener('abort', onAbort)
        }
        const finish = (fn: () => void): void => {
          if (settled) return
          settled = true
          cleanup()
          fn()
        }
        const onAbort = (): void => {
          kill()
          finish(() => reject(new BridgeError('TIMEOUT', '桥任务已取消')))
        }

        const timer = setTimeout(() => {
          timedOut = true
          kill()
        }, timeoutMs)
        opts.signal?.addEventListener('abort', onAbort, { once: true })
        if (opts.signal?.aborted) {
          onAbort()
          return
        }

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString('utf8')
          if (stdout.length > MAX_OUTPUT_BYTES) {
            kill()
            finish(() => reject(new BridgeError('BRIDGE_ERROR', '桥输出超过上限（16MB）')))
          }
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8')
        })
        child.on('error', (err: NodeJS.ErrnoException) => {
          finish(() =>
            reject(
              err.code === 'ENOENT'
                ? new BridgeError('NO_PYTHON', `未找到 Python 解释器（${python}）`)
                : new BridgeError('BRIDGE_ERROR', `无法启动 Python 桥：${err.message}`),
            ),
          )
        })
        child.on('close', (exitCode: number | null) => {
          finish(() => {
            if (timedOut) {
              reject(new BridgeError('TIMEOUT', `桥任务超时（${timeoutMs}ms）：${task}`, tail(stderr)))
              return
            }
            const envelope = parseBridgeOutput(stdout)
            if (!envelope) {
              reject(
                new BridgeError(
                  'BRIDGE_ERROR',
                  `桥输出不是合法 JSON（退出码 ${exitCode ?? 'null'}）`,
                  tail(stderr) || tail(stdout),
                ),
              )
              return
            }
            if (!envelope.ok) {
              reject(new BridgeError(envelope.code ?? 'BRIDGE_ERROR', envelope.message ?? '桥任务失败', envelope.detail ?? ''))
              return
            }
            resolve({ data: envelope.data as T, ms: Date.now() - started })
          })
        })

        child.stdin?.on('error', () => undefined)
        child.stdin?.write(JSON.stringify({ params }))
        child.stdin?.end()
      }),
  )
}

/** 取文本尾部（错误详情摘要） */
function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length > max ? trimmed.slice(-max) : trimmed
}
