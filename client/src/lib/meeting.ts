/**
 * M42（§71）：圆桌会议范式纯函数面——会议容器（::: meeting）与纪要容器（::: minutes）的解析、
 * 议题状态合并与进度推导、本地勾选兜底，以及纪要待办的负责人拆分。
 *
 * 口径与 remark-ext / scene/derive 两侧同语义：
 * - 会议条目 `- [x] 项`（已决）/ `- [>] 项`（进行中）/ `- 项`（待议）；
 * - 议题状态「容器更新优先，本地勾选兜底」——容器显式标记（done / doing）压过本地勾选，
 *   容器未标记（todo）时本地勾选视为已决（用户手动推进会议时的降级路径）；
 * - 纪要为 `- 键 | 值` 条目，键 ∈ {决议 / 待办 / 风险}（未识别键归入决议栏）；
 *   待办值以 `@负责人 事项` 开头时拆出负责人（点击派活 = 回填 `@负责人 ` 草稿）。
 */
import * as React from 'react'

export type MeetingState = 'todo' | 'doing' | 'done'

export interface MeetingItem {
  label: string
  state: MeetingState
}

export interface MinutesItem {
  key: string
  value: string
}

/** 纪要三栏（未识别键归入首栏） */
export const MINUTES_KEYS = ['决议', '待办', '风险'] as const
export type MinutesKey = (typeof MINUTES_KEYS)[number]

// ---------- 解析 ----------

function isState(v: unknown): v is MeetingState {
  return v === 'todo' || v === 'doing' || v === 'done'
}

/** data-items JSON → 会议条目（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseMeetingItems(json: string | undefined): MeetingItem[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: MeetingItem[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { label?: unknown; state?: unknown }
      if (typeof o.label !== 'string' || o.label === '') continue
      out.push({ label: o.label, state: isState(o.state) ? o.state : 'todo' })
    }
    return out
  } catch {
    return []
  }
}

/** 容器行 → 会议条目（`- [x] / - [>] / - 项`；与 remark-ext finalizeMeeting 同口径的轻量版：先剥状态标记，空标签跳过） */
export function meetingItemsOfLines(lines: readonly string[]): MeetingItem[] {
  const out: MeetingItem[] = []
  for (const raw of lines) {
    const m = /^[-*]\s+(.+)$/.exec(raw.trim())
    if (!m) continue
    let body = m[1]!.trim()
    let state: MeetingState = 'todo'
    const mark = /^\[([xX> ]?)\]\s*/.exec(body)
    if (mark) {
      const ch = (mark[1] ?? '').toLowerCase()
      state = ch === 'x' ? 'done' : ch === '>' ? 'doing' : 'todo'
      body = body.slice(mark[0].length).trim()
    }
    if (body === '') continue
    out.push({ label: body, state })
  }
  return out
}

/** data-items JSON → 纪要条目（非法 JSON / 形状不符 → 空数组，走 raw / children 回退） */
export function parseMinutesItems(json: string | undefined): MinutesItem[] {
  if (!json) return []
  try {
    const arr: unknown = JSON.parse(json)
    if (!Array.isArray(arr)) return []
    const out: MinutesItem[] = []
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      const o = v as { key?: unknown; value?: unknown }
      if (typeof o.value !== 'string' || o.value === '') continue
      out.push({ key: typeof o.key === 'string' ? o.key : '', value: o.value })
    }
    return out
  } catch {
    return []
  }
}

// ---------- 议题合并与进度（纯函数） ----------

/**
 * 合并多份会议容器的议题（容器更新语义）：
 * - 按标签对齐；后声明的显式状态（done / doing）覆盖先前状态，todo 不覆盖；
 * - 新标签按首见顺序追加（会议中途加议题）；
 * - 返回新数组（不改入参）。
 */
export function mergeMeetingItems(groups: readonly (readonly MeetingItem[])[]): MeetingItem[] {
  const order: string[] = []
  const byLabel = new Map<string, MeetingItem>()
  for (const group of groups) {
    for (const item of group) {
      const prev = byLabel.get(item.label)
      if (!prev) {
        order.push(item.label)
        byLabel.set(item.label, { ...item })
        continue
      }
      if (item.state !== 'todo') byLabel.set(item.label, { label: item.label, state: item.state })
    }
  }
  return order.map((label) => byLabel.get(label)!)
}

