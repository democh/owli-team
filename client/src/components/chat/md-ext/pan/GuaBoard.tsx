/**
 * M54-B t1：卦盘 · 装卦剧场（§4.1）——爻列 / 爻详情 / 变卦剧场 / 错·综预览 / 重放装卦。
 * M54-C：底部「亲手摇卦」入口（§5.1；onOpenToss 由外壳注入，板内不触存储）。
 *
 * 口径纪律：卦名与爻数据一律取自卡内派生（deriveGua）；板内只做确定性展示变换
 * （错 = 六爻全变、综 = 六爻颠倒，名称取自卡字段「错卦」段），不新造数据、不预测。
 * 重放仅为逐爻点亮（300ms/爻，reduced-motion 直出终态）；标记：世 ● / 应 ○ / 动 ▲ / 空亡 虚线框。
 */
import * as React from 'react'
import type { GuaModel, GuaYao } from './model'
import { Legend, MiniGua, yaoTitle } from './parts'

/** 爻题 / 小六爻图口径见 parts（与 TsToss 摇卦台共用） */

/** 去「键：」前缀 + 取 `（…）` 前名称（错卦 / 综卦 段复用） */
function segName(seg: string): string {
  const body = seg.replace(/^[^：:]{1,4}[：:]\s*/u, '')
  const i = body.search(/[（(]/u)
  return (i >= 0 ? body.slice(0, i) : body).trim()
}

/** 小六爻图见 parts.MiniGua（错·综预览与摇卦台共用） */

export function GuaBoard({ model, onOpenToss }: { model: GuaModel; onOpenToss?: () => void }): React.JSX.Element {
  const firstDong = model.yao.find((y) => y.dong)
  const [sel, setSel] = React.useState<number>(firstDong ? firstDong.pos : 1)
  const [theater, setTheater] = React.useState(false)
  const [cuoZong, setCuoZong] = React.useState<'cuo' | 'zong' | null>(null)
  const [replay, setReplay] = React.useState<number | null>(null)
  const [running, setRunning] = React.useState(false)
  const timer = React.useRef<number | null>(null)

  const detailVal = (label: string): string => model.detail.find((d) => d.label === label)?.value ?? ''
  const selYao = model.yao[sel - 1]!
  const hasDong = model.yao.some((y) => y.dong)
  const posLabel = (y: GuaYao): string => yaoTitle(y)

  const cuoZongNames = (() => {
    const segs = detailVal('错卦')
      .split('｜')
      .map((s) => s.trim())
      .filter(Boolean)
    return { cuo: segs[0] ? segName(segs[0]) : '', zong: segs[1] ? segName(segs[1]) : '' }
  })()
  const miniOf = (kind: 'cuo' | 'zong'): Array<{ yin: boolean }> =>
    kind === 'cuo' ? model.yao.map((y) => ({ yin: !y.yin })) : [...model.yao].reverse().map((y) => ({ yin: y.yin }))

  const stopReplay = React.useCallback((): void => {
    if (timer.current !== null) {
      window.clearInterval(timer.current)
      timer.current = null
    }
    setRunning(false)
  }, [])
  React.useEffect(() => () => stopReplay(), [stopReplay])

  const startReplay = (): void => {
    stopReplay()
    let reduced = false
    try {
      reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      reduced = false
    }
    if (reduced) {
      setReplay(6)
      return
    }
    setReplay(0)
    setRunning(true)
    timer.current = window.setInterval(() => {
      setReplay((v) => {
        const next = (v ?? 0) + 1
        if (next >= 6) {
          stopReplay()
          return 6
        }
        return next
      })
    }, 300)
  }

  const toggleReplay = (): void => {
    if (running) stopReplay()
    else startReplay()
  }

  const showBian = (y: GuaYao): boolean => y.bian !== undefined && (theater || sel === y.pos)

  return (
    <div className="pn-board pn-gua">
      <div className="pn-gua-title">
        {model.ben}
        {model.bianName ? <span className="pn-gua-arrow"> → {model.bianName}</span> : null}
      </div>

      <div className="pn-gua-top">
        <div className="pn-yao-col" role="group" aria-label="六爻（↑↓ 切换，Enter 选中）">
          {[...model.yao].reverse().map((y) => (
            <button
              type="button"
              key={y.pos}
              data-pos={y.pos}
              className={`pn-yao${y.yin ? ' is-yin' : ' is-yang'}${y.shiYing === '世' ? ' is-shi' : ''}${
                y.shiYing === '应' ? ' is-ying' : ''
              }${y.dong ? ' is-dong' : ''}${y.kong ? ' is-kong' : ''}${sel === y.pos ? ' is-on' : ''}${
                replay !== null && y.pos <= replay ? ' is-lit' : ''
              }${replay !== null && y.pos > replay ? ' is-unlit' : ''}`}
              aria-pressed={sel === y.pos}
              aria-label={`${posLabel(y)}${y.shiYing ? `（${y.shiYing}）` : ''}${y.dong ? ' 动爻' : ''}${y.kong ? ' 空亡' : ''}`}
              onClick={() => setSel(y.pos)}
            >
              <span className="pn-yao-title">{posLabel(y)}</span>
              <span className="pn-yao-line" aria-hidden="true">
                {y.yin ? (
                  <>
                    <span className="pn-yao-seg" />
                    <span className="pn-yao-gap" />
                    <span className="pn-yao-seg" />
                  </>
                ) : (
                  <span className="pn-yao-seg is-full" />
                )}
              </span>
              <span className="pn-yao-marks">
                {y.shiYing ? (
                  <span className="pn-mark" aria-hidden="true" data-text={y.shiYing}>
                    {y.shiYing === '世' ? '●' : '○'}
                  </span>
                ) : null}
                {y.dong ? (
                  <span className="pn-mark" aria-hidden="true" data-text="动">
                    ▲
                  </span>
                ) : null}
                {y.kong ? (
                  <span className="pn-mark pn-mark-kong" aria-hidden="true">
                    空亡
                  </span>
                ) : null}
              </span>
              {model.digits ? <span className="pn-yao-digit">{model.digits[y.pos - 1]}</span> : null}
              <span className="pn-yao-badge">
                {y.liuShen} · {y.liuQin}
              </span>
              {showBian(y) ? (
                <span className="pn-yao-bian">
                  变 {y.bian!.ganZhi} {y.bian!.wuXing} {y.bian!.liuQin}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        <div className="pn-gua-side">
          <div className="pn-detail pn-yao-detail" role="region" aria-label="爻详情">
            <span className="pn-detail-strong">
              {posLabel(selYao)}
              {selYao.dong ? ' · 动爻' : selYao.shiYing ? ` · ${selYao.shiYing}爻` : ' · 静爻'}
            </span>
            <span>
              六神 {selYao.liuShen} · 六亲 {selYao.liuQin}
            </span>
            <span>
              干支 {selYao.ganZhi} · 五行 {selYao.wuXing}
            </span>
            {selYao.kong ? <span>空亡</span> : null}
            {selYao.bian ? (
              <span className="pn-detail-bian">
                变：{selYao.bian.ganZhi} {selYao.bian.wuXing} {selYao.bian.liuQin}
              </span>
            ) : null}
          </div>

          <div className="pn-gua-actions">
            {onOpenToss ? (
              <button type="button" className="pn-act pn-act-toss" onClick={onOpenToss}>
                亲手摇卦
              </button>
            ) : null}
            <button type="button" className="pn-act" aria-pressed={running} onClick={toggleReplay}>
              {running ? '停止重放' : '重放装卦'}
            </button>
            <button
              type="button"
              className="pn-act"
              aria-pressed={theater}
              disabled={!hasDong}
              title={hasDong ? undefined : '无动爻'}
              onClick={() => setTheater((v) => !v)}
            >
              变卦剧场
            </button>
            <button
              type="button"
              className="pn-act"
              aria-pressed={cuoZong === 'cuo'}
              aria-expanded={cuoZong === 'cuo'}
              onClick={() => setCuoZong(cuoZong === 'cuo' ? null : 'cuo')}
            >
              错卦
            </button>
            <button
              type="button"
              className="pn-act"
              aria-pressed={cuoZong === 'zong'}
              aria-expanded={cuoZong === 'zong'}
              onClick={() => setCuoZong(cuoZong === 'zong' ? null : 'zong')}
            >
              综卦
            </button>
            {!hasDong ? <span className="pn-gua-nodong">无动爻</span> : null}
          </div>

          {cuoZong ? (
            <div className="pn-pop" role="region" aria-label={cuoZong === 'cuo' ? '错卦预览' : '综卦预览'}>
              <div className="pn-pop-title">
                {cuoZong === 'cuo' ? '错卦' : '综卦'} {cuoZong === 'cuo' ? cuoZongNames.cuo : cuoZongNames.zong}
              </div>
              <MiniGua yao={miniOf(cuoZong)} />
              <div className="pn-pop-note">{cuoZong === 'cuo' ? '六爻全变' : '六爻颠倒'}</div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="pn-gua-meta">
        {['起卦', '卦体', '动爻'].map((l) =>
          detailVal(l) ? (
            <span key={l} className="pn-gua-meta-item">
              {l}：{detailVal(l)}
            </span>
          ) : null,
        )}
      </div>

      <div className="pn-foot">
        <Legend
          ariaLabel="卦盘图例"
          items={[
            '世 / 应 文字角标',
            '动 = 动爻',
            '空亡 = 虚线框',
            `本卦 ${model.ben}${model.bianName ? ` → 变卦 ${model.bianName}` : ''}`,
          ]}
        />
      </div>
    </div>
  )
}
