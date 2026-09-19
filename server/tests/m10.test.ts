/**
 * M10 测试：LLM_MOCK 显式开关 —— E2E/离线演示的脚本化 Provider 接线。
 *
 * 验收对照（计划 M10「CI 中跑 mock 模式」）：
 * - 默认（LLM_MOCK 未设置）为 false：生产仍走真实模型唯一路径；
 * - LLM_MOCK=true 时 loadConfig 生效、describeConfig 标注、createProvider 产出零网络脚本流；
 * - settings.json 白名单不包含 LLM_MOCK（运行期设置无法打开 Mock）。
 */
import { describe, expect, it, vi } from 'vitest'
import { describeConfig, loadConfig, type AppConfig } from '../src/config.js'
import { createProvider } from '../src/llm/factory.js'
import { SETTINGS_FIELDS } from '../src/settings.js'
import type { ChatRequest } from '../src/llm/provider.js'

function mockRequest(): ChatRequest {
  return {
    system: '你是测试角色',
    messages: [{ role: 'user', content: '【用户】请帮我实现登录功能' }],
    model: 'mock',
    meta: { agentId: 'backend', participantIds: ['backend'], spokenAgentIds: ['backend'] },
  }
}

describe('M10 LLM_MOCK 显式开关', () => {
  it('默认关闭；LLM_MOCK=true 解析为开启并出现在配置诊断中', () => {
    const off = loadConfig()
    expect(off.llmMock).toBe(false)

    vi.stubEnv('LLM_MOCK', 'true')
    vi.stubEnv('LLM_MOCK_DELAY_MS', '0')
    try {
      const on = loadConfig()
      expect(on.llmMock).toBe(true)
      expect(on.llmMockDelayMs).toBe(0)
      expect(describeConfig(on).some((line) => line.includes('脚本化 Mock'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('LLM_MOCK 不在 settings.json 白名单（运行期不可打开 Mock）', () => {
    expect(SETTINGS_FIELDS).not.toContain('llmMock')
    expect(SETTINGS_FIELDS).not.toContain('llmMockDelayMs')
  })

  it('LLM_MOCK=true 时 createProvider 产出脚本化流（零网络，无 Key 也能跑）', async () => {
    const cfg: AppConfig = { ...loadConfig(), llmApiKey: '', llmMock: true, llmMockDelayMs: 0 }
    const provider = createProvider(cfg)
    const chunks: string[] = []
    let produced = ''
    for await (const chunk of provider.chatStream(mockRequest(), new AbortController().signal)) {
      chunks.push(chunk.type)
      if (chunk.type === 'text') produced += chunk.text
    }
    expect(chunks).toContain('text')
    expect(chunks).toContain('usage')
    expect(chunks).toContain('done')
    // 脚本化接力行：单人会话 → 交还用户
    expect(produced).toContain('@用户')
  })
})
