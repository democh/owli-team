/**
 * M27：MCP 客户端封装（@modelcontextprotocol/sdk）。
 *
 * - stdio：子进程环境 = SDK 安全默认集 + 服务器配置 env（**不透传进程 env**，
 *   防 LLM_API_KEY 等进程级密钥泄漏给第三方子进程）；spawn 走 argv 数组不过 shell；
 *   stderr 转日志；cwd 缺省为应用根目录。
 * - http：Streamable HTTP（headers 来自加密凭据）。
 * - 暴露管理器所需的最小面（listTools / callTool / close / 工具变更通知）；
 *   `clientFactory` 可注入（测试用 InMemoryTransport 替代真实子进程）。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import type { McpServerConfig, McpTransportKind } from '@multi-agent/shared'
import { getLogger } from '../logger.js'

/** 连接 / 工具清单请求超时（默认 15s；低配主机上 uvx/npx 冷启动或并发起步会踩线，可用 env 放大） */
function envTimeoutMs(name: string): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 15_000
}

export const MCP_CONNECT_TIMEOUT_MS = envTimeoutMs('MCP_CONNECT_TIMEOUT_MS')
export const MCP_LIST_TIMEOUT_MS = envTimeoutMs('MCP_LIST_TIMEOUT_MS')

/** 回灌模型的 detail 硬上限（防大结果撑爆上下文与落库） */
export const MCP_RESULT_MAX_BYTES = 64 * 1024
/** structuredContent 单独截断上限 */
const STRUCTURED_MAX_CHARS = 4_096

/** 远端工具定义（SDK Tool 的结构子集，避免管理器依赖 SDK 类型） */
export interface McpRemoteToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  annotations?: { readOnlyHint?: boolean; [key: string]: unknown }
}

export interface McpCallOutcome {
  ok: boolean
  /** 扁平化后的文本结果（已截断） */
  content: string
  /** 结果块数量（summary 展示用） */
  blockCount: number
}

export interface McpConnectionHandle {
  /** 服务器自称信息（initialize 时上报） */
  serverInfo?: { name: string; version: string }
  /** stdio 子进程 pid（进程退出兜底同步强杀用；http 传输为 undefined） */
  childPid?: number
  listTools(timeoutMs?: number): Promise<McpRemoteToolDef[]>
  callTool(name: string, args: unknown, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<McpCallOutcome>
  close(): Promise<void>
  /** tools/list_changed 通知订阅（服务器支持时自动触发工具清单刷新） */
  onToolsChanged(cb: () => void): void
}

export interface McpConnectOptions {
  transport: McpTransportKind
  config: McpServerConfig
  /** 解密后的凭据（stdio: { env }；http: { headers }） */
  secret?: Record<string, unknown>
  /** 应用根目录（stdio cwd 缺省值） */
  rootDir: string
}

export type McpClientFactory = (opts: McpConnectOptions) => Promise<McpConnectionHandle>

/** secret.env / secret.headers → 字符串值字典（忽略非字符串值） */
function stringRecord(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && key.trim().length > 0) out[key.trim()] = value
  }
  return out
}

function humanBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

interface ContentBlockLike {
  type?: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  name?: string
}

/** base64 → 近似字节数（图片 / 音频块大小描述用） */
function base64Bytes(data: string | undefined): number {
  if (!data) return 0
  return Math.floor((data.length * 3) / 4)
}

/** 单个结果块 → 文本占位 / 正文 */
function flattenBlock(block: ContentBlockLike): string {
  switch (block.type) {
    case 'text':
      return block.text ?? ''
    case 'image':
      return `[图片 ${block.mimeType ?? 'image/*'} ${humanBytes(base64Bytes(block.data))}]`
    case 'audio':
      return `[音频 ${block.mimeType ?? 'audio/*'} ${humanBytes(base64Bytes(block.data))}]`
    case 'resource': {
      const text = typeof block.text === 'string' ? `\n${block.text.slice(0, 2_000)}` : ''
      return `[资源 ${block.uri ?? '(无 uri)'}]${text}`
    }
    case 'resource_link':
      return `[资源链接 ${block.uri ?? block.name ?? '(无 uri)'}]`
    default:
      return block.type ? `[${block.type} 块]` : '[未知块]'
  }
}

