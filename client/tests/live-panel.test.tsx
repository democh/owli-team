/**
 * 实况面板（M49 / ADR 0100）组件单测：
 * - 四面切换（face 条即二级导航；face 状态由 live-panel-store 驱动）；
 * - 运行中操作面脉冲点 / 交付件未读计数徽标（看到即清零）；
 * - 暂停跟随（本次运行不自动聚焦，beginRun 重置）；
 * - 「在主区展开当前面」（浏览器面无展开项；展开走深度工作台 + deepFrom 记录返回目标）；
 * - 交付件面：跟最新 → 点列表钉住 → 回跟最新；
 * - panel surface 不触悬浮直播窗（空态「打开连接管理」仅切应用视图）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Artifact, ChatMessage } from '@multi-agent/shared'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useLiveDockStore } from '../src/stores/live-dock-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { LivePanel } from '../src/components/live/LivePanel'

const fetchMock = vi.fn()

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 交付件面列表数据（image kind：预览直出，不触发内容拉取） */
const FILES: Artifact[] = [
  { path: 'out/newer.png', size: 2048, mtime: 2, kind: 'image', updatedAt: '2026-09-18T10:00:00.000Z', authorAgentId: 'analyst' },
  { path: 'out/older.png', size: 1024, mtime: 1, kind: 'image', updatedAt: '2026-09-18T09:00:00.000Z' },
]

/** API 桩：浏览器活动会话为 null（不触发帧流 WS）；交付件列表固定两件；其余端点空数据 */
function mockApi(): void {
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/artifacts')) return Promise.resolve(jsonResponse({ artifacts: FILES }))
    if (url.includes('/browser')) return Promise.resolve(jsonResponse({ active: null, history: [] }))
    if (url.includes('/api/audit')) return Promise.resolve(jsonResponse({ entries: [] }))
    if (url.includes('/connections')) return Promise.resolve(jsonResponse({ connections: [], bindings: [] }))
    return Promise.resolve(jsonResponse({}, 404))
  })
  vi.stubGlobal('fetch', fetchMock)
}

function makeRunningMessage(): ChatMessage {
  return {
    id: 'm1',
    sessionId: 's1',
    role: 'agent',
    agentId: 'analyst',
    content: '',
    mentions: [],
    status: 'streaming',
    createdAt: new Date().toISOString(),
    toolCalls: [
      { id: 't1', name: 'db_query', args: {}, status: 'running', startedAt: new Date().toISOString() },
    ],
  }
}

