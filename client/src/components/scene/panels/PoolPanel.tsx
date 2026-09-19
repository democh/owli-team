/**
 * M52-A 面板 · pool 汇聚板（§7.4）：容器条目卡墙——研讨产物（点子 / 来源 / 立场 / 选项）实时沉淀；
 * 点卡头定位来源消息；点条目 / 「深入」回填草稿（composerInsert 统一语义，用户确认后发送）。
 */
import * as React from 'react'
import { ArrowRight, LayoutGrid } from 'lucide-react'
import { AgentAvatar } from '../../agents/AgentAvatar'
import { useSceneCtx } from '../context'
import { panRowsOf } from '../derive'
import { useSceneContainers } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 容器名 → 中文徽标（未知容器显示原名） */
const CONTAINER_LABEL: Record<string, string> = {
  ideas: '点子',
  sources: '来源',
  claim: '主张',
  offer: '报价',
  verdict: '裁决',
  checklist: '清单',
  pan: '盘面',
  pool: '汇聚',
}

/** 卡片墙最多呈现的条目数（其余由「深入」回填展开） */
const MAX_ITEMS = 4

export function PoolPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const containers = useSceneContainers()

  const cards = React.useMemo(
    () =>
      containers
        .map((c) => {
          const { fields, items } = panRowsOf(c.lines)
          return {
            id: `${c.messageId}:${c.seq}`,
            name: c.name,
            title: c.arg,
            agentId: c.messageAgentId,
            messageId: c.messageId,
            items: items.slice(0, MAX_ITEMS),
            fields: fields.slice(0, 2),
            total: items.length + fields.length,
          }
        })
        // 无结构化行且无标题的纯文本块不产生卡（正文由消息流呈现）
        .filter((c) => c.total > 0 || c.title !== '')
        .reverse(),
    [containers],
  )

  if (cards.length === 0) {
    return (
      <PanelShell title="汇聚板" icon={LayoutGrid}>
        <PanelEmpty icon={LayoutGrid} text="研讨产物将汇聚在这里" hint="对话中产生的要点、选项与来源会沉淀成卡片" />
      </PanelShell>
    )
  }

  return (
    <PanelShell title="汇聚板" icon={LayoutGrid} badge={<span className="scene-panel-count">{cards.length}</span>}>
      <div className="scene-pool" role="list" aria-label="汇聚板">
        {cards.map((card) => {
          const agent = card.agentId ? ctx?.agentOf(card.agentId) : undefined
          return (
            <div className="scene-pool-card" key={card.id} role="listitem">
              <button
                type="button"
                className="scene-pool-head"
                title="定位来源消息"
                onClick={() => ctx?.focus(card.messageId)}
              >
                {agent ? (
                  <AgentAvatar agent={agent} size={18} animated={false} className="rounded-full shrink-0" />
                ) : (
                  <span className="scene-pool-dot" aria-hidden />
                )}
                <span className="scene-pool-badge">{CONTAINER_LABEL[card.name] ?? card.name}</span>
                <span className="scene-pool-title">{card.title || '（未命名）'}</span>
                <span className="scene-pool-count">{card.total}</span>
              </button>
              {card.items.length > 0 ? (
                <ul className="scene-pool-items">
                  {card.items.map((it, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        className="scene-pool-item"
                        title="引用这条内容"
                        onClick={() =>
                          ctx?.insert(it.label ? `关于「${it.label}」：${it.value}——请进一步展开。` : `${it.value}——请进一步展开。`)
                        }
                      >
                        {it.label ? <span className="scene-pool-item-label">{it.label}</span> : null}
                        <span className="scene-pool-item-value">{it.value}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {card.fields.length > 0 ? (
                <div className="scene-pool-fields">
                  {card.fields.map((f, i) => (
                    <span className="scene-pool-field" key={i}>
                      <b>{f.label}</b>
                      {f.value}
                    </span>
                  ))}
                </div>
              ) : null}
              <button
                type="button"
                className="scene-pool-dig"
                onClick={() => ctx?.insert(`请深入展开「${card.title || card.name}」。`)}
              >
                <ArrowRight size={12} />
                深入
              </button>
            </div>
          )
        })}
      </div>
    </PanelShell>
  )
}
