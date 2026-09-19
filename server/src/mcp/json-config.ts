/**
 * M28：MCP JSON 直配（mcp.json —— 生态标准 `mcpServers` 格式，Claude Desktop / Claude Code 配置可直接拷贝）。
 *
 * - 文件权威：启动同步（先于 MCP_SERVERS env 种子）→ mtime 轮询（MCP_CONFIG_POLL_MS，0=关闭）→ API 手动同步；
 * - upsert：新增 → 创建（source='json'）+ 连接；变更（transport / config / enabled / secret 解密后深比较）→ 更新 + 重连；
 * - 删除：文件成功解析且缺失的 source='json' 服务器 → 断开 + 移除（session_mcp_servers 双 FK 级联解绑）；
 * - 防误删：JSON 解析失败 / mcpServers 结构非法 → 整次同步跳过（绝不删库）；条目级失败不影响其他条目，
 *   且「文件中声明过但解析失败」的名字仍保留（不触发删除）；
 * - 变量的字符串 `${VAR}` / `${VAR:-default}` 展开（args / env / url / headers / cwd）；未定义且无默认 → 条目跳过；
 * - secret（stdio env / http headers）走 SecretVault（与路由相同的拆分通道），对外视图保持脱敏。
 */
import fs from 'node:fs'
import type {
  McpJsonImportOutcome,
  McpJsonStatus,
  McpJsonSyncResult,
  McpJsonSyncSummary,
  McpServerConfig,
  McpTransportKind,
} from '@multi-agent/shared'
import { getLogger } from '../logger.js'
import type { McpServerStore } from '../store/mcp-servers.js'
import { nowIso } from '../store/sessions.js'
import type { McpRuntimeManager } from './manager.js'
import { isValidMcpSlug } from './naming.js'

// ---------- 解析（纯函数，测试友好） ----------

export interface McpJsonEntry {
  name: string
  displayName?: string
  transport: McpTransportKind
  config: McpServerConfig
  secret: Record<string, unknown> | null
  enabled: boolean
}

export interface McpJsonParseResult {
  /** false = 整次不可用（JSON 语法 / mcpServers 结构非法）→ 调用方必须跳过同步（绝不删库） */
  ok: boolean
  entries: McpJsonEntry[]
  /** mcpServers 中出现过的全部合法 slug 名（含解析失败的条目；删除判定的白名单，防误删） */
  declaredNames: string[]
  errors: string[]
  warnings: string[]
}

/** `${VAR}` / `${VAR:-default}` */
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g

/** 展开字符串中的环境变量（未定义且无默认 → 记入 missing） */
export function expandVars(input: string, env: NodeJS.ProcessEnv, missing: Set<string>): string {
  return input.replace(VAR_RE, (_match, name: string, fallback?: string) => {
    const value = env[name]
    if (value !== undefined && value !== '') return value
    if (fallback !== undefined) return fallback
    missing.add(name)
    return _match
  })
}

/** 已知字段（其余忽略 + 告警） */
const ENTRY_KEYS = new Set([
  'command',
  'args',
  'env',
  'cwd',
  'url',
  'headers',
  'type',
  'timeoutMs',
  'approvalPolicy',
  'readOnlyOverride',
  'enabled',
  'displayName',
  'eagerLoad',
])

/** 展开用的字符串字段集合（命令本身不展开，避免注入误用） */
function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === 'string')
  )
}

