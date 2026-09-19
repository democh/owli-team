/**
 * M6 项目层与真实仓库测试：
 * - ProjectStore：ALLOWED_ROOTS 白名单（空 / 白名单外 / 不存在 / 非目录 / 子路径）、mode 校验；
 * - worktree 隔离：创建会话 → worktree 目录 + agent/<sid> 分支；工具改动只在 worktree；
 *   查看改动（变更集 + diff）→ 合并 → 主仓库更新；丢弃 → 目录 / 分支删除、主仓库无痕；
 * - repo 模式：直接挂载，isGitMode=交付件走 git 变更集；
 * - Git 工具集：status / diff（三种模式）/ log / branch / commit / restore；
 * - 参数注入防护：`-` 开头、非法字符、路径逃逸、含空格文件名（execFile 参数数组）；
 * - run_command：cwd 限定在 worktree 内；
 * - 引擎集成：后端角色改文件 → 变更只在 agent 分支，主分支不受影响（计划验收原文）。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { WorkspaceMode } from '@multi-agent/shared'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { abortError } from '../src/llm/provider.js'
import type { ToolResult, ToolRuntime } from '../src/tools/registry.js'
import { gitIdentityEnv } from '../src/util/git.js'
import { makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

const GIT_ENV = gitIdentityEnv()

function gitSync(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' })
}

/** 初始化一个含初始提交的临时 git 仓库 */
function initGitRepo(dir: string): void {
  gitSync(dir, ['init', '-b', 'main'])
  fs.writeFileSync(path.join(dir, 'README.md'), '# 初始内容\n')
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const v = 1\n')
  gitSync(dir, ['add', '-A'])
  gitSync(dir, ['commit', '-m', 'init'])
}

function makeRepoEnv() {
  const repoDir = makeTmpDir('ma-m6-repo-')
  initGitRepo(repoDir)
  const env = makeEnv({ allowedRoots: [repoDir], approvalMode: 'off' })
  return { env, repoDir }
}

function runtimeFor(
  env: ReturnType<typeof makeEnv>,
  sessionId: string,
  workspace: string,
  overrides: Partial<ToolRuntime> = {},
): ToolRuntime {
  return {
    sessionId,
    runId: 'r-m6',
    agentId: 'backend',
    workspace,
    artifacts: env.artifacts,
    skills: env.skills,
    memory: env.memory,
    tasks: env.tasks,
    participants: [{ id: 'backend', name: '马克斯' }],
    todos: [],
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: '测试未提供技能' }),
    ...overrides,
  }
}

/** 工具执行辅助：清只读缓存后直连 registry（用例中文件系统状态频繁变化，避免陈旧缓存命中） */
async function runTool(
  env: ReturnType<typeof makeEnv>,
  name: string,
  args: Record<string, unknown>,
  rt: ToolRuntime,
): Promise<ToolResult> {
  env.tools.clearReadCache()
  return env.tools.execWithAbort(name, args, rt)
}

/** 建项目 + 会话并准备 worktree 工作区 */
async function createWorktreeSession(env: ReturnType<typeof makeEnv>, repoDir: string) {
  const project = env.projects.create({ name: '演示仓库', rootPath: repoDir, workspaceMode: 'worktree' })
  const session = env.sessions.create(['backend'], 'M6 会话', { projectId: project.id })
  await env.workspace.prepare(session)
  return { project, session, root: session.workspaceDir! }
}

// ---------- ProjectStore 与 ALLOWED_ROOTS ----------

