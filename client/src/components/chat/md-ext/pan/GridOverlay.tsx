/**
 * M66-B：户型叠图（§10.3）——底图（会话内最近图片附件）+ SVG 九宫网格叠加；
 * 宫位色带按选中盘（八宅游年 / 流年飞星 mini 切换）；格点击 → 回填草稿；
 * 无底图 → 空态引导。v1 修订：网格固定正北在上（图纸偏转对齐列 v2，页面明示前提）；
 * 只读叠加（不写图）。
 */
import * as React from 'react'
import type { LuopanModel } from './model'
import { LUOPAN_GRID9, LUOPAN_STAR_NAME, LUOPAN_STAR_NOTE } from './luopan-model'
import { artifactContentUrl } from '../../../../lib/artifacts'
import { useSessionStore } from '../../../../stores/session-store'

export function GridOverlay({ model, ask }: { model: LuopanModel; ask?: (t: string) => void }): React.JSX.Element {
  const sessionId = useSessionStore((s) => s.currentId)
  const byId = useSessionStore((s) => s.byId)
  const order = useSessionStore((s) => s.order)
  const [mode, setMode] = React.useState<'bazhai' | 'feixing'>('bazhai')
  /** 网格旋转对齐角（0–359°；使宫界与图纸朝向对齐——格内容随网格整体旋转） */
  const [rot, setRot] = React.useState(0)
  /** 指北模式（v3 自动找正：点击图纸北向标记 → 自动计算旋转角） */
  const [pointing, setPointing] = React.useState(false)

  /** 会话内最近一张图片附件（倒序找；v1 校验「图纸已按北向上」由内容提示承担） */
  const image = React.useMemo(() => {
    for (let i = order.length - 1; i >= 0; i--) {
      const m = byId.get(order[i]!)
      const img = m?.attachments?.find((a) => a.kind === 'image')
      if (img) return img
    }
    return undefined
  }, [byId, order])

  /** 工作台快照（design/snapshot-*，已按北向上——无需对齐，给提示徽标） */
  const isSnapshot = image?.path.startsWith('design/snapshot-') ?? false

  /** v3 自动找正：点击位置（相对图心）→ 旋转角（北 = 上：0°；东 = 90°） */
  const onStageClick = (e: React.MouseEvent<HTMLDivElement>): void => {
    if (!pointing) return
    const rect = e.currentTarget.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const nx = (e.clientX - rect.left) / rect.width - 0.5
    const ny = (e.clientY - rect.top) / rect.height - 0.5
    const deg = (Math.atan2(nx, -ny) * 180) / Math.PI
    setRot(Math.round(((deg % 360) + 360) % 360) % 360)
    setPointing(false)
  }

  const bazhaiMap = React.useMemo(() => {
    const m = new Map<string, { star: string; luck: '吉' | '凶' }>()
    for (const p of model.lucky) m.set(p.gua || p.dir, { star: p.star, luck: '吉' })
    for (const p of model.cautious) m.set(p.gua || p.dir, { star: p.star, luck: '凶' })
    return m
  }, [model.lucky, model.cautious])
  const flyMap = React.useMemo(() => new Map(model.fly.map((f) => [f.palace, f.star])), [model.fly])

  if (!image) {
    return (
      <div className="pn-lp-overlay" data-lp-overlay>
        <div className="pn-lp-overlay-empty">
          上传户型图后可用（叠图为只读参考：网格按正北在上——请使用已标注朝向、或已按北向上的图纸；偏转对齐列 v2）
        </div>
      </div>
    )
  }

  return (
    <div className="pn-lp-overlay" data-lp-overlay>
      <div className="pn-lp-overlay-bar">
        <button
          type="button"
          className={mode === 'bazhai' ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-ov-mode="bazhai"
          onClick={() => setMode('bazhai')}
        >
          游年叠图
        </button>
        <button
          type="button"
          className={mode === 'feixing' ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-ov-mode="feixing"
          onClick={() => setMode('feixing')}
        >
          飞星叠图
        </button>
        <label className="pn-lp-ov-rot">
          对齐
          <input
            type="range"
            min={0}
            max={359}
            step={1}
            value={rot}
            onChange={(e) => setRot(Number(e.target.value))}
            aria-label="网格旋转对齐角"
            data-lp-ov-rot
          />
          <span className="pn-lp-ov-rot-val">{rot}°</span>
        </label>
        {rot !== 0 ? (
          <button type="button" className="pn-lp-tab" onClick={() => setRot(0)} data-lp-ov-reset>
            复位
          </button>
        ) : null}
        <button
          type="button"
          className={pointing ? 'pn-lp-tab pn-lp-tab-on' : 'pn-lp-tab'}
          data-lp-ov-point
          onClick={() => setPointing((v) => !v)}
          title="自动找正：在图纸上点击北向标记（以图心为起点）"
        >
          指北
        </button>
        <span className="pn-lp-overlay-note" data-lp-ov-note>
          {isSnapshot ? '工作台快照（已按北向上）' : '图纸有偏转时：点「指北」或拖动「对齐」'}
        </span>
      </div>
      <div
        className={pointing ? 'pn-lp-overlay-stage pn-lp-pointing' : 'pn-lp-overlay-stage'}
        data-lp-ov-stage
        onClick={onStageClick}
      >
        {pointing ? <div className="pn-lp-ov-hint">点击图纸上的北向标记（从图心指向该点）</div> : null}
        {sessionId ? (
          <img className="pn-lp-overlay-img" src={artifactContentUrl(sessionId, image.path)} alt={image.name} />
        ) : null}
        <svg className="pn-lp-overlay-grid" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="九宫网格叠加">
          <g
            transform={rot !== 0 ? `rotate(${rot} 50 50)` : undefined}
            data-lp-ov-rotg={rot}
            style={{ pointerEvents: pointing ? 'none' : 'auto' }}
          >
            {LUOPAN_GRID9.map((g) => {
            const info =
              mode === 'feixing'
                ? (() => {
                    const s = flyMap.get(g.palace)
                    return { main: s ? (LUOPAN_STAR_NAME[s] ?? String(s)) : '—', tone: s === 5 ? 'care' : 'star', note: '流年落宫（传统参考，逐年变化）' }
                  })()
                : (() => {
                    const b = bazhaiMap.get(g.palace)
                    return {
                      main: b ? b.star : '—',
                      tone: b ? (b.luck === '吉' ? 'good' : 'care') : 'none',
                      note: b ? (LUOPAN_STAR_NOTE[b.star] ?? '传统参考') : '未取到该宫游年星',
                    }
                  })()
            const x = g.col * (100 / 3)
            const y = g.row * (100 / 3)
            return (
              <g
                key={g.palace}
                className="pn-lp-ov-cell"
                data-lp-ov-cell={g.palace}
                onClick={() => ask?.(`@司南 户型图${g.palace}宫（${g.dir}，${info.main}）想进一步了解：<补述问题>；`)}
              >
                <title>{`${g.palace}宫 · ${g.dir} · ${info.main}（${info.note}）`}</title>
                <rect x={x + 0.4} y={y + 0.4} width={100 / 3 - 0.8} height={100 / 3 - 0.8} className={`pn-lp-ov-bg pn-lp-ov-${info.tone}`} />
              </g>
            )
            })}
          </g>
        </svg>
      </div>
    </div>
  )
}
