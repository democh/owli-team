/**
 * 实况面板跟随引擎（M49 / ADR 0100）单测：
 * - resolveFollow 纯函数：op 自动聚焦全规则（暂停 / 本 Run 锁 / 60s 视图锁 / 60s 面锁）；
 * - artifact 软跟随（仅停在交付件面且未钉住）；
 * - faceOfOpKind 映射（connection 等不驱动聚焦）；
 * - store 接线：非当前会话忽略 / 程序性切换不算手动 / 手动切走锁本 Run / 点「实况」恢复 /
 *   openArtifact（chip 跳转）/ noteArtifact 软跟随 / beginRun 重置 Run 级护栏；
 * - 右栏收起（rightPanelOpen）：自动聚焦不抢展开；chip 跳转（显式意图）强制展开。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { OpEvent } from '@multi-agent/shared'
import {
  FOLLOW_LOCK_MS,
  faceOfOpKind,
  resolveFollow,
  useLivePanelStore,
  type FollowSnapshot,
} from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

/** 纯函数测试用固定时刻（避免真实时钟） */
const NOW = 1_000_000

function snap(over: Partial<FollowSnapshot> = {}): FollowSnapshot {
  return {
    rightView: 'members',
    face: 'browser',
    followPaused: false,
    artifactPinned: false,
    ...over,
  }
}

function makeOp(over: Partial<OpEvent> = {}): OpEvent {
  return {
    id: 'op1',
    ts: new Date().toISOString(),
    sessionId: 's1',
    runId: 'r1',
    actor: 'analyst',
    kind: 'db',
    action: 'db.query',
    status: 'ok',
    ...over,
  }
}

beforeEach(() => {
  localStorage.clear()
  useSessionStore.setState({ currentId: 's1' })
  useRunStore.setState({ runId: undefined, active: false })
  // 注意顺序：先摆正 ui-store（可能触发订阅写手动锁），再整体重置跟随状态
  useUiStore.setState({ rightView: 'members', rightPanelOpen: true, requestedArtifactPath: undefined })
  useLivePanelStore.setState({
    face: 'browser',
    faceLockedAt: undefined,
    viewLockedRunId: undefined,
    lastManualViewAt: undefined,
    followPaused: false,
    pinnedArtifactPath: undefined,
    followArtifactPath: undefined,
  })
})

describe('resolveFollow：op 自动聚焦（护栏全规则）', () => {
  it('右栏未在实况 → 切视图到实况 + 切到对应面', () => {
    expect(resolveFollow(snap(), { type: 'op', face: 'db' }, NOW)).toEqual({ toLive: true, face: 'db' })
    expect(resolveFollow(snap({ rightView: 'tasks' }), { type: 'op', face: 'ssh' }, NOW)).toEqual({
      toLive: true,
      face: 'ssh',
    })
  })

  it('已在实况 → 仅切面（不重复切视图）', () => {
    expect(resolveFollow(snap({ rightView: 'live', face: 'browser' }), { type: 'op', face: 'db' }, NOW)).toEqual({
      face: 'db',
    })
  })

  it('面已一致 → 空补丁（不打扰）', () => {
    expect(resolveFollow(snap({ rightView: 'live', face: 'db' }), { type: 'op', face: 'db' }, NOW)).toEqual({})
  })

  it('暂停跟随 → 全跳过（切视图与切面都不做）', () => {
    expect(resolveFollow(snap({ followPaused: true }), { type: 'op', face: 'db' }, NOW)).toEqual({})
    expect(resolveFollow(snap({ rightView: 'live', face: 'ssh', followPaused: true }), { type: 'op', face: 'db' }, NOW)).toEqual({})
  })

  it('本 Run 已手动切走（viewLockedRunId === currentRunId）→ 不拉回', () => {
    expect(resolveFollow(snap({ viewLockedRunId: 'r1', currentRunId: 'r1' }), { type: 'op', face: 'db', runId: 'r1' }, NOW)).toEqual({})
  })

  it('锁属事件 Run（与当前 Run 引用不同仍匹配）→ 不拉回', () => {
    expect(resolveFollow(snap({ viewLockedRunId: 'r1', currentRunId: 'r9' }), { type: 'op', face: 'db', runId: 'r1' }, NOW)).toEqual({})
  })

  it('锁属旧 Run（当前与事件 Run 均不匹配）→ 恢复跟随', () => {
    expect(
      resolveFollow(snap({ viewLockedRunId: 'r0', currentRunId: 'r1' }), { type: 'op', face: 'db', runId: 'r1' }, NOW),
    ).toEqual({ toLive: true, face: 'db' })
  })

  it('60s 视图锁：10s 前手动切换 → 不抢；锁过期（恰满 60s）→ 恢复', () => {
    expect(resolveFollow(snap({ lastManualViewAt: NOW - 10_000 }), { type: 'op', face: 'db' }, NOW)).toEqual({})
    expect(
      resolveFollow(snap({ lastManualViewAt: NOW - FOLLOW_LOCK_MS + 1 }), { type: 'op', face: 'db' }, NOW),
    ).toEqual({})
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'ssh', lastManualViewAt: NOW - FOLLOW_LOCK_MS }), { type: 'op', face: 'db' }, NOW),
    ).toEqual({ face: 'db' })
  })

  it('60s 面锁：在实况 → 保视图不抢面；不在实况 → 仅切视图不抢面', () => {
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'browser', faceLockedAt: NOW - 10_000 }), { type: 'op', face: 'ssh' }, NOW),
    ).toEqual({})
    expect(
      resolveFollow(snap({ rightView: 'tasks', face: 'browser', faceLockedAt: NOW - 5_000 }), { type: 'op', face: 'db' }, NOW),
    ).toEqual({ toLive: true })
  })

  it('面锁过期 → 跟切对应面', () => {
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'browser', faceLockedAt: NOW - FOLLOW_LOCK_MS - 1 }), { type: 'op', face: 'db' }, NOW),
    ).toEqual({ face: 'db' })
  })
})

