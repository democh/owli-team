/**
 * M37：消息流行派生（chat-rows.ts）单测——
 * 结构键 → 行结构（message / wave / wave-sep）、waveOf 对齐、rail 导航条目、分隔行插入条件（ADR 0065）。
 */
import { describe, expect, it } from 'vitest'
import { deriveRows, type StreamRow } from '../src/lib/chat-rows'

/** 结构键片段：role~runId~turnIndex（-1 表示无 turn，空串表示无 run） */
const seg = (role: string, runId = '', turn: number | string = -1): string => `${role}~${runId}~${turn}`
/** 组装完整结构键（与 ChatArea 的拼接口径一致） */
const key = (...parts: string[]): string => parts.join('|')
/** 行类型序列（断言骨架用） */
const kinds = (rows: StreamRow[]): string[] => rows.map((r) => r.kind)

describe('deriveRows：骨架与波次派生', () => {
  it('空输入：三态皆空', () => {
    const d = deriveRows([], '')
    expect(d.rows).toEqual([])
    expect(d.waveOf).toEqual([])
    expect(d.rail).toEqual([])
  })

  it('单条用户消息：message 行 + null 归属 + user 导航块', () => {
    const d = deriveRows(['m1'], key(seg('user')))
    expect(d.rows).toEqual([{ kind: 'message', id: 'm1' }])
    expect(d.waveOf).toEqual([null])
    expect(d.rail).toEqual([{ rowIndex: 0, kind: 'user', ids: ['m1'] }])
  })

  it('同 runId + turnIndex 连续 ≥2 条成员消息成 wave 行（M16 语义不变）', () => {
    const d = deriveRows(['a1', 'a2'], key(seg('agent', 'r1', 0), seg('agent', 'r1', 0)))
    expect(d.rows).toEqual([{ kind: 'wave', key: 'wave-r1-0', ids: ['a1', 'a2'] }])
    expect(d.waveOf[0]).toEqual({ runId: 'r1', turnIndex: 0, memberIds: ['a1', 'a2'] })
    expect(d.rail).toEqual([{ rowIndex: 0, kind: 'agent', ids: ['a1', 'a2'] }])
  })

  it('单条成员消息（不成波）：message 行 + 波次归属保留', () => {
    const d = deriveRows(['a1'], key(seg('agent', 'r1', 0)))
    expect(d.rows).toEqual([{ kind: 'message', id: 'a1' }])
    expect(d.waveOf[0]).toEqual({ runId: 'r1', turnIndex: 0, memberIds: ['a1'] })
  })

  it('≥2 个波次起点：插入分隔行（key 唯一、rail 不含分隔行）', () => {
    const d = deriveRows(
      ['u1', 'a1', 'a2', 'a3', 'a4', 'b1', 'b2'],
      key(seg('user'), seg('agent', 'r1', 0), seg('agent', 'r1', 0), seg('agent', 'r1', 1), seg('agent', 'r1', 1), seg('agent', 'r2', 0), seg('agent', 'r2', 0)),
    )
    expect(kinds(d.rows)).toEqual(['message', 'wave-sep', 'wave', 'wave-sep', 'wave', 'wave-sep', 'wave'])
    expect((d.rows[1] as { key: string }).key).toBe('sep-r1~0')
    expect(waveOfShapes(d)).toEqual([
      null,
      'r1~0',
      'r1~0',
      'r1~1',
      'r1~1',
      'r2~0',
      'r2~0',
    ])
    // 分隔行不产生导航条目：user + 3 个波次块
    expect(d.rail).toEqual([
      { rowIndex: 0, kind: 'user', ids: ['u1'] },
      { rowIndex: 2, kind: 'agent', ids: ['a1', 'a2'] },
      { rowIndex: 4, kind: 'agent', ids: ['a3', 'a4'] },
      { rowIndex: 6, kind: 'agent', ids: ['b1', 'b2'] },
    ])
  })

  it('仅 1 个波次起点：不插入分隔行', () => {
    const d = deriveRows(['u1', 'a1', 'a2'], key(seg('user'), seg('agent', 'r1', 0), seg('agent', 'r1', 0)))
    expect(kinds(d.rows)).toEqual(['message', 'wave'])
  })

  it('同 key 中续段（被用户消息隔开的第二段）不算新起点', () => {
    const d = deriveRows(
      ['a1', 'a2', 'u1', 'a3'],
      key(seg('agent', 'r1', 0), seg('agent', 'r1', 0), seg('user'), seg('agent', 'r1', 0)),
    )
    expect(kinds(d.rows)).toEqual(['wave', 'message', 'message'])
  })

  it('system 事件条 / 无 runId 的成员消息：plain 行 + 各自导航类', () => {
    const d = deriveRows(['s1', 'a1', 'u1'], key(seg('system'), seg('agent'), seg('user')))
    expect(kinds(d.rows)).toEqual(['message', 'message', 'message'])
    expect(d.waveOf).toEqual([null, null, null])
    expect(d.rail).toEqual([
      { rowIndex: 0, kind: 'system', ids: ['s1'] },
      { rowIndex: 1, kind: 'agent', ids: ['a1'] },
      { rowIndex: 2, kind: 'user', ids: ['u1'] },
    ])
  })

  it('turnIndex=-1 的成员消息不进波次段（视为 plain）', () => {
    const d = deriveRows(['a1', 'a2'], key(seg('agent', 'r1', -1), seg('agent', 'r1', -1)))
    expect(kinds(d.rows)).toEqual(['message', 'message'])
  })

  it('waveOf 与 rows 恒等对齐（每行恰好一个归属）', () => {
    const d = deriveRows(
      ['u1', 'a1', 'a2', 'u2', 'a3'],
      key(seg('user'), seg('agent', 'r1', 0), seg('agent', 'r1', 0), seg('user'), seg('agent', 'r1', 1)),
    )
    expect(d.waveOf).toHaveLength(d.rows.length)
  })
})

/** waveOf → 'runId~turn' / null（比对用，忽略 memberIds 细节） */
function waveOfShapes(d: ReturnType<typeof deriveRows>): (string | null)[] {
  return d.waveOf.map((w) => (w ? `${w.runId}~${w.turnIndex}` : null))
}
