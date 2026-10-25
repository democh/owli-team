/**
 * M52-A 面板 · chartboard 盘面面板（§7.4）：多盘 tabs + 盘面渲染——
 * 数据源：`::: pan` 容器（M51-E 契约）；切盘态 sessionStorage（`ma:sc:tab:*`）；「看解读」回填草稿。
 * M54-C：底部档案抽屉（§5.3）——PanBoard 存档后以 archVer 触发抽屉重读；
 * 顶部「合参」toggle（§5.4）——会话内同时存在可派生 bazi + ziwei 盘时展示双泳道。
 * M54 续完善（§5.1）：顶部「亲手摇卦」入口——请求经 ui-store.openPanToss 下发全局宿主；
 * 无卦盘也可摇（有可派生卦盘 → 作对照基线，否则无对照）。
 * M78：tarot 场景顶部三入口——「亲手抽牌 / 图鉴 / 手记」（类名 `.tc-*` 独立于 `.pn-toss-enter`，
 * m69 断言「tarot 无摇卦」不破）；请求经 ui-store 下发 TarotRitualHost。
 */
import * as React from 'react'
import { Compass } from 'lucide-react'
import { useUiStore } from '../../../stores/ui-store'
import { PAN_KIND_LABEL, PAN_KINDS } from '../../chat/md-ext/remark-ext'
import { Almanac } from '../../chat/md-ext/pan/Almanac'
import { ArchiveDrawer } from '../../chat/md-ext/pan/ArchiveDrawer'
import { parseCards } from '../../chat/md-ext/CardsCard'
import { derivePan } from '../../chat/md-ext/pan/derive'
import { PanCard } from '../../chat/md-ext/PanCard'
import type { PanModel, PanRowData } from '../../chat/md-ext/pan/model'
import { useSceneCtx } from '../context'
import { panRowsOf } from '../derive'
import { useSceneTab } from '../persist'
import { PanBoard, type PanChart } from '../parts'
import { CardsBoard } from '../parts'
import { useSceneContainers } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** M78：塔罗三入口（亲手抽牌 / 图鉴 / 手记；全局宿主消费，不随面板卸载消失） */
function TarotEntries({ sessionId }: { sessionId?: string }): React.JSX.Element {
  const openTarotDraw = useUiStore((s) => s.openTarotDraw)
  const openTarotCodex = useUiStore((s) => s.openTarotCodex)
  const openTarotJournal = useUiStore((s) => s.openTarotJournal)
  return (
    <div className="tc-enter-row">
      <button type="button" className="tc-enter" onClick={() => openTarotDraw({ sessionId })}>
        亲手抽牌
      </button>
      <button type="button" className="tc-enter is-ghost" onClick={openTarotCodex}>
        图鉴
      </button>
      <button type="button" className="tc-enter is-ghost" onClick={openTarotJournal}>
        手记
      </button>
    </div>
  )
}

