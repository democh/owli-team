/**
 * P2 记忆域隔离测试：写入推导 / 同内容跨空间去重独立 / 查询与召回的空间过滤。
 */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { SessionStore } from '../src/store/sessions.js'
import { recallMemories, type RecallIndexDeps } from '../src/memory/recall.js'
import type { VecIndex } from '../src/memory/vectors.js'

function setup() {
  const db = openDatabase(':memory:', { memory: true })
  const sessions = new SessionStore(db)
  const memory = new MemoryStore(db, undefined, (sid) => sessions.getSession(sid)?.spaceId ?? 'default')
  return { db, sessions, memory }
}

describe('P2：记忆域隔离', () => {
  it('写入按来源会话推导空间域；同内容在不同空间各自成条', () => {
    const { sessions, memory } = setup()
    const work = sessions.create([], '工作', { spaceId: 'work' })
    const life = sessions.create([], '生活', { spaceId: 'life' })

    const a = memory.upsertScoped('agent', 'pm', 'fact', '用户偏好简洁结论', { sourceSessionId: work.id })
    const b = memory.upsertScoped('agent', 'pm', 'fact', '用户偏好简洁结论', { sourceSessionId: life.id })
    expect(a?.item.spaceId).toBe('work')
    expect(b?.item.spaceId).toBe('life')
    expect(b?.added).toBe(true) // 跨空间不互相去重
    // 同空间重复写入仍去重
    const dup = memory.upsertScoped('agent', 'pm', 'fact', '用户偏好简洁结论', { sourceSessionId: work.id })
    expect(dup?.added).toBe(false)
  })

  it('无来源会话 / 解析失败 = 跨域共享（spaceId 空）', () => {
    const { memory } = setup()
    const g = memory.upsertScoped('global', 'global', 'fact', '我叫小明', {})
    expect(g?.item.spaceId).toBeUndefined()
  })

  it('query 空间过滤：具体空间 = 同空间 + 跨域共享；shared = 仅跨域共享', () => {
    const { sessions, memory } = setup()
    const work = sessions.create([], '工作', { spaceId: 'work' })
    memory.upsertScoped('agent', 'pm', 'fact', '工作域事实', { sourceSessionId: work.id })
    memory.upsertScoped('global', 'global', 'fact', '共享事实', {})

    const inWork = memory.query({ spaceId: 'work' })
    expect(inWork.map((m) => m.content).sort()).toEqual(['共享事实', '工作域事实'])
    const inLife = memory.query({ spaceId: 'life' })
    expect(inLife.map((m) => m.content)).toEqual(['共享事实'])
    const shared = memory.query({ spaceId: 'shared' })
    expect(shared.map((m) => m.content)).toEqual(['共享事实'])
    // 不过滤 = 全量（兼容旧行为）
    expect(memory.query({}).length).toBe(2)
  })

  it('召回层：异空间带标签记忆被过滤，跨域共享保留；缺省 spaceId 不过滤', () => {
    const { sessions, memory } = setup()
    const work = sessions.create([], '工作', { spaceId: 'work' })
    const wa = memory.upsertScoped('agent', 'pm', 'fact', '工作域事实', { sourceSessionId: work.id })!.item
    const sh = memory.upsertScoped('global', 'global', 'fact', '共享事实', {})!.item

    // 伪向量索引：两桶各命中两条（sim 1.0），isolating 过滤逻辑于 recallMemories
    const index = {
      query: (_bucket: string, _vec: Float32Array, k: number) =>
        [
          { memoryId: wa.id, sim: 1 },
          { memoryId: sh.id, sim: 1 },
        ].slice(0, k),
    } as unknown as VecIndex
    const deps: RecallIndexDeps = { index, store: memory }
    const base = { queryText: '事实', queryVec: new Float32Array(1), buckets: ['agent:pm'], topK: 5, minScore: 0, budgetTokens: 1000 }

    const inLife = recallMemories(deps, { ...base, spaceId: 'life' })
    expect(inLife.items.map((i) => i.content)).toEqual(['共享事实'])
    const inWork = recallMemories(deps, { ...base, spaceId: 'work' })
    expect(inWork.items.map((i) => i.content).sort()).toEqual(['共享事实', '工作域事实'])
    const noFilter = recallMemories(deps, base)
    expect(noFilter.items.length).toBe(2)
  })
})
