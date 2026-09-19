/**
 * M54-C t3：盘面档案（§5.3）——`ma:pn:archive:<sessionId>`（session 作用域，本地私密，不落库）。
 * 条目 `{kind,title,fields,items,raw,savedAt}`：fields/items 为结构化行 JSON 原文（回看直灌 PanCard，
 * 零重解析）；上限 20 条 FIFO（溢出移除最旧并提示）；同内容去重（不重复存档）。
 * 无会话上下文的调用方不应调用（本模块自身容错：非法数据回退空数组）。
 */
import { readStored, writeStored } from '../../../scene/persist'

export interface ArchiveEntry {
  kind: string
  title: string
  /** 结构化行 JSON 原文（= remark 侧 data-fields） */
  fields: string
  /** 结构化行 JSON 原文（= remark 侧 data-items） */
  items: string
  /** 容器原文（无结构化行时的兜底渲染） */
  raw: string
  savedAt: number
}

export const ARCHIVE_MAX = 20

export function archiveKey(sessionId: string): string {
  return `ma:pn:archive:${sessionId || '-'}`
}

function isEntry(v: unknown): v is ArchiveEntry {
  if (!v || typeof v !== 'object') return false
  const o = v as Partial<ArchiveEntry>
  return typeof o.kind === 'string' && typeof o.savedAt === 'number' && (typeof o.fields === 'string' || typeof o.items === 'string')
}

export function readArchive(sessionId: string): ArchiveEntry[] {
  const raw = readStored<unknown>('session', archiveKey(sessionId), [])
  if (!Array.isArray(raw)) return []
  return raw.filter(isEntry).slice(-ARCHIVE_MAX)
}

function sameContent(a: ArchiveEntry, b: ArchiveEntry): boolean {
  return a.kind === b.kind && a.title === b.title && a.fields === b.fields && a.items === b.items
}

export type ArchiveSaveStatus = 'saved' | 'dup' | 'evicted'

/** 存为档案：同内容去重；超上限 FIFO 移除最旧（status=evicted 供溢出提示） */
export function saveArchive(sessionId: string, entry: ArchiveEntry): { list: ArchiveEntry[]; status: ArchiveSaveStatus } {
  const list = readArchive(sessionId)
  if (list.some((e) => sameContent(e, entry))) return { list, status: 'dup' }
  let next = [...list, entry]
  let status: ArchiveSaveStatus = 'saved'
  if (next.length > ARCHIVE_MAX) {
    next = next.slice(-ARCHIVE_MAX)
    status = 'evicted'
  }
  writeStored('session', archiveKey(sessionId), next)
  return { list: next, status }
}

export function removeArchive(sessionId: string, savedAt: number): ArchiveEntry[] {
  const next = readArchive(sessionId).filter((e) => e.savedAt !== savedAt)
  writeStored('session', archiveKey(sessionId), next)
  return next
}

/** 存档时间小字（只读展示） */
export function archiveTime(savedAt: number): string {
  try {
    return new Date(savedAt).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}
