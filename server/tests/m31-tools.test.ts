/**
 * M31 单测：画布创作工具集（canvas_read / canvas_write / media_generate / media_video）——
 * Agent ↔ 画布闭环的读写通道。
 *
 * 守护五件事：
 * - 未装配守卫：ctx 缺 canvas / media 时给出明确「未启用」提示（绝不静默失败）；
 * - canvas_read：空画布引导 / 节点与连线摘要（id 类型 坐标 摘要）/ 单节点 JSON 详情 / 未知 id 引导；
 * - canvas_write：缺省 id 与坐标自动补（空画布原点、连排右移）并回灌生效 id；connect 去重与悬空跳过；
 *   remove_node 级联删边；zod 拒绝空 / 非法 / 超量 ops；写入广播 by=agent；
 * - media_*：未配置连接透传引导（含 detail 去「设置 → 媒体生成」指引）；「创建即返回」（job id + 异步提示 + 作者标注）；
 *   canvasTarget 自动落位（place_on_canvas 开关 + 服务端未装配画布时放弃放置）；首尾帧不齐 / 能力未声明透传错误；
 * - 元数据：canvas_read 只读、四工具全部 deferred（渐进披露，经 tool_search 激活）。
 */
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MediaCapability, MediaConnectionConfig } from '@multi-agent/shared'
import { CanvasStore } from '../src/canvas/store.js'
import { SecretVault } from '../src/connections/crypto.js'
import { MediaService } from '../src/media/service.js'
import type { MediaProviderAdapter } from '../src/media/types.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { SessionStore } from '../src/store/sessions.js'
import { createCanvasTools } from '../src/tools/canvas.js'
import { createMediaTools } from '../src/tools/media.js'
import type { AgentTool, ToolResult, ToolRuntime } from '../src/tools/registry.js'
import type { NotifyHub } from '../src/ws.js'
import { makeTmpDir, type PublishedNotification } from './helpers.js'

const ALL_CAPS: MediaCapability[] = ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video']

interface CanvasChange {
  sessionId: string
  version: number
  by: string
}

interface ToolsEnv {
  sessionId: string
  connections: ConnectionStore
  canvas: CanvasStore
  media: MediaService
  canvasChanges: CanvasChange[]
  tools: Map<string, AgentTool>
  runtime: ToolRuntime
}

/** 每个用例独立 SQLite + Vault + workspace + 画布目录（互不污染） */
function makeEnv(): ToolsEnv {
  const dir = makeTmpDir('ma-m31-tools-')
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const sessions = new SessionStore(db)
  const session = sessions.create([], 'M31 工具测试')
  const artifacts = new ArtifactStore(path.join(dir, 'workspace'))
  const notify = {
    publish: (input: PublishedNotification) => input,
  } as unknown as NotifyHub
  const media = new MediaService({ connections, artifacts, notify })
  const canvasChanges: CanvasChange[] = []
  const canvas = new CanvasStore({
    dataDir: path.join(dir, 'data'),
    publish: (sessionId, version, by) => canvasChanges.push({ sessionId, version, by }),
  })
  const tools = new Map<string, AgentTool>(
    [...createCanvasTools(), ...createMediaTools()].map((t) => [t.name, t] as const),
  )
  // 工具实现只消费 sessionId / agentId / canvas / media（其余运行时字段与本体无关）
  const runtime = { sessionId: session.id, runId: 'r-m31-tools', agentId: 'pm', canvas, media } as unknown as ToolRuntime
  return { sessionId: session.id, connections, canvas, media, canvasChanges, tools, runtime }
}

/** 按生产链路执行：先 zod 解析（默认值 / 校验生效）再 execute */
async function runTool(env: ToolsEnv, name: string, args: unknown): Promise<ToolResult> {
  const tool = env.tools.get(name)
  if (!tool) throw new Error(`工具不存在：${name}`)
  return tool.execute(tool.schema.parse(args), env.runtime)
}

