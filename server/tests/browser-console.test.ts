/**
 * M22 浏览器回归（诊断修复批）：控制台采集 + 输入键序 + 工具可达性。
 *
 * 覆盖修复点：
 * - 控制台采集（此前完全缺失）：Runtime.consoleAPICalled / Runtime.exceptionThrown /
 *   Log.entryAdded → 环形缓冲；级别映射、参数序列化、空白压缩、超长截断；
 *   console.clear 与主帧导航清空（子帧导航不清空）；
 * - consoleLog 级别过滤（error 含 exception；warning 含 error + exception）与 limit 取最近 N 条；
 * - 输入键序缺陷：
 *   ① fill 的「全选清空」必须走带修饰键的 dispatchKeyEvent（Meta/Ctrl+A），
 *      旧实现 `!mapped && key.length===1` 会误走 insertText('a')，从未真正全选；
 *   ② fill submit / press 的 Enter 必须成对 keyDown（text='\r'）+ keyUp，旧实现缺 keyUp；
 *   ③ press 键名大小写不敏感（'enter' → Enter）；
 * - browser_console 工具：无服务 / 无会话 / 空日志 / 正常输出（时间 + 级别 + 文本）；
 * - browser_open：复用已开会话时按 URL 对齐（同址不重复导航，异址显式导航）；
 * - browser_snapshot：include_text=true 附带页面正文文本。
 *
 * FakeCdp（tests/fake-cdp.ts 共享替身）驱动真实 BrowserSession（不依赖本机 Chrome）；
 * 工具层用真实会话对象 + 最小 ToolRuntime。
 */
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import type { CdpClient } from '../src/browser/cdp.js'
import {
  BrowserSession,
  type BrowserSessionCallbacks,
  type BrowserSessionOptions,
} from '../src/browser/session.js'
import type { BrowserRuntime } from '../src/browser/runtime.js'
import type { AgentTool, ToolRuntime } from '../src/tools/registry.js'
import { createBrowserTools } from '../src/tools/browser.js'
import { FakeCdp } from './fake-cdp.js'

const CFG = {
  browserViewportWidth: 1280,
  browserViewportHeight: 800,
  browserFrameQuality: 60,
  browserStepShots: false,
  browserScreenshotDir: path.join(os.tmpdir(), 'ma-browser-console-test'),
} as unknown as AppConfig

const CALLBACKS: BrowserSessionCallbacks = {
  onFrame: () => undefined,
  onState: () => undefined,
  onStep: () => undefined,
  onClosed: () => undefined,
}

function makeOptions(): BrowserSessionOptions {
  return {
    id: 'bs_test',
    sessionId: 's_test',
    backend: 'local',
    endpoint: 'ws://127.0.0.1:1/fake',
    external: false,
    cfg: CFG,
    callbacks: CALLBACKS,
  }
}

async function makeSession(fake: FakeCdp): Promise<BrowserSession> {
  const session = new BrowserSession(makeOptions())
  await session.start(fake as unknown as CdpClient)
  return session
}

/** 工具上下文：activeFor 返回给定会话（undefined = 无会话） */
function toolCtx(session?: BrowserSession): ToolRuntime {
  const browser = { activeFor: () => session } as unknown as BrowserRuntime
  return { sessionId: 's_test', runId: 'r_test', agentId: 'qa', browser } as unknown as ToolRuntime
}

/** browser_open 专用上下文（ensureForSession 直接返回给定会话） */
function openCtx(session: BrowserSession): ToolRuntime {
  const browser = { ensureForSession: async () => session } as unknown as BrowserRuntime
  return { sessionId: 's_test', runId: 'r_test', agentId: 'qa', browser } as unknown as ToolRuntime
}

function findTool<T>(name: string): AgentTool<T> {
  const tool = createBrowserTools().find((item) => item.name === name)
  if (!tool) throw new Error(`工具未注册：${name}`)
  return tool as unknown as AgentTool<T>
}

// ---------- 控制台采集 ----------

