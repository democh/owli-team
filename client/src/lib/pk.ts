/**
 * M43（§72）：多方 PK 范式纯函数面——findings 缺陷-修补配对（解析与「已响应」推导）、
 * 对决分侧 / 阶段 / 计分、裁决回填模板，以及 claim 主张 / offer 报价容器的行级解析。
 *
 * 口径与 remark-ext / scene/derive 两侧同语义（轻量版实现，不跨层 import；同 lib/meeting 先例）：
 * - findings 条目 `- 缺陷 N | 描述 | 修补方向`（修补方向缺省 → 空串，降级普通行）；
 * - claim 容器：首参 = 主张标题；`细节：…` 字段行 → detail；`- 论据 | 证据` 条目 → reasons；
 * - offer 容器：`键：值` 字段行 + `- 键 | 值` 条目（同 pan 口径）。
 *
 * 「已响应」推导（PK-2）：后续消息提及「缺陷 N」即视为已响应；`\d+` 贪心整段匹配
 * （「缺陷 10」不会误配「缺陷 1」）；findings 定义行（`- 缺陷 N | …`）不计入提及（防自响应）。
 *
 * 对决分侧（PK-1）：显式结构化口径——场景 arena 席位（左/右）优先，其次姿态注册表
 * （DUEL_STANCE；头脑风暴红队对 ideator/challenger 等）；两侧均非空才成对决，无启发式。
 *
 * M63（批一）：交锋计量扩展（claims）、交锋看板（crossFireOf）、报价序列（offerSeriesOf）、
 * claim 扩展字段（视角 / 倾向 / 置信度）与回填模板库（TEMPLATES）——全部纯函数，容器优先。
 */

/** 裁决状态（与 scene/derive.SceneVerdictStatus 同构的本地定义：避免 lib → components 反向依赖） */
export type DuelVerdictStatus = 'long' | 'short' | 'draw' | 'none'

// ---------- findings（缺陷-修补配对，PK-2） ----------

export interface Finding {
  id: number
  text: string
  fix: string
}

function isFinding(v: unknown): Finding | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as { id?: unknown; text?: unknown; fix?: unknown }
  if (typeof o.id !== 'number' || !Number.isInteger(o.id) || o.id < 1) return undefined
  if (typeof o.text !== 'string') return undefined
  return { id: o.id, text: o.text, fix: typeof o.fix === 'string' ? o.fix : '' }
}

/** data-items JSON → findings（非法 JSON / 形状不符条目跳过；空结果走 raw 回退） */
export function parseFindingsItems(json: string | undefined): Finding[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: Finding[] = []
    for (const v of arr) {
      const f = isFinding(v)
      if (f && f.text !== '') out.push(f)
    }
    return out
  } catch {
    return []
  }
}

/** findings 条目行：`- 缺陷 N | 描述 | 修补方向`（首个 | 后余文再按 | 拆修补） */
const FINDING_ITEM_RE = /^\s*[-*]\s*(?:缺陷|问题)\s*(\d+)\s*[|｜]\s*(.*)$/

/** findings 定义行（提及扫描排除用：`- 缺陷 N | …` 为定义而非引用） */
const FINDING_DEF_RE = /^\s*[-*]\s*(?:缺陷|问题)\s*\d+\s*[|｜]/

/** 容器行 → findings（与 remark-ext finalizeFindings 同口径的轻量版；不合式跳过） */
export function findingsOfLines(lines: readonly string[]): Finding[] {
  const out: Finding[] = []
  for (const raw of lines) {
    const m = FINDING_ITEM_RE.exec(raw)
    if (!m) continue
    const id = Number(m[1])
    const rest = (m[2] ?? '').trim()
    if (!Number.isInteger(id) || rest === '') continue
    const pipe = rest.search(/[|｜]/)
    out.push(
      pipe < 0
        ? { id, text: rest, fix: '' }
        : { id, text: rest.slice(0, pipe).trim(), fix: rest.slice(pipe + 1).trim() },
    )
  }
  return out
}

/**
 * 文本中的缺陷编号提及（「已响应」推导数据源）：
 * - 定义行（`- 缺陷 N | …`）跳过（findings 容器自身不算响应）；
 * - 全角 / 半角分隔与空白容忍；`缺陷 10` 精确取 10。
 */
