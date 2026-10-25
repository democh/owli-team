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
