/**
 * glob 工具（M5）：fast-glob 文件路径检索（支持 ** 与 ignore）。
 * 只读 → 可并行 + 幂等缓存；敏感文件从结果中剔除。
 */
import fg from 'fast-glob'
import { z } from 'zod'
import { matchedSensitivePattern } from './sensitive.js'
import type { ToolRuntime, ToolResult } from './registry.js'

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**']

export const globTool = {
  name: 'glob',
  readOnly: true,
  description:
    '按 glob 模式查找工作区文件路径（支持 ** 递归，如 "docs/**/*.md"、"src/**/*.ts"）。已知文件名模式时用本工具定位文件；查文件内容用 grep / search_text。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'glob 模式，如 "**/*.ts"（相对工作区根）' },
      ignore: { type: 'array', items: { type: 'string' }, description: '额外忽略的模式（如 ["**/dist/**"]）' },
      max_results: { type: 'number', description: '最多返回条数（默认 100，上限 500）' },
    },
    required: ['pattern'],
  },
  schema: z.object({
    pattern: z.string().min(1),
    ignore: z.array(z.string()).default([]),
    max_results: z.number().int().min(1).max(500).default(100),
  }),
  async execute(
    args: { pattern: string; ignore: string[]; max_results: number },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      if (ctx.signal?.aborted) {
        const err = new Error('操作已被中断')
        err.name = 'AbortError'
        throw err
      }
      const files = await fg(args.pattern, {
        cwd: ctx.workspace,
        ignore: [...DEFAULT_IGNORE, ...args.ignore],
        dot: false,
        onlyFiles: true,
        unique: true,
        suppressErrors: true,
        followSymbolicLinks: false,
      })
      const visible = ctx.allowSensitive ? files : files.filter((f) => !matchedSensitivePattern(f))
      const sorted = visible.sort((a, b) => a.localeCompare(b))
      const shown = sorted.slice(0, args.max_results)
      if (shown.length === 0) {
        return { ok: true, summary: `未匹配到文件（模式 ${args.pattern}）`, detail: '（0 条）' }
      }
      const more = sorted.length > shown.length ? `\n…（共 ${sorted.length} 条，已显示前 ${shown.length} 条）` : ''
      return {
        ok: true,
        summary: `匹配 ${sorted.length} 个文件`,
        detail: shown.join('\n') + more,
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      return { ok: false, summary: `glob 失败：${(err as Error).message}` }
    }
  },
}
