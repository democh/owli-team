/**
 * M22 浏览器断线自愈回归（韧性增强批）：CDP 连接意外断开后的自动重连与动作等待。
 *
 * 覆盖设计：
 * - 断线入口：onUnexpectedClose → handleDisconnect（同一时刻仅一个重连任务）；
 * - 重连语义：同端点新建连接 → 重挂原管理页（preferTargetId）→ 恢复域 / 事件 / 帧流；
 *   旧连接的事件订阅全部迁移（旧连接后续事件不再被消费）；
 * - 退避与耗尽：reconnectDelaysMs 序列逐次重试；全部失败才 closed + error + onClosed；
 * - 动作等待：重连期间 runExclusive / evaluateRaw / 人工输入先等待恢复结果，
 *   不向调用方回放连接中断噪音；恢复后在「新连接」上执行；
 * - 控制权保持：人工接管（human）中重连不把控制权打回 agent；
 * - 信息面：headless 缺省无头、external 显式透传。
 *
 * FakeCdp（tests/fake-cdp.ts 共享替身）驱动真实 BrowserSession：emitClose 模拟断线，
 * cdpFactory 注入新连接，connectBehavior 注入连接失败。
 */
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { BrowserState } from '@multi-agent/shared'
import type { AppConfig } from '../src/config.js'
import type { CdpClient } from '../src/browser/cdp.js'
import {
  BrowserSession,
  type BrowserSessionCallbacks,
  type BrowserSessionOptions,
} from '../src/browser/session.js'
import { FakeCdp } from './fake-cdp.js'

const CFG = {
  browserViewportWidth: 1280,
  browserViewportHeight: 800,
  browserFrameQuality: 60,
  browserStepShots: false,
  browserScreenshotDir: path.join(os.tmpdir(), 'ma-browser-resilience-test'),
} as unknown as AppConfig

const ENDPOINT = 'ws://127.0.0.1:1/fake'

function makeOptions(
  callbacks: Partial<BrowserSessionCallbacks> = {},
  extra: Partial<BrowserSessionOptions> = {},
): BrowserSessionOptions {
  return {
    id: 'bs_resilience',
    sessionId: 's_resilience',
    backend: 'local',
    endpoint: ENDPOINT,
    external: false,
    cfg: CFG,
    callbacks: {
      onFrame: () => undefined,
      onState: () => undefined,
      onStep: () => undefined,
      onClosed: () => undefined,
      ...callbacks,
    },
    reconnectDelaysMs: [1, 1, 1],
    ...extra,
  }
}

/** 轮询等待条件成立（避免固定延时的时序脆弱） */
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (cond()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待条件超时')
}

