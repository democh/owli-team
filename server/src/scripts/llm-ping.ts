/**
 * llm:ping：LLM 连通性冒烟（真实模型）。
 * 用法：npm run llm:ping -- "你好" [--thinking]（--thinking 强制开启思考模式，灰色输出思维链）
 */
import { loadConfig } from '../config.js'
import { createProvider } from '../llm/factory.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.llmApiKey) {
    console.error('未配置 LLM_API_KEY：请在 .env 中配置真实模型 API Key')
    process.exit(1)
  }
  const args = process.argv.slice(2)
  const thinking = args.includes('--thinking') || cfg.llmThinking
  const prompt = args.filter((a) => a !== '--thinking').join(' ').trim() || '你好，简单介绍一下你自己'
  const provider = createProvider(cfg)
  console.log(`LLM: ${cfg.llmModel} @ ${cfg.llmBaseUrl}${thinking ? `（思考 on/${cfg.llmReasoningEffort}）` : ''}`)
  console.log(`> ${prompt}\n`)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 120_000)
  try {
    for await (const chunk of provider.chatStream(
      {
        system: '你是一个简洁的研发协作助手。',
        messages: [{ role: 'user', content: prompt }],
        thinking,
        meta: { agentId: 'pm', participantIds: ['pm'] },
      },
      controller.signal,
    )) {
      // 思考内容灰色输出，正文默认色（终端上直观区分两条通道）
      if (chunk.type === 'reasoning') process.stdout.write(`\x1b[2m${chunk.text}\x1b[0m`)
      else if (chunk.type === 'text') process.stdout.write(chunk.text)
    }
    console.log('\n\n✓ 连通性正常')
  } catch (err) {
    console.error(`\n✗ 调用失败：${(err as Error).message}`)
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }
}

void main()
