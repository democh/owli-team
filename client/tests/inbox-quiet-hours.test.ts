/**
 * P4：通知空间化分级——生活空间晚间 inbox 推送静默（仅入箱不打扰）；
 * 空间未装配 / 非生活空间 / 未知会话 / 无 sessionId 一律不静默（旧行为零变化）。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { InboxItem, SessionSummary, Space } from '@multi-agent/shared'
import { inboxPushSilenced } from '../src/stores/ws-store'
import { useSessionStore } from '../src/stores/session-store'
import { useSpaceStore } from '../src/stores/space-store'

const T0 = '2026-09-01T00:00:00.000Z'
const WORK: Space = {
  id: 'work',
  name: '工作',
  kind: 'work',
  builtin: true,
  sort: 1,
  createdAt: T0,
  updatedAt: T0,
}
const LIFE: Space = { ...WORK, id: 'life', name: '生活', kind: 'life', sort: 2 }

function session(id: string, spaceId?: string): SessionSummary {
  return { id, title: id, participantIds: [], spaceId, createdAt: T0, updatedAt: T0, messageCount: 0 }
}

function item(overrides: Partial<InboxItem> = {}): InboxItem {
  return { id: 'i1', type: 'mention', title: '会话', createdAt: T0, ...overrides } as unknown as InboxItem
}

/** 本地时间构造（避免时区影响） */
const at = (h: number): Date => new Date(2026, 8, 23, h, 0)

beforeEach(() => {
  useSessionStore.setState({
    sessions: [session('s_life', 'life'), session('s_work', 'work'), session('s_plain')],
  })
  useSpaceStore.setState({ spaces: [WORK, LIFE], currentId: 'work', loaded: true })
})

describe('P4：inbox 通知空间化分级（晚间静默）', () => {
  it('生活空间 + 晚间（20:00–07:00）→ 静默；白天不静默', () => {
    expect(inboxPushSilenced(item({ sessionId: 's_life' }), at(22))).toBe(true)
    expect(inboxPushSilenced(item({ sessionId: 's_life' }), at(6))).toBe(true)
    expect(inboxPushSilenced(item({ sessionId: 's_life' }), at(10))).toBe(false)
    expect(inboxPushSilenced(item({ sessionId: 's_life' }), at(19))).toBe(false)
  })

  it('工作 / 缺省空间 + 晚间不静默（仅生活空间生效）', () => {
    expect(inboxPushSilenced(item({ sessionId: 's_work' }), at(22))).toBe(false)
    expect(inboxPushSilenced(item({ sessionId: 's_plain' }), at(22))).toBe(false)
  })

  it('空间未装配 / 无 sessionId / 未知会话一律不静默（旧行为零变化）', () => {
    useSpaceStore.setState({ spaces: [], currentId: 'default', loaded: true })
    expect(inboxPushSilenced(item({ sessionId: 's_life' }), at(22))).toBe(false)
    expect(inboxPushSilenced(item({}), at(22))).toBe(false)
    expect(inboxPushSilenced(item({ sessionId: 's_unknown' }), at(22))).toBe(false)
  })
})
