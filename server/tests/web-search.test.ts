/**
 * web_search 工具测试：
 * - parseBaiduSerp：data-tools 转义 JSON / mu 兜底 / 摘要与灰字站点 / 去重 / 无标题过滤；
 * - clampQuery72：汉字计 2 的宽度截断；
 * - 工具级：未启用提示、HTML 模式（cookie 预热 + 假百度 SERP）、风控拦截提示、
 *   无结果提示、API 模式（Bearer 鉴权 + references 解析 + image 过滤）、API 错误码。
 */
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { resetAntiBotState } from '../src/tools/http.js'
import type { ToolRegistry, ToolRuntime } from '../src/tools/registry.js'
import { clampQuery72, parseBaiduSerp, resetSearchCookieCache } from '../src/tools/web_search.js'
import { makeTmpDir } from './helpers.js'

/** 假百度 SERP：data-tools（转义 JSON）/ mu / h3 跳转链三种 URL 来源 + 摘要 + 灰字 */
const SERP_HTML = `<html><head><title>nodejs 文档_百度搜索</title></head><body>
<div id="content_left">
<div class="result c-container xpath-log new-pmd" id="1" data-tools="{&quot;title&quot;:&quot;Node.js 官方文档&quot;,&quot;url&quot;:&quot;https://nodejs.org/zh-cn/docs&quot;}">
<h3 class="t"><a href="http://www.baidu.com/link?url=abc">Node.js 官方文档</a></h3>
<div class="c-abstract">Node.js 是一个开源、跨平台的 JavaScript 运行时环境。</div>
<span class="c-color-gray">nodejs.org</span>
<span class="c-color-gray">2026-09-10</span>
</div>
<div class="result c-container" id="2" mu="https://example.com/article">
<h3><a href="http://www.baidu.com/link?url=def">示例文章标题</a></h3>
<div class="c-abstract">示例摘要内容。</div>
<span class="c-color-gray">example.com</span>
</div>
<div class="result c-container" id="3">
<h3><a href="http://www.baidu.com/link?url=ghi">跳转链兜底条目</a></h3>
</div>
</div>
</body></html>`

/** 独立工具运行时（与 m5/tools 测试同形态） */
function makeToolEnv(
  webSearchOverride: Partial<ToolRuntime['webSearch']> = {},
): { registry: ToolRegistry; runtime: ToolRuntime } {
  const cfg = loadConfig()
  const artifacts = new ArtifactStore(makeTmpDir('ma-ws-art-'))
  const sessionId = 's-ws'
  const workspace = artifacts.ensureSessionDir(sessionId)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(path.join(makeTmpDir('ma-ws-db-'), 'app.db'))
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    'web_search 测试',
    JSON.stringify(['pm']),
    now,
    now,
  )
  const runtime: ToolRuntime = {
    sessionId,
    runId: 'r-ws',
    agentId: 'pm',
    workspace,
    artifacts,
    skills,
    memory: new MemoryStore(db),
    tasks: new TaskStore(db),
    participants: [{ id: 'pm', name: '费利' }],
    todos: [],
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webFetchAllowedDomains: [],
    webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '', ...webSearchOverride },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: '测试未提供技能' }),
  }
  return { registry: createToolRegistry(cfg), runtime }
}

