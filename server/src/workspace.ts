/**
 * 工作区服务（M6）：会话工作区根的解析与 worktree 生命周期。
 *
 * 三种模式（项目级配置，会话继承）：
 * - `sandbox`：`workspace/u_<uid>/<sid>/`（M57 起用户维度嵌套；无属主 / 历史数据沿用 `workspace/<sid>/`，
 *   兼容回退见 `resolveDir`；一次性搬迁 `npm run migrate:workspace`），惰性创建，不落 workspace_dir；
 * - `repo`：直接挂载 `project.rootPath`（不建目录、不隔离，改动即真实改动）；
 * - `worktree`（推荐）：`git worktree add <WORKTREE_DIR>/u_<uid>/<sid> -b agent/<sid>`，
 *   改动只落在独立分支，主仓库不受影响；支持「查看改动 / 合并 / 丢弃」；
 *   既有旧布局（WORKTREE_DIR/<sid>）幂等复用原位，不自动搬迁。
 *
 * 路径安全：会话工作区最终根一律写入 `sessions.workspace_dir`（经 SessionStore 持久化），
 * ArtifactStore / 工具运行时均以此为唯一真相；worktree 丢弃前校验路径位于 WORKTREE_DIR 之下；
 * 删除账号的磁盘清理（purgeUser）全部带「根内」安全校验。
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

/** 目录段安全清洗（用户 id / 会话 id 防路径拼接逃逸） */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 安全删除：仅当目标位于 base 之内（防拼接逃逸 / 误删）；目标不存在时静默成功 */
function removeUnder(base: string, target: string): boolean {
  const baseResolved = path.resolve(base) + path.sep
  const resolved = path.resolve(target)
  if (!resolved.startsWith(baseResolved)) return false
  fs.rmSync(resolved, { recursive: true, force: true })
  return true
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

  /** M57：用户维度的资源目录（`<root>/u_<uid>`；无属主 → 根目录，兼容旧布局） */
  private userScopedDir(root: string, ownerId: string | undefined): string {
    const seg = ownerId ? sanitizeSegment(ownerId) : ''
    return seg ? path.join(root, `u_${seg}`) : root
  }

  /**
   * M57：会话工作区根的统一解析（ArtifactStore / 工具沙箱 / 展示共用）：
   * - 显式 workspaceDir（repo / worktree / 已持久化的 sandbox）优先；
   * - 无属主（单用户兼容模式 / 历史数据）→ 旧平面布局 `workspace/<sid>`；
   * - 有属主 → 新布局 `workspace/u_<uid>/<sid>`；新目录未建而旧目录已存在 → 兼容回退旧路径
   *   （由 `npm run migrate:workspace` 完成一次性搬迁）。
   */
  resolveDir(sessionId: string): string {
    const legacy = path.join(this.deps.cfg.workspaceDir, sessionId)
    const session = this.deps.sessions.getSession(sessionId)
    if (!session) return legacy
    if (session.workspaceDir) return session.workspaceDir
    const nested = path.join(this.userScopedDir(this.deps.cfg.workspaceDir, session.ownerId), sessionId)
    if (nested === legacy) return legacy
    if (!fs.existsSync(nested) && fs.existsSync(legacy)) return legacy
    return nested
  }

  /** M57：会话画布文档路径（`data/canvas/u_<uid>/<sid>.json`；无属主 / 旧文件回退平面布局） */
  canvasFileFor(sessionId: string): string {
    const canvasDir = path.join(this.deps.cfg.dataDir, 'canvas')
    const sid = sanitizeSegment(sessionId)
    const legacy = path.join(canvasDir, `${sid}.json`)
    const session = this.deps.sessions.getSession(sessionId)
    if (!session?.ownerId) return legacy
    const nested = path.join(this.userScopedDir(canvasDir, session.ownerId), `${sid}.json`)
    if (!fs.existsSync(nested) && fs.existsSync(legacy)) return legacy
    return nested
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
    // M57：新会话 worktree 落用户维度目录 u_<uid>/；既有（旧布局）目录原位幂等复用，不自动搬迁
    const legacyRoot = path.join(this.deps.cfg.worktreeDir, session.id)
    const root = path.join(this.userScopedDir(this.deps.cfg.worktreeDir, session.ownerId), session.id)
    for (const candidate of [root, legacyRoot]) {
      if (fs.existsSync(path.join(candidate, '.git'))) {
        this.deps.sessions.setWorkspace(session.id, candidate)
        return
      }
    }
    ensureDir(path.dirname(root))
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
    const root = session.workspaceDir ?? this.resolveDir(sessionId)
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

  /**
   * M57：删除账号时清理其磁盘资产（先逐会话解除 git worktree 注册，再删目录树）。
   * - 新布局：`workspace/u_<uid>`、`WORKTREE_DIR/u_<uid>`、`data/canvas/u_<uid>` 整树删除；
   * - 旧布局（迁移前）：逐会话 `workspace/<sid>`、`WORKTREE_DIR/<sid>`、`canvas/<sid>.json`；
   * - 所有删除均带「根内」安全校验；返回告警清单（清理失败不阻断账号删除）。
   * 注：必须在账号（会话行）删除「之前」调用——worktree 解除注册需要会话信息。
   */
  async purgeUser(userId: string, sessionIds: string[]): Promise<string[]> {
    const warnings: string[] = []
    const seg = sanitizeSegment(userId)
    if (!seg) return [`用户 id 非法，已跳过磁盘清理：${userId}`]
    // 1) 先解除 git worktree 注册（目录存在时执行；失败记录后继续）
    for (const sid of sessionIds) {
      try {
        await this.discard(sid)
      } catch (err) {
        warnings.push(`worktree 丢弃失败（${sid}）：${(err as Error).message}`)
      }
    }
    // 2) 新布局：用户维度整树
    const canvasDir = path.join(this.deps.cfg.dataDir, 'canvas')
    const treeTargets: Array<[string, string]> = [
      [this.deps.cfg.workspaceDir, path.join(this.deps.cfg.workspaceDir, `u_${seg}`)],
      [this.deps.cfg.worktreeDir, path.join(this.deps.cfg.worktreeDir, `u_${seg}`)],
      [canvasDir, path.join(canvasDir, `u_${seg}`)],
    ]
    for (const [base, target] of treeTargets) {
      if (!removeUnder(base, target)) warnings.push(`清理路径越界，已跳过：${target}`)
    }
    // 3) 旧布局：逐会话平面目录 / 文件
    for (const sid of sessionIds) {
      const sidSeg = sanitizeSegment(sid)
      if (!sidSeg) continue
      removeUnder(this.deps.cfg.workspaceDir, path.join(this.deps.cfg.workspaceDir, sidSeg))
      removeUnder(this.deps.cfg.worktreeDir, path.join(this.deps.cfg.worktreeDir, sidSeg))
      const canvasFile = path.join(canvasDir, `${sidSeg}.json`)
      if (path.resolve(canvasFile).startsWith(path.resolve(canvasDir) + path.sep)) {
        fs.rmSync(canvasFile, { force: true })
      }
    }
    return warnings
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
