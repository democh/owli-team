/**
 * M28：工具按需发现（渐进披露 / Tool Search）。
 *
 * 与 Claude Code / Anthropic Tool Search Tool 同构：核心工具常驻；
 * 重型工具（浏览器 / 数据库 / Git / SSH / 联网 / 命令）与 MCP 工具默认不进模型清单，
 * 经 tool_search 检索激活后才可调用（Run 级生命周期，激活只增不减）。
 *
 * 检索为混合排序：
 * - BM25 词法打底（中英混排分词：拉丁按词 + CJK 单字/双字 2-gram，不引入分词依赖）；
 * - 可选嵌入语义融合（复用 M25 嵌入通道；不可用 / 失败时静默退化为纯词法）；
 * - 排序函数为纯函数（测试友好）；ToolDiscoveryService 持有条目向量缓存（name+description hash 失效）。
 */
import type { ToolSearchActivation } from './registry.js'

/** 可检索工具条目（由引擎按「本回合该 Agent 的可延迟集合」投影） */
export interface ToolSearchEntry {
  name: string
  description: string
  source: 'builtin' | 'mcp'
  /** source=mcp 时的服务器 slug（如 filesystem） */
  server?: string
  /** 展示分类（工具中心同源映射；MCP 条目恒为 'MCP'） */
  category: string
}

export interface ToolSearchHit {
  entry: ToolSearchEntry
  score: number
}

/** 嵌入通道（M25 EmbeddingManager 适配；失败抛出，由本模块静默退化） */
export interface ToolEmbedder {
  embed(texts: string[]): Promise<ArrayLike<number>[]>
}

// ---------- 分词（中英混排；无外部依赖） ----------

const TOKEN_RE = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+)|([a-z0-9][a-z0-9_.\-/]*)/g

/** 中英混排分词：拉丁按词（小写，附下划线/点/斜杠拆分出的子词）；CJK 单字 + 相邻双字（2-gram） */
export function tokenize(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  let match: RegExpExecArray | null
  TOKEN_RE.lastIndex = 0
  while ((match = TOKEN_RE.exec(lower)) !== null) {
    const cjk = match[1]
    if (cjk) {
      for (const ch of cjk) out.push(ch)
      for (let i = 0; i + 1 < cjk.length; i++) out.push(cjk.slice(i, i + 2))
      continue
    }
    const word = match[2]
    if (!word) continue
    out.push(word)
    // db_query → db / query；docs/需求.md → docs / 需求 / md（提升复合名的命中面）
    for (const part of word.split(/[_.\-/]+/)) {
      if (part && part !== word) out.push(part)
    }
  }
  return out
}

// ---------- BM25 词法打分 ----------

const K1 = 1.2
const B = 0.75
/** 工具名重复注入次数（name 命中权重高于 description） */
const NAME_WEIGHT = 3
/** 查询整体子串命中工具名时的强先验分（如 query="git" → 全部 git_* 排前） */
const NAME_SUBSTRING_SCORE = 0.9
/** 查询词重复出现计入上限（防长 query 单 term 刷分） */
const QTF_CAP = 3

function countToken(tokens: string[], term: string): number {
  let n = 0
  for (const t of tokens) if (t === term) n++
  return n
}

/** BM25 打分（docs[i] 为条目 i 的 token 序列；调用方负责 name 加权重复注入） */
export function bm25Scores(queryTokens: string[], docs: string[][]): number[] {
  const n = docs.length
  if (n === 0 || queryTokens.length === 0) return new Array(n).fill(0)
  const lens = docs.map((d) => d.length)
  const total = lens.reduce((a, b) => a + b, 0)
  const avgdl = total > 0 ? total / n : 1
  // 文档频率（每个文档内去重）
  const df = new Map<string, number>()
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) ?? 0) + 1)
  }
  // 查询词频（去重计数，防重复词刷分）
  const qtf = new Map<string, number>()
  for (const term of queryTokens) qtf.set(term, (qtf.get(term) ?? 0) + 1)

  const scores = new Array<number>(n).fill(0)
  for (const [term, qn] of qtf) {
    const d = df.get(term)
    if (!d) continue
    const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5))
    for (let i = 0; i < n; i++) {
      const tf = countToken(docs[i], term)
      if (tf === 0) continue
      const denom = tf + K1 * (1 - B + (B * lens[i]) / avgdl)
      scores[i] += idf * ((tf * (K1 + 1)) / denom) * Math.min(qn, QTF_CAP)
    }
  }
  return scores
}