describe('M22：浏览器控制台采集（BrowserSession）', () => {
  it('consoleAPICalled / exceptionThrown / Log.entryAdded 采集：级别映射与参数序列化', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)
    expect(fake.calls('Log.enable')).toHaveLength(1) // 资源加载错误依赖 Log 域

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }, { value: 42 }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'careful' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'info', args: [{ value: 'fyi' }] })
    fake.emit('Runtime.exceptionThrown', {
      exceptionDetails: { exception: { description: 'TypeError: x is not a function' } },
    })
    fake.emit('Log.entryAdded', { entry: { level: 'error', text: 'Failed to load resource: 404' } })

    const all = session.consoleLog('all', 50)
    expect(all.total).toBe(6)
    expect(all.entries.map((entry) => entry.level)).toEqual([
      'log',
      'warning',
      'error',
      'info',
      'exception',
      'error',
    ])
    expect(all.entries[0].text).toBe('hello 42')
    expect(all.entries[4].text).toBe('TypeError: x is not a function')
    // seq 单调递增
    expect(all.entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('参数序列化：对象 JSON 化 / description 兜底 / 类型占位 / 空白压缩与超长截断', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: { a: 1 } }] })
    fake.emit('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ description: 'Error: custom', type: 'object' }],
    })
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'undefined' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'a   b\n\tc' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '   ' }] }) // 空白文本丢弃
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '长'.repeat(700) }] })

    const { entries, total } = session.consoleLog('all', 50)
    expect(total).toBe(5) // 空白文本不产生条目
    expect(entries[0].text).toBe('{"a":1}')
    expect(entries[1].text).toBe('Error: custom')
    expect(entries[2].text).toBe('<undefined>')
    expect(entries[3].text).toBe('a b c')
    expect(entries[4].text.endsWith('…')).toBe(true)
    expect(entries[4].text.length).toBe(601)
  })

  it('console.clear 清空缓冲；主帧导航清空、子帧导航不清空', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'one' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'two' }] })
    expect(session.consoleLog().total).toBe(2)

    fake.emit('Runtime.consoleAPICalled', { type: 'clear' })
    expect(session.consoleLog().total).toBe(0)

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'three' }] })
    fake.emit('Page.frameNavigated', { frame: { url: 'https://sub.example.com/frame', parentId: 'p1' } })
    expect(session.consoleLog().total).toBe(1) // 子帧导航不清空
    expect(session.currentUrl).toBeUndefined() // 子帧不更新当前地址

    fake.emit('Page.frameNavigated', { frame: { url: 'https://example.com/next' } })
    expect(session.consoleLog().total).toBe(0) // 主帧导航清空
    expect(session.currentUrl).toBe('https://example.com/next')
  })

  it('consoleLog 级别过滤：error 含 exception；warning 含 error + exception；limit 取最近 N 条', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'l' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'info', args: [{ value: 'i' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'warning', args: [{ value: 'w' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'e' }] })
    fake.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught' } })

    expect(session.consoleLog('error').total).toBe(2)
    expect(session.consoleLog('warning').total).toBe(3)
    expect(session.consoleLog('all').total).toBe(5)

    const limited = session.consoleLog('all', 2)
    expect(limited.total).toBe(5)
    expect(limited.entries.map((entry) => entry.text)).toEqual(['e', 'Uncaught'])
  })
})

// ---------- 输入键序 ----------

describe('M22：浏览器输入键序（fill / press）', () => {
  it('press 键名大小写不敏感：enter → Enter 的 keyDown(text=\\r) + keyUp 成对', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)

    await session.press('enter')

    const events = fake.calls('Input.dispatchKeyEvent')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      text: '\r',
    })
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(events[1].text).toBeUndefined()
    expect(fake.calls('Input.insertText')).toHaveLength(0)
  })

  it('press 普通功能键：ArrowDown 走 dispatchKeyEvent（无 text）', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)

    await session.press('ArrowDown')

    const events = fake.calls('Input.dispatchKeyEvent')
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      type: 'keyDown',
      key: 'ArrowDown',
      code: 'ArrowDown',
      windowsVirtualKeyCode: 40,
    })
    expect(events[0].text).toBeUndefined()
    expect(events[1]).toMatchObject({ type: 'keyUp', key: 'ArrowDown' })
  })

  it('fill 全选清空：Meta/Ctrl+A 走 dispatchKeyEvent（带修饰键），文本经 insertText 一次', async () => {
    const fake = new FakeCdp()
    fake.evaluateResult = (expression: string) =>
      expression.includes('scrollIntoView') ? { ok: true, x: 100, y: 100 } : undefined
    const session = await makeSession(fake)

    await session.fill('#q', 'hello')

    // 全选：keyDown + keyUp（带修饰键），而不是 insertText('a') 插入字符
    const keyA = fake.calls('Input.dispatchKeyEvent').filter((params) => params.key === 'a')
    expect(keyA).toHaveLength(2)
    expect(keyA.map((params) => params.type)).toEqual(['keyDown', 'keyUp'])
    expect(keyA[0]).toMatchObject({ code: 'KeyA', windowsVirtualKeyCode: 65 })
    expect(Number(keyA[0].modifiers)).toBeGreaterThan(0)
    expect(Number(keyA[1].modifiers)).toBeGreaterThan(0)

    // 文本输入恰一次（且不是 'a'）
    const inserts = fake.calls('Input.insertText')
    expect(inserts).toHaveLength(1)
    expect(inserts[0].text).toBe('hello')

    // 先聚焦（鼠标 down/up）再输入
    const mouseTypes = fake.calls('Input.dispatchMouseEvent').map((params) => params.type)
    expect(mouseTypes).toEqual(['mousePressed', 'mouseReleased'])
  })

  it('fill submit：Enter 成对 keyDown(text=\\r) + keyUp（旧实现缺 keyUp）', async () => {
    const fake = new FakeCdp()
    fake.evaluateResult = (expression: string) =>
      expression.includes('scrollIntoView') ? { ok: true, x: 10, y: 20 } : undefined
    const session = await makeSession(fake)

    await session.fill('#q', 'hi', { submit: true })

    const enters = fake.calls('Input.dispatchKeyEvent').filter((params) => params.key === 'Enter')
    expect(enters).toHaveLength(2)
    expect(enters[0]).toMatchObject({ type: 'keyDown', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    expect(enters[1]).toMatchObject({ type: 'keyUp', code: 'Enter' })
    expect(enters[1].text).toBeUndefined()

    // 键序：全选（带修饰键）→ 文本 → 回车
    const sequence = fake.sent
      .filter((item) => item.method === 'Input.dispatchKeyEvent' || item.method === 'Input.insertText')
      .map((item) =>
        item.method === 'Input.insertText'
          ? `text:${String(item.params.text)}`
          : `${String(item.params.type)}:${String(item.params.key)}`,
      )
    expect(sequence).toEqual(['keyDown:a', 'keyUp:a', 'text:hi', 'keyDown:Enter', 'keyUp:Enter'])
  })
})

