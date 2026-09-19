/**
 * 图谱档案工作面板（§28.4，M21）：点击节点滑出，回答「这位成员此刻在做什么」。
 * - 状态徽章（发言中 / 排队 / 待你指示 / 待命）→ 与画布节点同口径
 * - 接力战绩三格：接手 / 交出 / 发言（会话统计）
 * - 工作产出：该成员交付件列表（按 authorAgentId 归集，点击打开交付件浏览器）
 * - 上下游关系 chips（谁交给 TA、TA 交给谁）→ 点击可切换聚焦成员
 * - 最近一次发言（点击定位到对话区）与操作行：聚焦 / 拍一拍 / @ 召唤
 * - M22 深化：灵魂徽标 / 专长 chips / 接力链追踪（3 跳） / 游离成员提示
 */
import * as React from 'react'
import { AtSign, BarChart3, Crosshair, File as FileIcon, FileCode2, FileSpreadsheet, FileText, FileType2, GitBranch, Globe, Hand, Image as ImageIcon, Table2, Unplug, Video, X } from 'lucide-react'
import type { AgentDefinition, AgentGroup, Artifact, ChatMessage, SoulMeta } from '@multi-agent/shared'
import type { GraphLink } from '../../../lib/graph'
import { patAgent } from '../../../lib/agent-actions'
import { humanSize, timeAgo } from '../../../lib/time'
import { cn } from '../../../lib/utils'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { SoulBadge } from '../../agents/SoulPicker'
import { Button } from '../../ui/button'
import { useAgentStore } from '../../../stores/agent-store'
import { useUiStore } from '../../../stores/ui-store'

/** 运行状态文案（节点卡 / 档案面板 / 悬停预览同口径） */
export const STATUS_LABEL: Record<string, string> = {
  idle: '待命',
  speaking: '发言中',
  thinking: '思考中',
  done: '产出完毕',
  error: '出错了',
}

const KIND_ICON: Record<Artifact['kind'], React.JSX.Element> = {
  markdown: <FileText className="size-3 shrink-0 text-blue-600" />,
  code: <FileCode2 className="size-3 shrink-0 text-emerald-600" />,
  html: <Globe className="size-3 shrink-0 text-cyan-600" />,
  chart: <BarChart3 className="size-3 shrink-0 text-violet-600" />,
  data: <Table2 className="size-3 shrink-0 text-amber-600" />,
  image: <ImageIcon className="size-3 shrink-0 text-pink-600" />,
  video: <Video className="size-3 shrink-0 text-rose-600" />,
  office: <FileSpreadsheet className="size-3 shrink-0 text-orange-600" />,
  pdf: <FileType2 className="size-3 shrink-0 text-red-600" />,
  other: <FileIcon className="size-3 shrink-0 text-muted-foreground" />,
}

function baseName(path: string): string {
  return path.split('/').pop() ?? path
}

export interface GraphInspectorProps {
  agent: AgentDefinition
  group?: AgentGroup
  /** 上游（谁交给 TA；按接手次数降序） */
  upstream: GraphLink[]
  /** 下游（TA 交给谁） */
  downstream: GraphLink[]
  /** 该成员完成发言条数 */
  talks: number
  speaking: boolean
  queueIndex: number
  awaitingUser: boolean
  /** 最近一条完成发言（点击定位） */
  lastMessage?: ChatMessage
  /** 该成员的工作产出（会话交付件按 authorAgentId 归集；缺省 = 暂无产出） */
  artifacts?: Artifact[]
  /** 生效灵魂（会话覆盖 > 角色默认；缺省 = 无灵魂，不占位） */
  soul?: SoulMeta
  /** 接力链追踪已激活（以该成员为起点，最多 3 跳） */
  traceActive?: boolean
  /** 切换接力链追踪（未接入时按钮不渲染——追踪链路实现见 GraphView 后续接线） */
  onTrace?: () => void
  /** 游离成员：尚未接入接力链（in/out 均为 0 且已有接力流量） */
  isolated?: boolean
  /** 聚焦：相机居中该成员 */
  onFocus: () => void
  /** 点击关系 chip 切换聚焦成员（同面板换人） */
  onSelect: (id: string) => void
  onClose: () => void
}

