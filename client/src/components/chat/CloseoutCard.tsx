/**
 * 收尾交付清单（M37-6 修订，ADR 0092；分层默认续修订，ADR 0123）——本轮 Run 交还用户时，
 * 若本轮有交付件，在消息流尾部给出交付清单：类型图标 / 目录 / 文件名 / 体积 / 交付者
 * （M85：底部快捷 chips（继续推进 / 总结本轮）已按用户决策移除）。
 * 紧凑口径（2026-09-25 用户决策）：**只展示核心交付件**——过程产物（charts/ 行情与博弈快照等）
 * 与溢出项不再展示（原「其他」折叠组已移除，头部计数保留总数）；「接着说」入口已移除；
 * 整清单可整体收起隐藏（头部左簇即开关，收起后仅留概要行）；面板入口由头部按钮承载。
 * 无交付件则完全不渲染（轮次结束不重复固定文案；「你的回合」交接条已承载收束语义）。
 * 触发完全从消息派生（尾条为成员「完成」消息且 mentions 仅含 user、无运行中 Run）；
 * 订阅按「尾条指纹」隔离：流式 delta 不改指纹 → 不触发本组件重渲染。
 * 指纹末位含「本轮交付件计数」：流式期消息不带 artifacts（run:end 时 refreshMessages 才回填），
 * 若不入指纹，补全后的刷新不改变指纹 → useMemo 停留在空态（清单卡不出现）。
 * 元数据 hook 下沉至 DeliveryManifest：隐藏态不发起拉取（与「无交付件不渲染」同口径）。
 * M39（§97，DEV-3）：验收单——development 场景追加验收区：qa 判定徽章（通过 / 有条件通过 /
 * 未通过，acceptanceOf 启发式派生）+ 未决项列表；无 qa 内容 → 仅列交付件（降级不变）。
 * M44（AF-5）：签收区——development 场景且锚点存在时，追加「核心交付签收」行：锚点名 + vN +
 * 闭环统计（已回应 / 未闭环）+ 「签收」（本地态 sessionStorage；签收时回填「已签收 <名> vN。」草稿）。
 */
import * as React from 'react'
import { ChevronRight, Package, PackageCheck, PackageOpen } from 'lucide-react'
import type { AgentDefinition, ChatMessage, DeliveryClass } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useArtifactMeta } from '../../stores/artifact-store'
import { useArtifactVersions } from '../../lib/artifact-versions'
import { acceptanceOf, type AcceptanceInfo } from '../../lib/acceptance'
import { baseName } from '../../lib/artifacts'
import { partitionDelivery } from '../../lib/delivery'
import {
  closureOf,
  loadPinnedPath,
  loadSignoffs,
  pickFocusPath,
  saveSignoffs,
  signoffDraft,
  signoffTag,
} from '../../lib/focus-artifact'
import { stageOf } from '../../lib/stage-map'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'
import { ConfettiBurst } from '../ui/confetti'
import { useSceneCtx } from '../scene/context'
import { ArtifactRow } from './DeliveryList'

/** 彩纸触发窗口：仅新近完成的本轮播放，重挂载 / 打开旧会话不重放 */
const CELEBRATE_WINDOW_MS = 90_000
/** 头部交付者头像流上限 */
const MAX_AUTHORS = 5

interface DeliveryEntry {
  path: string
  /** 该交付件的交付者（消息级归属，用于清单行头像） */
  agentId?: string
  /** M87：服务端索引分层（final / process / attachment / media；缺省回退路径启发式） */
  deliveryClass?: DeliveryClass
}

interface CloseoutInfo {
  tailId: string
  runId?: string
  waves: number
  entries: DeliveryEntry[]
  createdAt: string
}

/** M39：验收判定徽章色调 */
const VERDICT_TONE: Record<AcceptanceInfo['verdict'], string> = {
  通过: 'bg-emerald-500/10 text-emerald-600',
  有条件通过: 'bg-amber-500/10 text-amber-600',
  未通过: 'bg-rose-500/10 text-rose-600',
}

