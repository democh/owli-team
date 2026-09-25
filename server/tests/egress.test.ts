/**
 * M82：联网出口层测试。
 * - 纯函数：配置解析 / EGRESS_PROXY_URL 后备 / 旁路匹配（回环 / 域后缀 / CIDR）/ 凭据脱敏 / 出口 IP 提取；
 * - 运行时：路由解析（未配置 / 通道门控 / 旁路 / 连接缺失 / 后备优先级）、经代理请求、失败回退与严格模式、
 *   降级冷却（连续 2 次失败 60s 内不再重撞代理）、Abort 语义、探测（出口 IP / 连接不存在）；
 * - 集成：antiBotFetch 经出口层（成功标注 / 通道隔离 / egress 错误不冷却目标 host）。
 *
 * 假代理：CONNECT + 绝对 URI 转发（统一落到本地目标服务），支持 Basic 鉴权与固定目标映射，
 * 使测试可用「非回环假域名」（site.test / probe.test）走代理路径（回环域名恒直连，无法用于代理用例）。
 */
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadConfig, type AppConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { openDatabase } from '../src/store/db.js'
import { ConnectionStore } from '../src/store/connections.js'
import { AuditStore } from '../src/store/audit.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createConnectionsRouter } from '../src/routes/connections.js'
import { createSettingsRouter } from '../src/routes/settings.js'
import type { AuthUser } from '../src/auth/service.js'
import {
  configureEgress,
  EgressError,
  EgressRuntime,
  egressNoteOf,
  extractExitIp,
  hostBypassed,
  maskUrl,
  parseEgressProxyUrl,
  parseEgressTarget,
} from '../src/net/egress.js'
import { AntiBotError, antiBotFetch, resetAntiBotState } from '../src/tools/http.js'
import type { ToolRuntime } from '../src/tools/registry.js'
import { webFetchTool } from '../src/tools/web_fetch.js'
import { makeEnv as makeFullEnv, makeTmpDir } from './helpers.js'

// ---------- 环境与假服务 ----------

interface Env {
  dir: string
  cfg: AppConfig
  connections: ConnectionStore
  runtime: EgressRuntime
}

/** 隔离环境：临时 data 目录 + 真实 SQLite + 加密库；出口字段显式置默认（不受本机 .env 影响） */
function makeEnv(overrides: Partial<AppConfig> = {}): Env {
  const dir = makeTmpDir('ma-egress-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    // 隔离运行期设置文件（PUT /api/settings 用例绝不污染仓库真实 data/settings.json）
    settingsFile: path.join(dir, 'settings.json'),
    logLevel: 'silent',
    egressMode: 'direct',
    egressConnectionId: '',
    egressProxyUrl: '',
    egressChannels: ['search', 'finance', 'browser'],
    egressNoProxy: [],
    egressFallback: 'direct',
    egressProbeUrl: 'http://probe.test/echo',
    ...overrides,
  }
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  return { dir, cfg, connections, runtime: new EgressRuntime({ cfg, connections }) }
}

/** 目标服务：按路径返回内容（/echo 回显 JSON IP；其余返回 HTML） */
function startTarget(): Promise<{ port: number; close: () => Promise<void>; hits: string[] }> {
  const hits: string[] = []
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '/')
    if ((req.url ?? '').startsWith('/echo')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ip: '203.0.113.7' }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end('<html><head><title>出口目标</title></head><body><p>出口目标正文</p></body></html>')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
        hits,
      })
    })
  })
}

interface FakeProxy {
  port: number
  /** 代理侧观察到的请求（method/url/auth；CONNECT 记 method=CONNECT） */
  seen: Array<{ method: string; url: string; auth?: string }>
  /** 请求计数（用于断言「冷却期内不再重撞代理」） */
  count: () => number
  close: () => Promise<void>
}

/**
 * 假 HTTP 代理：全部请求（绝对 URI 与 CONNECT）一律转发到 targetPort（忽略目标 host），
 * 支持 Basic 鉴权（auth 为期望的 proxy-authorization 原值，不匹配返回 407）。
 */
