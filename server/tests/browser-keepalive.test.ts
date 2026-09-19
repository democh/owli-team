/**
 * M22 CDP 保活回归（韧性增强批）：半开连接检测。
 *
 * 场景：TCP 半开（睡眠唤醒 / NAT 静默丢包）时，ws 客户端不触发 close——
 * 连接僵尸化，后续命令全部超时。保活策略：静默一个周期发协议 ping；
 * 再过一周期仍无任何入站（pong / 消息）判定已死 → terminate → onUnexpectedClose。
 *
 * 用真实 WebSocketServer 替身（ws 库）驱动真实 CdpClient：
 * - autoPong=true 模拟健康端点（回 pong）：连接保持；
 * - autoPong=false + 静默模拟半开端点：两周期内被判定并触发 close 事件；
 * - autoPong=false + 主动推消息模拟「有入站的慢端点」：不误杀。
 */
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { CdpClient } from '../src/browser/cdp.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  // 逆序清理：后建资源先释放（否则 wss.close 会等待仍存活的客户端连接而挂起）
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function makeServer(opts: { autoPong: boolean }): Promise<{ sockets: WebSocket[]; url: string }> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: opts.autoPong })
  const sockets: WebSocket[] = []
  wss.on('connection', (socket) => sockets.push(socket)) // connect 前注册，避免丢事件
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
  cleanups.push(async () => {
    // 兜底 terminate 残留连接：wss.close 仅在无存活客户端时才回调
    for (const socket of sockets) socket.terminate()
    await new Promise<void>((resolve) => wss.close(() => resolve()))
  })
  const port = (wss.address() as AddressInfo).port
  return { sockets, url: `ws://127.0.0.1:${port}` }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等待 close 事件（超时返回 undefined） */
function waitClose(client: CdpClient, timeoutMs: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    client.onUnexpectedClose((reason) => {
      clearTimeout(timer)
      resolve(reason)
    })
  })
}

describe('M22：CDP 保活（半开连接检测）', () => {
  it('健康端点（回 pong）：连接保持，不误判', async () => {
    const { url } = await makeServer({ autoPong: true })
    const client = new CdpClient({ keepaliveMs: 60 })
    cleanups.push(() => client.close())
    await client.connect(url)
    const closed = waitClose(client, 400)

    await sleep(300)
    expect(await closed).toBeUndefined()
    expect(client.connected).toBe(true)
    // 连接仍可用：命令有正常响应通道（测试端点不解析命令，用超时证明存活而非立即失败）
    await expect(client.send('Runtime.evaluate', {}, { timeoutMs: 30 })).rejects.toThrow(/超时/)
    expect(client.connected).toBe(true)
  })

  it('半开端点（不回 pong / 无入站）：两周期内判定并触发 close', async () => {
    const { url } = await makeServer({ autoPong: false })
    const client = new CdpClient({ keepaliveMs: 60 })
    cleanups.push(() => client.close())
    await client.connect(url)

    const started = Date.now()
    const reason = await waitClose(client, 1_000)
    const elapsed = Date.now() - started
    expect(reason).toBeDefined() // terminate 触发 close → 会话层据此重连
    expect(elapsed).toBeGreaterThanOrEqual(100) // 至少一个完整静默周期 + 一个探测周期
    expect(elapsed).toBeLessThan(800)
    expect(client.connected).toBe(false)
    // 判定后命令立刻明确失败（不再傻等 15s 超时）
    await expect(client.send('Runtime.evaluate', {}, { timeoutMs: 5_000 })).rejects.toThrow(/未连接/)
  })

  it('慢但活（有入站消息）：保活不误杀', async () => {
    const { sockets, url } = await makeServer({ autoPong: false })
    const client = new CdpClient({ keepaliveMs: 60 })
    cleanups.push(() => client.close())
    await client.connect(url)
    const target = sockets[0]
    if (!target) throw new Error('服务端未收到连接')
    const ticker = setInterval(() => {
      if (target.readyState === target.OPEN) target.send(JSON.stringify({ method: 'Page.loadEventFired', params: {} }))
    }, 30)
    cleanups.push(() => clearInterval(ticker))

    const closed = waitClose(client, 400)
    await sleep(300)
    expect(await closed).toBeUndefined() // 入站消息刷新静默窗口
    expect(client.connected).toBe(true)
  })

  it('keepaliveMs=0：关闭保活（显式关闭开关）', async () => {
    const { url } = await makeServer({ autoPong: false })
    const client = new CdpClient({ keepaliveMs: 0 })
    cleanups.push(() => client.close())
    await client.connect(url)

    const closed = waitClose(client, 300)
    await sleep(200)
    expect(await closed).toBeUndefined()
    expect(client.connected).toBe(true)
  })
})
