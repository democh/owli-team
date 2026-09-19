/**
 * Git 工具集（M6）：git_status / git_diff / git_log / git_branch / git_commit / git_restore。
 *
 * 安全约定（与 util/git.ts 配合）：
 * - 全部 `execFile('git', args[])` 参数数组执行，**禁止 shell 字符串拼接**；
 * - range / 分支名先过 `assertSafeRef`（拒绝 `-` 开头的选项注入与控制字符）；
 * - 文件路径必须落在会话工作区内（resolveInRoot），以相对路径传给 git（`--` 分隔）；
 * - git_commit / git_branch / git_restore 为写类（串行执行 + 破坏缓存）；git_commit 在 M7 强制走审批。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { PathEscapeError, resolveInRoot } from '../util/paths.js'
import {
  assertBranchName,
  assertSafeRef,
  gitFailure,
  gitIdentityEnv,
  gitRepoRoot,
  isGitAbort,
  runGit,
} from '../util/git.js'
import { toolAbortError, type ToolResult, type ToolRuntime } from './registry.js'

const MAX_DIFF_CHARS = 8_000

function failure(err: unknown): ToolResult {
  if (err instanceof PathEscapeError) return { ok: false, summary: err.message }
  return { ok: false, summary: `执行失败：${(err as Error).message.slice(0, 300)}` }
}

/** 每个工具执行前确认工作区是 git 仓库；返回 cwd（会话工作区根） */
async function ensureRepo(ctx: ToolRuntime): Promise<{ cwd: string } | { error: ToolResult }> {
  const root = await gitRepoRoot(ctx.workspace)
  if (!root) {
    return {
      error: {
        ok: false,
        summary: '当前工作区不是 git 仓库',
        detail: 'git 工具仅在「真实仓库」项目中可用（项目的 workspaceMode 为 repo / worktree）。',
      },
    }
  }
  return { cwd: ctx.workspace }
}

/** 工作区内相对路径（git 的 path 参数；拒绝工作区根本身）
 *  注意：resolveInRoot 返回 realpath 归一形式，相对计算须对齐 base（macOS /var → /private/var）。 */
function relInWorkspace(ctx: ToolRuntime, input: string): string {
  const full = resolveInRoot(ctx.workspace, input)
  const base = fs.existsSync(ctx.workspace) ? fs.realpathSync(ctx.workspace) : path.resolve(ctx.workspace)
  const rel = path.relative(base, full).split(path.sep).join('/')
  if (!rel || rel === '.' || rel.startsWith('..')) throw new Error('path 不能是工作区根目录，请指定具体文件')
  return rel
}

