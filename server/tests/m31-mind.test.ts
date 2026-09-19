/**
 * M31 脑图生成服务端测试（P4）：
 * - MindGenerator 五来源素材组装（conversation / plans / tasks / memory / topic）→ 结构化 JSON 树；
 * - 空来源引导错误（code='empty'）/ LLM 失败（code='llm'）/ 输出不可用（code='invalid'）；
 * - 请求契约（meta.agentId / responseFormat / summaryModel / 素材文本）+ usage kind='mind' 落库；
 * - coerceMindTree 归一化（深度 / 子节点上限 / 标题缺失与截断 / 非法输入）与 renderConversation 渲染。
 */
import { describe, expect, it } from 'vitest'
import type { MindTreeNode } from '@multi-agent/shared'
import { coerceMindTree, MIND_AGENT_ID, MindGenerator, renderConversation } from '../src/canvas/mind.js'
import type { ChatRequest, LlmChunk, LlmProvider } from '../src/llm/provider.js'
import { makeEnv } from './helpers.js'

/** 脚本化 Provider：逐次返回预置 JSON / 原始文本 / 抛错（越界后重复最后一条） */
function scriptedProvider(scripts: Array<{ json?: unknown; raw?: string; fail?: string }>): {
  provider: LlmProvider
  requests: ChatRequest[]
} {
  const requests: ChatRequest[] = []
  let call = 0
  const provider: LlmProvider = {
    chatStream: async function* (req: ChatRequest, _signal: AbortSignal): AsyncIterable<LlmChunk> {
      requests.push(req)
      const script = scripts[Math.min(call, scripts.length - 1)]!
      call += 1
      if (script.fail) throw new Error(script.fail)
      const text = script.raw ?? JSON.stringify(script.json)
      const mid = Math.ceil(text.length / 2)
      yield { type: 'text', text: text.slice(0, mid) }
      yield { type: 'text', text: text.slice(mid) }
      yield { type: 'usage', usage: { promptTokens: 100, completionTokens: 50 } }
    },
  }
  return { provider, requests }
}

function makeMindEnv(): ReturnType<typeof makeEnv> & { mindOf: (scripts: Array<{ json?: unknown; raw?: string; fail?: string }>) => MindGenerator } {
  const env = makeEnv()
  return Object.assign(env, {
    mindOf: (scripts: Array<{ json?: unknown; raw?: string; fail?: string }>): MindGenerator => {
      const { provider } = scriptedProvider(scripts)
      return new MindGenerator({
        cfg: env.cfg,
        provider,
        sessions: env.sessions,
        tasks: env.tasks,
        plans: env.plans,
        memory: env.memory,
        usage: env.usage,
      })
    },
  })
}

function appendUser(env: ReturnType<typeof makeEnv>, sessionId: string, content: string): void {
  env.sessions.appendMessage({ sessionId, role: 'user', content, mentions: [], status: 'complete' })
}

const SAMPLE_TREE: MindTreeNode = {
  title: '登录重构',
  children: [
    { title: '阶段一', children: [{ title: '抽离会话层' }] },
    { title: '阶段二', children: [{ title: '接入 OAuth' }] },
  ],
}

describe('MindGenerator：来源组装与成功路径（M31）', () => {
  it('conversation：素材含对话文本；请求契约正确；usage kind=mind 落库', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '登录重构')
    appendUser(env, session.id, '讨论登录重构')
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'arch',
      content: '拆成三步推进',
      mentions: [],
      status: 'complete',
    })
    const { provider, requests } = scriptedProvider([{ json: SAMPLE_TREE }])
    const mind = new MindGenerator({
      cfg: env.cfg,
      provider,
      sessions: env.sessions,
      tasks: env.tasks,
      plans: env.plans,
      memory: env.memory,
      usage: env.usage,
    })
    const result = await mind.generate({ sessionId: session.id, source: 'conversation' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tree).toEqual(SAMPLE_TREE)

    const req = requests[0]!
    expect(req.meta.agentId).toBe(MIND_AGENT_ID)
    expect(req.responseFormat?.name).toBe('mind_tree')
    expect(req.temperature).toBe(0.3)
    const material = String(req.messages[0]!.content)
    expect(material).toContain('source="conversation"')
    expect(material).toContain('[用户] 讨论登录重构')
    expect(material).toContain('[Agent(arch)] 拆成三步推进')

    const rows = env.db.all<{ kind: string; session_id: string }>(`SELECT kind, session_id FROM usage WHERE kind = 'mind'`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.session_id).toBe(session.id)
  })

  it('plans / tasks / memory：对应素材进入请求文本（仅启用记忆参与）', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '上线冲刺')
    env.plans.create({
      sessionId: session.id,
      agentId: 'pm',
      title: '上线计划',
      goal: '两周完成灰度上线',
      steps: [{ content: '灰度发布脚本' }, { content: '回滚演练', mode: 'review' }],
    })
    env.tasks.replace(session.id, undefined, [
      { content: '搭骨架', status: 'in_progress', ownerAgentId: 'fe' },
      { content: '接接口', status: 'pending' },
    ])
    env.memory.upsertScoped('session', session.id, 'decision', '采用 JWT 会话', { status: 'active' })
    env.memory.upsertScoped('session', session.id, 'fact', '候选不启用的记忆', { status: 'candidate' })

    const cases: Array<{ source: 'plans' | 'tasks' | 'memory'; marker: string; root: string }> = [
      { source: 'plans', marker: '上线计划', root: '计划全景' },
      { source: 'tasks', marker: '搭骨架', root: '任务全景' },
      { source: 'memory', marker: '采用 JWT 会话', root: '记忆图谱' },
    ]
    for (const c of cases) {
      const { provider, requests } = scriptedProvider([{ json: SAMPLE_TREE }])
      const mind = new MindGenerator({
        cfg: env.cfg,
        provider,
        sessions: env.sessions,
        tasks: env.tasks,
        plans: env.plans,
        memory: env.memory,
        usage: env.usage,
      })
      const result = await mind.generate({ sessionId: session.id, source: c.source })
      expect(result.ok).toBe(true)
      const material = String(requests[0]!.messages[0]!.content)
      expect(material).toContain(c.marker)
      if (c.source === 'memory') expect(material).not.toContain('候选不启用的记忆')
    }
  })

  it('topic：自定义主题直接作为素材；根标题缺省时用主题回填', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '主题会话')
    const { provider, requests } = scriptedProvider([{ raw: '```json\n{ "children": [ { "title": "分支" } ] }\n```' }])
    const mind = new MindGenerator({
      cfg: env.cfg,
      provider,
      sessions: env.sessions,
      tasks: env.tasks,
      plans: env.plans,
      memory: env.memory,
      usage: env.usage,
    })
    const result = await mind.generate({ sessionId: session.id, source: 'topic', topic: '微服务拆分' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tree.title).toBe('微服务拆分') // 模型未给 title → fallback
    expect(result.tree.children?.[0]?.title).toBe('分支')
    expect(String(requests[0]!.messages[0]!.content)).toContain('微服务拆分')
  })
})

