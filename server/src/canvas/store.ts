/**
 * M31：画布文档存储 —— data/canvas/<sessionId>.json（JSON 单文档 + version 乐观锁）。
 *
 * 设计（对齐 ADR 6 JSON 文档与 settings.ts 原子写模式）：
 * - 磁盘为唯一真相；内存缓存加速读（每会话一份文档，懒加载）；
 * - 保存：baseVersion 不匹配 → CanvasDocConflictError（409，路由回传服务端最新版）；
 * - agent 写入（applyOps）：读-改-写内部完成，version+1 后原子落盘并广播 notify:canvas-changed；
 * - 脏写防护：tmp + rename 原子替换；文件损坏 / 缺失 → 返回空白文档（绝不阻断画布打开）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { CanvasDoc, CanvasEdge, CanvasNode, CanvasOp } from '@multi-agent/shared'
import { ensureDir } from '../util/paths.js'

/** 节点 / 边 id（与项目既有 `${prefix}_${uuid8}` 口径一致） */
export function newNodeId(): string {
  return `nd_${randomUUID().slice(0, 8)}`
}

export function newEdgeId(): string {
  return `ed_${randomUUID().slice(0, 8)}`
}

/** 乐观锁冲突：路由层映射为 409（附服务端最新版） */
export class CanvasDocConflictError extends Error {
  constructor(readonly current: CanvasDoc) {
    super('画布已被其他写入更新（版本冲突）')
    this.name = 'CanvasDocConflictError'
  }
}

/** 空白文档（新会话 / 文件缺失 / 损坏兜底） */
export function emptyDoc(sessionId: string): CanvasDoc {
  return {
    v: 1,
    sessionId,
    version: 1,
    updatedAt: new Date().toISOString(),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    edges: [],
  }
}

/** 文档清洗：丢弃结构性非法条目（防手改文件 / 旧版本残留拖垮画布） */
function sanitizeDoc(raw: unknown, sessionId: string): CanvasDoc {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyDoc(sessionId)
  const record = raw as Record<string, unknown>
  const nodes = Array.isArray(record.nodes)
    ? (record.nodes as unknown[]).filter((n): n is CanvasNode => {
        const node = n as CanvasNode
        return (
          !!node &&
          typeof node === 'object' &&
          typeof node.id === 'string' &&
          typeof node.type === 'string' &&
          !!node.position &&
          typeof node.position.x === 'number' &&
          typeof node.position.y === 'number' &&
          !!node.data &&
          typeof node.data === 'object'
        )
      })
    : []
  const edgeKinds = new Set(['flow', 'mind', 'ref'])
  const edges = Array.isArray(record.edges)
    ? (record.edges as unknown[]).filter((e): e is CanvasEdge => {
        const edge = e as CanvasEdge
        return (
          !!edge &&
          typeof edge === 'object' &&
          typeof edge.id === 'string' &&
          typeof edge.source === 'string' &&
          typeof edge.target === 'string' &&
          edgeKinds.has(edge.kind)
        )
      })
    : []
  const viewport = record.viewport as CanvasDoc['viewport'] | undefined
  return {
    v: 1,
    sessionId,
    version: typeof record.version === 'number' && record.version >= 1 ? Math.floor(record.version) : 1,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : new Date().toISOString(),
    viewport:
      viewport && typeof viewport.x === 'number' && typeof viewport.y === 'number' && typeof viewport.zoom === 'number'
        ? viewport
        : { x: 0, y: 0, zoom: 1 },
    nodes,
    edges,
  }
}

/** 自动排布：把新节点放到既有内容右侧空位（agent 未给坐标时；批内互推因 nodes 为运行中副本）
 *  M31：导出供 media_* 工具计算产物落位目标（canvasTarget）复用。 */
export function autoPosition(doc: CanvasDoc): { x: number; y: number } {
  if (doc.nodes.length === 0) return { x: 0, y: 0 }
  let maxX = -Infinity
  let minY = Infinity
  for (const node of doc.nodes) {
    maxX = Math.max(maxX, node.position.x + (node.width ?? 240))
    minY = Math.min(minY, node.position.y)
  }
  return { x: Math.round(maxX + 80), y: Math.round(minY) }
}

export interface CanvasStoreOptions {
  /** 应用数据目录（文档落 <dataDir>/canvas/<sessionId>.json） */
  dataDir: string
  /** 变更广播（index 注入：notify:canvas-changed；测试可缺省） */
  publish?: (sessionId: string, version: number, by: 'agent' | 'user') => void
}

/**
 * 画布文档存储：磁盘 JSON + 内存缓存。
 * 并发模型：本地单用户 + 单进程串行事件循环，save/applyOps 为同步临界区（无锁即可）。
 */
export class CanvasStore {
  private readonly dir: string
  private readonly cache = new Map<string, CanvasDoc>()

  constructor(private readonly opts: CanvasStoreOptions) {
    this.dir = path.join(opts.dataDir, 'canvas')
    ensureDir(this.dir)
  }

