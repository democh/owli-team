/**
 * M36：设置（主区视图，自 M8 设置弹窗升级为与对话 / 控制台同级的独立页）。
 * - 左侧分类导航 + 右侧专业表单：覆盖全部运行期设置（模型与生成 / 媒体生成 / 上下文 /
 *   向量记忆 / 运行控制 / 工具与安全 / 联网与出网 / 金融投研）；
 *   导航点击滚动定位、滚动联动高亮（scrollspy）。
 * - M56：「媒体生成」分组（媒体连接全局配置，自「连接管理」迁入；启用即全场景可用）——
 *   见 components/settings/MediaConnectionsSection；并消费画布生成面板的聚焦请求（settingsFocus）。
 * - 数据源：GET /api/settings（data/settings.json 覆盖 env，白名单即安全边界）；
 *   PUT /api/settings 保存即写入覆盖层并热更新（无需重启）；脏状态提示「未保存改动」。
 * - 资源与集成：连接 / MCP / 角色 / 技能 概览与直达入口（全局资源统一收口）。
 * - 系统信息：GET /api/health 下发的运行参数（模型 / 地址 / 思考模式 / 降级轮询）+ 通知通道状态。
 * - 例外：金融「启用开关」与工具注册在启动时判定，切换后需重启（行内已标注）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import {
  Activity,
  Bot,
  Brain,
  Cable,
  Clapperboard,
  Cpu,
  Info,
  Layers,
  Loader2,
  Network,
  Plug,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import type { ConnectionKind } from '@multi-agent/shared'
import { apiGet, apiPost, apiPut } from '../../lib/api'
import { cn } from '../../lib/utils'
import { useUnsavedChanges } from '../../lib/unsaved-changes'
import { useAgentStore } from '../../stores/agent-store'
import { useConnectionsStore } from '../../stores/connections-store'
import { useMcpStore } from '../../stores/mcp-store'
import { useUiStore } from '../../stores/ui-store'
import { useWsStore } from '../../stores/ws-store'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { MediaConnectionsSection } from './MediaConnectionsSection'
import { ModelProvidersSection } from './ModelProvidersSection'

/** 运行期设置表单（与 server RuntimeSettingsSchema 33 字段一一对应） */
interface SettingsForm {
  llmModel: string
  summaryModel: string
  judgeModel: string
  temperature: number
  /** 统一温度：开启后忽略角色 AGENT.md 的 temperature，全部角色使用上述温度 */
  temperatureOverride: boolean
  maxTurnsPerRun: number
  contextBudgetTokens: number
  keepRecentTurns: number
  toolResultMaxTokens: number
  toolDetailKeep: number
  toolTimeoutMs: number
  handoffMode: 'auto' | 'tool' | 'text'
  /** M88：自动编排（意图判定）总开关；关闭 = 仅显式 mode / 规划先行生效 */
  autonomyEnabled: boolean
  approvalMode: 'off' | 'risky' | 'all'
  approvalTimeoutMs: number
  allowRunCommand: boolean
  allowSensitive: boolean
  notifyPollMs: number
  /** M25：向量记忆（嵌入连接热切换 + 召回参数 + 沉淀模式） */
  embeddingConnectionId: string
  memoryRecallEnabled: boolean
  memoryRecallTopK: number
  memoryRecallMinScore: number
  memoryRecallBudgetTokens: number
  memoryDigestMode: 'off' | 'session' | 'all'
  /** M34：金融投研（启用开关需重启，其余三项保存即生效） */
  financeEnabled: boolean
  financeQuoteRefreshMs: number
  financeMinIntervalMs: number
  financePyTimeoutMs: number
  /** M82：联网出口（热更新；代理目标与凭据在「连接管理」的出口代理连接中维护） */
  egressMode: 'direct' | 'proxy'
  egressConnectionId: string
  egressChannels: Array<'search' | 'finance' | 'browser' | 'mcp' | 'llm'>
  egressNoProxy: string[]
  egressFallback: 'direct' | 'fail'
  egressProbeUrl: string
}