function LinkChips({
  links,
  label,
  onSelect,
}: {
  links: GraphLink[]
  label: string
  onSelect: (id: string) => void
}): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const nameOf = (id: string): string => agents.find((a) => a.id === id)?.name ?? id
  const shown = links.slice(0, 3)
  const rest = links.length - shown.length
  return (
    <div className="flex items-start gap-1.5">
      <span className="w-8 shrink-0 pt-0.5 text-[10px] text-muted-foreground">{label}</span>
      <span className="flex min-w-0 flex-wrap gap-1">
        {shown.length === 0 && <span className="text-[10.5px] text-muted-foreground/70">暂无</span>}
        {shown.map((l) => (
          <button
            key={l.id}
            type="button"
            onClick={() => onSelect(l.id)}
            className="flex items-center gap-0.5 rounded-full border bg-muted/40 px-1.5 py-px text-[10px] transition-colors hover:border-primary/40 hover:text-primary"
            title={`${nameOf(l.id)} · 接手 ${l.count} 次${l.lastAt ? ` · ${timeAgo(l.lastAt)}` : ''}`}
          >
            <span className="max-w-[72px] truncate">{nameOf(l.id)}</span>
            <span className="text-muted-foreground">×{l.count}</span>
          </button>
        ))}
        {rest > 0 && <span className="pt-0.5 text-[10px] text-muted-foreground">+{rest}</span>}
      </span>
    </div>
  )
}

