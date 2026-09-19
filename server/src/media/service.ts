/**
 * M31：媒体生成服务 —— 适配器注册表 + 任务管线（队列 / 并发 / 取消 / 超时 / 广播 / 产物落盘）。
 *
 * 职责边界：
 * - 任务生命周期：queued → running → succeeded / failed / canceled；每任务一个 AbortController；
 * - 入场校验：连接启用 + 适配器注册 + 能力匹配（最小权限：未配置不可用，错误文案引导去「设置 → 媒体生成」）；
 * - 产物落盘：workspace/<sid>/canvas/media/gen-*.<ext>（成为普通交付件，广播 artifact:updated）；
 * - 实时通道：notify:media-job（创建 / 状态 / 进度节流 / 终态；前端 media-store 消费）；
 * - 历史保留：内存 Map（最近 200 条，按会话），重启即清（产物文件为持久真相）。
 * - 适配器只做「提交 → 轮询 → 取件」，队列与广播全部在本层收口。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  CanvasImageData,
  CanvasNode,
  CanvasNodeData,
  CanvasOp,
  CanvasVideoData,
  ConnectionDefinition,
  MediaCapability,
  MediaConnectionConfig,
  MediaJob,
  MediaJobInput,
  MediaProviderInfo,
} from '@multi-agent/shared'
import type { CanvasStore } from '../canvas/store.js'
import type { ArtifactStore } from '../store/artifacts.js'
import type { ConnectionStore } from '../store/connections.js'
import type { NotifyHub } from '../ws.js'
import type { MediaJobContext, MediaProviderAdapter } from './types.js'
import { MEDIA_CAPABILITY_LABEL, outputExtFor } from './types.js'

/** 每会话保留的任务条数（内存历史；更早的从交付件浏览） */
const HISTORY_PER_SESSION = 50
/** 进度广播最小间隔（高频 report 节流；终态不受限） */
const PROGRESS_THROTTLE_MS = 700
/** 默认并发（本地 ComfyUI / 云端 API 双路均衡） */
const DEFAULT_CONCURRENCY = 2
/** 图像 / 视频默认超时（连接 config.timeoutMs 可覆盖） */
const IMAGE_TIMEOUT_MS = 5 * 60_000
const VIDEO_TIMEOUT_MS = 10 * 60_000
/** 画布占位节点尺寸（M31 修订：与前端 NODE_SIZE 对齐；多产物横向排开间距 +24） */
const OUT_NODE_SIZE = { image: { width: 280, height: 200 }, video: { width: 320, height: 212 } } as const
const OUT_GAP = 24

export interface MediaServiceOptions {
  connections: ConnectionStore
  artifacts: ArtifactStore
  notify: NotifyHub
  /** 并发上限（测试可调） */
  concurrency?: number
  /** M31 修订：画布存储（任务创建落占位 / 终态结算；未装配时全部落位静默降级） */
  canvas?: CanvasStore
}

export class MediaService {
  private readonly adapters = new Map<MediaConnectionConfig['provider'], MediaProviderAdapter>()
  private readonly jobs = new Map<string, MediaJob>()
  private readonly absByJob = new Map<string, AbortController>()
  private queue: string[] = []
  private running = 0
  private readonly concurrency: number

