/**
 * 免 Key 检索的多引擎适配器（web_search HTML 模式的引擎降级链）：
 * - 每个引擎独立声明「URL 构造 / SERP 解析 / 是否 Cookie 预热」，统一输出 SearchItem；
 * - 引擎链按序尝试：百度（中文质量最优但风控最严）→ Bing（稳定）→ 搜狗 / 360（国内兜底）；
 *   某引擎被风控/冷却时自动切换到下一个（冷却状态由 antiBotFetch 按 host 维护）；
 * - 反爬对抗收敛在 tools/http.ts（限速 / 冷却 / 软封锁计数），本模块只负责「换入口 + 换解析」——
 *   IP 级风控下任何单点客户端伪装都不可靠，多入口降级才是结构性解法（ADR 0184）。
 */
import { htmlToText } from './text.js'

export interface SearchItem {
  title: string
  url: string
  summary: string
  site: string
  date: string
}

// ---------- 通用小工具 ----------

/** 数字实体安全解码（非法码点保留原样） */
function safeCodePoint(code: number, raw: string): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw
}

/** 补充实体解码：htmlToText 仅覆盖基础五类，SERP 摘要高频出现 &ensp; / &#0183; 等 */
function decodeCommonEntities(s: string): string {
  return s
    .replace(/&ensp;|&emsp;|&thinsp;/gi, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (raw, hex: string) => safeCodePoint(parseInt(hex, 16), raw))
    .replace(/&#(\d+);/g, (raw, dec: string) => safeCodePoint(Number(dec), raw))
}

/** 内联片段净化：去标签 + 解码实体 + 压缩空白；全角标点前空格清除（em 高亮标签边界产生的排版噪声） */
export function cleanInline(s: string): string {
  return decodeCommonEntities(htmlToText(s))
    .replace(/\s+/g, ' ')
    .replace(/\s+(?=[，。、；：！？）》」』】])/g, '')
    .trim()
}

/** data-tools 属性（转义 JSON）实体解码（&amp; 最后处理，避免二次解码） */
function decodeAttrEntities(s: string): string {
  return s
    .replace(/&quot;/gi, '"')
    .replace(/&#0*34;/g, '"')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#0*39;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/** 站点展示净化：去协议前缀与尾斜杠（各引擎统一） */
function cleanSite(raw: string): string {
  return raw
    .replace(/^https?:\/\//, '')
    .replace(/\/$/, '')
    .trim()
}

/** 日期：从块纯文本提取（标签已剥离，不会误匹配链接） */
function extractDate(blockText: string): string {
  return (
    /(\d{4}[-年]\d{1,2}[-月]\d{1,2}日?|\d{1,2}\s*小时前|\d{1,2}\s*分钟前|\d+\s*天前|昨天)/.exec(
      blockText,
    )?.[1] ?? ''
  )
}

/** 标签 class 判定（独立词匹配，避免 result 误命中结果容器之外的前缀类名） */
function classOf(tag: string): string {
  return /class="([^"]*)"/i.exec(tag)?.[1] ?? ''
}

function hasClassWord(tag: string, word: string): boolean {
  return classOf(tag).split(/\s+/).includes(word)
}

const DIV_TAG_RE = /<div[^>]*>/gi
const LI_TAG_RE = /<li[^>]*>/gi

/** 按容器起点切块（起点标签需通过 isStart 判定；同引擎结果块结构一致） */
function splitBlocks(html: string, tagRe: RegExp, isStart: (tag: string) => boolean): string[] {
  tagRe.lastIndex = 0
  const starts: number[] = []
  for (let m = tagRe.exec(html); m; m = tagRe.exec(html)) {
    if (isStart(m[0])) starts.push(m.index)
  }
  const blocks: string[] = []
  for (let i = 0; i < starts.length; i++) {
    blocks.push(html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : html.length))
  }
  return blocks
}

// ---------- 百度：解析器（原 web_search.ts 迁移，行为保持不变） ----------

/** 百度跳转链（www.baidu.com/link?url=...）判定：此类 URL 不可作为展示链接且无站点信息 */
function isBaiduLink(url: string): boolean {
  return /(^|\.)baidu\.com$/i.test(hostOf(url)) && /\/link\?/i.test(url)
}

/** 结果容器判定：class 含 c-container 且含 result / result-* 类 */
function isBaiduContainer(tag: string): boolean {
  const cls = classOf(tag)
  if (!cls) return false
  const parts = cls.split(/\s+/)
  return parts.includes('c-container') && parts.some((p) => p === 'result' || p.startsWith('result-'))
}

/** 单个结果块解析：标题 / 真实 URL / 摘要 / 站点 / 日期（多级回退，容忍结构差异） */
function parseBaiduBlock(block: string): SearchItem | null {
  const h3 = /<h3[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? ''
  const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h3)
  const title = cleanInline(anchor?.[2] ?? h3)
  if (!title) return null

  // URL：data-tools JSON（真实 URL）→ mu 属性 → h3 内锚点（百度跳转链）
  let url = ''
  const toolsRaw = /data-tools="([^"]*)"/i.exec(block)?.[1]
  if (toolsRaw) {
    const decoded = decodeAttrEntities(toolsRaw)
    try {
      const parsed = JSON.parse(decoded) as { url?: string }
      if (typeof parsed.url === 'string' && parsed.url) url = parsed.url
    } catch {
      // 转义异常时宽松提取，避免整块丢弃
      url = /"url"\s*:\s*"([^"]+)"/.exec(decoded)?.[1] ?? ''
    }
  }
  if (!url) url = /\bmu="([^"]+)"/i.exec(block)?.[1] ?? ''
  if (!url) url = anchor?.[1] ?? ''

  // 摘要：c-abstract / content-right_* / c-span-last 依次尝试
  const absRaw =
    /<div[^>]*class="[^"]*\bc-abstract\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
    /<span[^>]*class="[^"]*\bcontent-right_[^"]*"[^>]*>([\s\S]*?)<\/span>/i.exec(block)?.[1] ??
    /<div[^>]*class="[^"]*\bc-span-last\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i.exec(block)?.[1] ??
    ''
  const summary = cleanInline(absRaw)

  // 站点：真实 URL 的 hostname 优先；跳转链/缺失时取灰字（排除日期/快照等噪声）
  let site = url && !isBaiduLink(url) ? hostOf(url) : ''
  if (!site) {
    const grays = block.match(/<span[^>]*class="[^"]*\bc-color-gray\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi) ?? []
    for (const gray of grays) {
      const text = cleanInline(gray)
      if (text && !/^\d/.test(text) && text.length <= 60 && !/快照/.test(text)) {
        site = text
        break
      }
    }
  }

  return {
    title,
    url,
    summary,
    site: cleanSite(site),
    date: extractDate(htmlToText(block)),
  }
}

