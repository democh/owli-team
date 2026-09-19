/**
 * 收尾交付清单（M37-6 修订，ADR 0092；分层默认续修订，ADR 0123）——本轮 Run 交还用户时，
 * 若本轮有交付件，在消息流尾部给出交付清单：类型图标 / 目录 / 文件名 / 体积 / 交付者 + 快捷继续。
 * 默认只展示最终交付（结论性件按重要度取前 N，过程产物判定见 lib/delivery）；
 * 过程产物（charts/ 行情与博弈快照等）与溢出项收进「其他」组默认折叠，箭头全展示 / 收起；
 * 整清单可整体收起隐藏（头部左簇即开关，收起后仅留概要行与快捷继续）；
 * 全为过程产物的极端下「其他」默认展开（卡片不空）；面板入口由头部按钮承载。
 * 无交付件则完全不渲染（轮次结束不重复固定文案；「你的回合」交接条已承载收束语义）。
 * 触发完全从消息派生（尾条为成员「完成」消息且 mentions 仅含 user、无运行中 Run）；
 * 订阅按「尾条指纹」隔离：流式 delta 不改指纹 → 不触发本组件重渲染。
 * 指纹末位含「本轮交付件计数」：流式期消息不带 artifacts（run:end 时 refreshMessages 才回填），
 * 若不入指纹，补全后的刷新不改变指纹 → useMemo 停留在空态（清单卡不出现）。
 * 元数据 hook 下沉至 DeliveryManifest：隐藏态不发起拉取（与「无交付件不渲染」同口径）。
 */
import * as React from 'react'
import { ChevronRight, MessageSquarePlus, Package, PackageOpen } from 'lucide-react'
import type { AgentDefinition } from '@multi-agent/shared'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { useArtifactMeta } from '../../lib/use-artifact-meta'
import { partitionDelivery } from '../../lib/delivery'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'
import { ConfettiBurst } from '../ui/confetti'
import { ArtifactRow } from './DeliveryList'

/** 彩纸触发窗口：仅新近完成的本轮播放，重挂载 / 打开旧会话不重放 */
const CELEBRATE_WINDOW_MS = 90_000
/** 头部交付者头像流上限 */
const MAX_AUTHORS = 5

interface DeliveryEntry {
  path: string
  /** 该交付件的交付者（消息级归属，用于清单行头像） */
  agentId?: string
}

interface CloseoutInfo {
  tailId: string
  waves: number
  entries: DeliveryEntry[]
  createdAt: string
}

/** 快捷继续 chips：回填草稿由用户确认发送（ADR 0064） */
const QUICK_CHIPS: { label: string; prompt: string }[] = [
  { label: '继续推进', prompt: '继续推进下一步' },
  { label: '总结本轮', prompt: '总结一下本轮的成果与遗留问题' },
]

/** 交付清单主体：仅在可见时挂载（元数据按会话共享缓存补齐） */
function DeliveryManifest({ info }: { info: CloseoutInfo }): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const meta = useArtifactMeta()
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const expandWorkspace = useUiStore((s) => s.expandWorkspace)
  const [burst, setBurst] = React.useState(0)
  // 「其他」组折叠态：null = 未操作（默认口径——有最终交付则折叠，全为过程产物则展开）
  const [othersOpen, setOthersOpen] = React.useState<boolean | null>(null)
  // 整清单折叠态：默认展开（收起后仅留概要行与快捷继续）
  const [listOpen, setListOpen] = React.useState(true)

  // 彩纸：挂载一拍内仅新近完成播放（同一条尾消息的重复挂载由 celebrateId 收敛；quiet 在 ConfettiBurst 内部）
  const celebratedRef = React.useRef('')
  React.useEffect(() => {
    if (celebratedRef.current === info.tailId) return
    celebratedRef.current = info.tailId
    setOthersOpen(null) // 新尾条：回到默认折叠口径
    setListOpen(true) // 新尾条：整清单回到展开
    if (Date.now() - Date.parse(info.createdAt) < CELEBRATE_WINDOW_MS) setBurst((n) => n + 1)
  }, [info.tailId, info.createdAt])

  // 分层默认：最终交付（重要度前 N）+ 其他（过程产物与溢出项）
  const { primary, others } = React.useMemo(() => partitionDelivery(info.entries), [info.entries])
  const othersShown = othersOpen ?? primary.length === 0
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
      className="handoff-in relative mx-4 mb-3 mt-1 overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent px-3.5 py-2.5"
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
          {info.waves > 0 && <span className="truncate text-[11px] text-muted-foreground">收束于第 {info.waves} 波</span>}
          <ChevronRight
            className={cn('size-3 shrink-0 text-muted-foreground transition-transform group-hover:text-primary', listOpen && 'rotate-90')}
          />
        </button>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="flex -space-x-1.5">
            {authors.slice(0, MAX_AUTHORS).map((a) => (
              <AgentAvatar key={a.id} agent={a} size={18} animated={false} className="rounded-full ring-1 ring-card" />
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
            <div data-delivery-group="primary" className="mt-1.5 space-y-0.5 border-t border-primary/10 pt-1.5">
              {primary.map((e) => (
                <ArtifactRow key={e.path} path={e.path} meta={meta.get(e.path)} author={agents.find((a) => a.id === e.agentId)} />
              ))}
            </div>
          )}
          {others.length > 0 && (
            <div className={cn(primary.length > 0 ? 'mt-1' : 'mt-1.5 border-t border-primary/10 pt-1.5')}>
              <button
                type="button"
                data-delivery-toggle
                aria-expanded={othersShown}
                aria-label={`其他 ${others.length} 件`}
                title={othersShown ? '收起其他' : `展开其他 ${others.length} 件`}
                onClick={() => setOthersOpen(!othersShown)}
                className="flex w-full items-center gap-1 rounded-lg border border-dashed border-primary/25 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:border-primary/45 hover:text-primary"
              >
                <ChevronRight className={cn('size-3 shrink-0 transition-transform', othersShown && 'rotate-90')} />
                其他 · {others.length} 件
              </button>
              {othersShown && (
                <div data-delivery-group="others" className="mt-0.5 space-y-0.5">
                  {others.map((e) => (
                    <ArtifactRow key={e.path} path={e.path} meta={meta.get(e.path)} author={agents.find((a) => a.id === e.agentId)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-primary/10 pt-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <MessageSquarePlus className="size-3" />
          接着说
        </span>
        {QUICK_CHIPS.map((c) => (
          <button
            key={c.label}
            type="button"
            title={c.prompt}
            className="rounded-full border bg-card px-2.5 py-0.5 text-[11.5px] text-muted-foreground transition-colors hover:border-primary/30 hover:text-primary"
            onClick={() => insertToComposer(c.prompt)}
          >
            {c.label}
          </button>
        ))}
      </div>
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
    return { tailId: id, waves, entries, createdAt: tail.createdAt }
  }, [tailKey])

  if (active || !info) return null
  return <DeliveryManifest info={info} />
}
