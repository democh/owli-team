/**
 * 收尾交付清单分层（M37-6 续修订，ADR 0123）：把「本轮交付」拆成
 * 最终交付（默认展示：结论性件按重要度取前 N）与「其他」（过程产物与溢出项，默认折叠）。
 *
 * - 过程产物 = 路径首段命中过程目录的工作区相对路径——`charts/` 是金融行情与博弈快照的
 *   落盘约定（server/src/finance），`data` / `raw` / `cache` / `tmp` / `temp` / `logs` 为
 *   通用中间态目录；快照数据行（实测 kind=code）会淹没结论性交付，故不进默认视图；
 * - 重要度分层：文档（md / office / pdf）> 图示与页面（html / mermaid）> 媒体 > 源码文本 > 数据（csv / json）；
 * - 全部纯前端派生（ADR 62）：零协议、服务端零改动；展开 / 收起为卡片本地态。
 */
import { extOf } from './artifacts'

/** 默认展示的最终交付行数上限（超出部分进「其他」组） */
export const DELIVERY_PRIMARY_LIMIT = 5

/** 过程目录（路径首段命中即判过程产物；新增数据落盘目录时在此登记） */
const PROCESS_DIRS = new Set(['charts', 'data', 'raw', 'cache', 'tmp', 'temp', 'logs'])

/** 文档类（结论性交付） */
const DOC_EXT = new Set(['md', 'markdown', 'pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'])
/** 图示与页面类（富文档 / 流程图） */
const PAGE_EXT = new Set(['html', 'htm', 'mmd', 'mermaid'])
/** 媒体类 */
const MEDIA_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'avif', 'bmp', 'tiff', 'tif',
  'mp4', 'webm', 'mov', 'm4v',
])
/** 数据类（表格 / 结构化数据；图表配置 *.chart.json 亦落此层） */
const DATA_EXT = new Set(['csv', 'tsv', 'json', 'jsonl', 'jsonc'])

/** 路径首段（无目录返回 ''） */
export function firstSegment(filePath: string): string {
  const i = filePath.indexOf('/')
  return i > 0 ? filePath.slice(0, i) : ''
}

/** 过程产物（快照 / 中间态数据）：位于过程目录下 */
export function isProcessArtifact(filePath: string): boolean {
  return PROCESS_DIRS.has(firstSegment(filePath))
}

/** 重要度分层（越小越靠前）：文档 0 / 图示与页面 1 / 媒体 2 / 源码文本 3 / 数据 4 */
export function deliveryTier(filePath: string): number {
  const ext = extOf(filePath)
  if (DOC_EXT.has(ext)) return 0
  if (PAGE_EXT.has(ext)) return 1
  if (MEDIA_EXT.has(ext)) return 2
  if (DATA_EXT.has(ext)) return 4
  return 3
}

export interface DeliveryPartition<T> {
  /** 默认展示：最终交付（按重要度稳定排序，≤ limit） */
  primary: T[]
  /** 折叠组：过程产物 + 溢出项（保持原交付顺序） */
  others: T[]
}

/** 分层：最终交付按重要度取前 limit；过程产物与溢出项进「其他」（保持原交付顺序） */
export function partitionDelivery<T extends { path: string }>(
  entries: T[],
  limit: number = DELIVERY_PRIMARY_LIMIT,
): DeliveryPartition<T> {
  const ranked = entries
    .map((entry, index) => ({ entry, index, tier: deliveryTier(entry.path) }))
    .filter((d) => !isProcessArtifact(d.entry.path))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((d) => d.entry)
  const primary = ranked.slice(0, limit)
  const primaryPaths = new Set(primary.map((e) => e.path))
  return { primary, others: entries.filter((e) => !primaryPaths.has(e.path)) }
}
