/**
 * M31 单测：媒体生成服务（MediaService）与适配器共享工具。
 *
 * 守护六件事：
 * - 状态机与产物：queued → running → succeeded；产物落盘 workspace/<sid>/canvas/media/gen-* 且广播齐全；
 * - 队列 / 并发：并发上限内先到先跑，超限排队（progressText '排队中'），空出槽位自动泵出；
 * - 取消 / 超时：queued 立即取消、running 由执行侧收敛；超时收敛为 failed（非 canceled）且文案带时限；
 * - 失败与重试：adapter 异常 → failed（错误透传）；retry 以原参数重建新任务；
 * - 入场校验：未配置 / 未声明能力 / 缺输入图 / 缺首尾帧 / 空 prompt / 输入越界——全部给出引导文案；
 * - 纯函数工具：deepReplaceVars（整值保类型 / 内联替换 / 未命中保留）与 getPath（点路径 + [n] 下标）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MediaCapability, MediaConnectionConfig, MediaJob } from '@multi-agent/shared'
import { SecretVault } from '../src/connections/crypto.js'
import { deepReplaceVars, getPath, sleep } from '../src/media/adapters/http.js'
import { MediaService } from '../src/media/service.js'
import type { MediaProviderAdapter } from '../src/media/types.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { SessionStore } from '../src/store/sessions.js'
import type { NotifyHub } from '../src/ws.js'
import { makeTmpDir, type PublishedNotification } from './helpers.js'

const ALL_CAPS: MediaCapability[] = ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video']

interface MediaEnv {
  dir: string
  /** 真实会话 id（任务 / 产物按会话落盘；M56：媒体连接本身全局，无需会话绑定） */
  sessionId: string
  connections: ConnectionStore
  artifacts: ArtifactStore
  service: MediaService
  published: PublishedNotification[]
}

/** 每个用例独立 SQLite + Vault + workspace（互不污染）；notify 假体做深拷贝快照（job 引用会被原地更新） */
function makeMediaEnv(opts: { concurrency?: number } = {}): MediaEnv {
  const dir = makeTmpDir('ma-m31-media-')
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const sessions = new SessionStore(db)
  const session = sessions.create([], 'M31 媒体测试')
  const artifacts = new ArtifactStore(path.join(dir, 'workspace'))
  const published: PublishedNotification[] = []
  const notify = {
    publish: (input: PublishedNotification) => {
      published.push(structuredClone(input))
      return input
    },
  } as unknown as NotifyHub
  const service = new MediaService({ connections, artifacts, notify, concurrency: opts.concurrency })
  return { dir, sessionId: session.id, connections, artifacts, service, published }
}

let connSeq = 0
/** 建一条启用中的媒体连接（默认 ComfyUI 五能力；config 可覆写；M56：全局配置，无需会话绑定） */
function createMediaConnection(env: MediaEnv, config: Partial<MediaConnectionConfig> = {}) {
  connSeq += 1
  const connection = env.connections.create({
    name: `媒体连接 ${connSeq}`,
    kind: 'media',
    config: {
      provider: 'comfyui',
      baseUrl: 'http://127.0.0.1:8188',
      capabilities: ALL_CAPS,
      ...config,
    },
    secret: { apiKey: 'sk-test' },
  })
  return connection
}

/** 测试替身适配器：run 由用例提供；test 默认通过 */
function mockAdapter(run: MediaProviderAdapter['run']): MediaProviderAdapter {
  return {
    kind: 'comfyui',
    capabilities: ALL_CAPS,
    test: async () => ({ ok: true, detail: 'mock 探活通过' }),
    run,
  }
}

/** adapter 侧的可中断长等待（模拟远端长任务：只有 abort / 超时才会结束；永不产出） */
async function waitForever(ctx: { signal: AbortSignal }): Promise<never> {
  await sleep(600_000, ctx.signal)
  throw new Error('不可达：长等待不应正常返回') // abort 时 sleep 已 reject
}