/** 归一化到 [0,1]（全零保持零） */
function normalizeMax(scores: number[]): number[] {
  let max = 0
  for (const s of scores) if (s > max) max = s
  return max > 0 ? scores.map((s) => s / max) : scores.map(() => 0)
}

/** 词法打分（BM25 归一化 + 查询整体子串命中工具名强先验）；纯函数，供测试与语义融合共用 */
export function lexicalScores(query: string, entries: ToolSearchEntry[]): number[] {
  const queryTokens = tokenize(query)
  const docs = entries.map((entry) => {
    const nameTokens = tokenize(entry.name)
    // name 命中加权：逐 token 重复注入 NAME_WEIGHT 次（BM25 词频加成，名称命中权重高于 description）
    const head = nameTokens.flatMap((token) => new Array<string>(NAME_WEIGHT).fill(token))
    return head.concat(tokenize(entry.description))
  })
  const scores = normalizeMax(bm25Scores(queryTokens, docs))
  const full = query.trim().toLowerCase()
  // 过短的查询（单字符）不做子串强先验，避免噪声
  if (full.length >= 2) {
    entries.forEach((entry, i) => {
      if (entry.name.toLowerCase().includes(full)) scores[i] = Math.max(scores[i], NAME_SUBSTRING_SCORE)
    })
  }
  return scores
}

