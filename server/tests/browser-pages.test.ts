/**
 * M22 浏览器回归（多标签页跟随）：感知所有页面 / 跟随激活页 / 关闭回退 / 事件隔离。
 *
 * 覆盖页面跟随设计：
 * - 感知层：Target.setDiscoverTargets + targetCreated / targetInfoChanged / targetDestroyed；
 * - 跟随规则：当前页 opener 链新页即时跟随；空白页（Ctrl+T）观察至真实导航；
 *   内部页（devtools / chrome / chrome-extension）忽略；无管理页时重新接管；
 * - 切换语义：停旧帧流 → detach 旧页 → attach 新页 → 重开采集（控制台清空 + switch_page 步骤）；
 * - 回退：当前页关闭 → 剩余页面（插入序最后）接管；无剩余 → page_closed + currentUrl 置空；
 * - 时序安全：切换只在动作边界清结（runExclusive / evaluateRaw 入口 settlePages），动作目标页稳定；
 * - 事件隔离：页面级事件按 sessionId 过滤，旧页残留事件不污染新页（browser 级事件放行）。
 *
 * FakeCdp（tests/fake-cdp.ts 共享替身）驱动真实 BrowserSession；waitFor({ms:1}) 作为
 * 「动作边界」触发器：其 runExclusive 会等待并清结已登记的页面切换，保证断言时序确定。
 */
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import type { CdpClient } from '../src/browser/cdp.js'
import {
  BrowserSession,
  type BrowserFrame,
  type BrowserSessionCallbacks,
  type BrowserSessionOptions,
  type BrowserStepRecord,
} from '../src/browser/session.js'
import { FakeCdp } from './fake-cdp.js'

const CFG = {
  browserViewportWidth: 1280,
  browserViewportHeight: 800,
  browserFrameQuality: 60,
  browserStepShots: false,
  browserScreenshotDir: path.join(os.tmpdir(), 'ma-browser-pages-test'),
} as unknown as AppConfig

function makeOptions(callbacks: Partial<BrowserSessionCallbacks> = {}): BrowserSessionOptions {
  return {
    id: 'bs_pages',
    sessionId: 's_pages',
    backend: 'local',
    endpoint: 'ws://127.0.0.1:1/fake',
    external: false,
    cfg: CFG,
    callbacks: {
      onFrame: () => undefined,
      onState: () => undefined,
      onStep: () => undefined,
      onClosed: () => undefined,
      ...callbacks,
    },
  }
}

async function makeSession(
  fake: FakeCdp,
  callbacks: Partial<BrowserSessionCallbacks> = {},
): Promise<BrowserSession> {
  const session = new BrowserSession(makeOptions(callbacks))
  await session.start(fake as unknown as CdpClient)
  return session
}