async function until(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('测试等待超时：条件未达成')
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 取出操作成功结果（失败时立即抛断言错误携带文案） */
function jobOf(result: { job: MediaJob } | { error: string }): MediaJob {
  if ('error' in result) throw new Error(`意外失败：${result.error}`)
  return result.job
}

/** 提取失败文案（成功时立即抛断言错误；create / cancel / retry 返回共用） */
function errorOf(result: { job: MediaJob } | { error: string }): string {
  if (!('error' in result)) throw new Error('预期操作失败，但返回了任务')
  return result.error
}

const jobBroadcasts = (env: MediaEnv): MediaJob[] =>
  env.published.filter((p) => p.type === 'notify:media-job').map((p) => p.payload.job as MediaJob)

describe('M31 媒体服务：状态机与产物落盘', () => {
  it('happy path：create → running → succeeded；产物落盘、进度节流广播、artifact-updated 齐全', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env, { defaultModel: 'flux' })
    env.service.register(
      mockAdapter(async (job, ctx) => {
        ctx.report(50, '采样 10/20')
        const rel = ctx.saveOutput(Buffer.from(`图-${job.prompt}`, 'utf8'), 'png')
        return { outputs: [rel] }
      }),
    )

    const job = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '一只猫' }))
    // create 同步执行到 adapter 首个 await：返回时已 running（广播序列首条仍是 queued）
    expect(job.status).toBe('running')
    expect(job.model).toBe('flux') // 缺省回填连接 defaultModel
    expect(job.connectionName).toBeDefined()

    await until(() => env.service.get(job.id)!.status === 'succeeded')
    const done = env.service.get(job.id)!
    expect(done.outputs).toHaveLength(1)
    expect(done.outputs[0]).toMatch(/^canvas\/media\/gen-.*\.png$/)
    expect(done.progress).toBe(100)
    expect(done.finishedAt).toBeDefined()

    // 磁盘为真相：产物内容可读
    const abs = path.join(env.dir, 'workspace', env.sessionId, done.outputs[0]!)
    expect(fs.readFileSync(abs, 'utf8')).toBe('图-一只猫')

    const statuses = jobBroadcasts(env).map((j) => j.status)
    expect(statuses[0]).toBe('queued')
    expect(statuses).toContain('running')
    expect(statuses.at(-1)).toBe('succeeded')
    const artifactNote = env.published.find((p) => p.type === 'notify:artifact-updated')
    expect(artifactNote?.payload.path).toBe(done.outputs[0])
    expect(artifactNote?.payload.authorAgentId).toBeUndefined() // user 创建不标作者
  })

  it('显式 model 优先于连接 defaultModel；agent 创建标注作者', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env, { defaultModel: 'flux' })
    env.service.register(mockAdapter(async (job, ctx) => ({ outputs: [ctx.saveOutput(Buffer.from('x'), 'png')] })))

    const job = jobOf(
      env.service.create(env.sessionId, 'researcher', { capability: 'text2image', prompt: '调查图', model: 'sdxl' }),
    )
    expect(job.model).toBe('sdxl')
    await until(() => env.service.get(job.id)!.status === 'succeeded')
    const rel = env.service.get(job.id)!.outputs[0]!
    expect(env.artifacts.authorOf(env.sessionId, rel)).toBe('researcher')
    const note = env.published.find((p) => p.type === 'notify:artifact-updated')
    expect(note?.payload.authorAgentId).toBe('researcher')
  })

  it('空产物 → failed（文案含「没有产物」）', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async () => ({ outputs: [] })))
    const job = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '空' }))
    await until(() => env.service.get(job.id)!.status === 'failed')
    expect(env.service.get(job.id)!.error).toContain('没有产物')
    expect(env.service.get(job.id)!.progressText).toBe('失败')
  })

  it('list：按会话隔离且新任务在前', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async (job, ctx) => ({ outputs: [ctx.saveOutput(Buffer.from('1'), 'png')] })))
    const first = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '1' }))
    await until(() => env.service.get(first.id)!.status === 'succeeded')
    const second = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '2' }))
    await until(() => env.service.get(second.id)!.status === 'succeeded')
    const list = env.service.list(env.sessionId)
    expect(list.map((j) => j.prompt)).toEqual(['2', '1'])
    expect(env.service.list('sess_other')).toEqual([])
  })
})

