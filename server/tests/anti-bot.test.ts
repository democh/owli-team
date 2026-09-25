/**
 * 反爬 HTTP 模块（tools/http.ts）测试：
 * - browserHeaders：默认浏览器 UA / 语言头 / 可覆盖 / Safari 指纹不带 Sec-Fetch-*；
 * - detectBlockPage：wappass 重定向 / 百度安全验证 / Cloudflare 挑战 / 403；
 * - decodeBody：BOM / content-type charset / <meta charset>（GBK 家族归一）；
 * - antiBotFetch：429 退避重试、重试耗尽、网络错误、外部取消不重试、
 *   风控页 → blocked + host 冷却、too-large、限速排队、readBody=false 取 Set-Cookie、
 *   会话 Cookie 自动携带（tough-cookie CookieJar）、UA 池 host 粘性。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  antiBotFetch,
  browserHeaders,
  decodeBody,
  detectBlockPage,
  effectivePool,
  resetAntiBotState,
} from '../src/tools/http.js'

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return { server, base: `http://127.0.0.1:${port}` }
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

afterEach(() => {
  resetAntiBotState()
})

describe('http：请求头与风控识别', () => {
  it('browserHeaders：默认浏览器 UA / 中文语言头，可被覆盖', () => {
    const def = browserHeaders()
    expect(def['user-agent']).toContain('Mozilla/5.0')
    expect(def['accept-language']).toContain('zh-CN')
    expect(browserHeaders('CustomUA/1.0')['user-agent']).toBe('CustomUA/1.0')
    expect(browserHeaders(undefined, { referer: 'https://x/' }).referer).toBe('https://x/')
    expect(browserHeaders('', { accept: 'application/json' }).accept).toBe('application/json')
  })

  it('browserHeaders：Safari 指纹不发送 Sec-Fetch-*（显式 UA 覆盖保持既有行为）', () => {
    const safari = browserHeaders(undefined, {}, { ua: 'Mozilla/5.0 (Macintosh) Safari/605.1.15', secFetch: false })
    expect(safari['user-agent']).toContain('Safari/605.1.15')
    expect(safari['sec-fetch-dest']).toBeUndefined()
    expect(safari['upgrade-insecure-requests']).toBeUndefined()
    // 显式 UA 覆盖 → 附带 Sec-Fetch-*（与既有行为一致）
    expect(browserHeaders('CustomUA/1.0')['sec-fetch-dest']).toBe('document')
  })

  it('detectBlockPage：wappass / 百度安全验证 / Cloudflare / 403 特征识别', () => {
    expect(
      detectBlockPage({ status: 200, finalUrl: 'https://wappass.baidu.com/static/captcha', text: '' }),
    ).toContain('百度安全验证')
    expect(
      detectBlockPage({ status: 200, finalUrl: 'https://www.baidu.com/s', text: '<html><title>百度安全验证</title>' }),
    ).toContain('风控')
    expect(
      detectBlockPage({ status: 200, finalUrl: 'https://x.com/', text: '<html><title>Just a moment...</title>' }),
    ).toContain('Cloudflare')
    expect(detectBlockPage({ status: 403, finalUrl: 'https://x.com/', text: '' })).toContain('403')
    expect(
      detectBlockPage({ status: 200, finalUrl: 'https://x.com/', text: '<html><title>正常页面</title>hello</html>' }),
    ).toBeNull()
    // JSON 接口空响应（软风控）仅在 expectJson 时识别，避免误伤正常空页面
    expect(detectBlockPage({ status: 200, finalUrl: 'https://x.com/api', text: '' })).toBeNull()
    expect(detectBlockPage({ status: 200, finalUrl: 'https://x.com/api', text: '', expectJson: true })).toContain('空响应')
  })

  it('decodeBody：BOM / content-type charset / meta charset（GBK 家族）', () => {
    // BOM 优先
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文', 'utf8')])
    expect(decodeBody(bom, 'text/plain')).toBe('中文')
    // content-type 声明（“百度”的 GBK 字节）
    const gbk = Buffer.from([0xb0, 0xd9, 0xb6, 0xc8])
    expect(decodeBody(gbk, 'text/html; charset=gbk')).toBe('百度')
    // meta 声明兜底（content-type 无 charset）
    const withMeta = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>', 'latin1'),
      gbk,
      Buffer.from('</body></html>', 'latin1'),
    ])
    expect(decodeBody(withMeta, 'text/html')).toBe('<html><head><meta charset="gbk"></head><body>百度</body></html>')
    // utf-8 兜底
    expect(decodeBody(Buffer.from('plain', 'utf8'), '')).toBe('plain')
  })
})

describe('http：antiBotFetch 反爬行为', () => {
  it('429 → 尊重退避重试，第二次成功', async () => {
    let calls = 0
    const { server, base } = await startServer((_req, res) => {
      calls += 1
      if (calls === 1) {
        res.writeHead(429, { 'retry-after': '0' })
        res.end('busy')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<title>ok</title>')
    })
    try {
      const res = await antiBotFetch({ url: `${base}/x`, minIntervalMs: 0 })
      expect(res.ok).toBe(true)
      expect(res.text).toContain('ok')
      expect(calls).toBe(2)
    } finally {
      await closeServer(server)
    }
  })

  it('429 重试耗尽 → AntiBotError(rate-limit)', async () => {
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(429, { 'retry-after': '0' })
      res.end()
    })
    try {
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 1 })).rejects.toMatchObject({
        name: 'AntiBotError',
        kind: 'rate-limit',
        status: 429,
      })
    } finally {
      await closeServer(server)
    }
  })

  it('连接失败 → AntiBotError(network)', async () => {
    await expect(
      antiBotFetch({ url: 'http://127.0.0.1:9/x', minIntervalMs: 0, maxRetries: 0 }),
    ).rejects.toMatchObject({ kind: 'network' })
  })

  it('外部取消 → AbortError（不重试不包装）', async () => {
    const ctl = new AbortController()
    const { server, base } = await startServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200)
        res.end('late')
      }, 500)
    })
    try {
      const pending = antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, signal: ctl.signal })
      ctl.abort()
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await closeServer(server)
    }
  })

  it('风控页 → blocked 并冷却 host（冷却期内不再发起请求）', async () => {
    let calls = 0
    const { server, base } = await startServer((_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>百度安全验证</title></head><body>请进行验证</body></html>')
    })
    try {
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0 })).rejects.toMatchObject({ kind: 'blocked' })
      await expect(antiBotFetch({ url: `${base}/y`, minIntervalMs: 0 })).rejects.toMatchObject({ kind: 'blocked' })
      expect(calls).toBe(1)
    } finally {
      await closeServer(server)
    }
  })

  it('声明超限 → AntiBotError(too-large) 携带 bytes', async () => {
    const big = 'x'.repeat(64 * 1024)
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(big.length) })
      res.end(big)
    })
    try {
      await expect(
        antiBotFetch({ url: `${base}/big`, minIntervalMs: 0, maxBytes: 1024 }),
      ).rejects.toMatchObject({ kind: 'too-large', bytes: big.length })
    } finally {
      await closeServer(server)
    }
  })

  it('同域名最小间隔生效（限速排队）', async () => {
    const stamps: number[] = []
    const { server, base } = await startServer((_req, res) => {
      stamps.push(Date.now())
      res.writeHead(200)
      res.end('ok')
    })
    try {
      await antiBotFetch({ url: `${base}/a`, minIntervalMs: 150 })
      await antiBotFetch({ url: `${base}/b`, minIntervalMs: 150 })
      expect(stamps.length).toBe(2)
      expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(120)
    } finally {
      await closeServer(server)
    }
  })

  it('readBody=false：只取响应头（Set-Cookie 预热场景）', async () => {
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(200, { 'set-cookie': ['BAIDUID=abc; path=/', 'BIDUPSID=def; path=/'] })
      res.end('<html>body-not-read</html>')
    })
    try {
      const res = await antiBotFetch({ url: `${base}/`, minIntervalMs: 0, readBody: false })
      expect(res.text).toBe('')
      expect(res.setCookies.length).toBe(2)
      expect(res.setCookies[0]).toContain('BAIDUID=abc')
    } finally {
      await closeServer(server)
    }
  })

  it('会话 Cookie：Set-Cookie 入库并在后续同域请求自动携带', async () => {
    const seen: Array<string | undefined> = []
    let calls = 0
    const { server, base } = await startServer((req, res) => {
      seen.push(req.headers.cookie)
      calls += 1
      if (calls === 1) {
        res.writeHead(200, { 'set-cookie': ['qgqp_b_id=abc123; path=/; max-age=3600'] })
        res.end('first')
        return
      }
      res.writeHead(200)
      res.end('second')
    })
    try {
      await antiBotFetch({ url: `${base}/a`, minIntervalMs: 0 })
      await antiBotFetch({ url: `${base}/b`, minIntervalMs: 0 })
      expect(seen[0]).toBeUndefined()
      expect(seen[1]).toContain('qgqp_b_id=abc123')
    } finally {
      await closeServer(server)
    }
  })

  it('会话 Cookie：调用方显式 cookie 优先于 Cookie 罐', async () => {
    let seen: string | undefined
    let calls = 0
    const { server, base } = await startServer((req, res) => {
      calls += 1
      if (calls === 1) {
        res.writeHead(200, { 'set-cookie': ['a=1; path=/'] })
        res.end('x')
        return
      }
      seen = req.headers.cookie
      res.writeHead(200)
      res.end('y')
    })
    try {
      await antiBotFetch({ url: `${base}/a`, minIntervalMs: 0 })
      await antiBotFetch({ url: `${base}/b`, minIntervalMs: 0, headers: { cookie: 'manual=1' } })
      expect(seen).toBe('manual=1')
    } finally {
      await closeServer(server)
    }
  })

  it('UA 池：同 host 会话内保持稳定且为浏览器指纹', async () => {
    const agents: Array<string | undefined> = []
    const { server, base } = await startServer((req, res) => {
      agents.push(req.headers['user-agent'])
      res.writeHead(200)
      res.end('ok')
    })
    try {
      await antiBotFetch({ url: `${base}/a`, minIntervalMs: 0 })
      await antiBotFetch({ url: `${base}/b`, minIntervalMs: 0 })
      expect(agents[0]).toContain('Mozilla/5.0')
      expect(agents[1]).toBe(agents[0])
    } finally {
      await closeServer(server)
    }
  })

  it('软封锁：连接被异常中断单次 → network（不立即冷却）', async () => {
    const { server, base } = await startServer((req) => {
      req.socket.destroy()
    })
    try {
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })).rejects.toMatchObject({
        kind: 'network',
      })
    } finally {
      await closeServer(server)
    }
  })

  it('软封锁：连续两次连接中断 → blocked（冷却期内不再发起请求）', async () => {
    let calls = 0
    const { server, base } = await startServer((req) => {
      calls += 1
      req.socket.destroy()
    })
    try {
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })).rejects.toMatchObject({
        kind: 'network',
      })
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })).rejects.toMatchObject({
        kind: 'blocked',
        message: expect.stringContaining('连续 2 次'),
      })
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })).rejects.toMatchObject({
        kind: 'blocked',
      })
      expect(calls).toBe(2)
    } finally {
      await closeServer(server)
    }
  })

  it('软封锁：同一请求内的重试失败不重复计数（单次请求 → network，不触发 5 分钟冷却）', async () => {
    let calls = 0
    const { server, base } = await startServer((req) => {
      calls += 1
      req.socket.destroy()
    })
    try {
      // maxRetries=1：两次尝试同属一次逻辑请求 → 计数 1，不升级 blocked
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 1 })).rejects.toMatchObject({
        kind: 'network',
      })
      expect(calls).toBe(2)
      // 下一次独立请求失败 → 累计 2 次 → blocked + 冷却
      await expect(antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })).rejects.toMatchObject({
        kind: 'blocked',
        message: expect.stringContaining('连续 2 次'),
      })
      expect(calls).toBe(3)
    } finally {
      await closeServer(server)
    }
  })

  it('软封锁：JSON 接口空响应 → 首次 network（可重试）；连续两次 → blocked + 冷却', async () => {
    let calls = 0
    const { server, base } = await startServer((_req, res) => {
      calls += 1
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end('')
    })
    try {
      await expect(
        antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0, accept: 'application/json' }),
      ).rejects.toMatchObject({ kind: 'network' })
      await expect(
        antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0, accept: 'application/json' }),
      ).rejects.toMatchObject({ kind: 'blocked' })
      await expect(
        antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0, accept: 'application/json' }),
      ).rejects.toMatchObject({ kind: 'blocked' })
      expect(calls).toBe(2)
    } finally {
      await closeServer(server)
    }
  })

  it('软封锁：非 JSON 请求的空响应不误判（空页面正常返回）', async () => {
    const { server, base } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('')
    })
    try {
      const res = await antiBotFetch({ url: `${base}/x`, minIntervalMs: 0, maxRetries: 0 })
      expect(res.ok).toBe(true)
      expect(res.text).toBe('')
    } finally {
      await closeServer(server)
    }
  })
})

describe('http：UA 池合并与 Cookie 分桶（加固批）', () => {
  it('effectivePool：追加 UA 前置合并（trim / 空行剔除）；空输入回退内置池', () => {
    const builtin = effectivePool()
    expect(builtin.length).toBeGreaterThanOrEqual(4)
    const merged = effectivePool(['  Custom/1.0  ', '', 'Safari/26.0'])
    expect(merged.length).toBe(builtin.length + 2)
    expect(merged[0].ua).toBe('Custom/1.0')
    expect(merged[0].secFetch).toBe(true) // 非 Safari 结尾 → Chromium 语义
    expect(merged.find((p) => p.ua === 'Safari/26.0')?.secFetch).toBe(false)
    expect(effectivePool([])).toBe(builtin)
  })

  it('Cookie 罐按 cookieKey 分桶：不同用户同站点互不串号', async () => {
    let n = 0
    const seen: Array<string | undefined> = []
    const server = http.createServer((req, res) => {
      seen.push(req.headers.cookie)
      n += 1
      res.setHeader('set-cookie', `sid=C${n}; Path=/`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await antiBotFetch({ url: `${base}/a`, minIntervalMs: 0, maxRetries: 0, cookieKey: 'u1' })
      await antiBotFetch({ url: `${base}/b`, minIntervalMs: 0, maxRetries: 0, cookieKey: 'u2' })
      await antiBotFetch({ url: `${base}/c`, minIntervalMs: 0, maxRetries: 0, cookieKey: 'u1' })
      expect(seen[0]).toBeUndefined() // u1 首访：无 Cookie
      expect(seen[1] ?? '').not.toContain('sid=') // u2 独立桶：不携带他人的会话
      expect(seen[2] ?? '').toContain('sid=C1') // u1 复访：自动回传自己的 Cookie
    } finally {
      await closeServer(server)
    }
  })
})