export function findingMentions(text: string): number[] {
  const out: number[] = []
  for (const raw of text.split('\n')) {
    if (FINDING_DEF_RE.test(raw)) continue
    const re = /缺陷\s*(\d+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(raw)) !== null) out.push(Number(m[1]))
  }
  return out
}

/** 会话存储最小形状（结构化入参：订阅 selector 与单测直接复用，不跨层 import store） */
export interface MessageLookup {
  order: readonly string[]
  byId: ReadonlyMap<string, { content: string }>
}

/**
 * messageId 之后（不含自身）全部消息的缺陷提及签名（排序去重 `'1,3'`；无提及为 `''`）。
 * 返回值恒为 primitive —— 可直接作 zustand selector（Object.is 稳定，流式增量不触发重渲染）。
 */
export function respondedSig(store: MessageLookup, messageId: string): string {
  const idx = store.order.indexOf(messageId)
  if (idx < 0) return ''
  const ids = new Set<number>()
  for (let i = idx + 1; i < store.order.length; i++) {
    const m = store.byId.get(store.order[i]!)
    if (!m) continue
    for (const id of findingMentions(m.content)) ids.add(id)
  }
  if (ids.size === 0) return ''
  return [...ids].sort((a, b) => a - b).join(',')
}

/** 签名串 → 编号集合（组件侧 useMemo 使用） */
export function findingIdsOfSig(sig: string): ReadonlySet<number> {
  if (sig === '') return EMPTY_IDS
  return new Set(sig.split(',').map((v) => Number(v)))
}

const EMPTY_IDS: ReadonlySet<number> = new Set()

// ---------- 对决分侧 / 阶段（PK-1） ----------

export type DuelSide = 'left' | 'right'
export type DuelPhase = '立论' | '反驳' | '修补'

/**
 * 对抗姿态注册表（显式登记；未登记角色 = 中立 / 中轴席）。
 * 新对抗组接入 = 表内登记（ADR 0117：不做内容启发式）。
 * 姿态仅在无席位声明时兜底，且场上不得存在「无站位」成员——混合波（如头脑风暴全员同波）不成对决。
 */
export const DUEL_STANCE: Record<string, DuelSide> = {
  // 辩论场（arena 席位之外的双保险口径）
  affirmative: 'left',
  negative: 'right',
  // 头脑风暴红队对（PK-1 主触发：红队挑刺 vs 发散）
  ideator: 'left',
  challenger: 'right',
}

export interface DuelSplit {
  left: string[]
  right: string[]
  /** 中立成员（中轴席；对决布局中整行渲染） */
  center: string[]
}

/** 成员按席位 / 姿态分侧（席位优先，含中轴席）；仅「全员各就各位且两侧均非空」才返回，否则 undefined（降级普通组） */
export function duelSides(
  memberIds: readonly string[],
  seats?: { left?: readonly string[]; right?: readonly string[]; center?: readonly string[] },
): DuelSplit | undefined {
  const seatLeft = new Set(seats?.left ?? [])
  const seatRight = new Set(seats?.right ?? [])
  const seatCenter = new Set(seats?.center ?? [])
  const out: DuelSplit = { left: [], right: [], center: [] }
  let stray = 0
  for (const id of memberIds) {
    const side: DuelSide | undefined = seatLeft.has(id) ? 'left' : seatRight.has(id) ? 'right' : undefined
    if (side === 'left') {
      if (!out.left.includes(id)) out.left.push(id)
    } else if (side === 'right') {
      if (!out.right.includes(id)) out.right.push(id)
    } else if (seatCenter.has(id)) {
      if (!out.center.includes(id)) out.center.push(id)
    } else {
      // 席位缺省时才查姿态注册表（席位优先，含中轴席）
      const stance = DUEL_STANCE[id]
      if (stance === 'left') {
        if (!out.left.includes(id)) out.left.push(id)
      } else if (stance === 'right') {
        if (!out.right.includes(id)) out.right.push(id)
      } else {
        stray++
      }
    }
  }
  // 场上存在「无站位」成员（未命中席位与姿态）→ 混合讨论而非对决，降级普通组（宁缺毋滥）
  if (stray > 0) return undefined
  return out.left.length > 0 && out.right.length > 0 ? out : undefined
}

/** 波序号 → 对决阶段徽章（0 立论 / 1 反驳 / ≥2 修补；负值按立论兜底） */
export function duelPhaseOf(waveIndex: number): DuelPhase {
  if (waveIndex <= 0) return '立论'
  return waveIndex === 1 ? '反驳' : '修补'
}

