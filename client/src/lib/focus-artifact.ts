/**
 * M44（核心交付锚点，ADR 依据见批次落位）：锚点选择 / 意见闭环 / 模板 — 纯函数与本地态。
 * - 锚点候选（AF-1）：手动钉选（localStorage `ma:focus-artifact:<sessionId>`）优先；否则按
 *   partitionDelivery 重要度取首个（文档 > 图示 > 源码 > 数据；过程产物剔除）——不落库（视图偏好）；
 * - 意见闭环（AF-4，口径：宁缺毋滥）：只认高置信配对——用户消息含「的意见」+ @非用户成员 +
 *   正文命中已知交付件名（全名或去扩展名主干）；后续同作者变更消息（artifacts 含同路径）配对成功；
 *   其余不计入未闭环；用户可「标记已满意」本地排除（sessionStorage `ma:m44-satisfied:<sid>`）；
 * - 模板（AF-3 / AF-5）：提意见草稿与签收草稿（只写草稿不直发，ADR 0064）。
 */
import type { ChatMessage } from '@multi-agent/shared'
import { baseName } from './artifacts'
import { partitionDelivery } from './delivery'

// ---------- 锚点选择与钉选（localStorage，视图偏好） ----------

export function focusKey(sessionId: string): string {
  return `ma:focus-artifact:${sessionId || '-'}`
}

export function loadPinnedPath(sessionId: string): string | undefined {
  try {
    return localStorage.getItem(focusKey(sessionId)) ?? undefined
  } catch {
    return undefined
  }
}

export function savePinnedPath(sessionId: string, path: string | undefined): void {
  try {
    if (path) localStorage.setItem(focusKey(sessionId), path)
    else localStorage.removeItem(focusKey(sessionId))
  } catch {
    // 隐私模式：忽略（本会话内仍按内存态展示由调用方自持）
  }
}