  constructor(private readonly opts: MediaServiceOptions) {
    this.concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY)
  }

  /** 注册适配器（index.ts 装配：comfyui / sdwebui / openai / template） */
  register(adapter: MediaProviderAdapter): void {
    this.adapters.set(adapter.kind, adapter)
  }

  adapterOf(provider: string): MediaProviderAdapter | undefined {
    return this.adapters.get(provider as MediaConnectionConfig['provider'])
  }

  // ---------- 查询 ----------

  list(sessionId: string): MediaJob[] {
    return [...this.jobs.values()]
      .filter((job) => job.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  get(jobId: string): MediaJob | undefined {
    return this.jobs.get(jobId)
  }

  /** 启用中的可用媒体连接（能力 / 模型 / 工作流模板；全局，不区分会话；生成面板与工具共用） */
  providersOf(): MediaProviderInfo[] {
    const out: MediaProviderInfo[] = []
    for (const connection of this.opts.connections.list()) {
      if (connection.kind !== 'media' || !connection.enabled) continue
      const config = normalizeMediaConfig(connection.config)
      if (!config || !this.adapters.has(config.provider)) continue
      out.push({
        connectionId: connection.id,
        connectionName: connection.name,
        provider: config.provider,
        capabilities: config.capabilities,
        models: config.models ?? [],
        defaultModel: config.defaultModel,
        workflows: (config.workflows ?? []).map((w) => ({ id: w.id, name: w.name, capability: w.capability })),
      })
    }
    return out
  }

  /** 解析任务的生效连接（全局启用 + 适配器 + 能力校验；错误文案已本地化） */
  private resolveConnection(
    connectionId: string | undefined,
    capability: MediaCapability,
  ): { connection: ConnectionDefinition; config: MediaConnectionConfig; adapter: MediaProviderAdapter } | { error: string } {
    const available = this.opts.connections.list().filter((c) => c.kind === 'media' && c.enabled)
    if (available.length === 0) {
      return { error: '尚未配置媒体生成连接：请到「设置 → 媒体生成」创建并启用连接' }
    }
    const connection = connectionId ? available.find((c) => c.id === connectionId) : available[0]
    if (!connection) return { error: '指定的媒体连接不存在或未启用' }
    const config = normalizeMediaConfig(connection.config)
    if (!config) return { error: `媒体连接「${connection.name}」配置不完整（provider / baseUrl 必填）` }
    const adapter = this.adapters.get(config.provider)
    if (!adapter) return { error: `媒体连接「${connection.name}」的提供方 ${config.provider} 暂无适配器` }
    if (!config.capabilities.includes(capability)) {
      return {
        error: `媒体连接「${connection.name}」未声明能力「${MEDIA_CAPABILITY_LABEL[capability]}」：请在连接配置中勾选`,
      }
    }
    return { connection, config, adapter }
  }

  // ---------- 任务创建 / 取消 / 重试 ----------

  /** 创建任务（路由 / 工具共用入口）；返回任务或错误文案 */
  create(sessionId: string, actor: string, input: MediaJobInput): { job: MediaJob } | { error: string } {
    const resolved = this.resolveConnection(input.connectionId, input.capability)
    if ('error' in resolved) return resolved
    if (!input.prompt?.trim()) return { error: '缺少提示词（prompt 必填）' }
    const inputs = input.inputs ?? {}
    const needsImage = input.capability === 'image2image' || input.capability === 'image2video'
    const needsFirstLast = input.capability === 'firstlast2video'
    if (needsImage && !(inputs.images?.length ?? 0)) {
      return { error: `能力「${MEDIA_CAPABILITY_LABEL[input.capability]}」需要输入图片（inputs.images）` }
    }
    if (needsFirstLast && (!inputs.firstFrame || !inputs.lastFrame)) {
      return { error: '首尾帧视频需要同时提供 firstFrame 与 lastFrame' }
    }
    for (const rel of [...(inputs.images ?? []), inputs.firstFrame, inputs.lastFrame].filter(Boolean) as string[]) {
      try {
        // resolveSafe 只防越界不查存在性：素材必须真实落盘（早失败早引导，避免任务排队后才炸）
        if (!fs.existsSync(this.opts.artifacts.resolveSafe(sessionId, rel))) throw new Error('输入素材不存在')
      } catch {
        return { error: `输入素材不存在或越界：${rel}` }
      }
    }
    const now = new Date().toISOString()
    const job: MediaJob = {
      id: `mj_${randomUUID().slice(0, 8)}`,
      sessionId,
      actor,
      capability: input.capability,
      connectionId: resolved.connection.id,
      connectionName: resolved.connection.name,
      model: input.model ?? resolved.config.defaultModel,
      prompt: input.prompt.trim(),
      negative: input.negative,
      inputs,
      params: input.params ?? {},
      status: 'queued',
      progressText: '排队中',
      outputs: [],
      canvasTarget: input.canvasTarget,
      createdAt: now,
    }
    this.jobs.set(job.id, job)
    // M31 修订：创建即落占位（服务端为真相——用户不必开着画布；完成原地替换 / 失败保留 / 取消移除）
    this.placePlaceholder(job, input)
    this.queue.push(job.id)
    this.trimHistory(sessionId)
    this.publish(job)
    this.pump()
    return { job }
  }

  // ---------- M31 修订：画布全周期落位（占位 → 结算） ----------

  /** 输出节点 data 构造（占位 / 产物共用；谱系字段与前端旧落位口径一致） */
  private outputNodeData(job: MediaJob, artifact?: string): CanvasImageData | CanvasVideoData {
    const base = {
      source: 'generate' as const,
      jobId: job.id,
      prompt: job.prompt,
      params: {
        capability: job.capability,
        model: job.model,
        negative: job.negative,
        width: job.params.width,
        height: job.params.height,
        steps: job.params.steps,
        seed: job.params.seed,
        duration: job.params.duration,
        workflowId: job.params.workflowId,
      },
    }
    if (artifact) return { ...base, artifact, pending: false }
    return { ...base, pending: true }
  }

  /** 画布写入的 by（用户自建任务不记作者；agent 任务记其 id） */
  private byOf(job: MediaJob): string | undefined {
    return job.actor === 'user' ? undefined : job.actor
  }

  /** 创建任务时落占位节点（无画布存储 / place_on_canvas=false 时跳过；placedCanvas 记录落位结果） */
  private placePlaceholder(job: MediaJob, input: MediaJobInput): void {
    const canvas = this.opts.canvas
    if (!canvas || input.placeOnCanvas === false) return
    const kind = job.capability.endsWith('image') ? 'image' : 'video'
    const size = OUT_NODE_SIZE[kind]
    const data = this.outputNodeData(job)
    if (kind === 'video') {
      ;(data as CanvasVideoData).firstFrame = job.inputs.firstFrame
      ;(data as CanvasVideoData).lastFrame = job.inputs.lastFrame
    }
    try {
      const { applied } = canvas.applyOps(
        job.sessionId,
        [
          {
            op: 'add_node',
            node: {
              type: kind,
              position: job.canvasTarget,
              width: size.width,
              height: size.height,
              data: data as CanvasNodeData,
            },
          },
        ],
        { by: this.byOf(job), reason: 'media' },
      )
      job.canvasNodeId = applied[0]?.id
      job.placedCanvas = Boolean(job.canvasNodeId)
    } catch {
      job.placedCanvas = false
    }
  }

  /** 终态结算：成功原地替换（多产物排开）/ 失败保留带 error / 取消移除（仅状态首次转终态时调用） */
  private settleJob(job: MediaJob): void {
    const canvas = this.opts.canvas
    const nodeId = job.canvasNodeId
    if (!canvas || !nodeId || !job.placedCanvas) return
    const opts = { by: this.byOf(job), reason: 'media' as const }
    try {
      if (job.status === 'succeeded' && job.outputs.length > 0) {
        const ops: CanvasOp[] = [
          {
            op: 'update_node',
            id: nodeId,
            data: { artifact: job.outputs[0], pending: false } as Partial<CanvasNodeData>,
          },
        ]
        // 附加产物排开（基准 = 占位节点当前位置；尺寸与创建口径一致）
        if (job.outputs.length > 1) {
          const kind = job.capability.endsWith('image') ? 'image' : 'video'
          const size = OUT_NODE_SIZE[kind]
          const base = canvas.get(job.sessionId).nodes.find((n) => n.id === nodeId)
          if (base) {
            for (let i = 1; i < job.outputs.length; i += 1) {
              const data = this.outputNodeData(job, job.outputs[i])
              if (kind === 'video') {
                ;(data as CanvasVideoData).firstFrame = job.inputs.firstFrame
                ;(data as CanvasVideoData).lastFrame = job.inputs.lastFrame
              }
              ops.push({
                op: 'add_node',
                node: {
                  type: kind,
                  position: { x: Math.round(base.position.x + i * (size.width + OUT_GAP)), y: Math.round(base.position.y) },
                  width: size.width,
                  height: size.height,
                  data: data as CanvasNodeData,
                },
              })
            }
          }
        }
        canvas.applyOps(job.sessionId, ops, opts)
      } else if (job.status === 'failed') {
        canvas.applyOps(
          job.sessionId,
          [{ op: 'update_node', id: nodeId, data: { pending: false, error: job.error ?? '生成失败' } as Partial<CanvasNodeData> }],
          opts,
        )
      } else {
        // canceled：用户主动取消 → 干净移除占位
        canvas.applyOps(job.sessionId, [{ op: 'remove_node', id: nodeId }], opts)
      }
    } catch {
      /* 落位异常不影响任务终态（产物仍在交付件；下次打开画布仅缺席该节点） */
    }
  }

  cancel(jobId: string): { job: MediaJob } | { error: string } {
    const job = this.jobs.get(jobId)
    if (!job) return { error: '任务不存在' }
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      return { error: `任务已结束（${job.status}），无法取消` }
    }
    const ctrl = this.absByJob.get(jobId)
    ctrl?.abort()
    this.queue = this.queue.filter((id) => id !== jobId)
    if (job.status === 'queued') {
      this.finalize(job, 'canceled', undefined, '已取消')
    }
    // running：由执行侧捕获 abort 后 finalize（避免双写）
    return { job: this.jobs.get(jobId)! }
  }

  retry(jobId: string): { job: MediaJob } | { error: string } {
    const job = this.jobs.get(jobId)
    if (!job) return { error: '任务不存在' }
    return this.create(job.sessionId, job.actor, {
      connectionId: job.connectionId,
      capability: job.capability,
      model: job.model,
      prompt: job.prompt,
      negative: job.negative,
      inputs: job.inputs,
      params: job.params,
      canvasTarget: job.canvasTarget,
    })
  }

  /** 连接测试（connections 路由「测试」按钮的媒体分支） */
  async test(connection: ConnectionDefinition): Promise<{ ok: boolean; detail?: string; error?: string; latencyMs?: number }> {
    const config = normalizeMediaConfig(connection.config)
    if (!config) return { ok: false, error: '媒体连接配置不完整（provider / baseUrl 必填）' }
    const adapter = this.adapters.get(config.provider)
    if (!adapter) return { ok: false, error: `暂无 ${config.provider} 适配器` }
    const secret = this.opts.connections.getSecret(connection.id) ?? {}
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15_000)
    const started = Date.now()
    try {
      const result = await adapter.test({ config, secret, signal: ctrl.signal })
      return { ...result, latencyMs: Date.now() - started }
    } catch (err) {
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - started }
    } finally {
      clearTimeout(timer)
    }
  }

  // ---------- 执行管线 ----------

  private pump(): void {
    while (this.running < this.concurrency) {
      const id = this.queue.shift()
      if (!id) return
      const job = this.jobs.get(id)
      if (!job || job.status !== 'queued') continue
      this.running += 1
      void this.runJob(job).finally(() => {
        this.running -= 1
        this.pump()
      })
    }
  }

  private async runJob(job: MediaJob): Promise<void> {
    const resolved = this.resolveConnection(job.connectionId, job.capability)
    if ('error' in resolved) {
      this.finalize(job, 'failed', undefined, resolved.error)
      return
    }
    const { connection, config, adapter } = resolved
    const secret = this.opts.connections.getSecret(connection.id) ?? {}
    const ctrl = new AbortController()
    this.absByJob.set(job.id, ctrl)
    const timeoutMs =
      config.timeoutMs ?? (job.capability.endsWith('image') ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    const timeoutLabel = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.progressText = '已提交'
    this.publish(job)

    const dir = path.join(this.opts.artifacts.ensureSessionDir(job.sessionId), 'canvas', 'media')
    fs.mkdirSync(dir, { recursive: true })
    const ctx: MediaJobContext = {
      connection,
      config,
      secret,
      resolveInput: (rel) => this.opts.artifacts.resolveSafe(job.sessionId, rel),
      saveOutput: (data, ext) => {
        const name = `gen-${Date.now().toString(36)}-${randomUUID().slice(0, 4)}.${ext.replace(/^\./, '')}`
        const rel = `canvas/media/${name}`
        fs.writeFileSync(path.join(dir, name), data)
        if (job.actor !== 'user') this.opts.artifacts.markAuthor(job.sessionId, rel, job.actor)
        this.opts.notify.publish({
          type: 'notify:artifact-updated',
          sessionId: job.sessionId,
          payload: { path: rel, authorAgentId: job.actor === 'user' ? undefined : job.actor },
        })
        return rel
      },
      report: (progress, text) => this.reportProgress(job, progress, text),
      signal: ctrl.signal,
    }

    try {
      const result = await adapter.run(job, ctx)
      // finalize 幂等：若 cancel 已先落地（终态），这里只补充产物不重复广播
      if (timedOut) {
        this.finalize(job, 'failed', undefined, `生成超时（超过 ${timeoutLabel}，可在连接配置中调整 timeoutMs）`)
      } else if (ctrl.signal.aborted) {
        this.finalize(job, 'canceled', undefined, '已取消')
      } else if (result.outputs.length === 0) {
        this.finalize(job, 'failed', undefined, '生成结束但没有产物（请检查适配器工作流配置）')
      } else {
        this.finalize(job, 'succeeded', result.outputs)
      }
    } catch (err) {
      if (timedOut) {
        this.finalize(job, 'failed', undefined, `生成超时（超过 ${timeoutLabel}，可在连接配置中调整 timeoutMs）`)
      } else if (isAbortError(err) || ctrl.signal.aborted) {
        this.finalize(job, 'canceled', undefined, '已取消')
      } else {
        this.finalize(job, 'failed', undefined, (err as Error).message)
      }
    } finally {
      clearTimeout(timer)
      this.absByJob.delete(job.id)
    }
  }

  private lastProgressAt = new Map<string, number>()

  private reportProgress(job: MediaJob, progress?: number, text?: string): void {
    const changed = progress !== job.progress || (text !== undefined && text !== job.progressText)
    if (!changed) return
    job.progress = progress ?? job.progress
    job.progressText = text ?? job.progressText
    const now = Date.now()
    const last = this.lastProgressAt.get(job.id) ?? 0
    if (now - last < PROGRESS_THROTTLE_MS) return
    this.lastProgressAt.set(job.id, now)
    this.publish(job)
  }

  private finalize(job: MediaJob, status: MediaJob['status'], outputs?: string[], error?: string): void {
    if (job.status === 'succeeded' || job.status === 'failed' || job.status === 'canceled') {
      // 已终态（取消竞态）：只补充产物不重复广播
      if (outputs?.length) job.outputs = outputs
      return
    }
    job.status = status
    if (outputs) job.outputs = outputs
    if (error) job.error = error
    job.finishedAt = new Date().toISOString()
    if (status === 'succeeded') {
      job.progress = 100
      job.progressText = '完成'
    } else if (status === 'canceled') {
      job.progressText = '已取消'
    } else {
      job.progressText = '失败'
    }
    // M31 修订：画布结算（占位替换 / 保留 / 移除；先于任务广播，前端先合流节点再收提示）
    this.settleJob(job)
    this.publish(job)
  }

  private publish(job: MediaJob): void {
    this.opts.notify.publish({
      type: 'notify:media-job',
      sessionId: job.sessionId,
      payload: { job },
    })
  }

  private trimHistory(sessionId: string): void {
    const list = this.list(sessionId)
    if (list.length <= HISTORY_PER_SESSION) return
    for (const job of list.slice(HISTORY_PER_SESSION)) this.jobs.delete(job.id)
  }

  /** 进程退出 / 测试清理：中止全部运行任务 */
  stopAll(): void {
    for (const ctrl of this.absByJob.values()) ctrl.abort()
    this.absByJob.clear()
    this.queue = []
  }
}

