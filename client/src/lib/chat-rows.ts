/**
 * M37：消息流行派生（纯函数，可单测）——虚拟列表的行结构唯一来源。
 * 结构键 = order 顺序 + 每条消息 `role~runId~turnIndex`（流式 delta 不改这些字段，字符串未变则不重派生）。
 *
 * 行类型：
 * - message：单条消息（user / system / 未成波的成员消息）；
 * - wave：并行协作组（同 runId + turnIndex 连续 ≥2 条成员消息，M16 语义不变）；
 * - wave-sep：波次分隔行（M37，ADR 0065）——仅在会话存在 ≥2 个波次起点时插入，只划线不承载交互。
 *
 * 约束：分隔行只依赖结构键（不依赖消息内容），与 rows 一一对应的 waveOf 也同源于结构键；
 * 任何依赖内容（文本/工具/交付件）的聚合都不得做成独立虚拟行（挂消息内或波次组附属）。
 */
export interface WaveInfo {
  runId: string
  turnIndex: number
  /** 本波成员消息 id（有序）；单条波次即该消息 */
  memberIds: string[]
}

export type StreamRow =
  | { kind: 'message'; id: string }
  | { kind: 'wave'; key: string; ids: string[] }
  | { kind: 'wave-sep'; key: string; info: WaveInfo }

export type RowRole = 'user' | 'agent' | 'system'

/** 消息导航条条目（M37-7）：一行一块；分隔行不产生条目 */
export interface RailItem {
  rowIndex: number
  kind: RowRole
  ids: string[]
}

export interface DerivedRows {
  rows: StreamRow[]
  /** 每行所属波次（无归属为 null；wave-sep 行归属该波）——悬浮阶段条按首个可见行取用 */
  waveOf: (WaveInfo | null)[]
  rail: RailItem[]
}

/** 单条消息是否满足「波次成员」条件（与 M16 成波规则一致：agent 且有 runId / turnIndex） */
function isWaveMember(role: string, runId: string, turnRaw: string): boolean {
  return role === 'agent' && runId !== '' && Number(turnRaw) >= 0
}

export function deriveRows(order: string[], structureKey: string): DerivedRows {
  const parts = structureKey === '' ? [] : structureKey.split('|')

  /** 第一遍：骨架片段（波次段 / 普通行） */
  type Piece =
    | { kind: 'seg'; runId: string; turnIndex: number; segKey: string; ids: string[]; row: StreamRow }
    | { kind: 'plain'; row: StreamRow; role: RowRole }
  const pieces: Piece[] = []

  let i = 0
  while (i < parts.length) {
    const p = parts[i]!.split('~')
    const role = p[0] ?? ''
    const runId = p[1] ?? ''
    const turnRaw = p[2] ?? '-1'
    const id = order[i]
    if (isWaveMember(role, runId, turnRaw)) {
      let j = i + 1
      while (j < parts.length) {
        const n = parts[j]!.split('~')
        if (n[0] !== 'agent' || n[1] !== runId || n[2] !== turnRaw) break
        j++
      }
      const ids = order.slice(i, j)
      const segKey = `${runId}~${turnRaw}`
      if (j - i >= 2) {
        pieces.push({
          kind: 'seg',
          runId,
          turnIndex: Number(turnRaw),
          segKey,
          ids,
          row: { kind: 'wave', key: `wave-${runId}-${turnRaw}`, ids },
        })
        i = j
      } else {
        if (id) pieces.push({ kind: 'seg', runId, turnIndex: Number(turnRaw), segKey, ids, row: { kind: 'message', id } })
        i++
      }
    } else {
      if (id) {
        pieces.push({
          kind: 'plain',
          row: { kind: 'message', id },
          role: role === 'user' ? 'user' : role === 'system' ? 'system' : 'agent',
        })
      }
      i++
    }
  }

  // 第二遍：波次起点标记（与上一个波次段 key 不同即新起点；同 key 的中断续段不算）
  let prevSegKey: string | null = null
  const starts: boolean[] = pieces.map((p) => {
    if (p.kind !== 'seg') return false
    const isStart = p.segKey !== prevSegKey
    prevSegKey = p.segKey
    return isStart
  })
  const showSeps = starts.filter(Boolean).length >= 2

  // 第三遍：插入分隔行并产出 waveOf / rail
  const rows: StreamRow[] = []
  const waveOf: (WaveInfo | null)[] = []
  const rail: RailItem[] = []
  pieces.forEach((p, idx) => {
    if (p.kind === 'seg') {
      const info: WaveInfo = { runId: p.runId, turnIndex: p.turnIndex, memberIds: p.ids }
      if (showSeps && starts[idx]) {
        rows.push({ kind: 'wave-sep', key: `sep-${p.segKey}`, info })
        waveOf.push(info)
      }
      rows.push(p.row)
      waveOf.push(info)
      rail.push({ rowIndex: rows.length - 1, kind: 'agent', ids: p.ids })
    } else {
      rows.push(p.row)
      waveOf.push(null)
      rail.push({ rowIndex: rows.length - 1, kind: p.role, ids: [p.row.kind === 'message' ? p.row.id : ''] })
    }
  })

  return { rows, waveOf, rail }
}
