/**
 * M16：并行协作组容器——同 runId + 同 turnIndex 连续 ≥2 条成员消息成组展示（turnIndex = 波次号）。
 * 组头：∥ 并行标记 + 成员头像 chips + 完成进度（流式期间实时更新）+ 折叠开关；
 * 组内消息独立流式（复用 MessageItem 项级订阅，单条波次渲染路径完全不变）。
 * 成员画像 / 完成进度均为 primitive 订阅，本组件不随流式增量重渲染。
 * 入场动效 quiet 模式关闭；折叠为本地 UI 状态（行高变化由虚拟列表 measureElement 自动修正）。
 *
 * M43（§72）：对决组（PK-1）——场景内波内成员经 duelSides 分侧（arena 席位优先，其次对抗
 * 姿态注册表）且两侧均非空时，本组升级为对决布局：组头「对决 + 阶段徽章 + 计分板（PK-5）」、
 * 内容二栏（窄屏回退纵向单流）、组尾裁决卡（PK-4，仅最新成员波；运行中禁用；回填只写草稿）。
 * 计分 / 裁决卡在子组件内隔离订阅（useSceneMessages 节流 + useSceneBusy primitive 三路），
 * 主组件仍不随流式增量重渲染。
 */
import * as React from 'react'
import { ChevronDown, Columns2, Gavel, Swords } from 'lucide-react'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { cn } from '../../lib/utils'
import {
  duelPhaseOf,
  duelSides,
  duelTally,
  duelVerdictLabel,
  verdictTemplates,
  type DuelSplit,
} from '../../lib/pk'
import { useSceneCtx } from '../scene/context'
import { useSceneBusy, useSceneMessages, useSceneVerdicts } from '../scene/use-scene-data'
import { AgentAvatar } from '../agents/AgentAvatar'
import { MessageItem } from './MessageItem'

/** 入场动效窗口：仅新近波次播放，虚拟列表重挂载不重放 */
const WAVE_ANIMATE_WINDOW_MS = 60_000