describe('resolveFollow：artifact 软跟随', () => {
  it('停在交付件面且未钉住 → 选最新文件', () => {
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'artifacts' }), { type: 'artifact', path: 'out/a.md' }, NOW),
    ).toEqual({ followPath: 'out/a.md' })
  })

  it('钉住 → 不打扰（保持用户选择）', () => {
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'artifacts', artifactPinned: true }), { type: 'artifact', path: 'out/b.md' }, NOW),
    ).toEqual({})
  })

  it('非交付件面 / 非实况 → 不抢视图不抢页签', () => {
    expect(
      resolveFollow(snap({ rightView: 'live', face: 'db' }), { type: 'artifact', path: 'out/a.md' }, NOW),
    ).toEqual({})
    expect(
      resolveFollow(snap({ rightView: 'members', face: 'artifacts' }), { type: 'artifact', path: 'out/a.md' }, NOW),
    ).toEqual({})
  })
})

describe('faceOfOpKind 映射', () => {
  it('浏览器类（browser / browser-input / takeover）→ browser；db / ssh 各自成面', () => {
    expect(faceOfOpKind('browser')).toBe('browser')
    expect(faceOfOpKind('browser-input')).toBe('browser')
    expect(faceOfOpKind('takeover')).toBe('browser')
    expect(faceOfOpKind('db')).toBe('db')
    expect(faceOfOpKind('ssh')).toBe('ssh')
  })

  it('connection 等非实况操作 → undefined（不驱动聚焦）', () => {
    expect(faceOfOpKind('connection')).toBeUndefined()
  })
})