// ---------- 计分（PK-5 / M63 A1：交锋计量板数据源） ----------

export interface DuelSideTally {
  /** 本侧发言条数 */
  speaks: number
  /** 本侧提出的主张数（M63：claim 容器计数） */
  claims: number
  /** 本侧提出的缺陷总数 */
  findings: number
  /** 本侧缺陷中被后续消息提及的条数（被响应） */
  responded: number
}

export interface DuelTally {
  left: DuelSideTally
  right: DuelSideTally
}

export interface DuelMessage {
  /** 消息 id（M63：交锋看板 / 报价序列的定位锚点；缺省时对应条目跳过） */
  id?: string
  role?: string
  agentId?: string
  content: string
  /** 波次序号（M63：报价序列轮次标注；缺省不产出） */
  turnIndex?: number
}

/**
 * 对决计分（轻量派生）：各侧发言数 + 缺陷被响应数（见 lib 头注释的「已响应」口径）。
 * messages 建议传入本轮对决起的可见消息全集（跨波累计）。
 */
export function duelTally(
  messages: readonly DuelMessage[],
  sides: { left: readonly string[]; right: readonly string[] },
): DuelTally {
  const left = new Set(sides.left)
  const right = new Set(sides.right)
  const posted = { left: new Set<number>(), right: new Set<number>() }
  const mentioned = new Set<number>()
  const tally: DuelTally = {
    left: { speaks: 0, claims: 0, findings: 0, responded: 0 },
    right: { speaks: 0, claims: 0, findings: 0, responded: 0 },
  }
  for (const m of messages) {
    if (m.role !== undefined && m.role !== 'agent') continue
    if (!m.agentId) continue
    const side: DuelSide | undefined = left.has(m.agentId) ? 'left' : right.has(m.agentId) ? 'right' : undefined
    if (side) tally[side].speaks++
    if (side) tally[side].claims += claimNodesOfContent(m.content).length
    if (side) {
      for (const block of containerBlocks(m.content, 'findings')) {
        for (const f of findingsOfLines(block.lines)) posted[side].add(f.id)
      }
    }
    for (const id of findingMentions(m.content)) mentioned.add(id)
  }
  for (const side of ['left', 'right'] as const) {
    tally[side].findings = posted[side].size
    let n = 0
    for (const id of posted[side]) {
      if (mentioned.has(id)) n++
    }
    tally[side].responded = n
  }
  return tally
}

// ---------- 交锋看板（M63 A2）：findings 缺陷-修补配对的双泳道聚合 ----------

export interface CrossFireItem {
  id: number
  text: string
  messageId: string
  responded: boolean
}

export interface CrossFireModel {
  left: CrossFireItem[]
  right: CrossFireItem[]
}

/**
 * 交锋看板派生（M63）：各侧 findings 容器条目 + 「已响应」状态（全量消息提及扫描，
 * 口径同 duelTally / 配对卡——定义行不计提及）；未响应优先排序，同状态按编号升序。
 * 无 messageId 的消息跳过（定位锚点缺失）。
 */
export function crossFireOf(
  messages: readonly DuelMessage[],
  sides: { left: readonly string[]; right: readonly string[] },
): CrossFireModel {
  const left = new Set(sides.left)
  const right = new Set(sides.right)
  const per: Record<DuelSide, Map<number, CrossFireItem>> = { left: new Map(), right: new Map() }
  const mentioned = new Set<number>()
  for (const m of messages) {
    if (m.role !== undefined && m.role !== 'agent') continue
    for (const id of findingMentions(m.content)) mentioned.add(id)
    if (!m.agentId || !m.id) continue
    const side: DuelSide | undefined = left.has(m.agentId) ? 'left' : right.has(m.agentId) ? 'right' : undefined
    if (!side) continue
    for (const block of containerBlocks(m.content, 'findings')) {
      for (const f of findingsOfLines(block.lines)) {
        if (!per[side].has(f.id)) per[side].set(f.id, { id: f.id, text: f.text, messageId: m.id, responded: false })
      }
    }
  }
  const finish = (m: Map<number, CrossFireItem>): CrossFireItem[] =>
    [...m.values()]
      .map((it) => ({ ...it, responded: mentioned.has(it.id) }))
      .sort((a, b) => Number(a.responded) - Number(b.responded) || a.id - b.id)
  return { left: finish(per.left), right: finish(per.right) }
}

