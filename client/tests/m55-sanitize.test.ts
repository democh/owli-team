/**
 * M55（§77 / ADR 0125）：agent 正文展示净化 —— 流式累积缓冲 + 存量消息回看。
 *
 * 关键回归：净化块删除以 `[工具调用]` 标题行锚定，若对「已净化文本」增量拼接，块内后续
 * 日志行会失去锚点成为孤行（句首标题已被删）→ store 必须对「原始全文」求净化。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { ChatMessage } from '@multi-agent/shared'
import { messagesOf, useSessionStore } from '../src/stores/session-store'

/** 全角竖线运行时拼接：源码不出现字面协议标记序列 */
const VB = '\uFF5C'
const dsmlLine = `</${VB}${VB}DSML${VB}${VB} parameter>`

const BLOCK_HEAD = '[工具调用]\n'
const LOG_ZIWEI = '- ziwei_pan({"birth":"1992-08-27"}) → 紫微排盘完成\n'
const LOG_WRITE = '- write_file({"path":"a.md"}) → 已写入\n'

function agentMsg(id: string, content = '', status: ChatMessage['status'] = 'streaming'): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    role: 'agent',
    agentId: 'pm',
    content,
    mentions: [],
    status,
    createdAt: new Date().toISOString(),
  }
}

function userMsg(id: string, content: string): ChatMessage {
  return { ...agentMsg(id, content, 'complete'), role: 'user', agentId: undefined }
}

beforeEach(() => {
  useSessionStore.setState({
    sessions: [],
    currentId: 'sa',
    byId: new Map(),
    order: [],
    latestRun: null,
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
})

describe('M55 session-store 流式净化', () => {
  it('仿写日志块跨分片到达：整体剥除且后续续行不残留孤行', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(agentMsg('m1'))
    store.appendDelta('m1', `先给出结论。\n\n${BLOCK_HEAD}`)
    // 半截（标题行已到、尚无日志行）：暂不删除，待补齐整体命中
    expect(messagesOf(useSessionStore.getState())[0].content).toContain('[工具调用]')
    store.appendDelta('m1', LOG_ZIWEI)
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('先给出结论。')
    // 关键：块内续行到达时仍以原始缓冲为锚点求净化（不因标题已删而变孤行）
    store.appendDelta('m1', LOG_WRITE)
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('先给出结论。')
    // 正常后续正文不受影响（块删除后保留原有段落空行）
    store.appendDelta('m1', '已核对明细，请查收。')
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('先给出结论。\n\n已核对明细，请查收。')
  })

  it('协议标记行随分片补齐后整行剥除', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(agentMsg('m2'))
    store.appendDelta('m2', '正常段落\n')
    store.appendDelta('m2', `${dsmlLine}\n行尾`)
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('正常段落\n行尾')
  })

  it('用户消息不做净化（引用系统格式属正常输入）', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(userMsg('m3', ''))
    store.appendDelta('m3', `请看这段：\n${BLOCK_HEAD}${LOG_ZIWEI}`)
    expect(messagesOf(useSessionStore.getState())[0].content).toContain('[工具调用]')
  })

  it('存量消息在 upsert 时净化（历史回看兜底）', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(agentMsg('m4', `结论如下。\n\n${BLOCK_HEAD}${LOG_ZIWEI}`, 'complete'))
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('结论如下。')
  })

  it('重生成复用消息 id：流式缓冲在生成开始时重置，不携带上一版原始文本', () => {
    const store = useSessionStore.getState()
    store.upsertMessage(agentMsg('m5'))
    store.appendDelta('m5', `第一版回复\n${BLOCK_HEAD}${LOG_ZIWEI}`)
    // 重生成：turn:start 以空内容重新 upsert（同一消息 id）；即便上一版缓冲未随收尾释放，
    // 生成开始也必须重置——否则新一版净化会把上一版块外原文一并带出
    store.upsertMessage(agentMsg('m5', '', 'streaming'))
    store.appendDelta('m5', `${BLOCK_HEAD}${LOG_ZIWEI}`)
    store.appendDelta('m5', '第二版回复')
    expect(messagesOf(useSessionStore.getState())[0].content).toBe('第二版回复')
  })
})
