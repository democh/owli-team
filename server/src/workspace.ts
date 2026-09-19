/**
 * 工作区服务（M6）：会话工作区根的解析与 worktree 生命周期。
 *
 * 三种模式（项目级配置，会话继承）：
 * - `sandbox`：`workspace/<sessionId>/`（沿用旧行为，惰性创建，不落 workspace_dir）；
 * - `repo`：直接挂载 `project.rootPath`（不建目录、不隔离，改动即真实改动）；
 * - `worktree`（推荐）：`git worktree add <WORKTREE_DIR>/<sessionId> -b agent/<sessionId>`，
 *   改动只落在独立分支，主仓库不受影响；支持「查看改动 / 合并 / 丢弃」。
 *
 * 路径安全：会话工作区最终根一律写入 `sessions.workspace_dir`（经 SessionStore 持久化），
 * ArtifactStore / 工具运行时均以此为唯一真相；worktree 丢弃前校验路径位于 WORKTREE_DIR 之下。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Artifact, ProjectDefinition, Session } from '@multi-agent/shared'
import type { AppConfig } from './config.js'
import { classifyKind } from './store/artifacts.js'
import type { ProjectStore } from './store/projects.js'
import type { SessionStore } from './store/sessions.js'
import { ensureDir } from './util/paths.js'
import {
  assertBranchName,
  assertSafeRef,
  gitCurrentBranch,
  gitFailure,
  gitIdentityEnv,
  gitRepoRoot,
  runGit,
} from './util/git.js'

export interface WorktreeInfo {
  mode: 'sandbox' | 'repo' | 'worktree'
  /** 工作区根（绝对路径） */
  root: string
  /** worktree 模式下的会话分支 */
  branch?: string
  /** 主仓库根（worktree / repo 模式） */
  repoRoot?: string
  /** 主仓库当前分支 */
  mainBranch?: string
}

export interface WorktreeDiff {
  branch: string
  root: string
  files: string[]
  diff: string
  truncated: boolean
}

export class WorkspaceService {
  constructor(
    private readonly deps: {
      cfg: AppConfig
      sessions: SessionStore
      projects: ProjectStore
    },
  ) {}

  /** 同步解析：会话工作区根（供 ArtifactStore 注入 override；未配置 → undefined → 走 sandbox 兜底） */
  dirFor(sessionId: string): string | undefined {
    return this.deps.sessions.getSession(sessionId)?.workspaceDir
  }

