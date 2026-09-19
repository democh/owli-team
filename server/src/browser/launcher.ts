/**
 * 浏览器启动 / 接入（M22）：managed（自启临时 Profile）/ local（本机 Chrome 专用持久 Profile）
 * / remote（接入任意 CDP 端点）/ open（系统默认浏览器打开链接）。
 * 启动形态（无头 / 打开窗口）由 headless 选项决定（缺省无头，见 BROWSER_HEADLESS）。
 *
 * 关键技术点：
 * - Chrome 136+ 起，默认 user-data-dir 不允许开调试端口（Chromium issue 417456892），
 *   全部自启必须显式 `--user-data-dir`（managed=临时目录，local=data 下持久目录）；
 * - `--remote-debugging-port=0`（内核分配端口），通过 DevToolsActivePort 文件 + stderr
 *   "DevTools listening on ..." 双路确认端点；
 * - local 模式先复用已有实例（DevToolsActivePort + /json/version 探测），避免重复开窗；
 * - 进程管理：仅清理「本进程 spawn 的」浏览器（external 复用实例不动）。
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { BrowserBackend } from '@multi-agent/shared'
import { getLogger } from '../logger.js'
import { discoverExecutables, isExecutableFile, probeEndpoint, readDevToolsActivePort } from './discover.js'

export interface LaunchOptions {
  backend: BrowserBackend
  /** 持久 Profile 目录（local 模式；managed 为其下临时子目录） */
  profileRoot: string
  /** 显式可执行文件（空 = 自动发现） */
  executable?: string
  headless?: boolean
  viewport?: { width: number; height: number }
  /** 启动后首个页面 URL（默认 about:blank） */
  startUrl?: string
  /** 等待调试端点的超时（ms） */
  timeoutMs?: number
}

export interface LaunchResult {
  endpoint: string
  backend: BrowserBackend
  pid?: number
  profileDir?: string
  executable?: string
  /** true = 复用了已运行的实例（进程不归本进程管理） */
  external: boolean
  /** 本进程 spawn 的进程句柄（external 时为 undefined） */
  child?: ChildProcess
  version?: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 解析可用浏览器可执行文件（显式配置优先；无命中给出可操作的中文错误） */
export async function resolveExecutable(explicit?: string): Promise<string> {
  if (explicit) {
    if (isExecutableFile(explicit)) return path.resolve(explicit)
    throw new Error(`配置的浏览器可执行文件不可用：${explicit}（请检查路径与执行权限）`)
  }
  const found = await discoverExecutables()
  if (found.length === 0) {
    throw new Error('未发现可用的 Chrome / Chromium / Edge：请在连接设置中手动指定浏览器路径（BROWSER_EXECUTABLE）')
  }
  return found[0]!.path
}

/** local 模式：复用已有实例（DevToolsActivePort → /json/version 验证） */
export async function findExistingLocal(profileDir: string): Promise<string | undefined> {
  const active = readDevToolsActivePort(profileDir)
  if (!active?.wsPath) return undefined
  const probed = await probeEndpoint(active.port, 600)
  return probed?.url
}

/** 清掉上次运行遗留的 DevToolsActivePort：Chrome 被强杀时不清理该文件，误读会连到过期端口 */
function removeStaleActivePort(profileDir: string): void {
  try {
    fs.rmSync(path.join(profileDir, 'DevToolsActivePort'), { force: true })
  } catch {
    // 忽略：删除失败也无碍——waitForEndpoint 仍需探测通过才会返回
  }
}

function buildArgs(opts: { profileDir: string; headless: boolean; viewport: { width: number; height: number }; startUrl: string }): string[] {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${opts.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--disable-background-networking',
    '--disable-component-update',
    '--mute-audio',
    '--hide-scrollbars',
    `--window-size=${opts.viewport.width},${opts.viewport.height}`,
  ]
  if (opts.headless) {
    args.push('--headless=new', '--disable-gpu', '--disable-dev-shm-usage')
  }
  args.push(opts.startUrl)
  return args
}

/** 等待 DevToolsActivePort / stderr 任一确认端点可用 */
async function waitForEndpoint(
  child: ChildProcess,
  profileDir: string,
  stderrBuffer: { url?: string },
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (stderrBuffer.url) {
      const probed = stderrBuffer.url
      return probed
    }
    const active = readDevToolsActivePort(profileDir)
    if (active?.wsPath) {
      // /json/version 确认真实可达后再返回：既覆盖「文件已写、监听未就绪」的窗口，
      // 也防止历史运行残留的过期端口被误当端点（此时继续等待新实例覆写文件）
      const probed = await probeEndpoint(active.port, 600)
      if (probed?.url) return probed.url
    }
    if (child.exitCode !== null) {
      throw new Error(`浏览器进程提前退出（code=${child.exitCode}）：请检查可执行文件路径与 Profile 目录权限`)
    }
    await sleep(150)
  }
  throw new Error(`等待浏览器调试端点超时（${timeoutMs}ms）：调试端口未就绪（DevToolsActivePort 缺失或不可达）`)
}

