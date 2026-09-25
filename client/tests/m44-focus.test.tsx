/**
 * M44（AF-1–AF-5）：核心交付锚点测试。
 * - 纯函数：pickFocusPath（钉选 / 重要度 / 空集）· commentDraft / signoffDraft 模板 ·
 *   opinionsOf（高置信识别与负例）· closureOf（配对 / 误配防护 / 已满意排除 / 未闭环计数）；
 * - 变更卡（AF-2/AF-4）：写类工具消息 → 变更语义 + vN 徽章 + 回应角标；
 * - 锚定条（AF-1）：药丸读数（vN / 未闭环）、悬浮面板（版本线 / 未闭环标记已满意 / 钉选切换）、
 *   纯列表模式隐藏；
 * - 提意见入口（AF-3）：消息菜单模板回填；签收区（AF-5）：vN + 闭环统计 + 本地签收与取消。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { ChangeCard, isChangeMessage } from '../src/components/chat/ChangeCard'
import { CloseoutCard } from '../src/components/chat/CloseoutCard'
import { MessageActions } from '../src/components/chat/MessageActions'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { TooltipProvider } from '../src/components/ui/tooltip'
import {
  closureOf,
  commentDraft,
  loadSignoffs,
  opinionsOf,
  pickFocusPath,
  signoffDraft,
} from '../src/lib/focus-artifact'
import { useArtifactVersionsStore } from '../src/lib/artifact-versions'
import { useArtifactMetaStore } from '../src/lib/use-artifact-meta'
import { useAgentStore } from '../src/stores/agent-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSceneStore } from '../src/stores/scene-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T08:00:00.000Z'
const DOC = 'docs/需求文档-登录.md'
const CODE = 'src/app.ts'

// ---------- fixtures ----------

function makeAgent(over: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...over,
  }
}

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理' })
const DEVOPS = makeAgent({ id: 'devops', name: '奥托', role: 'DevOps 工程师' })
const ALL = [PM, DEVOPS]

const GROUPS: AgentGroup[] = [
  {
    id: 'development',
    name: '研发团队',
    description: '',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
  },
]

function msg(over: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    sessionId: 'sa',
    runId: 'r1',
    content: '内容',
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
  useSessionStore.setState({ currentId: 'sa', byId, order, artifactVersion: 0 })
}

function makeCtx(over: Partial<SceneCtx> = {}): SceneCtx {
  return {
    sessionId: 'sa',
    stage: { layout: 'stream', parts: [], fallback: true },
    participants: [],
    narrow: false,
    waitingIds: [],
    insert: () => {},
    focus: () => {},
    agentOf: (id) => ALL.find((a) => a.id === id),
    ...over,
  }
}

function wrap(ui: React.ReactElement, ctx: SceneCtx = makeCtx({ group: GROUPS[0] })): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={0}>
      <SceneContext.Provider value={ctx}>{ui}</SceneContext.Provider>
    </TooltipProvider>
  )
}

/** fetch 桩：/artifacts（元数据）+ /artifacts/versions（版本列表） */
function stubApi(versionsByPath: Record<string, Array<{ version: number; authorAgentId?: string; size?: number }>> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/artifacts/versions')) {
        const m = /path=([^&]+)/.exec(url)
        const path = m ? decodeURIComponent(m[1]!) : ''
        const versions = (versionsByPath[path] ?? []).map((v, i) => ({
          id: `v-${path}-${v.version}`,
          sessionId: 'sa',
          path,
          version: v.version,
          size: v.size ?? 1024,
          hash: `h${v.version}`,
          authorAgentId: v.authorAgentId ?? 'pm',
          createdAt: T0,
          messageId: `mv${i}`,
        }))
        return new Response(JSON.stringify({ versions }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      if (url.includes('/artifacts')) {
        return new Response(
          JSON.stringify({ artifacts: [{ path: DOC, kind: 'markdown', size: 2048, mtime: 0, updatedAt: T0 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

beforeEach(() => {
  sessionStorage.clear()
  localStorage.clear()
  vi.unstubAllGlobals()
  useAgentStore.setState({ agents: ALL, groups: GROUPS, skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [], artifactVersion: 0 })
  useRunStore.setState({ active: false, queue: [] })
  useSceneStore.setState({ listMode: false })
  useArtifactMetaStore.setState({ sessionId: undefined, version: -1, byPath: new Map() })
  useArtifactVersionsStore.setState({ sessionId: undefined, version: -1, byPath: new Map() })
  useUiStore.setState({ composerInsert: undefined, quietMode: true, mainTab: 'chat' })
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

// ---------- 纯函数 ----------

describe('M44 锚点与闭环纯函数', () => {
  it('pickFocusPath：钉选优先；未在集合回退重要度；空集 undefined', () => {
    expect(pickFocusPath([CODE, DOC], DOC)).toBe(DOC)
    expect(pickFocusPath([CODE, DOC])).toBe(DOC) // 文档 > 源码（partitionDelivery 重要度）
    expect(pickFocusPath([CODE], DOC)).toBe(CODE)
    expect(pickFocusPath([])).toBeUndefined()
  })

  it('模板：提意见 / 签收（去目录取文件名）', () => {
    expect(commentDraft('费利', DOC)).toBe('@费利 对《需求文档-登录.md》的意见：')
    expect(signoffDraft(DOC, 2)).toBe('已签收《需求文档-登录.md》v2。')
  })

  it('opinionsOf：高置信识别（「的意见」+ @成员 + 命中交付件名）；负例不构成意见', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '对《需求文档-登录.md》的意见：补充回滚说明', mentions: ['pm'] }),
      msg({ id: 'u2', role: 'user', content: '对《需求文档-登录.md》的意见：改改', mentions: [] }), // 无 @ 成员
      msg({ id: 'u3', role: 'user', content: '这份文档不错', mentions: ['pm'] }), // 无「的意见」
      msg({ id: 'u4', role: 'user', content: '对《不存在文件.md》的意见：x', mentions: ['pm'] }), // 未命中
      msg({ id: 'a1', role: 'agent', agentId: 'pm', content: '对《需求文档-登录.md》的意见：' }), // 非用户
    ]
    const opinions = opinionsOf(messages, [DOC, CODE])
    expect(opinions.map((o) => o.messageId)).toEqual(['u1'])
    expect(opinions[0]!.targetPath).toBe(DOC)
    expect(opinions[0]!.authorId).toBe('pm')
  })

  it('closureOf：同作者同文件后续变更配对；误配防护（作者 / 时序 / 文件）与已满意排除', () => {
    const messages = [
      msg({ id: 'u1', role: 'user', content: '对《需求文档-登录.md》的意见：补充回滚', mentions: ['pm'] }),
      msg({ id: 'u2', role: 'user', content: '对《需求文档-登录.md》的意见：再改', mentions: ['devops'] }), // 作者不匹配
      msg({ id: 'a1', role: 'agent', agentId: 'pm', content: '已修订', artifacts: [DOC] }),
      msg({ id: 'a0', role: 'agent', agentId: 'pm', content: '先前的交付', artifacts: [DOC], createdAt: '2026-09-19T07:00:00.000Z' }),
    ]
    const closure = closureOf(messages, [DOC])
    expect(closure.pairs).toHaveLength(1)
    expect(closure.pairs[0]!.opinion.messageId).toBe('u1')
    expect(closure.pairs[0]!.change.messageId).toBe('a1')
    expect(closure.responseOf.get('a1')?.messageId).toBe('u1')
    // devops 的意见无后续同作者变更 → 未闭环
    expect(closure.openOpinions.map((o) => o.messageId)).toEqual(['u2'])

    // 已满意本地排除
    const satisfied = closureOf(messages, [DOC], new Set(['u2']))
    expect(satisfied.openOpinions).toHaveLength(0)
    expect(satisfied.pairs).toHaveLength(1)
  })
})

// ---------- 变更卡（AF-2 / AF-4） ----------

describe('ChangeCard（AF-2 / AF-4）', () => {
  it('isChangeMessage：产出交付件 + 写类工具调用 → 变更语义', () => {
    const change = msg({
      id: 'a1',
      role: 'agent',
      agentId: 'pm',
      artifacts: [DOC],
      toolCalls: [{ id: 'c1', name: 'write_file', args: { path: DOC }, status: 'ok', startedAt: T0 }],
    })
    expect(isChangeMessage(change)).toBe(true)
    expect(isChangeMessage({ ...change, toolCalls: [] })).toBe(false)
    expect(isChangeMessage({ ...change, artifacts: [] })).toBe(false)
  })

  it('渲染：变更块 + vN 徽章 + 回应角标（配对成立）', async () => {
    stubApi({ [DOC]: [{ version: 2 }] })
    seed([
      msg({ id: 'u1', role: 'user', content: '对《需求文档-登录.md》的意见：补充回滚', mentions: ['pm'] }),
      msg({
        id: 'a1',
        role: 'agent',
        agentId: 'pm',
        content: '已按意见修订完毕',
        artifacts: [DOC],
        toolCalls: [{ id: 'c1', name: 'write_file', args: { path: DOC }, status: 'ok', startedAt: T0 }],
      }),
    ])
    const { container } = render(wrap(<ChangeCard message={useSessionStore.getState().byId.get('a1')!} />))
    expect(container.querySelector('[data-change-card]')).not.toBeNull()
    expect(screen.getByText(/变更 · 1/)).toBeInTheDocument()
    await waitFor(() => {
      expect(container.querySelector('[data-delivery-version="2"]')?.textContent).toBe('v2')
    })
    const badge = container.querySelector('[data-change-response]')!
    expect(badge.textContent).toBe('回应了你的意见')
    expect(badge.getAttribute('title')).toContain('回应意见：')
  })

  it('未配对（无后续变更或作者不匹配）→ 无回应角标', async () => {
    stubApi({ [DOC]: [{ version: 1 }] })
    seed([
      msg({ id: 'a1', role: 'agent', agentId: 'pm', content: '初版', artifacts: [DOC] }),
      msg({ id: 'u1', role: 'user', content: '对《需求文档-登录.md》的意见：改', mentions: ['pm'] }),
    ])
    const { container } = render(wrap(<ChangeCard message={useSessionStore.getState().byId.get('a1')!} />))
    expect(container.querySelector('[data-change-response]')).toBeNull()
  })
})

// ---------- 提意见入口（AF-3） ----------

describe('MessageActions 提意见（AF-3）', () => {
  it('成员交付消息 → 菜单出现「提意见（对交付件）」→ 模板入草稿', async () => {
    seed([
      msg({
        id: 'a1',
        role: 'agent',
        agentId: 'pm',
        content: '交付需求文档',
        artifacts: [DOC],
      }),
      msg({ id: 'u1', role: 'user', content: '好的' }),
    ])
    render(wrap(<MessageActions messageId="a1" />))
    await userEvent.click(screen.getByRole('button', { name: '消息操作' }))
    const item = screen.getByRole('menuitem', { name: '提意见（对交付件）' })
    await userEvent.click(item)
    expect(useUiStore.getState().composerInsert?.text).toBe(commentDraft('费利', DOC))
  })
})

// ---------- 签收区（AF-5） ----------

describe('CloseoutCard 签收区（AF-5）', () => {
  it('development：锚点 + vN + 闭环统计 + 签收回填与取消', async () => {
    stubApi({ [DOC]: [{ version: 2 }] })
    seed([
      msg({
        id: 'a1',
        role: 'agent',
        agentId: 'pm',
        content: '交付需求文档',
        turnIndex: 0,
        artifacts: [DOC],
        mentions: ['devops'],
      }),
      msg({ id: 'u1', role: 'user', content: '对《需求文档-登录.md》的意见：补充回滚', mentions: ['pm'] }),
      msg({
        id: 'a2',
        role: 'agent',
        agentId: 'pm',
        content: '已修订',
        turnIndex: 2,
        artifacts: [DOC],
      }),
      msg({ id: 'a3', role: 'agent', agentId: 'devops', content: '交还用户', turnIndex: 3, mentions: ['user'], artifacts: [CODE] }),
    ])
    const { container } = render(wrap(<CloseoutCard />))
    const signoff = container.querySelector('[data-signoff]')!
    expect(signoff).not.toBeNull()
    expect(signoff.getAttribute('data-signoff')).toBe(DOC)
    expect(signoff.textContent).toContain('核心交付签收')
    await waitFor(() => {
      expect(container.querySelector('[data-signoff-version="2"]')?.textContent).toBe('v2')
    })
    expect(signoff.textContent).toContain('已回应 1 · 未闭环 0')

    fireEvent.click(container.querySelector('[data-signoff-btn]')!)
    await waitFor(() => {
      expect(container.querySelector('[data-signoff-btn]')?.textContent).toContain('已签收 v2')
    })
    expect(useUiStore.getState().composerInsert?.text).toBe(signoffDraft(DOC, 2))
    expect([...loadSignoffs('sa')]).toEqual([`${DOC}@v2`])

    // 取消签收（重开用例记忆，避免跨断言残留）
    fireEvent.click(container.querySelector('[data-signoff-btn]')!)
    await waitFor(() => {
      expect(container.querySelector('[data-signoff-btn]')?.textContent?.trim()).toBe('签收')
    })
    expect([...loadSignoffs('sa')]).toEqual([])
  })
})
