/**
 * M87：交付件单一数据源 —— 事件合并 + 增量刷新（防 SSE/WS 双通道 O(N) 全量重拉）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Artifact } from '@multi-agent/shared'
import { useArtifactStore } from '../src/stores/artifact-store'
import { useSessionStore } from '../src/stores/session-store'

const T0 = '2026-10-25T10:00:00.000Z'

function artifact(path: string, size = 1024): Artifact {
  return { path, size, mtime: size, kind: 'markdown', updatedAt: T0 }
}

function stubFetch(changes: { revision: number; upserts: Artifact[]; deletes: string[] }): {
  listCalls: () => number
  changeCalls: () => number
} {
  let listCalls = 0
  let changeCalls = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/artifacts/changes')) {
        changeCalls++
        return new Response(JSON.stringify(changes), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }
      listCalls++
      return new Response(JSON.stringify({ artifacts: [artifact('docs/需求.md')], revision: 1, total: 1 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
  )
  return { listCalls: () => listCalls, changeCalls: () => changeCalls }
}

describe('M87：交付件 store', () => {
  beforeEach(() => {
    useArtifactStore.setState({
      sessionId: undefined,
      revision: 0,
      artifacts: [],
      byPath: new Map(),
      loading: false,
      loaded: false,
    })
    useSessionStore.setState({ currentId: undefined, artifactVersion: 0 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('超过 500 个文件时顺序取齐分页，不把首批当作完整工作区', async () => {
    const files = Array.from({ length: 601 }, (_, i) => artifact(`file-${i}.md`))
    const fetchMock = vi.fn(async (input: string) => {
      const offset = Number(new URL(input, 'http://local').searchParams.get('offset') ?? 0)
      return new Response(
        JSON.stringify({
          artifacts: files.slice(offset, offset + 500),
          total: files.length,
          hasMore: offset === 0,
          revision: 9,
        }),
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    await useArtifactStore.getState().ensure('s1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(useArtifactStore.getState().artifacts).toHaveLength(601)
    expect(useArtifactStore.getState().total).toBe(601)
    expect(useArtifactStore.getState().byPath.has('file-600.md')).toBe(true)
  })

  it('手动校准发送 refresh=1，普通缓存刷新不触发扫盘', async () => {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url)
        return new Response(JSON.stringify({ artifacts: [], total: 0, revision: 1 }))
      }),
    )
    await useArtifactStore.getState().ensure('s1', { force: true })
    await useArtifactStore.getState().ensure('s1', { force: true, reconcile: true })
    expect(calls).toEqual(['/api/sessions/s1/artifacts', '/api/sessions/s1/artifacts?refresh=1'])
  })

  it('分页期间 revision 改变，重新取快照而不是拼接不同版本', async () => {
    const pages = [
      { artifacts: [artifact('old.md')], total: 2, hasMore: true, revision: 1 },
      { artifacts: [artifact('second.md')], total: 2, hasMore: false, revision: 2 },
      { artifacts: [artifact('new.md'), artifact('second.md')], total: 2, hasMore: false, revision: 2 },
    ]
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(pages.shift()))),
    )
    await useArtifactStore.getState().ensure('s1')
    expect(useArtifactStore.getState().artifacts.map((item) => item.path)).toEqual(['new.md', 'second.md'])
    expect(useArtifactStore.getState().revision).toBe(2)
  })

  it('A → B → A 的迟到响应不能覆盖最新列表', async () => {
    const responses: Array<(response: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))),
    )
    const oldA = useArtifactStore.getState().ensure('a')
    const b = useArtifactStore.getState().ensure('b')
    const newA = useArtifactStore.getState().ensure('a')
    responses[2](new Response(JSON.stringify({ artifacts: [artifact('new.md')], revision: 3 })))
    await newA
    responses[0](new Response(JSON.stringify({ artifacts: [artifact('old.md')], revision: 1 })))
    responses[1](new Response(JSON.stringify({ artifacts: [artifact('b.md')], revision: 2 })))
    await Promise.all([oldA, b])
    expect(useArtifactStore.getState().artifacts.map((item) => item.path)).toEqual(['new.md'])
  })

  it('加载失败保留独立错误态，重试成功后清除', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('网络失败'))
        .mockResolvedValueOnce(new Response(JSON.stringify({ artifacts: [artifact('ok.md')], revision: 1 }))),
    )
    await useArtifactStore.getState().ensure('s1')
    expect(useArtifactStore.getState().error).toBe('网络失败')
    expect(useArtifactStore.getState().loaded).toBe(false)
    await useArtifactStore.getState().ensure('s1', { force: true })
    expect(useArtifactStore.getState().error).toBeNull()
    expect(useArtifactStore.getState().loaded).toBe(true)
  })

  it('一轮多次 artifact:updated → 合并为一次增量请求，并应用 upserts / deletes', async () => {
    const calls = stubFetch({
      revision: 2,
      upserts: [artifact('docs/接口.md', 2048)],
      deletes: ['docs/需求.md'],
    })

    // 首载：一次全量
    useSessionStore.setState({ currentId: 's1' })
    await useArtifactStore.getState().ensure('s1')
    expect(calls.listCalls()).toBe(1)
    expect(useArtifactStore.getState().byPath.get('docs/需求.md')).toBeDefined()

    // 三个事件（SSE + WS + 手动刷新）在合并窗口内 → 只发一次增量
    useSessionStore.setState({ artifactVersion: 1 })
    useSessionStore.setState({ artifactVersion: 2 })
    useSessionStore.setState({ artifactVersion: 3 })
    await new Promise((resolve) => setTimeout(resolve, 320))

    expect(calls.changeCalls()).toBe(1)
    expect(calls.listCalls()).toBe(1)
    const state = useArtifactStore.getState()
    expect(state.revision).toBe(2)
    expect(state.byPath.has('docs/需求.md')).toBe(false)
    expect(state.byPath.get('docs/接口.md')?.size).toBe(2048)
  })

  it('会话切换：重置旧数据并按新会话重新拉取', async () => {
    stubFetch({ revision: 1, upserts: [], deletes: [] })
    useSessionStore.setState({ currentId: 's1' })
    await useArtifactStore.getState().ensure('s1')
    useSessionStore.setState({ currentId: 's2' })
    await useArtifactStore.getState().ensure('s2')
    expect(useArtifactStore.getState().sessionId).toBe('s2')
  })
})