// ---------- browser_console 工具 ----------

describe('M22：browser_console 工具', () => {
  type ConsoleArgs = { level: 'all' | 'warning' | 'error'; limit: number }
  const args: ConsoleArgs = { level: 'all', limit: 50 }

  it('未装配浏览器运行时时给出明确提示', async () => {
    const ctx = { sessionId: 's_test', runId: 'r_test', agentId: 'qa' } as unknown as ToolRuntime
    const res = await findTool<typeof args>('browser_console').execute(args, ctx)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('未启用')
  })

  it('无活跃会话时提示先 browser_open', async () => {
    const res = await findTool<typeof args>('browser_console').execute(args, toolCtx())
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('没有打开的浏览器')
  })

  it('空缓冲返回「控制台无日志」', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)
    const res = await findTool<typeof args>('browser_console').execute(args, toolCtx(session))
    expect(res.ok).toBe(true)
    expect(res.summary).toBe('控制台无日志')
  })

  it('正常输出：[HH:MM:SS] [级别] 文本，按 level 过滤', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }] })
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] })
    fake.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught TypeError' } })

    const all = await findTool<typeof args>('browser_console').execute(args, toolCtx(session))
    expect(all.ok).toBe(true)
    expect(all.summary).toContain('3 条')
    expect(all.detail).toMatch(/\[\d{2}:\d{2}:\d{2}\] \[log\] hello/)
    expect(all.detail).toMatch(/\[\d{2}:\d{2}:\d{2}\] \[error\] boom/)
    expect(all.detail).toMatch(/\[\d{2}:\d{2}:\d{2}\] \[exception\] Uncaught TypeError/)

    const errors = await findTool<typeof args>('browser_console').execute(
      { level: 'error', limit: 50 },
      toolCtx(session),
    )
    expect(errors.summary).toContain('2 条')
    expect(errors.detail).toContain('boom')
    expect(errors.detail).not.toContain('hello')
  })
})

// ---------- browser_open / browser_snapshot ----------

describe('M22：browser_open 与 browser_snapshot', () => {
  it('browser_open：复用已开会话且地址一致（忽略协议/尾斜杠差异）时不重复导航', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)
    session.currentUrl = 'https://example.com/'

    const res = await findTool<{ url?: string; system: boolean }>('browser_open').execute(
      { url: 'https://example.com', system: false },
      openCtx(session),
    )
    expect(res.ok).toBe(true)
    expect(fake.calls('Page.navigate')).toHaveLength(0)
  })

  it('browser_open：复用会话但目标地址不同时显式导航', async () => {
    const fake = new FakeCdp()
    const session = await makeSession(fake)
    session.currentUrl = 'https://example.com/'

    const res = await findTool<{ url?: string; system: boolean }>('browser_open').execute(
      { url: 'https://other.example.com/page', system: false },
      openCtx(session),
    )
    expect(res.ok).toBe(true)
    const nav = fake.calls('Page.navigate')
    expect(nav).toHaveLength(1)
    expect(nav[0].url).toBe('https://other.example.com/page')
  })

  it('browser_snapshot：include_text=true 附带页面正文，false 不附带', async () => {
    const fake = new FakeCdp()
    fake.evaluateResult = (expression: string) => {
      if (expression.includes('querySelectorAll')) {
        return [{ index: 0, tag: 'button', text: 'Go', selector: 'button:nth-of-type(1)' }]
      }
      if (expression.includes('innerText')) return '这是页面正文\n\n\n第二段'
      return undefined
    }
    const session = await makeSession(fake)

    const withText = await findTool<{ include_text: boolean }>('browser_snapshot').execute(
      { include_text: true },
      toolCtx(session),
    )
    expect(withText.ok).toBe(true)
    expect(withText.detail).toContain('可交互元素（1 个）')
    expect(withText.detail).toContain('页面文本')
    expect(withText.detail).toContain('这是页面正文')

    const withoutText = await findTool<{ include_text: boolean }>('browser_snapshot').execute(
      { include_text: false },
      toolCtx(session),
    )
    expect(withoutText.detail).not.toContain('页面文本')
  })

  it('工具清单：13 个 browser_* 工具（含 browser_console）', () => {
    const names = createBrowserTools().map((tool) => tool.name)
    expect(names).toHaveLength(13)
    expect(names).toContain('browser_console')
    expect(names).toContain('browser_snapshot')
    expect(names).toContain('browser_request_human')
  })
})
