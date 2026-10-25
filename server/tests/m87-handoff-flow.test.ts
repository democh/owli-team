/**
 * M87：handoff 交接包端到端（真实引擎 + 脚本化 Provider）。
 * 验证：写文件 → handoff 未显式声明 artifacts → 引擎自动带出本轮产出 → 接手方回合指令含交接包。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { appendUserMessage, makeEnv, routePassThrough, waitRunFinished } from './helpers.js'

const text = (value: string): LlmChunk => ({ type: 'text', text: value })
const done: LlmChunk = { type: 'done' }
const call = (id: string, name: string, args: Record<string, unknown>): LlmChunk => ({
  type: 'tool_calls',
  calls: [{ id, name, arguments: JSON.stringify(args) }],
})

describe('M87：handoff 交接包端到端', () => {
  it('pm 写文件 → handoff 自动带出 → qa 回合指令列出交付物与口径', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'], '交接链路')
    const requests: ChatRequest[] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      requests.push(req)
      const routed = routePassThrough(req)
      if (routed) {
        yield* routed
        return
      }
      const last = req.messages[req.messages.length - 1]
      if (req.meta.agentId === 'pm') {
        if (last?.role === 'tool') {
          const content = String(last.content ?? '')
          if (content.includes('已写入工作区')) {
            yield call('c_handoff', 'handoff', {
              target: 'qa',
              reason: '需求定稿，转验收',
              expected_output: '验收报告',
              notes: '以 v1 为准',
            })
            return
          }
          yield text('@用户 已完成交接。')
          yield done
          return
        }
        yield call('c_write', 'write_file', { path: 'docs/需求.md', content: '# 需求\n验收口径：全部通过' })
        return
      }
      yield text('@用户 验收完成。')
      yield done
    }

    const message = appendUserMessage(env, session.id, '帮我写一份需求并交给质检')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const qaRequest = requests.find((req) => req.meta.agentId === 'qa')
    expect(qaRequest).toBeDefined()
    const instruction = String(qaRequest!.messages[qaRequest!.messages.length - 1]?.content ?? '')
    expect(instruction).toContain('上一棒交付物（来自 费利）：docs/需求.md')
    expect(instruction).toContain('交接口径（来自 费利）：以 v1 为准')
    // 索引已登记作者 / 版本（交接包元数据来源）
    const entry = env.index.getMany(session.id, ['docs/需求.md'])[0]
    expect(entry?.authorAgentId).toBe('pm')
    expect(entry?.version).toBe(1)
  }, 20_000)
})