/** 解析百度结果页（SERP）为结构化列表 */
export function parseBaiduSerp(html: string): SearchItem[] {
  const items: SearchItem[] = []
  const seen = new Set<string>()
  for (const block of splitBlocks(html, DIV_TAG_RE, isBaiduContainer)) {
    const item = parseBaiduBlock(block)
    if (!item) continue
    const key = item.url || item.title
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
  }
  return items
}

// ---------- Bing：解析器 ----------

/** Bing 跳转链（www.bing.com/ck/a?…u=a1<base64url>）解码为真实 URL；失败返回空串 */
function decodeBingHref(href: string): string {
  // 属性值实体解码（&amp; → &，否则 searchParams 解析丢失 u 参数）
  const raw = decodeAttrEntities(href.trim())
  if (!raw) return ''
  let parsed: URL
  try {
    parsed = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://www.bing.com')
  } catch {
    return ''
  }
  if (/(^|\.)bing\.com$/i.test(parsed.hostname) && parsed.pathname.startsWith('/ck/a')) {
    const enc = parsed.searchParams.get('u') ?? ''
    if (enc.startsWith('a1')) {
      const raw64 = enc.slice(2)
      const padded = raw64
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(raw64.length + ((4 - (raw64.length % 4)) % 4), '=')
      try {
        const decoded = Buffer.from(padded, 'base64').toString('utf8')
        if (/^https?:\/\//i.test(decoded)) return decoded
      } catch {
        // 解码失败 → 视为不可展示（不展示跳转链）
      }
    }
    return ''
  }
  return /^https?:/i.test(parsed.href) ? parsed.href : ''
}

/** Bing 结果容器：<li class="b_algo…">（广告为 b_ad，天然不匹配） */
function isBingContainer(tag: string): boolean {
  return hasClassWord(tag, 'b_algo')
}

/** 解析 Bing 结果页为结构化列表 */
export function parseBingSerp(html: string): SearchItem[] {
  const items: SearchItem[] = []
  const seen = new Set<string>()
  for (const block of splitBlocks(html, LI_TAG_RE, isBingContainer)) {
    const h2 = /<h2[^>]*>([\s\S]*?)<\/h2>/i.exec(block)?.[1] ?? ''
    const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h2)
    const title = cleanInline(anchor?.[2] ?? '')
    if (!title || !anchor) continue
    const url = decodeBingHref(anchor[1])
    const key = url || title
    if (seen.has(key)) continue
    seen.add(key)
    const summary = cleanInline(
      /<p[^>]*class="[^"]*\bb_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
        /<p[^>]*class="[^"]*\bb_paractl\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
        /<div[^>]*class="[^"]*\bb_caption\b[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
        '',
    )
    const citeText = cleanInline(/<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(block)?.[1] ?? '')
    items.push({
      title,
      url,
      summary,
      site: cleanSite(url ? hostOf(url) : citeText),
      date: extractDate(htmlToText(block)),
    })
  }
  return items
}

