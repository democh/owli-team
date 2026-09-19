/**
 * M31：媒体生成任务状态 —— 任务清单（WS notify:media-job 实时消费 + 打开面板时初始拉取）、
 * 可用提供方（「设置 → 媒体生成」中启用连接的能力 / 模型 / 工作流模板；M56 起全局，不区分会话）、
 * 完成自动落画布、终态提示。
 *
 * 分工：服务端 MediaService 是任务真相；本 store 只做「展示镜像 + 提示」，
 * 不承担轮询补拉（WS 有 seq 去重与降级轮询兜底）。
 * M31 修订：产物落画布由服务端完成（创建落占位 / 终态结算）——本 store 不再前端放置（防双写），
 * 仅按 job.placedCanvas 分流提示文案；节点内 pending 进度由本次订阅的 jobs 快照驱动。
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import type { CanvasGenerationParams, MediaJob, MediaJobInput, MediaProviderInfo } from '@multi-agent/shared'
import { CAPABILITY_LABEL, outputSummary } from '../lib/media'

/** 客户端任务清单上限（服务端每会话 50 条；冗余 10 条容错） */
const JOBS_LIMIT = 60
/** ensureProviders 并发去重（模块级：绕过 set 状态的异步窗口） */
let providersRefreshing = false

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
  /** 提供方是否已至少拉取过一次（能力门控：未加载完成前按「无能力」渲染，杜绝门控元素闪现） */
  providersLoaded: boolean
  /** M31 修订：任务快照是否已成功拉取过一次（僵尸占位自愈的判定门槛：拉取失败不得误判） */
  jobsLoaded: boolean
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
  /** 幂等确保提供方已加载（画布挂载消费；并发去重，已加载过则跳过） */
  ensureProviders(): Promise<void>
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

export const useMediaStore = create<MediaState>((set, get) => ({
  jobs: [],
  providers: [],
  providersLoaded: false,
  jobsLoaded: false,
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
      // 切会话：只清会话任务；providers 为全局清单（M56），与会话无关，保留避免能力门控闪烁
      set({ sessionId, jobs: [], jobsLoaded: false, lastError: undefined })
    }
    set({ loading: true })
    try {
      const [jobsRes, providersRes] = await Promise.all([
        request<{ jobs: MediaJob[] }>(`/api/sessions/${sessionId}/media/jobs`),
        request<{ providers: MediaProviderInfo[] }>('/api/media/providers'),
      ])
      if (get().sessionId !== sessionId) return // 已切走：丢弃过期响应
      set({ jobs: jobsRes.jobs, jobsLoaded: true, providers: providersRes.providers, providersLoaded: true, loading: false })
    } catch {
      if (get().sessionId !== sessionId) return
      // 服务未装配（503）/ 网络抖动：静默降级，面板按提供方空态给「去设置」引导
      set({ loading: false })
    }
  },

  refreshProviders: async () => {
    try {
      const res = await request<{ providers: MediaProviderInfo[] }>('/api/media/providers')
      set({ providers: res.providers, providersLoaded: true })
    } catch {
      /* 保留现有清单，等下次刷新 */
    }
  },

  ensureProviders: async () => {
    if (get().providersLoaded || providersRefreshing) return
    providersRefreshing = true
    try {
      await get().refreshProviders()
    } finally {
      providersRefreshing = false
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
      // M31 修订：落位由服务端完成（占位→产出）；此处仅提示（placedCanvas 标记落位结果）
      const placed = job.placedCanvas === true
      toast(`${CAPABILITY_LABEL[job.capability]}完成：${outputSummary(job)}${placed ? '，已落到画布' : '，产物已保存到交付件'}`)
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