/** SDK 调用结果 → 扁平化文本（text 拼接 / 非文本占位 / structuredContent 截断 / 总长硬上限） */
export function flattenCallResult(result: unknown): McpCallOutcome {
  const record = (result ?? {}) as {
    content?: ContentBlockLike[]
    structuredContent?: unknown
    isError?: boolean
    toolResult?: unknown
  }
  const blocks = Array.isArray(record.content) ? record.content : []
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object') parts.push(flattenBlock(block))
  }
  if (parts.length === 0 && record.toolResult !== undefined) {
    // 兼容旧版（toolResult 直出）形态
    try {
      parts.push(JSON.stringify(record.toolResult, null, 2))
    } catch {
      parts.push(String(record.toolResult))
    }
  }
  if (record.structuredContent !== undefined) {
    try {
      const json = JSON.stringify(record.structuredContent, null, 2)
      parts.push(`[structuredContent]\n${json.length > STRUCTURED_MAX_CHARS ? `${json.slice(0, STRUCTURED_MAX_CHARS)}\n…（已截断）` : json}`)
    } catch {
      /* 循环引用等异常形态：忽略 structuredContent */
    }
  }
  let content = parts.join('\n')
  if (Buffer.byteLength(content, 'utf8') > MCP_RESULT_MAX_BYTES) {
    content = `${content.slice(0, MCP_RESULT_MAX_BYTES)}\n…（结果超出 ${humanBytes(MCP_RESULT_MAX_BYTES)} 上限，已截断）`
  }
  const ok = record.isError !== true
  return { ok, content: content || '（空结果）', blockCount: Math.max(blocks.length, parts.length > 0 ? 1 : 0) }
}

/** 默认工厂：真实 SDK 传输（stdio 子进程 / Streamable HTTP） */
export const createSdkMcpClient: McpClientFactory = async (opts) => {
  const log = getLogger()
  // 客户端能力声明（sampling / roots / elicitation 按需）；tools/list_changed 通知
  // 由服务端声明、客户端注册处理器接收，无需在客户端能力中声明
  const client = new Client(
    { name: 'multi-agent-server', version: '0.1.0' },
    { capabilities: {} },
  )
  let transport: StdioClientTransport | StreamableHTTPClientTransport
  if (opts.transport === 'stdio') {
    if (!opts.config.command) throw new Error('stdio 服务器缺少 command 配置')
    const stdio = new StdioClientTransport({
      command: opts.config.command,
      args: Array.isArray(opts.config.args) ? opts.config.args : [],
      cwd: opts.config.cwd || opts.rootDir,
      // 安全默认集（PATH / HOME / TMPDIR / LANG 等）+ 配置 env；绝不透传完整进程 env
      env: { ...getDefaultEnvironment(), ...stringRecord(opts.secret?.env) },
      stderr: 'pipe',
    })
    stdio.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) log.debug({ server: opts.config.command, stderr: text.slice(0, 500) }, 'MCP 子进程 stderr')
    })
    transport = stdio
  } else {
    if (!opts.config.url) throw new Error('http 服务器缺少 url 配置')
    let url: URL
    try {
      url = new URL(opts.config.url)
    } catch {
      throw new Error(`http 端点 URL 非法：${opts.config.url}`)
    }
    const headers = stringRecord(opts.secret?.headers)
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    })
  }

  await client.connect(transport, { timeout: MCP_CONNECT_TIMEOUT_MS })
  const version = client.getServerVersion()
  return {
    serverInfo: version ? { name: version.name, version: version.version } : undefined,
    childPid: transport instanceof StdioClientTransport ? (transport.pid ?? undefined) : undefined,
    async listTools(timeoutMs = MCP_LIST_TIMEOUT_MS): Promise<McpRemoteToolDef[]> {
      const result = await client.listTools(undefined, { timeout: timeoutMs })
      return (result.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
        annotations: tool.annotations as McpRemoteToolDef['annotations'],
      }))
    },
    async callTool(name, args, callOpts): Promise<McpCallOutcome> {
      const result = await client.callTool(
        { name, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: callOpts?.timeoutMs, signal: callOpts?.signal },
      )
      return flattenCallResult(result)
    },
    async close(): Promise<void> {
      await client.close()
    },
    onToolsChanged(cb: () => void): void {
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => cb())
    },
  }
}
