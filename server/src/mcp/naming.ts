/**
 * M27：MCP 命名规范化（服务器 slug + 工具注册名）。
 *
 * 规则：
 * - 服务器名必须满足 slug（`^[a-z][a-z0-9-]{0,39}$`），工具名前缀直接使用它；
 * - 工具注册名 = `mcp__<slug>__<tool>`，需兼容 OpenAI function.name 约束
 *   （`^[a-zA-Z0-9_-]{1,64}$`）：原始工具名非法字符替换为 `_`；总长超 64 时
 *   截断工具段并追加 6 位稳定哈希（同输入 → 同名，跨进程稳定）；同服务器内
 *   冲突追加 `_2` / `_3` 后缀；
 * - 保留 registeredName → rawName 映射，调用时回传服务器声明的原始工具名。
 */
import crypto from 'node:crypto'

export const MCP_TOOL_PREFIX = 'mcp__'

/** 服务器 slug：小写字母开头，后接 0-39 位小写字母 / 数字 / 连字符 */
export const MCP_SLUG_RE = /^[a-z][a-z0-9-]{0,39}$/

/** OpenAI function.name 上限 */
export const MAX_TOOL_NAME_LEN = 64

export function isValidMcpSlug(name: string): boolean {
  return MCP_SLUG_RE.test(name)
}

/** 展示名 / env 名称 → 合法 slug（不满足时尽力归一；失败返回空串由调用方拒绝） */
export function slugifyMcpName(raw: string): string {
  let slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0) return ''
  if (!/^[a-z]/.test(slug)) slug = `mcp-${slug}`
  slug = slug.slice(0, 40).replace(/-+$/, '')
  return isValidMcpSlug(slug) ? slug : ''
}

/** 工具名段规范化（单段，不含前缀）：非法字符 → `_`；空 → `tool` */
export function sanitizeToolSegment(raw: string): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'tool'
}

/** 6 位稳定哈希（同输入跨进程同名；仅用于截断尾缀，非安全用途） */
export function stableHash6(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 6)
}

export function mcpToolPrefix(slug: string): string {
  return `${MCP_TOOL_PREFIX}${slug}__`
}

/** 是否为 MCP 注入工具（mcp__ 前缀；引擎过滤与审批门判定用） */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX)
}

/** 从注册名解析服务器 slug（`mcp__<slug>__<tool>`；非 MCP 名返回 undefined） */
export function mcpSlugOf(registeredName: string): string | undefined {
  if (!isMcpToolName(registeredName)) return undefined
  const rest = registeredName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  return sep > 0 ? rest.slice(0, sep) : undefined
}

/**
 * 计算单个工具的注册名（含 64 字符截断 + 同服去重）。
 * used 为该服务器已占用的注册名集合（会被本函数写入）。
 */
export function buildRegisteredName(slug: string, rawTool: string, used: Set<string>): string {
  const prefix = mcpToolPrefix(slug)
  const maxSegLen = Math.max(1, MAX_TOOL_NAME_LEN - prefix.length)
  let segment = sanitizeToolSegment(rawTool)
  if (segment.length > maxSegLen) {
    // 截断 + `_<hash6>` 尾缀（hash6 + 下划线 = 7 字符）
    const keep = Math.max(1, maxSegLen - 7)
    segment = `${segment.slice(0, keep)}_${stableHash6(`${slug}/${rawTool}`)}`
  }
  let candidate = `${prefix}${segment}`
  let n = 2
  while (used.has(candidate)) {
    const suffix = `_${n}`
    const seg = `${segment.slice(0, Math.max(1, maxSegLen - suffix.length))}${suffix}`
    candidate = `${prefix}${seg}`
    n++
  }
  used.add(candidate)
  return candidate
}

/** 批量规划工具名（保持输入顺序；返回 raw ↔ registered 映射） */
export function planToolNames(slug: string, rawTools: string[]): Array<{ rawName: string; registeredName: string }> {
  const used = new Set<string>()
  return rawTools.map((rawName) => ({ rawName, registeredName: buildRegisteredName(slug, rawName, used) }))
}
