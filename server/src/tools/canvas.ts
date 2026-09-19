/**
 * M31：画布创作工具集（canvas_read / canvas_write）。
 *
 * Agent ↔ 画布闭环的读写通道：
 * - canvas_read：画布现状摘要（节点 / 连线；单节点详情）——创作前先看一眼，避免重复造节点；
 * - canvas_write：ops 批量写入（add_node / update_node / remove_node / connect / remove_edge），
 *   经 CanvasStore.applyOps 读-改-写：version+1、原子落盘、广播 notify:canvas-changed（前端合流）。
 *
 * 写入纪律：
 * - 缺省 id / 坐标由服务端补（自动排布到现有内容右缘），生效 id 回灌模型供后续 connect / update；
 * - connect 去重（同向同 kind 不重复建边）；两端节点必须存在，否则跳过（不报错中断整批）；
 * - 边语义三分：flow 生成数据流（实线）/ mind 脑图层级 / ref 关联引用（虚线）。
 */
import { z } from 'zod'
import type { CanvasNode, CanvasNodeData, CanvasOp } from '@multi-agent/shared'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'

const NODE_TYPES = ['image', 'video', 'note', 'prompt', 'mind', 'artifact', 'group', 'game', 'kline'] as const
const EDGE_KINDS = ['flow', 'mind', 'ref'] as const

/** 摘要单行化（文本节点可能多行；控制回灌 token） */
function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** 节点内容摘要（按类型提取关键字段；回灌模型定位用） */
function nodeDigest(node: CanvasNode): string {
  const data = node.data as Record<string, unknown>
  switch (node.type) {
    case 'image':
    case 'video': {
      const artifact = typeof data.artifact === 'string' ? data.artifact : undefined
      const prompt = typeof data.prompt === 'string' ? `「${oneLine(data.prompt, 40)}」` : undefined
      const jobId = typeof data.jobId === 'string' ? data.jobId : undefined
      return [artifact, prompt, jobId].filter(Boolean).join(' ')
    }
    case 'note':
    case 'prompt':
    case 'mind':
      return typeof data.text === 'string' ? `「${oneLine(data.text, 60)}」` : ''
    case 'artifact':
      return typeof data.path === 'string' ? data.path : ''
    case 'group':
      return typeof data.title === 'string' ? `「${oneLine(data.title, 40)}」` : ''
    case 'game': {
      // M34 博弈推演节点：模型 / 话题 / 标的 + 结果态（结果内联在 data.result）
      const model = typeof data.model === 'string' ? data.model : undefined
      const topic = typeof data.topic === 'string' ? `「${oneLine(data.topic, 40)}」` : undefined
      const symbol = typeof data.symbol === 'string' ? `@${data.symbol}` : undefined
      const state = data.result !== undefined && data.result !== null ? '有结果' : '配置态'
      return [model, topic, symbol, state].filter(Boolean).join(' ')
    }
    case 'kline': {
      // M34 K 线行情节点：标的 / 名称 / 周期 + bars 数量（缺省 = 空态）
      const symbol = typeof data.symbol === 'string' ? data.symbol : undefined
      const name = typeof data.name === 'string' ? `「${oneLine(data.name, 24)}」` : undefined
      const period = typeof data.period === 'string' ? data.period : undefined
      const bars = Array.isArray(data.bars) ? data.bars.length : 0
      return [symbol, name, period, bars > 0 ? `${bars} 根` : '空态'].filter(Boolean).join(' ')
    }
  }
}

const nodeIdArg = z.object({ node_id: z.string().min(1).optional() })

