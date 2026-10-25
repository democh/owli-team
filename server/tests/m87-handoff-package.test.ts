/**
 * M87：handoff 交接包 —— 工具参数校验、回合指令注入、恢复语义（纯内存层）。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AgentDefinition } from '@multi-agent/shared'
import { describe, expect, it } from 'vitest'
import { buildTurnInstruction } from '../src/context/assembler.js'
import type { ToolRuntime, ToolResult } from '../src/tools/registry.js'
import { makeEnv } from './helpers.js'

const PM = {
  id: 'pm',
  name: '费利',
  role: '产品经理',
  handoff: ['qa'],
  skills: [],
  tools: [],
} as unknown as AgentDefinition
const QA = {
  id: 'qa',
  name: '祁验',
  role: '质量',
  handoff: ['pm'],
  skills: [],
  tools: [],
} as unknown as AgentDefinition

function write(env: ReturnType<typeof makeEnv>, sessionId: string, rel: string, content = 'x'): void {
  const full = path.join(env.artifacts.ensureSessionDir(sessionId), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

function runtimeOf(env: ReturnType<typeof makeEnv>, sessionId: string): ToolRuntime {
  return {
    sessionId,
    runId: 'run_m87',
    agentId: 'pm',
    memberKey: 'pm',
    relayMode: 'auto',
    workspace: env.artifacts.ensureSessionDir(sessionId),
    artifacts: env.artifacts,
    index: env.index,
    participants: [
      { id: 'pm', name: '费利' },
      { id: 'qa', name: '祁验' },
    ],
  } as unknown as ToolRuntime
}

describe('M87：handoff 交接包', () => {
  it('buildTurnInstruction：有交接包时列出路径 / 版本 / 体积与口径；无包时文本零差异', () => {
    const base = buildTurnInstruction(PM, [PM, QA], ['qa'], [], 'execute', {
      handoffs: [{ from: '费利', expectedOutput: '验收报告' }],
    })
    expect(base).toContain('上一棒期望（来自 费利）：验收报告')
    expect(base).not.toContain('上一棒交付物')

    const withPackage = buildTurnInstruction(PM, [PM, QA], ['qa'], [], 'execute', {
      handoffs: [
        {
          from: '费利',
          expectedOutput: '验收报告',
          artifacts: [
            { path: 'docs/需求.md', version: 3, size: 2048 },
            { path: 'docs/接口.md', version: 1, size: 512 },
          ],
          notes: '接口以 v2 为准',
        },
      ],
    })
    expect(withPackage).toContain('上一棒交付物（来自 费利）：docs/需求.md（v3 · 2KB）、docs/接口.md（1KB）')
    expect(withPackage).toContain('直接 read_file 查看，无需 list_dir 全盘盘点')
    expect(withPackage).toContain('交接口径（来自 费利）：接口以 v2 为准')
  })

  it('handoff 工具：显式路径经索引校验后随结果返回；未知路径忽略并回灌提示', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'], '交接包')
    write(env, session.id, 'docs/需求.md', '# 需求')
    env.index.upsert(session.id, [{ path: 'docs/需求.md', origin: 'tool', authorAgentId: 'pm', version: 2 }])

    const tool = env.tools.get('handoff')
    expect(tool).toBeDefined()
    const runtime = runtimeOf(env, session.id)

    const ok = (await tool!.execute(
      {
        target: 'qa',
        reason: '设计定稿，转验收',
        expected_output: '验收报告',
        artifacts: ['docs/需求.md', 'docs/不存在.md'],
        notes: '接口以 v2 为准',
      },
      runtime,
    )) as ToolResult
    expect(ok.ok).toBe(true)
    expect(ok.summary).toContain('交接包 1 件')
    expect(ok.handoff?.artifacts).toEqual(['docs/需求.md'])
    expect(ok.handoff?.notes).toBe('接口以 v2 为准')
    expect(ok.detail).toContain('1 个交付物路径不存在已忽略')

    // 未显式声明：handoff 结果不带 artifacts（引擎在收集时用本轮 message.artifacts 自动补齐）
    const auto = (await tool!.execute({ target: 'qa', reason: '继续' }, runtime)) as ToolResult
    expect(auto.handoff?.artifacts).toBeUndefined()
  })
})
