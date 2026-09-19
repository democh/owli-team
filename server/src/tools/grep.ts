/**
 * grep 工具（M5）：正则内容检索，支持 glob 过滤与上下文行。
 * 优先调用系统 rg（若 PATH 中存在），缺失时纯 JS 回退（fast-glob + 正则逐行）。
 * 只读 → 可并行 + 幂等缓存；敏感文件不参与检索。
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fg from 'fast-glob'
import { z } from 'zod'
import { matchedSensitivePattern } from './sensitive.js'
import type { ToolRuntime, ToolResult } from './registry.js'

const execFileAsync = promisify(execFile)

const DEFAULT_IGNORE = ['**/node_modules/**', '**/.git/**']
/** 单文件读取上限（回退路径）；更大文件跳过 */
const MAX_FILE_BYTES = 4 * 1024 * 1024

interface Hit {
  file: string
  line: number
  text: string
}

function abortLike(): Error {
  const err = new Error('操作已被中断')
  err.name = 'AbortError'
  return err
}

/** rg 路径：ENOENT / 用法错误（exit 2）→ 返回 undefined 交给 JS 回退 */
async function ripgrep(
  workspace: string,
  pattern: string,
  globFilter: string | undefined,
  maxResults: number,
): Promise<Hit[] | undefined> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '--with-filename', '-e', pattern]
  if (globFilter) args.push('-g', globFilter)
  args.push('-g', '!**/node_modules/**', '-g', '!**/.git/**', '.')
  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd: workspace,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 10_000,
    })
    const hits: Hit[] = []
    for (const raw of stdout.split('\n')) {
      if (hits.length >= maxResults) break
      if (!raw.trim()) continue
      const m = /^(.*?):(\d+):(.*)$/.exec(raw)
      if (!m) continue
      hits.push({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]), text: m[3] })
    }
    return hits
  } catch (err) {
    const e = err as { code?: number | string; killed?: boolean }
    if (e.killed) throw new Error('rg 执行超时')
    if (e.code === 1) return [] // 无匹配（rg 正常退出码）
    return undefined // ENOENT / exit 2 → JS 回退
  }
}

/** 纯 JS 回退：fast-glob 列文件 + 正则逐行匹配 */
async function jsGrep(
  workspace: string,
  regex: RegExp,
  globFilter: string | undefined,
  maxResults: number,
  allowSensitive: boolean,
): Promise<Hit[]> {
  const files = await fg(globFilter ?? '**/*', {
    cwd: workspace,
    ignore: DEFAULT_IGNORE,
    dot: false,
    onlyFiles: true,
    unique: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  })
  const hits: Hit[] = []
  for (const rel of files.sort((a, b) => a.localeCompare(b))) {
    if (hits.length >= maxResults) break
    if (!allowSensitive && matchedSensitivePattern(rel)) continue
    const full = path.join(workspace, rel)
    let stat: fs.Stats
    try {
      stat = fs.statSync(full)
    } catch {
      continue
    }
    if (stat.size > MAX_FILE_BYTES) continue
    let text: string
    try {
      text = fs.readFileSync(full, 'utf8')
    } catch {
      continue
    }
    if (text.includes('\u0000')) continue // 二进制跳过
    const lines = text.split('\n')
    for (let i = 0; i < lines.length && hits.length < maxResults; i++) {
      regex.lastIndex = 0
      if (regex.test(lines[i])) hits.push({ file: rel, line: i + 1, text: lines[i] })
    }
  }
  return hits
}

/** 命中行 +（可选）上下文行渲染 */
function renderHits(workspace: string, hits: Hit[], context: number): string {
  const lines: string[] = []
  const cache = new Map<string, string[]>()
  for (const hit of hits) {
    if (context > 0) {
      let content = cache.get(hit.file)
      if (!content) {
        try {
          content = fs.readFileSync(path.join(workspace, hit.file), 'utf8').split('\n')
        } catch {
          content = []
        }
        cache.set(hit.file, content)
      }
      const from = Math.max(1, hit.line - context)
      const to = Math.min(content.length, hit.line + context)
      for (let n = from; n <= to; n++) {
        const mark = n === hit.line ? ':' : '-'
        lines.push(`${hit.file}:${n}${mark} ${content[n - 1]?.trimEnd().slice(0, 200) ?? ''}`)
      }
      lines.push('--')
    } else {
      lines.push(`${hit.file}:${hit.line}: ${hit.text.trim().slice(0, 200)}`)
    }
  }
  return lines.join('\n')
}

export const grepTool = {
  name: 'grep',
  readOnly: true,
  description:
    '在工作区按正则检索文件内容（返回 文件:行号: 内容），支持 glob 过滤（如 "**/*.ts"）与上下文行（context>0 时展示前后行）。找定义 / 找引用 / 查关键词首选本工具。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '正则表达式（如 "function \\w+\\(" ；传字面量请自行转义）' },
      glob: { type: 'string', description: '文件名过滤（glob 模式，如 "**/*.ts"；缺省全部文件）' },
      context: { type: 'number', description: '上下文行数（0-5，默认 0）' },
      max_results: { type: 'number', description: '最多命中条数（默认 50，上限 200）' },
    },
    required: ['pattern'],
  },
  schema: z.object({
    pattern: z.string().min(1),
    glob: z.string().optional(),
    context: z.number().int().min(0).max(5).default(0),
    max_results: z.number().int().min(1).max(200).default(50),
  }),
  async execute(
    args: { pattern: string; glob?: string; context: number; max_results: number },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    if (ctx.signal?.aborted) throw abortLike()
    let regex: RegExp
    try {
      regex = new RegExp(args.pattern)
    } catch (err) {
      return { ok: false, summary: `正则表达式无效：${(err as Error).message}` }
    }

    let hits = await ripgrep(ctx.workspace, args.pattern, args.glob, args.max_results)
    if (!hits) hits = await jsGrep(ctx.workspace, regex, args.glob, args.max_results, ctx.allowSensitive)
    if (ctx.signal?.aborted) throw abortLike()

    // 敏感文件结果剔除（rg 路径下也需过滤）
    if (!ctx.allowSensitive) hits = hits.filter((h) => !matchedSensitivePattern(h.file))
    if (hits.length === 0) {
      return { ok: true, summary: `未匹配「${args.pattern}」`, detail: '（0 条命中）' }
    }
    return {
      ok: true,
      summary: `${hits.length} 条命中`,
      detail: renderHits(ctx.workspace, hits, args.context),
    }
  },
}
