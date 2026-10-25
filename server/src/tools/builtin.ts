/**
 * 内置工具集（§21.3）：文件读写 / 检索 / 记忆 / 任务清单 / 结构化转交 / Skill 加载 / 受限命令。
 * 全部文件操作限定会话工作区（resolveInRoot 沙箱：路径归一化 + 前缀校验 + 反软链逃逸）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { exec as execCb } from 'node:child_process'
import { promisify } from 'node:util'
import { createTwoFilesPatch } from 'diff'
import { z } from 'zod'
import type { MemoryKind, MemoryScope } from '@multi-agent/shared'
import { measureDoc, USER_ALIASES } from '@multi-agent/shared'
import type { AppConfig } from '../config.js'
import { classifyKind, isBinaryExt } from '../store/artifacts.js'
import { normalizeRelPath } from '../store/artifact-index.js'
import { DOCUMENT_EXTS, extractDocumentText } from '../util/document-extract.js'
import { ATTACHMENT_AUDIO_EXT } from '../util/mime.js'
import { PathEscapeError, resolveInRoot, writeFileAtomic } from '../util/paths.js'
import { matchedSensitivePattern, sensitiveRejection } from './sensitive.js'
import { applyPatchTool } from './apply_patch.js'
import { gitTools } from './git.js'
import { createApprovalTools } from './approval.js'
// M24：范式工具（write_plan / update_plan_step / submit_review）
import { createPlanTools } from './plan.js'
import { globTool } from './glob.js'
import { grepTool } from './grep.js'
import { webFetchTool } from './web_fetch.js'
import { webSearchTool } from './web_search.js'
// M21.2：业务工具集（计算 / 日期 / 表格 / 模板）
import { calcTool } from './calc.js'
import { RUN_COMMAND_DISABLED_SUMMARY } from './availability.js'
// M34：金融工具集（FINANCE_ENABLED=false 时登记未启用提示，见 createToolRegistry）
import { FINANCE_DISABLED_SUMMARY } from './finance_shared.js'
import { csvAnalyzeTool } from './csv_analyze.js'
import { dateCalcTool } from './date_calc.js'
import { templateFillTool } from './template_fill.js'
import { ToolRegistry, toolAbortError, type ToolRuntime, type ToolResult } from './registry.js'
// M22：连接中心工具集（数据库 / 浏览器；依赖由引擎运行期注入 ctx，未装配时返回明确提示）
import { createDbTools } from './db.js'
import { createBrowserTools } from './browser.js'
import { createSshTools } from './ssh.js'
// M31：画布创作工具集（无限画布读写 / 媒体生成；依赖由引擎运行期注入 ctx）
import { createCanvasTools } from './canvas.js'
import { createMediaTools } from './media.js'
// M35：定时任务工具集（创建 / 查看 / 管理；tier=deferred，经 tool_search 检索激活）
import { createScheduleTools } from './schedule.js'
// M34：金融投研工具集（数据类 8 + 量化类 4；FINANCE_ENABLED=true 时注册，tier=deferred）
import { createFinanceTools } from './finance.js'
import { createFinanceQuantTools } from './finance_quant.js'
// M51-E：命理排盘工具集（四柱 / 紫微 / 星盘 / 卦；纯计算只读，tier=deferred）
import { createPanTools } from './pan.js'
// M69：场景玩法工具集（trpg 掷骰 / tarot 抽牌；纯计算只读，tier=deferred）
import { createDiceTools } from './dice.js'
import { createTarotTools } from './tarot.js'
import { createLuopanTools } from './luopan.js'
import { createZeriTools } from './zeri.js'

const exec = promisify(execCb)

const SKIP_DIRS = new Set(['node_modules', '.git'])
/** 单次读取上限：更大文件要求模型分页/检索（M2 分页续读） */
const MAX_READ_BYTES = 8 * 1024 * 1024
/** M33：文档识别读取上限（office / pdf 解析为文本，不整块渲染；可比普通文件放宽） */
const MAX_DOC_READ_BYTES = 32 * 1024 * 1024

/** 中断错误判定（provider.abortError / registry.toolAbortError / writeFileAtomic 同名约定） */
function isAbortLike(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

/** 覆盖写 diff 摘要（+a/-d）：dry-run 与覆盖提示共用 */
function summarizeDiff(rel: string, previous: string, next: string): string {
  const patch = createTwoFilesPatch(rel, rel, previous, next)
  let added = 0
  let removed = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++
    else if (line.startsWith('-') && !line.startsWith('---')) removed++
  }
  return `+${added}/-${removed}`
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

function relOf(ctx: ToolRuntime, fullPath: string): string {
  // resolveInRoot 基于 realpath 归一化（macOS /var → /private/var），相对路径计算需对齐
  const base = fs.existsSync(ctx.workspace) ? fs.realpathSync(ctx.workspace) : path.resolve(ctx.workspace)
  return path.relative(base, fullPath).split(path.sep).join('/')
}

function failure(err: unknown): ToolResult {
  if (err instanceof PathEscapeError) return { ok: false, summary: err.message }
  return { ok: false, summary: (err as Error).message }
}

/** 遍历工作区文件（忽略隐藏项 / node_modules），最多 limit 个 */
function walkFiles(root: string, limit = 500): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || out.length >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile()) out.push(full)
    }
  }
  walk(root, 0)
  return out
}

