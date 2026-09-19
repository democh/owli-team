/**
 * SSH 连接器（M23）：ssh2 封装 —— 认证解析 / 连接建立 / 一次性命令执行 / 交互式 shell。
 *
 * 设计：
 * - 认证三种方式（password / key / agent）；私钥支持「文件路径」（服务端读取）或「粘贴内容」（secret）；
 * - 可测试性：client 工厂可注入（测试注入 fake，不依赖真实 SSH 服务）；
 * - 输出收集带字节上限（防大输出拖垮内存），超时强杀通道。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Client } from 'ssh2'
import type { ClientChannel, ConnectConfig } from 'ssh2'
import type { SshAuthMethod, SshExecResultDto } from '@multi-agent/shared'
import { cfgNumber, cfgString } from '../db/types.js'

const DEFAULT_READY_TIMEOUT_MS = 20_000
const DEFAULT_KEEPALIVE_MS = 15_000

/** 展开 ~ 为用户主目录（私钥路径便捷输入） */
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** 连接 config / secret → ssh2 ConnectConfig（认证方式缺失或凭据不全时抛中文错误） */
export function resolveConnectConfig(
  config: Record<string, unknown>,
  secret: Record<string, unknown>,
): ConnectConfig {
  const host = cfgString(config, 'host') ?? '127.0.0.1'
  const port = Math.trunc(cfgNumber(config, 'port', 22))
  const username = cfgString(config, 'username')
  if (!username) throw new Error('缺少用户名：SSH 连接需要登录账号')
  const base: ConnectConfig = {
    host,
    port,
    username,
    readyTimeout: cfgNumber(config, 'readyTimeoutMs', DEFAULT_READY_TIMEOUT_MS),
    keepaliveInterval: cfgNumber(config, 'keepaliveIntervalMs', DEFAULT_KEEPALIVE_MS),
  }
  const authMethod = (cfgString(config, 'authMethod') ?? 'password') as SshAuthMethod
  if (authMethod === 'password') {
    const password = typeof secret.password === 'string' && secret.password ? secret.password : undefined
    if (!password) throw new Error('缺少密码凭据：请填写并保存密码后重试')
    return { ...base, password }
  }
  if (authMethod === 'key') {
    const inline =
      typeof secret.privateKey === 'string' && secret.privateKey.trim() ? secret.privateKey : undefined
    const keyPath = cfgString(config, 'privateKeyPath')
    if (!inline && !keyPath) throw new Error('缺少私钥：请填写私钥文件路径（或粘贴私钥内容）后重试')
    let keyData: Buffer
    if (inline) {
      keyData = Buffer.from(inline)
    } else {
      const expanded = expandHome(keyPath!)
      if (!fs.existsSync(expanded)) throw new Error(`私钥文件不存在：${expanded}`)
      keyData = fs.readFileSync(expanded)
    }
    const passphrase =
      typeof secret.passphrase === 'string' && secret.passphrase ? secret.passphrase : undefined
    return { ...base, privateKey: keyData, passphrase }
  }
  if (authMethod === 'agent') {
    const agent = process.env.SSH_AUTH_SOCK
    if (!agent) throw new Error('未检测到 SSH Agent（SSH_AUTH_SOCK 为空）：请改用密码 / 私钥认证')
    return { ...base, agent }
  }
  throw new Error(`未知认证方式：${authMethod}（可选 password / key / agent）`)
}

/** client 工厂（测试注入 fake；生产为 ssh2.Client） */
export type SshClientFactory = () => Client

/** 建立连接（ready 时 resolve；error / 超时 reject；就绪前的 close 视为失败） */
export function connectClient(factory: SshClientFactory, config: ConnectConfig): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = factory()
    const timeoutMs = (config.readyTimeout ?? DEFAULT_READY_TIMEOUT_MS) + 1_000
    const timer = setTimeout(() => {
      client.destroy()
      reject(new Error(`SSH 连接超时（${timeoutMs}ms）：请检查主机 / 端口 / 网络可达性`))
    }, timeoutMs)
    timer.unref?.()
    const fail = (err: Error): void => {
      clearTimeout(timer)
      reject(err)
    }
    client.on('ready', () => {
      clearTimeout(timer)
      resolve(client)
    })
    client.on('error', (err: Error) => fail(err))
    client.on('close', () => fail(new Error('SSH 连接在就绪前被关闭')))
    client.connect(config)
  })
}

export interface ExecOptions {
  timeoutMs: number
  /** 输出字节上限（stdout + stderr 合计；超出截断） */
  maxBytes: number
}

/** 在已就绪的 client 上执行一次性命令（输出收集 + 截断 + 超时强杀通道） */
export function execCommand(client: Client, command: string, opts: ExecOptions): Promise<SshExecResultDto> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    client.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      let stdout = ''
      let stderr = ''
      let bytes = 0
      let truncated = false
      let exitCode: number | null = null
      let exitSignal: string | undefined
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          stream.close()
        } catch {
          // 通道可能已关闭：忽略
        }
        reject(new Error(`命令执行超时（${opts.timeoutMs}ms），已强制终止通道`))
      }, opts.timeoutMs)
      timer.unref?.()

      const append = (chunk: Buffer | string, target: 'stdout' | 'stderr'): void => {
        const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        bytes += Buffer.byteLength(text)
        if (bytes > opts.maxBytes) {
          truncated = true
          return
        }
        if (target === 'stdout') stdout += text
        else stderr += text
      }
      stream.on('data', (chunk: Buffer) => append(chunk, 'stdout'))
      stream.stderr.on('data', (chunk: Buffer) => append(chunk, 'stderr'))
      stream.on('exit', (code: number | null, signal?: string) => {
        exitCode = code
        exitSignal = signal ?? undefined
      })
      stream.on('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({
          stdout,
          stderr,
          code: exitCode,
          signal: exitSignal,
          durationMs: Date.now() - started,
          truncated,
        })
      })
      stream.on('error', (streamErr: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(streamErr)
      })
    })
  })
}

export interface ShellOpenOptions {
  cols: number
  rows: number
  term?: string
}

/** 打开交互式 shell（PTY；终端面板专用，调用方持有 client 生命周期） */
export function openShell(client: Client, opts: ShellOpenOptions): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    const cols = Math.max(Math.trunc(opts.cols) || 80, 20)
    const rows = Math.max(Math.trunc(opts.rows) || 24, 5)
    client.shell(
      { term: opts.term ?? 'xterm-256color', cols, rows, width: cols * 8, height: rows * 16 },
      (err, stream) => {
        if (err) reject(err)
        else resolve(stream)
      },
    )
  })
}

/** 调整 PTY 窗口（注意 ssh2 setWindow 参数序：rows, cols, height, width） */
export function resizeShell(stream: ClientChannel, cols: number, rows: number): void {
  try {
    const c = Math.max(Math.trunc(cols) || 80, 20)
    const r = Math.max(Math.trunc(rows) || 24, 5)
    stream.setWindow(r, c, r * 16, c * 8)
  } catch {
    // 通道已关闭：忽略
  }
}
