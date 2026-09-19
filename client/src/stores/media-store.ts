/**
 * M31：媒体生成任务状态 —— 任务清单（WS notify:media-job 实时消费 + 打开面板时初始拉取）、
 * 可用提供方（「设置 → 媒体生成」中启用连接的能力 / 模型 / 工作流模板；M56 起全局，不区分会话）、
 * 完成自动落画布、终态提示。
 *
 * 分工：服务端 MediaService 是任务真相；本 store 只做「展示镜像 + 落画布 + 提示」，
 * 不承担轮询补拉（WS 有 seq 去重与降级轮询兜底）。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { CanvasGenerationParams, MediaJob, MediaJobInput, MediaProviderInfo } from '@multi-agent/shared'
import { createNode, NODE_SIZE } from '../lib/canvas'
import { CAPABILITY_LABEL, outputKindOf, outputSummary } from '../lib/media'
import { useCanvasStore } from './canvas-store'

/** 已放置到画布的任务 id（WS 重放 / HTTP+WS 双通道的幂等；画布文档本身已持久化节点） */
const placedJobs = new Set<string>()
/** 客户端任务清单上限（服务端每会话 50 条；冗余 10 条容错） */
const JOBS_LIMIT = 60

/** 生成面板输入引用（右键「生成变体 / 设为首帧」写入；面板打开时消费） */
export interface GenRef {
  images: string[]
  firstFrame?: string
  lastFrame?: string
  /** 谱系回填：生成变体时预填提示词与参数 */
  prompt?: string
  params?: CanvasGenerationParams
}

const EMPTY_REF: GenRef = { images: [] }

