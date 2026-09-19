/**
 * 会话 store：跨会话流式守卫、消息补丁、交付件版本号。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage, Session, SessionSummary } from '@multi-agent/shared'
import { messagesOf, useSessionStore } from '../src/stores/session-store'

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
  })
})

describe('session-store', () => {
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