/** 变换运行时的部分字段（如缺省 canvas / media 的未装配场景） */
const ctxOf = (env: ToolsEnv, patch: Partial<ToolRuntime>): ToolRuntime =>
  ({ ...(env.runtime as object), ...patch }) as unknown as ToolRuntime

let connSeq = 0
/** 建一条启用中的媒体连接（默认 ComfyUI 五能力；M56：全局配置，无需会话绑定） */
function createMediaConnection(env: ToolsEnv, config: Partial<MediaConnectionConfig> = {}) {
  connSeq += 1
  const connection = env.connections.create({
    name: `媒体连接 ${connSeq}`,
    kind: 'media',
    config: { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', capabilities: ALL_CAPS, ...config },
    secret: { apiKey: 'sk-test' },
  })
  return connection
}

/** 注册测试替身适配器（run 由用例提供） */
function registerAdapter(env: ToolsEnv, run?: MediaProviderAdapter['run']): void {
  env.media.register({
    kind: 'comfyui',
    capabilities: ALL_CAPS,
    test: async () => ({ ok: true, detail: 'mock 探活通过' }),
    run: run ?? (async (_job, ctx) => ({ outputs: [ctx.saveOutput(Buffer.from('x'), 'png')] })),
  })
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('测试等待超时：条件未达成')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('M31 工具元数据（画布创作四件套）', () => {
  it('canvas_read 只读；四工具全部 deferred（渐进披露）', () => {
    const env = makeEnv()
    expect(env.tools.get('canvas_read')!.readOnly).toBe(true)
    expect(env.tools.get('canvas_write')!.readOnly).toBeUndefined()
    for (const name of ['canvas_read', 'canvas_write', 'media_generate', 'media_video']) {
      expect(env.tools.get(name)!.tier).toBe('deferred')
    }
  })
})

describe('M31 canvas_read', () => {
  it('未装配画布 → 明确「未启用」提示', async () => {
    const env = makeEnv()
    const tool = env.tools.get('canvas_read')!
    const res = await tool.execute(tool.schema.parse({}), ctxOf(env, { canvas: undefined }))
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('未启用')
  })

  it('空画布 → 摘要「画布为空」并引导 canvas_write / media_generate', async () => {
    const env = makeEnv()
    const res = await runTool(env, 'canvas_read', {})
    expect(res.ok).toBe(true)
    expect(res.summary).toBe('画布为空')
    expect(res.detail).toContain('canvas_write')
    expect(res.detail).toContain('media_generate')
  })

  it('节点与连线摘要：id / 类型 / 坐标 / 内容摘录 + 连线行', async () => {
    const env = makeEnv()
    env.canvas.applyOps(env.sessionId, [
      { op: 'add_node', node: { id: 'nd_p', type: 'prompt', data: { text: '一只猫在窗台晒太阳' } } },
      { op: 'add_node', node: { id: 'nd_i', type: 'image', data: { artifact: 'canvas/media/gen-1.png', prompt: '一只猫' } } },
      { op: 'connect', source: 'nd_p', target: 'nd_i', kind: 'flow' },
    ])
    const res = await runTool(env, 'canvas_read', {})
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('2 个节点 / 1 条连线')
    expect(res.summary).toContain('v')
    expect(res.detail).toContain('- nd_p prompt @(0,0) 「一只猫在窗台晒太阳」')
    expect(res.detail).toContain('nd_i image')
    expect(res.detail).toContain('canvas/media/gen-1.png')
    expect(res.detail).toContain('nd_p → nd_i')
  })

  it('game 节点（M34 博弈推演）：canvas_write 可写入，摘要区分「有结果 / 配置态」', async () => {
    const env = makeEnv()
    const written = await runTool(env, 'canvas_write', {
      ops: [
        {
          op: 'add_node',
          node: { id: 'nd_g1', type: 'game', data: { model: 'matrix', topic: '白酒板块十月走势', symbol: '600519', result: { bands: [] } } },
        },
        { op: 'add_node', node: { id: 'nd_g2', type: 'game', data: { model: 'evolve' } } },
      ],
    })
    expect(written.ok).toBe(true)
    expect(written.detail).toContain('已添加 nd_g1（game）')
    const res = await runTool(env, 'canvas_read', {})
    expect(res.detail).toContain('nd_g1 game')
    expect(res.detail).toContain('matrix 「白酒板块十月走势」 @600519 有结果')
    expect(res.detail).toContain('evolve 配置态')
  })

  it('kline 节点（M34 K 线行情）：canvas_write 可写入，摘要带标的 / 名称 / 周期 / 根数', async () => {
    const env = makeEnv()
    const written = await runTool(env, 'canvas_write', {
      ops: [
        {
          op: 'add_node',
          node: {
            id: 'nd_k1',
            type: 'kline',
            data: {
              symbol: 'sh600519',
              name: '贵州茅台',
              period: 'day',
              adjust: 'qfq',
              bars: [
                { timestamp: 1757952000000, open: 1450, high: 1468, low: 1442, close: 1461, volume: 28300 },
                { timestamp: 1758038400000, open: 1461, high: 1475, low: 1450, close: 1456, volume: 22100 },
              ],
            },
          },
        },
        { op: 'add_node', node: { id: 'nd_k2', type: 'kline', data: {} } },
      ],
    })
    expect(written.ok).toBe(true)
    expect(written.detail).toContain('已添加 nd_k1（kline）')
    const res = await runTool(env, 'canvas_read', {})
    expect(res.detail).toContain('nd_k1 kline')
    expect(res.detail).toContain('sh600519 「贵州茅台」 day 2 根')
    expect(res.detail).toContain('nd_k2 kline')
    expect(res.detail).toContain('空态')
  })

  it('node_id → 单节点 JSON 详情；未知 id → 引导先看清单', async () => {
    const env = makeEnv()
    env.canvas.applyOps(env.sessionId, [{ op: 'add_node', node: { id: 'nd_n', type: 'note', data: { text: '草稿' } } }])
    const found = await runTool(env, 'canvas_read', { node_id: 'nd_n' })
    expect(found.ok).toBe(true)
    expect(found.summary).toContain('nd_n')
    expect(found.summary).toContain('note')
    const parsed = JSON.parse(found.detail!) as { id: string; type: string; data: { text: string } }
    expect(parsed.id).toBe('nd_n')
    expect(parsed.type).toBe('note')
    expect(parsed.data.text).toBe('草稿')

    const missing = await runTool(env, 'canvas_read', { node_id: 'nd_ghost' })
    expect(missing.ok).toBe(false)
    expect(missing.summary).toContain('画布上没有节点 nd_ghost')
    expect(missing.detail).toContain('canvas_read')
  })
})

describe('M31 canvas_write', () => {
  it('未装配画布 → 明确「未启用」提示', async () => {
    const env = makeEnv()
    const tool = env.tools.get('canvas_write')!
    const res = await tool.execute(tool.schema.parse({ ops: [{ op: 'remove_node', id: 'x' }] }), ctxOf(env, { canvas: undefined }))
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('未启用')
  })

  it('add_node 缺省：自动 id + 空画布落原点，生效 id 回灌；写入广播 by=agent', async () => {
    const env = makeEnv()
    const res = await runTool(env, 'canvas_write', { ops: [{ op: 'add_node', node: { type: 'note', data: { text: '计划草稿' } } }] })
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('画布已更新')
    const match = res.detail!.match(/\+ 已添加 (\S+)（note）/)
    expect(match).not.toBeNull()
    const doc = env.canvas.get(env.sessionId)
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0]!.id).toBe(match![1])
    expect(doc.nodes[0]!.position).toEqual({ x: 0, y: 0 })
    expect(res.detail).toContain('画布现有 1 节点 / 0 连线。')
    expect(env.canvasChanges).toEqual([{ sessionId: env.sessionId, version: 2, by: 'agent' }])
  })

  it('连续 add_node 自动排布：第二个落在第一个右缘 +80（显式 width 优先）', async () => {
    const env = makeEnv()
    const res = await runTool(env, 'canvas_write', {
      ops: [
        { op: 'add_node', node: { type: 'image', width: 300, data: { artifact: 'canvas/media/a.png' } } },
        { op: 'add_node', node: { type: 'note', data: { text: '第二' } } },
      ],
    })
    expect(res.ok).toBe(true)
    const doc = env.canvas.get(env.sessionId)
    expect(doc.nodes[1]!.position).toEqual({ x: 380, y: 0 }) // 300 + 80
  })

  it('connect：新建回灌边 id 与语义；重复 / 悬空跳过（不中断整批）', async () => {
    const env = makeEnv()
    const res = await runTool(env, 'canvas_write', {
      ops: [
        { op: 'add_node', node: { id: 'nd_a', type: 'prompt', data: { text: 'p' } } },
        { op: 'add_node', node: { id: 'nd_b', type: 'image', data: {} } },
        { op: 'connect', source: 'nd_a', target: 'nd_b' },
        { op: 'connect', source: 'nd_a', target: 'nd_b' },
        { op: 'connect', source: 'nd_a', target: 'nd_ghost', kind: 'ref' },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.detail).toMatch(/→ 已连线 ed_\S+（nd_a → nd_b，flow）/)
    expect(res.detail!.match(/→ 连线跳过/g)).toHaveLength(2)
    expect(env.canvas.get(env.sessionId).edges).toHaveLength(1)
  })

  it('remove_node 级联删边；update_node 合并 data；remove_edge 按 id', async () => {
    const env = makeEnv()
    env.canvas.applyOps(env.sessionId, [
      { op: 'add_node', node: { id: 'nd_a', type: 'note', data: { text: '甲' } } },
      { op: 'add_node', node: { id: 'nd_b', type: 'note', data: { text: '乙' } } },
      { op: 'connect', source: 'nd_a', target: 'nd_b', kind: 'ref' },
    ])
    const res = await runTool(env, 'canvas_write', {
      ops: [
        { op: 'update_node', id: 'nd_a', data: { text: '甲改' }, position: { x: 50, y: 60 } },
        { op: 'remove_node', id: 'nd_b' },
      ],
    })
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('~ 已更新 nd_a')
    expect(res.detail).toContain('- 已删除 nd_b（相关连线一并移除）')
    const doc = env.canvas.get(env.sessionId)
    expect(doc.nodes).toHaveLength(1)
    expect(doc.nodes[0]!.position).toEqual({ x: 50, y: 60 })
    expect((doc.nodes[0]!.data as { text: string }).text).toBe('甲改')
    expect(doc.edges).toEqual([]) // 级联清理
  })

  it('zod 校验：空 ops / 非法 op / 超量（>50）均拒绝', () => {
    const env = makeEnv()
    const schema = env.tools.get('canvas_write')!.schema
    expect(schema.safeParse({ ops: [] }).success).toBe(false)
    expect(schema.safeParse({ ops: [{ op: 'nope' }] }).success).toBe(false)
    expect(
      schema.safeParse({ ops: Array.from({ length: 51 }, () => ({ op: 'remove_node', id: 'x' })) }).success,
    ).toBe(false)
  })
})

describe('M31 media_generate / media_video', () => {
  it('未装配媒体服务 → 明确「未启用」提示', async () => {
    const env = makeEnv()
    for (const name of ['media_generate', 'media_video']) {
      const tool = env.tools.get(name)!
      const res = await tool.execute(tool.schema.parse({ prompt: 'x' }), ctxOf(env, { media: undefined }))
      expect(res.ok).toBe(false)
      expect(res.summary).toContain('未启用')
    }
  })

  it('未配置媒体连接 → 透传引导（摘要 + detail 指明「设置 → 媒体生成」）', async () => {
    const env = makeEnv()
    const res = await runTool(env, 'media_generate', { prompt: '无人接单' })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('尚未配置媒体生成连接')
    expect(res.detail).toContain('设置 → 媒体生成')
  })

  it('创建即返回：文生图回灌任务 id / 作者标注 / 缺省 canvasTarget 落位', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    const res = await runTool(env, 'media_generate', { prompt: '一只猫在窗台' })
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('已创建文生图任务')
    const jobId = res.summary.match(/任务 (mj_\S+)（/)?.[1]
    expect(jobId).toBeDefined()
    expect(res.detail).toContain('异步长任务')
    expect(res.detail).toContain('自动出现在画布')
    expect(res.detail).toContain('canvas_write') // 本回合不空等的替代工作提示

    const job = env.media.get(jobId!)!
    expect(job.actor).toBe('pm')
    expect(job.capability).toBe('text2image')
    expect(job.canvasTarget).toEqual({ x: 0, y: 0 }) // 空画布 → 原点
    await until(() => env.media.get(jobId!)!.status === 'succeeded')
    expect(env.media.get(jobId!)!.canvasTarget).toEqual({ x: 0, y: 0 }) // 完成后保留，供前端自动落位
  })

  it('canvasTarget 跟随现有内容（右缘 +80）；place_on_canvas=false 关闭放置', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    env.canvas.applyOps(env.sessionId, [{ op: 'add_node', node: { id: 'nd_w', type: 'image', width: 300, data: {} } }])

    const placed = await runTool(env, 'media_generate', { prompt: '右移' })
    const placedJob = env.media.get(placed.summary.match(/任务 (mj_\S+)（/)![1]!)!
    expect(placedJob.canvasTarget).toEqual({ x: 380, y: 0 })

    const off = await runTool(env, 'media_generate', { prompt: '仅落交付件', place_on_canvas: false })
    expect(off.ok).toBe(true)
    expect(off.detail).not.toContain('自动出现在画布')
    const offJob = env.media.get(off.summary.match(/任务 (mj_\S+)（/)![1]!)!
    expect(offJob.canvasTarget).toBeUndefined()
  })

  it('服务端未装配画布：任务照常创建但放弃放置', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    const tool = env.tools.get('media_generate')!
    const res = await tool.execute(tool.schema.parse({ prompt: '无画布' }), ctxOf(env, { canvas: undefined }))
    expect(res.ok).toBe(true)
    expect(res.detail).not.toContain('自动出现在画布')
    const job = env.media.list(env.sessionId)[0]!
    expect(job.canvasTarget).toBeUndefined()
  })

  it('media_video：首尾帧不齐 / 连接未声明能力 → 透传错误文案', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    const half = await runTool(env, 'media_video', {
      capability: 'firstlast2video',
      prompt: '补间',
      first_frame: 'canvas/first.png',
    })
    expect(half.ok).toBe(false)
    expect(half.summary).toContain('firstFrame 与 lastFrame')

    const env2 = makeEnv()
    createMediaConnection(env2, { capabilities: ['text2image'] })
    registerAdapter(env2)
    const denied = await runTool(env2, 'media_video', { prompt: 'x' })
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('文生视频')
  })

  it('media_video 成功：文生视频回灌 + duration 进 params（schema 默认 capability）', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    const res = await runTool(env, 'media_video', { prompt: '镜头推进', duration: 5 })
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('已创建文生视频任务')
    const job = env.media.list(env.sessionId)[0]!
    expect(job.capability).toBe('text2video')
    expect(job.params.duration).toBe(5)
  })

  it('image2image 输入图透传（存在性校验由 MediaService 把关）', async () => {
    const env = makeEnv()
    createMediaConnection(env)
    registerAdapter(env)
    const res = await runTool(env, 'media_generate', {
      capability: 'image2image',
      prompt: '换风格',
      images: ['canvas/not-there.png'],
    })
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('输入素材不存在或越界')
  })
})
