/**
 * M66-B：罗盘盘面 · 三环罗盘（§10.2）——外环二十四山 / 中环后天八卦 / 内层九宫格（八宅·流年双盘）+
 * 第三 tab 户型叠图（GridOverlay）。几何：正北在上（deg − 90 转屏幕角），viewBox 320×320 静态 SVG。
 * 口径纪律：坐向 / 星号一律取自卡内派生（deriveLuopan），不重算、不预测；宫位详情统一带「参考」前缀
 * （合规表述——不写「大凶」）；派生失败由 PanView 回退静态表格（零回归路径）。
 */
import * as React from 'react'
import type { LuopanModel } from './model'
import { LUOPAN_GRID9, LUOPAN_STAR_NAME, LUOPAN_STAR_NOTE, splitDegrees } from './luopan-model'
import { AskBar, Legend } from './parts'
import { GridOverlay } from './GridOverlay'

const CX = 160
const CY = 160
const R_OUT = 150
const R_GUA = 116
const R_GRID = 86

/** 二十四山（自子山起顺时针） */
const MOUNTAINS = [
  '子', '癸', '丑', '艮', '寅', '甲', '卯', '乙', '辰', '巽', '巳', '丙',
  '午', '丁', '未', '坤', '申', '庚', '酉', '辛', '戌', '乾', '亥', '壬',
] as const

/** 后天八卦方位（中值角：正北在上） */
const GUA_ORDER: { gua: string; dir: string; mid: number }[] = [
  { gua: '坎', dir: '北', mid: 0 },
  { gua: '艮', dir: '东北', mid: 45 },
  { gua: '震', dir: '东', mid: 90 },
  { gua: '巽', dir: '东南', mid: 135 },
  { gua: '离', dir: '南', mid: 180 },
  { gua: '坤', dir: '西南', mid: 225 },
  { gua: '兑', dir: '西', mid: 270 },
  { gua: '乾', dir: '西北', mid: 315 },
]

/** 九宫格屏幕排布（正北在上：上排 西北/北/东北）——共用常量见 luopan-model.LUOPAN_GRID9 */

/** 度数 → 屏幕坐标（正北在上） */
function pt(deg: number, r: number): [number, number] {
  const rad = ((deg - 90) * Math.PI) / 180
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)]
}

