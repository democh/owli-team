/**
 * 结构化日志（M1）：pino + `traceId=runId`（用 childLogger 携带）。
 *
 * 双通道：
 * - stdout：人读（级别由 LOG_LEVEL 决定，测试环境默认 silent）；
 * - 文件：`data/logs/app-<YYYY-MM-DD>.log`，跨日自动换文件，保留 7 天。
 *
 * 未调用 initLogger 时（普通单测 import 链路）返回静默 logger，避免污染测试输出。
 */
import fs from 'node:fs'
import path from 'node:path'
import pino, { type Logger } from 'pino'
import type { AppConfig } from './config.js'

const RETENTION_DAYS = 7

/** 按日轮转的文件通道：写入时检查跨日，并顺带清理过期日志 */
class DailyFile {
  private stream: fs.WriteStream | undefined
  private day = ''

  constructor(
    private readonly dir: string,
    private readonly prefix = 'app',
  ) {}

  write(line: string): void {
    const day = new Date().toISOString().slice(0, 10)
    if (day !== this.day) this.roll(day)
    this.stream?.write(line)
  }

  close(): void {
    this.stream?.end()
    this.stream = undefined
    this.day = ''
  }

  private roll(day: string): void {
    this.stream?.end()
    this.stream = undefined
    this.day = day
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      this.stream = fs.createWriteStream(path.join(this.dir, `${this.prefix}-${day}.log`), { flags: 'a' })
      this.cleanup()
    } catch {
      // 日志目录不可写：退化为仅 stdout
      this.stream = undefined
    }
  }

  private cleanup(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 86_400_000
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.startsWith(`${this.prefix}-`) || !name.endsWith('.log')) continue
      const full = path.join(this.dir, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true })
      } catch {
        // 单个文件清理失败不影响其余
      }
    }
  }
}

let current: Logger = pino({ level: process.env.NODE_ENV === 'test' ? 'silent' : 'info' })
let file: DailyFile | undefined

/** 初始化（服务端入口调用一次）：stdout 按级别 + 文件全量 debug；silent 时不挂 stdout */
export function initLogger(cfg: AppConfig): Logger {
  file?.close()
  file = new DailyFile(cfg.logDir)
  const streams: pino.StreamEntry[] = []
  if (cfg.logLevel !== 'silent') streams.push({ level: cfg.logLevel, stream: process.stdout })
  streams.push({ level: 'debug', stream: { write: (line: string): void => file?.write(line) } })
  current = pino(
    { level: 'debug', base: undefined, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams, { dedupe: false }),
  )
  return current
}

export function getLogger(): Logger {
  return current
}

/** 带 traceId 的子日志器（编排层用 runId，`traceId=runId` 贯穿一次运行） */
export function childLogger(bindings: { traceId?: string; sessionId?: string; agentId?: string }): Logger {
  return current.child(bindings)
}

export function closeLogger(): void {
  file?.close()
  file = undefined
}
