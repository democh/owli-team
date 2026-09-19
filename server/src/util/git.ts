/**
 * Git 执行封装（M6）：统一走 `execFile('git', args[])` 参数数组，**禁止 shell 字符串拼接**。
 *
 * 安全约定：
 * - 所有会被 git 当作「选项」解析的参数（ref / 分支名 / 路径）先过 `assertSafeRef` 校验，
 *   拒绝以 `-` 开头（防 `--output=` / `--upload-pack=` 之类的选项注入）与控制字符；
 * - worktree / 仓库根路径必须来自服务端解析结果（ProjectStore / WorkspaceService），不接受模型输入；
 * - 错误统一转中文摘要，stderr 截断后作为 detail 返回给模型。
 */
import { execFile } from 'node:child_process'

export interface GitRunResult {
  ok: boolean
  stdout: string
  stderr: string
  /** 进程退出码（超时 / 被杀为 -1） */
  code: number
}

export interface GitRunOptions {
  timeoutMs?: number
  signal?: AbortSignal
  /** 注入 git 的身份信息（工作区可能没有全局 user.name/email） */
  env?: NodeJS.ProcessEnv
}

/** 参数形态校验：拒绝选项注入与不可见字符 */
export function assertSafeRef(value: string, label: string): string {
  const v = value.trim()
  if (!v) throw new Error(`${label}不能为空`)
  if (v.length > 200) throw new Error(`${label}过长（>200 字符）`)
  if (v.startsWith('-')) throw new Error(`${label}不能以 "-" 开头（防选项注入）：${v}`)
  if (/[\0\n\r]/.test(v)) throw new Error(`${label}含非法字符（换行 / NUL）`)
  if (v.includes('..') && v.includes(':')) throw new Error(`${label}含非法引用组合：${v}`)
  return v
}

/** 分支 / ref 名：仅允许常见安全字符 */
export function assertBranchName(value: string, label = '分支名'): string {
  const v = assertSafeRef(value, label)
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) throw new Error(`${label}含非法字符（仅允许字母、数字、._/-）：${v}`)
  if (v.endsWith('/') || v.endsWith('.') || v.includes('//')) throw new Error(`${label}格式非法：${v}`)
  return v
}

/** 中断判定（execFile 被 signal abort 时的错误形态） */
export function isGitAbort(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string }
  return e?.name === 'AbortError' || e?.code === 'ABORT_ERR' || (e?.message ?? '').includes('aborted')
}

/** 执行 git 命令（不经过 shell；cwd 为仓库 / worktree 根；信号中断时 reject） */
export function runGit(cwd: string, args: string[], opts: GitRunOptions = {}): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        timeout: opts.timeoutMs ?? 15_000,
        maxBuffer: 4 * 1024 * 1024,
        signal: opts.signal,
        env: opts.env ?? process.env,
      },
      (error, stdout, stderr) => {
        if (error && isGitAbort(error)) {
          // 中断：交给工具层统一转 ToolAbortError（不重试、不落副作用）
          reject(error)
          return
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : error ? -1 : 0
        resolve({
          ok: !error,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code,
        })
      },
    )
  })
}

/** 判断目录是否在 git 仓库内（返回仓库根；不是仓库返回 null） */
export async function gitRepoRoot(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel'])
  if (!result.ok) return null
  const root = result.stdout.trim()
  return root || null
}

/** 当前分支名（detached 时返回空串） */
export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await runGit(cwd, ['branch', '--show-current'])
  return result.ok ? result.stdout.trim() : ''
}

/** git 身份环境（测试与无全局配置的环境使用） */
export function gitIdentityEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'multi-agent',
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'agent@local',
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'multi-agent',
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'agent@local',
  }
}

/** 错误摘要（给模型看的可修正信息） */
export function gitFailure(result: GitRunResult, fallback = 'git 命令执行失败'): string {
  const message = (result.stderr || result.stdout).trim().split('\n')[0] ?? ''
  return message ? `${fallback}：${message.slice(0, 300)}` : fallback
}
