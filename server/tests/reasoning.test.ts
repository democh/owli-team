/**
 * 思考模式（V4）：reasoning 全链路 —— 剧本产出 → 引擎累积/广播 → 落库；
 * 工具循环中 assistant(tool_calls) 消息回传本子轮 reasoning（API 硬性要求，否则 400）。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { SessionStore } from '../src/store/sessions.js'
import { makeEnv, routePassThrough, sendAndWait } from './helpers.js'

describe('思考模式（V4）reasoning 链路', () => {
  it('默认关闭：Mock 不产出 reasoning，消息无思维链', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    await sendAndWait(env, session.id, '做个登录页')

    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages.length).toBeGreaterThan(0)
    expect(agentMessages.every((m) => !m.reasoning)).toBe(true)
  })

  it('开启思考：Mock 剧本产出 reasoning → 累积并落库', async () => {
    const env = makeEnv({ llmThinking: true })
    const session = env.sessions.create(['pm'])
    await sendAndWait(env, session.id, '做个登录页')

    const agentMessage = env.sessions.messages(session.id).find((m) => m.role === 'agent')!
    expect(agentMessage.reasoning).toBeTruthy()
    expect(agentMessage.reasoning).toContain('用户这次的诉求')
    // 工具循环第二轮思考与首轮差异化：整段剧本只出现一次，不回环重复
    expect(agentMessage.reasoning!.split('用户这次的诉求围绕').length - 1).toBe(1)
    expect(agentMessage.reasoning).toContain('工具回执已到')
    // 落库往返：flush 后用全新 Store 实例（无内存缓存）从 DB 重读仍带思维链
    env.sessions.saveNow(session.id)
    const fresh = new SessionStore(env.db)
    const reloaded = fresh.messages(session.id).find((m) => m.id === agentMessage.id)!
    expect(reloaded.reasoning).toBe(agentMessage.reasoning)
  })

  it('工具循环：assistant(tool_calls) 消息回传本子轮 reasoning', async () => {
    const env = makeEnv({ llmThinking: true })
    const calls: ChatRequest['messages'][] = []
    let round = 0
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    // 探针 provider：第一轮产出 reasoning + tool_calls，第二轮记录请求后收尾
    provider.chatStream = async function* (req: ChatRequest) {
      // M48：平台路由请求直通（不占 round / 不入探针记录）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      calls.push(req.messages.map((m) => ({ ...m })))
      if (round++ === 0) {
        yield { type: 'reasoning', text: '先建任务清单，再落交付件。' }
        yield {
          type: 'tool_calls',
          calls: [
            {
              id: 'call_probe_1',
              name: 'write_todos',
              arguments: JSON.stringify({ todos: [{ content: '探针任务', status: 'in_progress' }] }),
            },
          ],
        }
      } else {
        yield { type: 'text', text: '完成，@用户 请确认。' }
      }
      yield { type: 'done' }
    }

    const session = env.sessions.create(['pm'])
    await sendAndWait(env, session.id, '做个登录页')

    // 第二轮请求：工具循环注入的 assistant(tool_calls) 消息应携带本子轮 reasoning
    expect(calls.length).toBe(2)
    const assistantWithTools = calls[1].find((m) => m.role === 'assistant' && m.toolCalls?.length)
    expect(assistantWithTools?.reasoning).toBe('先建任务清单，再落交付件。')

    // 思维链累积为消息字段（前端折叠展示 + 持久化）
    const agentMessage = env.sessions.messages(session.id).find((m) => m.role === 'agent')!
    expect(agentMessage.reasoning).toBe('先建任务清单，再落交付件。')
    expect(agentMessage.content).toContain('请确认')
  })
})