const listDirTool = {
  name: 'list_dir',
  readOnly: true,
  description:
    '列出当前会话工作区的目录与文件（树形）。开始工作前先看一眼有哪些已有产出，避免重复造轮子。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内的相对目录，缺省为根目录' },
      depth: { type: 'number', description: '最大深度（1-4，默认 3）' },
    },
  },
  schema: z.object({ path: z.string().default('.'), depth: z.number().int().min(1).max(4).default(3) }),
  async execute(
    args: { path: string; depth: number },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const base = resolveInRoot(ctx.workspace, args.path)
      if (!fs.existsSync(base) || !fs.statSync(base).isDirectory()) {
        return { ok: false, summary: `目录不存在：${args.path}` }
      }
      const lines: string[] = []
      const walk = (dir: string, depth: number): void => {
        if (depth > args.depth || lines.length > 200) return
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        for (const entry of entries) {
          if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
          const full = path.join(dir, entry.name)
          const rel = relOf(ctx, full)
          if (entry.isDirectory()) {
            lines.push(`${rel}/`)
            walk(full, depth + 1)
          } else {
            lines.push(`${rel} (${humanSize(fs.statSync(full).size)})`)
          }
        }
      }
      walk(base, 1)
      if (lines.length === 0) {
        return { ok: true, summary: '目录为空', detail: '（空目录：还没有任何交付件）' }
      }
      return { ok: true, summary: `共 ${lines.length} 项`, detail: lines.join('\n') }
    } catch (err) {
      return failure(err)
    }
  },
}

/** M33：文档识别管道——office / pdf 自动提取文本（失败时返回用户可读的降级提示） */
function readDocument(full: string, rel: string, ext: string): ToolResult {
  try {
    const extracted = extractDocumentText(ext, fs.readFileSync(full))
    if (!extracted) return { ok: false, summary: `暂不支持提取此格式：${rel}` }
    if (!extracted.text) {
      return {
        ok: false,
        summary: `${rel} 未能提取到文本内容`,
        detail: extracted.note ?? '文件可能是空文档 / 加密文档，请让用户确认后重传。',
      }
    }
    return {
      ok: true,
      summary: `已读取 ${rel}（${extracted.extractor} 文档 · 自动提取文本 · ${extracted.text.length} 字符）`,
      detail: extracted.note ? `${extracted.text}\n\n[提取提示] ${extracted.note}` : extracted.text,
    }
  } catch (err) {
    return {
      ok: false,
      summary: `无法解析 ${rel}（${ext}）`,
      detail: `文件可能损坏或加密：${err instanceof Error ? err.message : String(err)}。请让用户确认文件可正常打开后重传。`,
    }
  }
}

/** M33：二进制文件读取提示（按类别给模型可行动的替代路径） */
function binaryReadHint(kind: ReturnType<typeof classifyKind>, ext: string): string {
  if (kind === 'image') {
    return '图片内容随用户消息的附件以视觉输入提供（最近发送的图片可直接看到）；若上下文中没有该图片，请让用户重新发送或描述内容。'
  }
  if (kind === 'video' || ATTACHMENT_AUDIO_EXT.has(ext)) {
    return '音视频无文本层：播放器 / 封面 / 元数据（时长、分辨率）随消息附件展示；如需理解内容，请让用户提供文字说明或关键帧截图（截图可视觉识别）。'
  }
  return '该文件为二进制格式，无法按文本读取；请让用户说明用途或转换格式。'
}

const readFileTool = {
  name: 'read_file',
  readOnly: true,
  description:
    '读取工作区内某个文件的内容，支持按行分页（offset/limit）。office（docx/xlsx/pptx）与 pdf 自动提取正文文本；图片 / 音视频等二进制文件不做文本读取。大文件先读第 1 页确认结构，再按需继续读取；不要重复读自己刚写过的文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对路径' },
      offset: { type: 'number', description: '起始行号（1 基，默认 1）' },
      limit: { type: 'number', description: '最多读取行数（默认 400，上限 2000）' },
    },
    required: ['path'],
  },
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().min(1).default(1),
    limit: z.number().int().min(1).max(2_000).default(400),
  }),
  async execute(
    args: { path: string; offset: number; limit: number },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx.workspace, args.path)
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return { ok: false, summary: `文件不存在：${args.path}` }
      }
      const guard = sensitiveRejection(relOf(ctx, full), ctx.allowSensitive, '读取')
      if (guard) return { ok: false, summary: guard }
      const size = fs.statSync(full).size
      const ext = path.extname(args.path).toLowerCase()
      // M33：文档识别——office / pdf 自动提取正文（替代 utf8 乱码）
      if (DOCUMENT_EXTS.has(ext)) {
        if (size > MAX_DOC_READ_BYTES) {
          return {
            ok: false,
            summary: `文件过大（${humanSize(size)}，文档识别上限 32MB）`,
            detail: '请请求用户拆分文档后重传，或改用 search_text 定位关键内容。',
          }
        }
        return readDocument(full, args.path, ext)
      }
      // M33：二进制媒体（图片 / 视频 / 音频 / 压缩包等）不做像素级读取
      if (isBinaryExt(args.path)) {
        const kind = classifyKind(args.path)
        return {
          ok: false,
          summary: `${args.path} 是二进制文件（${kind}），无法按文本读取。`,
          detail: binaryReadHint(kind, ext),
        }
      }
      // 审核 M-5：先 stat 预检体积再读取（大文件直接拒绝，避免整块读入内存后才发现超限）
      if (size > MAX_READ_BYTES) {
        return {
          ok: false,
          summary: `文件过大（${humanSize(size)}，单次读取上限 8MB）`,
          detail: '请改用 search_text 定位关键内容，或请求用户拆分该文件。',
        }
      }
      const buffer = fs.readFileSync(full)
      const lines = buffer.toString('utf8').split('\n')
      const total = lines.length
      if (args.offset > total) {
        return { ok: false, summary: `offset=${args.offset} 超出文件行数（共 ${total} 行）` }
      }
      const end = Math.min(total, args.offset + args.limit - 1)
      const shown = lines.slice(args.offset - 1, end).join('\n')
      const more = end < total
      return {
        ok: true,
        summary: `已读取 ${args.path}（第 ${args.offset}-${end} 行 / 共 ${total} 行）`,
        detail: more
          ? `${shown}\n\n[已截断：还有 ${total - end} 行，用 read_file(path="${args.path}", offset=${end + 1}) 继续读取]`
          : shown,
      }
    } catch (err) {
      return failure(err)
    }
  },
}

