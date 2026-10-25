import fs from 'node:fs'
import path from 'node:path'
import type { RunExecutionState } from '@multi-agent/shared'
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ArtifactVersionStore, MAX_VERSION_CONTENT_BYTES } from '../src/store/artifact-versions.js'
import { openDatabase } from '../src/store/db.js'
import { SessionStore } from '../src/store/sessions.js'
import { appendUserMessage, makeEnv, makeTmpDir, routePassThrough, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

function seedAgents(agentsDir: string): void {
  const agentMd = (id: string, name: string, tools?: string): string =>
    [
      '---',
      `id: ${id}`,
      `name: ${name}`,
      `role: ${name}`,
      `title: ${name}`,
      `description: 测试角色 ${id}`,
      'capabilities: [协作]',
      'avatar:',
      '  icon: user',
      '  gradient: ["#6366f1", "#818cf8"]',
      'handoff: []',
      ...(tools ? [`tools: [${tools}]`] : []),
      '---',
      '',
      '## 职责',
      '',
      '测试正文。',
      '',
    ].join('\n')
  fs.mkdirSync(path.join(agentsDir, 'development', 'pm'), { recursive: true })
  fs.mkdirSync(path.join(agentsDir, 'development', 'architect'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协作协议\n')
  fs.writeFileSync(
    path.join(agentsDir, 'development', '_group.yaml'),
    [
      'id: development',
      'name: 研发团队',
      'description: 测试场景',
      'icon: code',
      'theme: ["#3b82f6", "#60a5fa"]',
      'objective: 交付可用软件',
      'chain: [pm, architect]',
      'defaultSkills: []',
      'parallel: false',
      'rounds: false',
      'order: 10',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(agentsDir, 'development', 'pm', 'AGENT.md'), agentMd('pm', '产品经理'))
  fs.writeFileSync(
    path.join(agentsDir, 'development', 'architect', 'AGENT.md'),
    agentMd('architect', '架构师'),
  )
}

function makeIsolatedEnv(overrides: Parameters<typeof makeEnv>[0] = {}): Env {
  const agentsDir = path.join(makeTmpDir('ma-runtime-consistency-'), 'agents')
  seedAgents(agentsDir)
  return makeEnv({ agentsDir, autonomyEnabled: false, parallelMax: 1, maxTurnsPerRun: 20, ...overrides })
}

function installProvider(env: Env, handler: (req: ChatRequest) => LlmChunk[]): void {
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    const route = routePassThrough(req)
    if (route) {
      for (const chunk of route) yield chunk
      return
    }
    for (const chunk of handler(req)) yield chunk
  }
}

function call(name: string, args: Record<string, unknown>): LlmChunk {
  return { type: 'tool_calls', calls: [{ id: `call_${name}`, name, arguments: JSON.stringify(args) }] }
}

const text = (value: string): LlmChunk => ({ type: 'text', text: value })
const done: LlmChunk = { type: 'done' }
const hasToolResult = (req: ChatRequest): boolean => req.messages.some((message) => message.role === 'tool')

describe('运行链路：执行期工具授权', () => {
  it('模型直调角色白名单外的已知工具时，在审批和副作用前拒绝', async () => {
    const env = makeIsolatedEnv()
    const restricted = path.join(env.cfg.agentsDir, 'development', 'pm', 'AGENT.md')
    const source = fs.readFileSync(restricted, 'utf8')
    fs.writeFileSync(restricted, source.replace('handoff: []', 'handoff: []\ntools: [read_file]'))
    env.prompts.reload()
    const session = env.sessions.create(['pm'], '越权工具')
    installProvider(env, (req) => {
      if (!hasToolResult(req)) return [call('write_file', { path: 'denied.md', content: '不应落盘' }), done]
      return [text('已如实说明工具未获授权。\n@用户'), done]
    })
    const message = appendUserMessage(env, session.id, '@pm 写入文件')
    const { runId } = env.engine.launch(session.id, message.id, { triggerUserId: 'user-trigger' })
    await waitRunFinished(env.engine, runId)

    const agentMessage = env.sessions.messages(session.id).find((item) => item.role === 'agent')
    const entry = agentMessage?.toolCalls?.find((item) => item.name === 'write_file')
    expect(entry?.status).toBe('error')
    expect(entry?.summary).toContain('未获本回合授权')
    expect(fs.existsSync(path.join(env.artifacts.sessionDir(session.id), 'denied.md'))).toBe(false)
    expect(env.approvals.pendingOf(runId)).toEqual([])
  })
})

describe('运行链路：技能渐进披露', () => {
  it('正文按需加载并进入快照，激活态不跨成员共享', async () => {
    const env = makeIsolatedEnv()
    for (const id of ['pm', 'architect']) {
      const file = path.join(env.cfg.agentsDir, 'development', id, 'AGENT.md')
      const source = fs.readFileSync(file, 'utf8')
      fs.writeFileSync(file, source.replace('handoff: []', 'handoff: []\ntools: [load_skill]\nskills: [code-review]'))
    }
    env.prompts.reload()
    const requests: ChatRequest[] = []
    installProvider(env, (req) => {
      requests.push(req)
      if (req.meta.agentId === 'pm' && !hasToolResult(req)) {
        return [call('load_skill', { name: 'code-review' }), done]
      }
      return [text(req.meta.agentId === 'pm' ? '@架构师 请继续。' : '@用户 已完成。'), done]
    })
    const session = env.sessions.create(['pm', 'architect'], '技能按需加载')
    const message = appendUserMessage(env, session.id, '@pm 按代码评审技能处理')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const pmRequests = requests.filter((req) => req.meta.agentId === 'pm')
    const architectRequest = requests.find((req) => req.meta.agentId === 'architect')!
    expect(pmRequests[0].system).toContain('code-review')
    expect(pmRequests[0].system).not.toContain('# 已装载技能：code-review')
    // 同回合的工具续问沿用回合开始时的系统提示，正文已随工具结果返回；下次装配再复用激活态。
    expect(pmRequests[1].system).not.toContain('# 已装载技能：code-review')
    expect(architectRequest.system).not.toContain('# 已装载技能：code-review')
    expect(env.runs.get(runId)?.execution?.loadedSkills).toEqual({ pm: ['code-review'] })
    const pmNext = await env.context.prepareTurn({ sessionId: session.id, agentId: 'pm', runId, queue: [], loadedSkills: ['code-review'] })
    const architectNext = await env.context.prepareTurn({ sessionId: session.id, agentId: 'architect', runId, queue: [] })
    expect(pmNext.system).toContain('# 已装载技能：code-review')
    expect(architectNext.system).not.toContain('# 已装载技能：code-review')
  })

  it('未声明 load_skill 的旧角色保留技能预载兜底', async () => {
    const env = makeIsolatedEnv()
    const file = path.join(env.cfg.agentsDir, 'development', 'pm', 'AGENT.md')
    const source = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, source.replace('handoff: []', 'handoff: []\nskills: [code-review]'))
    env.prompts.reload()
    const session = env.sessions.create(['pm'], '旧角色技能兜底')
    const prepared = await env.context.prepareTurn({ sessionId: session.id, agentId: 'pm', runId: 'run-skill', queue: [] })
    expect(prepared.system).toContain('# 已装载技能：code-review')
  })
})

describe('运行链路：Plan 顺序与复验', () => {
  it('A→B→A 不合并，execute/review 由当前步骤决定且不提前推进后续步骤', async () => {
    const env = makeIsolatedEnv()
    const session = env.sessions.create(['pm', 'architect'], '顺序计划')
    const plan = env.plans.create({
      sessionId: session.id,
      agentId: 'pm',
      title: '顺序计划',
      goal: '验证顺序派发',
      steps: [
        { content: 'A 执行', ownerAgentId: 'pm' },
        { content: 'B 评审', ownerAgentId: 'architect', mode: 'review' },
        { content: 'A 再执行', ownerAgentId: 'pm' },
      ],
    })
    env.plans.setStatus(plan.id, 'approved')
    const turns: string[] = []
    const thirdStepAtReview: string[] = []
    let pmSteps = 0
    installProvider(env, (req) => {
      if (hasToolResult(req)) return [text('本步完成。'), done]
      const agentId = req.meta.agentId
      turns.push(`${agentId}:${req.meta.mode ?? 'execute'}`)
      if (agentId === 'architect') {
        thirdStepAtReview.push(env.plans.get(plan.id)!.steps[2].status)
        return [
          {
            type: 'tool_calls',
            calls: [
              {
                id: 'review_s2',
                name: 'submit_review',
                arguments: JSON.stringify({ target: `step:${plan.id}/s2`, verdict: 'pass', findings: [] }),
              },
              {
                id: 'done_s2',
                name: 'update_plan_step',
                arguments: JSON.stringify({ step_id: 's2', plan_id: plan.id, status: 'done' }),
              },
            ],
          },
          done,
        ]
      }
      if (req.tools?.some((tool) => tool.name === 'update_plan_step')) {
        pmSteps++
        const stepId = pmSteps === 1 ? 's1' : 's3'
        return [call('update_plan_step', { step_id: stepId, plan_id: plan.id, status: 'done' }), done]
      }
      return [text('计划收口。'), done]
    })

    const { runId } = env.engine.launchPlanExecution(session.id, plan.id, { triggerUserId: 'user-plan' })
    await waitRunFinished(env.engine, runId)
    expect(turns.slice(0, 3)).toEqual(['pm:execute', 'architect:review', 'pm:execute'])
    expect(thirdStepAtReview).toEqual(['pending'])
    expect(env.plans.get(plan.id)?.steps.map((step) => step.status)).toEqual(['done', 'done', 'done'])
    expect(env.plans.get(plan.id)?.status).toBe('done')
  })
})

describe('运行链路：版本化恢复', () => {
  it('恢复 Plan、技能、累计回合和待消费插话，并保留快照触发身份', async () => {
    const env = makeIsolatedEnv()
    const architectFile = path.join(env.cfg.agentsDir, 'development', 'architect', 'AGENT.md')
    const architectSource = fs.readFileSync(architectFile, 'utf8')
    fs.writeFileSync(
      architectFile,
      architectSource.replace('handoff: []', 'handoff: []\ntools: [load_skill, update_plan_step]\nskills: [code-review]'),
    )
    env.prompts.reload()
    const session = env.sessions.create(['pm', 'architect'], '恢复计划')
    const plan = env.plans.create({
      sessionId: session.id,
      agentId: 'pm',
      title: '恢复计划',
      goal: '从中断点继续',
      steps: [
        { content: '已完成', ownerAgentId: 'pm' },
        { content: '待恢复', ownerAgentId: 'architect' },
      ],
    })
    env.plans.setStatus(plan.id, 'approved')
    env.plans.setStatus(plan.id, 'executing')
    env.plans.setStepStatus(plan.id, 's1', 'done')
    const injected = appendUserMessage(env, session.id, '恢复时补充这条约束')
    const execution: RunExecutionState = {
      version: 1,
      triggerUserId: 'user-original',
      mode: 'execute',
      relayMode: 'auto',
      activePlanIds: [plan.id],
      pendingPlanIds: [],
      planDispatch: { architect: [{ planId: plan.id, stepId: 's2' }] },
      waveSignatures: ['pm'],
      waveTexts: ['已完成首步'],
      waveWriteCounts: [1],
      forceNextParallel: false,
      synthesisAdded: false,
      planSubmissions: 1,
      planRefillStreak: 0,
      loadedSkills: { architect: ['code-review'] },
    }
    env.runs.create({ id: 'run-interrupted', sessionId: session.id, state: 'waiting', queue: ['architect'], execution })
    env.runs.update('run-interrupted', {
      queue: ['architect'],
      spoken: ['pm'],
      turnIndex: 4,
      fallbackUsed: true,
      handedToUser: true,
      pendingUserMessages: [injected.id],
      execution,
    })
    env.db.run("UPDATE runs SET state = 'interrupted' WHERE id = 'run-interrupted'")
    const requests: ChatRequest[] = []
    installProvider(env, (req) => {
      requests.push(req)
      if (req.meta.agentId === 'architect' && !hasToolResult(req)) {
        return [call('update_plan_step', { step_id: 's2', plan_id: plan.id, status: 'done' }), done]
      }
      return [text('恢复完成。'), done]
    })

    const resumed = env.engine.resume(session.id, 'run-interrupted')
    expect(env.runs.get(resumed.runId)?.triggerUserId).toBe('user-original')
    await waitRunFinished(env.engine, resumed.runId)
    expect(resumed.queue).toEqual(['architect'])
    expect(env.runs.get(resumed.runId)?.turnIndex).toBeGreaterThan(4)
    expect(env.runs.get(resumed.runId)?.pendingUserMessages).toEqual([])
    expect(requests.some((req) => JSON.stringify(req.messages).includes('恢复时补充这条约束'))).toBe(true)
    expect(requests.find((req) => req.meta.agentId === 'architect')?.system).toContain('# 已装载技能：code-review')
    expect(env.plans.get(plan.id)?.status).toBe('done')
    expect(env.runs.get('run-interrupted')?.state).toBe('done')
  })

  it('未知快照版本明确降级为旧队列数据', () => {
    const env = makeIsolatedEnv()
    const session = env.sessions.create(['pm'], '旧快照')
    env.runs.create({ id: 'run-legacy', sessionId: session.id, state: 'waiting', queue: ['pm'], triggerUserId: 'legacy-user' })
    env.db.run("UPDATE runs SET execution_state = '{\"version\":99}', state = 'interrupted' WHERE id = 'run-legacy'")
    const snapshot = env.runs.get('run-legacy')
    expect(snapshot?.execution).toBeUndefined()
    expect(snapshot?.queue).toEqual(['pm'])
    expect(snapshot?.triggerUserId).toBe('legacy-user')
  })
})

describe('运行链路：交付件原始内容版本', () => {
  it('二进制与大文本同尺寸修改产生新版本，重复内容仍去重', () => {
    const root = makeTmpDir('ma-artifact-version-')
    const artifacts = new ArtifactStore(root)
    const db = openDatabase(path.join(makeTmpDir('ma-artifact-version-db-'), 'app.db'))
    const versions = new ArtifactVersionStore(db)
    const session = new SessionStore(db).create([], '交付件版本')
    artifacts.ensureSessionDir(session.id)
    const record = (relPath: string) => {
      const read = artifacts.read(session.id, relPath, MAX_VERSION_CONTENT_BYTES)
      return versions.record({ sessionId: session.id, path: relPath, content: read.content, hash: read.hash, size: read.size })
    }

    fs.writeFileSync(path.join(artifacts.sessionDir(session.id), 'same.bin'), Buffer.from([0, 1, 2, 3]))
    expect(record('same.bin')?.version).toBe(1)
    fs.writeFileSync(path.join(artifacts.sessionDir(session.id), 'same.bin'), Buffer.from([3, 2, 1, 0]))
    expect(record('same.bin')?.version).toBe(2)
    expect(record('same.bin')).toBeUndefined()
    expect(versions.get(session.id, 'same.bin', 2)?.content).toBeUndefined()

    const largeA = `a${'x'.repeat(MAX_VERSION_CONTENT_BYTES)}`
    const largeB = `b${'x'.repeat(MAX_VERSION_CONTENT_BYTES)}`
    fs.writeFileSync(path.join(artifacts.sessionDir(session.id), 'large.txt'), largeA)
    expect(record('large.txt')?.version).toBe(1)
    fs.writeFileSync(path.join(artifacts.sessionDir(session.id), 'large.txt'), largeB)
    expect(record('large.txt')?.version).toBe(2)
    expect(versions.get(session.id, 'large.txt', 2)?.content).toBeUndefined()
    expect(versions.get(session.id, 'large.txt', 1)?.hash).not.toBe(versions.get(session.id, 'large.txt', 2)?.hash)
    expect(() => versions.record({ sessionId: session.id, path: 'missing-hash', size: 12 })).toThrow('原始内容摘要')
    db.close()
  })
})
