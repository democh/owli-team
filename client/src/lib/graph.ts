/**
 * 协作图谱数据推导（§28，M17）：纯前端口径，零后端改动。
 * - 节点 = 会话在场成员（用户不参与形象系统，不绘制用户节点；交接给用户以节点「待你指示」呈现）
 * - 接力实线 = 每条 agent 消息 mentions 派生接手关系（权重 = 接手次数；非交还用户时 mentions 即实际接手成员）
 * - 编制虚线 = 各场景 group.chain 相邻对（预期接力链路；与已有接力边同向重合时以实线为准）
 * - 边视觉语义（接线在 GraphView / RelayEdge）：实线蓝 = 顺向接力；实线琥珀 = 最近一棒（recent）；
 *   长虚线紫 = 回退接力（目标排名在源之前，由 layoutGraph.ranks 判定）；短虚线灰 = 编制预期
 * - 实时状态 = 复用现有 RunEvent（wave:start / run:start / queue:updated / turn:end），无新通道、无新 API
 * - M21 游戏化扩展：节点接手/交出计数（入/出边权重和）、图级战况摘要、单节点上下游明细
 * - M22 深度洞察：游离成员口径（接力已展开而从未参与）、多跳接力路径追踪（BFS）
 */
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'

/** 运行态快照（run-store / agent-store 归约后的实时字段） */
export interface GraphLive {
  /** 是否有进行中的 Run */
  active: boolean
  /** 当前波成员（wave:start；串行波长度为 1） */
  currentWave: string[]
  /** 待发言队列（含正在发言者；run:start / queue:updated / turn:end 对齐） */
  queue: string[]
  /** 成员运行状态（agent-store.statuses） */
  statuses: Record<string, string | undefined>
}

// type（非 interface）：满足 React Flow v12 Node 数据需具备隐式索引签名的约束
export type GraphNodeData = {
  agent: AgentDefinition
  group?: AgentGroup
  /** 分组主题色（节点描边；缺省 null） */
  themeColor: string | null
  /** 发言中（当前波成员 / speaking / thinking） */
  speaking: boolean
  /** 排队序号（1 起；0 = 不在队列） */
  queueIndex: number
  /** 待用户指示（最近一次完成发言交接给了用户，且当前无进行中 Run） */
  awaitingUser: boolean
  /** 近期接力高亮（最近一条 agent 消息的出手者与接手者） */
  recent: boolean
  /** M21：接手总次数（入边权重和，节点徽章「接手 N」） */
  inCount: number
  /** M21：交出总次数（出边权重和，档案面板统计） */
  outCount: number
  /** M22：游离成员——接力已展开（总量 ≥ 2）而从未参与任何一棒（nudge 提示） */
  isolated: boolean
}

export interface GraphNode {
  id: string
  data: GraphNodeData
}

export interface GraphEdge {
  id: string
  source: string
  target: string
  /** 接手次数（接力边）；编制边恒为 0 */
  count: number
  /** 最近接手时间（接力边） */
  lastAt?: string
  kind: 'relay' | 'chain'
  /** 最近一棒：最近一条 agent 消息派生的交接边（与节点 recent 高亮同源；编制边恒无） */
  recent?: boolean
}

export interface GraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 游离提示的最低接力量（低于该值不提示，避免会话早期满图 nudge） */
const ISOLATED_MIN_RELAY = 2

export function buildGraph(
  messages: ChatMessage[],
  participants: AgentDefinition[],
  groups: AgentGroup[],
  live?: GraphLive,
): GraphModel {
  const ids = new Set(participants.map((a) => a.id))
  const groupOf = new Map(groups.map((g) => [g.id, g]))

  // ---- 接力关系：逐条 agent 消息的 mentions 派生（streaming 中 mentions 未定，跳过）----
  const relay = new Map<string, GraphEdge>()
  let lastFrom: string | undefined
  let lastTo = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'agent' || !m.agentId || m.status === 'streaming') continue
    const from = m.agentId
    const targets = m.mentions.filter((x) => x !== 'user' && x !== from && ids.has(x))
    if (targets.length > 0) {
      lastFrom = from
      lastTo = new Set(targets)
    }
    for (const to of targets) {
      const key = `${from}->${to}`
      const edge = relay.get(key)
      if (edge) {
        edge.count += 1
        edge.lastAt = m.createdAt
      } else {
        relay.set(key, { id: key, source: from, target: to, count: 1, lastAt: m.createdAt, kind: 'relay' })
      }
    }
  }

  // ---- 最近一棒：最近一条 agent 消息派生的交接边（与节点 recent 同源；琥珀高亮 + 光晕）----
  if (lastFrom) {
    for (const to of lastTo) {
      const edge = relay.get(`${lastFrom}->${to}`)
      if (edge) edge.recent = true
    }
  }

  // ---- 编制虚线：各场景 chain 相邻对（两端须在场；与接力边重合时以实线为准）----
  const chainEdges: GraphEdge[] = []
  const seen = new Set(relay.keys())
  for (const g of groups) {
    for (let i = 0; i < g.chain.length - 1; i++) {
      const a = g.chain[i]!
      const b = g.chain[i + 1]!
      const key = `${a}->${b}`
      if (!ids.has(a) || !ids.has(b) || seen.has(key)) continue
      seen.add(key)
      chainEdges.push({ id: `chain:${g.id}:${key}`, source: a, target: b, count: 0, kind: 'chain' })
    }
  }

  // ---- M21：节点级接力计数（入 = 接手总次数；出 = 交出总次数）----
  const inCount = new Map<string, number>()
  const outCount = new Map<string, number>()
  let relayTotal = 0
  for (const e of relay.values()) {
    outCount.set(e.source, (outCount.get(e.source) ?? 0) + e.count)
    inCount.set(e.target, (inCount.get(e.target) ?? 0) + e.count)
    relayTotal += e.count
  }

  // ---- 待你指示：最近一条完成发言交还用户，且当前空闲 ----
  const lastAgent = [...messages].reverse().find((m) => m.role === 'agent' && m.status !== 'streaming')
  const awaitingUser =
    !(live?.active ?? false) && lastAgent?.mentions.includes('user') ? lastAgent.agentId : undefined

  // ---- 节点（participants 顺序 = 会话编制顺序）----
  const queue = live?.queue ?? []
  const wave = new Set(live?.currentWave ?? [])
  const nodes: GraphNode[] = participants.map((agent) => {
    const group = groupOf.get(agent.group)
    const qIdx = queue.indexOf(agent.id)
    const st = live?.statuses[agent.id]
    const speaking = Boolean(live?.active) && (wave.has(agent.id) || st === 'speaking' || st === 'thinking')
    return {
      id: agent.id,
      data: {
        agent,
        group,
        themeColor: group?.theme[0] ?? null,
        speaking,
        queueIndex: qIdx >= 0 ? qIdx + 1 : 0,
        awaitingUser: awaitingUser === agent.id,
        recent: !speaking && (agent.id === lastFrom || lastTo.has(agent.id)),
        inCount: inCount.get(agent.id) ?? 0,
        outCount: outCount.get(agent.id) ?? 0,
        // 接力已展开但从未参与（阈值避免会话早期满图 nudge）
        isolated:
          relayTotal >= ISOLATED_MIN_RELAY &&
          (inCount.get(agent.id) ?? 0) === 0 &&
          (outCount.get(agent.id) ?? 0) === 0,
      },
    }
  })

  return { nodes, edges: [...relay.values(), ...chainEdges] }
}

