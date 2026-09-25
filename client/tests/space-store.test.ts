/**
 * 空间（Space）store 单测：加载（成功 / 所选空间被删回退 / 未装配兜底）/
 * 切换持久化 / 自建追加排序 / 删除回退 / 默认空间映射。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '@multi-agent/shared'
import { spaceIdOf, useSpaceStore } from '../src/stores/space-store'

const T0 = '2026-09-01T00:00:00.000Z'
const WORK: Space = {
  id: 'work',
  name: '工作',
  kind: 'work',
  builtin: true,
  sort: 1,
  createdAt: T0,
  updatedAt: T0,
}
const LIFE: Space = {
  id: 'life',
  name: '生活',
  kind: 'life',
  builtin: true,
  sort: 2,
  createdAt: T0,
  updatedAt: T0,
}
const CUSTOM: Space = {
  id: 'sp_shop',
  name: '我的小店',
  kind: 'custom',
  builtin: false,
  sort: 5,
  createdAt: T0,
  updatedAt: T0,
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  useSpaceStore.setState({ spaces: [], currentId: 'default', loaded: false })
})

describe('space-store：加载', () => {
  it('成功加载并保留合法 currentId；所选空间不存在时回退 default', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ spaces: [WORK, LIFE] }))
    useSpaceStore.getState().setCurrent('life')
    await useSpaceStore.getState().loadSpaces()
    expect(useSpaceStore.getState().spaces.map((s) => s.id)).toEqual(['work', 'life'])
    expect(useSpaceStore.getState().currentId).toBe('life')
    expect(useSpaceStore.getState().loaded).toBe(true)

    // 服务端侧该空间已被删除 → 下次加载回退 default
    fetchMock.mockResolvedValue(jsonResponse({ spaces: [WORK] }))
    await useSpaceStore.getState().loadSpaces()
    expect(useSpaceStore.getState().currentId).toBe('default')
  })

  it('未装配（响应缺 spaces 字段）→ 空列表 + loaded 置位（UI 隐藏切换器，不抛错）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await useSpaceStore.getState().loadSpaces()
    expect(useSpaceStore.getState().spaces).toEqual([])
    expect(useSpaceStore.getState().loaded).toBe(true)
  })
})

describe('space-store：切换与持久化', () => {
  it('setCurrent：currentId 落 localStorage（跨重启保留）', () => {
    useSpaceStore.getState().setCurrent('work')
    expect(localStorage.getItem('owli.currentSpace')).toBe('work')
    expect(useSpaceStore.getState().currentId).toBe('work')
  })
})

describe('space-store：自建与删除', () => {
  it('createSpace：POST 后追加并按 sort 排序', async () => {
    useSpaceStore.setState({ spaces: [WORK, LIFE], currentId: 'default', loaded: true })
    fetchMock.mockResolvedValue(jsonResponse({ space: CUSTOM }, 201))
    const created = await useSpaceStore.getState().createSpace('我的小店')
    expect(created.id).toBe('sp_shop')
    expect(useSpaceStore.getState().spaces.map((s) => s.id)).toEqual(['work', 'life', 'sp_shop'])
  })

  it('removeSpace：DELETE 后移除；删除当前空间时 currentId 回退 default', async () => {
    useSpaceStore.setState({ spaces: [WORK, LIFE], currentId: 'life', loaded: true })
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, sessionsDetached: 3 }))
    const result = await useSpaceStore.getState().removeSpace('life')
    expect(result.sessionsDetached).toBe(3)
    expect(useSpaceStore.getState().spaces.map((s) => s.id)).toEqual(['work'])
    expect(useSpaceStore.getState().currentId).toBe('default')
  })
})

describe('space-store：默认空间映射', () => {
  it('spaceIdOf：缺省 = default（存量零差异）', () => {
    expect(spaceIdOf({})).toBe('default')
    expect(spaceIdOf({ spaceId: 'work' })).toBe('work')
  })
})