/** 交付规格体检（仅 Markdown 类）：落盘后回灌结构化指标，供模型对照 <deliverable_spec> 自检 */
function healthNote(rel: string, content: string): string {
  if (!/\.(md|markdown)$/i.test(rel)) return ''
  const m = measureDoc(content)
  const warn = m.placeholders > 0 ? `⚠ 占位残留 ${m.placeholders} 处（待填 / TODO）——交付前请逐处替换为正文并清理。` : ''
  return `\n体检：非空白字符 ${m.chars} / 二级章节 ${m.sections} / 表格 ${m.tables} / 来源标记 ${m.sources}——对照交付规格（速览 ≤800 / 标准 1500–4000 / 深度 ≥4000）自检；未达档位下限先补全再交还。${warn}`
}

const writeFileTool = {
  name: 'write_file',
  description:
    '把交付件写入工作区（新建或覆盖，自动创建目录）。产出文档 / 代码 / 报告等成果时使用，这是团队交付件的主通道。覆盖已有文件时建议先 dry_run=true 预览 diff 再正式写入；长报告分章撰写时用 mode=append 逐节追加（先骨架后填充），避免单次成文被截断。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对路径，如 docs/需求文档.md' },
      content: { type: 'string', description: '完整文件内容' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: '写入模式：overwrite 覆盖（默认）/ append 追加到文件末尾（长文档逐节撰写；文件不存在时等价新建）',
      },
      dry_run: { type: 'boolean', description: '仅预览：对已有文件返回 diff 摘要不写入（默认 false）' },
    },
    required: ['path', 'content'],
  },
  schema: z.object({
    path: z.string().min(1),
    content: z.string(),
    mode: z.enum(['overwrite', 'append']).default('overwrite'),
    dry_run: z.boolean().default(false),
  }),
  async execute(
    args: { path: string; content: string; mode: 'overwrite' | 'append'; dry_run: boolean },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx.workspace, args.path)
      const rel = relOf(ctx, full)
      const guard = sensitiveRejection(rel, ctx.allowSensitive, '写入')
      if (guard) return { ok: false, summary: guard }

      const exists = fs.existsSync(full) && fs.statSync(full).isFile()
      const previous = exists ? fs.readFileSync(full, 'utf8') : ''
      // 交付规格闭环：append 模式以空行衔接（长文档分节撰写）；文件不存在时等价新建
      const appended = args.mode === 'append' && previous !== ''
      const next = appended ? `${previous.replace(/\s+$/, '')}\n\n${args.content}` : args.content
      const diffSummary = exists ? summarizeDiff(rel, previous, next) : undefined

      // M5：覆盖已有文件的 dry-run（供模型/审批先看改动）
      if (exists && args.dry_run) {
        const patch = createTwoFilesPatch(rel, rel, previous, next, '原内容', '新内容', { context: 2 })
        return {
          ok: true,
          summary: `dry-run：未写入。将${appended ? '追加到' : '覆盖'} ${rel}（${diffSummary}）`,
          detail: `以下是本次${appended ? '追加' : '覆盖'}的 diff 预览（未写入）：\n${patch.slice(0, 3_000)}${patch.length > 3_000 ? '\n…（预览已截断）' : ''}`,
        }
      }

      // M5：原子写（临时文件 → 检查中断 → rename）
      writeFileAtomic(full, next, ctx.signal)
      ctx.artifacts.markAuthor(ctx.sessionId, rel, ctx.agentId)
      return {
        ok: true,
        summary: appended
          ? `已追加到 ${rel}（+${humanSize(Buffer.byteLength(args.content))}，共 ${humanSize(Buffer.byteLength(next))}）`
          : exists
            ? `已覆盖 ${rel}（${diffSummary}）（${humanSize(Buffer.byteLength(next))}）`
            : `已写入 ${rel}（${humanSize(Buffer.byteLength(next))}）`,
        detail: `交付件 ${rel} 已写入工作区，可在交付件面板中查看。${healthNote(rel, next)}`,
        artifacts: [rel],
      }
    } catch (err) {
      if (isAbortLike(err)) throw err
      return failure(err)
    }
  },
}