/** 字段缺省回退（服务端旧版本缺字段时不渲染受控警告）：值对齐 server env 默认 */
const FALLBACK: SettingsForm = {
  llmModel: '',
  summaryModel: '',
  judgeModel: '',
  temperature: 0.7,
  temperatureOverride: false,
  maxTurnsPerRun: 20,
  contextBudgetTokens: 60_000,
  keepRecentTurns: 8,
  toolResultMaxTokens: 4_000,
  toolDetailKeep: 4,
  toolTimeoutMs: 120_000,
  handoffMode: 'auto',
  autonomyEnabled: true,
  approvalMode: 'risky',
  approvalTimeoutMs: 60_000,
  allowRunCommand: true,
  allowSensitive: false,
  notifyPollMs: 8_000,
  embeddingConnectionId: '',
  memoryRecallEnabled: true,
  memoryRecallTopK: 8,
  memoryRecallMinScore: 0.25,
  memoryRecallBudgetTokens: 600,
  memoryDigestMode: 'off',
  financeEnabled: false,
  financeQuoteRefreshMs: 10_000,
  financeMinIntervalMs: 0,
  financePyTimeoutMs: 30_000,
  egressMode: 'direct',
  egressConnectionId: '',
  egressChannels: ['search', 'finance', 'browser'],
  egressNoProxy: ['localhost', '127.0.0.1', '::1', '*.local', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16'],
  egressFallback: 'direct',
  egressProbeUrl: 'https://myip.ipip.net',
}

/** M82：出口状态（GET /api/egress/status） */
interface EgressStatusInfo {
  mode: 'direct' | 'proxy'
  state: 'direct' | 'proxied' | 'degraded'
  bindingName?: string
  bindingError?: string
  channels: string[]
  fails: number
  coolingUntil?: string
  lastOkAt?: string
  lastError?: string
  lastProbe?: { at: string; ok: boolean; exitIp?: string; latencyMs?: number; error?: string }
}

/** M82：出口通道多选（标签与默认值对齐 server EGRESS_CHANNELS） */
const EGRESS_CHANNELS: Array<{ id: SettingsForm['egressChannels'][number]; label: string; hint: string }> = [
  { id: 'search', label: '搜索抓取', hint: 'web_search / web_fetch' },
  { id: 'finance', label: '金融数据', hint: '行情 / K 线 / 新闻（含 Python 桥 P1）' },
  { id: 'browser', label: '浏览器', hint: '自启 Chromium 出口（P1）' },
  { id: 'mcp', label: 'MCP', hint: 'MCP HTTP / 子进程（P1）' },
  { id: 'llm', label: '模型与嵌入', hint: '默认不跟随（防本地 / 国内端点被代理）' },
]

interface HealthInfo {
  ok?: boolean
  model?: string
  baseUrl?: string
  thinking?: boolean
  notifyPollMs?: number
}

type SectionId =
  | 'model'
  | 'media'
  | 'context'
  | 'memory'
  | 'runtime'
  | 'safety'
  | 'network'
  | 'finance'
  | 'resources'
  | 'system'

const SECTIONS: Array<{ id: SectionId; label: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'model', label: '模型与生成', icon: Cpu },
  { id: 'media', label: '媒体生成', icon: Clapperboard },
  { id: 'context', label: '上下文', icon: Layers },
  { id: 'memory', label: '向量记忆', icon: Brain },
  { id: 'runtime', label: '运行控制', icon: Activity },
  { id: 'safety', label: '工具与安全', icon: ShieldCheck },
  { id: 'network', label: '联网与出网', icon: Network },
  { id: 'finance', label: '金融投研', icon: TrendingUp },
  { id: 'resources', label: '资源与集成', icon: Cable },
  { id: 'system', label: '系统信息', icon: Info },
]

const selectCls =
  'h-7 max-w-full rounded-md border border-input bg-background px-2 text-[12px] outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** 表单行左侧：字段名 + 说明（说明同时进入隐式 label 的可达名） */
function FieldLabel({ label, hint }: { label: string; hint?: string }): React.JSX.Element {
  return (
    <span className="w-full sm:w-44 sm:shrink-0 sm:pt-0.5">
      <span className="block text-[12px] text-foreground/85">{label}</span>
      {hint && <span className="mt-0.5 block text-[10.5px] leading-4 text-muted-foreground">{hint}</span>}
    </span>
  )
}

/** 两栏表单行（隐式 label 关联，测试与无障碍均按字段名拾取控件） */
function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <FieldLabel label={label} hint={hint} />
      <span className="flex min-w-0 flex-1 items-center gap-2">{children}</span>
    </label>
  )
}

/** 开关行：状态文案随勾选变化（「已开启 / 已关闭」） */
function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string
  hint?: string
  checked: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-3">
      <FieldLabel label={label} hint={hint} />
      <span className="flex items-center gap-2 pt-0.5">
        <input
          type="checkbox"
          checked={checked}
          className="size-4 accent-[hsl(var(--primary))]"
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className={cn('text-[11.5px]', checked ? 'text-emerald-700' : 'text-muted-foreground')}>
          {checked ? '已开启' : '已关闭'}
        </span>
      </span>
    </label>
  )
}

function NumberInput({
  value,
  min,
  max,
  step = 1,
  width = 'w-32',
  onChange,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  width?: string
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <Input
      type="number"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      className={cn('h-7 text-[12px]', width)}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  )
}

