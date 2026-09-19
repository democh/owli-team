/**
 * Python 环境探测（M34 §3.2）：解释器发现 → 版本 / 依赖检测 → 状态分档 + 缓存。
 *
 * - 解释器候选：显式指定优先（FINANCE_PYTHON，不做回退）→ python3 → python → py -3（Windows）；
 * - 探测脚本内联为常量（零依赖自包含，-c 执行），一次 spawn 拿到版本 + 全部包状态；
 * - 状态三档：ready（核心包齐）/ partial（部分缺）/ absent（无解释器或核心包全缺 → 全走 Node 源 A）；
 * - 缓存 10 分钟（fin_env 工具与设置面板共用；force 强制刷新）。
 */
import { execFile } from 'node:child_process'
import { sanitizedEnv } from './env.js'

export type PyEnvLevel = 'ready' | 'partial' | 'absent'

/** 核心包（全齐 → ready；全缺或无解释器 → absent） */
export const REQUIRED_PY_PACKAGES = ['baostock', 'akshare', 'pandas', 'ta', 'tablib'] as const
/** 可选包（openpyxl：tablib 的 XLSX 导出；curl_cffi：TLS 指纹反爬增强） */
export const OPTIONAL_PY_PACKAGES = ['openpyxl', 'curl_cffi'] as const

/** 最低 Python 版本（3.9：f-string / 类型语法与主流数据包要求） */
const MIN_PYTHON_VERSION = '3.9'

/** 探测缓存时长 */
const CACHE_MS = 10 * 60 * 1_000
/** 单解释器探测超时（首次 import 探测应很快；10s 已很宽松） */
const PROBE_TIMEOUT_MS = 10_000

export interface PyPackageStatus {
  installed: boolean
  version?: string
}

export interface PyEnvStatus {
  level: PyEnvLevel
  /** 探测时间戳 */
  at: number
  /** 解释器路径（absent 时缺省） */
  python?: string
  /** 解释器版本（如 3.12.4） */
  version?: string
  /** 包状态表（键 = 包名） */
  packages: Record<string, PyPackageStatus>
  /** 缺失的核心包（供安装引导） */
  missing: string[]
  /** 中文摘要（fin_env 工具 / 设置面板展示） */
  summary: string
}

/** 探测输出（探测脚本的 stdout JSON 形状） */
export interface RawProbe {
  python: string
  version: string
  packages: Record<string, PyPackageStatus>
}

/** 内联探测脚本：输出版本 + 包状态 JSON（importlib 检测，不 import 重型包本体） */
const PROBE_SCRIPT = `
import json, sys
try:
    import importlib.metadata as md
except Exception:
    md = None
import importlib.util as iu

names = ${JSON.stringify([...REQUIRED_PY_PACKAGES, ...OPTIONAL_PY_PACKAGES])}

def version(name):
    if md is None:
        return None
    try:
        return md.version(name)
    except Exception:
        return None

def installed(name):
    try:
        return iu.find_spec(name) is not None
    except Exception:
        return False

out = {
    "python": sys.executable,
    "version": ".".join(map(str, sys.version_info[:3])),
    "packages": {n: {"installed": installed(n), "version": version(n)} for n in names},
}
sys.stdout.write(json.dumps(out))
`

let cache: PyEnvStatus | null = null

/** 测试辅助：清空探测缓存 */
export function resetProbeCache(): void {
  cache = null
}