// ---------- 语义融合 ----------

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    const x = Number(a[i] ?? 0)
    const y = Number(b[i] ?? 0)
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** djb2 文本哈希（条目向量缓存键；仅内部使用） */
function hashText(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

// ---------- 发现服务（引擎装配；含条目向量缓存） ----------

/** 条目向量缓存上限（超出整体清空重算，防无界增长） */
const VEC_CACHE_MAX = 2_000

export interface ToolDiscoveryOptions {
  embedder?: ToolEmbedder
  /** 语义融合权重（0-1；默认 0.35；仅嵌入可用时生效） */
  semanticWeight?: number
}

export class ToolDiscoveryService {
  private readonly vecCache = new Map<string, ArrayLike<number>>()

  constructor(private readonly opts: ToolDiscoveryOptions = {}) {}

  /** 当前是否具备语义能力（嵌入通道已装配；实际可用性以调用结果为准，失败静默退化） */
  get semanticReady(): boolean {
    return this.opts.embedder !== undefined
  }

  /**
   * 混合检索：词法（BM25）+ 语义（嵌入余弦）融合 → 排序 → top-limit（1-10）。
   * 嵌入失败 / 未配置 → 纯词法结果（确定性，零网络）。
   */
  async rank(query: string, entries: ToolSearchEntry[], limit = 5): Promise<ToolSearchHit[]> {
    const top = Math.max(1, Math.min(10, limit))
    const trimmed = query.trim()
    if (trimmed === '' || entries.length === 0) return []

    const lexical = lexicalScores(trimmed, entries)
    let semantic: number[] | null = null
    if (this.opts.embedder) {
      try {
        semantic = await this.semanticScores(trimmed, entries)
      } catch {
        semantic = null // 静默退化：嵌入不可用不应影响检索可用性
      }
    }

    const weight = semantic ? clamp01(this.opts.semanticWeight ?? 0.35) : 0
    const hits: ToolSearchHit[] = []
    for (let i = 0; i < entries.length; i++) {
      const score = (1 - weight) * lexical[i] + weight * (semantic?.[i] ?? 0)
      if (score > 0) hits.push({ entry: entries[i], score })
    }
    hits.sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    return hits.slice(0, top)
  }

  /** 清空条目向量缓存（工具清单变化 / 测试隔离） */
  clearCache(): void {
    this.vecCache.clear()
  }

  private async semanticScores(query: string, entries: ToolSearchEntry[]): Promise<number[]> {
    const embedder = this.opts.embedder!
    const queryVec = (await embedder.embed([query]))[0]
    if (!queryVec) throw new Error('嵌入返回空向量')

    const vecs = new Array<ArrayLike<number> | undefined>(entries.length)
    const missing: Array<{ index: number; text: string }> = []
    entries.forEach((entry, index) => {
      const key = this.vecKey(entry)
      const cached = this.vecCache.get(key)
      if (cached) vecs[index] = cached
      else missing.push({ index, text: `${entry.name} ${entry.description}` })
    })
    if (missing.length > 0) {
      const got = await embedder.embed(missing.map((m) => m.text))
      missing.forEach((m, j) => {
        const vec = got[j]
        if (!vec) return
        vecs[m.index] = vec
        if (this.vecCache.size >= VEC_CACHE_MAX) this.vecCache.clear()
        this.vecCache.set(this.vecKey(entries[m.index]), vec)
      })
    }
    // 余弦相似度（-1..1）→ 0..1；低相似压制（cos < 0.15 视为无关，避免弱命中撑满 top-N）
    return vecs.map((vec) => (vec ? Math.max(0, (cosine(queryVec, vec) - 0.15) / 0.85) : 0))
  }

  private vecKey(entry: ToolSearchEntry): string {
    return `${entry.name}\u0000${hashText(entry.description)}`
  }
}

// ---------- 发现区块（L3 注入；未激活工具的类别概览） ----------

/** 分组标签（比工具中心分类更细：浏览器 / 数据库 / SSH 拆分，MCP 按服务器聚合） */
export function groupOf(entry: ToolSearchEntry): string {
  if (entry.source === 'mcp') return `MCP · ${entry.server ?? '未命名'}`
  const name = entry.name
  if (name.startsWith('git_')) return 'Git'
  if (name.startsWith('browser_')) return '浏览器自动化'
  if (name.startsWith('db_')) return '数据库'
  if (name.startsWith('ssh_')) return 'SSH 远程'
  if (name === 'web_fetch' || name === 'web_search') return '联网'
  if (name === 'run_command') return '命令执行'
  return entry.category
}

/** 每组展示的示例工具名上限 */
const EXAMPLE_MAX = 4

/**
 * <tool_discovery> 区块：未加载工具按类别概览（约 100-200 token），替代被延迟工具的完整 schema。
 * 无条目（全部已加载 / 无延迟工具）→ 空串（不注入）。
 */
export function renderDiscoveryBlock(entries: ToolSearchEntry[]): string {
  if (entries.length === 0) return ''
  const groups = new Map<string, string[]>()
  for (const entry of entries) {
    const label = groupOf(entry)
    const list = groups.get(label)
    if (list) list.push(entry.name)
    else groups.set(label, [entry.name])
  }
  const lines = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([label, names]) => {
      const shown = names.slice(0, EXAMPLE_MAX).join(' / ')
      return `- ${label}（${names.length} 个）：${shown}${names.length > EXAMPLE_MAX ? ' …' : ''}`
    })
  return [
    '<tool_discovery>',
    '以下能力按需加载（当前未放入工具清单）：任务确实需要时，先调用 tool_search 检索（中英文关键词均可），命中工具会立即激活并在本任务内持续可用。',
    ...lines,
    '提示：优先用现有工具完成任务；不要为浏览而检索。',
    '</tool_discovery>',
  ].join('\n')
}

/** 引擎侧检索结果的条目投影（tool_search 回灌用） */
export function toActivation(entry: ToolSearchEntry): ToolSearchActivation {
  return { name: entry.name, description: entry.description, source: entry.source, server: entry.server }
}