/** 生效状态：容器显式标记优先，todo 时本地勾选兜底为已决 */
export function effectiveState(item: MeetingItem, localDone: ReadonlySet<string>): MeetingState {
  if (item.state === 'done' || item.state === 'doing') return item.state
  return localDone.has(item.label) ? 'done' : 'todo'
}

export interface MeetingProgress {
  /** 生效状态视图（running 时首个未决项显示为进行中） */
  view: MeetingItem[]
  doneCount: number
  /** 首个未决项下标（全部已决为 -1） */
  currentIndex: number
}

/** 议题进度：生效状态 + 运行中把「首个未决项」点亮为进行中（会议正在推进的实时信号） */
export function meetingProgress(
  items: readonly MeetingItem[],
  localDone: ReadonlySet<string>,
  running: boolean,
): MeetingProgress {
  const view = items.map((it) => ({ label: it.label, state: effectiveState(it, localDone) }))
  const doneCount = view.reduce((n, it) => n + (it.state === 'done' ? 1 : 0), 0)
  const currentIndex = view.findIndex((it) => it.state !== 'done')
  if (running && currentIndex >= 0 && view[currentIndex]!.state === 'todo') {
    view[currentIndex] = { ...view[currentIndex]!, state: 'doing' }
  }
  return { view, doneCount, currentIndex }
}

/** 议题定位词：`经营简报：四方数据汇总` → `经营简报`（跳议题首条按此匹配正文） */
export function meetingLabelHead(label: string): string {
  const idx = label.search(/[:：]/)
  return (idx > 0 ? label.slice(0, idx) : label).trim()
}

// ---------- 纪要待办负责人 ----------

/** 拆分待办负责人：`@高扬 周三前给出素材排期` → { owner: '高扬', text: '周三前给出素材排期' } */
export function splitMinutesOwner(value: string): { owner?: string; text: string } {
  const m = /^@([^\s@]+)\s+(.+)$/.exec(value.trim())
  if (!m) return { text: value.trim() }
  return { owner: m[1]!, text: m[2]!.trim() }
}

// ---------- 本地勾选兜底（sessionStorage + 跨组件订阅） ----------

const STORAGE_PREFIX = 'ma:meeting:'
const EMPTY_LABELS: readonly string[] = []

const cache = new Map<string, readonly string[]>()
const listeners = new Set<() => void>()

/** 无会话上下文（独立渲染 / 单测）时的内存桶键 */
const ANON_KEY = ''

function storageKey(sid: string): string {
  return `${STORAGE_PREFIX}${sid}`
}

function readLabels(sid: string): readonly string[] {
  if (sid === ANON_KEY) return EMPTY_LABELS
  try {
    const raw = sessionStorage.getItem(storageKey(sid))
    if (raw === null) return EMPTY_LABELS
    const arr: unknown = JSON.parse(raw)
    if (!Array.isArray(arr)) return EMPTY_LABELS
    return arr.filter((v): v is string => typeof v === 'string' && v !== '')
  } catch {
    return EMPTY_LABELS // 存储损坏 / 隐私模式：回到未勾选态
  }
}

/** 本会话本地勾选（已决）议题标签（缓存引用稳定——useSyncExternalStore 快照安全） */
export function meetingChecks(sid: string | undefined): readonly string[] {
  const key = sid ?? ANON_KEY
  const hit = cache.get(key)
  if (hit) return hit
  const labels = readLabels(key)
  cache.set(key, labels)
  return labels
}

/** 勾选 / 取消本地已决（无会话上下文时仅即时态，不落存储） */
export function toggleMeetingCheck(sid: string | undefined, label: string): void {
  const key = sid ?? ANON_KEY
  const cur = meetingChecks(sid)
  const next = cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]
  cache.set(key, next)
  if (key !== ANON_KEY) {
    try {
      sessionStorage.setItem(storageKey(key), JSON.stringify(next))
    } catch {
      // 配额 / 隐私模式：忽略，仅本次会话内生效
    }
  }
  for (const fn of listeners) fn()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** React 侧订阅（会议卡勾选与议题进度条同一数据源，跨组件即时同步） */
export function useMeetingChecks(sid: string | undefined): readonly string[] {
  const getSnapshot = React.useCallback(() => meetingChecks(sid), [sid])
  return React.useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_LABELS)
}