// ---------- 裁决回填模板（PK-4；统一回填语义：只写草稿不直发，ADR 0118） ----------

export interface VerdictTemplate {
  key: 'left' | 'right' | 'both' | 'again'
  label: string
  text: string
}

/** 对决组尾部裁决按钮模板（left / right 为左右席标签） */
export function verdictTemplates(left: string, right: string): VerdictTemplate[] {
  const close = (side: string): string =>
    `裁决：采纳「${side}」。请据此收口本轮对决，列出胜方要点与败方需保留的风险提示。`
  return [
    { key: 'left', label: `采纳「${left}」`, text: close(left) },
    { key: 'right', label: `采纳「${right}」`, text: close(right) },
    { key: 'both', label: '两案并保留', text: '裁决：两案并保留。请分别列出两套方案的适用条件、切换信号与共同底线。' },
    {
      key: 'again',
      label: '再来一轮',
      text: `@${left} @${right} 请再交锋一轮：针对上一轮未回应到的分歧点逐一回应，缺证据的一方补足证据。`,
    },
  ]
}

// ---------- 容器块扫描（claim / offer / findings；未闭合忽略——同 derive.parseContainers 口径） ----------

interface ContainerBlock {
  arg: string
  lines: string[]
}

function containerBlocks(content: string, name: string): ContainerBlock[] {
  const open = new RegExp(`^:::(?!:)\\s*${name}(?:\\s+(.*))?$`)
  const lines = content.split('\n')
  const out: ContainerBlock[] = []
  let i = 0
  while (i < lines.length) {
    const m = open.exec(lines[i]!.trim())
    if (!m) {
      i++
      continue
    }
    let j = i + 1
    while (j < lines.length && !/^:::\s*$/.test(lines[j]!.trim())) j++
    if (j >= lines.length) {
      i++
      continue
    }
    out.push({ arg: (m[1] ?? '').trim(), lines: lines.slice(i + 1, j) })
    i = j + 1
  }
  return out
}

// ---------- claim 主张（论断树数据源；§7.7） ----------

export interface ClaimReasonData {
  text: string
  evidence?: string
}

export interface ClaimNodeData {
  claim: string
  detail?: string
  reasons: ClaimReasonData[]
  /** M63：扩展字段（视角 / 倾向 / 置信度；缺省不影响渲染） */
  perspective?: string
  stance?: string
  confidence?: string
}

/** 细节字段行：`细节：…` / `说明：…`（取首行；其余内容照常） */
const CLAIM_DETAIL_RE = /^(?:细节|说明|detail)\s*[：:]\s*(.+)$/i

export function claimDetailOf(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    const m = CLAIM_DETAIL_RE.exec(raw.trim())
    if (m && m[1]!.trim() !== '') return m[1]!.trim()
  }
  return undefined
}

// ---------- claim 扩展字段（M63 N1：四路观点卡数据源） ----------

export interface ClaimMeta {
  perspective?: string
  stance?: string
  confidence?: string
}

/** 倾向词 → 色键（多 / 空 / 中性；A 股口径红涨绿跌；ClaimTree 与四路观点卡共用） */
export function stanceToneOf(stance: string): 'long' | 'short' | 'none' {
  if (/多|正|买|看涨/.test(stance)) return 'long'
  if (/空|反|卖|看跌/.test(stance)) return 'short'
  return 'none'
}

/** 扩展字段行：`视角：基本面` / `倾向：多方` / `置信度：高`（各取首条；与 细节 行并列共存） */
export const CLAIM_META_RE = /^(视角|倾向|置信度)\s*[：:]\s*(.+)$/

/** claim 容器行 → 扩展字段（remark 收尾与场景面板共用单一实现；缺省字段不产出键） */
export function claimMetaOf(lines: readonly string[]): ClaimMeta {
  const out: ClaimMeta = {}
  for (const raw of lines) {
    const m = CLAIM_META_RE.exec(raw.trim())
    if (!m) continue
    const value = (m[2] ?? '').trim()
    if (value === '') continue
    if (m[1] === '视角' && out.perspective === undefined) out.perspective = value
    else if (m[1] === '倾向' && out.stance === undefined) out.stance = value
    else if (m[1] === '置信度' && out.confidence === undefined) out.confidence = value
  }
  return out
}