/** 媒体连接 config 窄化（provider / baseUrl / capabilities 最少集校验） */
export function normalizeMediaConfig(raw: Record<string, unknown>): MediaConnectionConfig | undefined {
  const provider = raw.provider
  const baseUrl = raw.baseUrl
  if (provider !== 'comfyui' && provider !== 'sdwebui' && provider !== 'openai' && provider !== 'template') {
    return undefined
  }
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return undefined
  const capabilities = Array.isArray(raw.capabilities)
    ? (raw.capabilities.filter(
        (c): c is MediaCapability =>
          c === 'text2image' ||
          c === 'image2image' ||
          c === 'text2video' ||
          c === 'image2video' ||
          c === 'firstlast2video',
      ) as MediaCapability[])
    : []
  return {
    provider,
    baseUrl: baseUrl.trim(),
    models: Array.isArray(raw.models) ? (raw.models.filter((m): m is string => typeof m === 'string')) : undefined,
    defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
    capabilities,
    workflows: Array.isArray(raw.workflows)
      ? (raw.workflows.filter((w) => {
          const item = w as { id?: unknown; json?: unknown }
          return item && typeof item === 'object' && typeof item.id === 'string' && item.json !== undefined
        }) as MediaConnectionConfig['workflows'])
      : undefined,
    template:
      raw.template && typeof raw.template === 'object' && !Array.isArray(raw.template)
        ? (raw.template as MediaConnectionConfig['template'])
        : undefined,
    timeoutMs: typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? raw.timeoutMs : undefined,
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || /aborted|abort/i.test(err.message))
}

/** 供适配器复用：能力对应的落盘扩展名（图像 png / 视频 mp4） */
export { outputExtFor }