/** 交付清单主体：仅在可见时挂载（元数据按会话共享缓存补齐） */
function DeliveryManifest({ info }: { info: CloseoutInfo }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const meta = useArtifactMeta()
  const ctx = useSceneCtx()
  // 签收回填草稿（M44 AF-5）
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const expandWorkspace = useUiStore((s) => s.expandWorkspace)
  const [burst, setBurst] = React.useState(0)
  // 整清单折叠态：默认展开（收起后仅留概要行）
  const [listOpen, setListOpen] = React.useState(true)

  // M39（DEV-3）：development 场景验收区（qa 判定 + 未决项；无 qa 内容 → 不渲染）
  const groupId = ctx?.group?.id
  const acceptance = React.useMemo<AcceptanceInfo | undefined>(() => {
    if (groupId !== 'development') return undefined
    const s = useSessionStore.getState()
    const messages: ChatMessage[] = []
    for (const id of s.order) {
      const m = s.byId.get(id)
      if (m) messages.push(m)
    }
    return acceptanceOf(messages, info.runId)
    // tailId 变化 = 新一轮收尾（同轮内消息不变化）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId, info.runId, info.tailId])

  // M44（AF-5）：签收区（development）——锚点（钉选优先）+ vN + 闭环统计 + 本地签收态
  const sessionId = useSessionStore((s) => s.currentId ?? '')
  const paths = React.useMemo(() => info.entries.map((e) => e.path), [info.entries])
  const anchor = React.useMemo(
    () => pickFocusPath(paths, sessionId ? loadPinnedPath(sessionId) : undefined),
    [paths, sessionId],
  )
  const anchorVersions = useArtifactVersions(groupId === 'development' ? anchor : undefined)
  const latestVersion = anchorVersions && anchorVersions.length > 0 ? anchorVersions[0]!.version : undefined
  const [signoffs, setSignoffs] = React.useState<Set<string>>(() => (sessionId ? loadSignoffs(sessionId) : new Set()))
  React.useEffect(() => {
    setSignoffs(sessionId ? loadSignoffs(sessionId) : new Set())
  }, [sessionId, info.tailId])
  const closure = React.useMemo(() => {
    const s = useSessionStore.getState()
    const messages: ChatMessage[] = []
    for (const id of s.order) {
      const m = s.byId.get(id)
      if (m) messages.push(m)
    }
    return closureOf(messages, paths)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info.tailId, paths])
  const signed = anchor !== undefined && latestVersion !== undefined && signoffs.has(signoffTag(anchor, latestVersion))
  const toggleSignoff = (): void => {
    if (!anchor || latestVersion === undefined) return
    const tag = signoffTag(anchor, latestVersion)
    const next = new Set(signoffs)
    if (next.has(tag)) next.delete(tag)
    else {
      next.add(tag)
      insertToComposer(signoffDraft(anchor, latestVersion))
    }
    setSignoffs(next)
    saveSignoffs(sessionId, next)
  }

  // 彩纸：挂载一拍内仅新近完成播放（同一条尾消息的重复挂载由 celebrateId 收敛；quiet 在 ConfettiBurst 内部）
  const celebratedRef = React.useRef('')
  React.useEffect(() => {
    if (celebratedRef.current === info.tailId) return
    celebratedRef.current = info.tailId
    setListOpen(true) // 新尾条：整清单回到展开
    if (Date.now() - Date.parse(info.createdAt) < CELEBRATE_WINDOW_MS) setBurst((n) => n + 1)
  }, [info.tailId, info.createdAt])

  // M85：仅取核心交付件（过程产物不再展示——partitionDelivery 的 others 部分按用户决策移除）
  // M87：分层优先用索引 deliveryClass（服务端单点判定）；元数据未到时回退路径启发式
  const classified = React.useMemo(
    () => info.entries.map((entry) => ({ ...entry, deliveryClass: entry.deliveryClass ?? meta.get(entry.path)?.deliveryClass })),
    [info.entries, meta],
  )
  const { primary } = React.useMemo(() => partitionDelivery(classified), [classified])
  const authors: AgentDefinition[] = []
  const authorIds = new Set<string>()
  for (const e of info.entries) {
    if (!e.agentId || authorIds.has(e.agentId)) continue
    authorIds.add(e.agentId)
    const agent = agents.find((a) => a.id === e.agentId)
    if (agent) authors.push(agent)
  }

  return (
    <div
      data-delivery-manifest
      className="handoff-in relative mx-4 mb-3 mt-1 overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent px-3 py-2"
    >
      <ConfettiBurst burst={burst} />
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-delivery-collapse
          aria-expanded={listOpen}
          aria-label={listOpen ? '收起交付清单' : '展开交付清单'}
          title={listOpen ? '收起交付清单' : '展开交付清单'}
          onClick={() => setListOpen((v) => !v)}
          className="group flex min-w-0 items-center gap-2 text-left"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/20">
            <Package className="size-3.5" />
          </span>
          <span className="shrink-0 text-[12.5px] font-semibold">本轮交付</span>
          <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[10.5px] font-medium tabular-nums text-primary">
            {info.entries.length} 件
          </span>
          {acceptance ? (
            <span
              data-qa-verdict={acceptance.verdict}
              title="验收判定（来自 qa 本轮发言）"
              className={cn('shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-medium', VERDICT_TONE[acceptance.verdict])}
            >
              验收 · {acceptance.verdict}
            </span>
          ) : null}
          {info.waves > 0 && <span className="truncate text-[11px] text-muted-foreground">收束于第 {info.waves} 波</span>}
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-primary', listOpen && 'rotate-90')}
          />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="flex -space-x-1.5">
            {authors.slice(0, MAX_AUTHORS).map((a) => (
              <AgentAvatar key={a.id} agent={a} size={18} animated={false} className="ring-1 ring-card" />
            ))}
          </span>
          {authors.length > MAX_AUTHORS && (
            <span className="text-[10px] text-muted-foreground/80">+{authors.length - MAX_AUTHORS}</span>
          )}
          <button
            type="button"
            onClick={() => expandWorkspace('artifacts')}
            aria-label="打开交付件面板"
            title="打开交付件面板（全部文件与历史版本）"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <PackageOpen className="size-3.5" />
          </button>
        </span>
      </div>

      {listOpen && (
        <>
          {primary.length > 0 && (
            <div data-delivery-group="primary" className="mt-1 space-y-0.5 border-t border-primary/10 pt-1">
              {primary.map((e) => (
                <ArtifactRow
                  key={e.path}
                  path={e.path}
                  meta={meta.get(e.path)}
                  author={agents.find((a) => a.id === e.agentId)}
                  stage={stageOf(groupId, e.agentId)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {acceptance && acceptance.unresolved.length > 0 ? (
        <div data-qa-unresolved="" className="mt-1.5 border-t border-primary/10 pt-1.5">
          <div className="px-0.5 text-[11px] text-muted-foreground">验收未决 · {acceptance.unresolved.length} 项</div>
          <ul className="mt-0.5 space-y-0.5">
            {acceptance.unresolved.map((u, i) => (
              <li key={i} className="flex items-start gap-1.5 px-0.5 text-[11.5px] leading-5">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-amber-500/70" aria-hidden />
                <span className="min-w-0">{u}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {groupId === 'development' && anchor ? (
        <div
          data-signoff={anchor}
          className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-primary/10 pt-1.5"
        >
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <PackageCheck className="size-3.5 text-primary/70" />
            核心交付签收
          </span>
          <span className="min-w-0 max-w-[42%] truncate text-[11.5px] font-medium" title={anchor}>
            {baseName(anchor)}
          </span>
          {typeof latestVersion === 'number' ? (
            <span
              data-signoff-version={latestVersion}
              className="shrink-0 rounded-full bg-muted px-1.5 text-[10px] font-medium tabular-nums leading-[1.7] text-muted-foreground"
            >
              v{latestVersion}
            </span>
          ) : null}
          <span className="shrink-0 text-[10.5px] text-muted-foreground">
            已回应 {closure.pairs.length} · 未闭环 {closure.openOpinions.length}
          </span>
          <button
            type="button"
            data-signoff-btn=""
            disabled={latestVersion === undefined}
            title={
              latestVersion === undefined
                ? '等待版本信息'
                : signed
                  ? '取消签收（本地）'
                  : '签收并回填「已签收 <名> vN」草稿'
            }
            onClick={toggleSignoff}
            className={cn(
              'ml-auto shrink-0 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              signed
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600'
                : 'text-muted-foreground hover:border-primary/40 hover:text-primary',
              latestVersion === undefined && 'cursor-not-allowed opacity-50',
            )}
          >
            {signed ? `已签收 v${latestVersion}` : '签收'}
          </button>
        </div>
      ) : null}

    </div>
  )
}

export function CloseoutCard(): React.JSX.Element | null {
  const active = useRunStore((s) => !!s.active)
  // 尾条指纹：id~role~status~user 提及~对其他成员提及~本轮交付件计数（忽略 system 事件条；流式 delta 不改动）
  const tailKey = useSessionStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const m = s.byId.get(s.order[i]!)
      if (!m || m.role === 'system') continue
      const user = m.mentions.includes('user') ? 1 : 0
      const targets = m.mentions.filter((x) => x !== 'user').length
      let delivered = 0
      if (m.role === 'agent' && m.status === 'complete' && user === 1 && targets === 0) {
        for (const mid of s.order) {
          const x = s.byId.get(mid)
          if (!x || x.role !== 'agent' || x.runId !== m.runId) continue
          delivered += x.artifacts?.length ?? 0
        }
      }
      return `${m.id}~${m.role}~${m.status}~${user}~${targets}~${delivered}`
    }
    return ''
  })

  const info = React.useMemo<CloseoutInfo | null>(() => {
    const [id, role, status, user, targets] = tailKey.split('~')
    if (!id || role !== 'agent' || status !== 'complete' || user !== '1' || targets !== '0') return null
    const s = useSessionStore.getState()
    const tail = s.byId.get(id)
    if (!tail) return null
    // 本轮 = 尾条所属 Run；波次数取最大 turnIndex + 1，交付件按出现顺序去重并记录交付者
    let waves = 0
    const entries: DeliveryEntry[] = []
    const seen = new Set<string>()
    for (const mid of s.order) {
      const m = s.byId.get(mid)
      if (!m || m.role !== 'agent' || m.runId !== tail.runId) continue
      if (typeof m.turnIndex === 'number' && m.turnIndex >= 0) waves = Math.max(waves, m.turnIndex + 1)
      for (const p of m.artifacts ?? []) {
        if (seen.has(p)) continue
        seen.add(p)
        entries.push({ path: p, agentId: m.agentId })
      }
    }
    // 无交付件：不渲染收尾卡（每轮固定收尾文案已移除）
    if (entries.length === 0) return null
    if (waves === 0 && typeof tail.turnIndex === 'number' && tail.turnIndex >= 0) waves = tail.turnIndex + 1
    return { tailId: id, ...(tail.runId ? { runId: tail.runId } : {}), waves, entries, createdAt: tail.createdAt }
  }, [tailKey])

  if (active || !info) return null
  return <DeliveryManifest info={info} />
}