/** 去扩展名主干（`docs/需求文档-登录.md` → `需求文档-登录`） */
export function stemOf(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * 锚点选择：钉选（仍存在于交付件集合）优先；否则按重要度（partitionDelivery）取首个；
 * 无交付件 → undefined。
 */
export function pickFocusPath(paths: readonly string[], pinned?: string): string | undefined {
  if (paths.length === 0) return undefined
  if (pinned && paths.includes(pinned)) return pinned
  const { primary } = partitionDelivery(paths.map((path) => ({ path })))
  return primary[0]?.path ?? paths[0]
}

// ---------- 模板（AF-3 / AF-5） ----------

/** 提意见草稿：「@作者 对《交付名》的意见：」 */
export function commentDraft(authorName: string, path: string): string {
  return `@${authorName} 对《${baseName(path)}》的意见：`
}

/** 签收草稿：「已签收《交付名》vN。」 */
export function signoffDraft(path: string, version: number): string {
  return `已签收《${baseName(path)}》v${version}。`
}

// ---------- 意见闭环（AF-4） ----------

export interface OpinionRef {
  messageId: string
  /** 意见针对的交付件路径 */
  targetPath: string
  /** 被 @ 的作者（意见接收人） */
  authorId: string
  /** 意见正文摘要（面板展示） */
  excerpt: string
}

export interface ChangeRef {
  messageId: string
  authorId?: string
  /** 该消息产出的交付件路径 */
  paths: string[]
}

export interface ClosureResult {
  /** 高置信配对（意见 → 后续同作者同文件变更） */
  pairs: { opinion: OpinionRef; change: ChangeRef }[]
  /** 未闭环意见（未配对且未被标记已满意） */
  openOpinions: OpinionRef[]
  /** 变更消息 id → 其回应的意见（AF-4 变更卡角标） */
  responseOf: Map<string, OpinionRef>
}

/** 交付件名命中：正文含全名或去扩展名主干（避免「README」式裸词误报，取最长命中） */
function matchArtifact(content: string, paths: readonly string[]): string | undefined {
  let best: string | undefined
  let bestLen = 0
  for (const path of paths) {
    const name = baseName(path)
    const stem = stemOf(path)
    const hit = content.includes(name) ? name.length : content.includes(stem) ? stem.length : 0
    if (hit > bestLen) {
      best = path
      bestLen = hit
    }
  }
  return best
}

/**
 * 高置信意见识别：用户消息 + 含「的意见」+ @ 至少一名非用户成员 + 正文命中已知交付件名。
 * 不满足任一条件不构成意见（宁缺毋滥，不计入未闭环）。
 */
export function opinionsOf(messages: readonly ChatMessage[], artifactPaths: readonly string[]): OpinionRef[] {
  if (artifactPaths.length === 0) return []
  const out: OpinionRef[] = []
  for (const m of messages) {
    if (m.role !== 'user' || !m.content.includes('的意见')) continue
    const authorId = (m.mentions ?? []).find((x) => x !== 'user')
    if (!authorId) continue
    const targetPath = matchArtifact(m.content, artifactPaths)
    if (!targetPath) continue
    out.push({
      messageId: m.id,
      targetPath,
      authorId,
      excerpt: m.content.replace(/\s+/g, ' ').slice(0, 60),
    })
  }
  return out
}

/** 变更识别：成员消息产出交付件（paths 非空） */
export function changesOf(messages: readonly ChatMessage[]): ChangeRef[] {
  const out: ChangeRef[] = []
  for (const m of messages) {
    if (m.role !== 'agent' || !m.agentId) continue
    const paths = m.artifacts ?? []
    if (paths.length === 0) continue
    out.push({ messageId: m.id, authorId: m.agentId, paths })
  }
  return out
}

/**
 * 闭环推导（会话序内配对）：意见 → 其后首个「同作者 + 同文件」变更消息。
 * satisfied 为本地「标记已满意」的意见消息 id 集合（排除出未闭环计数）。
 */
export function closureOf(
  messages: readonly ChatMessage[],
  artifactPaths: readonly string[],
  satisfied: ReadonlySet<string> = new Set(),
): ClosureResult {
  const opinions = opinionsOf(messages, artifactPaths)
  const order = messages.map((m) => m.id)
  const idx = new Map(order.map((id, i) => [id, i]))
  const changes = changesOf(messages)
  const pairs: { opinion: OpinionRef; change: ChangeRef }[] = []
  const paired = new Set<string>()
  const responseOf = new Map<string, OpinionRef>()
  for (const opinion of opinions) {
    const oi = idx.get(opinion.messageId) ?? -1
    const change = changes.find(
      (c) =>
        c.authorId === opinion.authorId &&
        c.paths.includes(opinion.targetPath) &&
        (idx.get(c.messageId) ?? -1) > oi,
    )
    if (change) {
      pairs.push({ opinion, change })
      paired.add(opinion.messageId)
      if (!responseOf.has(change.messageId)) responseOf.set(change.messageId, opinion)
    }
  }
  const openOpinions = opinions.filter((o) => !paired.has(o.messageId) && !satisfied.has(o.messageId))
  return { pairs, openOpinions, responseOf }
}

// ---------- 已满意本地态（sessionStorage） ----------

export function satisfiedKey(sessionId: string): string {
  return `ma:m44-satisfied:${sessionId || '-'}`
}

export function loadSatisfied(sessionId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(satisfiedKey(sessionId))
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x !== ''))
  } catch {
    return new Set()
  }
}

export function saveSatisfied(sessionId: string, ids: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(satisfiedKey(sessionId), JSON.stringify([...ids]))
  } catch {
    // 配额 / 隐私模式：忽略
  }
}

// ---------- 签收本地态（sessionStorage） ----------

export function signoffKey(sessionId: string): string {
  return `ma:signoff:${sessionId || '-'}`
}

/** 签收标识：`<path>@v<version>` */
export function signoffTag(path: string, version: number): string {
  return `${path}@v${version}`
}

export function loadSignoffs(sessionId: string): Set<string> {
  try {
    const raw = sessionStorage.getItem(signoffKey(sessionId))
    if (!raw) return new Set()
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return new Set()
    return new Set(arr.filter((x): x is string => typeof x === 'string' && x !== ''))
  } catch {
    return new Set()
  }
}

export function saveSignoffs(sessionId: string, tags: ReadonlySet<string>): void {
  try {
    sessionStorage.setItem(signoffKey(sessionId), JSON.stringify([...tags]))
  } catch {
    // 配额 / 隐私模式：忽略
  }
}