describe('MindGenerator：失败路径（M31）', () => {
  it('空来源：conversation / plans / tasks / memory 给引导错误（code=empty）；topic 缺参同错', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '空会话')
    const mind = env.mindOf([{ json: SAMPLE_TREE }])
    for (const source of ['conversation', 'plans', 'tasks', 'memory'] as const) {
      const result = await mind.generate({ sessionId: session.id, source })
      expect(result.ok).toBe(false)
      if (result.ok) continue
      expect(result.code).toBe('empty')
      expect(result.error.length).toBeGreaterThan(0)
    }
    const topic = await mind.generate({ sessionId: session.id, source: 'topic' })
    expect(topic.ok).toBe(false)
    if (!topic.ok) expect(topic.code).toBe('empty')
  })

  it('LLM 调用失败 → code=llm，错误文案透传', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '失败会话')
    appendUser(env, session.id, '有内容')
    const mind = env.mindOf([{ fail: '上游 503 不可用' }])
    const result = await mind.generate({ sessionId: session.id, source: 'conversation' })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('llm')
    expect(result.error).toContain('上游 503 不可用')
  })

  it('输出不可用 → code=invalid（非 JSON / 根无子节点）', async () => {
    const env = makeMindEnv()
    const session = env.sessions.create([], '无效输出会话')
    appendUser(env, session.id, '有内容')
    const bad = env.mindOf([{ raw: '这不是 JSON' }])
    const r1 = await bad.generate({ sessionId: session.id, source: 'conversation' })
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.code).toBe('invalid')

    const lonely = env.mindOf([{ json: { title: '只有根' } }])
    const r2 = await lonely.generate({ sessionId: session.id, source: 'conversation' })
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.code).toBe('invalid')
  })
})

describe('coerceMindTree：归一化（M31）', () => {
  it('深度截断到 3 层；子节点上限 6；标题截断 60 字', () => {
    const deep = { title: 'r', children: [{ title: 'a', children: [{ title: 'b', children: [{ title: 'c', children: [{ title: 'd' }] }] }] }] }
    const tree = coerceMindTree(deep, '兜底')
    expect(tree?.children?.[0]?.children?.[0]?.children).toBeUndefined() // 第 3 层为叶
    const wide = { title: 'r', children: Array.from({ length: 8 }, (_, i) => ({ title: `c${i}` })) }
    expect(coerceMindTree(wide, '兜底')?.children).toHaveLength(6)
    const long = { title: 'x'.repeat(100), children: [{ title: 'a' }] }
    expect(coerceMindTree(long, '兜底')?.title).toHaveLength(60)
  })

  it('根 title 缺失用 fallback；子节点 title 缺失丢弃；非法输入返回 undefined', () => {
    const tree = coerceMindTree({ children: [{ title: '  ' }, { title: '有效' }] }, '主题')
    expect(tree?.title).toBe('主题')
    expect(tree?.children?.map((c) => c.title)).toEqual(['有效'])
    expect(coerceMindTree(null, 'x')).toBeUndefined()
    expect(coerceMindTree([1, 2], 'x')).toBeUndefined()
    expect(coerceMindTree({ title: '无子节点' }, 'x')).toBeUndefined()
  })
})

describe('renderConversation（M31）', () => {
  it('渲染角色与工具调用行；工具摘要压缩空白', () => {
    const lines = renderConversation([
      { id: 'm1', sessionId: 's', role: 'user', content: '看下仓库', mentions: [], status: 'complete', createdAt: '' },
      {
        id: 'm2',
        sessionId: 's',
        role: 'agent',
        agentId: 'dev',
        content: '  已检查  ',
        mentions: [],
        status: 'complete',
        createdAt: '',
        toolCalls: [{ id: 't1', name: 'run_command', args: {}, status: 'ok', summary: 'git   status\n干净', startedAt: '' }],
      },
    ])
    expect(lines).toContain('[用户] 看下仓库')
    expect(lines).toContain('[Agent(dev)] 已检查')
    expect(lines).toContain('· 工具 run_command：git status 干净')
  })
})
