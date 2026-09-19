/**
 * M54-A t5：紫微 · 十二宫巡游（§4.3）——4×4 固定格位 / 三方四正 / 大限巡游 / 四化定位。
 *
 * 格位纪律（§A.6-2）：一律按 label 干支的地支映射（CELL 表），禁止按条目序摆放；
 * 三方四正 = 三合（地支 ±4，2 宫）+ 对宫（±6，1 宫）；键盘 = 4×4 方向键 + Enter。
 */
import * as React from 'react'
import type { ZiweiModel } from './model'
import { AskBar, Legend, MuChip, type MuTone } from './parts'

/** 地支 → 4×4 格位（行 / 列；中宫 = 2-3 行 × 2-3 列） */
const CELL: Record<string, [number, number]> = {
  巳: [1, 1], 午: [1, 2], 未: [1, 3], 申: [1, 4],
  辰: [2, 1], 酉: [2, 4],
  卯: [3, 1], 戌: [3, 4],
  寅: [4, 1], 丑: [4, 2], 子: [4, 3], 亥: [4, 4],
}

const ZHI_LIST = '子丑寅卯辰巳午未申酉戌亥'

/** 三方四正：三合（±4）+ 对宫（+6） */
function relBranches(zhi: string): string[] {
  const n = ZHI_LIST.indexOf(zhi)
  if (n < 0) return []
  return [(n + 4) % 12, (n + 8) % 12, (n + 6) % 12].map((i) => ZHI_LIST[i]!)
}

/** 方向键步进（跳过中宫空格，边界 / 无落点 → null） */
function stepBranch(zhi: string, dr: number, dc: number): string | null {
  const cur = CELL[zhi]
  if (!cur) return null
  let [r, c] = cur
  for (;;) {
    r += dr
    c += dc
    if (r < 1 || r > 4 || c < 1 || c > 4) return null
    const hit = Object.keys(CELL).find((b) => CELL[b]![0] === r && CELL[b]![1] === c)
    if (hit) return hit
  }
}

const DIRS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
}

