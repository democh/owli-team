/**
 * 协作图谱 buildGraph 纯函数（M17，§28）：
 * 接手边权重与最近时间 / 交还用户（不绘制用户节点）/ 编制虚线去重 /
 * 分组主题色 / 实时状态叠加（发言光晕·排队序号·近期接力）/ 空态。
 * M21 扩展：节点接手 / 交出计数、图级战况摘要、单节点上下游明细。
 * M22 扩展：接力路径追踪（traceFrom 双向 BFS）、游离成员口径（isolated）。
 * 边视觉语义扩展：最近一棒（edge.recent，与节点 recent 同源）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { buildGraph, neighborsOf, summarizeGraph, traceFrom, type GraphLive } from '../src/lib/graph'

let seq = 0

function agent(id: string, group = 'development'): AgentDefinition {
  return {
    id,
    name: id.toUpperCase(),
    role: '角色',
    title: '头衔',
    description: '',
    capabilities: [],
    avatar: { gradient: ['#000000', '#ffffff'], icon: 'user' },
    group,
    handoff: [],
  }
}

function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: `m${++seq}`,
    sessionId: 's1',
    role: 'agent',
    content: '',
    mentions: [],
    status: 'complete',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function group(over: Partial<AgentGroup> = {}): AgentGroup {
  return {
    id: 'development',
    name: '研发团队',
    description: '',
    icon: 'code',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
    ...over,
  }
}

const lives = (over: Partial<GraphLive> = {}): GraphLive => ({
  active: false,
  currentWave: [],
  queue: [],
  statuses: {},
  ...over,
})

describe('buildGraph：接力边（mentions 派生）', () => {
  it('同一对成员多次接手 → 权重累加、lastAt 取最近', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T01:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect')],
      [],
    )
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({
      source: 'pm',
      target: 'architect',
      count: 2,
      lastAt: '2026-01-01T01:00:00.000Z',
      kind: 'relay',
    })
  })

  it('最近一棒：仅最近一条派生的交接边标记 recent；交还用户不刷新', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'] }),
        msg({ agentId: 'architect', mentions: ['qa'] }),
        msg({ agentId: 'qa', mentions: ['user'] }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [],
    )
    const recent = graph.edges.filter((e) => e.recent).map((e) => `${e.source}->${e.target}`)
    expect(recent).toEqual(['architect->qa'])
  })

  it('交还用户不产生边；空闲时出手者标记「待你指示」', () => {
    const messages = [msg({ agentId: 'pm', content: '请确认', mentions: ['user'] })]
    const idle = buildGraph(messages, [agent('pm')], [], lives())
    expect(idle.edges).toHaveLength(0)
    expect(idle.nodes[0].data.awaitingUser).toBe(true)
    // 运行中不显示「待你指示」
    const running = buildGraph(messages, [agent('pm')], [], lives({ active: true }))
    expect(running.nodes[0].data.awaitingUser).toBe(false)
  })

  it('streaming 消息不参与推导；自指 / 非在场成员过滤', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', status: 'streaming', mentions: ['architect'] }),
        msg({ agentId: 'architect', mentions: ['architect', 'ghost', 'qa'] }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [],
    )
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0]).toMatchObject({ source: 'architect', target: 'qa', count: 1 })
  })
})

describe('buildGraph：编制虚线与分组主题色', () => {
  it('chain 相邻对生成虚线；与接力边同向重合时以实线为准（去重）', () => {
    const g = group({ chain: ['pm', 'architect', 'qa'] })
    const graph = buildGraph(
      [msg({ agentId: 'pm', mentions: ['architect'] })],
      [agent('pm'), agent('architect'), agent('qa')],
      [g],
    )
    const relay = graph.edges.filter((e) => e.kind === 'relay')
    const chain = graph.edges.filter((e) => e.kind === 'chain')
    expect(relay).toHaveLength(1)
    expect(chain.map((e) => `${e.source}->${e.target}`)).toEqual(['architect->qa'])
  })

  it('chain 两端须在场；themeColor 取分组主题色（未注册组为 null）', () => {
    const g = group({ chain: ['pm', 'architect', 'qa'] })
    const graph = buildGraph([], [agent('pm'), agent('architect'), agent('solo', 'other')], [g])
    expect(graph.edges.filter((e) => e.kind === 'chain')).toHaveLength(1)
    const themeOf = new Map(graph.nodes.map((n) => [n.id, n.data.themeColor]))
    expect(themeOf.get('pm')).toBe('#3b82f6')
    expect(themeOf.get('solo')).toBeNull()
  })

  it('空态：无消息时仅节点 + 编制虚线', () => {
    const graph = buildGraph([], [agent('pm'), agent('architect')], [group({ chain: ['pm', 'architect'] })])
    expect(graph.nodes).toHaveLength(2)
    expect(graph.edges).toHaveLength(1)
    expect(graph.edges[0].kind).toBe('chain')
  })
})

describe('buildGraph：实时状态叠加', () => {
  it('当前波成员 = 发言中；排队序号 1 起；近期接力由最近一条消息标记', () => {
    const graph = buildGraph(
      [msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' })],
      [agent('pm'), agent('architect'), agent('qa')],
      [],
      lives({ active: true, currentWave: ['architect'], queue: ['architect', 'qa'] }),
    )
    const byId = new Map(graph.nodes.map((n) => [n.id, n.data]))
    expect(byId.get('architect')!.speaking).toBe(true)
    expect(byId.get('architect')!.queueIndex).toBe(1)
    expect(byId.get('qa')!.speaking).toBe(false)
    expect(byId.get('qa')!.queueIndex).toBe(2)
    expect(byId.get('pm')!.queueIndex).toBe(0)
    // 近期接力：最近出手 pm、最近接手 architect（两者均高亮）
    expect(byId.get('pm')!.recent).toBe(true)
    expect(byId.get('architect')!.recent).toBe(false) // 发言中优先于近期高亮
    expect(byId.get('qa')!.recent).toBe(false)
  })

  it('无 live（历史重放）：不标记发言中与排队', () => {
    const graph = buildGraph([], [agent('pm')], [])
    expect(graph.nodes[0].data.speaking).toBe(false)
    expect(graph.nodes[0].data.queueIndex).toBe(0)
  })
})

describe('buildGraph：接力计数（M21）', () => {
  it('节点接手（入）/ 交出（出）计数 = 入 / 出边权重和', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T01:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-01T02:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [],
    )
    const byId = new Map(graph.nodes.map((n) => [n.id, n.data]))
    expect(byId.get('pm')!).toMatchObject({ inCount: 0, outCount: 2 })
    expect(byId.get('architect')!).toMatchObject({ inCount: 2, outCount: 1 })
    expect(byId.get('qa')!).toMatchObject({ inCount: 1, outCount: 0 })
  })

  it('无接力时全部归零（编制虚线不计入权重）', () => {
    const graph = buildGraph([], [agent('pm'), agent('architect')], [group({ chain: ['pm', 'architect'] })])
    for (const n of graph.nodes) expect(n.data.inCount + n.data.outCount).toBe(0)
  })
})

describe('summarizeGraph / neighborsOf（M21）', () => {
  it('战况摘要：成员 / 接力边数 / 总接手次数 / 编制条数 / 最新接力', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-02T00:00:00.000Z' }),
        msg({ agentId: 'qa', mentions: ['pm'], createdAt: '2026-01-03T00:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-04T00:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [group({ chain: ['pm', 'architect', 'qa'] })],
    )
    const s = summarizeGraph(graph)
    expect(s).toMatchObject({ members: 3, relayEdges: 3, relayTotal: 4, chainCount: 0 })
    expect(s.latest).toEqual({ source: 'architect', target: 'qa', lastAt: '2026-01-04T00:00:00.000Z' })
  })

  it('无接力时 latest 缺省；编制虚线只计入 chainCount', () => {
    const graph = buildGraph([], [agent('pm'), agent('architect')], [group({ chain: ['pm', 'architect'] })])
    const s = summarizeGraph(graph)
    expect(s).toMatchObject({ members: 2, relayEdges: 0, relayTotal: 0, chainCount: 1 })
    expect(s.latest).toBeUndefined()
  })

  it('neighborsOf：上下游明细按接手次数降序（同数按最近时间降序）；编制边不参与', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'qa', mentions: ['architect'], createdAt: '2026-01-02T00:00:00.000Z' }),
        msg({ agentId: 'qa', mentions: ['architect'], createdAt: '2026-01-02T01:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-03T00:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [group({ chain: ['pm', 'architect'] })],
    )
    const { upstream, downstream } = neighborsOf(graph, 'architect')
    expect(upstream.map((l) => [l.id, l.count])).toEqual([
      ['qa', 2],
      ['pm', 1],
    ])
    expect(downstream.map((l) => [l.id, l.count])).toEqual([['qa', 1]])
    // 无接力关系的成员返回双空
    const lonely = neighborsOf(graph, 'ghost')
    expect(lonely.upstream).toHaveLength(0)
    expect(lonely.downstream).toHaveLength(0)
  })
})

describe('traceFrom：接力路径追踪（M22）', () => {
  /** 纯链 pm → architect → qa（另附未参与的 luna） */
  const chainGraph = (): ReturnType<typeof buildGraph> =>
    buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-02T00:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('qa'), agent('luna')],
      [],
    )

  it('双向 BFS：起点 hop=0，逐跳展开；未触达成员不在表内', () => {
    const trace = traceFrom(chainGraph(), 'pm', 3)
    expect([...trace.hops.entries()]).toEqual([
      ['pm', 0],
      ['architect', 1],
      ['qa', 2],
    ])
    expect(trace.hops.has('luna')).toBe(false)
    // 链路内接力边全部纳入
    expect([...trace.edgeIds].sort()).toEqual(['architect->qa', 'pm->architect'])
  })

  it('maxHops 截断：仅两端都被触达的边纳入 edgeIds', () => {
    const trace = traceFrom(chainGraph(), 'pm', 1)
    expect([...trace.hops.entries()]).toEqual([
      ['pm', 0],
      ['architect', 1],
    ])
    expect([...trace.edgeIds]).toEqual(['pm->architect'])
  })

  it('环路：反向接力同样参与扩散（三角形一跳全员互达）', () => {
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'architect', mentions: ['qa'], createdAt: '2026-01-02T00:00:00.000Z' }),
        msg({ agentId: 'qa', mentions: ['pm'], createdAt: '2026-01-03T00:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('qa')],
      [],
    )
    const trace = traceFrom(graph, 'architect', 1)
    expect([...trace.hops.entries()]).toEqual([
      ['architect', 0],
      ['pm', 1],
      ['qa', 1],
    ])
    expect([...trace.edgeIds].sort()).toEqual(['architect->qa', 'pm->architect', 'qa->pm'])
  })

  it('编制虚线不参与追踪；孤立成员只含自身', () => {
    const graph = buildGraph(
      [msg({ agentId: 'pm', mentions: ['architect'] })],
      [agent('pm'), agent('architect'), agent('luna')],
      [group({ chain: ['pm', 'architect'] })],
    )
    const trace = traceFrom(graph, 'luna')
    expect([...trace.hops.entries()]).toEqual([['luna', 0]])
    expect(trace.edgeIds.size).toBe(0)
  })
})

describe('isolated：游离成员口径（M22）', () => {
  it('接力总量达阈值且从未参与 → isolated；参与者与低流量场景不标记', () => {
    // 阈值内：仅 1 次接力，全员不提示（避免会话早期满图 nudge）
    const early = buildGraph(
      [msg({ agentId: 'pm', mentions: ['architect'] })],
      [agent('pm'), agent('architect'), agent('luna')],
      [],
    )
    expect(early.nodes.find((n) => n.id === 'luna')!.data.isolated).toBe(false)
    // 累计 2 次后：luna 从未参与 → isolated；pm / architect 参与过 → 不标记
    const graph = buildGraph(
      [
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T00:00:00.000Z' }),
        msg({ agentId: 'pm', mentions: ['architect'], createdAt: '2026-01-01T01:00:00.000Z' }),
      ],
      [agent('pm'), agent('architect'), agent('luna')],
      [],
    )
    const byId = new Map(graph.nodes.map((n) => [n.id, n.data]))
    expect(byId.get('luna')!.isolated).toBe(true)
    expect(byId.get('pm')!.isolated).toBe(false)
    expect(byId.get('architect')!.isolated).toBe(false)
  })
})