const editFileTool = {
  name: 'edit_file',
  description:
    '对工作区内文件做精确替换编辑（old_text 必须逐字匹配）。小改动优先用它而不是 write_file 全量覆写，避免误删内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '工作区内相对路径' },
      old_text: { type: 'string', description: '被替换的原文（需唯一匹配，除非 replace_all）' },
      new_text: { type: 'string', description: '替换后的新文本' },
      replace_all: { type: 'boolean', description: '是否替换全部匹配（默认 false）' },
    },
    required: ['path', 'old_text', 'new_text'],
  },
  schema: z.object({
    path: z.string().min(1),
    old_text: z.string().min(1),
    new_text: z.string(),
    replace_all: z.boolean().default(false),
  }),
  async execute(
    args: { path: string; old_text: string; new_text: string; replace_all: boolean },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const full = resolveInRoot(ctx.workspace, args.path)
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
        return { ok: false, summary: `文件不存在：${args.path}` }
      }
      const guard = sensitiveRejection(relOf(ctx, full), ctx.allowSensitive, '修改')
      if (guard) return { ok: false, summary: guard }
      const source = fs.readFileSync(full, 'utf8')
      const count = source.split(args.old_text).length - 1
      if (count === 0) {
        return { ok: false, summary: `未命中：old_text 在 ${args.path} 中不存在，请先 read_file 核对原文` }
      }
      if (count > 1 && !args.replace_all) {
        return { ok: false, summary: `old_text 出现 ${count} 次，请提供更长上下文或设置 replace_all=true` }
      }
      const next = args.replace_all
        ? source.split(args.old_text).join(args.new_text)
        : source.replace(args.old_text, args.new_text)
      // M5：原子写（临时文件 → 检查中断 → rename）
      writeFileAtomic(full, next, ctx.signal)
      const rel = relOf(ctx, full)
      ctx.artifacts.markAuthor(ctx.sessionId, rel, ctx.agentId)
      return {
        ok: true,
        summary: `已编辑 ${rel}（替换 ${args.replace_all ? count : 1} 处）`,
        artifacts: [rel],
      }
    } catch (err) {
      if (isAbortLike(err)) throw err
      return failure(err)
    }
  },
}

const searchTextTool = {
  name: 'search_text',
  readOnly: true,
  description: '在工作区所有文件中检索内容（返回 文件:行号: 文本）。找定义、找引用、查关键词时用。',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: '检索词（默认按字面量匹配）' },
      max_results: { type: 'number', description: '最多返回条数（默认 50）' },
    },
    required: ['pattern'],
  },
  schema: z.object({ pattern: z.string().min(1), max_results: z.number().int().min(1).max(200).default(50) }),
  async execute(args: { pattern: string; max_results: number }, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const files = walkFiles(ctx.workspace)
      const hits: string[] = []
      for (const file of files) {
        const rel = relOf(ctx, file)
        // M5：敏感文件不参与检索（防凭据经检索逃逸）
        if (!ctx.allowSensitive && matchedSensitivePattern(rel)) continue
        let text: string
        try {
          text = fs.readFileSync(file, 'utf8')
        } catch {
          continue
        }
        if (text.includes('\u0000')) continue // 二进制跳过
        const lines = text.split('\n')
        for (let i = 0; i < lines.length && hits.length < args.max_results; i++) {
          if (lines[i].includes(args.pattern)) {
            hits.push(`${relOf(ctx, file)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`)
          }
        }
        if (hits.length >= args.max_results) break
      }
      if (hits.length === 0) return { ok: true, summary: `未找到「${args.pattern}」`, detail: '（0 条命中）' }
      return { ok: true, summary: `${hits.length} 条命中`, detail: hits.join('\n') }
    } catch (err) {
      return failure(err)
    }
  },
}

/** M25：remember scope → owner 解析（project 未关联项目时不可写）；M57：global 桶按用户切分 */
function resolveMemoryOwner(
  scope: MemoryScope,
  ctx: ToolRuntime,
): { ownerId: string } | { error: string } {
  switch (scope) {
    case 'agent':
      return { ownerId: ctx.agentId }
    case 'project':
      return ctx.projectId
        ? { ownerId: ctx.projectId }
        : { error: '本会话未关联项目，不能写入 project 记忆（可改用 session / agent / global）' }
    case 'global':
      // 多用户：global 记忆按用户隔离（owner = 用户 id）；单用户兼容模式回退旧口径 'global'
      return { ownerId: ctx.userId || 'global' }
    default:
      return { ownerId: ctx.sessionId }
  }
}

