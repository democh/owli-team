/**
 * LiveDock（M22+ 操作直播浮窗）单测：
 * - 手势纯函数：clampPos / snapPos / clampSize / defaultPos；
 * - 状态机：noteOp 自动滑入 / 静音 / 同 Run 去重 / 跨会话忽略 / tab 跟随与手选锁定；
 * - M49 让位协同：宽屏且右栏停在实况 → 不自动滑入（tab 对齐；不消费 autoRunId）；
 *   右栏收起（rightPanelOpen=false）不算「可见」→ 照常划入兜底；
 * - Run 生命周期：beginRun 重置静音、finishRun 3s 回落胶囊（fake timers）；
 * - 组件：三态渲染 / 胶囊点击展开 / Esc 折叠 / 数据库视图与右栏联动 / 引用计数；
 * - DockDbView surface="panel"：不触浮窗，提供「展开工作台」。
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpEvent } from '@multi-agent/shared'
import { clampPos, clampSize, defaultPos, snapPos } from '../src/lib/use-drag'
import {
  DOCK_BOTTOM_CLEARANCE,
  DOCK_DEFAULT_SIZE,
  DOCK_MAX_SIZE,
  DOCK_MIN_SIZE,
  useLiveDockStore,
} from '../src/stores/live-dock-store'
import { useBrowserStore } from '../src/stores/browser-store'
import { useConnectionsStore } from '../src/stores/connections-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'
import { LiveDock } from '../src/components/live/LiveDock'
import { DockDbView } from '../src/components/live/DockDbView'

function makeOp(over: Partial<OpEvent> = {}): OpEvent {
  return {
    id: 'op1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    runId: 'r1',
    actor: 'analyst',
    kind: 'db',
    action: 'db.query',
    status: 'ok',
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState({ currentId: 's1' })
  // M49：视口宽（jsdom 1024 > 900）；右栏默认不在实况，避免让位规则干扰既有用例
  useUiStore.setState({ rightView: 'members', rightPanelOpen: true })
  useLiveDockStore.setState({
    visible: false,
    mode: 'dock',
    tab: 'browser',
    pos: null,
    size: DOCK_DEFAULT_SIZE,
    muted: false,
    autoRunId: undefined,
    tabLockedAt: undefined,
    lastOp: undefined,
  })
  useBrowserStore.setState({ session: null, sessionId: undefined, frame: null, steps: [], streamStatus: 'closed', mode: 'watch' })
  useConnectionsStore.setState({ ops: [], sessionId: undefined })
})

describe('use-drag 手势纯函数', () => {
  it('clampPos 将窗口完整约束在视口内（含边距）', () => {
    expect(clampPos(-50, -50, 400, 300, 1200, 800)).toEqual({ x: 8, y: 8 })
    expect(clampPos(9999, 9999, 400, 300, 1200, 800)).toEqual({ x: 792, y: 492 })
    expect(clampPos(100.4, 120.6, 400, 300, 1200, 800)).toEqual({ x: 100, y: 121 })
  })

  it('snapPos 在阈值内吸附边缘，超阈值保持原位', () => {
    // 距右边 2px（阈值 14）→ 吸附到 margin 位
    expect(snapPos(790, 100, 400, 300, 1200, 800).x).toBe(792)
    // 距左边 10px → 吸附到 8
    expect(snapPos(18, 200, 400, 300, 1200, 800).x).toBe(8)
    // 中间区域不吸附
    expect(snapPos(400, 200, 400, 300, 1200, 800)).toEqual({ x: 400, y: 200 })
  })

  it('clampSize 限制在 min–max 且不超视口', () => {
    expect(clampSize(100, 100, DOCK_MIN_SIZE, DOCK_MAX_SIZE, 1200, 800)).toEqual({ w: 320, h: 200 })
    expect(clampSize(9999, 9999, DOCK_MIN_SIZE, DOCK_MAX_SIZE, 1200, 800)).toEqual({ w: 720, h: 640 })
    // 小视口：上限收敛到 视口 − 2×margin
    expect(clampSize(9999, 9999, DOCK_MIN_SIZE, DOCK_MAX_SIZE, 600, 300)).toEqual({ w: 584, h: 284 })
  })

  it('defaultPos 右下锚定并避让底部 composer 区', () => {
    expect(defaultPos(420, 320, 1200, 800, 16, DOCK_BOTTOM_CLEARANCE)).toEqual({
      x: 1200 - 420 - 16,
      y: 800 - 320 - DOCK_BOTTOM_CLEARANCE,
    })
  })
})

describe('noteOp 自动滑入规则', () => {
  it('本会话首次实况操作 → 展开为卡片并选中对应 tab', () => {
    useLiveDockStore.getState().noteOp(makeOp({ kind: 'browser', action: 'browser.navigate' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(true)
    expect(s.mode).toBe('dock')
    expect(s.tab).toBe('browser')
    expect(s.lastOp?.action).toBe('browser.navigate')
  })

  it('同一 Run 只自动弹一次；新 Run 可再次滑入', () => {
    const { noteOp } = useLiveDockStore.getState()
    noteOp(makeOp({ runId: 'r1' }))
    expect(useLiveDockStore.getState().visible).toBe(true)
    useLiveDockStore.setState({ visible: false })
    noteOp(makeOp({ id: 'op2', runId: 'r1' }))
    expect(useLiveDockStore.getState().visible).toBe(false)
    noteOp(makeOp({ id: 'op3', runId: 'r2' }))
    expect(useLiveDockStore.getState().visible).toBe(true)
  })

  it('关闭（静音）后不再自动滑入；openDock 解除静音', () => {
    useLiveDockStore.getState().close()
    useLiveDockStore.getState().noteOp(makeOp())
    expect(useLiveDockStore.getState().visible).toBe(false)
    useLiveDockStore.getState().openDock()
    expect(useLiveDockStore.getState().muted).toBe(false)
    expect(useLiveDockStore.getState().visible).toBe(true)
  })

  it('其他会话的操作事件完全忽略（连 lastOp 都不更新）', () => {
    useLiveDockStore.getState().noteOp(makeOp({ sessionId: 's2' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(false)
    expect(s.lastOp).toBeUndefined()
  })

  it('connection 类操作不驱动直播窗（仅浏览器 / 数据库实况）', () => {
    useLiveDockStore.getState().noteOp(makeOp({ kind: 'connection', action: 'connection.test' }))
    expect(useLiveDockStore.getState().visible).toBe(false)
    expect(useLiveDockStore.getState().lastOp?.action).toBe('connection.test')
  })

  it('自动滑入后跟随操作类型切 tab；用户手选后短时间内不被抢切', () => {
    const { noteOp, setTab } = useLiveDockStore.getState()
    noteOp(makeOp({ kind: 'browser', action: 'browser.navigate', runId: 'r1' }))
    expect(useLiveDockStore.getState().tab).toBe('browser')
    noteOp(makeOp({ id: 'op2', kind: 'db', action: 'db.query', runId: 'r1' }))
    expect(useLiveDockStore.getState().tab).toBe('db')

    setTab('browser') // 用户手选：60s 锁定
    noteOp(makeOp({ id: 'op3', kind: 'db', action: 'db.execute', runId: 'r1' }))
    expect(useLiveDockStore.getState().tab).toBe('browser')
  })

  it('M49 让位协同：宽屏且右栏停在实况 → 不自动滑入（仅对齐 tab，不消费 autoRunId）', () => {
    useUiStore.setState({ rightView: 'live' })
    useLiveDockStore.getState().noteOp(makeOp({ kind: 'db', action: 'db.query', runId: 'r1' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(false)
    expect(s.tab).toBe('db') // 手动展开时的对齐 tab
    expect(s.autoRunId).toBeUndefined() // 自动弹出机会未被消费
  })

  it('右栏收起（rightPanelOpen=false）不算让位 → 直播窗照常划入兜底', () => {
    useUiStore.setState({ rightView: 'live', rightPanelOpen: false })
    useLiveDockStore.getState().noteOp(makeOp({ kind: 'db', action: 'db.query', runId: 'r1' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(true)
    expect(s.tab).toBe('db')
    expect(s.autoRunId).toBe('r1')
  })

  it('M49 让位协同：离开实况后同 Run 仍可兜底滑入；手动 openDock 不受限', () => {
    useUiStore.setState({ rightView: 'live' })
    const { noteOp } = useLiveDockStore.getState()
    noteOp(makeOp({ kind: 'db', runId: 'r1' }))
    expect(useLiveDockStore.getState().visible).toBe(false)

    // 手动唤起：不受让位限制
    useLiveDockStore.getState().openDock()
    expect(useLiveDockStore.getState().visible).toBe(true)
    useLiveDockStore.setState({ visible: false, mode: 'dock' })

    // 右栏切走 → 同一 Run 仍可自动滑入
    useUiStore.setState({ rightView: 'tasks' })
    noteOp(makeOp({ id: 'op2', kind: 'ssh', runId: 'r1' }))
    const s = useLiveDockStore.getState()
    expect(s.visible).toBe(true)
    expect(s.tab).toBe('ssh')
  })
})

describe('Run 生命周期与回落（fake timers）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('finishRun 3s 后回落胶囊；期间新操作到达则取消回落', () => {
    const { noteOp, finishRun } = useLiveDockStore.getState()
    noteOp(makeOp())
    finishRun()
    vi.advanceTimersByTime(1500)
    noteOp(makeOp({ id: 'op2', action: 'db.execute' })) // 取消回落
    vi.advanceTimersByTime(5000)
    expect(useLiveDockStore.getState().mode).toBe('dock')

    finishRun()
    vi.advanceTimersByTime(3000)
    expect(useLiveDockStore.getState().mode).toBe('pill')
    expect(useLiveDockStore.getState().visible).toBe(true)
  })

  it('beginRun 重置静音与自动弹出标记（新 Run 可再次滑入）', () => {
    const { close, beginRun } = useLiveDockStore.getState()
    close()
    beginRun()
    expect(useLiveDockStore.getState().muted).toBe(false)
    useLiveDockStore.getState().noteOp(makeOp({ runId: 'r9' }))
    expect(useLiveDockStore.getState().visible).toBe(true)
  })
})

describe('LiveDock 组件三态与联动', () => {
  it('不可见时不渲染', () => {
    const { container } = render(<LiveDock />)
    expect(container.firstChild).toBeNull()
  })

  it('卡片态渲染 tabs；切换数据库 tab 展示 DB 视图', async () => {
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'browser' })
    useBrowserStore.setState({ sessionId: 's1' })
    useConnectionsStore.setState({
      sessionId: 's1',
      ops: [makeOp({ summary: 'SELECT 1', detail: 'SELECT 1' })],
    })
    render(<LiveDock />)
    expect(screen.getByText('操作直播')).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /数据库/ }))
    expect(screen.getByText('查询')).toBeTruthy()
    // 概要条与 SQL 卡均含该文本：用 pre 选择器精确定位 SQL 卡
    expect(screen.getByText('SELECT 1', { selector: 'pre' })).toBeTruthy()
  })

  it('胶囊态显示最新操作摘要，点击展开', async () => {
    useLiveDockStore.setState({ visible: true, mode: 'pill', lastOp: makeOp({ summary: 'SELECT 1' }) })
    render(<LiveDock />)
    const label = screen.getByText('数据库操作 · SELECT 1')
    expect(label).toBeTruthy()
    await userEvent.click(label)
    expect(useLiveDockStore.getState().mode).toBe('dock')
  })

  it('Esc 折叠为胶囊', async () => {
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'db' })
    useConnectionsStore.setState({ sessionId: 's1' })
    render(<LiveDock />)
    await userEvent.keyboard('{Escape}')
    expect(useLiveDockStore.getState().mode).toBe('pill')
  })

  it('数据库视图空态可跳转「连接管理」控制台并折叠浮窗', async () => {
    useUiStore.setState({ rightView: 'members', appView: 'workspace' })
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'db' })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<LiveDock />)
    await userEvent.click(screen.getByRole('button', { name: /打开连接管理/ }))
    expect(useUiStore.getState().appView).toBe('connections')
    expect(useLiveDockStore.getState().mode).toBe('pill')
  })

  it('可见时持有帧流引用，卸载释放归零才断流', () => {
    useBrowserStore.setState({ sessionId: 's1', streamStatus: 'open' })
    useLiveDockStore.setState({ visible: true, mode: 'dock', tab: 'browser' })
    const { unmount } = render(<LiveDock />)
    expect(useBrowserStore.getState().streamStatus).toBe('open')
    unmount()
    expect(useBrowserStore.getState().streamStatus).toBe('closed')
  })
})

describe('DockDbView 数据展示', () => {
  it('展示动作徽标 / SQL / 结果预览 / 失败态', () => {
    const okOp = makeOp({
      summary: 'SELECT * FROM orders',
      detail: 'SELECT * FROM orders LIMIT 5',
      durationMs: 42,
      preview: { columns: ['id', 'amount'], rows: [{ id: 1, amount: null }] },
    })
    useConnectionsStore.setState({ sessionId: 's1', ops: [okOp] })
    render(<DockDbView />)
    expect(screen.getByText('查询')).toBeTruthy()
    expect(screen.getByText('SELECT * FROM orders LIMIT 5')).toBeTruthy()
    expect(screen.getByText('id')).toBeTruthy()
    expect(screen.getByText('NULL')).toBeTruthy()
    expect(screen.getByText('结果预览')).toBeTruthy()
    expect(screen.getByText('42ms')).toBeTruthy()
  })

  it('空态提示绑定连接', () => {
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<DockDbView />)
    expect(screen.getByText(/暂无数据库操作/)).toBeTruthy()
  })

  it('M49：panel 面（surface="panel"）提供「展开工作台」，不触悬浮窗', async () => {
    useUiStore.setState({ rightView: 'members', appView: 'workspace', mainTab: 'chat', deepFrom: undefined })
    useLiveDockStore.setState({ visible: false, mode: 'dock' })
    useConnectionsStore.setState({ sessionId: 's1', ops: [] })
    render(<DockDbView surface="panel" />)
    await userEvent.click(screen.getByRole('button', { name: /展开工作台/ }))
    expect(useUiStore.getState().mainTab).toBe('database')
    expect(useUiStore.getState().deepFrom).toBe('chat')
    // panel 面内嵌右栏：不折叠 / 唤醒悬浮胶囊
    expect(useLiveDockStore.getState().visible).toBe(false)
    expect(useLiveDockStore.getState().mode).toBe('dock')
  })
})