/** 分组卡片：标题 + 说明 + 表单行容器（滚动静默锚点） */
function Section({
  id,
  title,
  hint,
  register,
  children,
}: {
  id: SectionId
  title: string
  hint?: string
  register: (id: SectionId, el: HTMLElement | null) => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section
      ref={(el) => {
        register(id, el)
      }}
      className="scroll-mt-3"
    >
      <h3 className="text-[12.5px] font-semibold">{title}</h3>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
      <div className="mt-2 space-y-3 rounded-lg border bg-card p-3.5">{children}</div>
    </section>
  )
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 text-[12px] sm:flex-row sm:items-start sm:gap-3">
      <span className="w-full text-muted-foreground sm:w-44 sm:shrink-0">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/** 资源概览卡：图标 + 计数摘要 + 直达入口 */
function ResourceCard({
  icon,
  title,
  summary,
  detail,
  goLabel,
  onGo,
}: {
  icon: React.ReactNode
  title: string
  summary: string
  detail?: string
  goLabel: string
  onGo: () => void
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-medium">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground" title={detail}>
          {summary}
        </span>
      </span>
      <Button variant="outline" size="xs" className="shrink-0" onClick={onGo}>
        {goLabel}
      </Button>
    </div>
  )
}

const KIND_LABEL: Record<ConnectionKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
  chrome: '浏览器',
  ssh: 'SSH',
  embedding: '嵌入模型',
  media: '媒体生成',
  llm: '模型服务',
  proxy: '出口代理',
}

const WS_LABEL: Record<string, string> = {
  open: '实时推送（WS 已连接）',
  connecting: '连接中…',
  closed: '降级轮询',
}