export function ZiweiBoard({
  model,
  onAsk,
  onPalace,
}: {
  model: ZiweiModel
  onAsk?: (text: string) => void
  /** 点宫事件（外壳记研习足迹用；取消选中不触发） */
  onPalace?: (zhi: string) => void
}): React.JSX.Element {
  const [sel, setSel] = React.useState<string | null>(null)
  const [xun, setXun] = React.useState<number | null>(null)
  const [mu, setMu] = React.useState<MuTone | null>(null)
  const refs = React.useRef(new Map<string, HTMLButtonElement | null>())

  const byBranch = new Map(model.palaces.map((p) => [p.zhi, p]))
  // 大限巡游序：按年龄起点排序（盘内大限即年龄序，此处防御性重排）
  const cycle = [...model.palaces].sort((a, b) => (a.daXian?.range[0] ?? 999) - (b.daXian?.range[0] ?? 999))
  const curIdx = cycle.findIndex((p) => p.daXian?.current)
  const xunIdx = xun ?? curIdx
  const xunPalace = xunIdx >= 0 ? cycle[xunIdx]! : null
  const selPalace = sel ? byBranch.get(sel) ?? null : null
  const relSet = sel ? new Set(relBranches(sel)) : null
  const muPair = mu ? model.center.siHua.find((h) => h.mutagen === mu) ?? null : null
  const muBranches = new Set(
    mu
      ? model.palaces
          .filter((p) =>
            p.stars.some((s) => (muPair ? s.name === muPair.star && s.mutagen === mu : s.mutagen === mu)),
          )
          .map((p) => p.zhi)
      : [],
  )

  const onCellKey = (zhi: string) => (e: React.KeyboardEvent): void => {
    const d = DIRS[e.key]
    if (!d) return
    e.preventDefault()
    const target = stepBranch(zhi, d[0], d[1])
    if (target) refs.current.get(target)?.focus()
  }

  const askSel = (): void => {
    if (!selPalace) return
    const name = selPalace.name.replace(/宫$/u, '') || selPalace.name
    const range = selPalace.daXian ? `${selPalace.daXian.range[0]}-${selPalace.daXian.range[1]} ` : ''
    onAsk?.(`请重点解读${name}宫（${selPalace.gan}${selPalace.zhi}）主星与四化背景，以及 ${range}大限期间的课题与依据。`)
  }

  return (
    <div className="pn-board pn-ziwei">
      <div className="pn-ziwei-top">
        <div className="pn-ziwei-grid" role="grid" aria-label="十二宫（方向键移动，Enter 选中）">
          {model.palaces.map((p) => {
            const cls = ['pn-palace']
            if (sel === p.zhi) cls.push('is-on')
            else if (relSet?.has(p.zhi)) cls.push('is-rel')
            if (p.daXian?.current) cls.push('is-current')
            if (xun !== null && xunPalace?.zhi === p.zhi) cls.push('is-xun')
            if (muBranches.has(p.zhi)) cls.push('is-mu')
            return (
              <button
                type="button"
                key={p.zhi}
                ref={(el) => {
                  refs.current.set(p.zhi, el)
                }}
                className={cls.join(' ')}
                style={{ gridRow: CELL[p.zhi]![0], gridColumn: CELL[p.zhi]![1] }}
                data-branch={p.zhi}
                aria-pressed={sel === p.zhi}
                aria-label={`${p.name} ${p.gan}${p.zhi}，查看三方四正`}
                onClick={() => {
                  const next = sel === p.zhi ? null : p.zhi
                  setSel(next)
                  if (next !== null) onPalace?.(p.zhi)
                }}
                onKeyDown={onCellKey(p.zhi)}
              >
                <span className="pn-palace-head">
                  <span className="pn-palace-name">{p.name}</span>
                  {p.name === '命宫' ? (
                    <span className="pn-palace-tag">命</span>
                  ) : p.shenGong ? (
                    <span className="pn-palace-tag is-hollow">身</span>
                  ) : null}
                </span>
                <span className="pn-palace-gz">
                  {p.gan}
                  {p.zhi}
                </span>
                <span className="pn-palace-stars">
                  {p.stars.length === 0 ? (
                    <span className="pn-palace-empty">空宫</span>
                  ) : (
                    p.stars.map((s, i) => (
                      <span className="pn-star" key={i}>
                        {s.name}
                        {s.brightness ? <span className="pn-star-b">{s.brightness}</span> : null}
                        {s.mutagen ? <MuChip tone={s.mutagen} /> : null}
                      </span>
                    ))
                  )}
                </span>
                <span className="pn-palace-dx">{p.daXian ? `${p.daXian.range[0]}-${p.daXian.range[1]}` : ''}</span>
              </button>
            )
          })}

          <div className="pn-center" style={{ gridRow: '2 / 4', gridColumn: '2 / 4' }}>
            {model.center.wuXingJu || model.center.mingZhu ? (
              <div className="pn-center-line">
                {model.center.wuXingJu ?? ''}
                {model.center.mingZhu ? ` ｜ 命主 ${model.center.mingZhu}` : ''}
              </div>
            ) : null}
            {model.center.shenZhu || model.center.laiYin ? (
              <div className="pn-center-line">
                {model.center.shenZhu ? `身主 ${model.center.shenZhu}` : ''}
                {model.center.laiYin ? ` ｜ 来因宫 ${model.center.laiYin}` : ''}
              </div>
            ) : null}
            {model.center.siHua.length > 0 ? (
              <div className="pn-center-mu" role="group" aria-label="生年四化">
                {model.center.siHua.map((h) => (
                  <button
                    type="button"
                    key={h.mutagen}
                    className={`pn-mu-btn${mu === h.mutagen ? ' is-on' : ''}`}
                    aria-pressed={mu === h.mutagen}
                    onClick={() => setMu(mu === h.mutagen ? null : h.mutagen)}
                  >
                    <MuChip tone={h.mutagen} />
                    <span className="pn-mu-star">{h.star}</span>
                  </button>
                ))}
              </div>
            ) : null}
            {xunPalace ? (
              <div className="pn-center-xun">
                大限 {xunPalace.daXian?.range[0]}-{xunPalace.daXian?.range[1]} · {xunPalace.gan}
                {xunPalace.zhi} · {xunPalace.name}
              </div>
            ) : null}
            <div className="pn-center-step">
              <button type="button" onClick={() => setXun(Math.max(0, xunIdx - 1))} disabled={xunIdx <= 0}>
                ← 上一限
              </button>
              <button
                type="button"
                onClick={() => setXun(Math.min(cycle.length - 1, xunIdx + 1))}
                disabled={xunIdx >= cycle.length - 1}
              >
                下一限 →
              </button>
              {xun !== null ? (
                <button type="button" onClick={() => setXun(null)}>
                  回本限
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      <div className={`pn-detail${selPalace ? '' : ' is-empty'}`} role="region" aria-label="宫详情">
        {selPalace ? (
          <>
            <span className="pn-detail-strong">
              {selPalace.name} {selPalace.gan}
              {selPalace.zhi}
            </span>
            <span className="pn-detail-raw">{selPalace.raw}</span>
          </>
        ) : (
          <span>点选宫格 → 三方四正高亮与宫详情（再点取消）</span>
        )}
      </div>

      <div className="pn-foot">
        <AskBar items={selPalace ? [{ text: `请教${selPalace.name}`, onPick: askSel }] : []} />
        <Legend
          ariaLabel="紫微图例"
          items={[
            '命 ● / 身 ○ 角标',
            <>
              <span className="pn-dot-on" /> 当前大限
            </>,
            '三方四正 = 三合 + 对宫',
            <>
              四化 <MuChip tone="禄" />
              <MuChip tone="权" />
              <MuChip tone="科" />
              <MuChip tone="忌" />
            </>,
          ]}
        />
      </div>
    </div>
  )
}
