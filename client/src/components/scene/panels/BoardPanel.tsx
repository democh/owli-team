/**
 * M52-A 面板 · board 工序面板（§7.4）：版本线 + 目录树 + 交付件——
 * 数据源：含标题成员消息（最新为当前稿、其余为版本线）+ artifacts；点节点定位来源消息。
 */
import * as React from 'react'
import { ListTree } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { useUiStore } from '../../../stores/ui-store'
import { useSceneCtx } from '../context'
import { artifactsOf, headingsOf, type SceneHeading } from '../derive'
import { DeliveryPanel } from '../parts'
import { useSceneMessages } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

interface BoardVersion {
  id: string
  agentId?: string
  headCount: number
  first: SceneHeading
}

interface BoardModel {
  current?: { id: string; heads: SceneHeading[] }
  versions: BoardVersion[]
  deliveries: string[]
}

function buildModel(messages: ReturnType<typeof useSceneMessages>): BoardModel {
  const withHeads: { id: string; agentId?: string; heads: SceneHeading[] }[] = []
  for (const m of messages) {
    if (m.role !== 'agent') continue
    const heads = headingsOf(m.content)
    if (heads.length > 0) withHeads.push({ id: m.id, agentId: m.agentId, heads })
  }
  const current = withHeads[withHeads.length - 1]
  const history = withHeads.slice(0, -1)
  return {
    current,
    versions: history
      .slice(-8)
      .reverse()
      .map((v) => ({ id: v.id, agentId: v.agentId, headCount: v.heads.length, first: v.heads[0]! })),
    deliveries: artifactsOf(messages),
  }
}

/** 逐场景空态文案（M52-C 细化兑现：§67.2 记录 board 三场景语汇各异，未收录场景用中性默认） */
interface BoardCopy {
  emptyText: string
  emptyHint: string
}

const BOARD_COPY: Record<string, BoardCopy> = {
  // 游戏工坊：GDD 目录树 + 数值表
  gamedesign: { emptyText: '设计文档与数值表将在这里显示', emptyHint: '成员推进后，GDD 目录树与数值表会自动跟进' },
  // 创作工作室：文稿版本线（原文案即写作语境，保留）
  writing: { emptyText: '文稿结构与版本将在这里显示', emptyHint: '成员落笔后，目录树与版本线会自动跟进' },
  // 置业安家：对比矩阵 + 预算测算
  housing: { emptyText: '方案对比与预算测算将在这里显示', emptyHint: '成员测算后，对比矩阵与预算表会自动跟进' },
}

const BOARD_COPY_DEFAULT: BoardCopy = {
  emptyText: '文档结构与版本将在这里显示',
  emptyHint: '成员落笔后，目录树与版本线会自动跟进',
}

export function BoardPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const messages = useSceneMessages()
  const model = React.useMemo(() => buildModel(messages), [messages])

  const copy = BOARD_COPY[ctx?.group?.id ?? ''] ?? BOARD_COPY_DEFAULT
  const empty = !model.current && model.versions.length === 0 && model.deliveries.length === 0
  if (empty) {
    return (
      <PanelShell title="工序面板" icon={ListTree}>
        <PanelEmpty icon={ListTree} text={copy.emptyText} hint={copy.emptyHint} />
      </PanelShell>
    )
  }

  const totalVer = model.versions.length + (model.current ? 1 : 0)

  return (
    <PanelShell title="工序面板" icon={ListTree} badge={<span className="scene-panel-count">v{totalVer}</span>}>
      <div className="scene-board">
        {model.current ? (
          <section className="scene-board-sec">
            <div className="scene-board-cap">当前稿结构</div>
            <div className="scene-board-tree" role="list" aria-label="目录树">
              {model.current.heads.map((h, i) => (
                <button
                  type="button"
                  role="listitem"
                  key={i}
                  className={cn('scene-board-node', `scene-board-lv${Math.min(h.level, 3)}`)}
                  title="定位到该稿消息"
                  onClick={() => ctx?.focus(model.current!.id)}
                >
                  <span className="scene-board-node-text">{h.text}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {model.versions.length > 0 ? (
          <section className="scene-board-sec">
            <div className="scene-board-cap">版本线</div>
            <div className="scene-board-vers" role="list" aria-label="版本线">
              {model.versions.map((v, i) => (
                <button
                  type="button"
                  role="listitem"
                  key={v.id}
                  className="scene-board-ver"
                  title="定位到该版本消息"
                  onClick={() => ctx?.focus(v.id)}
                >
                  <span className="scene-board-ver-no">v{totalVer - 1 - i}</span>
                  <span className="scene-board-ver-title">{v.first.text}</span>
                  <span className="scene-board-ver-meta">{v.headCount} 节</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {model.deliveries.length > 0 ? (
          <section className="scene-board-sec">
            <div className="scene-board-cap">交付件</div>
            <DeliveryPanel
              items={model.deliveries.map((path) => ({ path }))}
              onOpen={(path) => useUiStore.getState().requestArtifact(path)}
            />
          </section>
        ) : null}
      </div>
    </PanelShell>
  )
}
