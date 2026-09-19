/**
 * M60（§81）· arena 席位发言流实时化与容器面冻结边界（ADR 0129）组件测：
 * - live 通道（useSceneLiveMessages）：流式消息即时入侧栏（data-streaming 标记）、随 store 增量在
 *   500ms 节流后刷新（无需等 run 收束）、收束后条目保持并去流式标记；空正文 + 流式 → 「发言中…」；
 * - 冻结面边界：流式消息中的 `::: claim` 半截容器不进论断树（容器解析面仍走完成态快照），
 *   收束后自动出现——实时（纯文本投影）与冻结（容器解析）两通道互不越界；
 * - 宽度自适应（clamp(164px, 22%, 340px)）为纯 CSS，实测断言归 E2E（m52-stage arena 用例）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, ChatMessage } from '@multi-agent/shared'
import { ArenaStage } from '../src/components/scene/ArenaStage'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'

// ---------- fixtures ----------

const T0 = '2026-09-19T10:00:00.000Z'

function makeAgent(id: string, name: string): AgentDefinition {
  return {
    id,
    name,
    role: '成员',
    title: '',
    description: '',
    capabilities: [],
    group: 'debate',
    avatar: { gradient: ['#0ea5e9', '#14b8a6'], icon: 'user' },
    handoff: [],
  }
}

const LIYAN = makeAgent('affirmative', '立言')
const LIFENG = makeAgent('negative', '砺锋')
const MINGDUAN = makeAgent('judge', '明断')
const ALL_AGENTS = [LIYAN, LIFENG, MINGDUAN]

function agentMsg(id: string, agentId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    role: 'agent',
    agentId,
    content,
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...over,
  }
}

function seed(messages: ChatMessage[]): void {
  const byId = new Map<string, ChatMessage>()
  const order: string[] = []
  for (const m of messages) {
    byId.set(m.id, m)
    order.push(m.id)
  }
  useSessionStore.setState({ byId, order })
}

/** 原地更新一条消息（流式增量 / 收束的 store 侧模拟） */
function patchMsg(id: string, over: Partial<ChatMessage>): void {
  useSessionStore.setState((s) => {
    const byId = new Map(s.byId)
    const cur = byId.get(id)
    if (cur) byId.set(id, { ...cur, ...over })
    return { byId }
  })
}

/** arena 场景上下文（辩论场席位：立言 / 砺锋 / 明断） */
function makeCtx(): SceneCtx {
  return {
    sessionId: 'sa',
    stage: {
      layout: 'arena',
      seats: { left: ['affirmative'], right: ['negative'], center: ['judge'] },
      parts: [],
      fallback: false,
    },
    participants: [LIYAN, LIFENG, MINGDUAN],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (agentId) => ALL_AGENTS.find((a) => a.id === agentId),
  }
}

function wrap(ui: React.ReactElement): React.JSX.Element {
  return <SceneContext.Provider value={makeCtx()}>{ui}</SceneContext.Provider>
}

beforeEach(() => {
  useAgentStore.setState({ agents: [...ALL_AGENTS], groups: [], skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [] })
})

// ---------- live 通道：流式即时入流 ----------

describe('M60 §81 席位发言流实时化（live 通道）', () => {
  it('流式消息即时入侧栏（data-streaming）→ 增量 500ms 节流刷新 → 收束后保持并去标记', () => {
    seed([agentMsg('m1', 'affirmative', '正方立论：远程办公提升专注。', { status: 'streaming', turnIndex: 0 })])
    const { container } = render(
      wrap(
        <ArenaStage>
          <div>消息流</div>
        </ArenaStage>,
      ),
    )
    const left = container.querySelector('.scene-arena-left')!
    const first = left.querySelector('.scene-side-item')!
    expect(left.querySelectorAll('.scene-side-item')).toHaveLength(1)
    expect(first.getAttribute('data-streaming')).toBe('true')
    expect(first.textContent).toContain('远程办公提升专注')

    vi.useFakeTimers()
    try {
      // 增量增长：订阅触发但节流未到（500ms 内不刷新）
      act(() => patchMsg('m1', { content: '正方立论：远程办公提升专注。同期研究显示效率与幸福感双升。' }))
      expect(left.querySelector('.scene-side-item')!.textContent).not.toContain('双升')
      act(() => vi.advanceTimersByTime(500))
      expect(left.querySelector('.scene-side-item')!.textContent).toContain('双升')
      expect(left.querySelector('.scene-side-item')!.getAttribute('data-streaming')).toBe('true')

      // 收束：去流式标记，条目保持（无回退闪烁）
      act(() => patchMsg('m1', { status: 'complete' }))
      act(() => vi.advanceTimersByTime(500))
      const done = left.querySelector('.scene-side-item')!
      expect(done.getAttribute('data-streaming')).toBeNull()
      expect(done.textContent).toContain('双升')
    } finally {
      vi.useRealTimers()
    }
  })

  it('空正文 + 流式 → 「发言中…」占位（右席同步）', () => {
    seed([agentMsg('m1', 'negative', '', { status: 'streaming', turnIndex: 0 })])
    const { container } = render(
      wrap(
        <ArenaStage>
          <div>消息流</div>
        </ArenaStage>,
      ),
    )
    const item = container.querySelector('.scene-arena-right .scene-side-item')!
    expect(item.getAttribute('data-streaming')).toBe('true')
    expect(item.textContent).toContain('发言中…')
  })
})

// ---------- 冻结面边界：容器解析不越界 ----------

describe('M60 §81 冻结面边界（ADR 0129：半截容器不进派生）', () => {
  it('流式消息中的 ::: claim 不进论断树（侧栏照常入流）；收束后论断树出现', () => {
    const CLAIM = ['::: claim 正方主张：净收益为正', '- 论据 1 | 证据 1', ':::'].join('\n')
    seed([agentMsg('m1', 'affirmative', CLAIM, { status: 'streaming', turnIndex: 0 })])
    const { container } = render(
      wrap(
        <ArenaStage>
          <div>消息流</div>
        </ArenaStage>,
      ),
    )
    // live 通道：侧栏条目已入流（实时面）
    expect(container.querySelector('.scene-arena-left .scene-side-item')).not.toBeNull()
    expect(container.querySelector('.scene-arena-left .scene-side-item')!.getAttribute('data-streaming')).toBe('true')
    // 冻结通道：流式期半截容器不解析（论断树面板不渲染）
    expect(container.querySelector('[data-insight="claims"]')).toBeNull()

    vi.useFakeTimers()
    try {
      act(() => patchMsg('m1', { status: 'complete' }))
      act(() => vi.advanceTimersByTime(500))
      // 收束后：完成态快照进容器解析面
      expect(container.querySelector('[data-insight="claims"]')).not.toBeNull()
      expect(container.querySelector('[data-insight="claims"] .scene-claim-title')?.textContent).toBe('正方主张：净收益为正')
    } finally {
      vi.useRealTimers()
    }
  })
})
