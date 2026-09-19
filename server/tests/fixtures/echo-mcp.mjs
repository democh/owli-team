/**
 * M27 测试夹具：最小 MCP 服务器（stdio 传输），供 server 单测（m27-manager 真实 stdio 用例）与 E2E 共用。
 *
 * 工具清单（覆盖结果处理与审批策略分支）：
 * - echo        （只读 readOnlyHint）：回显 text
 * - add         （只读 readOnlyHint）：两数求和
 * - slow        （只读 readOnlyHint）：sleep ms 后返回（调用超时 / 中断用例）
 * - big         （只读 readOnlyHint）：返回 100KB 文本（detail 截断用例）
 * - image       （只读 readOnlyHint）：返回图片块（非文本占位摘要用例）
 * - write_note  （写类，无注解）：写入一条笔记（审批策略 / 会话绑定用例）
 *
 * 纯 ESM，直接 `node echo-mcp.mjs` 以标准输入输出通信。
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'echo-mcp', version: '1.0.0' })

server.registerTool(
  'echo',
  { description: '回显输入文本', inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
)

server.registerTool(
  'add',
  { description: '两数求和', inputSchema: { a: z.number(), b: z.number() }, annotations: { readOnlyHint: true } },
  async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
)

server.registerTool(
  'slow',
  {
    description: '延时 ms 毫秒后返回（超时 / 中断测试用）',
    inputSchema: { ms: z.number().int().min(0).max(600_000) },
    annotations: { readOnlyHint: true },
  },
  async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return { content: [{ type: 'text', text: `slept:${ms}` }] }
  },
)

server.registerTool(
  'big',
  { description: '返回 100KB 文本（截断测试用）', annotations: { readOnlyHint: true } },
  async () => ({ content: [{ type: 'text', text: 'A'.repeat(100 * 1024) }] }),
)

server.registerTool(
  'image',
  { description: '返回图片块（非文本占位摘要测试用）', annotations: { readOnlyHint: true } },
  async () => ({
    content: [{ type: 'image', data: Buffer.from('tiny-image-bytes').toString('base64'), mimeType: 'image/png' }],
  }),
)

server.registerTool(
  'write_note',
  { description: '写入一条笔记（写类工具，无 readOnlyHint）', inputSchema: { note: z.string() } },
  async ({ note }) => ({ content: [{ type: 'text', text: `note saved:${note}` }] }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