const rememberTool = {
  name: 'remember',
  description:
    '把关键结论写入长期记忆（默认会话记忆 <session_memory>，永不裁剪、每个回合都会注入）。可选 scope 归属：session 本会话 / agent 本成员跨会话 / project 本项目 / global 全局。历史消息会被摘要压缩，凡「后续必须记得」的结论必须用本工具记录，或写入工作区文件；重复内容自动去重。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['decision', 'constraint', 'glossary', 'fact', 'preference', 'lesson'],
        description:
          '记忆类型：decision 已确认决策 / constraint 约束与口径 / glossary 术语 / fact 客观事实 / preference 偏好 / lesson 经验教训',
      },
      content: { type: 'string', description: '凝练的结论（一句话，含必要口径与数字）' },
      scope: {
        type: 'string',
        enum: ['session', 'agent', 'project', 'global'],
        description: '归属范围（默认 session）：session 本会话 / agent 本成员跨会话 / project 本项目 / global 全局',
      },
      importance: { type: 'integer', minimum: 1, maximum: 5, description: '重要度 1-5（默认 3，影响召回排序）' },
      supersedes: { type: 'string', description: '被本条目取代的旧记忆 id（结论更新时传，旧条目标记 superseded）' },
    },
    required: ['kind', 'content'],
  },
  schema: z.object({
    kind: z.enum(['decision', 'constraint', 'glossary', 'fact', 'preference', 'lesson']),
    content: z.string().min(1).max(500),
    scope: z.enum(['session', 'agent', 'project', 'global']).optional(),
    importance: z.number().int().min(1).max(5).optional(),
    supersedes: z.string().min(1).optional(),
  }),
  async execute(
    args: { kind: MemoryKind; content: string; scope?: MemoryScope; importance?: number; supersedes?: string },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    const scope: MemoryScope = args.scope ?? 'session'
    const owner = resolveMemoryOwner(scope, ctx)
    if ('error' in owner) return { ok: false, summary: owner.error }
    const result = ctx.memory.upsertScoped(scope, owner.ownerId, args.kind, args.content, {
      source: `agent:${ctx.agentId}`,
      importance: args.importance,
      sourceSessionId: ctx.sessionId,
      sourceRunId: ctx.runId,
      userId: ctx.userId,
    })
    if (!result) return { ok: false, summary: '记忆内容不能为空' }
    // supersedes：仅同 scope+owner 的 active 旧条目可被取代（防跨作用域误伤）
    let supersededNote = ''
    if (args.supersedes && result.added) {
      const old = ctx.memory.get(args.supersedes)
      if (
        old &&
        old.status === 'active' &&
        old.scope === scope &&
        old.ownerId === owner.ownerId &&
        old.id !== result.item.id
      ) {
        ctx.memory.markSuperseded(old.id, result.item.id)
        supersededNote = `，已取代旧记忆「${old.content.slice(0, 40)}」`
      } else {
        supersededNote = '，supersedes 未命中可取代的旧记忆（已忽略）'
      }
    }
    void ctx.memories?.poke()
    return {
      ok: true,
      summary: result.added
        ? `已写入记忆（${args.kind}${scope === 'session' ? '' : `，scope=${scope}`}${supersededNote}）`
        : '该记忆已存在（去重命中，无需重复记录）',
      detail:
        scope === 'session'
          ? `「${args.content}」已记入会话记忆，后续所有回合都会看到，即使历史被压缩也不会丢失。`
          : `「${args.content}」已记入 ${scope} 记忆（跨会话生效），后续相关回合会通过语义召回注入。`,
    }
  },
}

const writeTodosTool = {
  name: 'write_todos',
  description:
    '维护本次任务的多步执行清单（规划与进度跟踪）。任务超过两步时先写清单，每完成一步更新一次。',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: '完整清单（覆盖式更新）',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  schema: z.object({
    todos: z.array(
      z.object({ content: z.string().min(1), status: z.enum(['pending', 'in_progress', 'done']) }),
    ),
  }),
  async execute(args: { todos: Array<{ content: string; status: 'pending' | 'in_progress' | 'done' }> }, ctx: ToolRuntime): Promise<ToolResult> {
    // M3：落库（覆盖式，跨 Run 继承）+ 内存镜像（同 Run 快速读取）
    const items = ctx.tasks.replace(
      ctx.sessionId,
      ctx.runId,
      args.todos.map((t) => ({ content: t.content, status: t.status, ownerAgentId: ctx.memberKey ?? ctx.agentId })),
    )
    ctx.todos.splice(0, ctx.todos.length, ...args.todos)
    const icon = { pending: '☐', in_progress: '◐', done: '☑' } as const
    const lines = args.todos.map((t) => `${icon[t.status]} ${t.content}`)
    return {
      ok: true,
      summary: `任务清单已更新（${args.todos.length} 项）`,
      detail: lines.join('\n'),
      tasks: items,
    }
  },
}

/** M87：交接包路径存在性（索引优先；未装配索引时回退磁盘校验，越界路径视为不存在） */
function artifactExists(ctx: ToolRuntime, relPath: string): boolean {
  try {
    if (ctx.index) return ctx.index.getMany(ctx.sessionId, [relPath]).length > 0
    return fs.statSync(resolveInRoot(ctx.workspace, relPath)).isFile()
  } catch {
    return false
  }
}

