/**
 * M52-A 面板 · console 看板面板（§7.4）：管道看板 / 活动时间轴 / 交付件——
 * 看板数据源：`::: kanban|pipe|board` 容器条目（每容器一列）；时间轴取最近成员消息；点卡 / 点条目定位来源消息。
 */
import * as React from 'react'
import { Activity } from 'lucide-react'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { useUiStore } from '../../../stores/ui-store'
import { useSceneCtx } from '../context'
import { artifactsOf, panRowsOf, type SceneContainer } from '../derive'
import { DeliveryPanel, KanbanBoard, type KanbanCard, type KanbanColumn } from '../parts'
import { useSceneContainers, useSceneMessages } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 识别为管道看板的容器名（M41 管道容器接入前，先承接口头 kanban） */
const KANBAN_NAMES = new Set(['kanban', 'pipe', 'board'])

/** 时间轴呈现的最近成员消息条数 */
const TIMELINE_MAX = 12

/** 消息正文首行摘要（跳过空行 / 容器标记行；截断 52 字符） */
function firstLine(content: string): string {
  for (const raw of content.split('\n')) {
    const t = raw
      .trim()
      .replace(/^[#>*\-\s]+/, '')
      .replace(/[`*_]/g, '')
    if (t === '' || t.startsWith(':::')) continue
    return t.length > 52 ? `${t.slice(0, 52)}…` : t
  }
  return '（无正文）'
}

function columnsOf(containers: SceneContainer[]): KanbanColumn[] {
  const out: KanbanColumn[] = []
  for (const c of containers) {
    if (!KANBAN_NAMES.has(c.name)) continue
    const { items, fields } = panRowsOf(c.lines)
    const colId = `${c.messageId}:${c.seq}`
    const cards: KanbanCard[] = [
      ...items.map((it, i) => ({
        id: `${c.messageId}:i${i}`,
        title: it.label || it.value,
        meta: it.label ? it.value : undefined,
      })),
      ...fields.map((f, i) => ({
        id: `${c.messageId}:f${i}`,
        title: f.label,
        meta: f.value,
      })),
    ]
    if (cards.length > 0) out.push({ id: colId, title: c.arg || '管道', cards })
  }
  return out
}

export function ConsolePanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const messages = useSceneMessages()
  const containers = useSceneContainers()

  const timeline = React.useMemo(
    () =>
      messages
        .filter((m) => m.role === 'agent' && m.agentId)
        .slice(-TIMELINE_MAX)
        .reverse()
        .map((m) => ({
          id: m.id,
          agentId: m.agentId!,
          text: firstLine(m.content),
          turn: m.turnIndex,
        })),
    [messages],
  )
  const columns = React.useMemo(() => columnsOf(containers), [containers])
  const deliveries = React.useMemo(() => artifactsOf(messages), [messages])

  if (timeline.length === 0 && columns.length === 0 && deliveries.length === 0) {
    return (
      <PanelShell title="看板面板" icon={Activity}>
        <PanelEmpty icon={Activity} text="活动与产出将在这里显示" hint="成员推进的阶段、动作与交付件会汇入本面板" />
      </PanelShell>
    )
  }

  return (
    <PanelShell title="看板面板" icon={Activity}>
      <div className="scene-console">
        {columns.length > 0 ? (
          <section className="scene-console-sec">
            <div className="scene-console-cap">管道</div>
            <KanbanBoard columns={columns} onCard={(card) => ctx?.focus(card.id.split(':')[0]!)} />
          </section>
        ) : null}
        {timeline.length > 0 ? (
          <section className="scene-console-sec">
            <div className="scene-console-cap">活动时间轴</div>
            <div className="scene-console-tl" role="list" aria-label="活动时间轴">
              {timeline.map((it) => {
                const agent = ctx?.agentOf(it.agentId)
                return (
                  <button
                    type="button"
                    role="listitem"
                    key={it.id}
                    className="scene-console-item"
                    title="定位来源消息"
                    onClick={() => ctx?.focus(it.id)}
                  >
                    {agent ? (
                      <AgentAvatar agent={agent} size={18} animated={false} className="rounded-full shrink-0" />
                    ) : (
                      <span className="scene-pool-dot" aria-hidden />
                    )}
                    <span className="scene-console-text">{it.text}</span>
                    {it.turn != null && it.turn >= 0 ? <span className="scene-console-turn">R{it.turn + 1}</span> : null}
                  </button>
                )
              })}
            </div>
          </section>
        ) : null}
        {deliveries.length > 0 ? (
          <section className="scene-console-sec">
            <div className="scene-console-cap">交付件</div>
            <DeliveryPanel
              items={deliveries.map((path) => ({ path }))}
              onOpen={(path) => useUiStore.getState().requestArtifact(path)}
            />
          </section>
        ) : null}
      </div>
    </PanelShell>
  )
}