export function SettingsView(): React.JSX.Element {
  const setAppView = useUiStore((s) => s.setAppView)
  const [form, setForm] = React.useState<SettingsForm | null>(null)
  /** 已保存值快照（JSON 串）：脏状态判定与「恢复已保存值」基线 */
  const [baseline, setBaseline] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [health, setHealth] = React.useState<HealthInfo | null>(null)
  const [activeSection, setActiveSection] = React.useState<SectionId>('model')
  const scrollRef = React.useRef<HTMLDivElement>(null)
  const sectionRefs = React.useRef<Partial<Record<SectionId, HTMLElement | null>>>({})
  // M25：嵌入连接候选（连接中心 embedding kind；不参与会话绑定）
  const connections = useConnectionsStore((s) => s.connections)
  const wsStatus = useWsStore((s) => s.status)
  const agents = useAgentStore((s) => s.agents)
  const skills = useAgentStore((s) => s.skills)
  const mcpServers = useMcpStore((s) => s.servers)
  const mcpTools = useMcpStore((s) => s.tools)
  const embeddingConns = React.useMemo(() => connections.filter((c) => c.kind === 'embedding'), [connections])
  /** M82：出口代理连接候选（连接中心 proxy kind；不参与会话绑定） */
  const proxyConns = React.useMemo(() => connections.filter((c) => c.kind === 'proxy'), [connections])
  const [egressStatus, setEgressStatus] = React.useState<EgressStatusInfo | null>(null)
  /** 旁路名单文本框（逗号/换行分隔；与 egressNoProxy 数组同步，中间态保留原始文本） */
  const [noProxyText, setNoProxyText] = React.useState('')
  const [probing, setProbing] = React.useState(false)

  const loadEgressStatus = React.useCallback(async (): Promise<void> => {
    try {
      const res = await apiGet<{ status: EgressStatusInfo | null }>('/api/egress/status')
      setEgressStatus(res.status)
    } catch {
      setEgressStatus(null)
    }
  }, [])

  const load = React.useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const res = await apiGet<{ settings: Partial<SettingsForm> }>('/api/settings')
      const next = { ...FALLBACK, ...res.settings }
      setForm(next)
      setBaseline(JSON.stringify(next))
      setNoProxyText(next.egressNoProxy.join(', '))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void load()
    void loadEgressStatus()
    void useConnectionsStore.getState().load()
    void useAgentStore
      .getState()
      .load()
      .catch(() => undefined)
    void useMcpStore.getState().refreshAll()
    void apiGet<HealthInfo>('/api/health')
      .then((res) => setHealth(res))
      .catch(() => setHealth(null))
  }, [load, loadEgressStatus])

  const set = <K extends keyof SettingsForm>(key: K, value: SettingsForm[K]): void => {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  const dirty = form !== null && JSON.stringify(form) !== baseline
  const confirmDiscard = useUnsavedChanges(dirty)

  /** 统一温度开关说明：展示角色温度覆盖统计（AGENT.md 中单独配置了 temperature 的角色数） */
  const tempOverrideHint = React.useMemo(() => {
    if (form?.temperatureOverride) return '已开启：全部角色使用上方温度，忽略 AGENT.md 中的单独配置'
    if (agents.length === 0) return '开启后全部角色使用上方温度，忽略 AGENT.md 中的单独配置'
    const covered = agents.filter((a) => a.temperature !== undefined).length
    return `当前 ${covered}/${agents.length} 个角色单独配置了温度，全局值仅对其余角色生效；开启后全部使用上方温度`
  }, [form?.temperatureOverride, agents])

  const save = async (): Promise<void> => {
    if (!form) return
    setSaving(true)
    try {
      await apiPut('/api/settings', form)
      setBaseline(JSON.stringify(form))
      toast('设置已保存并即时生效')
      // M82：出口字段可能变化 → 刷新出口状态
      void loadEgressStatus()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  /** M82：通道多选切换 */
  const toggleEgressChannel = (id: SettingsForm['egressChannels'][number]): void => {
    setForm((prev) =>
      prev
        ? {
            ...prev,
            egressChannels: prev.egressChannels.includes(id)
              ? prev.egressChannels.filter((c) => c !== id)
              : [...prev.egressChannels, id],
          }
        : prev,
    )
  }

  /** M82：出口探测（复用连接测试接口：经该绑定请求 egressProbeUrl，回显出口 IP / 延迟） */
  const testEgress = async (): Promise<void> => {
    const id = form?.egressConnectionId ?? ''
    if (!id) {
      toast.error('请先选择出口连接（或在「连接管理」新建出口代理）')
      return
    }
    setProbing(true)
    try {
      const res = await apiPost<{ result: { ok: boolean; detail?: string; error?: string } }>(
        `/api/connections/${id}/test`,
      )
      if (res.result.ok) toast(`出口可用：${res.result.detail ?? '连接正常'}`)
      else toast.error(`出口不可用：${res.result.error ?? '未知错误'}`)
      await loadEgressStatus()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setProbing(false)
    }
  }

  /** M82：出口状态摘要（面板展示） */
  const egressStatusText = React.useMemo(() => {
    if (!egressStatus) return '未装配（服务端未返回出口状态）'
    if (egressStatus.bindingError) return `配置异常：${egressStatus.bindingError}`
    if (egressStatus.mode === 'direct') return '直连（未启用出口）'
    if (egressStatus.state === 'degraded') {
      const until = egressStatus.coolingUntil ? new Date(egressStatus.coolingUntil).toLocaleTimeString() : '—'
      return `出口降级中（冷却至 ${until}）：当前直连`
    }
    return `已启用：${egressStatus.bindingName ?? '未解析到绑定'}`
  }, [egressStatus])

  const register = React.useCallback((id: SectionId, el: HTMLElement | null): void => {
    sectionRefs.current[id] = el
  }, [])

  const jumpTo = (id: SectionId): void => {
    setActiveSection(id)
    const el = sectionRefs.current[id]
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }

  /** 滚动联动高亮：取「已越过容器顶部的最后一个分组」 */
  const onScroll = (): void => {
    const container = scrollRef.current
    if (!container) return
    const top = container.getBoundingClientRect().top
    let current: SectionId = SECTIONS[0].id
    for (const { id } of SECTIONS) {
      const el = sectionRefs.current[id]
      if (el && el.getBoundingClientRect().top - top <= 32) current = id
    }
    setActiveSection((prev) => (prev === current ? prev : current))
  }

  // M56：消费「设置聚焦」请求（画布生成面板 →「去设置 · 媒体生成」；表单就绪后滚动定位并高亮）
  const settingsFocus = useUiStore((s) => s.settingsFocus)
  React.useEffect(() => {
    if (!settingsFocus || !form) return
    const target = SECTIONS.find((s) => s.id === settingsFocus.section)
    if (target) {
      setActiveSection(target.id)
      const el = sectionRefs.current[target.id]
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
    useUiStore.getState().consumeSettingsFocus()
  }, [settingsFocus, form])

  const kindSummary = React.useMemo(() => {
    const counts = new Map<ConnectionKind, number>()
    for (const c of connections) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1)
    if (counts.size === 0) return '尚未接入任何连接'
    return [...counts.entries()].map(([kind, n]) => `${KIND_LABEL[kind]} ${n}`).join(' · ')
  }, [connections])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 页头：标题 + 保存语义说明 + 全局动作 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <Settings2 className="size-4 text-muted-foreground" />
        <span className="text-[13px] font-semibold">设置</span>
        <div className="ml-auto flex items-center gap-2">
          {dirty && (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-700">
              未保存改动
            </span>
          )}
          <Button variant="ghost" size="sm" disabled={loading || saving || !form} onClick={() => { if (confirmDiscard()) void load() }}>
            <RotateCcw className="size-3.5" />
            恢复已保存值
          </Button>
          <Button size="sm" disabled={!form || saving} onClick={() => void save()}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
            保存并生效
          </Button>
        </div>
      </div>

      {loading && !form && (
        <div className="flex flex-1 items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载设置…
        </div>
      )}

      {!loading && !form && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <span>设置加载失败（服务不可达或返回异常）</span>
          <Button variant="outline" size="xs" onClick={() => void load()}>
            重试
          </Button>
        </div>
      )}

      {form && (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          {/* 左侧分类导航（滚动定位 + 高亮联动） */}
          <nav aria-label="设置分类" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5 sm:w-40 sm:flex-col sm:items-stretch sm:overflow-y-auto sm:border-b-0 sm:border-r sm:py-2.5">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-current={activeSection === id ? 'true' : undefined}
                onClick={() => jumpTo(id)}
                className={cn(
                  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-2 py-1.5 text-left text-[12px] transition-colors sm:w-full',
                  activeSection === id
                    ? 'bg-primary/10 font-medium text-primary'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                <Icon className="size-3.5 shrink-0" />
                {label}
              </button>
            ))}
          </nav>

          {/* 右侧表单：全量分组滚动区 */}
          <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
            <div className="mx-auto max-w-2xl space-y-6">
              <Section id="model" title="模型与生成" register={register}>
                <Field label="主模型" hint="LLM_MODEL；编排与角色默认模型">
                  <Input
                    value={form.llmModel}
                    className="h-7 max-w-md flex-1 text-[12px]"
                    onChange={(e) => set('llmModel', e.target.value)}
                  />
                </Field>
                <Field label="摘要模型" hint="SUMMARY_MODEL；留空 = 同主模型">
                  <Input
                    value={form.summaryModel}
                    placeholder="（空 = 同主模型）"
                    className="h-7 max-w-md flex-1 text-[12px]"
                    onChange={(e) => set('summaryModel', e.target.value)}
                  />
                </Field>
                <Field label="评测模型" hint="JUDGE_MODEL；留空 = 同主模型">
                  <Input
                    value={form.judgeModel}
                    placeholder="（空 = 同主模型）"
                    className="h-7 max-w-md flex-1 text-[12px]"
                    onChange={(e) => set('judgeModel', e.target.value)}
                  />
                </Field>
                <Field label="温度" hint="0–2，越高越发散；默认仅对未单独配置的角色生效">
                  <NumberInput
                    value={form.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    width="w-24"
                    onChange={(v) => set('temperature', v)}
                  />
                </Field>
                <CheckField
                  label="统一温度"
                  hint={tempOverrideHint}
                  checked={form.temperatureOverride}
                  onChange={(v) => set('temperatureOverride', v)}
                />
                {/* 多 Provider：模型服务（全局连接；Agent 控制台「高级」页绑定引用） */}
                <div className="border-t pt-2.5">
                  <ModelProvidersSection />
                </div>
              </Section>

              {/* M56：媒体生成（媒体连接全局配置，自「连接管理」迁入；启用即全场景可用） */}
              <Section id="media" title="媒体生成" register={register}>
                <MediaConnectionsSection />
              </Section>

              <Section id="context" title="上下文" register={register}>
                <Field label="上下文预算（tokens）">
                  <NumberInput
                    value={form.contextBudgetTokens}
                    min={1000}
                    step={1000}
                    onChange={(v) => set('contextBudgetTokens', v)}
                  />
                </Field>
                <Field label="保留最近回合数" hint="KEEP_RECENT_TURNS；更早历史折叠为摘要">
                  <NumberInput value={form.keepRecentTurns} min={1} max={50} onChange={(v) => set('keepRecentTurns', v)} />
                </Field>
                <Field label="单条工具结果上限（tokens）" hint="超限截断并标注省略">
                  <NumberInput
                    value={form.toolResultMaxTokens}
                    min={100}
                    step={100}
                    onChange={(v) => set('toolResultMaxTokens', v)}
                  />
                </Field>
                <Field label="工具明细保留条数" hint="TOOL_DETAIL_KEEP；更早折叠为一行摘要">
                  <NumberInput value={form.toolDetailKeep} min={0} max={50} onChange={(v) => set('toolDetailKeep', v)} />
                </Field>
              </Section>

              <Section id="memory" title="向量记忆" register={register}>
                <CheckField
                  label="语义召回"
                  hint="每回合按相关性注入 L1.5 记忆块；未配置时自动休眠（零网络、零影响）"
                  checked={form.memoryRecallEnabled}
                  onChange={(v) => set('memoryRecallEnabled', v)}
                />
                <Field label="嵌入连接" hint="在「连接管理」新建（嵌入模型类型）；留空 = 未启用（休眠）">
                  <select
                    value={form.embeddingConnectionId}
                    className={cn(selectCls, 'w-72')}
                    onChange={(e) => set('embeddingConnectionId', e.target.value)}
                  >
                    <option value="">未启用（休眠）</option>
                    {embeddingConns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.enabled ? '' : '（已禁用）'}
                        {c.status === 'error' ? '（连接异常）' : ''}
                      </option>
                    ))}
                  </select>
                </Field>
                {form.embeddingConnectionId !== '' && !embeddingConns.some((c) => c.id === form.embeddingConnectionId) && (
                  <p className="pl-[11.75rem] text-[10.5px] text-amber-600">所选嵌入连接不存在（可能已删除），当前处于休眠</p>
                )}
                <Field label="召回条数 TopK" hint="默认 8；按混合评分取前 K 条">
                  <NumberInput value={form.memoryRecallTopK} min={1} max={50} onChange={(v) => set('memoryRecallTopK', v)} />
                </Field>
                <Field label="最低分门槛" hint="0–1；低于门槛不注入（默认 0.25）">
                  <NumberInput
                    value={form.memoryRecallMinScore}
                    min={0}
                    max={1}
                    step={0.05}
                    width="w-24"
                    onChange={(v) => set('memoryRecallMinScore', v)}
                  />
                </Field>
                <Field label="召回预算（tokens）" hint="注入 L1.5 的 token 上限（默认 600）">
                  <NumberInput
                    value={form.memoryRecallBudgetTokens}
                    min={100}
                    max={4000}
                    step={100}
                    onChange={(v) => set('memoryRecallBudgetTokens', v)}
                  />
                </Field>
                <Field label="自动沉淀" hint="Run 结束后把关键结论沉淀为记忆；候选默认待审">
                  <select
                    value={form.memoryDigestMode}
                    className={selectCls}
                    onChange={(e) => set('memoryDigestMode', e.target.value as SettingsForm['memoryDigestMode'])}
                  >
                    <option value="off">off（关闭）</option>
                    <option value="session">session（仅主 Run）</option>
                    <option value="all">all（含子代理 Run）</option>
                  </select>
                </Field>
              </Section>

              <Section id="runtime" title="运行控制" register={register}>
                <Field label="单 Run 回合上限">
                  <NumberInput value={form.maxTurnsPerRun} min={1} max={100} onChange={(v) => set('maxTurnsPerRun', v)} />
                </Field>
                <Field label="交接模式" hint="auto：优先 handoff 工具，回退文本 @">
                  <select
                    value={form.handoffMode}
                    className={selectCls}
                    onChange={(e) => set('handoffMode', e.target.value as SettingsForm['handoffMode'])}
                  >
                    <option value="auto">auto（工具优先 + 文本回退）</option>
                    <option value="tool">tool（仅 handoff 工具）</option>
                    <option value="text">text（仅文本 @）</option>
                  </select>
                </Field>
                <Field
                  label="自动编排"
                  hint="开启：按需求判定是否先出计划（多环节 / 高风险 → 规划；验收类 → 评审）；关闭：仅显式选择 / 规划先行生效"
                >
                  <select
                    value={String(form.autonomyEnabled)}
                    className={selectCls}
                    onChange={(e) => set('autonomyEnabled', e.target.value === 'true')}
                  >
                    <option value="true">开启（推荐）</option>
                    <option value="false">关闭（仅显式）</option>
                  </select>
                </Field>
                <Field label="降级轮询间隔（ms）" hint="WS 断线时的通知轮询间隔，由 /api/health 下发">
                  <NumberInput
                    value={form.notifyPollMs}
                    min={500}
                    max={60000}
                    step={500}
                    onChange={(v) => set('notifyPollMs', v)}
                  />
                </Field>
              </Section>

              <Section id="safety" title="工具与安全" register={register}>
                <Field label="工具超时（ms）">
                  <NumberInput
                    value={form.toolTimeoutMs}
                    min={1000}
                    step={1000}
                    onChange={(v) => set('toolTimeoutMs', v)}
                  />
                </Field>
                <Field label="审批模式" hint="risky：高风险工具（git_commit / run_command / 覆盖写 / 敏感文件）强制审批">
                  <select
                    value={form.approvalMode}
                    className={selectCls}
                    onChange={(e) => set('approvalMode', e.target.value as SettingsForm['approvalMode'])}
                  >
                    <option value="off">off（不审批）</option>
                    <option value="risky">risky（高风险才审批）</option>
                    <option value="all">all（全部工具审批）</option>
                  </select>
                </Field>
                <Field label="审批超时（ms）" hint="超时视为拒绝并回灌模型">
                  <NumberInput
                    value={form.approvalTimeoutMs}
                    min={5000}
                    step={10000}
                    onChange={(v) => set('approvalTimeoutMs', v)}
                  />
                </Field>
                <CheckField
                  label="允许 run_command"
                  hint="关闭后 shell 类工具一律拒绝（含审批通过）"
                  checked={form.allowRunCommand}
                  onChange={(v) => set('allowRunCommand', v)}
                />
                <CheckField
                  label="允许敏感文件读写"
                  hint=".env / .ssh / 私钥等；开启后仍走审批"
                  checked={form.allowSensitive}
                  onChange={(v) => set('allowSensitive', v)}
                />
              </Section>

              <Section
                id="network"
                title="联网与出网"
                hint="IP 代理 / 隧道出口：联网抓取通道可统一经出口发出（目标与凭据在「连接管理 → 出口代理」维护，加密存储）"
                register={register}
              >
                <Field label="出口模式" hint="direct = 直连（默认，零影响）；proxy = 按下方通道经出口代理">
                  <select
                    value={form.egressMode}
                    className={selectCls}
                    onChange={(e) => set('egressMode', e.target.value as SettingsForm['egressMode'])}
                  >
                    <option value="direct">direct（直连）</option>
                    <option value="proxy">proxy（经出口代理）</option>
                  </select>
                </Field>
                <Field label="出口连接" hint="在「连接管理」新建（出口代理类型）；留空 = 尝试 EGRESS_PROXY_URL 环境变量后备">
                  <select
                    value={form.egressConnectionId}
                    className={cn(selectCls, 'w-64')}
                    onChange={(e) => set('egressConnectionId', e.target.value)}
                  >
                    <option value="">未选择</option>
                    {proxyConns.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {c.enabled ? '' : '（已禁用）'}
                        {c.status === 'error' ? '（连接异常）' : ''}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={probing || !form.egressConnectionId}
                    onClick={() => void testEgress()}
                  >
                    {probing ? <Loader2 className="size-3.5 animate-spin" /> : <Network className="size-3.5" />}
                    测试出口
                  </Button>
                </Field>
                {form.egressMode === 'proxy' && form.egressConnectionId === '' && (
                  <p className="pl-[11.75rem] text-[10.5px] text-amber-600">
                    未选择出口连接：仅当已配置 EGRESS_PROXY_URL 时生效，否则出口保持直连
                  </p>
                )}
                <Field label="跟随通道" hint="仅勾选通道经出口；未勾选恒直连（模型与嵌入建议保持不勾选）">
                  <span className="flex flex-wrap gap-x-3 gap-y-1.5">
                    {EGRESS_CHANNELS.map((c) => (
                      <label key={c.id} className="inline-flex items-center gap-1.5 text-[11.5px]" title={c.hint}>
                        <input
                          type="checkbox"
                          className="size-3.5 accent-[hsl(var(--primary))]"
                          checked={form.egressChannels.includes(c.id)}
                          onChange={() => toggleEgressChannel(c.id)}
                        />
                        {c.label}
                      </label>
                    ))}
                  </span>
                </Field>
                <Field label="直连旁路" hint="域后缀 / IP / IPv4 CIDR，逗号分隔；回环与内网建议保留（本地服务不经代理）">
                  <Input
                    value={noProxyText}
                    className="h-7 w-full max-w-xl text-[12px]"
                    onChange={(e) => {
                      setNoProxyText(e.target.value)
                      set(
                        'egressNoProxy',
                        e.target.value
                          .split(/[,\n]/)
                          .map((s) => s.trim())
                          .filter(Boolean),
                      )
                    }}
                  />
                </Field>
                <Field
                  label="失败回退"
                  hint="direct = 出口不可用时回退直连并标注（可用性优先）；fail = 严格失败（合规优先，不泄漏真实 IP）"
                >
                  <select
                    value={form.egressFallback}
                    className={selectCls}
                    onChange={(e) => set('egressFallback', e.target.value as SettingsForm['egressFallback'])}
                  >
                    <option value="direct">direct（回退直连）</option>
                    <option value="fail">fail（严格失败）</option>
                  </select>
                </Field>
                <Field label="探测地址" hint="测试出口时请求该地址并回显出口 IP（可换任意回显服务；留空 = 不可探测）">
                  <Input
                    value={form.egressProbeUrl}
                    className="h-7 w-72 text-[12px]"
                    onChange={(e) => set('egressProbeUrl', e.target.value)}
                  />
                </Field>
                <InfoRow label="出口状态">
                  <span className="flex flex-col gap-0.5">
                    <span>{egressStatusText}</span>
                    {egressStatus?.lastProbe && (
                      <span className="text-[11px] text-muted-foreground">
                        最近探测：{new Date(egressStatus.lastProbe.at).toLocaleString()}
                        {egressStatus.lastProbe.ok
                          ? ` · 出口 IP ${egressStatus.lastProbe.exitIp ?? '—'} · ${egressStatus.lastProbe.latencyMs ?? '—'}ms`
                          : ` · 失败：${egressStatus.lastProbe.error ?? '未知错误'}`}
                      </span>
                    )}
                    {egressStatus?.lastError && (
                      <span className="text-[11px] text-amber-600">最近错误：{egressStatus.lastError}</span>
                    )}
                  </span>
                </InfoRow>
              </Section>

              <Section id="finance" title="金融投研" register={register}>
                <CheckField
                  label="启用金融工具"
                  hint="启用开关与工具注册在服务启动时判定，切换后需重启；行情三参数保存即生效"
                  checked={form.financeEnabled}
                  onChange={(v) => set('financeEnabled', v)}
                />
                <Field label="行情刷新间隔（ms）" hint="FINANCE_QUOTE_REFRESH_MS；报价缓存有效期（2000–600000）">
                  <NumberInput
                    value={form.financeQuoteRefreshMs}
                    min={2000}
                    max={600000}
                    step={1000}
                    onChange={(v) => set('financeQuoteRefreshMs', v)}
                  />
                </Field>
                <Field label="最小请求间隔（ms）" hint="FINANCE_MIN_INTERVAL_MS；金融源同域节流（0 = 复用默认 1200ms）">
                  <NumberInput
                    value={form.financeMinIntervalMs}
                    min={0}
                    max={60000}
                    step={100}
                    onChange={(v) => set('financeMinIntervalMs', v)}
                  />
                </Field>
                <Field label="Python 桥超时（ms）" hint="FINANCE_PY_TIMEOUT_MS；行情 / 指标计算桥接进程超时">
                  <NumberInput
                    value={form.financePyTimeoutMs}
                    min={1000}
                    max={600000}
                    step={1000}
                    onChange={(v) => set('financePyTimeoutMs', v)}
                  />
                </Field>
              </Section>

              <Section id="resources" title="资源与集成" register={register}>
                <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
                  <ResourceCard
                    icon={<Cable className="size-4" />}
                    title="连接管理"
                    summary={`${connections.length} 个连接`}
                    detail={kindSummary}
                    goLabel="前往连接管理"
                    onGo={() => setAppView('connections')}
                  />
                  <ResourceCard
                    icon={<Plug className="size-4" />}
                    title="MCP 管理"
                    summary={`${mcpServers.length} 台服务器 · ${mcpTools.length} 个工具`}
                    detail="MCP 服务器 CRUD / 生命周期 / 会话绑定"
                    goLabel="前往 MCP 管理"
                    onGo={() => setAppView('mcp')}
                  />
                  <ResourceCard
                    icon={<Bot className="size-4" />}
                    title="Agent 管理"
                    summary={`${agents.length} 个角色`}
                    detail="人设 / 能力 / 转交 / 灵魂与场景分组"
                    goLabel="前往 Agent 管理"
                    onGo={() => setAppView('agents')}
                  />
                  <ResourceCard
                    icon={<Sparkles className="size-4" />}
                    title="Skill 管理"
                    summary={`${skills.length} 项技能`}
                    detail="技能索引（正文按需加载）"
                    goLabel="前往 Skill 管理"
                    onGo={() => setAppView('skills')}
                  />
                </div>
              </Section>

              <Section id="system" title="系统信息" register={register}>
                <InfoRow label="服务健康">
                  <span className={cn('inline-flex items-center gap-1.5', health?.ok ? 'text-emerald-700' : 'text-muted-foreground')}>
                    <span className={cn('size-1.5 rounded-full', health?.ok ? 'bg-emerald-500' : 'bg-slate-300')} />
                    {health?.ok ? '运行正常' : '未知（服务不可达）'}
                  </span>
                </InfoRow>
                <InfoRow label="运行模型">
                  <span className="font-medium">{health?.model ?? '—'}</span>
                  {health?.thinking && <span className="ml-2 text-[11px] text-muted-foreground">思考模式已开启</span>}
                </InfoRow>
                <InfoRow label="服务地址">
                  <span className="break-all font-mono text-[11.5px] text-muted-foreground">{health?.baseUrl ?? '—'}</span>
                </InfoRow>
                <InfoRow label="降级轮询间隔">
                  {health?.notifyPollMs ?? form.notifyPollMs} ms（WS 断线时生效）
                </InfoRow>
                <InfoRow label="通知通道">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className={cn(
                        'size-1.5 rounded-full',
                        wsStatus === 'open' ? 'bg-emerald-500' : wsStatus === 'connecting' ? 'bg-amber-400' : 'bg-slate-300',
                      )}
                    />
                    {WS_LABEL[wsStatus] ?? wsStatus}
                  </span>
                </InfoRow>
                <InfoRow label="设置文件">
                  <span className="text-muted-foreground">data/settings.json（非法字段启动时丢弃并告警）</span>
                </InfoRow>
              </Section>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