const isTerminal = (status: MediaJob['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'canceled'
/** 状态阶段序：旧快照（HTTP 响应与 WS 广播交叉）不得覆盖更新状态 */
const stageOf = (status: MediaJob['status']): number => (status === 'queued' ? 0 : status === 'running' ? 1 : 2)

interface MediaState {
  sessionId?: string
  /** 会话任务（新 → 旧；产物以交付件为持久真相） */
  jobs: MediaJob[]
  /** 全局可用媒体连接（生成面板的能力 / 模型 / 工作流来源；「设置 → 媒体生成」配置，不区分会话） */
  providers: MediaProviderInfo[]
  loading: boolean
  /** 最近一次提交 / 重试失败文案（面板内联展示） */
  lastError?: string
  /** 生成面板开关（工具栏按钮 / 节点右键入口） */
  panelOpen: boolean
  /** 输入引用（图片 / 首尾帧 / 谱系回填） */
  genRef: GenRef
  openPanel(ref?: Partial<GenRef>): void
  closePanel(): void
  setGenRef(ref: GenRef): void
  /** 加载会话任务与可用提供方（切换会话重入；过期响应丢弃） */
  load(sessionId: string): Promise<void>
  /** 仅刷新提供方（「设置 → 媒体生成」中启用 / 停用变更后回来时调用；全局清单，与会话无关） */
  refreshProviders(): Promise<void>
  /** 任务快照统一入口（WS 通知与 HTTP 响应共用；幂等 upsert + 终态提示 + 完成落画布） */
  ingest(job: MediaJob): void
  createJob(input: MediaJobInput): Promise<MediaJob | undefined>
  cancelJob(jobId: string): Promise<void>
  retryJob(jobId: string): Promise<MediaJob | undefined>
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(data.error ?? `请求失败（HTTP ${res.status}）`)
  }
  return (await res.json()) as T
}

/** 成功任务的产物落画布（携带 canvasTarget 且画布已加载；多产物横向排开） */
function placeOutputs(job: MediaJob): number {
  const target = job.canvasTarget
  const canvas = useCanvasStore.getState()
  if (!target || canvas.sessionId !== job.sessionId || !canvas.doc || job.outputs.length === 0) return 0
  if (placedJobs.has(job.id)) return 0
  placedJobs.add(job.id)

  const kind = outputKindOf(job.capability)
  const size = NODE_SIZE[kind]
  const params: CanvasGenerationParams = {
    capability: job.capability,
    model: job.model,
    negative: job.negative,
    width: job.params.width,
    height: job.params.height,
    steps: job.params.steps,
    seed: job.params.seed,
    duration: job.params.duration,
    workflowId: job.params.workflowId,
  }
  const nodes = job.outputs.map((rel, index) => {
    const position = { x: target.x + index * (size.width + 24), y: target.y }
    if (kind === 'video') {
      return createNode('video', position, {
        artifact: rel,
        source: 'generate',
        jobId: job.id,
        prompt: job.prompt,
        params,
        firstFrame: job.inputs.firstFrame,
        lastFrame: job.inputs.lastFrame,
      })
    }
    return createNode('image', position, { artifact: rel, source: 'generate', jobId: job.id, prompt: job.prompt, params })
  })
  canvas.addNodes(nodes)
  return nodes.length
}

export const useMediaStore = create<MediaState>((set, get) => ({
  jobs: [],
  providers: [],
  loading: false,
  panelOpen: false,
  genRef: EMPTY_REF,

  openPanel: (ref) => {
    if (!ref) {
      set({ panelOpen: true })
      return
    }
    // 合并语义：先右键「设为首帧」再「设为尾帧」可连续补全（相同字段以最新为准）
    set({ panelOpen: true, genRef: { ...get().genRef, ...ref } })
  },

  closePanel: () => set({ panelOpen: false }),

  setGenRef: (ref) => set({ genRef: ref }),

  load: async (sessionId) => {
    if (get().sessionId !== sessionId) {
      set({ sessionId, jobs: [], providers: [], lastError: undefined })
    }
    set({ loading: true })
    try {
      const [jobsRes, providersRes] = await Promise.all([
        request<{ jobs: MediaJob[] }>(`/api/sessions/${sessionId}/media/jobs`),
        request<{ providers: MediaProviderInfo[] }>('/api/media/providers'),
      ])
      if (get().sessionId !== sessionId) return // 已切走：丢弃过期响应
      set({ jobs: jobsRes.jobs, providers: providersRes.providers, loading: false })
    } catch {
      if (get().sessionId !== sessionId) return
      // 服务未装配（503）/ 网络抖动：静默降级，面板按提供方空态给「去设置」引导
      set({ loading: false })
    }
  },

  refreshProviders: async () => {
    try {
      const res = await request<{ providers: MediaProviderInfo[] }>('/api/media/providers')
      set({ providers: res.providers })
    } catch {
      /* 保留现有清单，等下次刷新 */
    }
  },

  ingest: (job) => {
    const { sessionId, jobs } = get()
    if (!sessionId || job.sessionId !== sessionId) return
    const index = jobs.findIndex((j) => j.id === job.id)
    const before = index >= 0 ? jobs[index] : undefined
    if (before && stageOf(job.status) < stageOf(before.status)) return // 旧快照，忽略
    set({
      jobs: index >= 0 ? jobs.map((j, i) => (i === index ? job : j)) : [job, ...jobs].slice(0, JOBS_LIMIT),
    })
    if (before && isTerminal(before.status)) return // 终态只提示一次

    if (job.status === 'succeeded') {
      const placed = placeOutputs(job)
      toast(
        `${CAPABILITY_LABEL[job.capability]}完成：${outputSummary(job)}${placed > 0 ? '，已落到画布' : '，产物已保存到交付件'}`,
      )
    } else if (job.status === 'failed') {
      toast.error(`媒体生成失败：${job.error ?? '未知错误'}`)
    }
    // canceled：用户主动取消，静默
  },

  createJob: async (input) => {
    const { sessionId } = get()
    if (!sessionId) return undefined
    try {
      const res = await request<{ job: MediaJob }>(`/api/sessions/${sessionId}/media/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      })
      set({ lastError: undefined })
      get().ingest(res.job)
      return res.job
    } catch (err) {
      set({ lastError: (err as Error).message })
      toast.error((err as Error).message)
      return undefined
    }
  },

  cancelJob: async (jobId) => {
    try {
      const res = await request<{ job: MediaJob }>(`/api/media/jobs/${jobId}/cancel`, { method: 'POST' })
      get().ingest(res.job)
    } catch (err) {
      toast.error((err as Error).message)
    }
  },

  retryJob: async (jobId) => {
    try {
      const res = await request<{ job: MediaJob }>(`/api/media/jobs/${jobId}/retry`, { method: 'POST' })
      set({ lastError: undefined })
      get().ingest(res.job)
      return res.job
    } catch (err) {
      set({ lastError: (err as Error).message })
      toast.error((err as Error).message)
      return undefined
    }
  },
}))
