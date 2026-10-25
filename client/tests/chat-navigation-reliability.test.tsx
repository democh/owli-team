import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatMessage, SessionSummary } from '@multi-agent/shared'
import { ChatArea } from '../src/components/chat/ChatArea'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { useRunStore } from '../src/stores/run-store'
import { useAgentStore } from '../src/stores/agent-store'
import { openConversation, openContacts } from '../src/lib/navigation'

const virtualizer = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
  getVirtualItems: () => [],
  getTotalSize: () => 0,
  measureElement: vi.fn(),
}))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: () => virtualizer }))
vi.mock('../src/components/scene/SceneStage', () => ({
  SceneStage: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('../src/components/chat/Composer', () => ({ Composer: () => null }))
vi.mock('../src/components/chat/PlanReviewCard', () => ({ PlanReviewCard: () => null }))
vi.mock('../src/components/sessions/WorktreeBar', () => ({ WorktreeBar: () => null }))

const session: SessionSummary = {
  id: 's1',
  title: '定位测试',
  participantIds: [],
  messageCount: 4,
  createdAt: '2026-10-25T00:00:00.000Z',
  updatedAt: '2026-10-25T00:00:00.000Z',
}
function message(seq: number): ChatMessage {
  return {
    id: `m${seq}`,
    seq,
    sessionId: 's1',
    role: 'user',
    content: `消息${seq}`,
    status: 'complete',
    mentions: [],
    createdAt: session.createdAt,
  }
}
const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json({ artifacts: [], runs: [] })),
  )
  useSessionStore.setState({
    sessions: [session],
    currentId: 's1',
    current: session,
    selectionVersion: 0,
    order: ['m4'],
    byId: new Map([['m4', message(4)]]),
    structureKey: 'user~~-1',
    hasMore: true,
    loadingMessages: false,
    loadingEarlier: false,
    messageLoadError: null,
    earlierLoadError: null,
    latestRun: null,
    humanNames: {},
    humanProfiles: {},
    memberReads: [],
    streamingCount: 0,
  })
  useUiStore.setState({
    appView: 'workspace',
    mainTab: 'chat',
    focusRequest: undefined,
    sessionDrawer: false,
    sessionFilter: 'all',
  })
  useRunStore.setState({ active: false, approvals: [], queue: [] })
  useAgentStore.setState({ agents: [], groups: [], skills: [], loaded: true, loading: false })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('历史定位与导航恢复', () => {
  it('目标跨三页时持续前翻直到命中', async () => {
    const beforeValues: number[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const before = Number(new URL(url, 'http://local').searchParams.get('before'))
        if (!before) return json({ artifacts: [], runs: [] })
        beforeValues.push(before)
        return json({ session, messages: [message(before - 1)], hasMore: before > 2, totalCount: 4 })
      }),
    )
    render(<ChatArea />)
    act(() => useUiStore.getState().focusMessage('m1'))
    await waitFor(() => expect(useSessionStore.getState().order).toEqual(['m1', 'm2', 'm3', 'm4']))
    expect(beforeValues).toEqual([4, 3, 2])
    expect(virtualizer.scrollToIndex).toHaveBeenCalledWith(0, { align: 'center' })
    expect(screen.queryByText('正在定位历史消息…')).toBeNull()
  })

  it('慢网不因 1900ms 失去定位请求，取消后不继续翻页', async () => {
    vi.useFakeTimers()
    let resolve!: (response: Response) => void
    const fetchMock = vi.fn((url: string) =>
      url.includes('before=')
        ? new Promise<Response>((done) => {
            resolve = done
          })
        : Promise.resolve(json({ artifacts: [], runs: [] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    render(<ChatArea />)
    act(() => useUiStore.getState().focusMessage('m1'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100)
    })
    expect(screen.getByText('正在定位历史消息…')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消定位' }))
    await act(async () => resolve(json({ session, messages: [message(3)], hasMore: true })))
    expect(useUiStore.getState().focusRequest).toBeUndefined()
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('before='))).toHaveLength(1)
  })

  it('会话加载失败显示重试，不展示空会话开场引导', () => {
    useSessionStore.setState({ order: [], byId: new Map(), messageLoadError: '网络失败' })
    render(<ChatArea />)
    expect(screen.getByRole('alert')).toHaveTextContent('网络失败')
    expect(screen.getByRole('button', { name: '重试加载会话' })).toBeInTheDocument()
    expect(screen.queryByText('直接描述你的需求，平台将自动组队并派发任务')).toBeNull()
  })

  it('从设置打开会话会显露聊天页，联系人入口请求打开窄屏抽屉', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/api/sessions/s1?')
          ? json({ session, messages: [message(4)] })
          : json({ artifacts: [], runs: [] }),
      ),
    )
    useUiStore.setState({ appView: 'settings', mainTab: 'artifacts' })
    expect(await openConversation('s1')).toBe(true)
    expect(useUiStore.getState().appView).toBe('workspace')
    expect(useUiStore.getState().mainTab).toBe('chat')
    expect(openContacts()).toBe(true)
    expect(useUiStore.getState().leftTab).toBe('contacts')
    expect(useUiStore.getState().sessionDrawer).toBe(true)
  })
})