describe('M31 媒体服务：队列与并发', () => {
  it('concurrency=1：第二个任务排队（progressText 排队中），前一个结束自动泵出', async () => {
    const env = makeMediaEnv({ concurrency: 1 })
    createMediaConnection(env)
    const gates = new Map<string, () => void>()
    env.service.register(
      mockAdapter(async (job, ctx) => {
        await new Promise<void>((resolve) => gates.set(job.id, resolve))
        return { outputs: [ctx.saveOutput(Buffer.from(job.id, 'utf8'), 'png')] }
      }),
    )
    const jobA = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: 'A' }))
    const jobB = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: 'B' }))
    expect(jobA.status).toBe('running')
    expect(jobB.status).toBe('queued')
    expect(jobB.progressText).toBe('排队中')
    expect(jobB.startedAt).toBeUndefined()
    expect(gates.has(jobA.id)).toBe(true)
    expect(gates.has(jobB.id)).toBe(false) // 未占用槽位

    gates.get(jobA.id)!()
    await until(() => env.service.get(jobB.id)!.status === 'running')
    gates.get(jobB.id)!()
    await until(() => env.service.get(jobB.id)!.status === 'succeeded')
    expect(env.service.get(jobA.id)!.status).toBe('succeeded')
  })

  it('concurrency=2：两个任务并行执行', async () => {
    const env = makeMediaEnv({ concurrency: 2 })
    createMediaConnection(env)
    const gates = new Map<string, () => void>()
    env.service.register(
      mockAdapter(async (job, ctx) => {
        await new Promise<void>((resolve) => gates.set(job.id, resolve))
        return { outputs: [ctx.saveOutput(Buffer.from('ok'), 'png')] }
      }),
    )
    const jobA = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: 'A' }))
    const jobB = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: 'B' }))
    expect(jobA.status).toBe('running')
    expect(jobB.status).toBe('running')
    gates.get(jobA.id)!()
    gates.get(jobB.id)!()
    await until(() => env.service.get(jobA.id)!.status === 'succeeded' && env.service.get(jobB.id)!.status === 'succeeded')
  })
})

describe('M31 媒体服务：取消与超时', () => {
  it('queued 任务：cancel 立即收敛为 canceled 且不再执行', async () => {
    const env = makeMediaEnv({ concurrency: 1 })
    createMediaConnection(env)
    env.service.register(mockAdapter(async (job, ctx) => waitForever(ctx)))
    const jobA = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '占位' }))
    const jobB = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '排队中要取消' }))
    expect(jobB.status).toBe('queued')

    const canceled = env.service.cancel(jobB.id)
    expect(jobOf(canceled).status).toBe('canceled')
    expect(env.service.get(jobB.id)!.error).toBe('已取消')

    env.service.cancel(jobA.id) // 放空槽位，确认队列不会把 canceled 的任务再泵出
    await until(() => env.service.get(jobA.id)!.status === 'canceled')
    expect(env.service.get(jobB.id)!.startedAt).toBeUndefined()
    expect(jobBroadcasts(env).filter((j) => j.id === jobB.id).at(-1)!.status).toBe('canceled')
  })

  it('running 任务：cancel 触发 abort，执行侧收敛为 canceled', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async (job, ctx) => waitForever(ctx)))
    const job = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2video', prompt: '长视频' }))
    expect(job.status).toBe('running')

    env.service.cancel(job.id)
    await until(() => env.service.get(job.id)!.status === 'canceled')
    expect(env.service.get(job.id)!.error).toBe('已取消')
    expect(env.service.get(job.id)!.progressText).toBe('已取消')
  })

  it('终态任务：cancel 返回明确错误（含「无法取消」）；未知任务报「任务不存在」', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async (job, ctx) => ({ outputs: [ctx.saveOutput(Buffer.from('ok'), 'png')] })))
    const job = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '快任务' }))
    await until(() => env.service.get(job.id)!.status === 'succeeded')

    const denied = env.service.cancel(job.id)
    expect(errorOf(denied)).toContain('无法取消')
    const missing = env.service.cancel('mj_ghost')
    expect(errorOf(missing)).toBe('任务不存在')
  })

  it('超时（连接 timeoutMs 覆盖）：收敛为 failed 而非 canceled，文案带时限', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env, { timeoutMs: 60 })
    env.service.register(mockAdapter(async (job, ctx) => waitForever(ctx)))
    const job = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '慢慢来' }))
    await until(() => env.service.get(job.id)!.status === 'failed')
    const done = env.service.get(job.id)!
    expect(done.error).toContain('生成超时')
    expect(done.error).toContain('60ms')
    expect(done.progressText).toBe('失败')
  })
})