const gitStatusTool = {
  name: 'git_status',
  readOnly: true,
  description:
    '查看当前工作区的 git 状态：当前分支 + 未提交的变更文件列表（含新增/修改/删除）。动代码前后都应先看一眼。',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}),
  async execute(_args: Record<string, never>, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      const result = await runGit(repo.cwd, ['status', '--porcelain=v1', '--branch'])
      if (!result.ok) return { ok: false, summary: gitFailure(result, 'git status 失败') }
      const lines = result.stdout.split('\n').filter((l) => l.trim())
      const branchLine = lines.find((l) => l.startsWith('##')) ?? ''
      const branch = branchLine.replace(/^##\s*/, '').split('...')[0] ?? ''
      const changes = lines.filter((l) => !l.startsWith('##'))
      if (changes.length === 0) {
        return {
          ok: true,
          summary: `分支 ${branch || '(detached)'} · 工作区干净`,
          detail: '没有未提交的变更。',
        }
      }
      const parsed = changes.map((l) => `${l.slice(0, 2).trim() || '?'} ${l.slice(3)}`)
      return {
        ok: true,
        summary: `分支 ${branch || '(detached)'} · ${changes.length} 个文件有变更`,
        detail: parsed.join('\n'),
      }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

const gitDiffTool = {
  name: 'git_diff',
  readOnly: true,
  description:
    '查看改动内容（unified diff）。默认看工作区未暂存改动；staged=true 看已暂存；range 可指定比较范围（如 HEAD~1 或 main..HEAD）；path 限定单个文件。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '仅看该文件（工作区内相对路径，可选）' },
      staged: { type: 'boolean', description: '查看已暂存（git add 后）的改动，默认 false' },
      range: {
        type: 'string',
        description: '比较范围（如 HEAD~1 / main..HEAD / <commit>），默认工作区 vs 索引',
      },
    },
  },
  schema: z.object({
    path: z.string().optional(),
    staged: z.boolean().default(false),
    range: z.string().max(200).optional(),
  }),
  async execute(
    args: { path?: string; staged: boolean; range?: string },
    ctx: ToolRuntime,
  ): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      const gitArgs = ['diff']
      if (args.staged) gitArgs.push('--staged')
      if (args.range) {
        const range = assertSafeRef(args.range, 'range')
        if (!/^[A-Za-z0-9_./~^@{}-]+$/.test(range) || range.includes('--')) {
          return { ok: false, summary: `range 含非法字符：${range}（示例：HEAD~1 / main..HEAD）` }
        }
        gitArgs.push(range)
      }
      if (args.path) gitArgs.push('--', relInWorkspace(ctx, args.path))
      const result = await runGit(repo.cwd, gitArgs)
      if (!result.ok) return { ok: false, summary: gitFailure(result, 'git diff 失败') }
      if (!result.stdout.trim()) {
        return { ok: true, summary: '无差异', detail: '该范围内没有改动。' }
      }
      const truncated = result.stdout.length > MAX_DIFF_CHARS
      return {
        ok: true,
        summary: `diff 输出 ${result.stdout.split('\n').length} 行${truncated ? '（已截断）' : ''}`,
        detail: truncated
          ? `${result.stdout.slice(0, MAX_DIFF_CHARS)}\n…（diff 已截断，可用 path 参数查看单文件）`
          : result.stdout,
      }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

const gitLogTool = {
  name: 'git_log',
  readOnly: true,
  description: '查看提交历史（单行摘要，含分支装饰）。接手他人上下文时先看最近提交了解进度。',
  parameters: {
    type: 'object',
    properties: { limit: { type: 'number', description: '条数（默认 10，上限 50）' } },
  },
  schema: z.object({ limit: z.number().int().min(1).max(50).default(10) }),
  async execute(args: { limit: number }, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      const result = await runGit(repo.cwd, ['log', '--oneline', '--decorate', '-n', String(args.limit)])
      if (!result.ok) {
        return { ok: false, summary: gitFailure(result, 'git log 失败（可能还没有任何提交）') }
      }
      const out = result.stdout.trim()
      if (!out) return { ok: true, summary: '没有提交记录', detail: '仓库还没有任何提交。' }
      return { ok: true, summary: `最近 ${out.split('\n').length} 条提交`, detail: out }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

const gitBranchTool = {
  name: 'git_branch',
  description:
    '查看 / 创建 / 切换分支。无参数列出本地分支；create 新建并切换（git switch -c）；checkout 切换到已有分支。切换会改变工作区文件内容，切换前先 git_status 确认无未提交改动（有改动时切换可能失败或带过去）。',
  parameters: {
    type: 'object',
    properties: {
      create: { type: 'string', description: '新建并切换到该分支名（可选）' },
      checkout: { type: 'string', description: '切换到已有分支名（可选）' },
    },
  },
  schema: z.object({ create: z.string().max(200).optional(), checkout: z.string().max(200).optional() }),
  async execute(args: { create?: string; checkout?: string }, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      if (args.create) {
        const name = assertBranchName(args.create)
        const result = await runGit(repo.cwd, ['switch', '-c', name], { env: gitIdentityEnv() })
        if (!result.ok) return { ok: false, summary: gitFailure(result, `创建分支 ${name} 失败`) }
        return {
          ok: true,
          summary: `已创建并切换到分支 ${name}`,
          detail: result.stdout.trim() || result.stderr.trim(),
        }
      }
      if (args.checkout) {
        const name = assertBranchName(args.checkout)
        const result = await runGit(repo.cwd, ['switch', name])
        if (!result.ok)
          return { ok: false, summary: gitFailure(result, `切换分支 ${name} 失败（分支是否存在？）`) }
        return {
          ok: true,
          summary: `已切换到分支 ${name}`,
          detail: result.stdout.trim() || result.stderr.trim(),
        }
      }
      const result = await runGit(repo.cwd, [
        'branch',
        '--list',
        '--format=%(refname:short)%(if)%(HEAD)%(then) *%(end)',
      ])
      if (!result.ok) return { ok: false, summary: gitFailure(result, '列出分支失败') }
      const out = result.stdout.trim()
      return {
        ok: true,
        summary: `本地分支 ${out ? out.split('\n').length : 0} 个（* = 当前）`,
        detail: out || '（无分支）',
      }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

const gitCommitTool = {
  name: 'git_commit',
  description:
    '提交当前工作区的全部改动（git add -A + commit）。提交前建议先 git_status / git_diff 确认改动范围。该操作需要用户审批。',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: '提交信息（一句话说明本次改动）' } },
    required: ['message'],
  },
  schema: z.object({ message: z.string().min(1).max(200) }),
  async execute(args: { message: string }, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      const status = await runGit(repo.cwd, ['status', '--porcelain'])
      if (!status.ok) return { ok: false, summary: gitFailure(status, 'git status 失败') }
      if (!status.stdout.trim())
        return { ok: true, summary: '无变更可提交', detail: '工作区干净，没有需要提交的改动。' }
      const add = await runGit(repo.cwd, ['add', '-A'])
      if (!add.ok) return { ok: false, summary: gitFailure(add, 'git add 失败') }
      const commit = await runGit(repo.cwd, ['commit', '-m', args.message], { env: gitIdentityEnv() })
      if (!commit.ok) return { ok: false, summary: gitFailure(commit, '提交失败') }
      const hash = await runGit(repo.cwd, ['rev-parse', '--short', 'HEAD'])
      const short = hash.ok ? hash.stdout.trim() : ''
      return {
        ok: true,
        summary: `已提交${short ? `（${short}）` : ''}：${args.message}`,
        detail: commit.stdout.trim().slice(0, 1_500),
      }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

const gitRestoreTool = {
  name: 'git_restore',
  description:
    '还原文件到最近提交的状态（丢弃未提交改动）。必须指定 path，避免误伤整个工作区；staged=true 时仅从暂存区撤回。丢弃工作区改动不可逆，该操作需要用户审批。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要还原的文件（工作区内相对路径）' },
      staged: { type: 'boolean', description: '仅撤回暂存（保留工作区改动），默认 false = 丢弃工作区改动' },
    },
    required: ['path'],
  },
  schema: z.object({ path: z.string().min(1), staged: z.boolean().default(false) }),
  async execute(args: { path: string; staged: boolean }, ctx: ToolRuntime): Promise<ToolResult> {
    try {
      const repo = await ensureRepo(ctx)
      if ('error' in repo) return repo.error
      const rel = relInWorkspace(ctx, args.path)
      const gitArgs = ['restore']
      if (args.staged) gitArgs.push('--staged')
      gitArgs.push('--', rel)
      const result = await runGit(repo.cwd, gitArgs)
      if (!result.ok) return { ok: false, summary: gitFailure(result, `还原 ${rel} 失败`) }
      return {
        ok: true,
        summary: args.staged ? `已撤回暂存：${rel}` : `已还原 ${rel}（未提交改动已丢弃）`,
        detail: result.stderr.trim() || result.stdout.trim() || '完成',
      }
    } catch (err) {
      if (isGitAbort(err)) throw toolAbortError()
      return failure(err)
    }
  },
}

/** M28：Git 工具组默认延迟（不在常驻清单；经 tool_search 激活后本 Run 内可用） */
export const gitTools = [
  gitStatusTool,
  gitDiffTool,
  gitLogTool,
  gitBranchTool,
  gitCommitTool,
  gitRestoreTool,
].map((tool) => ({ ...tool, tier: 'deferred' as const }))