/** M21：图级战况摘要（HUD 显示；接力 = 全部接手次数之和） */
export interface GraphSummary {
  members: number
  relayEdges: number
  relayTotal: number
  chainCount: number
  /** 最近一条接力（lastAt 最大的接力边；无接力时为 undefined） */
  latest?: { source: string; target: string; lastAt: string }
}

export function summarizeGraph(model: GraphModel): GraphSummary {
  let relayEdges = 0
  let relayTotal = 0
  let latest: GraphSummary['latest']
  for (const e of model.edges) {
    if (e.kind !== 'relay') continue
    relayEdges += 1
    relayTotal += e.count
    if (e.lastAt && (!latest || e.lastAt > latest.lastAt)) {
      latest = { source: e.source, target: e.target, lastAt: e.lastAt }
    }
  }
  return {
    members: model.nodes.length,
    relayEdges,
    relayTotal,
    chainCount: model.edges.length - relayEdges,
    latest,
  }
}

/** M21：单节点上下游明细（档案面板；按接手次数降序，同数按最近时间降序） */
export interface GraphLink {
  id: string
  count: number
  lastAt?: string
}

export function neighborsOf(
  model: GraphModel,
  id: string,
): { upstream: GraphLink[]; downstream: GraphLink[] } {
  const upstream: GraphLink[] = []
  const downstream: GraphLink[] = []
  for (const e of model.edges) {
    if (e.kind !== 'relay') continue
    if (e.target === id) upstream.push({ id: e.source, count: e.count, lastAt: e.lastAt })
    if (e.source === id) downstream.push({ id: e.target, count: e.count, lastAt: e.lastAt })
  }
  const byWeight = (a: GraphLink, b: GraphLink): number =>
    b.count - a.count || (b.lastAt ?? '').localeCompare(a.lastAt ?? '')
  upstream.sort(byWeight)
  downstream.sort(byWeight)
  return { upstream, downstream }
}

// ---------- M22：接力路径追踪 ----------

/** 追踪结果：起点 hop=0，直接相关 hop=1，以此类推（maxHops 截断） */
export interface GraphTrace {
  /** id → 跳数（未触达的成员不在表内） */
  hops: Map<string, number>
  /** 链路范围内的接力边 id（两端均在表内） */
  edgeIds: Set<string>
}

/**
 * 从成员出发沿接力边双向 BFS，回答「这棒怎么一路传下来」。
 * 纯函数：沿接力边（不含编制虚线）双向扩散；边仅在两端都被触达时纳入链路。
 */
export function traceFrom(model: GraphModel, id: string, maxHops = 3): GraphTrace {
  const hops = new Map<string, number>([[id, 0]])
  const adj = new Map<string, string[]>()
  const relayEdges: GraphEdge[] = []
  for (const e of model.edges) {
    if (e.kind !== 'relay') continue
    relayEdges.push(e)
    const a = adj.get(e.source)
    if (a) a.push(e.target)
    else adj.set(e.source, [e.target])
    const b = adj.get(e.target)
    if (b) b.push(e.source)
    else adj.set(e.target, [e.source])
  }
  let frontier = [id]
  for (let depth = 1; depth <= maxHops && frontier.length > 0; depth++) {
    const next: string[] = []
    for (const cur of frontier) {
      for (const to of adj.get(cur) ?? []) {
        if (hops.has(to)) continue
        hops.set(to, depth)
        next.push(to)
      }
    }
    frontier = next
  }
  const edgeIds = new Set<string>()
  for (const e of relayEdges) {
    if (hops.has(e.source) && hops.has(e.target)) edgeIds.add(e.id)
  }
  return { hops, edgeIds }
}
