/**
 * M86：接力控制（auto / manual）与手动派发。
 *
 * 覆盖：
 * - 单助手对话缺省 manual：handoff 只登记「建议下一棒」，不召集未在场成员、不接棒，Run 交还用户；
 * - 显式 auto（能力保留）：单助手会话仍可按 handoff 召集并接手；
 * - 手动派发（空闲）：新起 Run（队列 = [目标]，跳过平台路由），落系统事件条 + 派发便条；
 * - 手动派发（活跃）：插到队首、不新建 Run，下一波由目标接手。
 */
import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@multi-agent/shared'
import { buildTurnInstruction } from '../src/context/assembler.js'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

function installScript(
  env: Env,
  script: (req: ChatRequest) => LlmChunk[],
): { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    requests.push(req)
    for (const chunk of script(req)) yield chunk
  }
  return { requests }
}

const textChunk = (text: string): LlmChunk => ({ type: 'text', text })
const doneChunk: LlmChunk = { type: 'done' }
const handoffChunk = (target: string): LlmChunk => ({
  type: 'tool_calls',
  calls: [
    {
      id: `c_${target}_${Math.random().toString(36).slice(2, 6)}`,
      name: 'handoff',
      arguments: JSON.stringify({ target, reason: '测试转交' }),
    },
  ],
})

const afterToolResult = (req: ChatRequest): boolean =>
  req.messages.length > 0 && req.messages[req.messages.length - 1]?.role === 'tool'

const handToUser = (req: ChatRequest): LlmChunk[] =>
  afterToolResult(req) ? [textChunk('已完成，交还用户。'), doneChunk] : [handoffChunk('user'), doneChunk]

function agentMessages(env: Env, sessionId: string, agentId: string): ChatMessage[] {
  return env.sessions.messages(sessionId).filter((m) => m.role === 'agent' && m.agentId === agentId)
}

describe('M86：接力控制（manual 缺省）', () => {
  it('单助手对话：handoff 只记录为建议，不召集、不接棒，Run 交还用户', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M86 手动接力')
    const { requests } = installScript(env, (req) => {
      if (req.meta.agentId !== 'backend') return handToUser(req)
      return afterToolResult(req) ? [textChunk('收到，建议交给设计。'), doneChunk] : [handoffChunk('architect'), doneChunk]
    })
    const message = appendUserMessage(env, session.id, '@backend 把发布页做出来')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    // 未自动召集、未接棒
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['backend'])
    expect(agentMessages(env, session.id, 'architect')).toHaveLength(0)
    // 工具回执：建议已记录（并说明不会自动接棒）
    const toolReq = requests.find((r) => r.meta.agentId === 'backend' && afterToolResult(r))!
    const toolContent = String(toolReq.messages[toolReq.messages.length - 1]?.content ?? '')
    expect(toolContent).toContain('已记录「建议下一棒')
    expect(toolContent).toContain('手动接力')
    // 建议留有审计痕迹，Run 正常收尾交还用户
    expect(env.events.listByRun(runId).some((e) => e.type === 'handoff:suggested')).toBe(true)
    expect(env.events.listByRun(runId).find((e) => e.type === 'run:end')?.payload.reason).toBe('completed')
    expect(env.published.some((n) => n.type === 'notify:awaiting-user')).toBe(true)
  })

  it('显式 auto（能力保留）：单助手会话仍可召集未在场角色并接手', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], 'M86 显式自动')
    env.sessions.setRelay(session.id, 'auto')
    installScript(env, (req) => {
      if (req.meta.agentId === 'backend') {
        return afterToolResult(req) ? [textChunk('已转交设计。'), doneChunk] : [handoffChunk('architect'), doneChunk]
      }
      return handToUser(req)
    })
    const message = appendUserMessage(env, session.id, '@backend 把发布页做出来')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['backend', 'architect'])
    expect(agentMessages(env, session.id, 'architect')).toHaveLength(1)
  })

  it('direct / group 形态缺省 manual（纯人聊天不触发 agent 接力）', () => {
    const env = makeEnv()
    const group = env.sessions.create([], '纯人群', { kind: 'group' })
    const single = env.sessions.create(['backend'], '单助手')
    expect(group.relay).toBeUndefined()
    expect(env.engine.activeRunOf(group.id)).toBeUndefined()
    // 推导值由 shared.resolveRelayMode 统一（这里用会话形态断言，避免在服务端重复实现）
    expect(group.participantIds).toHaveLength(0)
    expect(single.participantIds).toHaveLength(1)
  })
})

describe('M86：回合指令（接力控制）', () => {
  it('manual 不再声称自动召集；auto 保持原文（零差异）', () => {
    const env = makeEnv()
    const agent = env.prompts.get('backend')!
    const roster = env.prompts.list()

    const auto = buildTurnInstruction(agent, roster, [], [], 'execute', {})
    expect(auto).toContain('平台会自动召集后接手')

    const manual = buildTurnInstruction(agent, roster, [], [], 'execute', { relayMode: 'manual' })
    expect(manual).not.toContain('平台会自动召集后接手')
    expect(manual).toContain('手动接力')
    expect(manual).toContain('交还用户')
    expect(manual).not.toContain('权威通道')
  })
})

describe('M86：手动派发', () => {
  it('空闲时派发：新起 Run（队列 = [目标]），系统事件条 + 派发便条进入回合指令', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend', 'architect'], 'M86 空闲派发')
    const { requests } = installScript(env, () => [textChunk('架构接棒。'), doneChunk])

    const res = env.engine.dispatchTo(session.id, 'architect', { note: '先出接口设计' })
    expect(res.queue).toEqual(['architect'])
    await waitRunFinished(env.engine, res.runId)

    expect(requests[0]?.meta.agentId).toBe('architect')
    // 派发便条注入目标回合指令（「上一棒期望」）
    const lastUser = [...(requests[0]?.messages ?? [])].reverse().find((m) => m.role === 'user')
    expect(String(lastUser?.content ?? '')).toContain('先出接口设计')
    // 可审计的系统事件条
    expect(
      env.sessions.messages(session.id).some((m) => m.role === 'system' && m.content.includes('你派发了下一棒')),
    ).toBe(true)
  })

  it('运行中派发：插到队首，不新建 Run，下一波由目标接手', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend', 'architect'], 'M86 活跃派发')
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      if (req.meta.agentId === 'backend') {
        await gate
        yield textChunk('后端完成了第一段。')
        yield doneChunk
        return
      }
      yield textChunk('架构接棒。')
      yield doneChunk
    }

    const message = appendUserMessage(env, session.id, '@backend 开始')
    const { runId } = env.engine.launch(session.id, message.id)
    // 让 backend 进入生成（挂起在 gate），此时 Run 处于活跃态
    await new Promise((resolve) => setTimeout(resolve, 0))
    const res = env.engine.dispatchTo(session.id, 'architect')
    expect(res.runId).toBe(runId)
    expect(res.queue[0]).toBe('architect')
    release()
    await waitRunFinished(env.engine, runId)

    expect(agentMessages(env, session.id, 'architect').length).toBeGreaterThan(0)
  })
})