describe('M31 媒体服务：失败与重试', () => {
  it('adapter 异常 → failed（错误透传）；retry 以原参数重建新任务并成功', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    let attempt = 0
    env.service.register(
      mockAdapter(async (job, ctx) => {
        attempt += 1
        if (attempt === 1) throw new Error('远端 500：Internal Server Error')
        return { outputs: [ctx.saveOutput(Buffer.from('重试成功', 'utf8'), 'png')] }
      }),
    )
    const first = jobOf(env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '会失败一次' }))
    await until(() => env.service.get(first.id)!.status === 'failed')
    expect(env.service.get(first.id)!.error).toBe('远端 500：Internal Server Error')

    const retried = env.service.retry(first.id)
    if ('error' in retried) throw new Error(retried.error)
    expect(retried.job.id).not.toBe(first.id)
    expect(retried.job.prompt).toBe('会失败一次')
    expect(retried.job.capability).toBe('text2image')
    await until(() => env.service.get(retried.job.id)!.status === 'succeeded')
    expect(env.service.get(retried.job.id)!.outputs[0]).toMatch(/^canvas\/media\/gen-/)

    const missing = env.service.retry('mj_ghost')
    expect(errorOf(missing)).toBe('任务不存在')
  })
})

describe('M31 媒体服务：入场校验（最小权限与引导文案）', () => {
  it('未配置媒体连接 → 引导去「设置 → 媒体生成」创建并启用', () => {
    const env = makeMediaEnv()
    env.service.register(mockAdapter(async () => ({ outputs: [] })))
    const result = env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '无人接单' })
    const message = errorOf(result)
    expect(message).toContain('尚未配置媒体生成连接')
    expect(message).toContain('设置 → 媒体生成')
  })

  it('连接未声明能力 → 明确拒绝（含能力中文名）', () => {
    const env = makeMediaEnv()
    createMediaConnection(env, { capabilities: ['text2image'] })
    env.service.register(mockAdapter(async () => ({ outputs: [] })))
    const result = env.service.create(env.sessionId, 'user', { capability: 'text2video', prompt: 'x' })
    expect(errorOf(result)).toContain('文生视频')
  })

  it('指定不存在 / 未启用的 connectionId → 拒绝', () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async () => ({ outputs: [] })))
    const result = env.service.create(env.sessionId, 'user', {
      capability: 'text2image',
      prompt: 'x',
      connectionId: 'conn_ghost',
    })
    expect(errorOf(result)).toContain('指定的媒体连接不存在或未启用')
  })

  it('缺少输入图片 / 首尾帧不齐 / 空 prompt → 对应文案', () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async () => ({ outputs: [] })))
    const noImage = env.service.create(env.sessionId, 'user', { capability: 'image2image', prompt: 'x' })
    expect(errorOf(noImage)).toContain('需要输入图片')
    const halfFrame = env.service.create(env.sessionId, 'user', {
      capability: 'firstlast2video',
      prompt: 'x',
      inputs: { firstFrame: 'canvas/a.png' },
    })
    expect(errorOf(halfFrame)).toContain('firstFrame 与 lastFrame')
    const blankPrompt = env.service.create(env.sessionId, 'user', { capability: 'text2image', prompt: '   ' })
    expect(errorOf(blankPrompt)).toContain('缺少提示词')
  })

  it('输入素材：越界路径拒绝；真实存在的工作区文件放行', async () => {
    const env = makeMediaEnv()
    createMediaConnection(env)
    env.service.register(mockAdapter(async (job, ctx) => ({ outputs: [ctx.saveOutput(Buffer.from('ok'), 'png')] })))
    env.artifacts.ensureSessionDir(env.sessionId)

    const escape = env.service.create(env.sessionId, 'user', {
      capability: 'image2image',
      prompt: 'x',
      inputs: { images: ['../outside.png'] },
    })
    expect(errorOf(escape)).toContain('输入素材不存在或越界')

    const missing = env.service.create(env.sessionId, 'user', {
      capability: 'image2image',
      prompt: 'x',
      inputs: { images: ['canvas/not-there.png'] },
    })
    expect(errorOf(missing)).toContain('输入素材不存在或越界')

    const dir = path.join(env.artifacts.sessionDir(env.sessionId), 'canvas')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'up-in.png'), Buffer.from('输入图'))
    const ok = env.service.create(env.sessionId, 'user', {
      capability: 'image2image',
      prompt: '改个风格',
      inputs: { images: ['canvas/up-in.png'] },
    })
    const job = jobOf(ok)
    expect(job.inputs.images).toEqual(['canvas/up-in.png'])
    await until(() => env.service.get(job.id)!.status === 'succeeded')
  })
})

