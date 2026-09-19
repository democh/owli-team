/**
 * M27：MCP_SERVERS env 种子解析（历史格式兼容）。
 *
 * 真实接入与管理已迁移到 `server/src/mcp/`（SDK 双传输 + 运行时管理器 + 管理台）：
 * 启动时把本文件解析出的条目导入 DB（不存在才建，source='env'），此后 DB 为唯一真相。
 *
 * MCP_SERVERS 格式：`name=command args...`（stdio）或 `name=https://host/mcp`（HTTP），逗号分隔。
 */
import type { McpServerConfig, McpTransportKind } from '@multi-agent/shared'
import { isValidMcpSlug, slugifyMcpName } from '../mcp/naming.js'

/** 单个 MCP server 种子条目 */
export interface McpServerSeed {
  /** slug（工具名前缀；非法名称自动归一，无法归一则为空、由调用方跳过） */
  name: string
  transport: McpTransportKind
  config: McpServerConfig
}

/** 命令行 → argv（支持单 / 双引号分段；不经过 shell，无元字符展开） */
export function splitCommandLine(input: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(input)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token.length > 0) out.push(token)
  }
  return out
}

/** 解析 MCP_SERVERS 配置项：`name=target`（target 为 URL 或命令） */
export function parseMcpServerSeeds(entries: string[]): McpServerSeed[] {
  const seeds: McpServerSeed[] = []
  const seen = new Set<string>()
  for (const raw of entries) {
    const eq = raw.indexOf('=')
    if (eq <= 0) continue // 无名称的配置项直接忽略（启动日志会打印告警）
    const name = slugifyMcpName(raw.slice(0, eq))
    const target = raw.slice(eq + 1).trim()
    if (!name || !target || seen.has(name) || !isValidMcpSlug(name)) continue
    seen.add(name)
    if (target.startsWith('http://') || target.startsWith('https://')) {
      seeds.push({ name, transport: 'http', config: { url: target } })
      continue
    }
    const argv = splitCommandLine(target)
    if (argv.length === 0) continue
    seeds.push({ name, transport: 'stdio', config: { command: argv[0]!, args: argv.slice(1) } })
  }
  return seeds
}