// ---------- 搜狗：解析器 ----------

/** 搜狗结果容器：<div class="vrwrap…">（提示条 / 卡片块无 h3 标题，解析阶段自然过滤） */
function isSogouContainer(tag: string): boolean {
  return hasClassWord(tag, 'vrwrap')
}

/** 解析搜狗结果页为结构化列表（链接为 /link?url= 跳转链，站点取 cite 文本） */
export function parseSogouSerp(html: string): SearchItem[] {
  const items: SearchItem[] = []
  const seen = new Set<string>()
  for (const block of splitBlocks(html, DIV_TAG_RE, isSogouContainer)) {
    const h3 = /<h3[^>]*class="[^"]*\bvr-title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? ''
    if (!h3) continue
    const anchor = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(h3)
    const title = cleanInline(anchor?.[2] ?? h3)
    if (!title || !anchor) continue
    let url = decodeAttrEntities(anchor[1].trim())
    if (url.startsWith('//')) url = `https:${url}`
    else if (url.startsWith('/')) url = `https://www.sogou.com${url}`
    const key = url || title
    if (seen.has(key)) continue
    seen.add(key)
    const summary = cleanInline(
      /<p[^>]*class="[^"]*\bspace-txt\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
        /<div[^>]*class="[^"]*\btext-layout\b[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ??
        '',
    )
    const citeText = cleanInline(
      /<a[^>]*class="[^"]*\bciteLinkClass\b[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i.exec(
        block,
      )?.[1] ?? '',
    )
    const isRedirect = /(^|\.)sogou\.com$/i.test(hostOf(url)) && /\/link\?/i.test(url)
    const site = isRedirect || !url ? (citeText.length <= 40 ? citeText : '') : hostOf(url)
    items.push({
      title,
      url,
      summary,
      site: cleanSite(site),
      date: extractDate(htmlToText(block)),
    })
  }
  return items
}

// ---------- 360 搜索：解析器 ----------

/** 360 自家域（导航 / 推广链接）判定：data-mdurl 命中时整块丢弃 */
function isSo360SelfUrl(url: string): boolean {
  return /(^|\.)(so\.com|360\.cn|360\.com)$/i.test(hostOf(url))
}

/** 360 结果容器：<li class="res-list…"> */
function isSo360Container(tag: string): boolean {
  return hasClassWord(tag, 'res-list')
}

