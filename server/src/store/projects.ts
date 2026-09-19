/**
 * 项目存储（M6）：真实仓库挂载的实体层。
 *
 * 安全边界：
 * - `rootPath` 必须落在 `ALLOWED_ROOTS` 白名单内（realpath 后比较，防 symlink 逃逸）；
 * - 白名单为空时**拒绝创建任何项目**（未声明允许挂载的根目录时不放开真实文件系统）；
 * - `rootPath` 创建后不可修改（防校验绕过），改名 / 改模式走 PATCH。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ProjectDefinition, WorkspaceMode } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface ProjectRow {
  id: string
  name: string
  root_path: string
  workspace_mode: string
  base_branch: string | null
  /** M57：项目属主（users.id；NULL = 单用户兼容模式） */
  owner_id?: string | null
  created_at: string
  updated_at: string
}

const MODES: WorkspaceMode[] = ['sandbox', 'repo', 'worktree']

function rowToProject(row: ProjectRow): ProjectDefinition {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    workspaceMode: row.workspace_mode as WorkspaceMode,
    baseBranch: row.base_branch ?? undefined,
    ownerId: row.owner_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ProjectCreateInput {
  name: string
  rootPath: string
  workspaceMode?: WorkspaceMode
  baseBranch?: string
  /** M57：项目属主（多用户）；缺省 = 单用户兼容模式 */
  ownerId?: string
}

export class ProjectStore {
  /** 白名单规范化（realpath + 绝对路径）；构造函数完成，运行期不再变化 */
  private readonly allowedRoots: string[]

  constructor(
    private readonly db: AppDb,
    allowedRoots: string[],
  ) {
    this.allowedRoots = allowedRoots.map((root) => normalizeReal(path.resolve(root)))
  }

  /** 校验 rootPath：必须存在、是目录、在 ALLOWED_ROOTS 内（realpath 防 symlink 逃逸） */
  assertRootAllowed(rootPath: string): string {
    if (this.allowedRoots.length === 0) {
      throw new Error('未配置 ALLOWED_ROOTS：请在 .env 中声明允许挂载的根目录（逗号分隔）后再创建真实仓库项目')
    }
    const resolved = path.resolve(rootPath)
    let real: string
    try {
      real = fs.realpathSync(resolved)
    } catch {
      throw new Error(`rootPath 不存在：${resolved}`)
    }
    if (!fs.statSync(real).isDirectory()) throw new Error(`rootPath 不是目录：${real}`)
    const allowed = this.allowedRoots.some((root) => real === root || real.startsWith(root + path.sep))
    if (!allowed) {
      throw new Error(`rootPath 不在 ALLOWED_ROOTS 白名单内：${real}（允许：${this.allowedRoots.join('、')}）`)
    }
    return real
  }

  create(input: ProjectCreateInput): ProjectDefinition {
    const name = input.name?.trim()
    if (!name) throw new Error('项目名不能为空')
    if (input.workspaceMode && !MODES.includes(input.workspaceMode)) {
      throw new Error(`workspaceMode 非法（需 sandbox|repo|worktree）：${input.workspaceMode}`)
    }
    const real = this.assertRootAllowed(input.rootPath)
    const ts = nowIso()
    const project: ProjectDefinition = {
      id: newId('p'),
      name,
      rootPath: real,
      workspaceMode: input.workspaceMode ?? 'sandbox',
      baseBranch: input.baseBranch?.trim() || undefined,
      ownerId: input.ownerId,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.run(
      `INSERT INTO projects (id, name, root_path, workspace_mode, base_branch, owner_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      project.id,
      project.name,
      project.rootPath,
      project.workspaceMode,
      project.baseBranch ?? null,
      project.ownerId ?? null,
      ts,
      ts,
    )
    return project
  }

  /**
   * 项目列表（M57：ownerId 必传——用户 id = 仅本人；null = 系统全量（单用户兼容 / 内部用））。
   * 参数必传是刻意的：编译期强制每个调用点声明隔离意图。
   */
  list(ownerId: string | null): ProjectDefinition[] {
    const ownerFilter = ownerId === null ? '' : 'WHERE owner_id = ?'
    const params = ownerId === null ? [] : [ownerId]
    return this.db
      .all<ProjectRow>(`SELECT * FROM projects ${ownerFilter} ORDER BY updated_at DESC`, ...params)
      .map(rowToProject)
  }

  get(id: string): ProjectDefinition | undefined {
    const row = this.db.get<ProjectRow>('SELECT * FROM projects WHERE id = ?', id)
    return row ? rowToProject(row) : undefined
  }

  update(
    id: string,
    patch: { name?: string; workspaceMode?: WorkspaceMode; baseBranch?: string },
  ): ProjectDefinition | undefined {
    const project = this.get(id)
    if (!project) return undefined
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('项目名不能为空')
      project.name = name
    }
    if (patch.workspaceMode !== undefined) {
      if (!MODES.includes(patch.workspaceMode)) throw new Error(`workspaceMode 非法（需 sandbox|repo|worktree）：${patch.workspaceMode}`)
      project.workspaceMode = patch.workspaceMode
    }
    if (patch.baseBranch !== undefined) project.baseBranch = patch.baseBranch.trim() || undefined
    project.updatedAt = nowIso()
    this.db.run(
      'UPDATE projects SET name = ?, workspace_mode = ?, base_branch = ?, updated_at = ? WHERE id = ?',
      project.name,
      project.workspaceMode,
      project.baseBranch ?? null,
      project.updatedAt,
      id,
    )
    return project
  }

  /** 删除项目（关联会话的 project_id 由外键 ON DELETE SET NULL 置空，会话保留为 sandbox） */
  remove(id: string): boolean {
    return this.db.run('DELETE FROM projects WHERE id = ?', id).changes > 0
  }

  /** 项目下的会话数（删除前提示用） */
  sessionCount(id: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE project_id = ? AND deleted_at IS NULL', id)
    return Number(row?.n ?? 0)
  }
}

function normalizeReal(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
