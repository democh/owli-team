/**
 * apply_patch 工具（M5）：应用 unified diff 补丁修改工作区文件（多文件、可新建）。
 *
 * 策略：解析 → 全量校验（逐文件试应用，不落盘）→ 统一原子写入。
 * 任一段失败即整份拒绝，并回灌「最相近片段」帮助模型自我修正。
 * 3 类错位场景均给出可修正错误：
 * 1. 目标文件不存在（非新建补丁）/ 新建补丁撞已有文件；
 * 2. hunk 行号越界（补丁基于旧版本）；
 * 3. 上下文不匹配（内容已被改动，提示相似内容实际所在行）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { applyPatch, parsePatch, type StructuredPatch, type StructuredPatchHunk } from 'diff'
import { z } from 'zod'
import { PathEscapeError, resolveInRoot, writeFileAtomic } from '../util/paths.js'
import { sensitiveRejection } from './sensitive.js'
import { toolAbortError, type ToolRuntime, type ToolResult } from './registry.js'

/** 去掉 git 前缀 a/ b/（也容忍裸路径与 /dev/null） */
function stripPrefix(name: string | undefined): string {
  if (!name) return ''
  if (name === '/dev/null') return name
  return name.replace(/^[ab]\//, '')
}

function relOf(ctx: ToolRuntime, full: string): string {
  const base = fs.existsSync(ctx.workspace) ? fs.realpathSync(ctx.workspace) : path.resolve(ctx.workspace)
  return path.relative(base, full).split(path.sep).join('/')
}

/** 上下文不匹配时的「最相近片段」定位：用 hunk 首条内容行在文件中反查实际行号 */
function locateHint(source: string, hunk: StructuredPatchHunk, rel: string): string {
  const anchor = hunk.lines
    .filter((l) => (l.startsWith(' ') || l.startsWith('-')) && l.slice(1).trim().length >= 3)
    .map((l) => l.slice(1).trim())
    .find(Boolean)
  if (anchor) {
    const lines = source.split('\n')
    const idx = lines.findIndex((l) => l.includes(anchor))
    if (idx >= 0) {
      const from = Math.max(1, idx - 2)
      return `hunk 期望在第 ${hunk.oldStart} 行附近修改，但上下文不匹配；相似内容实际位于第 ${idx + 1} 行附近。请 read_file(path="${rel}", offset=${from}, limit=20) 核对最新内容后重新生成补丁。`
    }
  }
  return `hunk 期望在第 ${hunk.oldStart} 行附近修改，但文件中未找到对应上下文。请 read_file(path="${rel}") 核对最新内容后重新生成补丁。`
}

interface PendingFile {
  rel: string
  full: string
  next: string
  added: number
  removed: number
  created: boolean
}

export const applyPatchTool = {
  name: 'apply_patch',
  description:
    '应用 unified diff 补丁修改工作区文件（支持多文件与新建文件）。对已有文件做小范围改动时优先用它而不是 write_file 全量覆写。补丁上下文不匹配时会返回可修正提示。',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description:
          'unified diff 补丁文本（git diff 风格，可含多个 ---/+++ 文件段；新建文件用 --- /dev/null）',
      },
    },
    required: ['patch'],
  },
  schema: z.object({ patch: z.string().min(1) }),
  async execute(args: { patch: string }, ctx: ToolRuntime): Promise<ToolResult> {
    let files: StructuredPatch[]
    try {
      files = parsePatch(args.patch)
    } catch (err) {
      return {
        ok: false,
        summary: `补丁格式无法解析：${(err as Error).message.slice(0, 120)}`,
        detail: '请提供标准 unified diff（包含 --- 原文件 / +++ 新文件 头与 @@ 行）。',
      }
    }
    if (files.length === 0) {
      return { ok: false, summary: '补丁为空：未找到任何文件段（需包含 ---/+++ 文件头）' }
    }

    const pending: PendingFile[] = []
    const seen = new Set<string>()

    // ---- 阶段 1：全量校验（不落盘；任一文件失败 → 整份拒绝） ----
    for (const file of files) {
      if (ctx.signal?.aborted) throw toolAbortError()
      if (file.isBinary) {
        return {
          ok: false,
          summary: '不支持二进制文件的补丁（Binary files differ）',
          detail: '请改用 write_file 或其他方式处理二进制内容。',
        }
      }
      if (file.isRename) {
        return { ok: false, summary: '不支持重命名补丁（rename）', detail: '请分别新建 / 删除文件，并征得用户确认。' }
      }
      const oldName = stripPrefix(file.oldFileName)
      const newName = stripPrefix(file.newFileName)
      if (newName === '/dev/null') {
        return { ok: false, summary: `apply_patch 不支持删除文件（${oldName}），请征得用户确认后手动处理` }
      }
      const targetName = newName || oldName
      if (!targetName || targetName === '/dev/null') {
        return { ok: false, summary: '补丁缺少目标文件路径（---/+++ 行）' }
      }
      if (file.hunks.length === 0) continue // 无内容改动（纯元信息段）→ 跳过

      let full: string
      try {
        full = resolveInRoot(ctx.workspace, targetName)
      } catch (err) {
        if (err instanceof PathEscapeError) return { ok: false, summary: err.message }
        throw err
      }
      const rel = relOf(ctx, full)
      const guard = sensitiveRejection(rel, ctx.allowSensitive, '修改')
      if (guard) return { ok: false, summary: guard }
      if (seen.has(full)) continue
      seen.add(full)

      const created = oldName === '/dev/null' || file.isCreate === true
      const exists = fs.existsSync(full) && fs.statSync(full).isFile()
      if (!exists && !created) {
        return {
          ok: false,
          summary: `目标文件不存在：${rel}（补丁基于已有文件）`,
          detail: '若确需新建文件，请在补丁中使用 "--- /dev/null"；或先核对路径（list_dir / glob）。',
        }
      }
      if (exists && created) {
        return {
          ok: false,
          summary: `补丁声明新建 ${rel}，但该文件已存在`,
          detail: '可能是补丁被重复应用；如确需覆盖，请改用「修改」形式补丁（--- a/路径 / +++ b/路径）。',
        }
      }

      const source = exists ? fs.readFileSync(full, 'utf8') : ''
      const totalLines = source === '' ? 0 : source.split('\n').length

      // 行号越界预检（比 applyPatch=false 更精确的错误）
      const oob = file.hunks.find((h) => h.oldLines > 0 && !created && h.oldStart > Math.max(totalLines, 1))
      if (oob) {
        return {
          ok: false,
          summary: `hunk 定位越界：期望从第 ${oob.oldStart} 行开始，但 ${rel} 仅有 ${totalLines} 行`,
          detail: `补丁可能基于旧版本生成。请 read_file(path="${rel}") 核对最新内容后重新生成补丁。`,
        }
      }

      const applied = applyPatch(source, file)
      if (applied === false) {
        return {
          ok: false,
          summary: `补丁应用失败（上下文不匹配）：${rel}`,
          detail: locateHint(source, file.hunks[0], rel),
        }
      }
      const added = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('+')).length, 0)
      const removed = file.hunks.reduce((n, h) => n + h.lines.filter((l) => l.startsWith('-')).length, 0)
      pending.push({ rel, full, next: applied, added, removed, created })
    }

    if (pending.length === 0) return { ok: false, summary: '补丁未包含可应用的改动' }
    if (ctx.signal?.aborted) throw toolAbortError()

    // ---- 阶段 2：统一原子写入（每个文件独立原子；中断时保留已写文件） ----
    const details: string[] = []
    for (const p of pending) {
      writeFileAtomic(p.full, p.next, ctx.signal)
      ctx.artifacts.markAuthor(ctx.sessionId, p.rel, ctx.agentId)
      details.push(`${p.created ? '新建' : '修改'} ${p.rel}（+${p.added}/-${p.removed}）`)
    }
    return {
      ok: true,
      summary: `已应用补丁：${pending.length} 个文件`,
      detail: details.join('\n'),
      artifacts: pending.map((p) => p.rel),
    }
  },
}
