/**
 * M33 前端测试：附件托盘（三态 / 交互）+ 消息内附件原生渲染（分类 / Lightbox / 播放）
 * + Composer 附件流（选择 → 上传 → 发送携带附件）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, MessageAttachment } from '@multi-agent/shared'
import { AttachmentTray, type TrayItem } from '../src/components/chat/AttachmentTray'
import { Composer } from '../src/components/chat/Composer'
import { MessageAttachments } from '../src/components/chat/MessageAttachments'
import { apiUpload } from '../src/lib/api'
import { useAgentStore } from '../src/stores/agent-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

// apiUpload 走 XHR（jsdom 无真实网络）：仅替换该函数，其余 api 保持真实实现
vi.mock('../src/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/api')>()
  return { ...actual, apiUpload: vi.fn() }
})

const uploadMock = vi.mocked(apiUpload)

const T0 = '2026-09-17T08:00:00.000Z'

function makeAgent(id: string, name: string, role: string): AgentDefinition {
  return {
    id,
    name,
    role,
    title: role,
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
  }
}

const UPLOADED: MessageAttachment = {
  path: 'uploads/x-note.txt',
  name: 'note.txt',
  kind: 'other',
  mime: 'text/plain',
  size: 12,
  uploadedAt: T0,
}

beforeEach(() => {
  // 底栏上下文电池（ContextBar）挂载即拉取快照：stub 网络为常挂起，避免真实请求与 act 警告
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})))
  localStorage.clear()
  // jsdom 缺失 object URL API（媒体缩略图创建 / 释放）
  URL.createObjectURL = vi.fn(() => 'blob:mock')
  URL.revokeObjectURL = vi.fn()
  uploadMock.mockReset()
  uploadMock.mockResolvedValue({ attachment: UPLOADED })
  useAgentStore.setState({
    agents: [makeAgent('architect', '艾达', '架构师'), makeAgent('pm', '费利', '产品经理')],
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({
    sessions: [
      {
        id: 's1',
        title: '测试会话',
        participantIds: ['architect', 'pm'],
        createdAt: T0,
        updatedAt: T0,
        messageCount: 0,
      },
    ],
    currentId: 's1',
    byId: new Map(),
    order: [],
    loadingSessions: false,
    loadingMessages: false,
    artifactVersion: 0,
  })
  useRunStore.setState({ active: false, queued: false, queue: [], currentWave: [], approvals: [] })
  useUiStore.setState({ requestedArtifactPath: undefined, mainTab: 'chat', rightView: 'members' })
  useLivePanelStore.setState({
    face: 'browser',
    faceLockedAt: undefined,
    viewLockedRunId: undefined,
    lastManualViewAt: undefined,
    followPaused: false,
    pinnedArtifactPath: undefined,
    followArtifactPath: undefined,
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- AttachmentTray ----------

const docItem: TrayItem = {
  id: 't1',
  name: 'note.txt',
  size: 2048,
  mime: 'text/plain',
  visual: 'text',
  status: 'done',
  progress: 1,
}

describe('M33：附件托盘（AttachmentTray）', () => {
  it('空列表不渲染；文档卡展示名称 / 类型标签 / 体积', () => {
    const { container, rerender } = render(<AttachmentTray items={[]} onRemove={vi.fn()} onOpen={vi.fn()} />)
    expect(container.firstChild).toBeNull()

    rerender(<AttachmentTray items={[docItem]} onRemove={vi.fn()} onOpen={vi.fn()} />)
    expect(screen.getByText('note.txt')).toBeInTheDocument()
    expect(screen.getByText('文本')).toBeInTheDocument()
    expect(screen.getByText('2.0KB')).toBeInTheDocument()
    expect(screen.getByText('随消息发送')).toBeInTheDocument()
  })

  it('上传中：进度指示（发送前状态提示存在）；错误态：标红 + 原因入 title', () => {
    const items: TrayItem[] = [
      { ...docItem, status: 'uploading', progress: 0.4 },
      { ...docItem, id: 't2', name: 'bad.pdf', visual: 'pdf', status: 'error', error: '服务端拒绝' },
    ]
    const { container } = render(<AttachmentTray items={items} onRemove={vi.fn()} onOpen={vi.fn()} />)
    // 上传中：进度条宽度按 progress 渲染
    const bars = container.querySelectorAll('span[style*="width"]')
    expect(bars.length).toBeGreaterThan(0)
    expect((bars[0] as HTMLElement).style.width).toBe('40%')
    // 错误态：文案 + title 携带原因
    expect(screen.getByText('上传失败')).toBeInTheDocument()
    expect(screen.getByTitle('bad.pdf · 上传失败：服务端拒绝')).toBeInTheDocument()
  })

  it('媒体项：点击缩略图触发预览；删除按钮按 id 回调（stopPropagation 不触发预览）', async () => {
    const user = userEvent.setup()
    const onRemove = vi.fn()
    const onOpen = vi.fn()
    const media: TrayItem = {
      id: 'm1',
      name: 'shot.png',
      size: 1024,
      mime: 'image/png',
      visual: 'image',
      status: 'done',
      progress: 1,
      localUrl: 'blob:mock',
    }
    render(<AttachmentTray items={[media]} onRemove={onRemove} onOpen={onOpen} />)
    await user.click(screen.getByTitle('shot.png（点击预览）'))
    expect(onOpen).toHaveBeenCalledWith('m1')

    await user.click(screen.getByRole('button', { name: '移除 shot.png' }))
    expect(onRemove).toHaveBeenCalledWith('m1')
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})

// ---------- MessageAttachments ----------

function imageAtt(i: number): MessageAttachment {
  return { path: `uploads/p${i}.png`, name: `${i}.png`, kind: 'image', mime: 'image/png', size: 1024, uploadedAt: T0 }
}

describe('M33：消息内附件渲染（MessageAttachments）', () => {
  it('图片网格：多图逐张按钮；点击打开 Lightbox 并可左右切换', async () => {
    const user = userEvent.setup()
    render(<MessageAttachments sessionId="s1" attachments={[imageAtt(1), imageAtt(2)]} />)
    const buttons = screen.getAllByTitle(/（点击放大）/)
    expect(buttons).toHaveLength(2)
    await user.click(buttons[0])

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByAltText('1.png')).toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: '下一张' }))
    expect(within(dialog).getByAltText('2.png')).toBeInTheDocument()
    // Esc 关闭
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('文档卡：点击名称请求右侧预览（requestArtifact）；下载链接带 download 参数', async () => {
    const user = userEvent.setup()
    const pdf: MessageAttachment = {
      path: 'uploads/合同.pdf',
      name: '合同.pdf',
      kind: 'pdf',
      mime: 'application/pdf',
      size: 4096,
      uploadedAt: T0,
    }
    render(<MessageAttachments sessionId="s1" attachments={[pdf]} />)
    expect(screen.getByText('PDF · 4.0KB')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '合同.pdf' }))
    expect(useUiStore.getState().requestedArtifactPath).toBe('uploads/合同.pdf')
    // M49（ADR 0100）：chip 跳转 → 右栏实况·交付件面钉住（主区不再切「交付件」页签）
    expect(useUiStore.getState().mainTab).toBe('chat')
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().face).toBe('artifacts')
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBe('uploads/合同.pdf')

    const link = screen.getByRole('link', { name: '下载 合同.pdf' })
    expect(link.getAttribute('href')).toContain('download=1')
  })

  it('视频：封面式（无 controls + 时长 / 分辨率角标）→ 点击切换为内联播放', async () => {
    const user = userEvent.setup()
    const video: MessageAttachment = {
      path: 'uploads/demo.mp4',
      name: 'demo.mp4',
      kind: 'video',
      mime: 'video/mp4',
      size: 5000,
      durationMs: 65_000,
      width: 1280,
      height: 720,
      uploadedAt: T0,
    }
    const { container } = render(<MessageAttachments sessionId="s1" attachments={[video]} />)
    expect(screen.getByTitle('demo.mp4（点击播放）')).toBeInTheDocument()
    expect(screen.getByText(/1:05/)).toBeInTheDocument()
    expect(screen.getByText(/1280×720/)).toBeInTheDocument()
    expect(container.querySelector('video')!.hasAttribute('controls')).toBe(false)

    await user.click(screen.getByTitle('demo.mp4（点击播放）'))
    expect(container.querySelector('video')!.hasAttribute('controls')).toBe(true)
  })

  it('音频：渲染紧凑播放条（audio 元素 + 文件名）', () => {
    const audio: MessageAttachment = {
      path: 'uploads/a.mp3',
      name: 'a.mp3',
      kind: 'other',
      mime: 'audio/mpeg',
      size: 2048,
      uploadedAt: T0,
    }
    const { container } = render(<MessageAttachments sessionId="s1" attachments={[audio]} />)
    expect(container.querySelector('audio')).not.toBeNull()
    expect(screen.getByText('a.mp3')).toBeInTheDocument()
  })
})

// ---------- Composer 附件流 ----------

describe('M33：Composer 附件流', () => {
  function fileInput(): HTMLInputElement {
    return document.querySelector('input[type="file"]') as HTMLInputElement
  }

  it('选择文件 → 托盘即时展示 → 上传完成 → 发送携带附件并清空托盘', async () => {
    const user = userEvent.setup()
    const sendMock = vi.fn(async () => undefined)
    useRunStore.setState({ send: sendMock })
    render(<Composer />)

    const file = new File(['hello world'], 'note.txt', { type: 'text/plain' })
    fireEvent.change(fileInput(), { target: { files: [file] } })

    // 托盘即时出现（上传中占位）
    expect(await screen.findByText('note.txt')).toBeInTheDocument()
    // 上传完成：发送按钮可用（纯附件消息也可发送）
    const send = screen.getByRole('button', { name: '发送' })
    await waitFor(() => expect(send).not.toBeDisabled())

    await user.type(screen.getByRole('textbox'), '看下这个')
    await user.click(send)
    await waitFor(() => expect(sendMock).toHaveBeenCalledTimes(1))
    expect(sendMock).toHaveBeenCalledWith('看下这个', undefined, [UPLOADED], undefined)
    // 发送后托盘清空
    await waitFor(() => expect(screen.queryByText('note.txt')).not.toBeInTheDocument())
  })

  it('上传中：发送按钮不可用（拦截半成品附件）', async () => {
    uploadMock.mockImplementationOnce(() => new Promise(() => {}))
    const sendMock = vi.fn(async () => undefined)
    useRunStore.setState({ send: sendMock })
    render(<Composer />)

    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'slow.png', { type: 'image/png' })] } })
    await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeDisabled())
    expect(sendMock).not.toHaveBeenCalled()
  })

  it('不支持的格式：前端白名单拦截（不上传、不进托盘）', async () => {
    const { container } = render(<Composer />)
    fireEvent.change(fileInput(), { target: { files: [new File(['MZ'], 'evil.exe')] } })
    await waitFor(() => expect(container.textContent).not.toContain('evil.exe'))
    expect(uploadMock).not.toHaveBeenCalled()
  })

  it('移除托盘项：上传完成的附件被移除后不可发送（空内容 + 无附件）', async () => {
    const user = userEvent.setup()
    render(<Composer />)
    fireEvent.change(fileInput(), { target: { files: [new File(['x'], 'note.txt', { type: 'text/plain' })] } })
    const send = screen.getByRole('button', { name: '发送' })
    await waitFor(() => expect(send).not.toBeDisabled())

    await user.click(screen.getByRole('button', { name: '移除 note.txt' }))
    await waitFor(() => expect(send).toBeDisabled())
  })
})
