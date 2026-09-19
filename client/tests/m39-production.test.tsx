/**
 * M39（§97）：生产型渲染包测试。
 * - 阶段映射纯函数：stageOf / waveStage（去重排序 / 进度段 / 未收录回退）；
 * - 悬浮阶段条场景化（DEV-1 / SR-1）：development → 阶段名 + 进度段；无 group → 波次数字；
 * - 波次网格（MK-1）：marketing / health × 2–4 条 → data-wave-grid；窄屏 / 超限 / 非网格场景不启用；
 * - 工序卡（DEV-2）：交付明细行阶段标签 + 作者头像；
 * - 验收单（DEV-3）：acceptanceOf 派生（判定优先级 / 未决项）+ CloseoutCard 验收区；
 * - 工具卡变体（BI-1 / SR-2）：DbPipelineCard（SQL / 预览 / 已校验）与 SshEvidenceCard
 *   （exit / 输出折叠 / 截断 / 审批拒绝）+ ToolCard 场景路由；
 * - 复盘卡（SR-3）：::: postmortem 渲染与 fail-safe。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type * as React from 'react'
import type { AgentDefinition, AgentGroup, ChatMessage, ToolCallRecord } from '@multi-agent/shared'
import { CloseoutCard } from '../src/components/chat/CloseoutCard'
import { DbPipelineCard, parseDbMeta } from '../src/components/chat/DbPipelineCard'
import { DeliveryFiles } from '../src/components/chat/DeliveryList'
import { Markdown } from '../src/components/chat/Markdown'
import { SshEvidenceCard, parseSshMeta } from '../src/components/chat/SshEvidenceCard'
import { ToolCard } from '../src/components/chat/ToolCard'
import { WaveGroup } from '../src/components/chat/WaveGroup'
import { WaveStrip } from '../src/components/chat/WaveStrip'
import { SceneContext, type SceneCtx } from '../src/components/scene/context'
import { TooltipProvider } from '../src/components/ui/tooltip'
import { acceptanceOf } from '../src/lib/acceptance'
import { stageOf, waveStage } from '../src/lib/stage-map'
import { useArtifactMetaStore } from '../src/lib/use-artifact-meta'
import { useAgentStore } from '../src/stores/agent-store'
import { useLivePanelStore } from '../src/stores/live-panel-store'
import { useRunStore } from '../src/stores/run-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

const T0 = '2026-09-19T06:00:00.000Z'

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
const QA = makeAgent({ id: 'qa', name: '诺娃', role: '测试工程师' })
const DEVOPS = makeAgent({ id: 'devops', name: '奥托', role: 'DevOps 工程师' })
const SRE = makeAgent({ id: 'sre', name: '江屿', role: 'SRE 工程师', group: 'sre' })
const GROWTH = makeAgent({ id: 'growth', name: '高扬', role: '增长负责人', group: 'marketing' })
const CONTENT = makeAgent({ id: 'content', name: '林悦', role: '内容策划', group: 'marketing' })
const SEO = makeAgent({ id: 'seo', name: '韩枫', role: '搜索投放', group: 'marketing' })
const ALL = [PM, QA, DEVOPS, SRE, GROWTH, CONTENT, SEO]

function group(id: string, name: string): AgentGroup {
  return {
    id,
    name,
    description: '',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: [],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
  }
}

const GROUPS: AgentGroup[] = [group('development', '研发团队'), group('sre', '站点可靠性'), group('marketing', '市场增长')]

function agentMsg(id: string, agentId: string, content: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
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
  useSessionStore.setState({ currentId: 'sa', byId, order })
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

function wrap(ui: React.ReactElement, ctx: SceneCtx = makeCtx()): React.JSX.Element {
  return (
    <TooltipProvider delayDuration={0}>
      <SceneContext.Provider value={ctx}>{ui}</SceneContext.Provider>
    </TooltipProvider>
  )
}

function call(over: Partial<ToolCallRecord> & { name: string }): ToolCallRecord {
  return {
    id: 'c1',
    args: {},
    status: 'ok',
    startedAt: T0,
    ...over,
  }
}

beforeEach(() => {
  useAgentStore.setState({ agents: ALL, groups: GROUPS, skills: [], loaded: true, loading: false, statuses: {} })
  useSessionStore.setState({ currentId: 'sa', byId: new Map(), order: [], artifactVersion: 0 })
  useRunStore.setState({ active: false, queue: [] })
  useArtifactMetaStore.setState({ sessionId: undefined, version: -1, byPath: new Map() })
  useUiStore.setState({ composerInsert: undefined, quietMode: false, mainTab: 'chat' })
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

// ---------- 阶段映射纯函数 ----------

describe('M39 阶段映射（stage-map）', () => {
  it('stageOf：角色 → 阶段名；未收录场景 / 未映射角色 → undefined', () => {
    expect(stageOf('development', 'pm')).toBe('需求')
    expect(stageOf('development', 'devops')).toBe('部署')
    expect(stageOf('sre', 'sre')).toBe('分级止血')
    expect(stageOf('finance', 'finance')).toBeUndefined()
    expect(stageOf('development', 'nobody')).toBeUndefined()
  })

  it('waveStage：单成员带进度段；多成员去重排序；全未映射 → undefined', () => {
    expect(waveStage('development', [{ id: 'pm' }])).toEqual({ label: '需求', index: 1, total: 7 })
    expect(waveStage('development', [{ id: 'qa' }])).toEqual({ label: '测试', index: 6, total: 7 })
    // 并行波：去重 + 按阶段序（后端先于部署；旁路角色折入相邻段）
    expect(waveStage('development', [{ id: 'devops' }, { id: 'backend' }, { id: 'ai-engineer' }])).toEqual({
      label: '后端·部署',
      index: 7,
      total: 7,
    })
    expect(waveStage('finance', [{ id: 'finance' }])).toBeUndefined()
    expect(waveStage('development', [{ id: 'nobody' }])).toBeUndefined()
  })
})

// ---------- 悬浮阶段条（DEV-1 / SR-1） ----------

describe('WaveStrip 场景化（DEV-1 / SR-1）', () => {
  it('development：阶段名 + 进度段（第 N 波 → 需求 · 阶段 1/7）', () => {
    seed([agentMsg('m1', 'pm', '需求梳理完成')])
    const { container } = render(<WaveStrip info={{ runId: 'r1', turnIndex: 0, memberIds: ['m1'] }} group={GROUPS[0]} onJump={() => {}} />)
    const strip = container.querySelector('[data-wave-strip]')!
    expect(strip.getAttribute('data-wave-stage')).toBe('需求')
    expect(strip.textContent).toContain('需求')
    expect(strip.textContent).toContain('阶段 1/7')
    expect(strip.textContent).not.toContain('第 1 波')
  })

  it('sre：五段轨道（分级止血 · 阶段 1/5）', () => {
    seed([agentMsg('m1', 'sre', '先止血')])
    const { container } = render(<WaveStrip info={{ runId: 'r1', turnIndex: 0, memberIds: ['m1'] }} group={GROUPS[1]} onJump={() => {}} />)
    const strip = container.querySelector('[data-wave-strip]')!
    expect(strip.textContent).toContain('分级止血')
    expect(strip.textContent).toContain('阶段 1/5')
  })

  it('无 group / 未收录场景：回退波次数字（口径零变化）', () => {
    seed([agentMsg('m1', 'pm', '需求梳理完成')])
    const bare = render(<WaveStrip info={{ runId: 'r1', turnIndex: 0, memberIds: ['m1'] }} onJump={() => {}} />)
    expect(bare.container.querySelector('[data-wave-strip]')!.textContent).toContain('第 1 波')
    bare.unmount()

    seed([agentMsg('m1', 'growth', '增长方案')])
    const other = render(<WaveStrip info={{ runId: 'r1', turnIndex: 1, memberIds: ['m1'] }} total={3} group={GROUPS[2]} onJump={() => {}} />)
    const strip = other.container.querySelector('[data-wave-strip]')!
    expect(strip.textContent).toContain('第 2 波')
    expect(strip.textContent).toContain('共 3 波')
  })
})

// ---------- 波次网格（MK-1） ----------

describe('WaveGroup 波次网格（MK-1）', () => {
  const ids = ['g1', 'g2', 'g3']

  it('marketing × 3 条 → 2 列网格（data-wave-grid）', () => {
    seed([
      agentMsg('g1', 'growth', '增长：目标拆解'),
      agentMsg('g2', 'content', '内容：选题日历'),
      agentMsg('g3', 'seo', '搜索：关键词表'),
    ])
    const { container } = render(wrap(<WaveGroup ids={ids} />, makeCtx({ group: GROUPS[2] })))
    const grid = container.querySelector('[data-wave-grid]')
    expect(grid).not.toBeNull()
    expect(grid!.querySelector('.grid-cols-2')).not.toBeNull()
  })

  it('development 同波不改布局（非网格场景）；窄屏回退纵向', () => {
    seed([agentMsg('g1', 'pm', '甲'), agentMsg('g2', 'qa', '乙')])
    const dev = render(wrap(<WaveGroup ids={['g1', 'g2']} />, makeCtx({ group: GROUPS[0] })))
    expect(dev.container.querySelector('[data-wave-grid]')).toBeNull()
    dev.unmount()

    seed([agentMsg('g1', 'growth', '甲'), agentMsg('g2', 'content', '乙')])
    const narrow = render(wrap(<WaveGroup ids={['g1', 'g2']} />, makeCtx({ group: GROUPS[2], narrow: true })))
    expect(narrow.container.querySelector('[data-wave-grid]')).toBeNull()
  })

  it('超出 2–4 条（5 条）回退纵向单列', () => {
    seed([
      agentMsg('g1', 'growth', '1'),
      agentMsg('g2', 'content', '2'),
      agentMsg('g3', 'seo', '3'),
      agentMsg('g4', 'growth', '4'),
      agentMsg('g5', 'content', '5'),
    ])
    const { container } = render(wrap(<WaveGroup ids={['g1', 'g2', 'g3', 'g4', 'g5']} />, makeCtx({ group: GROUPS[2] })))
    expect(container.querySelector('[data-wave-grid]')).toBeNull()
  })
})

// ---------- 工序卡（DEV-2） ----------

describe('交付明细行（DEV-2）', () => {
  it('阶段标签 + 作者头像（development 阶段映射透传）', () => {
    const { container } = render(wrap(<DeliveryFiles paths={['docs/需求文档-登录.md']} agentId="pm" />, makeCtx({ group: GROUPS[0] })))
    const row = container.querySelector('[data-delivery-row]')!
    expect(row.getAttribute('data-delivery-stage')).toBe('需求')
    expect(container.textContent).toContain('需求')
    expect(screen.getByTitle('由 费利 交付')).toBeInTheDocument()
  })

  it('未收录场景：不渲染阶段标签', () => {
    const { container } = render(wrap(<DeliveryFiles paths={['docs/经营简报-本周.md']} agentId="pm" />, makeCtx({ group: group('finance', '财务法务') })))
    expect(container.querySelector('[data-delivery-row]')!.getAttribute('data-delivery-stage')).toBeNull()
  })
})

// ---------- 验收单（DEV-3） ----------

describe('M39 验收派生（acceptance）', () => {
  const qaMsg = (content: string, over: Partial<ChatMessage> = {}): ChatMessage => agentMsg('q1', 'qa', content, { runId: 'r1', ...over })

  it('判定优先级：未通过 > 有条件通过 > 通过；未决项去重至多 5 条', () => {
    const info = acceptanceOf(
      [qaMsg('验收判定：有条件通过。\n- 未决：灰度观察 24h\n- 待验证：旧接口下线排期\n- 未决：灰度观察 24h')],
      'r1',
    )
    expect(info?.verdict).toBe('有条件通过')
    expect(info?.unresolved).toEqual(['灰度观察 24h', '旧接口下线排期'])

    const strong = acceptanceOf([qaMsg('结论：未通过，需修复后复验')], 'r1')
    expect(strong?.verdict).toBe('未通过')
  })

  it('runId 过滤与缺省：其他 Run 的 qa 消息不参与派生；无判定 → undefined', () => {
    expect(acceptanceOf([qaMsg('验收判定：通过', { runId: 'r2' })], 'r1')).toBeUndefined()
    expect(acceptanceOf([qaMsg('测试计划已出，覆盖主流程')], 'r1')).toBeUndefined()
    expect(acceptanceOf([qaMsg('验收判定：通过')], undefined)).toBeUndefined()
  })
})

describe('收尾卡验收区（DEV-3）', () => {
  function stubArtifacts(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ artifacts: [{ path: 'docs/测试报告-登录.md', kind: 'markdown', size: 1024, mtime: 0, updatedAt: T0 }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
  }

  it('development：验收徽章 + 未决项渲染（qa 判定派生）', async () => {
    stubArtifacts()
    seed([
      agentMsg('q1', 'qa', '验收判定：通过（2 项未决）。\n- 未决：灰度观察 24h 后再推全量\n- 未决：旧接口下线排期待确认', {
        turnIndex: 4,
        artifacts: ['docs/测试报告-登录.md'],
        mentions: ['devops'],
      }),
      agentMsg('d1', 'devops', '部署完成，交还用户。', { turnIndex: 5, mentions: ['user'], artifacts: ['docs/部署说明-登录.md'] }),
    ])
    const { container } = render(wrap(<CloseoutCard />, makeCtx({ group: GROUPS[0] })))
    expect(screen.getByText('本轮交付')).toBeInTheDocument()
    const chip = container.querySelector('[data-qa-verdict]')!
    expect(chip.getAttribute('data-qa-verdict')).toBe('通过')
    expect(chip.textContent).toContain('验收 · 通过')
    const unresolved = container.querySelector('[data-qa-unresolved]')!
    expect(unresolved.textContent).toContain('验 收未决 · 2 项'.replace(' ', ''))
    expect(unresolved.textContent).toContain('灰度观察 24h 后再推全量')
    expect(unresolved.textContent).toContain('旧接口下线排期待确认')
    vi.unstubAllGlobals()
  })

  it('非 development 场景：不渲染验收区（降级不变）', () => {
    stubArtifacts()
    seed([agentMsg('d1', 'devops', '交还用户。', { turnIndex: 1, mentions: ['user'], artifacts: ['docs/部署说明-登录.md'] })])
    const { container } = render(wrap(<CloseoutCard />, makeCtx({ group: group('finance', '财务法务') })))
    expect(screen.getByText('本轮交付')).toBeInTheDocument()
    expect(container.querySelector('[data-qa-verdict]')).toBeNull()
    vi.unstubAllGlobals()
  })
})

// ---------- 工具卡变体（BI-1 / SR-2） ----------

describe('DbPipelineCard（BI-1）', () => {
  const meta = {
    columns: ['city', 'orders'],
    rows: [
      { city: '杭州', orders: '120' },
      { city: '上海', orders: '98' },
    ],
    rowCount: 42,
    durationMs: 118,
  }

  it('结构：已校验徽章 + 行数/耗时 + SQL 展开 + 结果预览表', () => {
    const { container } = render(<DbPipelineCard call={call({ name: 'db_query', args: { sql: 'SELECT city, COUNT(*) AS orders FROM t GROUP BY city' }, meta })} />)
    expect(container.querySelector('[data-db-pipeline="db_query"]')).not.toBeNull()
    expect(container.querySelector('[data-db-verified]')).not.toBeNull()
    expect(screen.getByText('42 行 · 118ms')).toBeInTheDocument()
    // SQL 默认折叠 → 展开
    expect(container.querySelector('pre')).toBeNull()
    fireEvent.click(container.querySelector('[data-sql-toggle]')!)
    expect(container.querySelector('pre')?.textContent).toContain('SELECT city')
    // 预览（≤5 行）
    const preview = container.querySelector('[data-db-preview]')!
    expect(preview.textContent).toContain('前 2 行（共 42 行）')
    expect(preview.textContent).toContain('杭州')
    expect(preview.textContent).toContain('120')
  })

  it('失败态：无已校验徽章、展示错误摘要；meta 缺省 → summary 降级', () => {
    const { container } = render(<DbPipelineCard call={call({ name: 'db_query', status: 'error', summary: '查询失败：relation does not exist', args: { sql: 'SELECT 1' } })} />)
    expect(container.querySelector('[data-db-verified]')).toBeNull()
    expect(container.textContent).toContain('relation does not exist')
    expect(parseDbMeta(undefined)).toBeUndefined()
    expect(parseDbMeta({ columns: 'oops' })).toBeUndefined()
  })
})

describe('SshEvidenceCard（SR-2）', () => {
  const meta = {
    command: 'df -h && free -m',
    exitCode: 0,
    durationMs: 240,
    output: 'Filesystem  Size\n/dev/sda1  40G\nMem  8192',
    truncated: false,
  }

  it('结构：exit 徽章 + 命令块 + 输出折叠（行数读数）', () => {
    const { container } = render(<SshEvidenceCard call={call({ name: 'ssh_exec', args: { command: 'df -h && free -m' }, meta })} />)
    expect(container.querySelector('[data-ssh-evidence]')).not.toBeNull()
    expect(container.querySelector('[data-exit-code="0"]')?.textContent).toContain('exit 0')
    expect(container.textContent).toContain('$ df -h && free -m')
    expect(container.querySelector('[data-ssh-output-toggle]')?.textContent).toContain('输出 · 3 行')
    fireEvent.click(container.querySelector('[data-ssh-output-toggle]')!)
    expect(container.textContent).toContain('Filesystem')
  })

  it('截断提示 / 停止态 / 审批拒绝徽章', () => {
    const trunc = render(<SshEvidenceCard call={call({ name: 'ssh_exec', args: {}, meta: { ...meta, truncated: true } })} />)
    expect(trunc.container.querySelector('[data-ssh-truncated]')).not.toBeNull()
    trunc.unmount()

    const stopped = render(<SshEvidenceCard call={call({ name: 'ssh_exec', args: { command: 'reboot' }, status: 'stopped', summary: '运行已停止，未执行' })} />)
    expect(stopped.container.textContent).toContain('已取消')
    stopped.unmount()

    const denied = render(<SshEvidenceCard call={call({ name: 'ssh_exec', args: { command: 'reboot' }, status: 'error', summary: '审批被拒绝' })} />)
    expect(denied.container.querySelector('[data-ssh-denied]')).not.toBeNull()
    expect(parseSshMeta({})).toBeUndefined()
  })
})

describe('ToolCard 场景路由（BI-1 / SR-2）', () => {
  it('bi × db_query → 取数管道卡；sre × ssh_exec → 证据卡；其他 → 通用卡', () => {
    const dbCall = call({ name: 'db_query', args: { sql: 'SELECT 1' }, summary: '查询完成：1 行（12ms）' })
    const bi = render(wrap(<ToolCard call={dbCall} />, makeCtx({ group: group('bi', '商业智能') })))
    expect(bi.container.querySelector('[data-db-pipeline]')).not.toBeNull()
    bi.unmount()

    const sshCall = call({ name: 'ssh_exec', args: { command: 'uptime' }, summary: '命令完成：exit 0（90ms）' })
    const sre = render(wrap(<ToolCard call={sshCall} />, makeCtx({ group: GROUPS[1] })))
    expect(sre.container.querySelector('[data-ssh-evidence]')).not.toBeNull()
    sre.unmount()

    // 非场景 / 未命中工具 → 通用卡（tool name 直显）
    const generic = render(wrap(<ToolCard call={call({ name: 'db_query', args: {}, summary: 'x' })} />, makeCtx({ group: GROUPS[0] })))
    expect(generic.container.querySelector('[data-db-pipeline]')).toBeNull()
    expect(generic.container.textContent).toContain('db_query')
    generic.unmount()

    const bare = render(<ToolCard call={dbCall} />)
    expect(bare.container.querySelector('[data-db-pipeline]')).toBeNull()
  })
})

// ---------- 复盘卡（SR-3） ----------

describe('复盘卡（::: postmortem）', () => {
  const PM_CONTENT = [
    '::: postmortem 故障复盘：登录超时',
    '分级：SEV2 · 核心功能降级',
    '时间线：10:02 告警 → 10:12 止血 → 10:40 恢复',
    '归因：连接池配置未随扩容同步',
    '- 改进项 | 连接池参数纳入变更检查单 | 马克斯 · 9-30',
    '- 改进项 | 扩容时自动校验连接池上限 | 奥托 · 10-15',
    ':::',
  ].join('\n')

  it('结构：标题 / 三要素排序 / 改进项与归属 chip', () => {
    const { container } = render(<Markdown content={PM_CONTENT} />)
    const card = container.querySelector('.md-postmortem[data-postmortem-card]')!
    expect(card.querySelector('.md-postmortem-title')?.textContent).toBe('故障复盘：登录超时')
    const keys = [...card.querySelectorAll('.md-postmortem-k')].map((k) => k.textContent)
    expect(keys).toEqual(['分级', '时间线', '归因'])
    expect(card.textContent).toContain('连接池配置未随扩容同步')
    const actions = card.querySelector('[data-postmortem-actions]')!
    expect(actions.querySelectorAll('li')).toHaveLength(2)
    expect(actions.textContent).toContain('连接池参数纳入变更检查单')
    expect(actions.textContent).toContain('马克斯 · 9-30')
  })

  it('fail-safe：未闭合 postmortem 内容展开（无壳、内容保留）', () => {
    const broken = ['::: postmortem 未完', '分级：SEV1'].join('\n')
    const { container } = render(<Markdown content={broken} />)
    expect(container.querySelector('[data-postmortem-card]')).toBeNull()
    expect(container.textContent).toContain('分级：SEV1')
  })
})