describe('store 接线：noteOp / 手动导航 / beginRun', () => {
  it('非当前会话的操作事件完全忽略（视图与面都不动）', () => {
    useLivePanelStore.getState().noteOp(makeOp({ sessionId: 's2', kind: 'db' }))
    expect(useUiStore.getState().rightView).toBe('members')
    expect(useLivePanelStore.getState().face).toBe('browser')
  })

  it('当前会话实况操作 → 自动切到实况 + 对应面（程序性切换不产生手动锁）', () => {
    useLivePanelStore.getState().noteOp(makeOp({ kind: 'ssh' }))
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().face).toBe('ssh')
    expect(useLivePanelStore.getState().viewLockedRunId).toBeUndefined()
    expect(useLivePanelStore.getState().lastManualViewAt).toBeUndefined()
  })

  it('程序性切到「实况」不冒认「手动点实况恢复」（旧 Run 锁保留）', () => {
    useLivePanelStore.setState({ viewLockedRunId: 'r0' })
    useLivePanelStore.getState().noteOp(makeOp({ kind: 'db', runId: 'r1' }))
    expect(useUiStore.getState().rightView).toBe('live')
    // 旧 Run 锁非「手动切到实况」的 resumeFollow 触发点，应原样保留
    expect(useLivePanelStore.getState().viewLockedRunId).toBe('r0')
  })

  it('手动切走 → 锁本 Run 不拉回；点「实况」→ 恢复跟随可再聚焦', () => {
    useRunStore.setState({ runId: 'r1', active: true })
    useUiStore.getState().setRightView('tasks')
    expect(useLivePanelStore.getState().viewLockedRunId).toBe('r1')

    useLivePanelStore.getState().noteOp(makeOp({ kind: 'db' }))
    expect(useUiStore.getState().rightView).toBe('tasks')

    useUiStore.getState().setRightView('live')
    expect(useLivePanelStore.getState().viewLockedRunId).toBeUndefined()

    useLivePanelStore.getState().noteOp(makeOp({ id: 'op2', kind: 'db' }))
    expect(useLivePanelStore.getState().face).toBe('db')
  })

  it('openArtifact：切实况 + 交付件面 + 钉住 + 锁本 Run（本 Run 内操作不再抢）', () => {
    useRunStore.setState({ runId: 'r1', active: true })
    useLivePanelStore.getState().openArtifact('out/report.md')
    const s = useLivePanelStore.getState()
    expect(useUiStore.getState().rightView).toBe('live')
    expect(s.face).toBe('artifacts')
    expect(s.pinnedArtifactPath).toBe('out/report.md')
    expect(s.followArtifactPath).toBe('out/report.md')
    expect(s.viewLockedRunId).toBe('r1')

    useLivePanelStore.getState().noteOp(makeOp({ kind: 'db' }))
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().face).toBe('artifacts')
  })

  it('requestArtifact（chip 跳转）→ 由订阅响应为 openArtifact', () => {
    useRunStore.setState({ runId: 'r1', active: true })
    useUiStore.getState().requestArtifact('out/x.md')
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useLivePanelStore.getState().pinnedArtifactPath).toBe('out/x.md')
    expect(useLivePanelStore.getState().face).toBe('artifacts')
  })

  it('noteArtifact：停在交付件面未钉住 → 软跟随；钉住后不打扰', () => {
    useUiStore.setState({ rightView: 'live' })
    useLivePanelStore.setState({ face: 'artifacts' })
    useLivePanelStore.getState().noteArtifact('out/a.md')
    expect(useLivePanelStore.getState().followArtifactPath).toBe('out/a.md')

    useLivePanelStore.getState().pinArtifact('out/a.md')
    useLivePanelStore.getState().noteArtifact('out/b.md')
    expect(useLivePanelStore.getState().followArtifactPath).toBe('out/a.md')
  })

  it('右栏收起时自动聚焦不抢展开：只切视图状态，重新展开停到实况', () => {
    useUiStore.setState({ rightPanelOpen: false })
    useLivePanelStore.getState().noteOp(makeOp({ kind: 'db' }))
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useUiStore.getState().rightPanelOpen).toBe(false)
    expect(useLivePanelStore.getState().face).toBe('db')
    expect(useLivePanelStore.getState().lastManualViewAt).toBeUndefined() // 程序性切换不算手动
  })

  it('openArtifact（chip 点击 = 用户显式意图）→ 收起态也展开右栏', () => {
    useUiStore.setState({ rightPanelOpen: false })
    useLivePanelStore.getState().openArtifact('out/report.md')
    expect(useUiStore.getState().rightView).toBe('live')
    expect(useUiStore.getState().rightPanelOpen).toBe(true)
  })

  it('beginRun：重置 Run 级护栏（锁 / 面锁 / 暂停）但保留当前面', () => {
    useLivePanelStore.setState({ face: 'ssh', viewLockedRunId: 'r1', faceLockedAt: NOW, followPaused: true })
    useLivePanelStore.getState().beginRun()
    const s = useLivePanelStore.getState()
    expect(s.viewLockedRunId).toBeUndefined()
    expect(s.faceLockedAt).toBeUndefined()
    expect(s.followPaused).toBe(false)
    expect(s.face).toBe('ssh')
  })
})