  /** 会话是否处于 git 模式（repo / worktree：交付件 = git 变更集） */
  isGitMode(sessionId: string): boolean {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session?.projectId || !session.workspaceDir) return false
    const project = this.deps.projects.get(session.projectId)
    return Boolean(project && project.workspaceMode !== 'sandbox')
  }

  projectOf(sessionId: string): ProjectDefinition | undefined {
    const session = this.deps.sessions.getSession(sessionId)
    return session?.projectId ? this.deps.projects.get(session.projectId) : undefined
  }

  /**
   * 会话创建时准备工作区（路由层在 create 之后调用；失败由调用方删除会话并回 400）。
   * - 无项目 / sandbox：不做事（惰性兜底 `workspace/<sid>`）；
   * - repo：校验目录存在后直接把根写入会话；
   * - worktree：创建 `agent/<sid>` 分支的 worktree（目录已存在且是同一仓库的 worktree 时复用）。
   */
  async prepare(session: Session): Promise<void> {
    if (!session.projectId) return
    const project = this.deps.projects.get(session.projectId)
    if (!project) throw new Error('项目不存在')
    if (project.workspaceMode === 'sandbox') return

    if (project.workspaceMode === 'repo') {
      if (!fs.existsSync(project.rootPath)) throw new Error(`项目目录不存在：${project.rootPath}`)
      this.deps.sessions.setWorkspace(session.id, project.rootPath)
      return
    }

    // worktree 模式
    const repoRoot = await gitRepoRoot(project.rootPath)
    if (!repoRoot) throw new Error(`项目目录不是 git 仓库（worktree 模式要求）：${project.rootPath}`)
    const branch = `agent/${session.id}`
    const root = path.join(this.deps.cfg.worktreeDir, session.id)

    // 幂等复用：目录已是本仓库注册的 worktree → 直接挂载
    if (fs.existsSync(path.join(root, '.git'))) {
      this.deps.sessions.setWorkspace(session.id, root)
      return
    }
    ensureDir(this.deps.cfg.worktreeDir)
    const base = project.baseBranch ? assertSafeRef(project.baseBranch, 'baseBranch') : 'HEAD'
    const result = await runGit(repoRoot, ['worktree', 'add', root, '-b', branch, base], { env: gitIdentityEnv() })
    if (!result.ok) {
      throw new Error(gitFailure(result, 'worktree 创建失败（base 分支是否存在？）'))
    }
    this.deps.sessions.setWorkspace(session.id, root)
  }

  /** 会话的工作区状态（worktree 面板 / 前端头部展示） */
  async info(sessionId: string): Promise<WorktreeInfo> {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const project = session.projectId ? this.deps.projects.get(session.projectId) : undefined
    const mode = project && session.workspaceDir ? project.workspaceMode : 'sandbox'
    const root = session.workspaceDir ?? path.join(this.deps.cfg.workspaceDir, session.id)
    if (mode === 'worktree' && project) {
      return {
        mode,
        root,
        branch: `agent/${sessionId}`,
        repoRoot: project.rootPath,
        mainBranch: await gitCurrentBranch(project.rootPath),
      }
    }
    if (mode === 'repo' && project) {
      return { mode, root, repoRoot: project.rootPath, mainBranch: await gitCurrentBranch(project.rootPath) }
    }
    return { mode: 'sandbox', root }
  }

  /** git 变更集（repo / worktree 模式的「交付件」语义）：git status 解析 + 删除标记 */
  async changedArtifacts(sessionId: string): Promise<Artifact[]> {
    const root = this.dirFor(sessionId)
    if (!root || !fs.existsSync(root)) return []
    const result = await runGit(root, ['status', '--porcelain'])
    if (!result.ok) return []
    const out: Artifact[] = []
    for (const line of result.stdout.split('\n')) {
      if (!line.trim()) continue
      const code = line.slice(0, 2)
      let filePath = line.slice(3)
      // 重命名：`R  old -> new` → 取新路径
      const arrow = filePath.indexOf(' -> ')
      if (arrow >= 0) filePath = filePath.slice(arrow + 4)
      if (!filePath) continue
      const full = path.join(root, filePath)
      const exists = fs.existsSync(full) && fs.statSync(full).isFile()
      const stat = exists ? fs.statSync(full) : undefined
      out.push({
        path: filePath.split(path.sep).join('/'),
        size: stat?.size ?? 0,
        mtime: stat?.mtimeMs ?? 0,
        kind: classifyKind(filePath),
        updatedAt: stat ? new Date(stat.mtimeMs).toISOString() : new Date().toISOString(),
        gitStatus: code.trim() || 'M',
      })
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  /** 查看改动：相对「分叉点」的完整 diff（含已提交与未提交） */
  async diff(sessionId: string): Promise<WorktreeDiff> {
    const { root, project, branch } = this.requireWorktree(sessionId)
    const mainBranch = await gitCurrentBranch(project.rootPath)
    let base = 'HEAD'
    if (mainBranch) {
      const mergeBase = await runGit(root, ['merge-base', mainBranch, 'HEAD'], { env: gitIdentityEnv() })
      if (mergeBase.ok && mergeBase.stdout.trim()) base = mergeBase.stdout.trim()
    }
    const diff = await runGit(root, ['diff', base], { env: gitIdentityEnv() })
    if (!diff.ok) throw new Error(gitFailure(diff, '查看改动失败'))
    const filesResult = await runGit(root, ['status', '--porcelain'])
    const files = filesResult.ok
      ? filesResult.stdout
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => l.slice(3).trim())
      : []
    const MAX = 60_000
    return {
      branch,
      root,
      files,
      diff: diff.stdout.slice(0, MAX),
      truncated: diff.stdout.length > MAX,
    }
  }

  /** 合并 worktree → 主仓库当前分支（合并需显式确认，路由层校验 confirm） */
  async merge(sessionId: string): Promise<{ detail: string }> {
    const { project, branch } = this.requireWorktree(sessionId)
    // 主仓库必须干净（防把用户未提交的改动卷进合并冲突）
    const mainStatus = await runGit(project.rootPath, ['status', '--porcelain'])
    if (mainStatus.ok && mainStatus.stdout.trim()) {
      throw new Error('主仓库存在未提交改动：请先在主仓库处理（提交或暂存）后再合并')
    }
    const wtStatus = await runGit(this.dirFor(sessionId)!, ['status', '--porcelain'])
    if (wtStatus.ok && wtStatus.stdout.trim()) {
      throw new Error('存在未提交改动：请先 git_commit 提交，或 git_restore 还原后再合并')
    }
    const merge = await runGit(
      project.rootPath,
      ['merge', '--no-ff', '-m', `merge ${branch}（会话 ${sessionId}）`, branch],
      { env: gitIdentityEnv() },
    )
    if (!merge.ok) {
      await runGit(project.rootPath, ['merge', '--abort'])
      throw new Error(gitFailure(merge, '合并失败（已回滚主仓库）'))
    }
    return { detail: merge.stdout.trim() || '合并完成' }
  }

  /** 丢弃 worktree（删除工作目录 + agent 分支；主仓库不受影响）；返回是否执行了删除 */
  async discard(sessionId: string): Promise<boolean> {
    const session = this.deps.sessions.getSession(sessionId)
    const project = session?.projectId ? this.deps.projects.get(session.projectId) : undefined
    if (!session?.projectId || !session.workspaceDir || !project || project.workspaceMode !== 'worktree') return false
    const root = session.workspaceDir
    // 安全：只允许删除 WORKTREE_DIR 之下的目录
    const base = path.resolve(this.deps.cfg.worktreeDir) + path.sep
    if (!path.resolve(root).startsWith(base)) {
      throw new Error(`工作区路径不属于 worktree 目录，拒绝删除：${root}`)
    }
    const branch = `agent/${sessionId}`
    const remove = await runGit(project.rootPath, ['worktree', 'remove', '--force', root])
    if (!remove.ok && fs.existsSync(root)) {
      throw new Error(gitFailure(remove, 'worktree 删除失败'))
    }
    await runGit(project.rootPath, ['branch', '-D', assertBranchName(branch)], { env: gitIdentityEnv() })
    return true
  }

  private requireWorktree(sessionId: string): { root: string; project: ProjectDefinition; branch: string } {
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) throw new Error('会话不存在')
    const project = session.projectId ? this.deps.projects.get(session.projectId) : undefined
    if (!project || project.workspaceMode !== 'worktree' || !session.workspaceDir) {
      throw new Error('该会话不是 worktree 模式')
    }
    return { root: session.workspaceDir, project, branch: `agent/${sessionId}` }
  }
}