const handoffTool = {
  name: 'handoff',
  description:
    '结构化转交：把接力棒交给某位（或多位）成员（或 "user" 交还用户）。多目标 = 并行 fan-out：这些成员会同时开工、各自独立产出。有明确下游时优先用本工具，而不是只在正文里 @。目标尚未在场但资产存在时平台会自动召集后接手；完全未知的目标会收到错误提示，请按提示重选。转交时用 artifacts 列出接手方要用的交付物路径（省略时自动带出本轮已产出），notes 写清口径 / 验收 / 已知坑。',
  parameters: {
    type: 'object',
    properties: {
      target: {
        oneOf: [
          { type: 'string', description: '接手方：在场成员的 id 或姓名；或 "user" 表示交还用户结束本轮' },
          {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 4,
            description: '多位接手方（≤4）：并行 fan-out，各自独立产出；"user" 只能单独使用',
          },
        ],
      },
      reason: { type: 'string', description: '为什么转交给 TA（一句话）' },
      expected_output: { type: 'string', description: '期望接手方产出什么' },
      artifacts: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 8,
        description: '交接包：接手方需要查看的交付物路径（≤8，工作区相对路径；省略时自动带出本轮产出）',
      },
      notes: { type: 'string', description: '交接口径：约束 / 验收 / 已知坑（≤300 字）' },
    },
    required: ['target', 'reason'],
  },
  schema: z.object({
    target: z.union([z.string().min(1).max(40), z.array(z.string().min(1).max(40)).min(2).max(4, '并行目标最多 4 个')]),
    reason: z.string().min(1).max(200),
    expected_output: z.string().max(300).optional(),
    artifacts: z.array(z.string().min(1).max(300)).max(8, '交接包最多 8 个路径').optional(),
    notes: z.string().max(300).optional(),
  }),
  async execute(
    args: {
      target: string | string[]
      reason: string
      expected_output?: string
      artifacts?: string[]
      notes?: string
    },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    const rawList = (Array.isArray(args.target) ? args.target : [args.target])
      .map((t) => t.trim().replace(/^@/, ''))
      .filter((t) => t.length > 0)
    if (rawList.length === 0) return { ok: false, summary: '转交失败：target 不能为空' }
    const userHit = rawList.some((t) => USER_ALIASES.includes(t.toLowerCase()))
    if (userHit && rawList.length > 1) {
      return { ok: false, summary: '"user" 只能单独使用（多目标 = 并行 fan-out，交还用户 = 收尾语义）' }
    }
    // M87：交接包路径校验（索引优先；未知路径忽略并回灌提示，不拖累转交本身）
    const declared = [...new Set((args.artifacts ?? []).map((p) => normalizeRelPath(p)).filter((p): p is string => Boolean(p)))]
    const accepted: string[] = []
    const missing: string[] = []
    for (const relPath of declared.slice(0, 8)) {
      if (artifactExists(ctx, relPath)) accepted.push(relPath)
      else missing.push(relPath)
    }
    const packageNote = accepted.length > 0 ? `；交接包 ${accepted.length} 件` : ''
    const missingNote =
      missing.length > 0 ? `（${missing.length} 个交付物路径不存在已忽略：${missing.slice(0, 3).join('、')}）` : ''
    const extras = {
      ...(accepted.length > 0 ? { artifacts: accepted } : {}),
      ...(args.notes ? { notes: args.notes } : {}),
    }
    if (userHit) {
      return {
        ok: true,
        summary: `已交还用户（${args.reason}）${packageNote}`,
        detail: `转交意图已记录：→ user。原因：${args.reason}${args.notes ? `。口径：${args.notes}` : ''}${missingNote}`,
        handoff: { targets: ['user'], reason: args.reason, expected_output: args.expected_output, ...extras },
      }
    }
    // 逐个解析目标：在场成员直接放行；资产存在但未在场 → 放行并标注（M48：引擎收集 handoff 时自动召集，同一波内接手）
    const resolved: string[] = []
    const enlisted: Array<{ id: string; name: string }> = []
    const problems: string[] = []
    for (const raw of rawList) {
      const present = ctx.participants.find((p) => p.id === raw) ?? ctx.participants.find((p) => p.name === raw)
      if (present) {
        if (!resolved.includes(present.id)) resolved.push(present.id)
        continue
      }
      const asset = ctx.resolveAgent?.(raw)
      if (asset && !resolved.includes(asset.id)) {
        resolved.push(asset.id)
        enlisted.push(asset)
        continue
      }
      problems.push(`「${raw}」不在场`)
    }
    if (resolved.length === 0) {
      const names = ctx.participants.map((p) => `${p.name}(${p.id})`).join('、')
      return { ok: false, summary: `转交失败：${problems.join('；')}。可转交：${names}；或 "user" 交还用户` }
    }
    const nameOf = new Map([...ctx.participants, ...enlisted].map((p) => [p.id, p.name]))
    const names = resolved.map((id) => nameOf.get(id) ?? id).join('、')
    const parallel = resolved.length > 1
    const notes: string[] = []
    if (enlisted.length > 0) notes.push(`将自动召集：${enlisted.map((p) => p.name).join('、')}`)
    if (problems.length > 0) notes.push(`部分未转交：${problems.join('；')}`)
    const problemNote = notes.length > 0 ? `（${notes.join('；')}）` : ''
    // M86：手动接力——不自动接棒，只登记「建议下一棒」，由用户点按派发（引擎侧同样不会入队）
    if (ctx.relayMode === 'manual') {
      return {
        ok: true,
        summary: parallel ? `已记录并行派发建议 @${names}` : `已记录派发建议 @${names}`,
        detail: `当前会话为手动接力：已记录「建议下一棒 → ${resolved.join('、')}」，不会自动接棒，等待用户点按派发。原因：${args.reason}${
          args.expected_output ? `。期望产出：${args.expected_output}` : ''
        }${args.notes ? `。口径：${args.notes}` : ''}${problemNote}${missingNote}`,
        handoff: { targets: resolved, reason: args.reason, expected_output: args.expected_output, ...extras },
      }
    }
    return {
      ok: true,
      summary: `${parallel ? `已并行转交 @${names}` : `已转交 @${names}`}（${args.reason}）${packageNote}`,
      detail: `转交意图已记录：→ ${resolved.join('、')}${parallel ? '（并行 fan-out，各自独立产出）' : ''}。原因：${args.reason}${
        args.expected_output ? `。期望产出：${args.expected_output}` : ''
      }${args.notes ? `。口径：${args.notes}` : ''}${problemNote}${missingNote}`,
      handoff: { targets: resolved, reason: args.reason, expected_output: args.expected_output, ...extras },
    }
  },
}