describe('M22：浏览器断线自愈（BrowserSession）', () => {
  it('断线后自动重连：重挂原管理页 + 恢复域与帧流 + 步骤留痕', async () => {
    const states: BrowserState[] = []
    const steps: Array<{ action: string; ok: boolean; detail?: string }> = []
    const frames: string[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = new BrowserSession(
      makeOptions(
        {
          onState: (state) => states.push(state),
          onStep: (step) => steps.push({ action: step.action, ok: step.ok, detail: step.detail }),
          onFrame: (frame) => frames.push(frame.data),
        },
        { cdpFactory: () => next as unknown as CdpClient },
      ),
    )
    await session.start(fake as unknown as CdpClient)
    expect(session.info().state).toBe('ready')

    fake.emitClose('socket hang up')
    expect(session.info().state).toBe('reconnecting') // 断线即时进入重连态
    await waitFor(() => session.isClosed() || session.info().state === 'ready')

    // 新连接：同端点建立 + 重挂原管理页（preferTargetId 命中，不新建页面）
    expect(next.connectCalls).toEqual([{ url: ENDPOINT }])
    expect(next.calls('Target.attachToTarget')).toEqual([{ targetId: 'page-1', flatten: true }])
    expect(next.calls('Target.getTargets').length).toBeGreaterThan(0)
    // 域与帧流恢复
    expect(next.calls('Page.enable')).toHaveLength(1)
    expect(next.calls('Runtime.enable')).toHaveLength(1)
    expect(next.calls('Page.startScreencast')).toHaveLength(1)
    expect(next.calls('Target.setDiscoverTargets')).toEqual([{ discover: true }])
    // 步骤与状态：reconnecting → ready，reconnect 步骤留痕
    expect(steps.find((step) => step.action === 'reconnect')?.ok).toBe(true)
    expect(steps.find((step) => step.action === 'reconnect')?.detail).toContain('第 1 次尝试')
    expect(states).toContain('reconnecting')
    expect(session.info().state).toBe('ready')
    expect(session.isClosed()).toBe(false)

    // 帧流恢复：新连接推出帧
    next.emit('Page.screencastFrame', { data: 'revived', sessionId: 1, metadata: {} }, next.currentSessionId)
    expect(session.getLastFrame()?.data).toBe('revived')
    expect(frames).toContain('revived')

    // 事件订阅迁移：旧连接后续事件不再被消费
    const consoleBefore = session.consoleLog('all', 50).total
    fake.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'stale-from-dead' }] })
    expect(session.consoleLog('all', 50).total).toBe(consoleBefore)
  })

  it('重连期间动作入口等待恢复：evaluate 与人工输入落在新连接上', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    next.evaluateResult = (expression: string) => (expression === 'document.title' ? 'Recovered' : undefined)
    const session = new BrowserSession(
      makeOptions(
        {},
        {
          cdpFactory: () => next as unknown as CdpClient,
          reconnectDelaysMs: [30, 1], // 首个退避 30ms：给动作先于恢复发起的时间窗
        },
      ),
    )
    await session.start(fake as unknown as CdpClient)

    fake.emitClose('network down')
    // 断线后立即发起动作：应等待重连完成后在新连接上执行（旧连接不收到该命令）
    const title = await session.evaluate<string>('document.title')
    expect(title).toBe('Recovered')
    expect(next.calls('Runtime.evaluate').length).toBeGreaterThan(0)
    expect(fake.calls('Runtime.evaluate')).toHaveLength(0)

    await session.handleHumanInput({ kind: 'text', text: 'hello' })
    expect(next.calls('Input.insertText')).toEqual([{ text: 'hello' }])
    expect(fake.calls('Input.insertText')).toHaveLength(0)
  })

  it('人工接管中重连：控制权与状态保持（human 不被打回 ready）', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const session = new BrowserSession(
      makeOptions({}, { cdpFactory: () => next as unknown as CdpClient }),
    )
    await session.start(fake as unknown as CdpClient)
    await session.takeover('user')
    expect(session.info().state).toBe('human')

    fake.emitClose('wifi recovered')
    await waitFor(() => next.connectCalls.length === 1 && session.info().state === 'human')
    expect(session.info().controller).toBe('human')
    expect(next.calls('Page.startScreencast')).toHaveLength(1)
  })

  it('重试退避：前次连接失败后继续重试，成功即恢复（不落 error）', async () => {
    const steps: Array<{ action: string; detail?: string }> = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    next.connectBehavior = (attempt) => {
      if (attempt <= 1) throw new Error('connect ECONNREFUSED')
    }
    const session = new BrowserSession(
      makeOptions(
        { onStep: (step) => steps.push({ action: step.action, detail: step.detail }) },
        { cdpFactory: () => next as unknown as CdpClient, reconnectDelaysMs: [1, 1, 1] },
      ),
    )
    await session.start(fake as unknown as CdpClient)

    fake.emitClose('browser restarting')
    await waitFor(() => session.info().state === 'ready')
    expect(next.connectCalls).toHaveLength(2) // 第 1 次失败 + 第 2 次成功
    expect(steps.find((step) => step.action === 'reconnect')?.detail).toContain('第 2 次尝试')
    expect(session.isClosed()).toBe(false)
  })

  it('重试耗尽：落 error + onClosed，废弃连接被关闭', async () => {
    const reasons: string[] = []
    const states: BrowserState[] = []
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const dead = new FakeCdp()
    dead.connectBehavior = () => {
      throw new Error('connect ECONNREFUSED')
    }
    const session = new BrowserSession(
      makeOptions(
        { onClosed: (reason) => reasons.push(reason), onState: (state) => states.push(state) },
        { cdpFactory: () => dead as unknown as CdpClient, reconnectDelaysMs: [1, 1] },
      ),
    )
    await session.start(fake as unknown as CdpClient)

    fake.emitClose('browser crashed')
    await waitFor(() => session.isClosed())
    expect(dead.connectCalls).toHaveLength(2)
    expect(dead.closeCalls).toBe(2) // 每个失败尝试的连接都被关闭
    expect(session.info().state).toBe('error')
    expect(states).toContain('error')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain('browser crashed')
  })

  it('信息面：headless 缺省无头、external 显式透传', async () => {
    const headless = new BrowserSession(makeOptions())
    await headless.start(new FakeCdp() as unknown as CdpClient)
    expect(headless.info().headless).toBe(true)
    expect(headless.info().external).toBe(false) // 默认非复用

    const headed = new BrowserSession(makeOptions({}, { headless: false }))
    await headed.start(new FakeCdp() as unknown as CdpClient)
    expect(headed.info().headless).toBe(false)

    const reused = new BrowserSession(makeOptions({}, { external: true }))
    await reused.start(new FakeCdp() as unknown as CdpClient)
    expect(reused.info().external).toBe(true)
  })

  it('会话主动关闭后：断线事件不再触发重连', async () => {
    const fake = new FakeCdp({ initialUrl: 'https://a.example.com/' })
    const next = new FakeCdp()
    const session = new BrowserSession(
      makeOptions({}, { cdpFactory: () => next as unknown as CdpClient }),
    )
    await session.start(fake as unknown as CdpClient)
    await session.close('用户关闭')

    fake.emitClose('late close event')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(next.connectCalls).toHaveLength(0)
    expect(session.info().state).toBe('closed')
  })
})