function startFakeProxy(opts: { targetPort: number; auth?: string; dead?: boolean }): Promise<FakeProxy> {
  const seen: FakeProxy['seen'] = []
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method ?? 'GET', url: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined })
    if (opts.dead) {
      req.socket.destroy()
      return
    }
    if (opts.auth && req.headers['proxy-authorization'] !== opts.auth) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' })
      res.end('auth required')
      return
    }
    const url = new URL(req.url ?? '/', 'http://placeholder')
    const up = http.request(
      {
        host: '127.0.0.1',
        port: opts.targetPort,
        path: url.pathname + url.search,
        method: req.method,
        headers: { ...req.headers, host: url.host },
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers)
        upRes.pipe(res)
      },
    )
    up.on('error', (err) => {
      res.writeHead(502)
      res.end(String(err))
    })
    req.pipe(up)
  })
  server.on('connect', (req, clientSocket, head) => {
    seen.push({ method: 'CONNECT', url: req.url ?? '', auth: req.headers['proxy-authorization'] as string | undefined })
    if (opts.auth && req.headers['proxy-authorization'] !== opts.auth) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const serverSocket = net.connect(opts.targetPort, '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) serverSocket.write(head)
      serverSocket.pipe(clientSocket)
      clientSocket.pipe(serverSocket)
    })
    serverSocket.on('error', () => clientSocket.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        seen,
        count: () => seen.length,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** 假 SOCKS5 服务器（RFC 1928/1929 最小实现）：无鉴权 / 账号口令，忽略目标地址一律转发到 targetPort（便于假域名用例） */
function startFakeSocks5(opts: { targetPort: number; auth?: { user: string; pass: string } }): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => {
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting'
    let buf = Buffer.alloc(0)
    let upstream: net.Socket | undefined
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        // 隧道态：后续字节直通上游（上游未就绪时继续缓冲，就绪后补发）
        if (stage === 'tunnel') {
          if (upstream) {
            upstream.write(buf)
            buf = Buffer.alloc(0)
          }
          return
        }
        if (stage === 'greeting') {
          if (buf.length < 2) return
          const nmethods = buf[1]!
          if (buf.length < 2 + nmethods) return
          const methods = buf.subarray(2, 2 + nmethods)
          const method = opts.auth ? (methods.includes(0x02) ? 0x02 : 0xff) : 0x00
          buf = buf.subarray(2 + nmethods)
          if (method === 0xff) {
            socket.end(Buffer.from([0x05, 0xff]))
            return
          }
          socket.write(Buffer.from([0x05, method]))
          stage = opts.auth ? 'auth' : 'request'
          continue
        }
        if (stage === 'auth') {
          if (buf.length < 2) return
          const ulen = buf[1]!
          if (buf.length < 3 + ulen) return
          const plen = buf[2 + ulen]!
          if (buf.length < 3 + ulen + plen) return
          const user = buf.subarray(2, 2 + ulen).toString()
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
          buf = buf.subarray(3 + ulen + plen)
          const ok = opts.auth !== undefined && user === opts.auth.user && pass === opts.auth.pass
          socket.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
          if (!ok) {
            socket.end()
            return
          }
          stage = 'request'
          continue
        }
        // request：VER CMD RSV ATYP ADDR PORT（仅支持 CONNECT；地址（含域名，远端 DNS）解析后忽略）
        if (buf.length < 5) return
        const atyp = buf[3]
        let need: number
        if (atyp === 0x01) need = 10
        else if (atyp === 0x03) need = 7 + buf[4]!
        else if (atyp === 0x04) need = 22
        else {
          socket.end(Buffer.from([0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
          return
        }
        if (buf.length < need) return
        buf = buf.subarray(need)
        stage = 'tunnel'
        const up = net.connect(opts.targetPort, '127.0.0.1', () => {
          upstream = up
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0, 0]))
          if (buf.length > 0) up.write(buf)
          buf = Buffer.alloc(0)
          up.pipe(socket)
          socket.pipe(up)
        })
        up.on('error', () => socket.destroy())
        return
      }
    }
    socket.on('data', onData)
    socket.on('error', () => undefined)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

/** 建一个出口代理连接（返回 connectionId；secret 可给凭据） */
function createProxyConnection(
  env: Env,
  config: Record<string, unknown>,
  secret?: Record<string, unknown>,
): string {
  const connection = env.connections.create({ name: `代理-${Math.random().toString(36).slice(2, 8)}`, kind: 'proxy', config, ...(secret ? { secret } : {}) })
  return connection.id
}

/** 直连 fetch 桩（回退 / 旁路路径断言用） */
function stubDirectFetch(handler?: (url: string) => Response): { calls: string[] } {
  const calls: string[] = []
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const href = String(url)
    calls.push(href)
    return handler ? handler(href) : new Response('direct-ok', { status: 200, headers: { 'content-type': 'text/plain' } })
  })
  return { calls }
}

