/**
 * 空间（Space）测试：内置种子 / CRUD / 内置不可删 / 会话归属与变更 / 删除空间外键置空。
 */
import { describe, expect, it } from 'vitest'
import { openDatabase } from '../src/store/db.js'
import { SessionStore } from '../src/store/sessions.js'
import { SpaceStore, applySpaceSoulDefaults } from '../src/store/spaces.js'

function setup() {
  const db = openDatabase(':memory:', { memory: true })
  const spaces = new SpaceStore(db)
  const sessions = new SessionStore(db)
  return { db, spaces, sessions }
}

describe('空间（Space）', () => {
  it('内置三空间落种（我的 / 工作 / 生活），重复构造幂等', () => {
    const { db, spaces } = setup()
    const list = spaces.list()
    expect(list.map((s) => s.id)).toEqual(['default', 'work', 'life'])
    expect(list.every((s) => s.builtin)).toBe(true)
    // 重复构造（ensureBuiltins 幂等，不重复插入 / 不漂移）
    const again = new SpaceStore(db)
    expect(again.list().length).toBe(3)
    expect(again.get('default')!.createdAt).not.toBe('builtin')
  })

  it('自建空间 CRUD：创建排序递增、改名、删除返回受影响会话数', () => {
    const { spaces, sessions } = setup()
    sessions.create([], '工作会话', { spaceId: 'work' })
    const custom = spaces.create({ name: '我的小店' })
    expect(custom.kind).toBe('custom')
    expect(custom.sort).toBeGreaterThan(2)
    sessions.create([], '店里的事', { spaceId: custom.id })

    const renamed = spaces.update(custom.id, { name: '副业' })
    expect(renamed?.name).toBe('副业')

    const { removed, sessionsDetached } = spaces.remove(custom.id)
    expect(removed).toBe(true)
    expect(sessionsDetached).toBe(1)
    // 外键置空 → 会话回到「我的」语义（spaceId 缺省）
    expect(sessions.list(null).find((s) => s.title === '店里的事')?.spaceId).toBeUndefined()
  })

  it('内置空间不可删除', () => {
    const { spaces } = setup()
    expect(() => spaces.remove('work')).toThrow('内置空间不可删除')
  })

  it('自建空间用户级隔离：listForUser 仅见「内置 ∪ 本人自建」；ownerOf 三态', () => {
    const { spaces } = setup()
    const a = spaces.create({ name: 'A 的空间' }, 'u1')
    const b = spaces.create({ name: 'B 的空间' }, 'u2')
    expect(spaces.listForUser('u1').map((s) => s.id)).toEqual(['default', 'work', 'life', a.id])
    expect(spaces.listForUser('u2').map((s) => s.id)).toEqual(['default', 'work', 'life', b.id])
    // 兼容模式归属 'local'：内置（NULL）+ 'local' 自建
    const local = spaces.create({ name: '本地空间' }, 'local')
    expect(spaces.listForUser('local').map((s) => s.id)).toEqual(['default', 'work', 'life', local.id])
    // 归属三态
    expect(spaces.ownerOf(a.id)).toBe('u1')
    expect(spaces.ownerOf('work')).toBeNull()
    expect(spaces.ownerOf('nope')).toBeUndefined()
  })

  it('会话空间归属：缺省 default 不落字段，指定空间随行投影，setSpace 往返', () => {
    const { spaces, sessions } = setup()
    const plain = sessions.create([], '普通会话')
    expect(plain.spaceId).toBeUndefined()
    expect(sessions.list(null)[0].spaceId).toBeUndefined()

    const work = sessions.create([], '工作会话', { spaceId: 'work' })
    expect(work.spaceId).toBe('work')
    // 落库重读（绕过缓存）
    sessions.flushAll()
    sessions.invalidateCache()
    expect(sessions.getSession(work.id)?.spaceId).toBe('work')

    // setSpace 变更与归位（防抖落库，断言前 flush）
    sessions.setSpace(work.id, 'life')
    expect(sessions.getSession(work.id)?.spaceId).toBe('life')
    sessions.flushAll()
    expect(spaces.sessionCount('life')).toBe(1)
    sessions.setSpace(work.id, 'default')
    expect(sessions.getSession(work.id)?.spaceId).toBeUndefined()
    sessions.flushAll()
    sessions.invalidateCache()
    expect(sessions.getSession(work.id)?.spaceId).toBeUndefined()
  })
})

describe('P3：空间默认灵魂', () => {
  it('soulOverrides 读写与清除（非法条目剔除；null 清空）', () => {
    const { spaces } = setup()
    const updated = spaces.update('work', { soulOverrides: { coach: 'career', pm: 'zen' } })
    expect(updated?.soulOverrides).toEqual({ coach: 'career', pm: 'zen' })
    // 重读（直查库路径）
    expect(spaces.get('work')?.soulOverrides).toEqual({ coach: 'career', pm: 'zen' })
    const cleared = spaces.update('work', { soulOverrides: null })
    expect(cleared?.soulOverrides).toBeUndefined()
    expect(spaces.get('work')?.soulOverrides).toBeUndefined()
  })

  it('applySpaceSoulDefaults：填充缺省 / 显式优先 / 分身键跳过 / 无绑定零差异', () => {
    const { spaces } = setup()
    spaces.update('life', { soulOverrides: { coach: 'zen', pm: 'strict' } })
    const life = spaces.get('life')

    // 填充缺省 + 显式优先 + 分身键跳过
    const merged = applySpaceSoulDefaults(life, ['coach', 'pm', 'designer~wild'], { pm: 'custom' })
    expect(merged).toEqual({ coach: 'zen', pm: 'custom' })

    // 无绑定空间 → 原样返回（引用不变，零差异）
    const none = applySpaceSoulDefaults(spaces.get('default'), ['coach'], undefined)
    expect(none).toBeUndefined()
    // 空间不存在 → 原样
    expect(applySpaceSoulDefaults(undefined, ['coach'], { a: 'b' })).toEqual({ a: 'b' })
  })
})