export function GraphInspector({
  agent,
  group,
  upstream,
  downstream,
  talks,
  speaking,
  queueIndex,
  awaitingUser,
  lastMessage,
  artifacts = [],
  soul,
  traceActive,
  onTrace,
  isolated,
  onFocus,
  onSelect,
  onClose,
}: GraphInspectorProps): React.JSX.Element {
  const statuses = useAgentStore((s) => s.statuses)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const focusMessage = useUiStore((s) => s.focusMessage)
  const requestArtifact = useUiStore((s) => s.requestArtifact)

  const statusText = speaking
    ? '发言中'
    : queueIndex > 0
      ? `排队第 ${queueIndex} 位`
      : awaitingUser
        ? '待你指示'
        : (STATUS_LABEL[statuses[agent.id] ?? 'idle'] ?? '待命')
  const inTotal = upstream.reduce((n, l) => n + l.count, 0)
  const outTotal = downstream.reduce((n, l) => n + l.count, 0)
  /** 产出列表：最新在前，面板内最多列 4 件 */
  const outputs = React.useMemo(() => [...artifacts].sort((a, b) => b.mtime - a.mtime), [artifacts])
  const shownOutputs = outputs.slice(0, 4)

  return (
    <aside
      className="graph-inspector-in pointer-events-auto absolute right-2 top-9 z-10 flex max-h-[calc(100%-44px)] w-[248px] flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur-sm"
      aria-label={`${agent.name} 档案`}
    >
      <header className="flex items-center gap-2 border-b px-2.5 py-2">
        <AgentAvatar agent={agent} size={34} animated={false} className="shrink-0 rounded-lg ring-1 ring-primary/15" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            <span className="truncate text-[12.5px] font-semibold leading-4">{agent.name}</span>
            {soul && <SoulBadge soul={soul} className="shrink-0" />}
          </div>
          <div className="truncate text-[10px] text-muted-foreground">
            {group ? `${group.name} · ` : ''}
            {agent.role}
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-px text-[9.5px]',
            speaking
              ? 'border-primary/40 bg-primary/10 text-primary'
              : awaitingUser
                ? 'border-amber-400/50 bg-amber-50 text-amber-600'
                : 'text-muted-foreground',
          )}
        >
          {statusText}
        </span>
        <Button variant="ghost" size="icon-sm" className="-mr-1 size-5 shrink-0" title="关闭档案" onClick={onClose}>
          <X className="size-3" />
        </Button>
      </header>

      <div className="space-y-2 overflow-y-auto px-2.5 py-2">
        <div className="grid grid-cols-3 gap-1.5">
          {[
            { label: '接手', value: inTotal },
            { label: '交出', value: outTotal },
            { label: '发言', value: talks },
          ].map((x) => (
            <div
              key={x.label}
              className="rounded-lg border bg-gradient-to-b from-card to-muted/50 py-1 text-center shadow-soft"
            >
              <div className="text-[13px] font-semibold leading-4 text-primary">{x.value}</div>
              <div className="text-[9.5px] text-muted-foreground">{x.label}</div>
            </div>
          ))}
        </div>

        {isolated && (
          <div className="flex items-center gap-1.5 rounded-lg border border-dashed px-2 py-1.5 text-[10.5px] text-muted-foreground">
            <Unplug className="size-3 shrink-0" />
            <span>还没接过棒 · 召唤 TA 加入接力</span>
          </div>
        )}

        {agent.capabilities.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10px] text-muted-foreground">专长</span>
            <div className="flex flex-wrap gap-1">
              {agent.capabilities.slice(0, 4).map((c) => (
                <span key={c} className="max-w-[92px] truncate rounded border bg-muted/40 px-1.5 py-px text-[9.5px] text-foreground/75">
                  {c}
                </span>
              ))}
              {agent.capabilities.length > 4 && (
                <span className="py-px text-[9.5px] text-muted-foreground/70">+{agent.capabilities.length - 4}</span>
              )}
            </div>
          </div>
        )}

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">工作产出</span>
            <span className="text-[9.5px] text-muted-foreground/70">{outputs.length > 0 ? `${outputs.length} 件` : ''}</span>
          </div>
          {outputs.length === 0 && <div className="text-[10.5px] text-muted-foreground/70">暂无产出</div>}
          {shownOutputs.map((a) => (
            <button
              key={a.path}
              type="button"
              onClick={() => requestArtifact(a.path)}
              className="flex w-full items-center gap-1.5 rounded-lg border bg-muted/30 px-1.5 py-1 text-left transition-colors hover:border-primary/30"
              title={`打开交付件：${a.path}`}
            >
              {KIND_ICON[a.kind] ?? KIND_ICON.other}
              <span className="min-w-0 flex-1 truncate text-[10.5px]">{baseName(a.path)}</span>
              <span className="shrink-0 text-[9.5px] text-muted-foreground">{humanSize(a.size)}</span>
            </button>
          ))}
          {outputs.length > shownOutputs.length && (
            <div className="text-[9.5px] text-muted-foreground/70">+{outputs.length - shownOutputs.length} 件，去交付件浏览器查看</div>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">接力链</span>
            {onTrace && (
              <button
                type="button"
                onClick={onTrace}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] transition-colors',
                  traceActive
                    ? 'border-primary/50 bg-primary/10 text-primary'
                    : 'text-muted-foreground hover:border-primary/40 hover:text-primary',
                )}
                title={traceActive ? '停止追踪（Esc）' : `从 ${agent.name} 出发追踪接力链（最多 3 跳）`}
              >
                <GitBranch className="size-3" />
                {traceActive ? '停止追踪' : '追踪接力链'}
              </button>
            )}
          </div>
          <LinkChips links={upstream} label="上游" onSelect={onSelect} />
          <LinkChips links={downstream} label="下游" onSelect={onSelect} />
        </div>

        {lastMessage && (
          <button
            type="button"
            onClick={() => focusMessage(lastMessage.id)}
            className="block w-full rounded-lg border bg-muted/30 px-2 py-1.5 text-left transition-colors hover:border-primary/30"
            title="定位到对话区该条发言"
          >
            <div className="mb-0.5 flex items-center justify-between text-[9.5px] text-muted-foreground">
              <span>最近发言</span>
              <span>{timeAgo(lastMessage.createdAt)}</span>
            </div>
            <p className="line-clamp-2 text-[11px] leading-4 text-foreground/85">{lastMessage.content.slice(0, 160)}</p>
          </button>
        )}
      </div>

      <footer className="flex items-center gap-1 border-t px-2.5 py-2">
        <Button variant="outline" size="xs" title="聚焦该成员（相机居中）" onClick={onFocus}>
          <Crosshair className="size-3" />
          聚焦
        </Button>
        <Button variant="outline" size="xs" title="拍一拍" onClick={() => void patAgent(agent)}>
          <Hand className="size-3" />
          拍一拍
        </Button>
        <Button
          variant="outline"
          size="xs"
          title="@ 召唤"
          onClick={() => insertToComposer(`@${agent.name} `)}
        >
          <AtSign className="size-3" />
          召唤
        </Button>
      </footer>
    </aside>
  )
}