/** 单条目解析（失败返回 undefined 并写入 errors） */
function parseEntry(
  name: string,
  raw: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): McpJsonEntry | undefined {
  const fail = (message: string): undefined => {
    errors.push(`服务器「${name}」：${message}，已跳过`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!ENTRY_KEYS.has(key)) warnings.push(`服务器「${name}」未知字段 ${key} 已忽略`)
  }

  // 传输判定（显式 type 优先；缺省按 command / url 推断）
  const type = typeof raw.type === 'string' ? raw.type : undefined
  if (type && type !== 'stdio' && type !== 'http' && type !== 'streamable-http') {
    return fail(`传输类型 ${type} 暂不支持（仅 stdio / http）`)
  }
  const hasCommand = typeof raw.command === 'string' && raw.command.length > 0
  const hasUrl = typeof raw.url === 'string' && raw.url.length > 0
  let transport: McpTransportKind
  if (type === 'stdio') {
    if (!hasCommand) return fail('stdio 缺少 command')
    transport = 'stdio'
  } else if (type === 'http' || type === 'streamable-http') {
    if (!hasUrl) return fail('http 缺少 url')
    transport = 'http'
  } else if (hasCommand && hasUrl) {
    return fail('同时声明 command 与 url 无法判定传输方式（请用 type 明确）')
  } else if (hasCommand) {
    transport = 'stdio'
  } else if (hasUrl) {
    transport = 'http'
  } else {
    return fail('缺少 command（stdio）或 url（http）')
  }

  const missing = new Set<string>()
  const config: McpServerConfig = {}
  const secret: Record<string, unknown> = {}

  if (transport === 'stdio') {
    config.command = raw.command as string
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every((arg) => typeof arg === 'string')) {
        return fail('args 必须是字符串数组')
      }
      config.args = (raw.args as string[]).map((arg) => expandVars(arg, env, missing))
    }
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string') return fail('cwd 必须是字符串')
      config.cwd = expandVars(raw.cwd, env, missing)
    }
    if (raw.env !== undefined) {
      if (!isStringRecord(raw.env)) return fail('env 必须是字符串键值对')
      const expanded: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw.env)) expanded[key] = expandVars(value, env, missing)
      secret.env = expanded
    }
  } else {
    if (raw.url !== undefined && typeof raw.url !== 'string') return fail('url 必须是字符串')
    config.url = expandVars(raw.url as string, env, missing)
    if (!/^https?:\/\//.test(config.url)) return fail('url 需以 http:// 或 https:// 开头')
    if (raw.headers !== undefined) {
      if (!isStringRecord(raw.headers)) return fail('headers 必须是字符串键值对')
      const expanded: Record<string, string> = {}
      for (const [key, value] of Object.entries(raw.headers)) expanded[key] = expandVars(value, env, missing)
      secret.headers = expanded
    }
  }

  if (missing.size > 0) {
    const names = [...missing].join('、')
    return fail(`引用了未定义变量 ${names}（可用 \${VAR:-默认值} 提供缺省）`)
  }

  if (raw.timeoutMs !== undefined) {
    const timeoutMs = raw.timeoutMs
    if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 600_000) {
      return fail('timeoutMs 需为 1000-600000 的整数（毫秒）')
    }
    config.timeoutMs = timeoutMs
  }
  if (raw.approvalPolicy !== undefined) {
    if (raw.approvalPolicy !== 'risky' && raw.approvalPolicy !== 'always' && raw.approvalPolicy !== 'never') {
      return fail('approvalPolicy 需为 risky / always / never')
    }
    config.approvalPolicy = raw.approvalPolicy
  }
  if (raw.readOnlyOverride !== undefined) {
    if (raw.readOnlyOverride !== 'auto' && raw.readOnlyOverride !== 'readonly' && raw.readOnlyOverride !== 'write') {
      return fail('readOnlyOverride 需为 auto / readonly / write')
    }
    config.readOnlyOverride = raw.readOnlyOverride
  }
  if (raw.eagerLoad !== undefined) {
    if (typeof raw.eagerLoad !== 'boolean') return fail('eagerLoad 需为布尔值')
    config.eagerLoad = raw.eagerLoad
  }
  if (raw.displayName !== undefined && typeof raw.displayName !== 'string') return fail('displayName 必须是字符串')

  return {
    name,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined,
    transport,
    config,
    secret: Object.keys(secret).length > 0 ? secret : null,
    enabled: raw.enabled === false ? false : true,
  }
}

/**
 * 解析 mcp.json 文本。
 * ok=false 仅当整体不可用（JSON 语法错误 / mcpServers 非对象）——调用方据此跳过同步；
 * 条目级问题进 errors（该条目跳过），declaredNames 仍保留其名字（防误删）。
 */
export function parseMcpJsonText(text: string, env: NodeJS.ProcessEnv = process.env): McpJsonParseResult {
  const empty: McpJsonParseResult = { ok: false, entries: [], declaredNames: [], errors: [], warnings: [] }
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (err) {
    return { ...empty, errors: [`JSON 解析失败：${(err as Error).message}`] }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    return { ...empty, errors: ['配置根节点必须是对象'] }
  }
  const servers = (root as Record<string, unknown>).mcpServers
  if (servers === undefined) {
    return { ...empty, errors: ['缺少 mcpServers 字段（格式：{ "mcpServers": { "<名称>": { ... } } }）'] }
  }
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { ...empty, errors: ['mcpServers 必须是对象'] }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const entries: McpJsonEntry[] = []
  const declaredNames: string[] = []
  for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
    if (!isValidMcpSlug(name)) {
      errors.push(`服务器名「${name}」非法（需为小写 slug：^[a-z][a-z0-9-]{0,39}$，将作为工具名前缀），已跳过`)
      continue
    }
    declaredNames.push(name)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`服务器「${name}」配置必须是对象，已跳过`)
      continue
    }
    const entry = parseEntry(name, raw as Record<string, unknown>, env, errors, warnings)
    if (entry) entries.push(entry)
  }
  return { ok: true, entries, declaredNames, errors, warnings }
}

