/**
 * M68 素材库前端测试：
 * - library-store：列表 / 容量拉取；上传（raw + x-file-name，成功后刷新）；删除；放入画布（无会话引导 / 入仓 + sendArtifact）；
 * - MaterialsConsole：空态引导 / 列表网格渲染 / 类型筛选（服务端参数）/ 上传按钮。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { LibraryItem } from '@multi-agent/shared'
import { MaterialsConsole } from '../src/components/console/MaterialsConsole'
import { useCanvasStore } from '../src/stores/canvas-store'
import { useLibraryStore } from '../src/stores/library-store'
import { useSessionStore } from '../src/stores/session-store'

vi.mock('sonner', () => {
  const toastFn = vi.fn()
  return { toast: Object.assign(toastFn, { error: vi.fn(), success: vi.fn() }) }
})
import { toast } from 'sonner'

const T0 = '2026-09-19T08:00:00.000Z'

function mkItem(over: Partial<LibraryItem> = {}): LibraryItem {
  return { id: 'mat_1', name: '猫咪.png', kind: 'image', ext: '.png', sizeBytes: 2048, source: 'upload', createdAt: T0, ...over }
}

function res(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response
}

let itemList: LibraryItem[] = []
let lastListUrl = ''
let uploadCalls: Array<{ name: string; size: number }> = []
let toCanvasCalls: number = 0

beforeEach(() => {
  vi.clearAllMocks()
  itemList = []
  lastListUrl = ''
  uploadCalls = []
  toCanvasCalls = 0
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (url.startsWith('/api/library/items') && method === 'GET') {
      lastListUrl = url
      return res({ items: itemList })
    }
    if (url === '/api/library/usage') return res({ usage: { count: itemList.length, bytes: 2048 * itemList.length } })
    if (url === '/api/library/uploads' && method === 'POST') {
      uploadCalls.push({ name: String((init?.headers as Record<string, string>)['x-file-name']), size: (init?.body as Blob)?.size ?? 0 })
      return res({ item: mkItem({ id: 'mat_new', name: '新上传.png' }) })
    }
    if (url.startsWith('/api/library/items/') && url.endsWith('/to-canvas')) {
      toCanvasCalls += 1
      return res({ path: 'library/ref-x-mat_1.png', kind: 'image' })
    }
    if (url.startsWith('/api/library/items/') && method === 'DELETE') return res({ ok: true })
    return res({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  useLibraryStore.setState({ items: [], usage: undefined, loading: false, uploading: 0 })
  useSessionStore.setState({ currentId: undefined })
  useCanvasStore.setState({ sendArtifact: vi.fn(async () => 'nd_new') })
})

describe('M68 library-store', () => {
  it('load：列表 + 容量拉取；查询 / 类型透传为服务端参数', async () => {
    itemList = [mkItem(), mkItem({ id: 'mat_2', name: '视频.mp4', kind: 'video' })]
    await useLibraryStore.getState().load()
    expect(useLibraryStore.getState().items).toHaveLength(2)
    expect(useLibraryStore.getState().usage?.count).toBe(2)

    await useLibraryStore.getState().load({ query: '猫', kind: 'video' })
    expect(lastListUrl).toContain('query=%E7%8C%AB')
    expect(lastListUrl).toContain('kind=video')
  })

  it('upload：raw + x-file-name 上传；成功后刷新列表并提示', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], '你好 图.png', { type: 'image/png' })
    const ok = await useLibraryStore.getState().upload([file])
    expect(ok).toBe(1)
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0]!.name).toContain(encodeURIComponent('你好 图.png'))
    expect(vi.mocked(toast)).toHaveBeenCalledWith('素材已上传')
  })

  it('toCanvas：无会话 → 引导 toast 不发请求；有会话 → 入仓 + sendArtifact 落节点', async () => {
    const denied = await useLibraryStore.getState().toCanvas('mat_1')
    expect(denied).toBe(false)
    expect(toCanvasCalls).toBe(0)
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringContaining('先在左侧选择一个会话'))

    useSessionStore.setState({ currentId: 's_demo' })
    const sendArtifact = useCanvasStore.getState().sendArtifact as unknown as ReturnType<typeof vi.fn>
    const ok = await useLibraryStore.getState().toCanvas('mat_1')
    expect(ok).toBe(true)
    expect(toCanvasCalls).toBe(1)
    expect(sendArtifact).toHaveBeenCalledWith('library/ref-x-mat_1.png') // copy-on-use 入仓路径
  })

  it('remove：删除后本地移除并刷新', async () => {
    itemList = [mkItem()]
    await useLibraryStore.getState().load()
    const ok = await useLibraryStore.getState().remove('mat_1')
    expect(ok).toBe(true)
    expect(vi.mocked(toast)).toHaveBeenCalledWith('素材已删除')
  })
})

describe('M68 MaterialsConsole', () => {
  it('空态：引导上传（跨会话随取随用）', async () => {
    render(<MaterialsConsole />)
    expect(await screen.findByText(/还没有素材/)).toBeTruthy()
    // 头部与空态各有一个「上传素材」入口
    expect(screen.getAllByRole('button', { name: /上传素材/ }).length).toBeGreaterThan(0)
  })

  it('列表：网格渲染素材卡片；类型筛选触发服务端参数', async () => {
    itemList = [mkItem(), mkItem({ id: 'mat_2', name: '视频.mp4', kind: 'video', sizeBytes: 3 * 1024 * 1024 })]
    render(<MaterialsConsole />)
    expect(await screen.findByText('猫咪.png')).toBeTruthy()
    expect(screen.getByText('视频.mp4')).toBeTruthy()
    expect(screen.getByText('2 KB')).toBeTruthy() // 大小格式化
    expect(screen.getByText('3.0 MB')).toBeTruthy()

    await userEvent.click(screen.getByRole('button', { name: '视频' }))
    await waitFor(() => expect(lastListUrl).toContain('kind=video'), { timeout: 2_000 })
  })

  it('类型筛选-音频：chip 触发 kind=audio 服务端参数', async () => {
    itemList = [mkItem({ id: 'mat_3', name: '配乐.mp3', kind: 'audio', ext: '.mp3' })]
    render(<MaterialsConsole />)
    await screen.findByText('配乐.mp3')
    await userEvent.click(screen.getByRole('button', { name: '音频' }))
    await waitFor(() => expect(lastListUrl).toContain('kind=audio'), { timeout: 2_000 })
  })

  it('放入画布按钮：调用 toCanvas（入仓 + 落节点）', async () => {
    itemList = [mkItem()]
    useSessionStore.setState({ currentId: 's_demo' })
    render(<MaterialsConsole />)
    await screen.findByText('猫咪.png')
    await userEvent.click(screen.getByTitle(/放入当前会话画布/))
    await waitFor(() => expect(toCanvasCalls).toBe(1), { timeout: 2_000 })
  })
})