describe('M22：多标签页感知与激活页跟随（BrowserSession）', () => {
  it('启动即开启页面发现：setDiscoverTargets + 初始页面清单', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake)

    expect(fake.calls('Target.setDiscoverTargets')).toEqual([{ discover: true }])
    expect(fake.calls('Target.getTargets').length).toBeGreaterThan(0)
    expect(session.info().currentUrl).toBe('https://a.example.com/')
  })

  it('当前页打开的新页面（opener 链）自动跟随：停旧采集 → attach 新页 → 重开帧流', async () => {
    const steps: BrowserStepRecord[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake, { onStep: (step) => steps.push(step) })
    expect(session.info().currentUrl).toBe('https://a.example.com/')

    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'before-switch' }] })
    const screencasts = fake.calls('Page.startScreencast').length

    // 场景：a.example.com 点击链接（target=_blank）打开新 tab
    fake.openTarget({ targetId: 'page-2', url: 'https://b.example.com/video/42', openerId: 'page-1' })
    await session.waitFor({ ms: 1 }) // 动作边界：清结切换

    expect(fake.calls('Target.detachFromTarget')).toEqual([{ sessionId: 'cdp-session-1' }])
    expect(fake.calls('Target.attachToTarget')).toEqual([{ targetId: 'page-2', flatten: true }])
    expect(fake.calls('Page.startScreencast')).toHaveLength(screencasts + 1)
    expect(session.info().currentUrl).toBe('https://b.example.com/video/42')
    // 新页上下文：控制台清空 + 切换步骤留痕
    expect(session.consoleLog('all', 50).entries).toHaveLength(0)
    const step = steps.find((s) => s.action === 'switch_page')
    expect(step?.ok).toBe(true)
    expect(step?.args).toEqual({ from: 'https://a.example.com/', to: 'https://b.example.com/video/42' })

    // 当前页内导航（同页地址变化）：currentUrl 同步，不产生新切换
    fake.changeTargetUrl('page-2', 'https://b.example.com/other')
    await session.waitFor({ ms: 1 })
    expect(session.info().currentUrl).toBe('https://b.example.com/other')
    expect(fake.calls('Target.attachToTarget')).toHaveLength(1)
  })

  it('当前管理页被关闭：回退到剩余页面继续管理', async () => {
    const steps: BrowserStepRecord[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake, { onStep: (step) => steps.push(step) })

    fake.openTarget({ targetId: 'page-2', url: 'https://b.example.com/', openerId: 'page-1' })
    await session.waitFor({ ms: 1 })
    expect(session.info().currentUrl).toBe('https://b.example.com/')

    fake.closeTarget('page-2')
    await session.waitFor({ ms: 1 })
    expect(fake.currentTargetId).toBe('page-1')
    expect(session.info().currentUrl).toBe('https://a.example.com/')
    const step = steps.filter((s) => s.action === 'switch_page').at(-1)
    expect(step?.detail).toContain('回退')
  })

  it('空白页（Ctrl+T）先观察：真实导航后才跟随（不抢画面）', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake)

    fake.openTarget({ targetId: 'page-2', url: 'about:blank' })
    await session.waitFor({ ms: 1 })
    expect(fake.calls('Target.attachToTarget')).toHaveLength(0)
    expect(session.info().currentUrl).toBe('https://a.example.com/')

    fake.changeTargetUrl('page-2', 'https://news.example.com/')
    await session.waitFor({ ms: 1 })
    expect(fake.currentTargetId).toBe('page-2')
    expect(session.info().currentUrl).toBe('https://news.example.com/')
  })

  it('内部页（devtools / chrome / 扩展页）不纳入管理', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake)

    fake.openTarget({ targetId: 'dev-1', url: 'devtools://devtools/bundled/inspector.html' })
    fake.openTarget({ targetId: 'cfg-1', url: 'chrome://settings/' })
    fake.openTarget({ targetId: 'ext-1', url: 'chrome-extension://abcdef/panel.html' })
    await session.waitFor({ ms: 1 })

    expect(fake.calls('Target.attachToTarget')).toHaveLength(0)
    expect(session.info().currentUrl).toBe('https://a.example.com/')
  })

  it('页面级事件按 sessionId 过滤：旧页残留事件不污染新页上下文', async () => {
    const frames: BrowserFrame[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake, { onFrame: (frame) => frames.push(frame) })
    const oldSession = fake.currentSessionId

    fake.openTarget({ targetId: 'page-2', url: 'https://b.example.com/', openerId: 'page-1' })
    await session.waitFor({ ms: 1 })
    const newSession = fake.currentSessionId
    expect(newSession).not.toBe(oldSession)

    // 新页事件正常采集
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'fresh-log' }] }, newSession)
    fake.emit('Page.screencastFrame', { data: 'live-frame', sessionId: 10, metadata: {} }, newSession)
    // 旧页（已 detach）残留事件：应被过滤（后发也不覆盖新页状态）
    fake.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'old-page-error' }] }, oldSession)
    fake.emit('Page.screencastFrame', { data: 'stale-frame', sessionId: 9, metadata: {} }, oldSession)
    // browser 级 / 无归属事件：放行（兼容部分 CDP 变体）
    fake.emit('Runtime.consoleAPICalled', { type: 'info', args: [{ value: 'no-session' }] })

    const texts = session.consoleLog('all', 50).entries.map((entry) => entry.text)
    expect(texts).toContain('fresh-log')
    expect(texts).toContain('no-session')
    expect(texts).not.toContain('old-page-error')
    expect(session.getLastFrame()?.data).toBe('live-frame')
    expect(frames.map((frame) => frame.data)).toEqual(['live-frame'])
  })

  it('评估入口先清结切换：动作目标页始终与面板展示页一致', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake)

    fake.evaluateResult = (expression: string) => {
      if (expression === 'location.href') return fake.urlOf()
      if (expression === 'document.title') return `title:${fake.currentTargetId}`
      return undefined
    }
    fake.openTarget({ targetId: 'page-2', url: 'https://b.example.com/', openerId: 'page-1' })

    // 不等待：evaluateRaw 内的 settlePages 应先清结切换，再在新页求值
    const title = await session.evaluate<string>('document.title')
    expect(title).toBe('title:page-2')
    expect(session.info().currentUrl).toBe('https://b.example.com/')
  })

  it('所有页面关闭后重新接管：新页面出现即跟随', async () => {
    const steps: BrowserStepRecord[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = await makeSession(fake, { onStep: (step) => steps.push(step) })

    fake.closeTarget('page-1')
    await session.waitFor({ ms: 1 })
    expect(session.info().currentUrl).toBeUndefined()
    expect(steps.find((s) => s.action === 'page_closed')?.ok).toBe(true)

    fake.openTarget({ targetId: 'page-9', url: 'https://c.example.com/' })
    await session.waitFor({ ms: 1 })
    expect(session.info().currentUrl).toBe('https://c.example.com/')
  })
})