beforeEach(() => {
  resetAntiBotState()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------- 纯函数：配置解析 ----------

describe('M82：出口配置解析（连接 config + secret）', () => {
  it('HTTP 代理：默认端口与凭据归一；非法配置给出中文原因', () => {
    const ok = parseEgressTarget({ mode: 'http', scheme: 'https', host: ' proxy.corp.io ', port: 3128, bypass: [' *.corp.io '] }, { username: ' u ', password: 'p' })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.target).toMatchObject({ mode: 'http', scheme: 'https', host: 'proxy.corp.io', port: 3128, username: 'u', password: 'p', bypass: ['*.corp.io'] })
    }
    expect(parseEgressTarget({ mode: 'http', host: '', port: 1 })).toMatchObject({ ok: false })
    expect(parseEgressTarget({ mode: 'http', host: 'a/b', port: 1 })).toMatchObject({ ok: false })
    expect(parseEgressTarget({ mode: 'http', host: 'h', port: 0 })).toMatchObject({ ok: false })
    expect(parseEgressTarget({ mode: 'http', host: 'h', port: 70_000 })).toMatchObject({ ok: false })
    expect(parseEgressTarget({ mode: 'http', host: 'h', port: 80, scheme: 'ftp' })).toMatchObject({ ok: false })
    // SSH 隧道为 P1：创建期显式拒绝（避免「建了不生效」）
    const ssh = parseEgressTarget({ mode: 'ssh', sshConnectionId: 'conn_x' })
    expect(ssh.ok).toBe(false)
    if (!ssh.ok) expect(ssh.error).toContain('P1')
  })

  it('SOCKS5：忽略 scheme；凭据可缺省', () => {
    const ok = parseEgressTarget({ mode: 'socks5', host: '127.0.0.1', port: 1080 })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.target).toMatchObject({ mode: 'socks5', scheme: 'http', host: '127.0.0.1', port: 1080 })
    expect(ok.ok && ok.target.username).toBeUndefined()
  })

  it('EGRESS_PROXY_URL：http(s)/socks5 协议与 userinfo 解码；非法输入给出原因', () => {
    const httpUrl = parseEgressProxyUrl('http://user:p%40ss@proxy.io:8080')
    expect(httpUrl.ok).toBe(true)
    if (httpUrl.ok) {
      expect(httpUrl.binding).toMatchObject({ id: 'env', mode: 'http', scheme: 'http', host: 'proxy.io', port: 8080, username: 'user', password: 'p@ss' })
    }
    const socks = parseEgressProxyUrl('socks5://127.0.0.1:1080')
    expect(socks.ok).toBe(true)
    if (socks.ok) expect(socks.binding.mode).toBe('socks5')
    expect(parseEgressProxyUrl('ftp://proxy.io:21').ok).toBe(false)
    expect(parseEgressProxyUrl('not a url').ok).toBe(false)
  })

  it('凭据脱敏：maskUrl 抹掉 userinfo（错误消息与日志复用）', () => {
    expect(maskUrl('http://user:pass@proxy.io:3128/path')).toBe('http://proxy.io:3128/path')
    expect(maskUrl('socks5://u@h:1080')).toBe('socks5://h:1080')
  })
})

describe('M82：直连旁路匹配', () => {
  it('回环恒直连（与配置无关）', () => {
    expect(hostBypassed('localhost', [])).toBe(true)
    expect(hostBypassed('127.0.0.1', [])).toBe(true)
    expect(hostBypassed('127.8.8.8', [])).toBe(true)
    expect(hostBypassed('::1', [])).toBe(true)
  })

  it('域后缀 / 裸域名 / IP / IPv4 CIDR', () => {
    expect(hostBypassed('a.example.com', ['example.com'])).toBe(true)
    expect(hostBypassed('example.com', ['example.com'])).toBe(true)
    expect(hostBypassed('notexample.com', ['example.com'])).toBe(false)
    expect(hostBypassed('svc.local', ['*.local'])).toBe(true)
    expect(hostBypassed('10.20.30.40', ['10.0.0.0/8'])).toBe(true)
    expect(hostBypassed('192.168.5.5', ['192.168.0.0/16'])).toBe(true)
    expect(hostBypassed('11.0.0.1', ['10.0.0.0/8'])).toBe(false)
    expect(hostBypassed('172.20.1.1', ['172.16.0.0/12'])).toBe(true)
    expect(hostBypassed('example.com', ['10.0.0.0/8'])).toBe(false)
  })
})

