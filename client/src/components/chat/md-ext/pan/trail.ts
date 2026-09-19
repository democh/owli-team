/**
 * M54-C t5：研习足迹（§5.5）——`ma:pn:trail:<sessionId>`（session 作用域，本地私密，不落库）。
 * 自动累计：看过盘数（按来源去重）/ 点宫次数 / 已游历宫数（地支去重）/ 摇卦次数 / 请教程数；
 * 展示为盘面页脚只读小字（无奖励、无提醒）。明确不做：签到 / 连击 / 成就 / 排行（合规红线 §5.6）。
 * 无会话上下文（独立渲染 / 单测）时调用方不应调用（本模块自身容错：非法数据回退空足迹）。
 */
import { readStored, writeStored } from '../../../scene/persist'

export interface PnTrail {
  chartsViewed: number
  palacesTapped: number
  palacesCovered: number
  yaoThrown: number
  linksAsked: number
  lastAt: number
  /** 内部：盘来源去重集合（不展示；上限防膨胀） */
  viewedKeys: string[]
  /** 内部：已游历地支去重集合（不展示） */
  coveredKeys: string[]
}

const VIEWED_MAX = 200

const EMPTY: PnTrail = {
  chartsViewed: 0,
  palacesTapped: 0,
  palacesCovered: 0,
  yaoThrown: 0,
  linksAsked: 0,
  lastAt: 0,
  viewedKeys: [],
  coveredKeys: [],
}

export function trailKey(sessionId: string): string {
  return `ma:pn:trail:${sessionId || '-'}`
}

/** 足迹变更订阅（M54 续完善：摇卦台宿主上移到 AppLayout 后，PanView 页脚据此跳组件刷新） */
const listeners = new Set<(sessionId: string) => void>()

export function subscribeTrail(fn: (sessionId: string) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s !== '') : []
}

function normalize(raw: unknown): PnTrail {
  if (!raw || typeof raw !== 'object') return { ...EMPTY }
  const o = raw as Partial<PnTrail>
  return {
    chartsViewed: num(o.chartsViewed),
    palacesTapped: num(o.palacesTapped),
    palacesCovered: num(o.palacesCovered),
    yaoThrown: num(o.yaoThrown),
    linksAsked: num(o.linksAsked),
    lastAt: num(o.lastAt),
    viewedKeys: strArr(o.viewedKeys).slice(-VIEWED_MAX),
    coveredKeys: strArr(o.coveredKeys).slice(0, 12),
  }
}

export function readTrail(sessionId: string): PnTrail {
  return normalize(readStored<unknown>('session', trailKey(sessionId), null))
}

function write(sessionId: string, t: PnTrail): PnTrail {
  const next = { ...t, lastAt: Date.now() }
  writeStored('session', trailKey(sessionId), next)
  for (const fn of [...listeners]) fn(sessionId)
  return next
}

/** 看过一张盘（key 去重：同一卡重复挂载不重复计数） */
export function recordView(sessionId: string, key: string): PnTrail {
  const t = readTrail(sessionId)
  if (key !== '' && t.viewedKeys.includes(key)) return write(sessionId, t)
  const viewedKeys = key !== '' ? [...t.viewedKeys, key].slice(-VIEWED_MAX) : t.viewedKeys
  return write(sessionId, { ...t, viewedKeys, chartsViewed: viewedKeys.length })
}

/** 点宫：次数 + 地支去重覆盖数 */
export function recordPalace(sessionId: string, zhi: string): PnTrail {
  const t = readTrail(sessionId)
  const coveredKeys = zhi !== '' && !t.coveredKeys.includes(zhi) ? [...t.coveredKeys, zhi] : t.coveredKeys
  return write(sessionId, {
    ...t,
    palacesTapped: t.palacesTapped + 1,
    coveredKeys,
    palacesCovered: coveredKeys.length,
  })
}

/** 成卦（第 6 爻定）一次 */
export function recordThrow(sessionId: string): PnTrail {
  const t = readTrail(sessionId)
  return write(sessionId, { ...t, yaoThrown: t.yaoThrown + 1 })
}

/** 回填草稿一次（请教程） */
export function recordAsk(sessionId: string): PnTrail {
  const t = readTrail(sessionId)
  return write(sessionId, { ...t, linksAsked: t.linksAsked + 1 })
}

/** 只读小字文案（设计例：`看过 4 张盘 · 十二宫已游历 7/12 · 摇卦 2 次`）；空足迹 → '' */
export function formatTrail(t: PnTrail): string {
  const parts: string[] = []
  if (t.chartsViewed > 0) parts.push(`看过 ${t.chartsViewed} 张盘`)
  if (t.palacesCovered > 0) parts.push(`十二宫已游历 ${t.palacesCovered}/12`)
  if (t.yaoThrown > 0) parts.push(`摇卦 ${t.yaoThrown} 次`)
  if (t.linksAsked > 0) parts.push(`请教 ${t.linksAsked} 次`)
  return parts.join(' · ')
}
