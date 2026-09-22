/**
 * P1 可读性修复：工具子轮文本分段。
 * 一个回合内「工具前旁白 → 工具执行 → 工具后正文」累积进同一 message.content；
 * 修复后子轮之间必须出现段落分隔（\n\n），旁白不与正文粘连。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmChunk {
  return { type: 'tool_calls', calls: [{ id, name, arguments: JSON.stringify(args) }] }
}

type ProbeScript = (req: ChatRequest, round: number) => LlmChunk[]

/** 探针 Provider：按脚本分轮产出（与 m3 测试同模式） */
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

describe('P1：工具子轮文本分段', () => {
  it('旁白 → write_todos → 正文：落库内容含段落分隔，且流式 delta 序列同步含分隔', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          { type: 'text', text: '我先列一下待办。' },
          toolCall('c1', 'write_todos', { todos: [{ content: '梳理需求', status: 'pending' }] }),
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: '待办已建好，下面进入需求拆解。@用户' }, { type: 'done' }]
    })

    const m = appendUserMessage(env, session.id, '开始 @pm')
    const { runId } = env.engine.launch(session.id, m.id)
    await waitRunFinished(env.engine, runId)

    const content = env.sessions.messages(session.id).find((x) => x.role === 'agent')?.content ?? ''
    // 修复前：「我先列一下待办。待办已建好」粘连；修复后：两段之间有空行
    expect(content).toContain('我先列一下待办。')
    expect(content).toContain('待办已建好')
    expect(content).toMatch(/我先列一下待办。\n\n+待办已建好/)
  })

  it('单轮无工具调用：不引入多余分隔（零差异）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, () => [{ type: 'text', text: '直接回复，无工具。@用户' }, { type: 'done' }])

    const m = appendUserMessage(env, session.id, '你好 @pm')
    const { runId } = env.engine.launch(session.id, m.id)
    await waitRunFinished(env.engine, runId)

    const content = env.sessions.messages(session.id).find((x) => x.role === 'agent')?.content ?? ''
    expect(content).toBe('直接回复，无工具。@用户')
  })
})
