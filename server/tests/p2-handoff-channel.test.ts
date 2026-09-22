/**
 * P2：handoff 结构化权威通道观测 —— trace turn:end 携带 handoffSource（tool / text）。
 * 权威化路径：handoff 工具优先（auto 模式下有工具调用即以工具为准）；文本 @ 为降级兜底。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type ProbeScript = (req: ChatRequest, round: number) => LlmChunk[]

function probeScript(env: ReturnType<typeof makeEnv>, script: ProbeScript): void {
  let round = 0
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req: ChatRequest) {
    const chunks = script(req, round)
    round++
    for (const chunk of chunks) yield chunk
  }
}

function handoffCall(id: string, target: string): LlmChunk {
  return { type: 'tool_calls', calls: [{ id, name: 'handoff', arguments: JSON.stringify({ target, reason: '接力' }) }] }
}

function turnEndEvents(env: ReturnType<typeof makeEnv>, runId: string): Array<Record<string, unknown>> {
  const rows = (env.events as unknown as { listByRun: (id: string) => Array<{ type: string; payload?: Record<string, unknown>; data?: Record<string, unknown> }> }).listByRun(runId)
  return rows.filter((r) => r.type === 'turn:end').map((r) => r.payload ?? r.data ?? {})
}

describe('P2：handoff 通道观测（handoffSource 落 trace）', () => {
  it('工具转交 → handoffSource=tool；文本 @ 兜底 → handoffSource=text', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    probeScript(env, (req, round) => {
      // 第一棒 pm：用 handoff 工具转交（权威通道）
      if (round === 0 && req.meta.agentId === 'pm') {
        return [
          { type: 'text', text: '需求已梳理，交给架构师。' },
          handoffCall('c1', 'architect'),
          { type: 'done' },
        ]
      }
      // 第二棒 architect：用文本 @用户 交还（兜底通道）
      return [{ type: 'text', text: '架构方案完成。\n@用户' }, { type: 'done' }]
    })

    const m = appendUserMessage(env, session.id, '做个登录页 @pm')
    const { runId } = env.engine.launch(session.id, m.id)
    await waitRunFinished(env.engine, runId)

    const ends = turnEndEvents(env, runId)
    const pmEnd = ends.find((e) => e.agentId === 'pm')
    const archEnd = ends.find((e) => e.agentId === 'architect')
    expect(pmEnd?.handoffSource).toBe('tool')
    expect(archEnd?.handoffSource).toBe('text')
    // 工具通道接力真实生效
    expect(pmEnd?.mentions).toEqual(['architect'])
  })
})
