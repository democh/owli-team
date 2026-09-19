/**
 * 统一温度开关（temperatureOverride）：设置面板「模型与生成 → 统一温度」。
 *
 * 验收对照：
 * - 默认关闭：角色级温度优先（agent.temperature ?? cfg.temperature）——165 个角色全量单独配置时全局值不生效；
 * - 开启后忽略角色配置：全部角色使用全局温度（请求探针断言 engine 实际下发的 req.temperature）；
 * - 运行期热切换（applySettingsToConfig = PUT /api/settings 同一路径）：切换后下一回合即生效、可关回。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { applySettingsToConfig } from '../src/settings.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

/** 请求探针：记录主回合请求温度（消息 @ 直达，不经 PRS） */
function probeTemps(env: ReturnType<typeof makeEnv>): Array<number | undefined> {
  const temps: Array<number | undefined> = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req: ChatRequest) {
    temps.push(req.temperature)
    yield { type: 'text', text: '已处理。@用户 完成。' }
    yield { type: 'done' }
  }
  return temps
}

async function runOnce(env: ReturnType<typeof makeEnv>, sessionId: string): Promise<void> {
  const message = appendUserMessage(env, sessionId, '@pm 请简短应答')
  const { runId } = env.engine.launch(sessionId, message.id)
  await waitRunFinished(env.engine, runId)
}

describe('统一温度开关（temperatureOverride）', () => {
  it('默认关闭：角色级温度优先（取 AGENT.md 的 temperature）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const temps = probeTemps(env)

    await runOnce(env, session.id)

    const roleTemp = env.prompts.get('pm')?.temperature
    expect(roleTemp).toBeTypeOf('number')
    expect(temps).toEqual([roleTemp])
  })

  it('开启后忽略角色配置：全部角色使用全局温度', async () => {
    const env = makeEnv({ temperatureOverride: true, temperature: 0.9 })
    const session = env.sessions.create(['pm'])
    const temps = probeTemps(env)

    await runOnce(env, session.id)

    expect(env.prompts.get('pm')?.temperature).not.toBe(0.9)
    expect(temps).toEqual([0.9])
  })

  it('运行期热切换（PUT /api/settings 同一路径）：下一回合即生效、可关回', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const temps = probeTemps(env)
    const roleTemp = env.prompts.get('pm')?.temperature

    await runOnce(env, session.id)
    expect(temps[0]).toBe(roleTemp)

    applySettingsToConfig(env.cfg, { temperatureOverride: true, temperature: 0.9 })
    await runOnce(env, session.id)
    expect(temps[1]).toBe(0.9)

    applySettingsToConfig(env.cfg, { temperatureOverride: false })
    await runOnce(env, session.id)
    expect(temps[2]).toBe(roleTemp)
  })
})