/** 稳定序列化（键排序；config / secret 深比较用） */
function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableKey(obj[key])}`)
      .join(',')}}`
  }
  return value === undefined ? 'undefined' : (JSON.stringify(value) ?? 'undefined')
}

// ---------- 同步服务（文件权威） ----------

export interface McpJsonServiceOptions {
  filePath: string
  /** 轮询间隔（毫秒；0 = 关闭轮询） */
  pollMs: number
  store: McpServerStore
  runtime: McpRuntimeManager
  /** 变更广播（notify:mcp-changed；测试可缺省） */
  publish?: (payload: { serverId?: string; action: string }) => void
  env?: NodeJS.ProcessEnv
}

const ZERO_SUMMARY: McpJsonSyncSummary = { created: 0, updated: 0, removed: 0, skipped: 0 }

export class McpJsonConfigService {
  private readonly filePath: string
  private readonly pollMs: number
  private readonly store: McpServerStore
  private readonly runtime: McpRuntimeManager
  private readonly publish: (payload: { serverId?: string; action: string }) => void
  private readonly env: NodeJS.ProcessEnv
  private timer?: NodeJS.Timeout
  private lastMtime?: number
  private lastSyncAt?: string
  private lastResult?: 'ok' | 'skipped'
  private lastError?: string
  private lastWarnings: string[] = []
  private entryNames: string[] = []
  private lastSummary: McpJsonSyncSummary = { ...ZERO_SUMMARY }

  constructor(opts: McpJsonServiceOptions) {
    this.filePath = opts.filePath
    this.pollMs = opts.pollMs
    this.store = opts.store
    this.runtime = opts.runtime
    this.publish = opts.publish ?? (() => undefined)
    this.env = opts.env ?? process.env
  }