const loadSkillTool = {
  name: 'load_skill',
  readOnly: true,
  description:
    '按名称加载技能（Skill）的操作手册正文。当任务与该技能描述的领域匹配时加载，按手册步骤执行。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名（见系统提示中的 available_skills 索引）' },
    },
    required: ['name'],
  },
  schema: z.object({ name: z.string().min(1) }),
  async execute(args: { name: string }, ctx: ToolRuntime): Promise<ToolResult> {
    const result = ctx.loadSkill(args.name)
    if (!result.ok) return { ok: false, summary: result.error ?? `技能不存在：${args.name}` }
    return {
      ok: true,
      summary: result.cached ? `技能 ${args.name}（缓存命中）` : `已加载技能 ${args.name}`,
      detail: result.body ?? '',
    }
  },
}

/** run_command 默认白名单前缀（M5 起可由 ALLOWED_COMMANDS 覆盖，§21.3） */
const DEFAULT_COMMAND_PREFIXES = ['npm test', 'npm run', 'npm -v', 'node -v', 'node --version', 'npx tsc', 'git status', 'git diff', 'git log']

/**
 * run_command 注入防护（审核 H-1）：白名单前缀匹配（startsWith）无法拦截 shell 元字符——
 * `npm test; curl evil`、`npm test && ...`、`npm test $(...)`、`npm test > file`、换行拼接等
 * 均以合法前缀开头。进入 shell 前做字符级拒绝；另拒绝 `KEY=VALUE` 前缀（防 NODE_OPTIONS / PATH 注入）。
 */