  private fileFor(sessionId: string): string {
    // sessionId 为服务端生成（sess_xxx），仍做一层防御
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '')
    return path.join(this.dir, `${safe}.json`)
  }

  /** 读取文档（懒加载 + 缓存；文件缺失 / 损坏 → 空白文档） */
  get(sessionId: string): CanvasDoc {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const file = this.fileFor(sessionId)
    let doc: CanvasDoc
    if (fs.existsSync(file)) {
      try {
        doc = sanitizeDoc(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, sessionId)
      } catch {
        doc = emptyDoc(sessionId)
      }
    } else {
      doc = emptyDoc(sessionId)
    }
    this.cache.set(sessionId, doc)
    return doc
  }

  /** 原子落盘（tmp + rename；失败不污染现有文件） */
  private flush(doc: CanvasDoc): void {
    const file = this.fileFor(doc.sessionId)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(doc)}\n`, 'utf8')
    fs.renameSync(tmp, file)
  }

  /**
   * 用户保存（PUT）：乐观锁 —— baseVersion 必须等于当前 version；
   * 成功返回新文档（version+1），冲突抛 CanvasDocConflictError（附服务端最新版）。
   */
  save(sessionId: string, incoming: Pick<CanvasDoc, 'nodes' | 'edges' | 'viewport'>, baseVersion: number): CanvasDoc {
    const current = this.get(sessionId)
    if (baseVersion !== current.version) throw new CanvasDocConflictError(current)
    const next: CanvasDoc = {
      v: 1,
      sessionId,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      viewport: incoming.viewport,
      nodes: incoming.nodes,
      edges: incoming.edges,
    }
    this.cache.set(sessionId, next)
    this.flush(next)
    this.opts.publish?.(sessionId, next.version, 'user')
    return next
  }

  /**
   * agent 写入（canvas_write 工具）：读-改-写内部完成（不走版本锁），
   * 返回生效结果（add_node / connect 的新 id，供工具回灌模型）。
   */
  applyOps(sessionId: string, ops: CanvasOp[]): { doc: CanvasDoc; applied: Array<{ op: CanvasOp['op']; id?: string }> } {
    const current = this.get(sessionId)
    const nodes = [...current.nodes]
    const edges = [...current.edges]
    const applied: Array<{ op: CanvasOp['op']; id?: string }> = []
    const indexOf = (id: string): number => nodes.findIndex((n) => n.id === id)

    for (const op of ops) {
      switch (op.op) {
        case 'add_node': {
          const id = op.node.id ?? newNodeId()
          const position = op.node.position ?? autoPosition({ ...current, nodes })
          nodes.push({
            id,
            type: op.node.type,
            position,
            width: op.node.width,
            height: op.node.height,
            data: op.node.data,
          })
          applied.push({ op: op.op, id })
          break
        }
        case 'update_node': {
          const idx = indexOf(op.id)
          if (idx < 0) {
            applied.push({ op: op.op, id: op.id })
            break
          }
          const prev = nodes[idx]!
          nodes[idx] = {
            ...prev,
            position: op.position ?? prev.position,
            width: op.width ?? prev.width,
            height: op.height ?? prev.height,
            data: op.data ? ({ ...prev.data, ...op.data } as CanvasNode['data']) : prev.data,
          }
          applied.push({ op: op.op, id: op.id })
          break
        }
        case 'remove_node': {
          const idx = indexOf(op.id)
          if (idx >= 0) nodes.splice(idx, 1)
          for (let i = edges.length - 1; i >= 0; i -= 1) {
            const edge = edges[i]!
            if (edge.source === op.id || edge.target === op.id) edges.splice(i, 1)
          }
          applied.push({ op: op.op, id: op.id })
          break
        }
        case 'connect': {
          const exists = edges.some((e) => e.source === op.source && e.target === op.target && e.kind === (op.kind ?? 'flow'))
          if (exists || indexOf(op.source) < 0 || indexOf(op.target) < 0) {
            applied.push({ op: op.op })
            break
          }
          const id = newEdgeId()
          edges.push({ id, source: op.source, target: op.target, kind: op.kind ?? 'flow' })
          applied.push({ op: op.op, id })
          break
        }
        case 'remove_edge': {
          const idx = edges.findIndex((e) => e.id === op.id)
          if (idx >= 0) edges.splice(idx, 1)
          applied.push({ op: op.op, id: op.id })
          break
        }
      }
    }

    const next: CanvasDoc = {
      ...current,
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
      nodes,
      edges,
    }
    this.cache.set(sessionId, next)
    this.flush(next)
    this.opts.publish?.(sessionId, next.version, 'agent')
    return { doc: next, applied }
  }

  /** 会话删除时清理（可选；保留文件亦可，当前由 sessions 路由决定是否调用） */
  remove(sessionId: string): void {
    this.cache.delete(sessionId)
    const file = this.fileFor(sessionId)
    if (fs.existsSync(file)) fs.rmSync(file, { force: true })
  }
}
