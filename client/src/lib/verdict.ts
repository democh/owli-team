/**
 * M52-E：裁决容器（`::: verdict`）状态解析纯函数面——`scene/derive`（场景工作区）
 * 与 `md-ext/remark-ext`（消息渲染）共用单一事实来源。
 * M52-F：条目多空侧归因（`verdictItemSide`）——versus 信号列逐条分侧共用。
 *
 * 口径：
 * - 首词命中状态词即成立——精确（多方 / 空方 / 僵持 / 正方 / 反方）或自然语言前缀
 *   （「空方领先」「多方占优」→ 对应状态）；未命中 → none（降级无状态标题卡，原行为）；
 * - 首词未命中时，`derive` 侧可再退回条目「胜负」行（value 前缀同口径）判定；
 * - 「置信度」条目：显式百分比直取；定性词（高 / 中 / 低）启发式映射仅用于驱动
 *   局势条幅度，展示保留原词（不伪造精度）。
 */

export type VerdictStatus = 'long' | 'short' | 'draw' | 'none'

/** 状态词注册表（正反方与多空同构——scene-expansion-design §5.6 对弈统一机制） */
const VERDICT_WORDS: ReadonlyArray<readonly [word: string, status: VerdictStatus]> = [
  ['多方', 'long'],
  ['空方', 'short'],
  ['僵持', 'draw'],
  ['正方', 'long'],
  ['反方', 'short'],
]

/** 文本首词 → 状态（精确或前缀；「空方领先」→ short；未命中 → none） */
export function matchVerdictStatus(text: string): VerdictStatus {
  const t = text.trim()
  for (const [word, status] of VERDICT_WORDS) {
    if (t === word || t.startsWith(word)) return status
  }
  return 'none'
}

export interface VerdictHead {
  status: VerdictStatus
  title: string
}

/**
 * 容器参数 → 状态与标题（`<状态词|自然语言首词> [标题]`）：
 * - 命中状态词：标题取剩余部分；无剩余时保留非标准首词原文（如「空方领先」），
 *   标准词（「多方」）无剩余 → 空标题；
 * - 未命中：状态 none、标题取整串（无状态标题卡降级）。
 */
export function parseVerdictArg(arg: string): VerdictHead {
  const trimmed = arg.trim()
  const m = /^(\S+)\s*(.*)$/.exec(trimmed)
  const head = m?.[1] ?? ''
  const status = matchVerdictStatus(head)
  if (status === 'none') return { status, title: trimmed }
  const rest = (m?.[2] ?? '').trim()
  const canonical = VERDICT_WORDS.some(([word]) => word === head)
  return { status, title: rest || (canonical ? '' : head) }
}

export interface VerdictRow {
  label: string
  value: string
}

/**
 * 条目「胜负」行 → 状态兜底（仅首词未命中时使用；value 前缀口径同 matchVerdictStatus）。
 * 只认 `胜负…` 项名（辩论 / 投研协议裁决四要素之一）；无命中行 → none。
 */
export function verdictStatusFromItems(items: ReadonlyArray<VerdictRow>): VerdictStatus {
  for (const it of items) {
    if (it.label.startsWith('胜负')) {
      const status = matchVerdictStatus(it.value)
      if (status !== 'none') return status
    }
  }
  return 'none'
}

export interface VerdictConfidence {
  /** 0–100 幅度（驱动局势条）：显式百分比直取；定性词映射（高 80 / 中 60 / 低 30） */
  pct: number
  /** 展示文本（显式百分比「60%」；定性词保留原词「中高」） */
  label: string
}

/** 「置信度」条目解析（无该条目 / 无法解析 → undefined） */
export function verdictConfidenceOf(items: ReadonlyArray<VerdictRow>): VerdictConfidence | undefined {
  const row = items.find((it) => it.label.startsWith('置信度'))
  if (!row) return undefined
  const value = row.value.trim()
  if (value === '') return undefined
  const pctM = /(\d{1,3})\s*%/.exec(value)
  if (pctM) {
    const n = Number(pctM[1])
    if (n >= 1 && n <= 100) return { pct: n, label: `${n}%` }
  }
  // 定性词映射（先低后高再中：「中高」含高 → 80、「中低」含低 → 30）
  const pct = /低/.test(value) ? 30 : /高/.test(value) ? 80 : /中/.test(value) ? 60 : undefined
  if (pct === undefined) return undefined
  const headM = /^([^（(【[—\-；;，,。:：\s]{1,10})/.exec(value)
  return { pct, label: (headM?.[1] ?? value.slice(0, 10)).trim() }
}

/** 条目多空侧归因（M52-F 信号列分侧口径；meta = 不进信号列） */
export type VerdictItemSide = 'long' | 'short' | 'draw' | 'meta'

/** 裁决元信息条目（已上移局面头 / 裁决卡：不进信号列，避免三处重复） */
const META_LABEL_RE = /^(胜负|置信度|声明)/

/**
 * 裁决条目 → 信号列归属（M52-F）：
 * - 元信息（胜负 / 置信度 / 声明）→ meta；
 * - 显式阵营词（多方 / 多头 / 正方 / 看多 ↔ long；空方 / 空头 / 反方 / 看空 ↔ short）；
 * - 「翻盘条件」→ 败方（推翻当前裁决的路径 = 落后方的信号：空方领先时归多方，反之归空方）；
 * - 其余条目 → 裁决方向侧；none（无法判向）→ meta（裁决卡全量兜底）。
 */
export function verdictItemSide(label: string, status: VerdictStatus): VerdictItemSide {
  const l = label.trim()
  if (META_LABEL_RE.test(l)) return 'meta'
  if (/空方|空头|反方|看空/.test(l)) return 'short'
  if (/多方|多头|正方|看多/.test(l)) return 'long'
  if (/翻盘/.test(l)) {
    if (status === 'long') return 'short'
    if (status === 'short') return 'long'
    if (status === 'draw') return 'draw'
    return 'meta'
  }
  if (status === 'long') return 'long'
  if (status === 'short') return 'short'
  if (status === 'draw') return 'draw'
  return 'meta'
}