/** 论据条目：`- 论据 | 证据`（证据缺省 → undefined；首个 | 前为论据） */
export function claimReasonsOfLines(lines: readonly string[]): ClaimReasonData[] {
  const out: ClaimReasonData[] = []
  for (const raw of lines) {
    const m = /^\s*[-*]\s+(.+)$/.exec(raw)
    if (!m) continue
    const body = m[1]!.trim()
    if (body === '') continue
    const idx = body.search(/[|｜]/)
    if (idx < 0) {
      out.push({ text: body })
    } else {
      const text = body.slice(0, idx).trim()
      const evidence = body.slice(idx + 1).trim()
      if (text !== '') out.push(evidence === '' ? { text } : { text, evidence })
    }
  }
  return out
}

/** data-reasons JSON → 论据（非法 JSON / 形状不符 → 空数组，走 raw 回退） */
export function parseClaimReasons(json: string | undefined): ClaimReasonData[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: ClaimReasonData[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { text?: unknown; evidence?: unknown }
      if (typeof o.text !== 'string' || o.text === '') continue
      out.push(typeof o.evidence === 'string' && o.evidence !== '' ? { text: o.text, evidence: o.evidence } : { text: o.text })
    }
    return out
  } catch {
    return []
  }
}

/** 消息内容 → 全部 claim 容器 → 论断树节点（arena 中轴聚合；保序） */
export function claimNodesOfContent(content: string): ClaimNodeData[] {
  const out: ClaimNodeData[] = []
  for (const block of containerBlocks(content, 'claim')) {
    if (block.arg === '') continue
    const node: ClaimNodeData = { claim: block.arg, reasons: claimReasonsOfLines(block.lines) }
    const detail = claimDetailOf(block.lines)
    if (detail !== undefined) node.detail = detail
    const meta = claimMetaOf(block.lines)
    if (meta.perspective !== undefined) node.perspective = meta.perspective
    if (meta.stance !== undefined) node.stance = meta.stance
    if (meta.confidence !== undefined) node.confidence = meta.confidence
    out.push(node)
  }
  return out
}

// ---------- offer 报价（报价卡 / 报价流数据源；§7.7） ----------

export interface OfferRow {
  label: string
  value: string
}

export interface OfferLines {
  fields: OfferRow[]
  items: OfferRow[]
}

/** 字段行 `键：值`（同 scene/derive.PAN_FIELD_RE 口径） */
const OFFER_FIELD_RE = /^([\p{L}\p{N}][^：:|]{0,15})[：:]\s*(.+)$/u

/** 容器行 → 字段 / 条目（同 panRowsOf 口径） */
export function offerRowsOf(lines: readonly string[]): OfferLines {
  const fields: OfferRow[] = []
  const items: OfferRow[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '') continue
    const item = /^\s*[-*]\s+(.+)$/.exec(line)
    if (item) {
      const content = item[1]!
      const idx = content.search(/[|｜]/)
      if (idx > 0) {
        items.push({ label: content.slice(0, idx).trim(), value: content.slice(idx + 1).trim() })
      } else {
        items.push({ label: '', value: content.trim() })
      }
      continue
    }
    const f = OFFER_FIELD_RE.exec(line)
    if (f) fields.push({ label: f[1]!.trim(), value: f[2]! })
  }
  return { fields, items }
}

/** data-fields / data-items JSON → 行（cards 兜底空数组） */
export function parseOfferRows(json: string | undefined): OfferRow[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: OfferRow[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; value?: unknown }
      if (typeof o.value !== 'string' || o.value === '') continue
      out.push({ label: typeof o.label === 'string' ? o.label : '', value: o.value })
    }
    return out
  } catch {
    return []
  }
}

const OFFER_PRICE_RE = /报价|价格|金额|总价|单价|价位/

/** 报价头条值：优先「报价 / 价格 / 金额」等键字段，其次首字段 / 首条目 / 标题参数 */
export function offerHeadline(fields: readonly OfferRow[], items: readonly OfferRow[], fallback = ''): string {
  for (const f of fields) {
    if (OFFER_PRICE_RE.test(f.label) && f.value !== '') return f.value
  }
  if (fields[0]?.value) return fields[0].value
  if (items[0]?.value) return items[0].value
  return fallback
}

/**
 * 报价数值（用于报价流的让步对比）：首个数值 × 量级（千 / 万 / 亿；缺省 1）。
 * 解析失败 → undefined（不参与 delta 计算）。
 */