/** 环形扇区 path */
function sector(a1: number, a2: number, r1: number, r2: number): string {
  const [x1, y1] = pt(a1, r2)
  const [x2, y2] = pt(a2, r2)
  const [x3, y3] = pt(a2, r1)
  const [x4, y4] = pt(a1, r1)
  const large = a2 - a1 > 180 ? 1 : 0
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} A${r2} ${r2} 0 ${large} 1 ${x2.toFixed(1)} ${y2.toFixed(1)} L${x3.toFixed(1)} ${y3.toFixed(1)} A${r1} ${r1} 0 ${large} 0 ${x4.toFixed(1)} ${y4.toFixed(1)} Z`
}

type CellInfo = { main: string; sub: string; tone: 'good' | 'care' | 'star' | 'none'; note: string }

export function LuopanBoard({
  model,
  onAsk,
  onPalace,
}: {
  model: LuopanModel
  onAsk?: (t: string) => void
  /** 点宫上报（研习足迹；M54 档案体系通用） */
  onPalace?: (palace: string) => void
}): React.JSX.Element {
  const [tab, setTab] = React.useState<'bazhai' | 'feixing' | 'overlay'>('bazhai')
  const [sel, setSel] = React.useState<string | null>(null)

  const deg = splitDegrees(model.degrees)

  const bazhaiMap = React.useMemo(() => {
    const m = new Map<string, { star: string; luck: '吉' | '凶' }>()
    for (const p of model.lucky) m.set(p.gua || p.dir, { star: p.star, luck: '吉' })
    for (const p of model.cautious) m.set(p.gua || p.dir, { star: p.star, luck: '凶' })
    return m
  }, [model.lucky, model.cautious])
  const flyMap = React.useMemo(() => new Map(model.fly.map((f) => [f.palace, f.star])), [model.fly])

  /** 宫位单元信息（按当前双盘派生） */
  const cellInfo = React.useCallback(
    (palace: string, dir: string): CellInfo => {
      if (tab === 'feixing') {
        const s = flyMap.get(palace)
        return s
          ? {
              main: LUOPAN_STAR_NAME[s] ?? String(s),
              sub: dir,
              tone: s === 5 ? 'care' : 'star',
              note: '流年落宫（传统参考，逐年变化）',
            }
          : { main: '—', sub: dir, tone: 'none', note: '未取到该宫星号' }
      }
      const b = bazhaiMap.get(palace)
      return b
        ? {
            main: b.star,
            sub: dir,
            tone: b.luck === '吉' ? 'good' : 'care',
            note: LUOPAN_STAR_NOTE[b.star] ?? '传统参考',
          }
        : { main: '—', sub: dir, tone: 'none', note: '未取到该宫游年星' }
    },
    [tab, flyMap, bazhaiMap],
  )

  const selCell = sel ? LUOPAN_GRID9.find((g) => g.palace === sel) : undefined
  const selInfo = selCell ? cellInfo(selCell.palace, selCell.dir) : undefined

  const onCell = (palace: string): void => {
    const next = sel === palace ? null : palace
    setSel(next)
    if (next !== null) onPalace?.(palace)
  }

  const askItems = React.useMemo(() => {
    const items: Array<{ text: string; onPick?: () => void }> = []
    if (onAsk && selCell && selInfo) {
      items.push({
        text: `深入「${selCell.palace}宫（${selCell.dir}）」`,
        onPick: () => onAsk(`@司南 关于${selCell.palace}宫（${selCell.dir}，${selInfo.main}）想进一步了解：<补述问题>；`),
      })
    }
    if (onAsk) {
      items.push({
        text: '盘面依据核对',
        onPick: () => onAsk(`@司南 想核对该盘的排版依据（坐向 ${model.sitting}/${model.facing}、宅卦 ${model.house}、${model.yun}）：`),
      })
    }
    return items
  }, [onAsk, selCell, selInfo, model.sitting, model.facing, model.house, model.yun])

  return (
    <div className="pn-luopan" data-luopan>
      {/* 盘头：坐向摘要 + 徽标 */}
      <div className="pn-lp-head">
        <span className="pn-lp-title">
          {model.sitting || '?'} 向 {model.facing || '?'}
        </span>
        {model.house ? <span className="pn-lp-chip">{model.house}{model.group ? `（${model.group}）` : ''}</span> : null}
        {model.quality ? <span className="pn-lp-chip">数据等级 {model.quality}</span> : null}
        <span className="pn-lp-chip pn-lp-chip-dim">八宅·坐山派 / 玄空·下卦</span>
      </div>

      {/* 双盘 tab + 叠图 */}
      <div className="pn-lp-tabs" role="tablist" aria-label="盘面切换">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'bazhai'}
          className={tab === 'bazhai' ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-tab="bazhai"
          onClick={() => { setTab('bazhai'); setSel(null) }}
        >
          八宅游年
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'feixing'}
          className={tab === 'feixing' ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-tab="feixing"
          onClick={() => { setTab('feixing'); setSel(null) }}
        >
          流年飞星
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'overlay'}
          className={tab === 'overlay' ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-tab="overlay"
          onClick={() => { setTab('overlay'); setSel(null) }}
        >
          户型叠图
        </button>
      </div>

      {tab === 'overlay' ? (
        <GridOverlay model={model} {...(onAsk ? { ask: onAsk } : {})} />
      ) : (
        <>
          {/* 三环罗盘（静态 SVG；八宅态：九宫格显示游年星；飞星态：显示星号） */}
          <svg className="pn-lp-svg" viewBox="0 0 320 320" role="img" aria-label="罗盘盘面" data-lp-svg>
            {/* 外环：二十四山 */}
            {MOUNTAINS.map((m, i) => {
              const mid = i * 15
              const d = sector(mid - 7.5, mid + 7.5, R_GUA, R_OUT)
              const [lx, ly] = pt(mid, (R_GUA + R_OUT) / 2)
              return (
                <g key={m}>
                  <path d={d} className="pn-lp-mount-cell" />
                  <text x={lx} y={ly} className="pn-lp-mount" textAnchor="middle" dominantBaseline="central">
                    {m}
                  </text>
                </g>
              )
            })}
            {/* 四正十字线 */}
            <line x1={CX} y1={CY - R_OUT} x2={CX} y2={CY - R_GUA} className="pn-lp-cross" />
            <line x1={CX} y1={CY + R_GUA} x2={CX} y2={CY + R_OUT} className="pn-lp-cross" />
            <line x1={CX - R_OUT} y1={CY} x2={CX - R_GUA} y2={CY} className="pn-lp-cross" />
            <line x1={CX + R_GUA} y1={CY} x2={CX + R_OUT} y2={CY} className="pn-lp-cross" />
            {/* 中环：后天八卦 */}
            {GUA_ORDER.map((g) => {
              const d = sector(g.mid - 22.5, g.mid + 22.5, R_GRID, R_GUA)
              const [lx, ly] = pt(g.mid, (R_GRID + R_GUA) / 2)
              return (
                <g key={g.gua}>
                  <path d={d} className="pn-lp-gua-cell" />
                  <text x={lx} y={ly} className="pn-lp-gua" textAnchor="middle" dominantBaseline="central">
                    {g.gua}
                  </text>
                </g>
              )
            })}
            {/* 坐向指针（有度数时；坐虚线 / 向实线） */}
            {deg ? (
              <>
                <line
                  x1={CX}
                  y1={CY}
                  x2={pt(deg[0], R_OUT)[0]}
                  y2={pt(deg[0], R_OUT)[1]}
                  className="pn-lp-needle-sit"
                />
                <line
                  x1={CX}
                  y1={CY}
                  x2={pt(deg[1], R_OUT)[0]}
                  y2={pt(deg[1], R_OUT)[1]}
                  className="pn-lp-needle-face"
                />
              </>
            ) : null}
            {/* 内层：九宫格 */}
            {LUOPAN_GRID9.map((g) => {
              const size = (R_GRID * 2) / 3
              const x = CX - R_GRID + g.col * size
              const y = CY - R_GRID + g.row * size
              const info = cellInfo(g.palace, g.dir)
              return (
                <g
                  key={g.palace}
                  className={sel === g.palace ? 'pn-lp-cell pn-lp-cell-sel' : `pn-lp-cell pn-lp-cell-${info.tone}`}
                  onClick={() => onCell(g.palace)}
                  role="button"
                  tabIndex={0}
                  data-lp-cell={g.palace}
                >
                  <rect x={x + 1.5} y={y + 1.5} width={size - 3} height={size - 3} rx={6} className="pn-lp-cell-bg" />
                  <text x={x + size / 2} y={y + size / 2 - 8} className="pn-lp-cell-main" textAnchor="middle" dominantBaseline="central">
                    {info.main}
                  </text>
                  <text x={x + size / 2} y={y + size / 2 + 12} className="pn-lp-cell-sub" textAnchor="middle" dominantBaseline="central">
                    {g.palace}·{g.dir}
                  </text>
                </g>
              )
            })}
          </svg>

          {/* 宫位详情条（点击宫位后） */}
          {selCell && selInfo ? (
            <div className="pn-lp-detail" data-lp-detail>
              <span className="pn-lp-detail-main">
                {selCell.palace}宫（{selCell.dir}）· {selInfo.main}
              </span>
              <span className="pn-lp-detail-note">参考：{selInfo.note}</span>
            </div>
          ) : null}

          {/* 底部摘要：运盘 / 流年 */}
          <div className="pn-lp-foot">
            {model.yun ? <span className="pn-lp-foot-item">{model.yun}</span> : null}
            {model.year ? (
              <span className="pn-lp-foot-item">
                {model.year} {model.yearStar}入中
              </span>
            ) : null}
          </div>

          <Legend
            items={[
              <span key="good" className="pn-lp-lg-good">
                参考吉方
              </span>,
              <span key="care" className="pn-lp-lg-care">
                传统慎用方（宜作辅助功能）
              </span>,
            ]}
            ariaLabel="罗盘图例"
          />
        </>
      )}

      <AskBar items={askItems} />
    </div>
  )
}