const canvasReadTool = {
  name: 'canvas_read',
  tier: 'deferred' as const,
  readOnly: true,
  description:
    '读取本会话的画布摘要：节点清单（id / 类型 / 坐标 / 内容摘录）、连线、画布尺寸信息；给 node_id 可查看单个节点的完整数据。要在画布上创作（摆放 / 连线 / 更新节点）前先读一眼现状。',
  parameters: {
    type: 'object',
    properties: {
      node_id: { type: 'string', description: '可选：某个节点的 id，查看其完整数据（缺省返回画布摘要）' },
    },
  },
  schema: nodeIdArg,
  async execute(args: { node_id?: string }, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.canvas) return { ok: false, summary: '画布存储未启用（服务端未装配画布）' }
    const doc = ctx.canvas.get(ctx.sessionId)
    if (args.node_id) {
      const node = doc.nodes.find((n) => n.id === args.node_id)
      if (!node) {
        return {
          ok: false,
          summary: `画布上没有节点 ${args.node_id}`,
          detail: '先用 canvas_read（不带参数）查看节点清单，再按清单中的 id 重试。',
        }
      }
      return {
        ok: true,
        summary: `节点 ${node.id}（${node.type} @(${Math.round(node.position.x)},${Math.round(node.position.y)})）`,
        detail: JSON.stringify(node, null, 2),
      }
    }
    if (doc.nodes.length === 0) {
      return {
        ok: true,
        summary: '画布为空',
        detail: '（画布还没有任何节点：可用 canvas_write 添加便签 / 提示词 / 节点，或用 media_generate 生成图片后自动落位）',
      }
    }
    const lines = doc.nodes.map((n) => {
      const digest = nodeDigest(n)
      return `- ${n.id} ${n.type} @(${Math.round(n.position.x)},${Math.round(n.position.y)})${digest ? ` ${digest}` : ''}`
    })
    const edgeLines = doc.edges.map((e) => `- ${e.id} ${e.kind} ${e.source} → ${e.target}`)
    return {
      ok: true,
      summary: `画布共 ${doc.nodes.length} 个节点 / ${doc.edges.length} 条连线（v${doc.version}）`,
      detail: [`节点：`, ...lines, ...(edgeLines.length > 0 ? ['连线：', ...edgeLines] : [])].join('\n'),
    }
  },
}

/** 节点 data 记录（zod 校验后信任为画布节点数据；结构由 CanvasStore / 前端消费方解释） */
const dataRecord = z.record(z.unknown())

const canvasOpSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add_node'),
    node: z.object({
      id: z.string().min(1).optional(),
      type: z.enum(NODE_TYPES),
      position: z.object({ x: z.number(), y: z.number() }).optional(),
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      data: dataRecord,
    }),
  }),
  z.object({
    op: z.literal('update_node'),
    id: z.string().min(1),
    data: dataRecord.optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  }),
  z.object({ op: z.literal('remove_node'), id: z.string().min(1) }),
  z.object({
    op: z.literal('connect'),
    source: z.string().min(1),
    target: z.string().min(1),
    kind: z.enum(EDGE_KINDS).optional(),
  }),
  z.object({ op: z.literal('remove_edge'), id: z.string().min(1) }),
])

type CanvasWriteArgs = { ops: Array<z.infer<typeof canvasOpSchema>> }

/** zod 校验结果 → CanvasOp（data 为宽记录，转画布节点数据类型） */
function toCanvasOps(ops: CanvasWriteArgs['ops']): CanvasOp[] {
  return ops.map((op): CanvasOp => {
    switch (op.op) {
      case 'add_node':
        return {
          op: 'add_node',
          node: {
            ...op.node,
            data: op.node.data as unknown as CanvasNodeData,
          },
        }
      case 'update_node':
        return {
          op: 'update_node',
          id: op.id,
          data: op.data as unknown as Partial<CanvasNodeData> | undefined,
          position: op.position,
          width: op.width,
          height: op.height,
        }
      case 'remove_node':
        return { op: 'remove_node', id: op.id }
      case 'connect':
        return { op: 'connect', source: op.source, target: op.target, kind: op.kind }
      case 'remove_edge':
        return { op: 'remove_edge', id: op.id }
    }
  })
}

/** 单条操作的回灌行（add_node / connect 携带生效 id） */
function appliedLine(op: CanvasOp, applied: { id?: string } | undefined): string {
  const id = applied?.id
  switch (op.op) {
    case 'add_node':
      return `+ 已添加 ${id ?? '?'}（${op.node.type}）`
    case 'update_node':
      return `~ 已更新 ${op.id}`
    case 'remove_node':
      return `- 已删除 ${op.id}（相关连线一并移除）`
    case 'connect':
      return id
        ? `→ 已连线 ${id}（${op.source} → ${op.target}，${op.kind ?? 'flow'}）`
        : `→ 连线跳过（${op.source} → ${op.target}：已存在或节点不存在）`
    case 'remove_edge':
      return `- 已删边 ${op.id}`
  }
}