/** 解析 360 结果页为结构化列表（data-mdurl 为真实 URL，缺失时保留 link?m= 跳转链） */
export function parseSo360Serp(html: string): SearchItem[] {
  const items: SearchItem[] = []
  const seen = new Set<string>()
  for (const block of splitBlocks(html, LI_TAG_RE, isSo360Container)) {
    const h3 = /<h3[^>]*class="[^"]*\bres-title\b[^"]*"[^>]*>([\s\S]*?)<\/h3>/i.exec(block)?.[1] ?? ''
    if (!h3) continue
    const anchorTag = /<a\b[^>]*>/i.exec(h3)?.[0] ?? ''
    const href = decodeAttrEntities(/href="([^"]+)"/i.exec(anchorTag)?.[1] ?? '')
    const mdurl = decodeAttrEntities(/data-mdurl="([^"]+)"/i.exec(anchorTag)?.[1] ?? '')
    const title = cleanInline(/<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(h3)?.[1] ?? h3)
    if (!title) continue
    // 真实 URL 优先；自家域真实 URL = 导航/推广块，丢弃
    if (mdurl && isSo360SelfUrl(mdurl)) continue
    const url = mdurl || href
    if (!url) continue
    const key = url || title
    if (seen.has(key)) continue
    seen.add(key)
    const summary = cleanInline(
      /<p[^>]*class="[^"]*\bres-desc\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1] ?? '',
    )
    const citeText = cleanInline(
      /<p[^>]*class="[^"]*\bg-linkinfo\b[^"]*"[^>]*>[\s\S]*?<cite[^>]*>([\s\S]*?)<\/cite>/i.exec(
        block,
      )?.[1] ?? '',
    )
    const isRedirect = /(^|\.)so\.com$/i.test(hostOf(url)) && /\/link\?/i.test(url)
    const site = isRedirect || !url ? (citeText.length <= 40 ? citeText : '') : hostOf(url)
    items.push({
      title,
      url,
      summary,
      site: cleanSite(site),
      date: extractDate(htmlToText(block)),
    })
  }
  return items
}

// ---------- 引擎注册表 ----------

export interface SearchEngine {
  id: string
  /** 展示名（summary / 降级提示用） */
  label: string
  /** 引擎基址（可被 runtime.engineUrls[id] 或 htmlUrl 覆写；测试注入本地地址） */
  baseUrl: string
  /** 是否需要 Cookie 预热（风控严格的引擎：百度 / 搜狗） */
  warmup: boolean
  buildUrl(base: string, query: string, count: number): string
  parse(html: string): SearchItem[]
}

export const ENGINE_REGISTRY: Record<string, SearchEngine> = {
  baidu: {
    id: 'baidu',
    label: '百度',
    baseUrl: 'https://www.baidu.com/s',
    warmup: true,
    buildUrl: (base, query, count) => {
      const endpoint = new URL(base)
      endpoint.searchParams.set('ie', 'utf-8')
      endpoint.searchParams.set('rn', String(count))
      endpoint.searchParams.set('wd', query)
      return endpoint.toString()
    },
    parse: parseBaiduSerp,
  },
  bing: {
    id: 'bing',
    label: 'Bing',
    baseUrl: 'https://www.bing.com/search',
    warmup: false,
    buildUrl: (base, query, count) => {
      const endpoint = new URL(base)
      endpoint.searchParams.set('q', query)
      endpoint.searchParams.set('count', String(count))
      return endpoint.toString()
    },
    parse: parseBingSerp,
  },
  sogou: {
    id: 'sogou',
    label: '搜狗',
    baseUrl: 'https://www.sogou.com/web',
    warmup: true,
    buildUrl: (base, query) => {
      const endpoint = new URL(base)
      endpoint.searchParams.set('query', query)
      return endpoint.toString()
    },
    parse: parseSogouSerp,
  },
  so360: {
    id: 'so360',
    label: '360搜索',
    baseUrl: 'https://www.so.com/s',
    warmup: false,
    buildUrl: (base, query) => {
      const endpoint = new URL(base)
      endpoint.searchParams.set('q', query)
      return endpoint.toString()
    },
    parse: parseSo360Serp,
  },
}

/** 内置引擎降级链顺序（中文结果质量优先；风控/冷却的引擎运行时自动跳过） */
export const DEFAULT_ENGINE_ORDER: readonly string[] = ['baidu', 'bing', 'sogou', 'so360']