describe('M6：ProjectStore 与 ALLOWED_ROOTS', () => {
  it('白名单为空 → 拒绝创建真实仓库项目', () => {
    const env = makeEnv({ allowedRoots: [] })
    expect(() => env.projects.create({ name: 'x', rootPath: makeTmpDir() })).toThrow(/未配置 ALLOWED_ROOTS/)
  })

  it('白名单外 / 不存在 / 非目录 → 拒绝；白名单内与子路径 → 成功', () => {
    const { env, repoDir } = makeRepoEnv()
    const other = makeTmpDir('ma-m6-other-')
    expect(() => env.projects.create({ name: 'x', rootPath: other })).toThrow(/不在 ALLOWED_ROOTS/)
    expect(() => env.projects.create({ name: 'x', rootPath: path.join(repoDir, 'missing') })).toThrow(/不存在/)
    expect(() => env.projects.create({ name: 'x', rootPath: path.join(repoDir, 'README.md') })).toThrow(/不是目录/)

    const project = env.projects.create({ name: '根目录', rootPath: repoDir })
    expect(fs.existsSync(project.rootPath)).toBe(true)
    const nested = env.projects.create({ name: '子目录', rootPath: path.join(repoDir, 'src') })
    expect(nested.rootPath.endsWith(`${path.sep}src`)).toBe(true)
  })

  it('非法 workspaceMode → 拒绝（create 与 update 一致）', () => {
    const { env, repoDir } = makeRepoEnv()
    expect(() =>
      env.projects.create({ name: 'x', rootPath: repoDir, workspaceMode: 'nope' as WorkspaceMode }),
    ).toThrow(/workspaceMode 非法/)
    const project = env.projects.create({ name: 'x', rootPath: repoDir })
    expect(() => env.projects.update(project.id, { workspaceMode: 'nope' as WorkspaceMode })).toThrow(/workspaceMode 非法/)
    const updated = env.projects.update(project.id, { name: '改名' })
    expect(updated?.name).toBe('改名')
    expect(env.projects.remove(project.id)).toBe(true)
    expect(env.projects.get(project.id)).toBeUndefined()
  })
})

// ---------- worktree 会话与隔离 ----------

describe('M6：worktree 会话与隔离', () => {
  it('创建会话 → worktree 目录 + agent/<sid> 分支；工具改动只在 worktree，主仓库不受影响', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)

    expect(root).toBe(path.join(env.cfg.worktreeDir, session.id))
    expect(fs.existsSync(path.join(root, 'README.md'))).toBe(true)
    expect(gitSync(repoDir, ['branch', '--list', `agent/${session.id}`])).toContain(`agent/${session.id}`)

    // 工具在 worktree 中改文件（工作区根 = worktree 路径）
    const rt = runtimeFor(env, session.id, root)
    const result = await runTool(env, 'write_file', { path: 'src/app.ts', content: 'export const v = 2\n' }, rt)
    expect(result.ok).toBe(true)

    // worktree 变了；主仓库没变；主分支干净
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('v = 2')
    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain('v = 1')
    expect(gitSync(repoDir, ['status', '--porcelain']).trim()).toBe('')
  })

  it('查看改动：变更集（changedArtifacts）与相对分叉点的 diff', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const v = 2\n')

    const artifacts = await env.workspace.changedArtifacts(session.id)
    const changed = artifacts.find((a) => a.path === 'src/app.ts')
    expect(changed).toBeDefined()
    expect(changed?.gitStatus).toBe('M')

    const diff = await env.workspace.diff(session.id)
    expect(diff.branch).toBe(`agent/${session.id}`)
    expect(diff.diff).toContain('-export const v = 1')
    expect(diff.diff).toContain('+export const v = 2')
  })

  it('合并：未提交 → 拒绝；git_commit 后 merge 成功，主仓库出现变更', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'export const v = 2\n')

    await expect(env.workspace.merge(session.id)).rejects.toThrow(/未提交改动/)

    const rt = runtimeFor(env, session.id, root)
    const commit = await runTool(env, 'git_commit', { message: 'feat: v2' }, rt)
    expect(commit.ok).toBe(true)

    const merged = await env.workspace.merge(session.id)
    expect(merged.detail.toLowerCase()).toContain('merge')
    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain('v = 2')
    // 主仓库里出现 merge 提交（--no-ff）
    expect(gitSync(repoDir, ['log', '--oneline', '-n', '3'])).toContain('merge ')
  })

  it('丢弃：目录与分支删除，主仓库无痕', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)
    fs.writeFileSync(path.join(root, 'README.md'), '# 改坏的内容\n')

    const removed = await env.workspace.discard(session.id)
    expect(removed).toBe(true)
    expect(fs.existsSync(root)).toBe(false)
    expect(gitSync(repoDir, ['branch', '--list', `agent/${session.id}`]).trim()).toBe('')
    expect(fs.readFileSync(path.join(repoDir, 'README.md'), 'utf8')).toBe('# 初始内容\n')
  })

  it('prepare：目标不是 git 仓库 → worktree 创建失败拒绝（可修正错误）', async () => {
    const plainDir = makeTmpDir('ma-m6-plain-')
    const env = makeEnv({ allowedRoots: [plainDir] })
    const project = env.projects.create({ name: '非仓库', rootPath: plainDir, workspaceMode: 'worktree' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await expect(env.workspace.prepare(session)).rejects.toThrow(/不是 git 仓库/)
  })

  it('repo 模式：直接挂载仓库根，isGitMode=true（交付件走变更集）', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: '直连', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'repo 会话', { projectId: project.id })
    await env.workspace.prepare(session)
    expect(session.workspaceDir).toBe(project.rootPath)
    expect(env.workspace.isGitMode(session.id)).toBe(true)
    // sandbox 会话不受影响
    const sandbox = env.sessions.create(['backend'], '沙箱')
    expect(env.workspace.isGitMode(sandbox.id)).toBe(false)
  })
})