export function offerAmount(text: string): number | undefined {
  const m = /(-?\d+(?:\.\d+)?)\s*(千|万|亿)?/.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n)) return undefined
  const unit = m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : m[2] === '千' ? 1e3 : 1
  return n * unit
}

/** 数量级紧凑格式（报价流 delta 展示；万 / 亿保留两位小数） */
export function formatOfferAmount(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${trimNum(n / 1e8)} 亿`
  if (abs >= 1e4) return `${trimNum(n / 1e4)} 万`
  if (abs >= 1e3) return `${trimNum(n / 1e3)} 千`
  return trimNum(n)
}

function trimNum(n: number): string {
  return Number(n.toFixed(2)).toString()
}

export interface OfferInstance {
  messageId: string
  title: string
  headline: string
  amount?: number
}

/** 消息内容 → 全部 offer 容器 → 报价实例（negotiation 报价流；保序） */
export function offersOfContent(content: string, messageId: string): OfferInstance[] {
  const out: OfferInstance[] = []
  for (const block of containerBlocks(content, 'offer')) {
    const rows = offerRowsOf(block.lines)
    const headline = offerHeadline(rows.fields, rows.items, block.arg)
    const amount = offerAmount(headline)
    out.push({ messageId, title: block.arg, headline, ...(amount !== undefined ? { amount } : {}) })
  }
  return out
}

// ---------- 报价序列（M63 G1/G2：报价折线 + 基准线 + 让步刻度数据源） ----------

export interface OfferPoint {
  messageId: string
  title: string
  headline: string
  /** 归一化金额（offerAmount 解析；解析失败的点不进序列） */
  amount: number
  side: DuelSide
  /** 让步理由（offer 容器「让步」字段值；缺省 = 未注明） */
  concession?: string
  turnIndex?: number
}

export interface OfferBaselines {
  target?: number
  bottom?: number
  batna?: number
}

export interface OfferSeries {
  points: OfferPoint[]
  baselines: OfferBaselines
  /** offset：每侧首个点在全局序列中的下标（折线分段用） */
}

const BASELINE_FILES: ReadonlyArray<readonly [keyof OfferBaselines, RegExp]> = [
  ['target', /目标/],
  ['bottom', /底线|walk-?away/i],
  ['batna', /BATNA|最佳替代/i],
]

const CONCESSION_FIELD_RE = /让步/

/**
 * 报价序列派生（M63）：成员消息中的 offer 容器按出现序聚合——
 * side 由消息作者 ∈ sides 判定；金额走 offerAmount 单一解析（不可解析点跳过，列表原样保留）；
 * 基准线（目标 / 底线 / BATNA）取首个显式字段行（缺省不产出）。
 */
export function offerSeriesOf(
  messages: readonly DuelMessage[],
  sides: { left: readonly string[]; right: readonly string[] },
): OfferSeries {
  const left = new Set(sides.left)
  const right = new Set(sides.right)
  const points: OfferPoint[] = []
  const baselines: OfferBaselines = {}
  for (const m of messages) {
    if (m.role !== undefined && m.role !== 'agent') continue
    if (!m.agentId || !m.id) continue
    const side: DuelSide | undefined = left.has(m.agentId) ? 'left' : right.has(m.agentId) ? 'right' : undefined
    if (!side) continue
    for (const block of containerBlocks(m.content, 'offer')) {
      const rows = offerRowsOf(block.lines)
      for (const f of rows.fields) {
        for (const [key, re] of BASELINE_FILES) {
          if (baselines[key] !== undefined || !re.test(f.label)) continue
          const v = offerAmount(f.value)
          if (v !== undefined) baselines[key] = v
        }
      }
      const headline = offerHeadline(rows.fields, rows.items, block.arg)
      const amount = offerAmount(headline)
      if (amount === undefined) continue
      const concessionRow = rows.fields.find((f) => CONCESSION_FIELD_RE.test(f.label))
      const turn = typeof m.turnIndex === 'number' ? { turnIndex: m.turnIndex } : {}
      points.push({
        messageId: m.id,
        title: block.arg,
        headline,
        amount,
        side,
        ...(concessionRow && concessionRow.value.trim() !== '' ? { concession: concessionRow.value.trim() } : {}),
        ...turn,
      })
    }
  }
  return { points, baselines }
}

// ---------- 回填模板库（M63 U3；统一回填语义：只写草稿不直发） ----------

/**
 * 对抗 / 博弈 / 分析域回填模板集中注册表（组件只引用常量；单测直测常量文本）。
 * `center` 为中轴席成员名（裁判 / 主管 / 教练），由宿主注入。
 */
export const TEMPLATES = {
  /** 交锋看板「催回应」 */
  chaseFinding: (id: number): string => `请回应「缺陷 ${id}」：给出修补或反驳，不要跳过。`,
  /** 证据无等级 → 补标注来源与等级 */
  askEvidence: (text: string): string =>
    `请为「${text}」标注证据来源与日期（等级：官方 / 学术 / 权威媒体 / 待核实）。`,
  /** 无证据论据 → 假设明示 */
  markHypothesis: (text: string): string => `「${text}」目前是假设，请补一条证据，或明示其假设地位。`,
  /** 对抗参与条：加一轮（point = 最新未决点，可缺省） */
  extraRound: (center: string, point?: string): string =>
    point !== undefined && point !== ''
      ? `@${center} 请再加一轮：重点交锋「${point}」，双方各挂一条新证据再回应。`
      : `@${center} 请再加一轮：针对尚未回应的分歧点逐一回应，缺证据的一方补足证据。`,
  /** 对抗参与条：叫停并裁决 */
  stopAndVerdict: (center: string): string =>
    `@${center} 请收束当前交锋，直接给出终局裁决（胜负 + 置信度 + 核心依据 + 翻盘条件）。`,
  /** M84：对抗参与条：立场互换（两队对调重赛 ≥1 轮；裁决长记录「同证据异结论」） */
  swapSides: (center: string): string =>
    `@${center} 指令：执行「立场互换」——两队全员对调重赛至少一轮，并记录「同证据异结论」现象。`,
  /** 对抗参与条：倾向表态 */
  leanSide: (center: string, side: string): string =>
    `@${center} 我的观感倾向：${side}——理由：…。请在终局裁决中回应这一倾向是否成立，并给出理由。`,
  /** 四路观点卡：补依据追问 */
  viewAsk: (perspective: string, claim: string): string =>
    `请围绕${perspective}观点「${claim}」补充依据与置信度说明。`,
  /** 四路分歧：裁决提示（invest 协议第 8 条口径） */
  splitAdjudicate: (): string =>
    `四路观点存在分歧，请主管按「来源可靠性 > 时效 > 一致性」裁决并记录在案。`,
  /** 让步幅度扩大（纪律警示）→ 说明回填 */
  concessionExplain: (delta: string, prev: string): string =>
    `这次让步幅度（${delta}）相比上一轮（${prev}）扩大了，请说明理由并给出换取条件。`,
  /** M66（N4）：立场推演（立场卡 / 汇聚板泳道） */
  stanceAsk: (role: string, care: string): string =>
    `请围绕「${role}」的核心关切「${care}」再推演一层：他们的真实约束与合理边界是什么？`,
  /** M66（N4）：分歧中间路径 */
  splitPath: (text: string): string => `请围绕分歧「${text}」推演可行的中间路径与各方可接受的最小让步。`,
  /** M66（N4）：存疑项核实路径 */
  splitVerify: (text: string): string => `请为存疑项「${text}」补充核实路径（来源与判定标准）。`,
} as const

/**
 * 多空对弈发起模板（M63 G4：versus 空态「发起多空对弈」按钮）。
 * 与 agents/_presets.yaml `bull-bear-duel` 的 prompt 同文——修改时两处同步（单一事实源说明见设计 §5-G4）。
 */
export const DUEL_PROMPT =
  '组织一轮多空对弈（围绕增长与估值的对抗推演，默认 3 轮）：@秦砚 持多方立论，@雷动 持空方立论，每轮挂证据与置信度并回应对方论据；@闻笛 汇拢双方证据弹药（附信源等级），随后由方程逐轮量化走子、主管终局裁决（胜负 + 置信度 + 核心依据 + 翻盘条件）。'

// ---------- 裁决状态标签（对决组头终局徽章；与 scene 裁决口径一致） ----------

/** 裁决状态 → 对决组头徽章文案（left / right 为左右席标签；none = 未裁决） */
export function duelVerdictLabel(status: DuelVerdictStatus, left: string, right: string): string | undefined {
  switch (status) {
    case 'long':
      return `${left} 胜`
    case 'short':
      return `${right} 胜`
    case 'draw':
      return '势均力敌'
    default:
      return undefined
  }
}