const SHELL_META_RE = /[;&|<>$`(){}[\]*?~!#\n\r\\]/
const ENV_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * M28：按需工具检索（渐进披露入口；核心常驻）。
 * 重型工具（浏览器 / 数据库 / Git / SSH / 联网 / 命令）与 MCP 工具默认不进清单，
 * 模型经本工具检索激活；命中工具写入 Run 级激活集合，下一子轮即可调用。
 */
const toolSearchTool = {
  name: 'tool_search',
  tier: 'core' as const,
  readOnly: true,
  description:
    '按需检索并激活更多工具（浏览器 / 数据库 / Git / SSH / 联网 / 命令 / MCP 服务器等默认未加载的能力）。当任务需要系统提示 <tool_discovery> 中列出的能力时，先用本工具检索：命中工具会立即激活并在本任务内持续可用。检索词用「要做的事」，中英文均可，如「查询数据库」「git 提交」「浏览器截图」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '需要的能力 / 要做的事（如「数据库查询」「打开网页并截图」）' },
      limit: { type: 'number', description: '最多激活几个工具（1-10，默认 5）' },
    },
    required: ['query'],
  },
  schema: z.object({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }),
  async execute(args: { query: string; limit?: number }, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.searchTools) {
      // M47：未装配检索内核 = 全部工具已直接可用（非失败语义，防红卡与无谓重试）
      return { ok: true, summary: '当前所有工具均已直接可用，无需检索' }
    }
    const outcome = await ctx.searchTools(args.query, args.limit)
    if (!outcome.ok) return { ok: false, summary: outcome.error ?? '工具检索失败' }
    const activated = outcome.activated ?? []
    if (activated.length === 0) {
      // M47：发现未启用（全部工具已在清单）→ 直接可用提示；真正空命中才给改写建议
      if (outcome.direct) return { ok: true, summary: outcome.note ?? '当前所有工具均已直接可用，无需检索' }
      return {
        ok: true,
        summary: '未命中可用工具',
        detail: outcome.note ?? '没有匹配的工具，请换用更通用的关键词重试。',
      }
    }
    const lines = activated.map(
      (t) =>
        `- ${t.name}${t.server ? `（MCP · ${t.server}）` : ''}：${t.description.replace(/\s+/g, ' ').slice(0, 160)}`,
    )
    return {
      ok: true,
      summary: `已激活 ${activated.length} 个工具：${activated.map((t) => t.name).join('、')}`,
      detail: `以下工具已加入工具清单，下一轮可直接调用（本任务内持续可用）：\n${lines.join('\n')}${
        outcome.note ? `\n\n${outcome.note}` : ''
      }`,
    }
  },
}

const runCommandTool = {
  name: 'run_command',
  tier: 'deferred' as const,
  description:
    '在工作区执行受限命令（测试 / 构建 / 版本检查）。默认关闭；仅在用户明确开启后可用，且仅允许白名单命令。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '完整命令（白名单前缀）' },
    },
    required: ['command'],
  },
  schema: z.object({ command: z.string().min(1) }),
  async execute(args: { command: string }, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.allowRunCommand) {
      return { ok: false, summary: RUN_COMMAND_DISABLED_SUMMARY }
    }
    // M5：白名单配置化（ALLOWED_COMMANDS 非空时覆盖内置默认表）
    const prefixes = ctx.allowedCommands.length > 0 ? ctx.allowedCommands : DEFAULT_COMMAND_PREFIXES
    const command = args.command.trim()
    // 审核 H-1：元字符检查必须先于白名单前缀匹配（否则前缀合法 + 拼接注入仍会被执行）
    const meta = SHELL_META_RE.exec(command)
    if (meta) {
      return {
        ok: false,
        summary: `命令包含不允许的 shell 元字符（${JSON.stringify(meta[0])}），已拒绝执行`,
        detail: 'run_command 仅支持白名单内的单条命令，不支持管道 / 重定向 / 命令替换 / 通配 / 多条拼接。',
      }
    }
    if (ENV_PREFIX_RE.test(command)) {
      return { ok: false, summary: '命令不允许以环境变量赋值开头（防 NODE_OPTIONS / PATH 注入）' }
    }
    if (!prefixes.some((p) => command.startsWith(p))) {
      return { ok: false, summary: `命令不在白名单内（允许前缀：${prefixes.join(' / ')}）` }
    }
    try {
      const { stdout, stderr } = await exec(command, {
        cwd: ctx.workspace,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        shell: '/bin/sh',
        // M5：真中断——回合停止 / 超时联动时 kill 子进程
        signal: ctx.signal,
      })
      const out = `${stdout}${stderr ? `\n[stderr]\n${stderr}` : ''}`.trim().slice(0, 4000)
      return { ok: true, summary: `命令执行完成（exit 0）`, detail: out || '（无输出）' }
    } catch (err) {
      if (isAbortLike(err)) throw toolAbortError()
      const e = err as { stdout?: string; stderr?: string; message: string }
      const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim().slice(0, 2000)
      return { ok: false, summary: `命令执行失败：${e.message.slice(0, 160)}`, detail: out || undefined }
    }
  },
}

/** 注册全部内置工具（run_command 始终注册，执行时检查开关，保证提示词可见性与错误提示一致） */
export function createToolRegistry(cfg: AppConfig): ToolRegistry {
  const registry = new ToolRegistry(cfg.toolTimeoutMs)
  for (const tool of [
    listDirTool,
    readFileTool,
    writeFileTool,
    editFileTool,
    applyPatchTool,
    searchTextTool,
    globTool,
    grepTool,
    webFetchTool,
    webSearchTool,
    // M21.2：业务工具集（计算 / 日期 / 表格 / 模板；金额日期纪律见 agents/_protocol.md）
    calcTool,
    dateCalcTool,
    csvAnalyzeTool,
    templateFillTool,
    rememberTool,
    handoffTool,
    writeTodosTool,
    loadSkillTool,
    // M28：按需工具检索（渐进披露入口；核心常驻）
    toolSearchTool,
    runCommandTool,
    // M6：Git 工具集（repo / worktree 模式下可用，执行时校验仓库）
    ...gitTools,
    // M7：审批请求（高危动作前由模型主动发起，引擎挂起等待用户决定）
    ...createApprovalTools(),
    // M22：连接中心（数据库查询 / 写入 + 浏览器自动化）
    ...createDbTools(),
    ...createBrowserTools(),
    // M23：SSH 远程命令（allowExec 开关 + 审批门 + 审计）
    ...createSshTools(),
    // M24：范式工具（可见性由 ToolRegistry.forAgent(mode) 门控；execute 范式不受影响）
    ...createPlanTools(),
    // M31：画布创作（画布读写 / 媒体生成；tier=deferred，经 tool_search 检索激活）
    ...createCanvasTools(),
    ...createMediaTools(),
    // M35：定时任务（创建 / 查看 / 管理；tier=deferred，经 tool_search 检索激活）
    ...createScheduleTools(),
    // M51-E：命理排盘（bazi_pan / ziwei_pan / natal_pan / gua_pan；tier=deferred，经 tool_search「排盘 / 命盘 / 星盘」检索激活）
    ...createPanTools(),
    // M69：场景玩法（dice_roll / tarot_draw；tier=deferred，经 tool_search「掷骰 / 骰子 / 塔罗 / 抽牌」检索激活）
    ...createDiceTools(),
    ...createTarotTools(),
    // M66-A：罗盘排盘（luopan_pan；tier=deferred，经 tool_search「罗盘 / 风水 / 堪舆 / 阳宅 / 坐向 / 飞星」检索激活）
    ...createLuopanTools(),
    // M66 续完善：择日排盘（zeri_pan；tier=deferred，经 tool_search「择日 / 日课 / 吉日 / 黄道 / 建除」检索激活）
    ...createZeriTools(),
  ]) {
    registry.register(tool)
  }
  // M34：金融投研工具集（FINANCE_ENABLED=false 时整体不注册：工具中心无噪音，tool_search 不可见）
  if (cfg.financeEnabled) {
    for (const tool of [...createFinanceTools(cfg), ...createFinanceQuantTools(cfg)]) registry.register(tool)
  } else {
    // M47：整组关闭 → 登记精确「未启用」提示（人设/白名单仍引用 fin_* 时，执行期给出可行动指引而非「未知工具」）
    const financeTools = [...createFinanceTools(cfg), ...createFinanceQuantTools(cfg)]
    registry.markUnavailable(financeTools.map((tool) => tool.name), FINANCE_DISABLED_SUMMARY)
  }
  return registry
}