// ---------- Git 工具集 ----------

describe('M6：Git 工具集', () => {
  it('git_status / git_log：干净与脏工作区、提交历史', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    const clean = await runTool(env, 'git_status', {}, rt)
    expect(clean.ok).toBe(true)
    expect(clean.summary).toContain('工作区干净')
    expect(clean.summary).toContain('main')

    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 9\n')
    const dirty = await runTool(env, 'git_status', {}, rt)
    expect(dirty.summary).toContain('1 个文件有变更')
    expect(dirty.detail).toContain('src/app.ts')

    const log = await runTool(env, 'git_log', { limit: 5 }, rt)
    expect(log.detail).toContain('init')
  })

  it('git_diff：工作区 / staged / range / path 四种模式', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 9\n')
    const unstaged = await runTool(env, 'git_diff', { staged: false }, rt)
    expect(unstaged.detail).toContain('+export const v = 9')

    gitSync(repoDir, ['add', '-A'])
    const afterAdd = await runTool(env, 'git_diff', { staged: false }, rt)
    expect(afterAdd.summary).toBe('无差异')
    const staged = await runTool(env, 'git_diff', { staged: true }, rt)
    expect(staged.detail).toContain('+export const v = 9')

    // path 限定：README 无改动 → 无差异
    const byPath = await runTool(env, 'git_diff', { path: 'README.md' }, rt)
    expect(byPath.summary).toBe('无差异')

    // range：提交后对比 HEAD~1
    const commit = await runTool(env, 'git_commit', { message: 'v9' }, rt)
    expect(commit.ok).toBe(true)
    const range = await runTool(env, 'git_diff', { range: 'HEAD~1' }, rt)
    expect(range.detail).toContain('+export const v = 9')
  })

  it('git_branch：列出 / 创建+切换 / 切回', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    const listed = await runTool(env, 'git_branch', {}, rt)
    expect(listed.ok).toBe(true)
    expect(listed.detail).toContain('*')

    const created = await runTool(env, 'git_branch', { create: 'feat-m6' }, rt)
    expect(created.ok).toBe(true)
    expect(gitSync(repoDir, ['branch', '--show-current']).trim()).toBe('feat-m6')

    const back = await runTool(env, 'git_branch', { checkout: 'main' }, rt)
    expect(back.ok).toBe(true)
    expect(gitSync(repoDir, ['branch', '--show-current']).trim()).toBe('main')
  })

  it('git_commit：无变更提示；有变更提交成功且工作区干净', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    const noChange = await runTool(env, 'git_commit', { message: 'nop' }, rt)
    expect(noChange.ok).toBe(true)
    expect(noChange.summary).toContain('无变更')

    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 3\n')
    const committed = await runTool(env, 'git_commit', { message: 'feat: 改 v' }, rt)
    expect(committed.ok).toBe(true)
    expect(committed.summary).toContain('feat: 改 v')
    expect(gitSync(repoDir, ['status', '--porcelain']).trim()).toBe('')
  })

  it('git_restore：还原单个文件的未提交改动', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const v = 100\n')
    const restored = await runTool(env, 'git_restore', { path: 'src/app.ts', staged: false }, rt)
    expect(restored.ok).toBe(true)
    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain('v = 1')
  })

  it('非 git 工作区 → 可读错误（提示需要真实仓库项目）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], '沙箱')
    const workspace = env.artifacts.ensureSessionDir(session.id)
    const rt = runtimeFor(env, session.id, workspace)
    const result = await runTool(env, 'git_status', {}, rt)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('不是 git 仓库')
  })
})

// ---------- 参数注入防护 ----------