describe('M31 媒体服务：providersOf 投影与连接测试', () => {
  it('providersOf：启用 + 已有适配器才出现；capabilities / models / workflows 投影裁剪（M56：全局，无会话维度）', () => {
    const env = makeMediaEnv()
    const connection = createMediaConnection(env, {
      models: ['flux', 'sdxl'],
      defaultModel: 'flux',
      workflows: [{ id: 'w1', name: '高清出图', capability: 'text2image', json: { 1: {} } }],
    })
    env.service.register(mockAdapter(async () => ({ outputs: [] })))

    // 未注册适配器的 provider / 未启用 → 均被过滤（M56：媒体连接全局，不再有「未绑定」维度）
    env.connections.create({
      name: 'SD WebUI',
      kind: 'media',
      config: { provider: 'sdwebui', baseUrl: 'http://127.0.0.1:7860', capabilities: ['text2image'] },
    })
    env.connections.create({
      name: '停用的 ComfyUI',
      kind: 'media',
      config: { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8189', capabilities: ALL_CAPS },
      enabled: false,
    })

    const list = env.service.providersOf()
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual({
      connectionId: connection.id,
      connectionName: connection.name,
      provider: 'comfyui',
      capabilities: ALL_CAPS,
      models: ['flux', 'sdxl'],
      defaultModel: 'flux',
      workflows: [{ id: 'w1', name: '高清出图', capability: 'text2image' }],
    })

    // M56 全局可见性：新启用连接无需任何会话绑定即进入清单；停用即消失
    const second = env.connections.create({
      name: '第二个 ComfyUI',
      kind: 'media',
      config: { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8191', capabilities: ['text2image'] },
    })
    expect(env.service.providersOf().map((p) => p.connectionId)).toContain(second.id)
    env.connections.update(second.id, { enabled: false })
    expect(env.service.providersOf().map((p) => p.connectionId)).not.toContain(second.id)
  })

  it('test()：透传适配器探活结果并附 latencyMs；配置不完整 / 无适配器 / 抛异常均有明确文案', async () => {
    const env = makeMediaEnv()
    const connection = createMediaConnection(env)
    env.service.register({
      ...mockAdapter(async () => ({ outputs: [] })),
      test: async (ctx) => ({ ok: true, detail: `探活 ${ctx.config.baseUrl}` }),
    })
    const ok = await env.service.test(env.connections.get(connection.id)!)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('http://127.0.0.1:8188')
    expect(typeof ok.latencyMs).toBe('number')

    const broken = env.connections.create({ name: '缺 baseUrl', kind: 'media', config: { provider: 'comfyui' } })
    const brokenResult = await env.service.test(env.connections.get(broken.id)!)
    expect(brokenResult.ok).toBe(false)
    expect(brokenResult.error).toContain('配置不完整')

    const noAdapter = env.connections.create({
      name: '无适配器',
      kind: 'media',
      config: { provider: 'openai', baseUrl: 'https://api.example.com/v1', capabilities: ['text2image'] },
    })
    const noAdapterResult = await env.service.test(env.connections.get(noAdapter.id)!)
    expect(noAdapterResult.ok).toBe(false)
    expect(noAdapterResult.error).toContain('暂无 openai 适配器')

    // 适配器自身抛错 → 收敛为 ok:false 而非异常外抛
    env.service.register({
      ...mockAdapter(async () => ({ outputs: [] })),
      test: async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:8188')
      },
    })
    const thrown = await env.service.test(env.connections.get(connection.id)!)
    expect(thrown.ok).toBe(false)
    expect(thrown.error).toContain('ECONNREFUSED')
    expect(typeof thrown.latencyMs).toBe('number')
  })
})

describe('M31 适配器共享工具：deepReplaceVars 与 getPath', () => {
  it('deepReplaceVars：整值占位符保留原类型；内联替换；未命中保留原文；数组 / 对象递归', () => {
    const vars = { seed: 42, model: 'flux', prompt: '一只猫', negative: '', first_frame: 'a.png' }
    const out = deepReplaceVars(
      {
        seed: '{{seed}}',
        text: '用 {{model}} 画：{{prompt}}',
        nested: { list: ['x-{{prompt}}-y', '{{seed}}', '{{missing}}'] },
        keep: '{{missing}}',
        video: { image: '{{first_frame}}' },
      },
      vars,
    )
    expect(out.seed).toBe(42) // 整值：number 而非 '42'
    expect(out.text).toBe('用 flux 画：一只猫')
    expect(out.nested.list[0]).toBe('x-一只猫-y')
    expect(out.nested.list[1]).toBe(42)
    expect(out.nested.list[2]).toBe('{{missing}}') // 未命中保留，便于排查
    expect(out.keep).toBe('{{missing}}')
    expect(out.video.image).toBe('a.png')
    // 原始对象不被改动（纯函数）
    expect(deepReplaceVars('{{prompt}}', vars)).toBe('一只猫')
  })

  it('getPath：点路径 / [n] 下标 / 缺失与空路径返回 undefined', () => {
    const source = { data: { status: 'done', output: [{ url: 'u1' }, { url: 'u2' }] }, n: 7 }
    expect(getPath(source, 'data.status')).toBe('done')
    expect(getPath(source, 'data.output[0].url')).toBe('u1')
    expect(getPath(source, 'data.output[1].url')).toBe('u2')
    expect(getPath(source, 'n')).toBe(7)
    expect(getPath(source, 'data.output[0].url[1]')).toBeUndefined() // 对字符串取下标 → undefined
    expect(getPath(source, 'data.missing')).toBeUndefined()
    expect(getPath(source, '')).toBeUndefined()
    expect(getPath(undefined, 'a.b')).toBeUndefined()
  })
})