export function ChartboardPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const containers = useSceneContainers()
  const [activeId, setActiveId] = useSceneTab('chartboard', '', ctx?.sessionId)
  const [archVer, setArchVer] = React.useState(0)
  const [almOpen, setAlmOpen] = React.useState(false)
  const [crossOpen, setCrossOpen] = React.useState(false)
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

  /** M69：牌阵容器（tarot 场景——工作区「牌阵台」区：CardsBoard 布局渲染 + 点牌高亮 + 深入解读回填） */
  const cardCharts = React.useMemo(
    () =>
      containers
        .filter((c) => c.name === 'cards')
        .map((c) => ({
          id: `${c.messageId}:${c.seq}`,
          title: c.arg || '牌阵',
          cards: parseCards(JSON.stringify(panRowsOf(c.lines).items)),
        })),
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
  // M63-F 行运泳道（§5.4 扩展）：会话内首个可派生 transit 盘（含扫描时点时出第三泳道；缺 → 零渲染）
  const transit = React.useMemo<PanModel | null>(() => {
    const c = charts.find((x) => x.kind === 'transit')
    return c ? derivePan('transit', c.title, c.fields, c.items) : null
  }, [charts])
  // M63 续完善（§7 F-t1）：中西对照——会话内同时存在可派生 bazi + natal（或 qizheng）时，
  // 顶部 toggle → 并排双盘（仅并置，不做数据融合）+ 出生参数一致性提示
  const westChart = React.useMemo(
    () => charts.find((x) => x.kind === 'natal') ?? charts.find((x) => x.kind === 'qizheng') ?? null,
    [charts],
  )
  const westModel = React.useMemo<PanModel | null>(() => {
    if (!westChart) return null
    return derivePan(westChart.kind === 'natal' ? 'natal' : 'qizheng', westChart.title, westChart.fields, westChart.items)
  }, [westChart])
  const eastChart = React.useMemo(() => charts.find((x) => x.kind === 'bazi') ?? null, [charts])
  const crossPair = React.useMemo(
    () =>
      bazi?.kind === 'bazi' && eastChart && westChart && westModel
        ? { east: eastChart, west: westChart, westModel }
        : null,
    [bazi, eastChart, westChart, westModel],
  )
  const crossNote = React.useMemo(() => {
    if (!crossPair || bazi?.kind !== 'bazi' || !('detail' in crossPair.westModel)) return null
    const pick = (rows: PanRowData[], key: string): string | undefined => {
      const v = rows.find((r) => r.label === key)?.value
      return v ? /(\d{4}-\d{2}-\d{2} \d{2}:\d{2})/.exec(v)?.[1] : undefined
    }
    const e = pick(bazi.detail, '命造')
    const w = pick(crossPair.westModel.detail, '出生')
    if (!e || !w) return null
    return e === w ? `出生参数一致（${e}）` : `⚠ 出生参数不一致：四柱 ${e} ｜ 星盘 ${w}（请核对取时口径）`
  }, [crossPair, bazi])
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

  const isTarot = ctx?.group?.id === 'tarot'
  if (charts.length === 0 && cardCharts.length === 0) {
    return (
      <PanelShell title="盘面面板" icon={Compass}>
        <div className="pn-alm-bar">
          {!isTarot ? (
            <button type="button" className="pn-toss-enter" onClick={requestToss}>
              亲手摇卦
            </button>
          ) : (
            <TarotEntries sessionId={ctx?.sessionId} />
          )}
        </div>
        <PanelEmpty icon={Compass} text={isTarot ? '对话中抽出的牌阵将显示在这里' : '对话中产生的盘面将显示在这里'} />
        <ArchiveDrawer sessionId={ctx?.sessionId} version={archVer} />
      </PanelShell>
    )
  }

  return (
    <PanelShell title="盘面面板" icon={Compass} badge={<span className="scene-panel-count">{charts.length + cardCharts.length}</span>}>
      <div className="pn-alm-bar">
        {!isTarot ? (
          <button type="button" className="pn-toss-enter" onClick={requestToss}>
            亲手摇卦
          </button>
        ) : (
          <TarotEntries sessionId={ctx?.sessionId} />
        )}
        {almanac ? (
          <button type="button" className="pn-alm-toggle" aria-pressed={almOpen} onClick={() => setAlmOpen((v) => !v)}>
            {almOpen ? '收起合参' : '合参'}
          </button>
        ) : null}
        {crossPair ? (
          <button
            type="button"
            className="pn-alm-toggle"
            aria-pressed={crossOpen}
            onClick={() => setCrossOpen((v) => !v)}
          >
            {crossOpen ? '收起对照' : '中西对照'}
          </button>
        ) : null}
      </div>
      {almanac && almOpen ? (
        <Almanac bazi={almanac.bazi} ziwei={almanac.ziwei} {...(transit?.kind === 'transit' ? { transit } : {})} />
      ) : null}
      {crossPair && crossOpen ? (
        <div className="scene-pb-cross" role="region" aria-label="中西对照（仅并置）">
          {crossNote ? <div className="scene-pb-cross-note">{crossNote}</div> : null}
          <div className="scene-pb-cross-grid">
            <PanCard
              kind={crossPair.east.kind}
              title={crossPair.east.title}
              fields={JSON.stringify(crossPair.east.fields)}
              items={JSON.stringify(crossPair.east.items)}
              raw={crossPair.east.raw}
              hideArchive
            />
            <PanCard
              kind={crossPair.west.kind}
              title={crossPair.west.title}
              fields={JSON.stringify(crossPair.west.fields)}
              items={JSON.stringify(crossPair.west.items)}
              raw={crossPair.west.raw}
              hideArchive
            />
          </div>
          <div className="scene-pb-cross-note is-quiet">中西对照：仅并置呈现，不做数据融合或互译</div>
        </div>
      ) : null}
      {charts.length > 0 ? (
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
            ctx?.insert(`请解读这张${kindLabel}「${chart.title}」的关键结论与依据 。`)
          }}
        />
      ) : null}
      {cardCharts.length > 0 ? (
        <div className="scene-cards-stack">
          {cardCharts.map((c) => (
            <CardsBoard key={c.id} title={c.title} cards={c.cards} onInsert={ctx ? (t) => ctx.insert(t) : undefined} />
          ))}
        </div>
      ) : null}
      <ArchiveDrawer sessionId={ctx?.sessionId} version={archVer} />
    </PanelShell>
  )
}
