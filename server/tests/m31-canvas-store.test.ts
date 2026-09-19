/**
 * M31 单测：画布文档存储（CanvasStore）—— 持久化 / 乐观锁 / ops 应用 / 防御清洗。
 *
 * 守护四件事：
 * - 单文档 JSON 往返（nodes / edges / viewport 无损）与原子落盘（重启后磁盘为真相）；
 * - version 乐观锁：正确 baseVersion 递增保存；过期保存抛冲突且携带服务端最新版；
 * - applyOps（agent 写入）：读-改-写、自动排布、级联删边、重复连线去重、幂等 applied 结果；
 * - 防御：文件损坏 / 结构性非法条目（手改文件）不得拖垮画布打开。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CanvasNodeInput } from '@multi-agent/shared'
import { CanvasDocConflictError, CanvasStore } from '../src/canvas/store.js'
import { makeTmpDir } from './helpers.js'

interface PublishedChange {
  sessionId: string
  version: number
  by: string
}

function makeStore(dataDir = makeTmpDir('ma-canvas-')): {
  store: CanvasStore
  dataDir: string
  published: PublishedChange[]
} {
  const published: PublishedChange[] = []
  const store = new CanvasStore({
    dataDir,
    publish: (sessionId, version, by) => published.push({ sessionId, version, by }),
  })
  return { store, dataDir, published }
}

const noteNode = (text: string, id?: string): CanvasNodeInput => ({ id, type: 'note', data: { text } })

describe('M31 画布文档：基础读写与持久化', () => {
  it('新会话：空白文档（v=1 / version=1 / 空画布）', () => {
    const { store } = makeStore()
    const doc = store.get('sess_new')
    expect(doc.v).toBe(1)
    expect(doc.sessionId).toBe('sess_new')
    expect(doc.version).toBe(1)
    expect(Number.isNaN(Date.parse(doc.updatedAt))).toBe(false)
    expect(doc.nodes).toEqual([])
    expect(doc.edges).toEqual([])
    expect(doc.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('save：version 递增 + 原子落盘 + 广播 by=user；新实例（模拟重启）读回一致', () => {
    const { store, dataDir, published } = makeStore()
    const saved = store.save(
      'sess_a',
      {
        viewport: { x: 120, y: -40, zoom: 1.5 },
        nodes: [{ id: 'nd_1', type: 'note', position: { x: 10, y: 20 }, data: { text: '你好画布' } }],
        edges: [{ id: 'ed_1', source: 'nd_1', target: 'nd_1', kind: 'ref' }],
      },
      1,
    )
    expect(saved.version).toBe(2)
    expect(published).toEqual([{ sessionId: 'sess_a', version: 2, by: 'user' }])

    // 磁盘为真相：新实例无缓存，读回内容一致
    const fresh = new CanvasStore({ dataDir })
    const loaded = fresh.get('sess_a')
    expect(loaded.version).toBe(2)
    expect(loaded.viewport).toEqual({ x: 120, y: -40, zoom: 1.5 })
    expect(loaded.nodes).toHaveLength(1)
    expect(loaded.nodes[0]!.data).toEqual({ text: '你好画布' })
    expect(loaded.edges[0]!.kind).toBe('ref')
  })

  it('save：过期 baseVersion → 冲突异常（携带服务端最新版，不落盘）', () => {
    const { store } = makeStore()
    store.save('sess_b', { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, 1)
    let thrown: unknown
    try {
      store.save('sess_b', { viewport: { x: 9, y: 9, zoom: 2 }, nodes: [], edges: [] }, 1)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(CanvasDocConflictError)
    const conflict = thrown as CanvasDocConflictError
    expect(conflict.current.version).toBe(2)
    expect(conflict.current.viewport).toEqual({ x: 0, y: 0, zoom: 1 })
  })

  it('文件损坏（非法 JSON）：get 返回空白文档而非抛错', () => {
    const { store, dataDir } = makeStore()
    fs.writeFileSync(path.join(dataDir, 'canvas', 'sess_bad.json'), '{ 不是 JSON', 'utf8')
    const doc = store.get('sess_bad')
    expect(doc.version).toBe(1)
    expect(doc.nodes).toEqual([])
  })

  it('结构性非法条目（手改文件）：nodes / edges 被清洗，合法条目保留', () => {
    const { store, dataDir } = makeStore()
    fs.writeFileSync(
      path.join(dataDir, 'canvas', 'sess_dirty.json'),
      JSON.stringify({
        v: 1,
        version: 7,
        viewport: { x: 1, y: 2, zoom: 1 },
        nodes: [
          { id: 'nd_ok', type: 'note', position: { x: 0, y: 0 }, data: { text: 'ok' } },
          { id: 'nd_bad', type: 'note', position: { x: 'oops' }, data: {} },
          { type: 'note', position: { x: 0, y: 0 }, data: {} },
        ],
        edges: [
          { id: 'ed_ok', source: 'nd_ok', target: 'nd_ok', kind: 'mind' },
          { id: 'ed_bad', source: 'nd_ok', target: 'nd_ok', kind: 'bogus' },
        ],
      }),
      'utf8',
    )
    const doc = store.get('sess_dirty')
    expect(doc.version).toBe(7)
    expect(doc.nodes.map((n) => n.id)).toEqual(['nd_ok'])
    expect(doc.edges.map((e) => e.id)).toEqual(['ed_ok'])
  })

  it('remove：清缓存并删除文件', () => {
    const { store, dataDir } = makeStore()
    store.save('sess_rm', { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, 1)
    const file = path.join(dataDir, 'canvas', 'sess_rm.json')
    expect(fs.existsSync(file)).toBe(true)
    store.remove('sess_rm')
    expect(fs.existsSync(file)).toBe(false)
    expect(store.get('sess_rm').version).toBe(1)
  })
})

describe('M31 画布文档：applyOps（agent 写入）', () => {
  it('add_node：给定坐标与自动排布（未给坐标落在既有内容右侧空位）+ 广播 by=agent', () => {
    const { store, published } = makeStore()
    const first = store.applyOps('sess_ops', [{ op: 'add_node', node: { ...noteNode('一号'), position: { x: 100, y: 50 }, width: 300 } }])
    expect(first.applied[0]!.id).toMatch(/^nd_/)
    expect(first.doc.nodes[0]!.position).toEqual({ x: 100, y: 50 })

    const second = store.applyOps('sess_ops', [{ op: 'add_node', node: noteNode('二号') }])
    const placed = second.doc.nodes[1]!
    expect(placed.position.x).toBeGreaterThan(100) // 自动排布在右侧
    expect(placed.position.y).toBe(50)
    expect(published.at(-1)).toEqual({ sessionId: 'sess_ops', version: second.doc.version, by: 'agent' })
  })

  it('add_node：批量同一批内互推位置（第二张卡不叠在第一张上）', () => {
    const { store } = makeStore()
    const result = store.applyOps('sess_batch', [
      { op: 'add_node', node: noteNode('a', 'nd_a') },
      { op: 'add_node', node: noteNode('b', 'nd_b') },
    ])
    const a = result.doc.nodes.find((n) => n.id === 'nd_a')!
    const b = result.doc.nodes.find((n) => n.id === 'nd_b')!
    expect(b.position.x).toBeGreaterThan(a.position.x)
    expect(result.applied.map((x) => x.id)).toEqual(['nd_a', 'nd_b'])
  })

  it('update_node：data 浅合并 / 坐标与尺寸更新；不存在 id 时容错', () => {
    const { store } = makeStore()
    store.applyOps('sess_up', [
      { op: 'add_node', node: { id: 'nd_1', type: 'image', position: { x: 0, y: 0 }, data: { artifact: 'canvas/a.png', prompt: '旧词' } } },
    ])
    const result = store.applyOps('sess_up', [
      { op: 'update_node', id: 'nd_1', data: { prompt: '新词' }, position: { x: 300, y: 0 }, width: 480 },
      { op: 'update_node', id: 'nd_missing', data: { text: 'x' } },
    ])
    const node = result.doc.nodes[0]!
    expect(node.data).toEqual({ artifact: 'canvas/a.png', prompt: '新词' }) // artifact 保留
    expect(node.position).toEqual({ x: 300, y: 0 })
    expect(node.width).toBe(480)
    expect(result.applied[1]).toEqual({ op: 'update_node', id: 'nd_missing' })
  })

  it('remove_node：级联删除关联边（其他边保留）', () => {
    const { store } = makeStore()
    const base = store.applyOps('sess_del', [
      { op: 'add_node', node: noteNode('a', 'nd_a') },
      { op: 'add_node', node: noteNode('b', 'nd_b') },
      { op: 'add_node', node: noteNode('c', 'nd_c') },
      { op: 'connect', source: 'nd_a', target: 'nd_b' },
      { op: 'connect', source: 'nd_b', target: 'nd_c' },
    ])
    expect(base.doc.edges).toHaveLength(2)
    const result = store.applyOps('sess_del', [{ op: 'remove_node', id: 'nd_b' }])
    expect(result.doc.nodes.map((n) => n.id)).toEqual(['nd_a', 'nd_c'])
    expect(result.doc.edges).toHaveLength(0) // 两条边均与 nd_b 相连
  })

  it('connect：重复连线去重 / 悬空端点拒绝 / remove_edge 生效', () => {
    const { store } = makeStore()
    store.applyOps('sess_edge', [
      { op: 'add_node', node: noteNode('a', 'nd_a') },
      { op: 'add_node', node: noteNode('b', 'nd_b') },
    ])
    const first = store.applyOps('sess_edge', [{ op: 'connect', source: 'nd_a', target: 'nd_b', kind: 'flow' }])
    expect(first.applied[0]!.id).toMatch(/^ed_/)

    const dup = store.applyOps('sess_edge', [
      { op: 'connect', source: 'nd_a', target: 'nd_b', kind: 'flow' }, // 重复 → 不再建边
      { op: 'connect', source: 'nd_a', target: 'nd_ghost' }, // 悬空 → 拒绝
      { op: 'connect', source: 'nd_a', target: 'nd_b', kind: 'ref' }, // 不同语义 → 允许
    ])
    expect(dup.doc.edges).toHaveLength(2)
    expect(dup.applied[0]!.id).toBeUndefined()
    expect(dup.applied[1]!.id).toBeUndefined()
    expect(dup.applied[2]!.id).toMatch(/^ed_/)

    const removed = store.applyOps('sess_edge', [{ op: 'remove_edge', id: dup.applied[2]!.id! }])
    expect(removed.doc.edges).toHaveLength(1)
    expect(removed.doc.edges[0]!.kind).toBe('flow')
  })

  it('applyOps 与 save 的版本互锁：ops 后旧 baseVersion 保存 → 冲突', () => {
    const { store } = makeStore()
    store.applyOps('sess_mix', [{ op: 'add_node', node: noteNode('agent 放的') }]) // version 1 → 2
    expect(() => store.save('sess_mix', { viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }, 1)).toThrow(
      CanvasDocConflictError,
    )
    const saved = store.save(
      'sess_mix',
      { viewport: { x: 0, y: 0, zoom: 1 }, nodes: store.get('sess_mix').nodes, edges: [] },
      2,
    )
    expect(saved.version).toBe(3)
  })
})