describe('M6：参数注入防护', () => {
  it('分支名 / range：拒绝 - 开头与非法字符', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    const dash = await runTool(env, 'git_branch', { create: '--help' }, rt)
    expect(dash.ok).toBe(false)
    expect(dash.summary).toContain('不能以 "-" 开头')

    const bad = await runTool(env, 'git_branch', { create: 'bad;name rm' }, rt)
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('非法字符')

    const range = await runTool(env, 'git_diff', { range: '--exec=rm' }, rt)
    expect(range.ok).toBe(false)
    expect(range.summary).toContain('不能以 "-" 开头')
  })

  it('路径：阻止 ../ 逃逸出工作区', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    const escape = await runTool(env, 'git_diff', { path: '../outside.txt' }, rt)
    expect(escape.ok).toBe(false)
    expect(escape.summary).toContain('越界')

    const restore = await runTool(env, 'git_restore', { path: '../../etc/passwd', staged: false }, rt)
    expect(restore.ok).toBe(false)
    expect(restore.summary).toContain('越界')
  })

  it('含空格的文件名：execFile 参数数组不被拆词', async () => {
    const { env, repoDir } = makeRepoEnv()
    const project = env.projects.create({ name: 'repo', rootPath: repoDir, workspaceMode: 'repo' })
    const session = env.sessions.create(['backend'], 'x', { projectId: project.id })
    await env.workspace.prepare(session)
    const rt = runtimeFor(env, session.id, repoDir)

    // 先提交成已跟踪文件（untracked 文件不会出现在 git diff 输出里）
    fs.writeFileSync(path.join(repoDir, 'with space.txt'), 'x\n')
    gitSync(repoDir, ['add', '-A'])
    gitSync(repoDir, ['commit', '-m', 'add spaced file'])
    fs.writeFileSync(path.join(repoDir, 'with space.txt'), 'y\n')

    const status = await runTool(env, 'git_status', {}, rt)
    expect(status.detail).toContain('with space.txt')

    const diff = await runTool(env, 'git_diff', { path: 'with space.txt' }, rt)
    expect(diff.ok).toBe(true)
    expect(diff.detail).toContain('with space.txt')

    const restore = await runTool(env, 'git_restore', { path: 'with space.txt', staged: false }, rt)
    expect(restore.ok).toBe(true)
    expect(fs.readFileSync(path.join(repoDir, 'with space.txt'), 'utf8')).toBe('x\n')
  })
})

// ---------- run_command cwd 限定 ----------

describe('M6：run_command 在 worktree 内执行', () => {
  it('cwd = 会话工作区（worktree 路径），不落到主仓库', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)
    const rt = runtimeFor(env, session.id, root, { allowRunCommand: true, allowedCommands: ['pwd'] })
    const result = await runTool(env, 'run_command', { command: 'pwd' }, rt)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain(session.id)
    expect(result.detail).not.toContain(`/worktrees\n`) // 兜底：不可能是主仓库根
  })
})

// ---------- 引擎集成（计划验收原文） ----------

describe('M6：引擎集成（后端角色改文件 → 变更只在 agent 分支）', () => {
  it('worktree 会话中 write_file → worktree 变化、主仓库与主分支不受影响、交付件可见', async () => {
    const { env, repoDir } = makeRepoEnv()
    const { session, root } = await createWorktreeSession(env, repoDir)

    // mock 剧本：第 1 回合调用 write_file 改 app.ts；第 2 回合交还用户
    let round = 0
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req: ChatRequest, signal: AbortSignal) {
      // M48：平台路由请求直通（不占 round）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      const chunks: LlmChunk[] =
        round++ === 0
          ? [
              {
                type: 'tool_calls',
                calls: [
                  {
                    id: 'c1',
                    name: 'write_file',
                    arguments: JSON.stringify({ path: 'src/app.ts', content: 'export const v = 2\n' }),
                  },
                ],
              },
              { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } },
              { type: 'done' },
            ]
          : [
              { type: 'text', text: '已完成改动。\n@用户' },
              { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } },
              { type: 'done' },
            ]
      for (const chunk of chunks) {
        if (signal.aborted) throw abortError()
        yield chunk
      }
    }

    const message = env.sessions.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '请把 app.ts 的 v 改成 2',
      mentions: [],
      status: 'complete',
    })
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    // 变更只出现在 worktree（agent 分支）
    expect(fs.readFileSync(path.join(root, 'src', 'app.ts'), 'utf8')).toContain('v = 2')
    expect(fs.readFileSync(path.join(repoDir, 'src', 'app.ts'), 'utf8')).toContain('v = 1')
    expect(gitSync(repoDir, ['status', '--porcelain']).trim()).toBe('')

    // 交付件 = git 变更集
    const artifacts = await env.workspace.changedArtifacts(session.id)
    expect(artifacts.map((a) => a.path)).toContain('src/app.ts')

    // 查看改动能看到 diff
    const diff = await env.workspace.diff(session.id)
    expect(diff.diff).toContain('+export const v = 2')
  })
})
