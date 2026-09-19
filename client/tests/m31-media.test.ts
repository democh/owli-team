/**
 * M31 媒体任务前端测试（P3）：media-store —— 加载与切换会话 / upsert 幂等与旧快照防御 /
 * 终态提示一次（canceled 静默）/ 完成落画布（同会话 + canvasTarget + 谱系 + placedJobs 幂等）/
 * 面板 genRef 合并 / createJob 失败 lastError / cancel·retry 回流（重试为新任务）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasDoc, CanvasVideoData, MediaJob, MediaProviderInfo } from '@multi-agent/shared'
import { NODE_SIZE } from '../src/lib/canvas'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useMediaStore } from '../src/stores/media-store'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn() }) }
})
import { toast } from 'sonner'

const T0 = '2026-06-01T08:00:00.000Z'
const SID = 's-media'

let jobList: MediaJob[] = []
let providerList: MediaProviderInfo[] = []
let canvasDoc: CanvasDoc
let postReply: { status: number; body: unknown } | undefined

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

function mkJob(over: Partial<MediaJob> = {}): MediaJob {
  return {
    id: 'j-1',
    sessionId: SID,
    actor: 'user',
    capability: 'text2image',
    connectionId: 'conn-1',
    prompt: '一只猫',
    inputs: {},
    params: {},
    status: 'queued',
    outputs: [],
    createdAt: T0,
    ...over,
  }
}

function mkProvider(over: Partial<MediaProviderInfo> = {}): MediaProviderInfo {
  return {
    connectionId: 'conn-1',
    connectionName: '本地 ComfyUI',
    provider: 'comfyui',
    capabilities: ['text2image'],
    models: ['flux-dev'],
    workflows: [],
    ...over,
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks() // sonner mock 为模块级单例：清呼叫记录避免跨用例断言串场
  canvasDoc = { v: 1, sessionId: SID, version: 1, updatedAt: T0, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], edges: [] }
  jobList = []
  providerList = []
  postReply = undefined
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.includes('/canvas')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as {
          baseVersion: number
          nodes: CanvasDoc['nodes']
          edges: CanvasDoc['edges']
          viewport: CanvasDoc['viewport']
        }
        canvasDoc = { ...canvasDoc, version: body.baseVersion + 1, nodes: body.nodes, edges: body.edges, viewport: body.viewport }
        return res({ doc: canvasDoc })
      }
      return res({ doc: canvasDoc, mediaBound: true })
    }
    if (/\/media\/jobs$/.test(url) && method === 'GET') return res({ jobs: jobList })
    if (url.includes('/media/providers')) return res({ providers: providerList })
    if (url.includes('/media/jobs') && method === 'POST') {
      return postReply ? res(postReply.body, postReply.status) : res({ job: mkJob() })
    }
    return res({})
  })
  vi.stubGlobal('fetch', fetchMock)
  // 重置两个 store（模块级 placedJobs 不可重置：各用例使用互不相同 job id 隔离）
  useMediaStore.setState({
    sessionId: undefined,
    jobs: [],
    providers: [],
    loading: false,
    lastError: undefined,
    panelOpen: false,
    genRef: { images: [] },
  })
  useCanvasStore.setState({
    sessionId: undefined,
    doc: null,
    mediaBound: false,
    loading: false,
    saving: false,
    dirty: false,
    saveError: undefined,
    lastSavedAt: undefined,
    selectedIds: [],
    clipboard: null,
    undoDepth: 0,
    redoDepth: 0,
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('media-store 加载与任务快照（M31）', () => {
  it('load：任务与提供方拉取；切换会话先清空再填充', async () => {
    jobList = [mkJob({ id: 'j-a' })]
    providerList = [mkProvider()]
    await useMediaStore.getState().load(SID)
    expect(useMediaStore.getState().jobs.map((j) => j.id)).toEqual(['j-a'])
    expect(useMediaStore.getState().providers.map((p) => p.connectionId)).toEqual(['conn-1'])
    expect(useMediaStore.getState().loading).toBe(false)

    jobList = [mkJob({ id: 'j-b', sessionId: 's-2' })]
    providerList = []
    await useMediaStore.getState().load('s-2')
    const st = useMediaStore.getState()
    expect(st.sessionId).toBe('s-2')
    expect(st.jobs.map((j) => j.id)).toEqual(['j-b'])
    expect(st.providers).toEqual([])
  })

  it('ingest：同 id upsert 不重复；旧快照与别的会话任务忽略', () => {
    useMediaStore.setState({ sessionId: SID })
    const queued = mkJob({ id: 'j-1' })
    useMediaStore.getState().ingest(queued)
    useMediaStore.getState().ingest({ ...queued, status: 'running' })
    expect(useMediaStore.getState().jobs).toHaveLength(1)
    expect(useMediaStore.getState().jobs[0]!.status).toBe('running')
    useMediaStore.getState().ingest(queued) // 旧快照（HTTP 响应与 WS 广播交叉）
    expect(useMediaStore.getState().jobs[0]!.status).toBe('running')
    useMediaStore.getState().ingest(mkJob({ id: 'j-x', sessionId: 's-other' }))
    expect(useMediaStore.getState().jobs.map((j) => j.id)).toEqual(['j-1'])
  })

  it('终态提示只一次：succeeded → toast、failed → toast.error、canceled 静默；重复 ingest 不重复提示', () => {
    useMediaStore.setState({ sessionId: SID })
    const done = mkJob({ id: 'j-done', status: 'succeeded', outputs: ['canvas/media/gen-a.png'] })
    useMediaStore.getState().ingest(done)
    useMediaStore.getState().ingest(done)
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1)

    const failed = mkJob({ id: 'j-fail', status: 'failed', error: '上游 500' })
    useMediaStore.getState().ingest(failed)
    useMediaStore.getState().ingest(failed)
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
    expect(String(vi.mocked(toast.error).mock.calls[0]![0])).toContain('上游 500')

    useMediaStore.getState().ingest(mkJob({ id: 'j-cancel', status: 'canceled' }))
    expect(vi.mocked(toast)).toHaveBeenCalledTimes(1) // canceled 静默
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)
  })
})

describe('media-store 完成落画布（M31）', () => {
  it('succeeded + canvasTarget：产物落画布（视频节点 / 谱系参数 / 首尾帧），重复 ingest 幂等', async () => {
    await useCanvasStore.getState().load(SID)
    useMediaStore.setState({ sessionId: SID })
    const job = mkJob({
      id: 'j-place',
      capability: 'firstlast2video',
      prompt: '镜头推进',
      inputs: { firstFrame: 'canvas/media/f.png', lastFrame: 'canvas/media/l.png' },
      params: { duration: 5, seed: 7, width: 1280, height: 720 },
      status: 'succeeded',
      outputs: ['canvas/media/gen-1.mp4', 'canvas/media/gen-2.mp4'],
      canvasTarget: { x: 100, y: 200 },
    })
    useMediaStore.getState().ingest(job)
    const nodes = useCanvasStore.getState().doc!.nodes
    expect(nodes).toHaveLength(2)
    expect(nodes.every((n) => n.type === 'video')).toBe(true)
    expect(nodes[0]!.position).toEqual({ x: 100, y: 200 })
    expect(nodes[1]!.position).toEqual({ x: 100 + NODE_SIZE.video.width + 24, y: 200 })
    const d = nodes[0]!.data as CanvasVideoData
    expect(d.artifact).toBe('canvas/media/gen-1.mp4')
    expect(d.source).toBe('generate')
    expect(d.jobId).toBe('j-place')
    expect(d.prompt).toBe('镜头推进')
    expect(d.params?.capability).toBe('firstlast2video')
    expect(d.params?.seed).toBe(7)
    expect(d.firstFrame).toBe('canvas/media/f.png')
    expect(d.lastFrame).toBe('canvas/media/l.png')
    expect(String(vi.mocked(toast).mock.calls[0]![0])).toContain('已落到画布')

    useMediaStore.getState().ingest(job) // WS 重放 / 双通道：不得重复放置
    expect(useCanvasStore.getState().doc!.nodes).toHaveLength(2)
  })

  it('无 canvasTarget 或画布会话不匹配：不落画布，提示产物在交付件', async () => {
    await useCanvasStore.getState().load(SID)
    useMediaStore.setState({ sessionId: SID })
    const job = mkJob({ id: 'j-no-target', status: 'succeeded', outputs: ['canvas/media/gen-x.png'] })
    useMediaStore.getState().ingest(job)
    expect(useCanvasStore.getState().doc!.nodes).toHaveLength(0)
    expect(String(vi.mocked(toast).mock.calls[0]![0])).toContain('交付件')

    await useCanvasStore.getState().load('s-other') // 画布切到别的会话
    const cross = mkJob({ id: 'j-cross', status: 'succeeded', outputs: ['canvas/media/gen-y.png'], canvasTarget: { x: 0, y: 0 } })
    useMediaStore.getState().ingest(cross)
    expect(useCanvasStore.getState().doc!.nodes).toHaveLength(0)
  })
})

describe('media-store 面板与提交（M31）', () => {
  it('openPanel：merge genRef（首帧→尾帧连续补全，同字段最新为准）；closePanel 关闭', () => {
    useMediaStore.getState().openPanel()
    expect(useMediaStore.getState().panelOpen).toBe(true)
    useMediaStore.getState().openPanel({ images: ['a.png'] })
    useMediaStore.getState().openPanel({ firstFrame: 'f.png' })
    useMediaStore.getState().openPanel({ lastFrame: 'l.png' })
    const ref = useMediaStore.getState().genRef
    expect(ref.images).toEqual(['a.png'])
    expect(ref.firstFrame).toBe('f.png')
    expect(ref.lastFrame).toBe('l.png')
    useMediaStore.getState().openPanel({ images: ['b.png'] })
    expect(useMediaStore.getState().genRef.images).toEqual(['b.png'])
    useMediaStore.getState().closePanel()
    expect(useMediaStore.getState().panelOpen).toBe(false)
  })

  it('createJob：失败写入 lastError 且返回 undefined；成功 ingest 并返回任务', async () => {
    useMediaStore.setState({ sessionId: SID })
    postReply = { status: 400, body: { error: '本会话未绑定可用媒体连接' } }
    const fail = await useMediaStore.getState().createJob({ capability: 'text2image', prompt: 'p' })
    expect(fail).toBeUndefined()
    expect(useMediaStore.getState().lastError).toBe('本会话未绑定可用媒体连接')
    expect(vi.mocked(toast.error)).toHaveBeenCalledTimes(1)

    postReply = { status: 200, body: { job: mkJob({ id: 'j-ok' }) } }
    const ok = await useMediaStore.getState().createJob({ capability: 'text2image', prompt: 'p' })
    expect(ok?.id).toBe('j-ok')
    expect(useMediaStore.getState().jobs.map((j) => j.id)).toEqual(['j-ok'])
    expect(useMediaStore.getState().lastError).toBeUndefined()
  })

  it('cancelJob / retryJob：响应任务回流 ingest；重试为新任务（新 id 置顶）', async () => {
    useMediaStore.setState({ sessionId: SID })
    useMediaStore.getState().ingest(mkJob({ id: 'j-flow', status: 'running' }))
    postReply = { status: 200, body: { job: { ...mkJob({ id: 'j-flow' }), status: 'canceled' } } }
    await useMediaStore.getState().cancelJob('j-flow')
    expect(useMediaStore.getState().jobs[0]!.status).toBe('canceled')

    postReply = { status: 200, body: { job: mkJob({ id: 'j-flow-2' }) } }
    const retried = await useMediaStore.getState().retryJob('j-flow')
    expect(retried?.id).toBe('j-flow-2')
    expect(useMediaStore.getState().jobs.map((j) => j.id)).toEqual(['j-flow-2', 'j-flow'])

    postReply = { status: 500, body: { error: '服务不可用' } }
    const denied = await useMediaStore.getState().retryJob('j-flow-2')
    expect(denied).toBeUndefined()
    expect(useMediaStore.getState().lastError).toBe('服务不可用')
  })
})