/**
 * 启动或接入浏览器（managed / local）。
 * local：优先复用已有实例；否则按 headless 选项启动专用持久 Profile。
 * managed：启动临时 Profile（每次独立，历史不残留）。
 */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchResult> {
  const logger = getLogger()
  const timeoutMs = opts.timeoutMs ?? 20_000
  const viewport = opts.viewport ?? { width: 1280, height: 800 }
  const startUrl = opts.startUrl ?? 'about:blank'

  if (opts.backend === 'local') {
    const persistent = path.join(opts.profileRoot, 'local')
    fs.mkdirSync(persistent, { recursive: true })
    const existing = await findExistingLocal(persistent)
    if (existing) {
      logger.info({ endpoint: existing }, '复用已运行的本地浏览器实例')
      return { endpoint: existing, backend: 'local', profileDir: persistent, external: true }
    }
    // 复用失败：清掉残留端口文件再启动，保证后续读到的端点必属新实例
    removeStaleActivePort(persistent)
    const executable = await resolveExecutable(opts.executable)
    const child = spawn(
      executable,
      buildArgs({ profileDir: persistent, headless: Boolean(opts.headless), viewport, startUrl }),
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    )
    const stderrBuffer: { url?: string } = {}
    child.stderr?.on('data', (chunk: Buffer) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk.toString())
      if (match?.[1]) stderrBuffer.url = match[1]
    })
    try {
      const endpoint = await waitForEndpoint(child, persistent, stderrBuffer, timeoutMs)
      logger.info({ endpoint, pid: child.pid }, '本地浏览器已启动（专用持久 Profile）')
      return {
        endpoint,
        backend: 'local',
        pid: child.pid,
        profileDir: persistent,
        executable,
        external: false,
        child,
      }
    } catch (err) {
      try {
        child.kill('SIGTERM')
      } catch {
        // 忽略
      }
      throw err
    }
  }

  // managed：启动临时 Profile
  fs.mkdirSync(opts.profileRoot, { recursive: true })
  const tempDir = fs.mkdtempSync(path.join(opts.profileRoot, 'managed-'))
  const executable = await resolveExecutable(opts.executable)
  const child = spawn(
    executable,
    buildArgs({ profileDir: tempDir, headless: opts.headless ?? true, viewport, startUrl }),
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
  )
  const stderrBuffer: { url?: string } = {}
  child.stderr?.on('data', (chunk: Buffer) => {
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk.toString())
    if (match?.[1]) stderrBuffer.url = match[1]
  })
  try {
    const endpoint = await waitForEndpoint(child, tempDir, stderrBuffer, timeoutMs)
    logger.info({ endpoint, pid: child.pid, tempDir, headless: opts.headless ?? true }, 'managed 浏览器已启动（临时 Profile）')
    return {
      endpoint,
      backend: 'managed',
      pid: child.pid,
      profileDir: tempDir,
      executable,
      external: false,
      child,
    }
  } catch (err) {
    try {
      child.kill('SIGTERM')
    } catch {
      // 忽略
    }
    throw err
  }
}

/** 关闭本进程 spawn 的浏览器（external 复用实例不动） */
export function killLaunchedBrowser(child: ChildProcess | undefined): void {
  if (!child || child.exitCode !== null || child.killed) return
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {
          // 忽略
        }
      }
    }, 3_000).unref?.()
  } catch {
    // 忽略
  }
}

/** 用系统默认浏览器打开链接（严格限定 http/https；argv 直传不经 shell） */
export async function openInSystemBrowser(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error(`非法链接：${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`仅支持用系统浏览器打开 http/https 链接（当前：${parsed.protocol}）`)
  }
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [parsed.toString()]]
      : process.platform === 'win32'
        ? ['explorer.exe', [parsed.toString()]]
        : ['xdg-open', [parsed.toString()]]
  await new Promise<void>((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000, windowsHide: true }, (err) => {
      if (err) reject(new Error(`打开系统浏览器失败：${err.message}`))
      else resolve()
    })
  })
}
