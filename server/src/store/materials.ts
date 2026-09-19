/**
 * M68：用户素材库存储（materials 表；per-user 私人素材）。
 *
 * 语义：
 * - 归属 owner_id（服务端取登录身份；单用户兼容模式固定 'local'）；无 FK——账号删除由路由显式级联 removeOf；
 * - 文件真相在磁盘（workspace/_library/u_<uid>/<id><ext>），行是索引：删除行时调用方负责文件双清（service 收口）；
 * - 列表按 created_at 降序（新 → 旧）；limit 封顶 200（P1 不分页）。
 */
import { randomUUID } from 'node:crypto'
import type { AppDb } from './db.js'
import { nowIso } from './sessions.js'

/** 素材来源：upload 用户上传 / generate 生成收藏 / artifact 交付件收藏（后两者 P2 接入） */
export type MaterialSource = 'upload' | 'generate' | 'artifact'
export type MaterialKind = 'image' | 'video' | 'audio'

export interface MaterialRecord {
  id: string
  ownerId: string
  /** 展示名（原文件名安全化后；≤120 字） */
  name: string
  kind: MaterialKind
  /** 扩展名（含点，小写） */
  ext: string
  mime?: string
  sizeBytes: number
  /** 相对素材根（_library）的路径：u_<uid>/<id><ext>（仅 [a-zA-Z0-9_-/. ]，防穿越） */
  relPath: string
  source: MaterialSource
  /** 收藏来源会话（可空；无外键——会话可删） */
  srcSessionId?: string
  createdAt: string
}

interface MaterialRow {
  id: string
  owner_id: string
  name: string
  kind: string
  ext: string
  mime: string | null
  size_bytes: number
  rel_path: string
  source: string
  src_session_id: string | null
  created_at: string
}

function rowToMaterial(row: MaterialRow): MaterialRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    kind: row.kind === 'video' ? 'video' : row.kind === 'audio' ? 'audio' : 'image',
    ext: row.ext,
    mime: row.mime ?? undefined,
    sizeBytes: Number(row.size_bytes),
    relPath: row.rel_path,
    source: row.source === 'generate' || row.source === 'artifact' ? row.source : 'upload',
    srcSessionId: row.src_session_id ?? undefined,
    createdAt: row.created_at,
  }
}

export function newMaterialId(): string {
  return `mat_${randomUUID().slice(0, 8)}`
}

export class MaterialStore {
  constructor(private readonly db: AppDb) {}

  /** 列表（属主隔离；query 对展示名子串；kind 筛选；limit 封顶 200） */
  list(ownerId: string, opts: { query?: string; kind?: MaterialKind; limit?: number } = {}): MaterialRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 60, 1), 200)
    const conds = ['owner_id = ?']
    const args: Array<string | number> = [ownerId]
    if (opts.kind) {
      conds.push('kind = ?')
      args.push(opts.kind)
    }
    const q = opts.query?.trim()
    if (q) {
      conds.push('name LIKE ?')
      args.push(`%${q}%`)
    }
    args.push(limit)
    return this.db
      .all<MaterialRow>(`SELECT * FROM materials WHERE ${conds.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...args)
      .map(rowToMaterial)
  }

  /** 单条（owner 校验一体：非属主 = undefined，不泄漏存在性） */
  get(ownerId: string, id: string): MaterialRecord | undefined {
    const row = this.db.get<MaterialRow>('SELECT * FROM materials WHERE id = ? AND owner_id = ?', id, ownerId)
    return row ? rowToMaterial(row) : undefined
  }

  insert(input: Omit<MaterialRecord, 'createdAt'> & { createdAt?: string }): MaterialRecord {
    const createdAt = input.createdAt ?? nowIso()
    this.db.run(
      `INSERT INTO materials (id, owner_id, name, kind, ext, mime, size_bytes, rel_path, source, src_session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.id,
      input.ownerId,
      input.name,
      input.kind,
      input.ext,
      input.mime ?? null,
      input.sizeBytes,
      input.relPath,
      input.source,
      input.srcSessionId ?? null,
      createdAt,
    )
    return { ...input, createdAt }
  }

  /** 删除单条（返回被删行供文件双清；非属主 / 不存在 → undefined） */
  remove(ownerId: string, id: string): MaterialRecord | undefined {
    const found = this.get(ownerId, id)
    if (!found) return undefined
    this.db.run('DELETE FROM materials WHERE id = ? AND owner_id = ?', id, ownerId)
    return found
  }

  /** 删除属主全部（账号删除级联；返回全部行供文件清理） */
  removeOf(ownerId: string): MaterialRecord[] {
    const all = this.db
      .all<MaterialRow>('SELECT * FROM materials WHERE owner_id = ?', ownerId)
      .map(rowToMaterial)
    this.db.run('DELETE FROM materials WHERE owner_id = ?', ownerId)
    return all
  }

  /** 属主素材总字节（容量条 / 用量汇总） */
  bytesOf(ownerId: string): number {
    const row = this.db.get<{ total: number | null }>(
      'SELECT COALESCE(SUM(size_bytes), 0) AS total FROM materials WHERE owner_id = ?',
      ownerId,
    )
    return Number(row?.total ?? 0)
  }

  countOf(ownerId: string): number {
    const row = this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM materials WHERE owner_id = ?', ownerId)
    return Number(row?.n ?? 0)
  }
}
