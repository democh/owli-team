/**
 * 会话 store：跨会话流式守卫、消息补丁、交付件版本号。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage, Session, SessionSummary } from '@multi-agent/shared'
import { filterSessions, messagesOf, useSessionStore } from '../src/stores/session-store'

const SESSION_A: SessionSummary = {
  id: 'sa',
  title: '会话A',
  participantIds: ['pm'],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  messageCount: 0,
}

function msg(id: string, sessionId: string, content = ''): ChatMessage {
  return {
    id,
    sessionId,
    role: 'agent',
    agentId: 'pm',
    content,
    mentions: [],
    status: 'streaming',
    createdAt: new Date().toISOString(),
  }
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [SESSION_A],
    currentId: 'sa',
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
    selectionVersion: 0,
    messageLoadError: null,
    earlierLoadError: null,
    hasMore: false,
    loadingEarlier: false,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('session-store', () => {
  it('加载失败保留错误状态，重试成功恢复消息', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('断网'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ session: SESSION_A, messages: [msg('ok', 'sa')] })),
        ),
    )
    await expect(useSessionStore.getState().selectSession('sa')).rejects.toThrow('断网')
    expect(useSessionStore.getState().messageLoadError).toBe('断网')
    expect(useSessionStore.getState().loadingMessages).toBe(false)
    await useSessionStore.getState().selectSession('sa')
    expect(useSessionStore.getState().messageLoadError).toBeNull()
    expect(useSessionStore.getState().order).toEqual(['ok'])
  })

  it('A → B → A 的旧请求不能覆盖同名新选择', async () => {
    const responses: Array<(response: Response) => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((resolve) => responses.push(resolve))),
    )
    const a1 = useSessionStore.getState().selectSession('sa')
    const b = useSessionStore.getState().selectSession('sb')
    const a2 = useSessionStore.getState().selectSession('sa')
    responses[2](new Response(JSON.stringify({ session: SESSION_A, messages: [msg('new', 'sa')] })))
    await a2
    responses[0](new Response(JSON.stringify({ session: SESSION_A, messages: [msg('old', 'sa')] })))
    responses[1](new Response(JSON.stringify({ session: { ...SESSION_A, id: 'sb' }, messages: [] })))
    await Promise.all([a1, b])
    expect(useSessionStore.getState().order).toEqual(['new'])
  })

  it('历史分页与当前消息去重，避免重复行和重复统计', async () => {
    const latest = { ...msg('m2', 'sa'), seq: 2 }
    useSessionStore.setState({ byId: new Map([['m2', latest]]), order: ['m2'], hasMore: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: SESSION_A,
              messages: [{ ...msg('m1', 'sa'), seq: 1 }, latest],
              hasMore: false,
            }),
          ),
      ),
    )
    await useSessionStore.getState().loadEarlier()
    expect(useSessionStore.getState().order).toEqual(['m1', 'm2'])
  })

  it('快捷键与会话列表共享筛选顺序', () => {
    const sessions = [SESSION_A, { ...SESSION_A, id: 'dm', kind: 'direct' as const }]
    expect(filterSessions(sessions, 'team').map((s) => s.id)).toEqual(['sa'])
    expect(filterSessions(sessions, 'chat').map((s) => s.id)).toEqual(['dm'])
    expect(filterSessions(sessions, 'all')).toEqual(sessions)
    // 置顶会话在两种筛选下都优先（列表与快捷键保持同一顺序）。
    const pinned: SessionSummary[] = [
      { ...sessions[0], id: 'pinned', prefs: { pinned: true, muted: false, archived: false, markedUnread: false } },
      sessions[0],
    ]
    expect(filterSessions(pinned, 'all').map((s) => s.id)).toEqual(['pinned', 'sa'])
  })

  it('upsertMessage：当前会话内新增与覆盖', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(msg('m1', 'sa', '第一句'))
    store.upsertMessage(msg('m1', 'sa', '修改后'))
    const messages = messagesOf(useSessionStore.getState())
    expect(messages).toHaveLength(1)
    expect(messages[0].content).toBe('修改后')
  })

  it('upsertMessage：跨会话流式事件被守卫拦截', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(msg('m1', 'sb', '别的会话'))
    expect(messagesOf(useSessionStore.getState())).toHaveLength(0)
  })

  it('appendDelta 累积增量，patchMessage 合并字段', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(msg('m1', 'sa'))
    store.appendDelta('m1', '你')
    store.appendDelta('m1', '好')
    store.patchMessage('m1', { status: 'complete', mentions: ['architect'] })
    const m = messagesOf(useSessionStore.getState())[0]
    expect(m.content).toBe('你好')
    expect(m.status).toBe('complete')
    expect(m.mentions).toEqual(['architect'])
  })

  it('patchMessage / appendDelta 对未知 id 无副作用', () => {
    const store = useSessionStore.getState()
    store.patchMessage('nope', { content: 'x' })
    store.appendDelta('nope', 'x')
    expect(messagesOf(useSessionStore.getState())).toHaveLength(0)
  })

  it('bumpArtifacts 递增交付件版本号（浏览器刷新依据）', () => {
    useSessionStore.getState().bumpArtifacts()
    useSessionStore.getState().bumpArtifacts()
    expect(useSessionStore.getState().artifactVersion).toBe(2)
  })

  it('applySession：缺省语义字段以「键缺失」清空（serial / planFirst / memberSouls）且保留 summary 字段', () => {
    useSessionStore.setState({
      sessions: [
        { ...SESSION_A, messageCount: 5, serial: true, planFirst: true, memberSouls: { pm: 'strict' } },
      ],
    })
    // 服务端以「键缺失」表示关闭（JSON 序列化丢弃 undefined 键）——模拟 PATCH 关闭串行后的响应体
    const patched = {
      id: 'sa',
      title: '会话A',
      participantIds: ['pm'],
      createdAt: SESSION_A.createdAt,
      updatedAt: SESSION_A.updatedAt,
    }
    useSessionStore.getState().applySession(patched as Session)
    const next = useSessionStore.getState().sessions[0]
    expect(next.serial).toBeUndefined()
    expect(next.planFirst).toBeUndefined()
    expect(next.memberSouls).toBeUndefined()
    expect(next.messageCount).toBe(5)
  })
})