beforeEach(() => {
  localStorage.clear()
  fetchMock.mockReset()
  mockApi()
  useSessionStore.setState({ currentId: 's1', artifactVersion: 0, byId: new Map(), order: [] })
  useRunStore.setState({ runId: undefined, active: false, approvals: [] })
  useConnectionsStore.setState({ ops: [], sessionId: undefined })
  useLiveDockStore.setState({ visible: false, mode: 'dock', tab: 'browser' })
  useUiStore.setState({
    rightView: 'live',
    mainTab: 'chat',
    deepFrom: undefined,
    appView: 'workspace',
    newArtifactCount: 0,
    lastArtifactPath: undefined,
    requestedArtifactPath: undefined,
  })
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

describe('LivePanel：face 条（二级导航）', () => {
  it('四面切换：点击 face 驱动 live-panel-store.face，非活动面卸载', async () => {
    render(<LivePanel />)
    expect(await screen.findByText('未连接浏览器')).toBeTruthy()

    await userEvent.click(screen.getByRole('tab', { name: /交付件/ }))
    expect(useLivePanelStore.getState().face).toBe('artifacts')
    expect(screen.queryByText('未连接浏览器')).toBeNull() // 切面 = 卸载（断流/续流语义一致）

    await userEvent.click(screen.getByRole('tab', { name: /数据库/ }))
    expect(useLivePanelStore.getState().face).toBe('db')
    expect(await screen.findByText('暂无数据库操作')).toBeTruthy()

    await userEvent.click(screen.getByRole('tab', { name: /终端/ }))
    expect(useLivePanelStore.getState().face).toBe('ssh')
    expect(await screen.findByText('暂无 SSH 操作')).toBeTruthy()
  })

  it('运行中操作面脉冲点：仅对应 face 页签提示「Agent 正在执行」', async () => {
    useRunStore.setState({ active: true })
    useSessionStore.setState({ byId: new Map([['m1', makeRunningMessage()]]), order: ['m1'] })
    render(<LivePanel />)
    expect(screen.getByTitle('数据库 · Agent 正在执行')).toBeTruthy()
    expect(screen.queryByTitle('浏览器 · Agent 正在执行')).toBeNull()
    expect(screen.queryByTitle('终端 · Agent 正在执行')).toBeNull()
  })

  it('交付件未读计数徽标：显示计数；切到交付件面「看到即清零」', async () => {
    render(<LivePanel />)
    act(() => useUiStore.setState({ newArtifactCount: 3 }))
    await waitFor(() => expect(screen.getByRole('tab', { name: /交付件/ }).textContent).toContain('3'))
    await userEvent.click(screen.getByRole('tab', { name: /交付件/ }))
    await waitFor(() => expect(useUiStore.getState().newArtifactCount).toBe(0))
    await waitFor(() => expect(screen.getByRole('tab', { name: /交付件/ }).textContent).not.toContain('3'))
  })

  it('停在交付件面时新件到达（artifactVersion 变更）→ 计数立即清零', async () => {
    render(<LivePanel />)
    await userEvent.click(screen.getByRole('tab', { name: /交付件/ }))
    act(() => useUiStore.setState({ newArtifactCount: 2 }))
    act(() => useSessionStore.setState({ artifactVersion: 1 })) // 模拟 artifact:updated 双通道刷新
    await waitFor(() => expect(useUiStore.getState().newArtifactCount).toBe(0))
  })
})

describe('LivePanel：跟随控制与展开', () => {
  it('暂停跟随：按钮切换 followPaused 并给出恢复语义', async () => {
    render(<LivePanel />)
    await userEvent.click(screen.getByTitle('暂停跟随（本次运行不再自动聚焦）'))
    expect(useLivePanelStore.getState().followPaused).toBe(true)
    await userEvent.click(screen.getByTitle('恢复跟随（操作到达自动聚焦实况）'))
    expect(useLivePanelStore.getState().followPaused).toBe(false)
  })

  it('展开当前面：数据库面 → 深度工作台（deepFrom 记录返回目标）；浏览器面无展开项', async () => {
    render(<LivePanel />)
    expect(screen.queryByTitle('在主区展开数据库工作台（对象树 / SQL 编辑 / 完整交互）')).toBeNull()
    await userEvent.click(screen.getByRole('tab', { name: /数据库/ }))
    await userEvent.click(screen.getByTitle('在主区展开数据库工作台（对象树 / SQL 编辑 / 完整交互）'))
    expect(useUiStore.getState().mainTab).toBe('database')
    expect(useUiStore.getState().deepFrom).toBe('chat')
  })
})

describe('LivePanel：交付件面（跟最新 / 钉住）', () => {
  it('默认跟最新（列表最新预览）→ 点列表项钉住 → 回跟最新', async () => {
    render(<LivePanel />)
    await userEvent.click(screen.getByRole('tab', { name: /交付件/ }))
    // 文件头（title = 完整路径）落在列表最新一件
    expect(await screen.findByTitle('out/newer.png')).toBeTruthy()
    expect(screen.getByText('实时跟最新')).toBeTruthy()

    await userEvent.click(screen.getByTitle('钉住查看：out/older.png'))
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBe('out/older.png')
    expect(screen.getByTitle('out/older.png')).toBeTruthy()
    expect(screen.getByText('已钉住查看')).toBeTruthy()

    await userEvent.click(screen.getByTitle('取消钉住，回跟最新'))
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBeUndefined()
    expect(screen.getByText('实时跟最新')).toBeTruthy()
  })
})

describe('LivePanel：panel surface 不触悬浮直播窗', () => {
  it('数据库面空态「打开连接管理」→ 切应用视图且不折叠悬浮窗（无 minimize）', async () => {
    render(<LivePanel />)
    await userEvent.click(screen.getByRole('tab', { name: /数据库/ }))
    await screen.findByText('暂无数据库操作')
    await userEvent.click(screen.getByRole('button', { name: /打开连接管理/ }))
    expect(useUiStore.getState().appView).toBe('connections')
    expect(useLiveDockStore.getState().visible).toBe(false)
  })
})
