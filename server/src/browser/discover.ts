/**
 * 浏览器自动发现（M22）：可执行文件探测链 + 活跃调试端点探测 + DevToolsActivePort 解析。
 *
 * 背景约束（Chrome 136+，Chromium issue 417456892）：
 * - 官方禁止对「默认 user-data-dir」开启远程调试端口：启动普通用户 Profile 的调试端口已不可行；
 * - 唯一受支持方式 = 显式 `--user-data-dir=<专用目录>`，因此本项目所有自启均使用专用 Profile
 *   （managed：临时目录；local：data 下持久目录，登录态可留存）；
 * - `--remote-debugging-port=0` 时端口由内核分配并写入 `<user-data-dir>/DevToolsActivePort`
 *   （首行=端口号，次行=/devtools/browser/<id>），与 stderr 的 "DevTools listening on ..." 双路确认。
 *
 * 安全：
 * - 端点探测仅允许 127.0.0.1 回环地址（不扫描局域网 / 公网）；
 * - 可执行检测走 fs.existsSync + 可执行位（不执行任何用户输入拼接的命令）。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DiscoveredExecutable {
  path: string
  name: string
  version?: string
}

export interface DiscoveredEndpoint {
  port: number
  url: string
  browser?: string
}

/** 活跃调试端点探测端口（仅回环） */
const DEFAULT_PORTS = [9222, 9223]

function candidatePaths(): Array<{ path: string; name: string }> {
  const home = os.homedir()
  const out: Array<{ path: string; name: string }> = []
  if (process.platform === 'darwin') {
    const apps = [
      ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Google Chrome'],
      ['Chromium.app/Contents/MacOS/Chromium', 'Chromium'],
      ['Microsoft Edge.app/Contents/MacOS/Microsoft Edge', 'Microsoft Edge'],
      ['Brave Browser.app/Contents/MacOS/Brave Browser', 'Brave'],
      ['Arc.app/Contents/MacOS/Arc', 'Arc'],
    ] as const
    for (const [rel, name] of apps) {
      out.push({ path: `/Applications/${rel}`, name })
      out.push({ path: path.join(home, 'Applications', rel), name })
    }
  } else if (process.platform === 'win32') {
    const locals = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
    for (const root of locals) {
      if (!root) continue
      out.push({ path: path.join(root, 'Google/Chrome/Application/chrome.exe'), name: 'Google Chrome' })
      out.push({ path: path.join(root, 'Microsoft/Edge/Application/msedge.exe'), name: 'Microsoft Edge' })
      out.push({ path: path.join(root, 'Chromium/Application/chrome.exe'), name: 'Chromium' })
    }
  } else {
    const bins = [
      ['/usr/bin/google-chrome', 'Google Chrome'],
      ['/usr/bin/google-chrome-stable', 'Google Chrome'],
      ['/usr/bin/chromium', 'Chromium'],
      ['/usr/bin/chromium-browser', 'Chromium'],
      ['/snap/bin/chromium', 'Chromium'],
      ['/usr/bin/microsoft-edge', 'Microsoft Edge'],
      ['/usr/bin/brave-browser', 'Brave'],
    ] as const
    for (const [p, name] of bins) out.push({ path: p, name })
  }
  return out
}

/** Playwright 下载的 Chromium 缓存（开发机常见，兜底可选） */
function playwrightCandidates(): Array<{ path: string; name: string }> {
  const roots =
    process.platform === 'darwin'
      ? [path.join(os.homedir(), 'Library/Caches/ms-playwright')]
      : process.platform === 'win32'
        ? [path.join(process.env.LOCALAPPDATA ?? '', 'ms-playwright')]
        : [path.join(os.homedir(), '.cache/ms-playwright')]
  const out: Array<{ path: string; name: string }> = []
  for (const root of roots) {
    let entries: string[] = []
    try {
      entries = fs.readdirSync(root).filter((e) => e.startsWith('chromium'))
    } catch {
      continue
    }
    entries.sort()
    for (const entry of entries) {
      const base = path.join(root, entry)
      const rel =
        process.platform === 'darwin'
          ? 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
          : process.platform === 'win32'
            ? 'chrome-win/chrome.exe'
            : 'chrome-linux/chrome'
      out.push({ path: path.join(base, rel), name: `Playwright ${entry}` })
    }
  }
  return out
}

export function isExecutableFile(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return false
    if (process.platform === 'win32') return true
    fs.accessSync(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 版本探测（`--version`，3s 超时；失败返回 undefined，不影响主流程） */
export async function probeExecutableVersion(execPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(execPath, ['--version'], { timeout: 3_000, windowsHide: true })
    const line = stdout.trim().split('\n')[0]?.trim()
    return line || undefined
  } catch {
    return undefined
  }
}

/**
 * 可执行文件发现：显式配置 → 环境变量（CHROME_PATH）→ 平台常见路径 → Playwright 缓存。
 * 去重（真实路径相同只留一条），版本探测串行执行（避免一次拉起多个进程）。
 */
export async function discoverExecutables(explicit?: string): Promise<DiscoveredExecutable[]> {
  const seen = new Set<string>()
  const candidates: Array<{ path: string; name: string }> = []
  const push = (p: string | undefined, name: string): void => {
    if (!p) return
    const resolved = path.resolve(p)
    if (seen.has(resolved)) return
    seen.add(resolved)
    candidates.push({ path: resolved, name })
  }

  push(explicit, '自定义')
  push(process.env.CHROME_PATH, 'CHROME_PATH')
  for (const c of candidatePaths()) push(c.path, c.name)
  for (const c of playwrightCandidates()) push(c.path, c.name)

  const hits = candidates.filter((c) => isExecutableFile(c.path))
  const out: DiscoveredExecutable[] = []
  for (const hit of hits.slice(0, 6)) {
    out.push({ path: hit.path, name: hit.name, version: await probeExecutableVersion(hit.path) })
  }
  return out
}

/** 探测单个回环端口上的调试端点（GET /json/version） */
export async function probeEndpoint(port: number, timeoutMs = 800): Promise<DiscoveredEndpoint | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return undefined
    const data = (await res.json()) as { Browser?: string; webSocketDebuggerUrl?: string }
    if (!data.webSocketDebuggerUrl) return undefined
    return { port, url: data.webSocketDebuggerUrl, browser: data.Browser }
  } catch {
    return undefined
  }
}

/** 扫描活跃调试端点（仅 127.0.0.1 的常见端口） */
export async function discoverEndpoints(ports: number[] = DEFAULT_PORTS): Promise<DiscoveredEndpoint[]> {
  const results = await Promise.all(ports.map((p) => probeEndpoint(p)))
  return results.filter((r): r is DiscoveredEndpoint => Boolean(r))
}

/** 读取 DevToolsActivePort（首行端口，次行 browser ws 路径） */
export function readDevToolsActivePort(profileDir: string): { port: number; wsPath: string } | undefined {
  try {
    const raw = fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8')
    const [portLine, pathLine] = raw.split('\n')
    const port = Number(portLine?.trim())
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) return undefined
    return { port, wsPath: pathLine?.trim() ?? '' }
  } catch {
    return undefined
  }
}