// ---------- 运行时：路由解析 ----------

describe('M82：出口路由解析', () => {
  it('未配置 / 通道未启用 / 旁路命中 → 直连', () => {
    const env = makeEnv()
    expect(env.runtime.resolveRoute('search', 'http://site.test/')).toMatchObject({ kind: 'direct', reason: 'unconfigured' })

    const id = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: 9 })
    env.cfg.egressMode = 'proxy'
    env.cfg.egressConnectionId = id
    env.cfg.egressChannels = ['finance']
    expect(env.runtime.resolveRoute('search', 'http://site.test/')).toMatchObject({ kind: 'direct', reason: 'unconfigured' })
    expect(env.runtime.resolveRoute('finance', 'http://site.test/')).toMatchObject({ kind: 'proxy' })

    env.cfg.egressChannels = ['search']
    env.cfg.egressNoProxy = ['site.test']
    expect(env.runtime.resolveRoute('search', 'http://site.test/')).toMatchObject({ kind: 'direct', reason: 'bypass' })
    expect(env.runtime.resolveRoute('search', 'http://127.0.0.1:1/')).toMatchObject({ kind: 'direct', reason: 'bypass' })
  })

  it('连接缺失 / 禁用 / 类型不符 → 直连 + 状态给出原因（不静默）', () => {
    const env = makeEnv({ egressMode: 'proxy', egressConnectionId: 'conn_missing' })
    expect(env.runtime.resolveRoute('search', 'http://site.test/')).toMatchObject({ kind: 'direct' })
    expect(env.runtime.status().bindingError).toContain('不存在')

    const id = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: 9 })
    env.cfg.egressConnectionId = id
    env.connections.update(id, { enabled: false })
    expect(env.runtime.status().bindingError).toContain('已禁用')

    const ssh = env.connections.create({ name: 'ssh-x', kind: 'ssh', config: { host: 'h', port: 22, username: 'u' } })
    env.cfg.egressConnectionId = ssh.id
    expect(env.runtime.status().bindingError).toContain('不是 proxy')
  })

  it('优先级：连接配置 > EGRESS_PROXY_URL 后备', () => {
    const env = makeEnv({ egressMode: 'proxy', egressProxyUrl: 'http://env-proxy.io:8080' })
    expect(env.runtime.resolveRoute('search', 'http://site.test/')).toMatchObject({ kind: 'proxy' })
    expect(env.runtime.resolveRoute('search', 'http://site.test/').binding?.name).toBe('EGRESS_PROXY_URL')

    const id = createProxyConnection(env, { mode: 'http', host: 'conn-proxy.io', port: 3128 })
    env.cfg.egressConnectionId = id
    expect(env.runtime.resolveRoute('search', 'http://site.test/').binding?.host).toBe('conn-proxy.io')
  })
})

// ---------- 运行时：请求链路 ----------

