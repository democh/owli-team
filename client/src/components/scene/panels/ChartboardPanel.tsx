/**
 * M52-A 面板 · chartboard 盘面面板（§7.4）：多盘 tabs + 盘面渲染——
 * 数据源：`::: pan` 容器（M51-E 契约）；切盘态 sessionStorage（`ma:sc:tab:*`）；「看解读」回填草稿。
 * M54-C：底部档案抽屉（§5.3）——PanBoard 存档后以 archVer 触发抽屉重读；
 * 顶部「合参」toggle（§5.4）——会话内同时存在可派生 bazi + ziwei 盘时展示双泳道。
 * M54 续完善（§5.1）：顶部「亲手摇卦」入口——请求经 ui-store.openPanToss 下发全局宿主；
 * 无卦盘也可摇（有可派生卦盘 → 作对照基线，否则无对照）。
 */
import * as React from 'react'
import { Compass } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { PAN_KIND_LABEL, PAN_KINDS } from '../../chat/md-ext/remark-ext'
import { Almanac } from '../../chat/md-ext/pan/Almanac'
import { ArchiveDrawer } from '../../chat/md-ext/pan/ArchiveDrawer'
import { derivePan } from '../../chat/md-ext/pan/derive'
import type { PanModel } from '../../chat/md-ext/pan/model'
import { useSceneCtx } from '../context'
import { panRowsOf } from '../derive'
import { useSceneTab } from '../persist'
import { PanBoard, type PanChart } from '../parts'
import { useSceneContainers } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

export function ChartboardPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const containers = useSceneContainers()
  const [activeId, setActiveId] = useSceneTab('chartboard', '', ctx?.sessionId)
  const [archVer, setArchVer] = React.useState(0)
  const [almOpen, setAlmOpen] = React.useState(false)
  const openPanToss = useUiStore((s) => s.openPanToss)

  const charts = React.useMemo<PanChart[]>(
    () =>
      containers
        .filter((c) => c.name === 'pan')
        .map((c) => {
          const m = /^(\S+)\s*(.*)$/.exec(c.arg)
          const kind = m?.[1] ?? ''
          const title = (m?.[2] ?? '').trim() || kind
          const { fields, items } = panRowsOf(c.lines)
          return { id: `${c.messageId}:${c.seq}`, kind, title, fields, items, raw: c.raw }
        }),
    [containers],
  )

  // 合参（§5.4）：会话内首个可派生 bazi + ziwei 盘（派生失败 / 缺一盘 → 无 toggle）
  const bazi = React.useMemo<PanModel | null>(() => {
    const c = charts.find((x) => x.kind === 'bazi')
    return c ? derivePan('bazi', c.title, c.fields, c.items) : null
  }, [charts])
  const ziwei = React.useMemo<PanModel | null>(() => {
    const c = charts.find((x) => x.kind === 'ziwei')
    return c ? derivePan('ziwei', c.title, c.fields, c.items) : null
  }, [charts])
  const almanac = bazi?.kind === 'bazi' && ziwei?.kind === 'ziwei' ? { bazi, ziwei } : null
  // 摇卦基线（§5.1）：会话内首个可派生卦盘；无卦盘 → compare = null（无对照直接摇）
  const guaModel = React.useMemo<PanModel | null>(() => {
    const c = charts.find((x) => x.kind === 'gua')
    return c ? derivePan('gua', c.title, c.fields, c.items) : null
  }, [charts])

  /** 顶部「亲手摇卦」（§5.1）：请求全局宿主打开摇卦台（对照基线 = 本面板首个卦盘） */
  const requestToss = (): void => {
    openPanToss({
      compare:
        guaModel?.kind === 'gua' ? { title: guaModel.ben, yao: guaModel.yao.map((y) => ({ yin: y.yin })) } : null,
      sessionId: ctx?.sessionId,
    })
  }

  if (charts.length === 0) {
    return (
      <PanelShell title="盘面面板" icon={Compass}>
        <div className="pn-alm-bar">
          <button type="button" className="pn-toss-enter" onClick={requestToss}>
            亲手摇卦
          </button>
        </div>
        <PanelEmpty icon={Compass} text="对话中产生的盘面将显示在这里" hint="排盘工具输出的盘面会自动汇入本面板，可切换与解读" />
        <ArchiveDrawer sessionId={ctx?.sessionId} version={archVer} />
      </PanelShell>
    )
  }

  return (
    <PanelShell title="盘面面板" icon={Compass} badge={<span className="scene-panel-count">{charts.length}</span>}>
      <div className="pn-alm-bar">
        <button type="button" className="pn-toss-enter" onClick={requestToss}>
          亲手摇卦
        </button>
        {almanac ? (
          <button type="button" className="pn-alm-toggle" aria-pressed={almOpen} onClick={() => setAlmOpen((v) => !v)}>
            {almOpen ? '收起合参' : '合参'}
          </button>
        ) : null}
      </div>
      {almanac && almOpen ? <Almanac bazi={almanac.bazi} ziwei={almanac.ziwei} /> : null}
      <PanBoard
        charts={charts}
        activeId={activeId || undefined}
        onActive={setActiveId}
        sessionId={ctx?.sessionId}
        onArchived={() => setArchVer((v) => v + 1)}
        onInterpret={(chart) => {
          const kindLabel = (PAN_KINDS as readonly string[]).includes(chart.kind)
            ? PAN_KIND_LABEL[chart.kind as keyof typeof PAN_KIND_LABEL]
            : '盘面'
          ctx?.insert(`请解读这张${kindLabel}「${chart.title}」的关键结论与依据。`)
        }}
      />
      <ArchiveDrawer sessionId={ctx?.sessionId} version={archVer} />
    </PanelShell>
  )
}
