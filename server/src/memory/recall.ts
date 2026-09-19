/**
 * 语义召回（M25.3a）：多桶 KNN 合并 + 混合评分（Mem0 v3 三信号 + 时效衰减）+ 预算截断。
 *
 * - 桶：session / agent / project / global（`scope:ownerId`；global 固定 `global:global`）；
 * - 评分：scopeWeight × (0.50·sim + 0.15·keyword + 0.10·entity + 0.15·importance + 0.10·recency)；
 * - keyword：查询分词在内容中的命中率（JS 包含率，确定性、零 FTS 依赖）；
 * - recency：0.5^(ageDays / 30)，半衰期 30 天（取 validFrom / createdAt）；
 * - vec0 镜像不过滤状态：命中的 id 取回行后必须过滤 status = active；
 * - 预算：按分数贪心累加 countTokensCalibrated，杜绝超预算注入。
 */
import type { MemoryItem, MemoryScope, RecalledMemory } from '@multi-agent/shared'
import { countTokensCalibrated } from '../context/tokenizer.js'
import { extractEntities, renderMemoryItems } from '../store/memory.js'
import type { MemoryStore } from '../store/memory.js'
import type { VecIndex } from './vectors.js'

/** scope 权重（跨层注入收敛：session 全量、global 最收敛） */
export const SCOPE_WEIGHT: Record<MemoryScope, number> = { session: 1, agent: 0.95, project: 0.92, global: 0.9 }

/** 混合评分权重（Mem0 v3 三信号 + importance + recency） */
export const RECALL_WEIGHTS = { sim: 0.5, keyword: 0.15, entity: 0.1, importance: 0.15, recency: 0.1 } as const

/** recency 半衰期（天） */
export const RECENCY_HALF_LIFE_DAYS = 30

const ITEM_OVERHEAD_TOKENS = 4

export interface RecallSignals {
  sim: number
  keyword: number
  entity: number
  importance: number
  recency: number
  scopeWeight: number
}

export interface MemoryScore {
  score: number
  signals: RecallSignals
}

/** 混合评分（单项信号在 signals 中回传给调试接口） */
export function scoreMemory(item: MemoryItem, sim: number, queryTokens: string[], nowMs: number): MemoryScore {
  const keyword = keywordScore(item.content, queryTokens)
  const entity = jaccard(queryTokens, item.entities)
  const importance = clamp01(item.importance / 5)
  const refMs = Date.parse(item.validFrom || item.createdAt)
  const ageDays = Number.isFinite(refMs) ? Math.max(0, nowMs - refMs) / 86_400_000 : 0
  const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS)
  const scopeWeight = SCOPE_WEIGHT[item.scope] ?? 1
  const score =
    scopeWeight *
    (RECALL_WEIGHTS.sim * clamp01(sim) +
      RECALL_WEIGHTS.keyword * keyword +
      RECALL_WEIGHTS.entity * entity +
      RECALL_WEIGHTS.importance * importance +
      RECALL_WEIGHTS.recency * recency)
  return {
    score: round4(score),
    signals: {
      sim: round4(clamp01(sim)),
      keyword: round4(keyword),
      entity: round4(entity),
      importance: round4(importance),
      recency: round4(recency),
      scopeWeight,
    },
  }
}

export interface RecallIndexDeps {
  index: VecIndex
  store: MemoryStore
}

export interface RecallInput {
  queryText: string
  queryVec: Float32Array
  buckets: string[]
  topK: number
  minScore: number
  budgetTokens: number
  /** 已在 L1 会话记忆中出现的 id（避免重复注入） */
  exclude?: Set<string>
}

export interface RecallResult {
  items: RecalledMemory[]
  /** `<recalled_memory>…</recalled_memory>` 注入块（预算截断后） */
  rendered: string
  tokens: number
  /** 通过评分与过滤的候选数（调试用；注入条目 ≤ topK） */
  candidates: number
}

/**
 * 召回主流程：每桶 KNN（topK×2 留余量）→ 合并取最高 sim → 取回行过滤（active / exclude）
 * → 混合评分过滤 minScore → 排序截 topK → 预算贪心截断 → 渲染。
 */
export function recallMemories(deps: RecallIndexDeps, input: RecallInput): RecallResult {
  const candidateK = Math.max(1, input.topK * 2)
  const best = new Map<string, number>()
  for (const bucket of input.buckets) {
    for (const hit of deps.index.query(bucket, input.queryVec, candidateK)) {
      const prev = best.get(hit.memoryId)
      if (prev === undefined || hit.sim > prev) best.set(hit.memoryId, hit.sim)
    }
  }
  if (best.size === 0) return { items: [], rendered: '', tokens: 0, candidates: 0 }

  const nowMs = Date.now()
  const queryTokens = extractEntities(input.queryText)
  const scored: Array<{ item: MemoryItem; entry: RecalledMemory }> = []
  for (const item of deps.store.rowsByIds([...best.keys()])) {
    if (item.status !== 'active') continue // vec0 镜像不过滤状态
    if (input.exclude?.has(item.id)) continue
    const { score, signals } = scoreMemory(item, best.get(item.id) ?? 0, queryTokens, nowMs)
    if (score < input.minScore) continue
    scored.push({
      item,
      entry: { id: item.id, scope: item.scope, kind: item.kind, content: item.content, score, signals },
    })
  }
  // 分数降序；同分按 id 稳定排序（确定性）
  scored.sort((a, b) => b.entry.score - a.entry.score || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0))
  const kept = truncateByBudget(scored.slice(0, input.topK), input.budgetTokens)
  const rendered = renderRecalledItems(kept.map((k) => k.item))
  return {
    items: kept.map((k) => k.entry),
    rendered,
    tokens: rendered ? countTokensCalibrated(rendered) : 0,
    candidates: scored.length,
  }
}

/** 渲染 L1.5 注入块（召回条目全部 kind 都渲染；截断由预算层负责） */
export function renderRecalledItems(items: MemoryItem[]): string {
  const body = renderMemoryItems(items, false)
  return body ? `<recalled_memory>\n${body}\n</recalled_memory>` : ''
}

/** 预算截断：按分数序贪心累加（含每条 4 token 开销），超预算条目跳过 */
function truncateByBudget(
  items: Array<{ item: MemoryItem; entry: RecalledMemory }>,
  budgetTokens: number,
): Array<{ item: MemoryItem; entry: RecalledMemory }> {
  const kept: typeof items = []
  let used = 0
  for (const entry of items) {
    const cost = countTokensCalibrated(entry.item.content) + ITEM_OVERHEAD_TOKENS
    if (used + cost > budgetTokens) continue
    kept.push(entry)
    used += cost
  }
  return kept
}

/** 查询分词在内容中的命中率（0-1，确定性） */
function keywordScore(content: string, tokens: string[]): number {
  if (tokens.length === 0) return 0
  const haystack = content.toLowerCase()
  let matched = 0
  for (const token of tokens) if (haystack.includes(token)) matched++
  return matched / tokens.length
}

/** 集合 Jaccard（大小写归一，双向去重） */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const setB = new Set(b.map((x) => x.toLowerCase()))
  const seen = new Set<string>()
  let inter = 0
  for (const x of a) {
    const key = x.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (setB.has(key)) inter++
  }
  const union = seen.size + setB.size - inter
  return union > 0 ? inter / union : 0
}

function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

function round4(x: number): number {
  return Math.round(x * 10_000) / 10_000
}