async function startServer(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

async function closeServer(server: http.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

beforeEach(() => {
  resetAntiBotState()
  resetSearchCookieCache()
})

describe('web_search：SERP 解析与参数约束', () => {
  it('parseBaiduSerp：data-tools / mu / 跳转链三种 URL 来源，摘要与站点抽取', () => {
    const items = parseBaiduSerp(SERP_HTML)
    expect(items.length).toBe(3)
    expect(items[0]).toEqual({
      title: 'Node.js 官方文档',
      url: 'https://nodejs.org/zh-cn/docs',
      summary: 'Node.js 是一个开源、跨平台的 JavaScript 运行时环境。',
      site: 'nodejs.org',
      date: '2026-09-10',
    })
    expect(items[1].url).toBe('https://example.com/article')
    expect(items[1].site).toBe('example.com')
    expect(items[2].url).toContain('link?url=ghi')
  })

  it('parseBaiduSerp：同 URL 去重、无标题块过滤', () => {
    const html = `<div class="result c-container" id="1" data-tools="{&quot;url&quot;:&quot;https://a.example/1&quot;}">
<h3><a href="http://www.baidu.com/link?url=x1">第一篇</a></h3></div>
<div class="result c-container" id="2" data-tools="{&quot;url&quot;:&quot;https://a.example/1&quot;}">
<h3><a href="http://www.baidu.com/link?url=x2">重复链接</a></h3></div>
<div class="result c-container" id="3"><div>无标题内容</div></div>`
    const items = parseBaiduSerp(html)
    expect(items.length).toBe(1)
    expect(items[0].title).toBe('第一篇')
  })

  it('clampQuery72：汉字计 2，超长按宽度截断', () => {
    expect(clampQuery72('ab')).toBe('ab')
    expect([...clampQuery72('汉'.repeat(36))].length).toBe(36)
    expect([...clampQuery72('汉'.repeat(37))].length).toBe(36)
    expect(clampQuery72('a'.repeat(70) + '汉')).toBe('a'.repeat(70) + '汉')
    expect([...clampQuery72('a'.repeat(71) + '汉')].length).toBe(71)
  })
})

describe('web_search：工具执行（HTML / API 双模式）', () => {
  it('未启用 → 明确提示（含开启方式）', async () => {
    const { registry, runtime } = makeToolEnv()
    const res = await registry.execute('web_search', { query: '测试' }, runtime)
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('未启用')
    expect(res.summary).toContain('WEB_SEARCH_ENABLED')
  })

  it('HTML 模式：cookie 预热 + 结果解析（本地假百度）', async () => {
    const requests: string[] = []
    let cookieForwarded = false
    const { server, port } = await startServer((req, res) => {
      requests.push(req.url ?? '')
      if ((req.url ?? '') === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'BAIDUID=test-cookie-123; path=/' })
        res.end('<html><body>home</body></html>')
        return
      }
      cookieForwarded = (req.headers.cookie ?? '').includes('BAIDUID=test-cookie-123')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SERP_HTML)
    })
    try {
      const { registry, runtime } = makeToolEnv({ enabled: true, htmlUrl: `http://127.0.0.1:${port}/s` })
      const res = await registry.execute('web_search', { query: 'nodejs 文档', count: 5 }, runtime)
      expect(res.ok).toBe(true)
      expect(res.summary).toContain('3 条结果')
      expect(res.summary).toContain('网页抓取')
      expect(res.detail).toContain('Node.js 官方文档')
      expect(res.detail).toContain('https://nodejs.org/zh-cn/docs')
      expect(res.detail).toContain('示例摘要内容')
      expect(requests[0]).toBe('/')
      expect(requests[1]).toContain('/s?')
      expect(requests[1]).toContain('wd=nodejs')
      expect(cookieForwarded).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it('HTML 模式：风控页 → 拦截提示（含 API 建议）', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>百度安全验证</title></head><body>请进行验证</body></html>')
    })
    try {
      const { registry, runtime } = makeToolEnv({ enabled: true, htmlUrl: `http://127.0.0.1:${port}/s` })
      const res = await registry.execute('web_search', { query: '风控用例' }, runtime)
      expect(res.ok).toBe(false)
      expect(res.summary).toContain('风控')
      expect(res.summary).toContain('BAIDU_SEARCH_API_KEY')
    } finally {
      await closeServer(server)
    }
  })

  it('HTML 模式：页面无可解析结构 → 提示稍后重试或配置 API', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>正常页面</title></head><body>无结果结构</body></html>')
    })
    try {
      const { registry, runtime } = makeToolEnv({ enabled: true, htmlUrl: `http://127.0.0.1:${port}/s` })
      const res = await registry.execute('web_search', { query: '空结果用例' }, runtime)
      expect(res.ok).toBe(false)
      expect(res.summary).toContain('未解析到搜索结果')
    } finally {
      await closeServer(server)
    }
  })

  it('API 模式：Bearer 鉴权 + references 解析（image 过滤）', async () => {
    let auth = ''
    let payload: Record<string, unknown> = {}
    const { server, port } = await startServer((req, res) => {
      let data = ''
      req.on('data', (chunk) => (data += chunk))
      req.on('end', () => {
        auth = String(req.headers.authorization ?? '')
        payload = JSON.parse(data) as Record<string, unknown>
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            request_id: 'req-1',
            references: [
              {
                title: '节点文档',
                url: 'https://nodejs.org/',
                content: 'Node.js 官方文档首页',
                website: 'nodejs.org',
                date: '2026-09-01',
                type: 'web',
              },
              { title: '图片结果', url: 'https://img.example.com/x.png', type: 'image' },
            ],
          }),
        )
      })
    })
    try {
      const { registry, runtime } = makeToolEnv({
        enabled: true,
        apiKey: 'test-key',
        apiUrl: `http://127.0.0.1:${port}/v2/ai_search/web_search`,
      })
      const res = await registry.execute('web_search', { query: 'nodejs', count: 3 }, runtime)
      expect(res.ok).toBe(true)
      expect(res.summary).toContain('官方 API')
      expect(res.summary).toContain('1 条结果')
      expect(res.detail).toContain('节点文档')
      expect(res.detail).toContain('https://nodejs.org/')
      expect(res.detail).not.toContain('img.example.com')
      expect(auth).toBe('Bearer test-key')
      expect(payload.search_source).toBe('baidu_search_v2')
      expect(payload.resource_type_filter).toEqual([{ type: 'web', top_k: 3 }])
      expect(JSON.stringify(payload.messages)).toContain('nodejs')
    } finally {
      await closeServer(server)
    }
  })

  it('API 模式：错误码 → 透出错误信息', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 216003, message: 'API Key 无效' }))
    })
    try {
      const { registry, runtime } = makeToolEnv({
        enabled: true,
        apiKey: 'bad-key',
        apiUrl: `http://127.0.0.1:${port}/v2/ai_search/web_search`,
      })
      const res = await registry.execute('web_search', { query: '错误用例' }, runtime)
      expect(res.ok).toBe(false)
      expect(res.summary).toContain('API Key 无效')
    } finally {
      await closeServer(server)
    }
  })
})