  /** 启动 mtime 轮询（pollMs<=0 时为 no-op；定时器 unref 不阻退出） */
  start(): void {
    if (this.pollMs <= 0 || this.timer) return
    this.timer = setInterval(() => {
      void this.pollTick().catch(() => undefined)
    }, this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  currentStatus(): McpJsonStatus {
    return {
      file: this.filePath,
      exists: fs.existsSync(this.filePath),
      pollMs: this.pollMs,
      lastSyncAt: this.lastSyncAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      lastWarnings: [...this.lastWarnings],
      entries: [...this.entryNames],
      summary: { ...this.lastSummary },
    }
  }

  /** 全量同步：upsert + 删除缺失（source='json'）；解析失败整次跳过 */
  async sync(trigger: 'startup' | 'poll' | 'manual'): Promise<McpJsonSyncResult> {
    const syncedAt = nowIso()
    this.lastSyncAt = syncedAt
    let text: string
    try {
      text = fs.readFileSync(this.filePath, 'utf8')
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
      this.lastResult = 'skipped'
      this.lastError = missing ? `配置文件不存在：${this.filePath}` : `配置文件读取失败：${(err as Error).message}`
      this.lastWarnings = []
      this.lastSummary = { ...ZERO_SUMMARY }
      // 文件消失 / 不可读同样防误删（绝不清空 source='json' 服务器）
      if (trigger !== 'startup' && !missing) this.publish({ action: 'json-sync-skipped' })
      return { ok: false, trigger, missing, errors: [this.lastError], warnings: [], summary: { ...ZERO_SUMMARY }, syncedAt }
    }
    this.recordMtime()

    const parsed = parseMcpJsonText(text, this.env)
    if (!parsed.ok) {
      this.lastResult = 'skipped'
      this.lastError = parsed.errors[0] ?? 'JSON 配置解析失败'
      this.lastWarnings = []
      this.lastSummary = { ...ZERO_SUMMARY }
      getLogger().warn({ file: this.filePath, errors: parsed.errors }, 'MCP JSON 配置解析失败：已跳过本次同步（不删除任何服务器）')
      this.publish({ action: 'json-sync-skipped' })
      return {
        ok: false,
        trigger,
        errors: parsed.errors,
        warnings: parsed.warnings,
        summary: { ...ZERO_SUMMARY },
        syncedAt,
      }
    }

    const summary: McpJsonSyncSummary = { ...ZERO_SUMMARY }
    const warnings = [...parsed.warnings]
    const presentNames = new Set(parsed.declaredNames)

    for (const entry of parsed.entries) {
      const existing = this.store.findByName(entry.name)
      if (!existing) {
        const server = this.store.create({
          name: entry.name,
          displayName: entry.displayName ?? null,
          transport: entry.transport,
          config: entry.config,
          secret: entry.secret,
          enabled: entry.enabled,
          source: 'json',
        })
        summary.created += 1
        if (server.enabled) void this.runtime.connect(server.id).catch(() => undefined)
        continue
      }
      if (existing.source !== 'json') {
        summary.skipped += 1
        warnings.push(`服务器「${entry.name}」已由 ${existing.source} 源配置占用，跳过（请改名或删除手动版）`)
        continue
      }
      const currentSecret = this.store.getSecret(existing.id) ?? null
      const changed =
        existing.transport !== entry.transport ||
        stableKey(existing.config) !== stableKey(entry.config) ||
        existing.enabled !== entry.enabled ||
        stableKey(currentSecret) !== stableKey(entry.secret)
      if (!changed) continue
      this.store.update(existing.id, {
        displayName: entry.displayName ?? null,
        transport: entry.transport,
        config: entry.config,
        enabled: entry.enabled,
        secret: entry.secret,
      })
      summary.updated += 1
      if (entry.enabled) void this.runtime.connect(existing.id).catch(() => undefined)
      else await this.runtime.disconnect(existing.id).catch(() => undefined)
    }

    // 删除：文件已成功解析且缺失的 json 源服务器（复用管理台删除语义：断开 + 移除 + 级联解绑）
    for (const server of this.store.list()) {
      if (server.source !== 'json' || presentNames.has(server.name)) continue
      await this.runtime.disconnect(server.id).catch(() => undefined)
      this.store.remove(server.id)
      summary.removed += 1
    }

    this.lastResult = 'ok'
    this.lastError = parsed.errors.length > 0 ? parsed.errors.join('；') : undefined
    this.lastWarnings = warnings
    this.entryNames = [...presentNames]
    this.lastSummary = summary
    const changedCount = summary.created + summary.updated + summary.removed
    if (changedCount > 0 || parsed.errors.length > 0 || warnings.length > 0) this.publish({ action: 'json-synced' })
    getLogger().info(
      { file: this.filePath, trigger, ...summary, errors: parsed.errors.length },
      'MCP JSON 配置同步完成',
    )
    return { ok: true, trigger, errors: parsed.errors, warnings, summary, syncedAt }
  }

  /** 粘贴导入：校验 → 创建为 ui 源（同名冲突跳过并报告；不触碰 json 源服务器） */
  async importAsUi(text: string): Promise<McpJsonImportOutcome> {
    const parsed = parseMcpJsonText(text, this.env)
    const created: string[] = []
    const skipped: Array<{ name: string; reason: string }> = []
    if (!parsed.ok) return { created, skipped, errors: parsed.errors, warnings: parsed.warnings }
    for (const entry of parsed.entries) {
      if (this.store.findByName(entry.name)) {
        skipped.push({ name: entry.name, reason: '同名服务器已存在（如需文件权威同步请写入 mcp.json）' })
        continue
      }
      try {
        const server = this.store.create({
          name: entry.name,
          displayName: entry.displayName ?? null,
          transport: entry.transport,
          config: entry.config,
          secret: entry.secret,
          enabled: entry.enabled,
          source: 'ui',
        })
        created.push(entry.name)
        if (server.enabled) void this.runtime.connect(server.id).catch(() => undefined)
      } catch (err) {
        skipped.push({ name: entry.name, reason: (err as Error).message })
      }
    }
    if (created.length > 0) this.publish({ action: 'json-imported' })
    return { created, skipped, errors: parsed.errors, warnings: parsed.warnings }
  }

  /** 轮询一拍：mtime 变化才同步（含文件出现 / 消失） */
  private async pollTick(): Promise<void> {
    let mtime: number | undefined
    try {
      mtime = fs.statSync(this.filePath).mtimeMs
    } catch {
      mtime = undefined
    }
    if (mtime === this.lastMtime) return
    await this.sync('poll')
  }

  private recordMtime(): void {
    try {
      this.lastMtime = fs.statSync(this.filePath).mtimeMs
    } catch {
      this.lastMtime = undefined
    }
  }
}
