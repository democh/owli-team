/**
 * 空间存储（Space）：工作生活一体的一级信息架构（docs/work-life-fusion-design.md）。
 *
 * - 内置三空间（default / work / life）由迁移 v27 落种，`ensureBuiltins` 在启动时校正名称与排序（幂等）；
 * - builtin 空间不可删除、不可改 kind；custom 空间删除后关联会话由外键 ON DELETE SET NULL 回 default 语义；
 * - 会话归属字段为 `sessions.space_id`（NULL = 我的空间），列表投影随行返回，前端按空间过滤。
 */
import type { Space, SpaceKind } from '@multi-agent/shared'
import { DEFAULT_SPACE_ID } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface SpaceRow {
  id: string
  name: string
  kind: string
  icon: string | null
  builtin: number
  sort: number
  /** P3：空间默认灵魂（JSON agentId → soulId；NULL = 无默认绑定） */
  soul_overrides?: string | null
  /** P4：自建空间归属（多用户 userId / 兼容模式 'local'；NULL = 内置三空间 / 迁移前历史遗留） */
  owner_id?: string | null
  created_at: string
  updated_at: string
}

function parseOverrides(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === 'string' && v) out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

function rowToSpace(row: SpaceRow): Space {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as SpaceKind,
    icon: row.icon ?? undefined,
    builtin: row.builtin ? true : undefined,
    sort: row.sort,
    soulOverrides: parseOverrides(row.soul_overrides),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * P3：空间默认灵魂合并（成员入编默认值）。
 * - 仅作用于经典成员键（agentId）；分身键（agentId~soulId）灵魂内嵌，跳过；
 * - 显式选择的灵魂永远优先；合并后为空则返回入参（保持 undefined 语义零差异）。
 */
export function applySpaceSoulDefaults(
  space: Space | undefined,
  memberKeys: string[],
  souls: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const overrides = space?.soulOverrides
  if (!overrides || Object.keys(overrides).length === 0) return souls
  const merged = { ...(souls ?? {}) }
  for (const key of memberKeys) {
    if (key.includes('~')) continue
    if (merged[key]) continue
    const soul = overrides[key]
    if (soul) merged[key] = soul
  }
  return Object.keys(merged).length > 0 ? merged : souls
}

const KINDS: SpaceKind[] = ['work', 'life', 'personal', 'custom']

/** 内置空间定义（ensureBuiltins 的校正依据；id 稳定，对外可作为常量引用） */
const BUILTINS: Array<{ id: string; name: string; kind: SpaceKind; icon: string; sort: number }> = [
  { id: DEFAULT_SPACE_ID, name: '我的', kind: 'personal', icon: 'home', sort: 0 },
  { id: 'work', name: '工作', kind: 'work', icon: 'briefcase', sort: 1 },
  { id: 'life', name: '生活', kind: 'life', icon: 'sparkles', sort: 2 },
]

export class SpaceStore {
  constructor(private readonly db: AppDb) {
    this.ensureBuiltins()
  }

  /** 内置空间校正（迁移种子的 created_at 占位 / 名称漂移在此收敛；幂等） */
  private ensureBuiltins(): void {
    const ts = nowIso()
    for (const b of BUILTINS) {
      const existing = this.db.get<SpaceRow>('SELECT * FROM spaces WHERE id = ?', b.id)
      if (!existing) {
        this.db.run(
          `INSERT INTO spaces (id, name, kind, icon, builtin, sort, created_at, updated_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?)`,
          b.id,
          b.name,
          b.kind,
          b.icon,
          b.sort,
          ts,
          ts,
        )
        continue
      }
      if (existing.created_at === 'builtin' || existing.name !== b.name || existing.kind !== b.kind || existing.sort !== b.sort) {
        this.db.run(
          `UPDATE spaces SET name = ?, kind = ?, icon = ?, sort = ?,
             created_at = CASE WHEN created_at = 'builtin' THEN ? ELSE created_at END,
             updated_at = CASE WHEN created_at = 'builtin' THEN ? ELSE updated_at END
           WHERE id = ?`,
          b.name,
          b.kind,
          b.icon,
          b.sort,
          ts,
          ts,
          b.id,
        )
      }
    }
  }

  list(): Space[] {
    return this.db.all<SpaceRow>('SELECT * FROM spaces ORDER BY sort ASC, created_at ASC').map(rowToSpace)
  }

  /** P4：按用户隔离的清单（内置 ∪ 本人自建 ∪ owner 为空的历史遗留；兼容模式 user='local'） */
  listForUser(userId: string): Space[] {
    return this.db
      .all<SpaceRow>(
        'SELECT * FROM spaces WHERE owner_id IS NULL OR owner_id = ? ORDER BY sort ASC, created_at ASC',
        userId,
      )
      .map(rowToSpace)
  }

  /** P4：自建空间归属（undefined = 不存在；null = 内置 / 迁移前历史遗留） */
  ownerOf(id: string): string | null | undefined {
    const row = this.db.get<{ owner_id: string | null }>('SELECT owner_id FROM spaces WHERE id = ?', id)
    if (!row) return undefined
    return row.owner_id ?? null
  }

  get(id: string): Space | undefined {
    const row = this.db.get<SpaceRow>('SELECT * FROM spaces WHERE id = ?', id)
    return row ? rowToSpace(row) : undefined
  }

  create(input: { name: string; kind?: SpaceKind; icon?: string }, ownerId?: string): Space {
    const name = input.name?.trim()
    if (!name) throw new Error('空间名不能为空')
    const kind = input.kind ?? 'custom'
    if (!KINDS.includes(kind)) throw new Error(`kind 非法（需 work|life|personal|custom）：${kind}`)
    const ts = nowIso()
    const maxSort = this.db.get<{ n: number | null }>('SELECT MAX(sort) AS n FROM spaces')?.n ?? 99
    const space: Space = {
      id: newId('sp'),
      name,
      kind,
      icon: input.icon?.trim() || undefined,
      sort: Number(maxSort) + 1,
      createdAt: ts,
      updatedAt: ts,
    }
    this.db.run(
      `INSERT INTO spaces (id, name, kind, icon, builtin, owner_id, sort, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      space.id,
      space.name,
      space.kind,
      space.icon ?? null,
      ownerId ?? null,
      space.sort,
      ts,
      ts,
    )
    return space
  }

  update(id: string, patch: { name?: string; icon?: string; sort?: number; soulOverrides?: Record<string, string> | null }): Space | undefined {
    const space = this.get(id)
    if (!space) return undefined
    if (patch.name !== undefined) {
      const name = patch.name.trim()
      if (!name) throw new Error('空间名不能为空')
      space.name = name
    }
    if (patch.icon !== undefined) space.icon = patch.icon.trim() || undefined
    if (patch.sort !== undefined && Number.isFinite(patch.sort)) space.sort = Math.trunc(patch.sort)
    // P3：默认灵魂绑定（null = 清除；非法条目静默剔除由 parse 层兜底，这里做写入前校验）
    if (patch.soulOverrides !== undefined) {
      const clean = patch.soulOverrides === null ? undefined : parseOverrides(JSON.stringify(patch.soulOverrides))
      space.soulOverrides = clean
    }
    space.updatedAt = nowIso()
    this.db.run(
      'UPDATE spaces SET name = ?, icon = ?, sort = ?, soul_overrides = ?, updated_at = ? WHERE id = ?',
      space.name,
      space.icon ?? null,
      space.sort,
      space.soulOverrides ? JSON.stringify(space.soulOverrides) : null,
      space.updatedAt,
      id,
    )
    return space
  }

  /** 删除空间（内置拒绝；关联会话由外键置空回「我的」语义，返回受影响会话数） */
  remove(id: string): { removed: boolean; sessionsDetached: number } {
    const space = this.get(id)
    if (!space) return { removed: false, sessionsDetached: 0 }
    if (space.builtin) throw new Error('内置空间不可删除')
    const detached = this.sessionCount(id)
    const result = this.db.run('DELETE FROM spaces WHERE id = ?', id)
    return { removed: result.changes > 0, sessionsDetached: detached }
  }

  /** 空间下的会话数（删除前提示用） */
  sessionCount(id: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions WHERE space_id = ? AND deleted_at IS NULL', id)
    return Number(row?.n ?? 0)
  }
}