/** 语义化版本比较（仅取数字段；a >= min 返回 true） */
function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map((s) => Number.parseInt(s, 10) || 0)
  const b = min.split('.').map((s) => Number.parseInt(s, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return true
}

/** 解析探测脚本输出（非 JSON / 缺字段 → null） */
export function parseProbeJson(raw: string): RawProbe | null {
  const text = raw.trim()
  if (!text.startsWith('{')) return null
  try {
    const obj = JSON.parse(text) as { python?: unknown; version?: unknown; packages?: unknown }
    if (typeof obj.python !== 'string' || typeof obj.version !== 'string') return null
    if (typeof obj.packages !== 'object' || obj.packages === null) return null
    const packages: Record<string, PyPackageStatus> = {}
    for (const [name, value] of Object.entries(obj.packages as Record<string, { installed?: unknown; version?: unknown }>)) {
      packages[name] = {
        installed: value?.installed === true,
        version: typeof value?.version === 'string' ? value.version : undefined,
      }
    }
    return { python: obj.python, version: obj.version, packages }
  } catch {
    return null
  }
}

/** 探测结果 → 状态分档（纯函数，供测试） */
export function buildStatus(raw: RawProbe): PyEnvStatus {
  const missing = REQUIRED_PY_PACKAGES.filter((name) => !raw.packages[name]?.installed)
  const level: PyEnvLevel =
    missing.length === 0 ? 'ready' : missing.length === REQUIRED_PY_PACKAGES.length ? 'absent' : 'partial'
  return {
    level,
    at: Date.now(),
    python: raw.python,
    version: raw.version,
    packages: raw.packages,
    missing,
    summary: summarize(level, raw.version, raw.python, missing),
  }
}

function summarize(level: PyEnvLevel, version: string, python: string, missing: readonly string[]): string {
  if (level === 'absent') {
    return '未检测到可用 Python 环境（无解释器或核心包全缺），金融数据将使用 Node 数据源'
  }
  if (level === 'partial') {
    return `Python ${version} 可用（${python}），缺少核心包：${missing.join(' / ')}（对应能力降级到 Node 源）`
  }
  return `Python ${version} 就绪（${python}），核心包齐备`
}

/** 无 Python 环境的降级状态 */
function absentStatus(): PyEnvStatus {
  return {
    level: 'absent',
    at: Date.now(),
    packages: {},
    missing: [...REQUIRED_PY_PACKAGES],
    summary: '未检测到可用 Python 环境（无解释器或核心包全缺），金融数据将使用 Node 数据源',
  }
}

interface Interpreter {
  cmd: string
  preArgs: string[]
}

/** 解释器候选：显式指定优先（不做回退——用户明确指定的解释器失败即视为 absent） */
function interpreterCandidates(explicit?: string): Interpreter[] {
  const override = explicit?.trim()
  if (override) return [{ cmd: override, preArgs: [] }]
  const list: Interpreter[] = [{ cmd: 'python3', preArgs: [] }]
  if (process.platform === 'win32') {
    list.push({ cmd: 'python', preArgs: [] })
    list.push({ cmd: 'py', preArgs: ['-3'] })
  } else {
    list.push({ cmd: 'python', preArgs: [] })
  }
  return list
}

/** 执行解释器（收集 stdout/stderr；超时/不存在 → reject） */
function execPython(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, env: sanitizedEnv() },
      (err, stdout) => {
        if (err) reject(err)
        else resolve({ stdout: String(stdout) })
      },
    )
  })
}

/**
 * 探测 Python 环境：遍历候选解释器直到拿到合法探测输出；全部失败 → absent。
 * 结果缓存 10 分钟（force 强制刷新，如安装完成后）。
 */
export async function probePython(
  opts: { python?: string; force?: boolean; timeoutMs?: number } = {},
): Promise<PyEnvStatus> {
  if (!opts.force && cache && Date.now() - cache.at < CACHE_MS) return cache
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS
  for (const interpreter of interpreterCandidates(opts.python)) {
    try {
      const { stdout } = await execPython(interpreter.cmd, [...interpreter.preArgs, '-c', PROBE_SCRIPT], timeoutMs)
      const raw = parseProbeJson(stdout)
      if (!raw || !versionAtLeast(raw.version, MIN_PYTHON_VERSION)) continue
      cache = buildStatus(raw)
      return cache
    } catch {
      // 解释器不可用（ENOENT / 超时 / 非零退出）→ 尝试下一个候选
    }
  }
  cache = absentStatus()
  return cache
}
