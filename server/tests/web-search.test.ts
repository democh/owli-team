/**
 * web_search 工具测试：
 * - parseBaiduSerp：data-tools 转义 JSON / mu 兜底 / 摘要与灰字站点 / 去重 / 无标题过滤；
 * - 多引擎解析器：Bing（ck/a 跳转链 base64 解码）/ 搜狗（相对跳转链补全）/ 360（data-mdurl 优先）；
 * - clampQuery72：汉字计 2 的宽度截断；
 * - 工具级：免 Key 引擎降级链（百度风控 → Bing 自动接管 + 冷却跳过）、全链失败汇总、
 *   cookie 预热、API 模式（Bearer 鉴权 + references 解析 + image 过滤）、API 错误码。
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
import { cleanInline, parseBingSerp, parseSo360Serp, parseSogouSerp } from '../src/tools/search-engines.js'
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

/** 假 Bing SERP：真实 URL / ck/a 跳转链（base64url u 参数）/ 摘要 / 广告块排除 */
const BING_SERP_HTML = `<html><body><ol id="b_results">
<li class="b_algo" data-id iid=SERP.5335><div class="b_algoheader">
<h2 class=""><a target="_blank" href="https://zhuanlan.zhihu.com/p/513504457" h="ID=SERP,5145.2">研发团队是什么</a></h2>
<div class="b_caption" role="text"><p class="b_lineclamp2">研发团队的核心职责与协作方式介绍。</p></div>
<div class="b_attribution"><cite>zhuanlan.zhihu.com</cite></div></div></li>
<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;p=abc&amp;u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9ibG9n&amp;ntb=1">跳转链条目</a></h2>
<div class="b_caption"><p class="b_lineclamp3">跳转链解码后的示例摘要。</p></div></li>
<li class="b_ad" data-bm="9"><h2><a href="https://ad.example.com/x">广告条目</a></h2></li>
</ol></body></html>`

/** 假搜狗 SERP：vr-title 相对跳转链补全 / cite 站点 / 无标题提示块过滤 */
const SOGOU_SERP_HTML = `<html><body>
<div class="vrwrap" id="sogou_vr_30000101_0">
<h3 class="vr-title  "><a target="_blank" href="/link?url=abc123" id="sogou_vr_30000101_title_0"><em>研发团队</em>_百度百科</a></h3>
<div class="text-layout"><p class="star-wiki space-txt"><em>研发团队</em>是2016年公布的管理科学技术名词。</p>
<a href="/link?url=abc123" class="citeLinkClass"><img class="footerIcon" src="https://cdn-yb.icon.qq.com/baike_baidu_com.ico"><span>百度百科</span></a></div>
</div>
<div class="vrwrap middle-better-hintBox"><div class="hint">猜你想搜</div></div>
</body></html>`

/** 假 360 SERP：data-mdurl 真实 URL / 自家导航过滤 / 无 mdurl 跳转链兜底 */
const SO360_SERP_HTML = `<html><body><ul class="result">
<li class="res-list" data-resid="1">
<h3 class="res-title "><a class="title" href="https://www.so.com/link?m=xyz" data-mdurl="https://baike.baidu.com/item/ruanfa">研发团队_百度百科</a></h3>
<p class="res-desc">研发团队是<em>企业</em>技术创新的核心力量。</p>
<p class="g-linkinfo"><cite><a href="https://www.so.com/link?m=xyz">baike.baidu.com</a></cite></p>
</li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=nav" data-mdurl="https://hao.360.com/?src=hj_so">360导航</a></h3></li>
<li class="res-list"><h3 class="res-title"><a href="https://www.so.com/link?m=noMdurl">无真实 URL 条目</a></h3></li>
</ul></body></html>`