const canvasWriteTool = {
  name: 'canvas_write',
  tier: 'deferred' as const,
  description:
    '在会话画布上批量写入（ops 数组）。节点类型：image 图片（data.artifact 工作区路径）/ video 视频 / note 便签（data.text）/ prompt 提示词（data.text、data.negative）/ mind 脑图主题（data.text，用 kind=mind 连线成树）/ artifact 交付件引用（data.path）/ group 画框（data.title）/ game 博弈推演（data.model 四模型 matrix 纳什均衡 / sequence 逆向归纳 / evolve 复制动态 / simulate 路径分位、data.topic 话题、data.symbol 标的、data.params 模型参数、data.seed 复现种子；带 data.result 即结果态——通常先用 fin_game 跑出结果，再把 result / stats / narrative 一并落画布）/ kline K 线行情（data.symbol 标的、data.name 名称、data.period 周期 day/week/month/min5/min15/min30/min60、data.adjust 复权 qfq/hfq/none、data.bars K 线数组（通常先用 fin_kline 拉取）、data.indicators 指标面板）。连线 kind：flow 生成数据流（如 prompt 节点 → image 节点）/ mind 脑图层级 / ref 关联引用。新节点缺省自动排布（可给 position 精确摆放）；返回各操作生效 id，可继续用 connect / update_node 引用。',
  parameters: {
    type: 'object',
    properties: {
      ops: {
        type: 'array',
        description: '操作清单（1-50 项，按顺序执行）',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add_node', 'update_node', 'remove_node', 'connect', 'remove_edge'] },
            node: {
              type: 'object',
              description: 'add_node 专用',
              properties: {
                id: { type: 'string', description: '可选：自定义 id（缺省服务端生成）' },
                type: { type: 'string', enum: [...NODE_TYPES] },
                position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
                width: { type: 'number' },
                height: { type: 'number' },
                data: { type: 'object', description: '节点数据（按 type 给字段，见工具说明）' },
              },
              required: ['type', 'data'],
            },
            id: { type: 'string', description: 'update_node / remove_node / remove_edge 的目标 id' },
            data: { type: 'object', description: 'update_node：部分字段合并更新' },
            position: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } } },
            width: { type: 'number' },
            height: { type: 'number' },
            source: { type: 'string', description: 'connect：起点节点 id' },
            target: { type: 'string', description: 'connect：终点节点 id' },
            kind: { type: 'string', enum: [...EDGE_KINDS], description: 'connect：边语义（默认 flow）' },
          },
          required: ['op'],
        },
      },
    },
    required: ['ops'],
  },
  schema: z.object({ ops: z.array(canvasOpSchema).min(1).max(50) }),
  async execute(args: CanvasWriteArgs, ctx: ToolRuntime): Promise<ToolResult> {
    if (!ctx.canvas) return { ok: false, summary: '画布存储未启用（服务端未装配画布）' }
    const ops = toCanvasOps(args.ops)
    // M31 修订：写入者透传（节点 by 注入 + 广播 actor，供前端作者徽标与写入高亮）
    const { doc, applied } = ctx.canvas.applyOps(ctx.sessionId, ops, { by: ctx.agentId })
    const lines = ops.map((op, i) => appliedLine(op, applied[i]))
    // M31 修订：写入的节点 id 清单随 meta 持久化（消息侧「在画布查看」精确定位）
    const nodeIds = ops
      .map((op, i) => ({ op: op.op, id: applied[i]?.id }))
      .filter((x) => (x.op === 'add_node' || x.op === 'update_node') && Boolean(x.id))
      .map((x) => x.id as string)
    return {
      ok: true,
      summary: `画布已更新（${ops.length} 项操作，v${doc.version}）`,
      detail: [...lines, `画布现有 ${doc.nodes.length} 节点 / ${doc.edges.length} 连线。`].join('\n'),
      meta: { canvasNodes: nodeIds },
    }
  },
}

/** M31：画布创作工具集（canvas_read 只读可与其它只读并行；canvas_write 写类串行） */
export function createCanvasTools(): AgentTool[] {
  return [canvasReadTool, canvasWriteTool]
}