describe('M82：经出口代理请求', () => {
  it('经假代理成功：目标内容返回、代理收到请求、元信息标注出口', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })

      const res = await env.runtime.fetch('search', 'http://site.test/doc?a=1')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('出口目标正文')
      expect(proxy.seen[0]).toMatchObject({ method: 'GET', url: 'http://site.test/doc?a=1' })
      const meta = env.runtime.metaOf(res)
      expect(meta).toMatchObject({ used: true })
      expect(egressNoteOf(meta)).toContain('（出口：')
      expect(env.runtime.status()).toMatchObject({ state: 'proxied', fails: 0 })
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('SOCKS5（无鉴权）：同包 Socks5ProxyAgent 承接，远端 DNS；connectTimeoutMs 走 clientFactory 生效', async () => {
    const target = await startTarget()
    const socks = await startFakeSocks5({ targetPort: target.port })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(env, {
        mode: 'socks5',
        host: '127.0.0.1',
        port: socks.port,
        connectTimeoutMs: 5_000,
      })
      const res = await env.runtime.fetch('search', 'http://site.test/socks')
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('出口目标正文')
      expect(env.runtime.metaOf(res)).toMatchObject({ used: true })
    } finally {
      await socks.close()
      await target.close()
    }
  })

  it('SOCKS5（账号口令）：凭据完成 RFC 1929 握手；错误口令在严格模式下报出口错误', async () => {
    const target = await startTarget()
    const socks = await startFakeSocks5({ targetPort: target.port, auth: { user: 'user', pass: 'pass' } })
    try {
      const okEnv = makeEnv({ egressMode: 'proxy' })
      okEnv.cfg.egressConnectionId = createProxyConnection(
        okEnv,
        { mode: 'socks5', host: '127.0.0.1', port: socks.port },
        { username: 'user', password: 'pass' },
      )
      const res = await okEnv.runtime.fetch('search', 'http://site.test/socks-auth')
      expect(await res.text()).toContain('出口目标正文')

      const badEnv = makeEnv({ egressMode: 'proxy', egressFallback: 'fail' })
      badEnv.cfg.egressConnectionId = createProxyConnection(
        badEnv,
        { mode: 'socks5', host: '127.0.0.1', port: socks.port },
        { username: 'user', password: 'wrong' },
      )
      await expect(badEnv.runtime.fetch('search', 'http://site.test/socks-bad')).rejects.toBeInstanceOf(EgressError)
      expect(badEnv.runtime.status().fails).toBe(1)
    } finally {
      await socks.close()
      await target.close()
    }
  })

  it('代理鉴权：连接 secret 作为 Basic 凭据（uri 注入 token，凭据不出现在响应/状态里）', async () => {
    const target = await startTarget()
    const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`
    const proxy = await startFakeProxy({ targetPort: target.port, auth: expected })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(
        env,
        { mode: 'http', host: '127.0.0.1', port: proxy.port },
        { username: 'user', password: 'pass' },
      )
      const res = await env.runtime.fetch('search', 'http://site.test/auth')
      expect(res.status).toBe(200)
      expect(proxy.seen[0]?.auth).toBe(expected)
      expect(JSON.stringify(env.runtime.status())).not.toContain('pass')
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('代理鉴权失败（严格模式）：407 → EgressError，明确可操作文案', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port, auth: 'Basic x' })
    try {
      const env = makeEnv({ egressMode: 'proxy', egressFallback: 'fail' })
      env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })
      const { calls } = stubDirectFetch()
      await expect(env.runtime.fetch('search', 'http://site.test/x')).rejects.toBeInstanceOf(EgressError)
      // 严格模式绝不回退直连（合规：不允许泄漏真实 IP）
      expect(calls).toHaveLength(0)
      expect(env.runtime.status().lastError).toContain('407')
      expect(env.runtime.status().fails).toBe(1)
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('回退直连：代理不可达 → 直连一次并标注；连续 2 次失败进入 60s 降级（不再重撞代理）', async () => {
    const env = makeEnv({ egressMode: 'proxy' })
    // 不可达代理（端口 1 拒绝连接）
    env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: 1 })
    const { calls } = stubDirectFetch()

    const first = await env.runtime.fetch('search', 'http://site.test/one')
    expect(await first.text()).toBe('direct-ok')
    expect(env.runtime.metaOf(first)).toMatchObject({ used: false, fallback: true, reason: 'fallback' })
    expect(egressNoteOf(env.runtime.metaOf(first))).toContain('已直连')
    expect(env.runtime.status().fails).toBe(1)
    expect(env.runtime.status().state).toBe('proxied')

    const second = await env.runtime.fetch('search', 'http://site.test/two')
    expect(env.runtime.metaOf(second)?.fallback).toBe(true)
    expect(env.runtime.status()).toMatchObject({ state: 'degraded', fails: 2 })
    expect(env.runtime.status().coolingUntil).toBeTruthy()

    // 降级冷却期内：直接直连（不再发起代理连接尝试），并带降级标注
    const third = await env.runtime.fetch('search', 'http://site.test/three')
    expect(env.runtime.metaOf(third)).toMatchObject({ used: false, reason: 'degraded' })
    expect(egressNoteOf(env.runtime.metaOf(third))).toContain('降级中')
    expect(calls).toHaveLength(3)
    expect(env.runtime.status().fails).toBe(2)
  })

  it('外部取消（AbortSignal）不视为出口失败', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })
      const ctl = new AbortController()
      ctl.abort()
      await expect(env.runtime.fetch('search', 'http://site.test/abort', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' })
      expect(env.runtime.status().fails).toBe(0)
    } finally {
      await proxy.close()
      await target.close()
    }
  })
})

// ---------- 运行时：探测 ----------

describe('M82：出口探测', () => {
  it('经指定连接探测：回显出口 IP 与延迟', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      const id = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })
      const result = await env.runtime.probe({ connectionId: id })
      expect(result.ok).toBe(true)
      expect(result.exitIp).toBe('203.0.113.7')
      expect(result.detail).toContain('出口 IP 203.0.113.7')
      expect(env.runtime.status().lastProbe?.ok).toBe(true)
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('未配置绑定 / 连接不存在 / 非 proxy 类型 → 明确错误（不静默）', async () => {
    const env = makeEnv()
    expect((await env.runtime.probe()).ok).toBe(false)
    expect((await env.runtime.probe()).error).toContain('未配置出口')
    expect((await env.runtime.probe({ connectionId: 'conn_missing' })).error).toBe('连接不存在')
    const ssh = env.connections.create({ name: 'ssh-y', kind: 'ssh', config: { host: 'h', port: 22, username: 'u' } })
    expect((await env.runtime.probe({ connectionId: ssh.id })).error).toContain('不是出口代理类型')
  })

  it('extractExitIp：JSON / 文本 / 无 IP', () => {
    expect(extractExitIp('{"ip":"1.2.3.4"}')).toBe('1.2.3.4')
    expect(extractExitIp('当前 IP：114.114.114.114  来自于：中国 江苏')).toBe('114.114.114.114')
    expect(extractExitIp('no address here')).toBeUndefined()
  })
})

// ---------- 集成：antiBotFetch ----------

describe('M82：antiBotFetch 经出口层（集成）', () => {
  it('经代理抓取成功并在响应元信息中标注出口', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    try {
      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })
      configureEgress({ cfg: env.cfg, connections: env.connections })

      const res = await antiBotFetch({ url: 'http://site.test/doc', egressChannel: 'search', minIntervalMs: 0, maxRetries: 0 })
      expect(res.ok).toBe(true)
      expect(res.text).toContain('出口目标正文')
      expect(res.egress).toMatchObject({ used: true })
      expect(proxy.seen.some((s) => s.url === 'http://site.test/doc')).toBe(true)
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('工具层标注：web_fetch 经代理 summary 含出口名；回退直连提示已直连', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    try {
      const runtime = { httpUserAgent: '', httpTimeoutMs: 15_000, httpMinIntervalMs: 0 } as unknown as ToolRuntime

      const env = makeEnv({ egressMode: 'proxy' })
      env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: proxy.port })
      configureEgress({ cfg: env.cfg, connections: env.connections })
      const ok = await webFetchTool.execute({ url: 'http://site.test/page' }, runtime)
      expect(ok.ok).toBe(true)
      expect(ok.summary).toContain('（出口：')

      // 代理不可达 → 回退直连并标注
      const dead = makeEnv({ egressMode: 'proxy' })
      dead.cfg.egressConnectionId = createProxyConnection(dead, { mode: 'http', host: '127.0.0.1', port: 1 })
      configureEgress({ cfg: dead.cfg, connections: dead.connections })
      stubDirectFetch((url) => {
        const res = new Response('<html><body>直连正文</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })
        Object.defineProperty(res, 'url', { value: url })
        return res
      })
      const fallback = await webFetchTool.execute({ url: 'http://site.test/page' }, runtime)
      expect(fallback.ok).toBe(true)
      expect(fallback.detail).toContain('直连正文')
      expect(fallback.summary).toContain('已直连')
    } finally {
      await proxy.close()
      await target.close()
    }
  })

  it('通道隔离：未启用通道的请求直连（仅 finance 跟随出口时 search 不经代理）', async () => {
    const env = makeEnv({ egressMode: 'proxy', egressChannels: ['finance'] })
    env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: 1 })
    configureEgress({ cfg: env.cfg, connections: env.connections })
    const { calls } = stubDirectFetch()
    const res = await antiBotFetch({ url: 'http://site.test/direct', egressChannel: 'search', minIntervalMs: 0, maxRetries: 0 })
    expect(res.ok).toBe(true)
    expect(calls).toHaveLength(1)
    // 既未经代理也无需回退：出口完全不介入（无标注）
    expect(res.egress).toBeUndefined()
  })

  it('严格模式：egress 错误独立分类，且不污染目标 host 冷却', async () => {
    const env = makeEnv({ egressMode: 'proxy', egressFallback: 'fail' })
    env.cfg.egressConnectionId = createProxyConnection(env, { mode: 'http', host: '127.0.0.1', port: 1 })
    configureEgress({ cfg: env.cfg, connections: env.connections })

    const err = await antiBotFetch({ url: 'http://blocked-host.test/x', egressChannel: 'search', minIntervalMs: 0, maxRetries: 0 }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(AntiBotError)
    expect((err as AntiBotError).kind).toBe('egress')

    // 切回直连后同 host 立即可用 ⇒ 出口失败未触发 host 风控冷却（归因隔离）
    env.cfg.egressMode = 'direct'
    stubDirectFetch()
    const ok = await antiBotFetch({ url: 'http://blocked-host.test/x', egressChannel: 'search', minIntervalMs: 0, maxRetries: 0 })
    expect(ok.ok).toBe(true)
  })
})

// ---------- 路由层：连接中心（kind=proxy）与设置 ----------

async function makeRouteFixture(): Promise<{
  env: ReturnType<typeof makeFullEnv>
  cfg: AppConfig
  connections: ConnectionStore
  audit: AuditStore
  egress: EgressRuntime
  url: string
  close: () => Promise<void>
}> {
  const env = makeFullEnv()
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const connections = new ConnectionStore(env.db, vault)
  const audit = new AuditStore(env.db)
  const cfg: AppConfig = {
    ...env.cfg,
    // 防御：即便 helpers 未隔离，路由用例也不得写仓库真实设置文件
    settingsFile: path.join(env.cfg.dataDir, 'settings.json'),
    egressMode: 'direct',
    egressConnectionId: '',
    egressProxyUrl: '',
    egressChannels: ['search', 'finance', 'browser'],
    egressNoProxy: [],
    egressFallback: 'direct',
    egressProbeUrl: 'http://probe.test/echo',
  }
  const egress = new EgressRuntime({ cfg, connections })
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    const uid = String(req.header('x-test-user') ?? '')
    if (uid) (req as unknown as { user?: AuthUser }).user = env.auth.getUser(uid) as unknown as AuthUser
    next()
  })
  const deps = {
    ...env,
    cfg,
    connections,
    audit,
    egress,
    db: { probe: async () => ({ ok: true }), invalidate: async () => undefined },
    ssh: { invalidate: async () => undefined },
    embeddings: { invalidate: () => undefined },
  } as unknown as ApiDeps
  app.use('/api', createConnectionsRouter(deps))
  app.use('/api', createSettingsRouter(deps))
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s))
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    env,
    cfg,
    connections,
    audit,
    egress,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

const asUser = (uid?: string): Record<string, string> => ({
  ...(uid ? { 'x-test-user': uid } : {}),
  'content-type': 'application/json',
})

describe('M82：连接中心（kind=proxy）', () => {
  it('创建：合法配置成功（凭据不回传）；SSH 形态与非法端口明确拒绝', async () => {
    const f = await makeRouteFixture()
    try {
      const okRes = await fetch(`${f.url}/api/connections`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({
          name: '公司出口',
          kind: 'proxy',
          config: { mode: 'http', scheme: 'http', host: 'proxy.corp.io', port: 3128 },
          secret: { username: 'u', password: 'p' },
        }),
      })
      expect(okRes.status).toBe(200)
      const created = (await okRes.json()) as { connection: { id: string; secretSet: boolean; config: Record<string, unknown> } }
      expect(created.connection.secretSet).toBe(true)
      expect(JSON.stringify(created.connection)).not.toContain('"password"')
      expect(f.connections.getSecret(created.connection.id)).toMatchObject({ username: 'u', password: 'p' })

      const sshRes = await fetch(`${f.url}/api/connections`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({ name: '隧道出口', kind: 'proxy', config: { mode: 'ssh', sshConnectionId: 'conn_x' } }),
      })
      expect(sshRes.status).toBe(400)
      expect(((await sshRes.json()) as { error: string }).error).toContain('P1')

      const badPort = await fetch(`${f.url}/api/connections`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({ name: '端口非法', kind: 'proxy', config: { mode: 'http', host: 'h', port: 0 } }),
      })
      expect(badPort.status).toBe(400)
    } finally {
      await f.close()
    }
  })

  it('成员创建出口代理 → 403（系统级资源 admin 管理）', async () => {
    const f = await makeRouteFixture()
    try {
      const member = f.env.users.create({ username: 'm1', displayName: 'M1', passwordHash: 'x', role: 'member' })
      const res = await fetch(`${f.url}/api/connections`, {
        method: 'POST',
        headers: asUser(member.id),
        body: JSON.stringify({ name: '私有出口', kind: 'proxy', config: { mode: 'http', host: 'h', port: 8080 } }),
      })
      expect(res.status).toBe(403)
    } finally {
      await f.close()
    }
  })

  it('测试 = 出口探测：回显出口 IP 并回写连接状态', async () => {
    const target = await startTarget()
    const proxy = await startFakeProxy({ targetPort: target.port })
    const f = await makeRouteFixture()
    try {
      const connection = f.connections.create({
        name: '探测出口',
        kind: 'proxy',
        config: { mode: 'http', host: '127.0.0.1', port: proxy.port },
      })
      const res = await fetch(`${f.url}/api/connections/${connection.id}/test`, { method: 'POST', headers: asUser() })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { ok: boolean; detail?: string } }
      expect(body.result.ok).toBe(true)
      expect(body.result.detail).toContain('203.0.113.7')
      expect(f.connections.get(connection.id)?.status).toBe('ok')
      expect(f.audit.list({ action: 'connection.test' }).length).toBeGreaterThan(0)
    } finally {
      await f.close()
      await proxy.close()
      await target.close()
    }
  })

  it('会话绑定出口代理 → 400（全局资源不参与绑定）', async () => {
    const f = await makeRouteFixture()
    try {
      const session = f.env.sessions.create(['pm'], 'S')
      const connection = f.connections.create({ name: '绑定出口', kind: 'proxy', config: { mode: 'http', host: 'h', port: 8080 } })
      const res = await fetch(`${f.url}/api/sessions/${session.id}/connections`, {
        method: 'POST',
        headers: asUser(),
        body: JSON.stringify({ connectionId: connection.id }),
      })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('不参与会话绑定')
    } finally {
      await f.close()
    }
  })
})

describe('M82：设置（联网与出网）', () => {
  it('PUT /api/settings 保存出口字段：热更新生效 + 设置变更落审计；GET /api/egress/status 返回状态', async () => {
    const f = await makeRouteFixture()
    try {
      const connection = f.connections.create({ name: '设置出口', kind: 'proxy', config: { mode: 'http', host: 'proxy.io', port: 3128 } })
      const putRes = await fetch(`${f.url}/api/settings`, {
        method: 'PUT',
        headers: asUser(),
        body: JSON.stringify({
          egressMode: 'proxy',
          egressConnectionId: connection.id,
          egressChannels: ['search'],
          egressFallback: 'fail',
        }),
      })
      expect(putRes.status).toBe(200)
      expect(f.cfg).toMatchObject({ egressMode: 'proxy', egressConnectionId: connection.id, egressChannels: ['search'], egressFallback: 'fail' })
      const auditActions = f.audit.list({ action: 'settings.update' })
      expect(auditActions).toHaveLength(1)
      expect(JSON.stringify(auditActions[0]?.detail)).toContain('egressMode')

      const statusRes = await fetch(`${f.url}/api/egress/status`, { headers: asUser() })
      const status = (await statusRes.json()) as { status: { mode: string; state: string; bindingName?: string } }
      expect(status.status).toMatchObject({ mode: 'proxy', state: 'proxied', bindingName: '设置出口' })
    } finally {
      await f.close()
    }
  })

  it('多用户下成员读取出口状态为空（系统级参数不向成员暴露）', async () => {
    const f = await makeRouteFixture()
    try {
      const member = f.env.users.create({ username: 'm2', displayName: 'M2', passwordHash: 'x', role: 'member' })
      const statusRes = await fetch(`${f.url}/api/egress/status`, { headers: asUser(member.id) })
      expect(((await statusRes.json()) as { status: unknown }).status).toBeNull()
      const settingsRes = await fetch(`${f.url}/api/settings`, { headers: asUser(member.id) })
      expect(((await settingsRes.json()) as { settings: Record<string, unknown> }).settings).toEqual({})
    } finally {
      await f.close()
    }
  })
})