export function WaveGroup({ ids }: { ids: string[] }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const quiet = useUiStore((s) => s.quietMode)
  const ctx = useSceneCtx()
  const [open, setOpen] = React.useState(true)

  // 组头数据都是 primitive：任意流式增量只改 byId 内容，不改变本组件订阅结果
  const memberKey = useSessionStore((s) => ids.map((id) => s.byId.get(id)?.agentId ?? '').join(','))
  const doneCount = useSessionStore((s) => {
    let n = 0
    for (const id of ids) {
      if (s.byId.get(id)?.status === 'complete') n++
    }
    return n
  })
  const createdAt = useSessionStore((s) => s.byId.get(ids[0])?.createdAt ?? '')
  const turnIndex = useSessionStore((s) => s.byId.get(ids[0])?.turnIndex)

  const agentIds = React.useMemo(() => memberKey.split(','), [memberKey])
  const seats = ctx?.stage.seats
  // 对决分侧（PK-1）：仅场景内、显式结构化口径（席位优先 → 姿态注册表）；两侧均非空才成对决
  const split = React.useMemo(
    () => (ctx ? duelSides(agentIds.filter(Boolean), seats) : undefined),
    [ctx, agentIds, seats],
  )
  const duel = split !== undefined && ids.length >= 2

  const nameOf = React.useCallback(
    (id: string | undefined): string => (id ? (agents.find((a) => a.id === id)?.name ?? '') : ''),
    [agents],
  )

  const members = memberKey
    .split(',')
    .map((id) => agents.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
  const animate =
    !quiet && createdAt !== '' && Date.now() - Date.parse(createdAt) < WAVE_ANIMATE_WINDOW_MS
  const allDone = doneCount >= ids.length

  // 对决分侧后的消息 id 分栏（保序）
  const columns = React.useMemo(() => {
    if (!split) return undefined
    const leftSet = new Set(split.left)
    const rightSet = new Set(split.right)
    const out = { left: [] as string[], right: [] as string[], center: [] as string[] }
    ids.forEach((id, i) => {
      const agent = agentIds[i] ?? ''
      if (leftSet.has(agent)) out.left.push(id)
      else if (rightSet.has(agent)) out.right.push(id)
      else out.center.push(id)
    })
    return out
  }, [ids, agentIds, split])

  // 裁决卡仅在「本组为最新成员波」时出现（历史对决波不重复挂按钮）
  const isLatestWave = useSessionStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const m = s.byId.get(s.order[i]!)
      if (m?.role === 'agent') return m.id === ids[ids.length - 1]
    }
    return false
  })

  const duelColumn = (
    side: 'left' | 'right',
    sideIds: string[],
    s: DuelSplit,
  ): React.JSX.Element => {
    const label = nameOf(side === 'left' ? s.left[0] : s.right[0]) || (side === 'left' ? '左席' : '右席')
    return (
      <div className="wave-duel-side flex min-w-0 flex-col gap-0.5" data-side={side}>
        <div className="flex items-center gap-1.5 px-2 pt-1.5 text-[10.5px] font-medium text-muted-foreground">
          <span
            className={cn(
              'inline-block size-1.5 shrink-0 rounded-full',
              side === 'left' ? 'bg-sky-500' : 'bg-orange-500',
            )}
          />
          <span className="truncate">{label}</span>
          <span className="shrink-0 text-muted-foreground/50">{sideIds.length} 条</span>
        </div>
        {sideIds.length > 0 ? (
          sideIds.map((id) => <MessageItem key={id} messageId={id} />)
        ) : (
          <div className="px-2 pb-1 text-[10.5px] text-muted-foreground/60">待发言…</div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('py-0.5', animate && 'handoff-in')} data-wave-group={duel ? 'duel' : 'parallel'}>
      <div className="mx-4 rounded-xl border border-dashed border-primary/25 bg-primary/[0.025]">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={open ? '折叠本波并行协作' : '展开本波并行协作'}
          className="flex w-full items-center gap-2 rounded-t-xl px-2.5 py-1.5 text-left text-[11.5px] transition-colors hover:bg-primary/[0.04]"
        >
          {duel ? (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">
                <Swords className="size-3.5" />
                对决
              </span>
              {turnIndex != null ? (
                <span
                  className="shrink-0 rounded bg-primary/10 px-1.5 text-[10px] font-medium text-primary"
                  data-duel-phase={duelPhaseOf(turnIndex)}
                >
                  {duelPhaseOf(turnIndex)}
                </span>
              ) : null}
              {split ? <DuelMeter split={split} nameOf={nameOf} /> : null}
            </>
          ) : (
            <>
              <span className="inline-flex shrink-0 items-center gap-1 font-medium text-primary">
                <Columns2 className="size-3.5" />
                并行协作
              </span>
              <span className="flex shrink-0 -space-x-1.5">
                {members.map((a) => (
                  <AgentAvatar key={a.id} agent={a} size={18} animated={false} className="rounded-full ring-1 ring-card" />
                ))}
              </span>
              <span className="min-w-0 truncate text-muted-foreground">{members.map((a) => a.name).join('、')}</span>
            </>
          )}
          <span
            className={cn(
              'ml-auto shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px]',
              allDone ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {doneCount}/{ids.length} 完成
          </span>
          <ChevronDown
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform duration-200', !open && '-rotate-90')}
          />
        </button>
        {open && (
          <>
            {duel && columns && !ctx?.narrow ? (
              <div className="border-t border-primary/10 py-0.5" data-duel-columns="">
                <div className="grid grid-cols-2 gap-x-2">
                  {split ? duelColumn('left', columns.left, split) : null}
                  {split ? duelColumn('right', columns.right, split) : null}
                </div>
                {columns.center.length > 0 ? (
                  <div className="border-t border-dashed border-primary/10">
                    {columns.center.map((id) => (
                      <MessageItem key={id} messageId={id} />
                    ))}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="border-t border-primary/10 py-0.5">
                {ids.map((id) => (
                  <MessageItem key={id} messageId={id} />
                ))}
              </div>
            )}
            {duel && split && isLatestWave && ctx ? (
              <DuelVerdictActions
                left={nameOf(split.left[0]) || '左席'}
                right={nameOf(split.right[0]) || '右席'}
                onInsert={ctx.insert}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * PK-5 计分板：各侧发言数 / 被响应缺陷数 + 终局徽章（verdict 尾条）。
 * 订阅经 useSceneMessages（500ms 节流 + 流式冻结）——流式期间计分不跳动。
 */
function DuelMeter({ split, nameOf }: { split: DuelSplit; nameOf: (id?: string) => string }): React.JSX.Element {
  const messages = useSceneMessages()
  const verdicts = useSceneVerdicts()
  const tally = React.useMemo(() => duelTally(messages, split), [messages, split])
  const leftLabel = nameOf(split.left[0]) || '左席'
  const rightLabel = nameOf(split.right[0]) || '右席'
  const last = verdicts.length > 0 ? verdicts[verdicts.length - 1] : undefined
  const outcome =
    last && last.status !== 'none' ? duelVerdictLabel(last.status, leftLabel, rightLabel) : undefined
  return (
    <span
      className="inline-flex min-w-0 shrink-0 items-center gap-1.5 text-[10.5px]"
      title="计分：发言数 / 被响应缺陷数（后续消息引用本侧缺陷编号即视为被响应）"
      data-duel-meter=""
    >
      <span className="truncate text-muted-foreground">
        {leftLabel}
        <b className="ml-0.5 font-semibold text-foreground">{tally.left.speaks}</b>
        <span className="text-muted-foreground/60">/</span>
        <b className="font-semibold text-foreground">{tally.left.responded}</b>
      </span>
      <span className="text-muted-foreground/50">vs</span>
      <span className="truncate text-muted-foreground">
        {rightLabel}
        <b className="ml-0.5 font-semibold text-foreground">{tally.right.speaks}</b>
        <span className="text-muted-foreground/60">/</span>
        <b className="font-semibold text-foreground">{tally.right.responded}</b>
      </span>
      {outcome ? (
        <span className="shrink-0 rounded-full bg-primary/10 px-1.5 font-medium text-primary" data-duel-outcome="">
          {outcome}
        </span>
      ) : null}
    </span>
  )
}

/** PK-4 裁决卡：四模板按钮 → 统一回填（只写草稿不直发，ADR 0118）；运行中禁用 */
function DuelVerdictActions({
  left,
  right,
  onInsert,
}: {
  left: string
  right: string
  onInsert: (text: string) => void
}): React.JSX.Element {
  const busy = useSceneBusy()
  const outs = React.useMemo(() => verdictTemplates(left, right), [left, right])
  return (
    <div
      className="flex flex-wrap items-center gap-1.5 border-t border-dashed border-primary/15 bg-primary/[0.015] px-2.5 py-1.5"
      data-duel-actions=""
    >
      <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-muted-foreground">
        <Gavel className="size-3" />
        裁决回填
      </span>
      {outs.map((t) => (
        <button
          key={t.key}
          type="button"
          disabled={busy.streaming}
          data-verdict-key={t.key}
          title={busy.streaming ? '运行中不可裁决：等待本波完成' : '写入草稿（可编辑后发送）'}
          onClick={() => onInsert(t.text)}
          className="rounded-md border border-primary/25 bg-card px-2 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}
