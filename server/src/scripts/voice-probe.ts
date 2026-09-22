/**
 * 声纹 A/B 风格探针（P1 验收，真实模型）：
 * 同一角色「带 voice.md / 摘掉声纹」同题对照 + 跨角色对照，检验去 AI 腔成效。
 *
 * 用法：npx tsx src/scripts/voice-probe.ts [--rounds=2]
 * 需要 .env 配置 LLM_API_KEY（LLM_MOCK 必须为 false）。
 * 产物：workspace/voice-probe/report-<ts>.md（原始输出 + 指标表），控制台打印汇总。
 *
 * 指标（离线规则，可机检）：
 * - bulletRatio：分点行占比（声纹目标：对话发言 ≤0.4）
 * - bannedHits：全局 AI 腔禁用词命中数（综上所述 / 赋能 / 抓手 / 闭环 / 打磨 / 颗粒度 / 希望对你有帮助 等）
 * - clicheOpen：模板开场命中（好的/收到/我来/下面我将 开头）
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { PromptLibrary } from '../store/prompts.js'
import { createProvider } from '../llm/factory.js'
import { buildSystemPrompt } from '../context/assembler.js'
import type { LlmProvider } from '../llm/provider.js'

const BANNED = ['综上所述', '总而言之', '赋能', '抓手', '闭环', '打磨', '颗粒度', '希望对你有帮助', '如有问题随时提问']
const CLICHE_OPEN = /^(好的|好[，,]|收到|我来|下面我将|首先)/

interface CaseDef {
  label: string
  agentId: string
  withVoice: boolean
  question: string
}

const CASES: CaseDef[] = [
  // 核心 A/B：同角色同题，唯一变量 = 声纹
  { label: 'pm 带声纹', agentId: 'pm', withVoice: true, question: '团队准备给产品加一个 AI 助手功能，你先把这事捋一捋。' },
  { label: 'pm 无声纹', agentId: 'pm', withVoice: false, question: '团队准备给产品加一个 AI 助手功能，你先把这事捋一捋。' },
  { label: 'qa 带声纹', agentId: 'qa', withVoice: true, question: '登录功能开发完了，你看一眼质量上有没有问题。' },
  { label: 'qa 无声纹', agentId: 'qa', withVoice: false, question: '登录功能开发完了，你看一眼质量上有没有问题。' },
  { label: 'chef 带声纹', agentId: 'chef', withVoice: true, question: '我想学做红烧肉，有什么要注意的？' },
  // 跨角色对照：无声纹角色作基线
  { label: 'sre 无声纹（基线）', agentId: 'sre', withVoice: false, question: '最近线上服务偶尔变慢，你怎么看？' },
]

function metrics(text: string): { bulletRatio: number; bannedHits: string[]; clicheOpen: boolean; chars: number } {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const bulletLines = lines.filter((l) => /^\s*([-*+]|\d+[.、)])/.test(l))
  const bannedHits = BANNED.filter((w) => text.includes(w))
  const firstLine = lines[0]?.trim() ?? ''
  return {
    bulletRatio: lines.length ? bulletLines.length / lines.length : 0,
    bannedHits,
    clicheOpen: CLICHE_OPEN.test(firstLine),
    chars: text.length,
  }
}

async function chatOnce(provider: LlmProvider, system: string, user: string, temperature: number): Promise<string> {
  let text = ''
  for await (const chunk of provider.chatStream(
    {
      system,
      messages: [{ role: 'user', content: user }],
      temperature,
      meta: { agentId: 'voice-probe', participantIds: [] },
    },
    new AbortController().signal,
  )) {
    if (chunk.type === 'text') text += chunk.text
  }
  return text
}

async function main(): Promise<void> {
  const cfg = loadConfig()
  if (cfg.llmMock) throw new Error('LLM_MOCK=true 时无法跑真实探针，请关闭后重试')
  const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
  const provider = createProvider(cfg)
  const rounds = Number(process.argv.find((a) => a.startsWith('--rounds='))?.split('=')[1] ?? 1)

  const outDir = path.join(process.cwd(), '..', 'workspace', 'voice-probe')
  fs.mkdirSync(outDir, { recursive: true })
  const lines: string[] = [`# 声纹 A/B 风格探针报告`, ``, `- 时间：${new Date().toISOString()}`, `- 模型：${cfg.llmModel}`, `- 轮次：${rounds}`, ``]

  const table: Array<{ label: string; m: ReturnType<typeof metrics> }> = []
  for (const c of CASES) {
    const agent = lib.get(c.agentId)
    if (!agent) throw new Error(`角色不存在：${c.agentId}`)
    const voice = c.withVoice ? lib.voice(c.agentId) : undefined
    if (c.withVoice && !voice) throw new Error(`${c.agentId} 缺少 voice.md`)
    const sys = buildSystemPrompt({
      protocol: lib.protocolText,
      groupProtocol: lib.groupProtocol(agent.group),
      agent,
      agentBody: lib.body(agent.id),
      voice: voice ? { body: voice.body } : undefined,
      roster: [agent],
      preloadedSkills: [],
      skillsIndex: '',
      workspaceListing: '',
      memoryBlock: '',
      summaryBlock: '',
    }).text

    for (let r = 0; r < rounds; r++) {
      const temperature = Math.min(0.8, (agent.temperature ?? cfg.temperature) + (c.withVoice ? 0.1 : 0))
      const output = await chatOnce(provider, sys, c.question, temperature)
      const m = metrics(output)
      table.push({ label: rounds > 1 ? `${c.label} #${r + 1}` : c.label, m })
      lines.push(`## ${c.label}${rounds > 1 ? `（第 ${r + 1} 轮）` : ''}`)
      lines.push(``)
      lines.push(`- 字数：${m.chars}｜分点占比：${(m.bulletRatio * 100).toFixed(0)}%｜禁用词：${m.bannedHits.join('、') || '无'}｜模板开场：${m.clicheOpen ? '是' : '否'}`)
      lines.push(``, '```', output, '```', ``)
      console.log(`✓ ${c.label} #${r + 1}：bullet=${(m.bulletRatio * 100).toFixed(0)}% banned=${m.bannedHits.length} cliche=${m.clicheOpen}`)
    }
  }

  lines.unshift(
    '',
    '| 用例 | 分点占比 | 禁用词数 | 模板开场 | 字数 |',
    '| --- | --- | --- | --- | --- |',
    ...table.map((t) => `| ${t.label} | ${(t.m.bulletRatio * 100).toFixed(0)}% | ${t.m.bannedHits.length} | ${t.m.clicheOpen ? '是' : '否'} | ${t.m.chars} |`),
    '',
    '---',
    '',
  )
  const report = path.join(outDir, `report-${new Date().toISOString().replace(/[:.]/g, '-')}.md`)
  fs.writeFileSync(report, lines.join('\n'))
  console.log(`\n报告：${report}`)
}

main().catch((err) => {
  console.error(`探针失败：${(err as Error).message}`)
  process.exit(1)
})
