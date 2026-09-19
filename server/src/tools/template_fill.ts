/**
 * template_fill 工具（M21.2）：模板渲染落盘 —— 读工作区模板（{{dot.path}} 占位）→ 渲染 → 原子写。
 * 缺失变量汇总为错误清单不静默；dry_run 返回渲染预览不落盘；成功后标记交付件。
 * 零依赖：占位符为正则驱动的点路径查找（纯函数可单测）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PathEscapeError, resolveInRoot, writeFileAtomic } from '../util/paths.js'
import { sensitiveRejection } from './sensitive.js'
import type { ToolRuntime, ToolResult } from './registry.js'

const PREVIEW_BYTES = 2 * 1024

function relOfWorkspace(workspace: string, full: string): string {
  const base = fs.existsSync(workspace) ? fs.realpathSync(workspace) : path.resolve(workspace)
  return path.relative(base, full).split(path.sep).join('/')
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\}\}/g

function resolvePath(data: Record<string, unknown>, key: string): unknown {
  let cur: unknown = data
  for (const seg of key.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

function renderValue(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return JSON.stringify(v)
}

export type TemplateOutcome =
  | { ok: true; rendered: string; replaced: number; keys: string[] }
  | { ok: false; error: string; missing: string[]; invalid: string[] }

/** 纯函数渲染入口（可单测）：收集缺失 / 非法变量与替换计数 */
export function renderTemplate(template: string, data: Record<string, unknown>): TemplateOutcome {
  const missing = new Set<string>()
  const invalid = new Set<string>()
  const keys: string[] = []
  let replaced = 0
  const rendered = template.replace(PLACEHOLDER_RE, (_match, key: string) => {
    const value = resolvePath(data, key)
    if (value === undefined || value === null) {
      missing.add(key)
      return ''
    }
    if (typeof value === 'object') {
      invalid.add(key)
      return ''
    }
    replaced++
    if (!keys.includes(key)) keys.push(key)
    return renderValue(value)
  })
  if (missing.size > 0 || invalid.size > 0) {
    const parts: string[] = []
    if (missing.size > 0) parts.push(`缺失变量：${[...missing].slice(0, 20).join('、')}`)
    if (invalid.size > 0) parts.push(`变量值不是文本 / 数字（请指定到具体字段）：${[...invalid].slice(0, 20).join('、')}`)
    return { ok: false, error: parts.join('；'), missing: [...missing], invalid: [...invalid] }
  }
  // 渲染后仍残留 '{{' → 存在未解析占位符（如拼写用了非法字符）
  const leftover = rendered.match(/\{\{[\s\S]{0,60}?\}\}/)
  if (leftover) {
    return { ok: false, error: `存在未解析占位符「${leftover[0].slice(0, 60)}」（占位符不支持空格外的特殊字符，请检查拼写）`, missing: [], invalid: [] }
  }
  return { ok: true, rendered, replaced, keys }
}

export const templateFillTool = {
  name: 'template_fill',
  description:
    '用数据渲染工作区模板（{{点路径}} 占位，如 {{客户.名称}}）并落盘为交付件。适合合同 / 报价单 / 邮件 / 纪要等模板化文档；缺失变量会汇总报错不静默；dry_run=true 仅返回渲染预览。',
  parameters: {
    type: 'object',
    properties: {
      template: { type: 'string', description: '模板文件工作区相对路径（如 templates/报价单.md）' },
      data: { type: 'object', description: '变量对象，支持点路径嵌套：{ "客户": { "名称": "某某" }, "金额": 1200 }', additionalProperties: true },
      output: { type: 'string', description: '输出文件工作区相对路径（如 docs/报价单-某某.md）' },
      dry_run: { type: 'boolean', description: '仅返回渲染预览不落盘（默认 false）' },
    },
    required: ['template', 'data', 'output'],
  },
  schema: z.object({
    template: z.string().min(1),
    data: z.record(z.unknown()),
    output: z.string().min(1),
    dry_run: z.boolean().default(false),
  }),
  async execute(
    args: { template: string; data: Record<string, unknown>; output: string; dry_run: boolean },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const tplFull = resolveInRoot(ctx.workspace, args.template)
      if (!fs.existsSync(tplFull) || !fs.statSync(tplFull).isFile()) {
        return { ok: false, summary: `模板不存在：${args.template}` }
      }
      const tplGuard = sensitiveRejection(relOfWorkspace(ctx.workspace, tplFull), ctx.allowSensitive, '读取')
      if (tplGuard) return { ok: false, summary: tplGuard }
      const outFull = resolveInRoot(ctx.workspace, args.output)
      const outRel = relOfWorkspace(ctx.workspace, outFull)
      const outGuard = sensitiveRejection(outRel, ctx.allowSensitive, '写入')
      if (outGuard) return { ok: false, summary: outGuard }

      const template = fs.readFileSync(tplFull, 'utf8')
      const outcome = renderTemplate(template, args.data)
      if (!outcome.ok) {
        return {
          ok: false,
          summary: `模板渲染失败（未写入）：${outcome.error}`,
          detail: `请补齐 data 后重试。缺失清单：${outcome.missing.length > 0 ? outcome.missing.join('、') : '（无）'}；非法值：${outcome.invalid.length > 0 ? outcome.invalid.join('、') : '（无）'}`,
        }
      }

      if (args.dry_run) {
        const preview = outcome.rendered.slice(0, PREVIEW_BYTES)
        return {
          ok: true,
          summary: `dry-run：渲染完成（替换 ${outcome.replaced} 处），未写入 ${outRel}`,
          detail: `以下是渲染预览（未写入）：\n${preview}${outcome.rendered.length > PREVIEW_BYTES ? '\n…（预览已截断至 2KB）' : ''}`,
        }
      }

      writeFileAtomic(outFull, outcome.rendered, ctx.signal)
      ctx.artifacts.markAuthor(ctx.sessionId, outRel, ctx.agentId)
      return {
        ok: true,
        summary: `已生成 ${outRel}（替换 ${outcome.replaced} 处变量）`,
        detail: `交付件 ${outRel} 已按模板 ${args.template} 渲染写入。变量：${outcome.keys.slice(0, 20).join('、') || '（无）'}。`,
        artifacts: [outRel],
      }
    } catch (err) {
      if (err instanceof PathEscapeError) return { ok: false, summary: err.message }
      if ((err as Error).name === 'AbortError') throw err
      return { ok: false, summary: `模板填充失败：${(err as Error).message}` }
    }
  },
}