/** 独立工具运行时（与 m5/tools 测试同形态） */
function makeToolEnv(webSearchOverride: Partial<ToolRuntime['webSearch']> = {}): {
  registry: ToolRegistry
  runtime: ToolRuntime
} {
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
    // engines 缺省仅百度（避免测试触真实网络）；降级链用例显式指定 engines + engineUrls
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '', engines: ['baidu'], ...webSearchOverride },
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
  it('HTML 模式：cookie 预热 + 结果解析（本地假百度）', async () => {
    const requests: string[] = []
    let cookieForwarded = false
    const { server, port } = await startServer((req, res) => {
      requests.push(req.url ?? '')
      if ((req.url ?? '') === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': 'BAIDUID=test-cookie-123; path=/',
        })
        res.end('<html><body>home</body></html>')
        return
      }
      cookieForwarded = (req.headers.cookie ?? '').includes('BAIDUID=test-cookie-123')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SERP_HTML)
    })
    try {
      const { registry, runtime } = makeToolEnv({ htmlUrl: `http://127.0.0.1:${port}/s` })
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
      const { registry, runtime } = makeToolEnv({ htmlUrl: `http://127.0.0.1:${port}/s` })
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
      const { registry, runtime } = makeToolEnv({ htmlUrl: `http://127.0.0.1:${port}/s` })
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

describe('web_search：多引擎解析器（Bing / 搜狗 / 360）', () => {
  it('cleanInline：em 高亮标签边界 → 空格压缩 + 全角标点前空格清除', () => {
    expect(cleanInline('<em>研发</em>，原来是这么回事儿')).toBe('研发，原来是这么回事儿')
    // 半角标点/英文空格不清理（避免破坏英文排版）
    expect(cleanInline('研发团队 (research team )是名词')).toBe('研发团队 (research team )是名词')
    // 补充实体：命名空白实体 + 数字实体（SERP 摘要高频噪声）
    expect(cleanInline('2022年11月27日&ensp;&#0183;&ensp;研发，这个词')).toBe('2022年11月27日 · 研发，这个词')
  })

  it('parseBingSerp：真实 URL + ck/a 跳转链 base64 解码 + 摘要 + 广告块排除', () => {
    const items = parseBingSerp(BING_SERP_HTML)
    expect(items.length).toBe(2)
    expect(items[0]).toEqual({
      title: '研发团队是什么',
      url: 'https://zhuanlan.zhihu.com/p/513504457',
      summary: '研发团队的核心职责与协作方式介绍。',
      site: 'zhuanlan.zhihu.com',
      date: '',
    })
    expect(items[1].url).toBe('https://example.com/blog')
    expect(items[1].summary).toContain('跳转链解码后的示例摘要')
  })

  it('parseSogouSerp：相对跳转链补全 + cite 站点 + 无标题块过滤', () => {
    const items = parseSogouSerp(SOGOU_SERP_HTML)
    expect(items.length).toBe(1)
    // em 高亮标签 → 空格（htmlToText 统一策略，与真实数据行为一致）
    expect(items[0].title).toBe('研发团队 _百度百科')
    expect(items[0].url).toBe('https://www.sogou.com/link?url=abc123')
    expect(items[0].summary).toContain('管理科学技术名词')
    expect(items[0].site).toBe('百度百科')
  })

  it('parseSo360Serp：data-mdurl 真实 URL 优先 + 自家导航过滤 + 跳转链兜底', () => {
    const items = parseSo360Serp(SO360_SERP_HTML)
    expect(items.length).toBe(2)
    expect(items[0].title).toBe('研发团队_百度百科')
    expect(items[0].url).toBe('https://baike.baidu.com/item/ruanfa')
    expect(items[0].summary).toContain('技术创新的核心力量')
    expect(items[0].site).toBe('baike.baidu.com')
    expect(items[1].url).toBe('https://www.so.com/link?m=noMdurl')
  })
})

describe('web_search：免 Key 多引擎降级链', () => {
  it('百度风控 → 自动降级 Bing（标注引擎与原因；冷却期不再撞百度）', async () => {
    const baiduCalls: string[] = []
    const bingCalls: string[] = []
    const baidu = await startServer((req, res) => {
      baiduCalls.push(req.url ?? '')
      if ((req.url ?? '') === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body>home</body></html>')
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>百度安全验证</title></head><body>请进行验证</body></html>')
    })
    // 引擎隔离：两个引擎用不同端口（限速/冷却按 host:port 计数，互不影响）
    const bing = await startServer((req, res) => {
      bingCalls.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(BING_SERP_HTML)
    })
    try {
      const { registry, runtime } = makeToolEnv({
        engines: ['baidu', 'bing'],
        engineUrls: {
          baidu: `http://127.0.0.1:${baidu.port}/s`,
          bing: `http://127.0.0.1:${bing.port}/search`,
        },
      })
      const res = await registry.execute('web_search', { query: '研发团队', count: 5 }, runtime)
      expect(res.ok).toBe(true)
      expect(res.summary).toContain('2 条结果')
      expect(res.summary).toContain('网页抓取·Bing（降级）')
      expect(res.detail).toContain('（降级跳过 百度：')
      expect(res.detail).toContain('研发团队是什么')
      expect(bingCalls[0]).toContain('/search?')
      expect(bingCalls[0]).toContain('q=%E7%A0%94%E5%8F%91%E5%9B%A2%E9%98%9F')
      expect(baiduCalls.filter((u) => u.includes('/s?')).length).toBe(1)

      // 第二回合：百度 host 处于风控冷却 → 直接跳过（不再发起请求）→ Bing 仍然可用
      const again = await registry.execute('web_search', { query: '研发团队', count: 5 }, runtime)
      expect(again.ok).toBe(true)
      expect(again.summary).toContain('Bing')
      expect(baiduCalls.filter((u) => u.includes('/s?')).length).toBe(1)
    } finally {
      await closeServer(baidu.server)
      await closeServer(bing.server)
    }
  })

  it('全部引擎失败 → 汇总各引擎原因 + API 建议', async () => {
    const blockPage: http.RequestListener = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>百度安全验证</title></head><body>请进行验证</body></html>')
    }
    const baidu = await startServer(blockPage)
    const bing = await startServer(blockPage)
    try {
      const { registry, runtime } = makeToolEnv({
        engines: ['baidu', 'bing'],
        engineUrls: {
          baidu: `http://127.0.0.1:${baidu.port}/s`,
          bing: `http://127.0.0.1:${bing.port}/search`,
        },
      })
      const res = await registry.execute('web_search', { query: '风控用例' }, runtime)
      expect(res.ok).toBe(false)
      expect(res.summary).toContain('已尝试 2 个引擎')
      expect(res.summary).toContain('百度：')
      expect(res.summary).toContain('Bing：')
      expect(res.summary).toContain('风控')
      expect(res.summary).toContain('BAIDU_SEARCH_API_KEY')
    } finally {
      await closeServer(baidu.server)
      await closeServer(bing.server)
    }
  })
})
