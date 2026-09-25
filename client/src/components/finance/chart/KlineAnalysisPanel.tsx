/**
 * K 线分析面板（M83 §5.1）：纯展示组件（props.analysis = 服务端分析引擎结论）。
 *
 * - 阶段分析卡：阶段徽章 + 置信度条 + 描述 + 起始日（+ 阶段色带开关联动回调）；
 * - 市场情绪周期：分数 + 档位 + 路径；
 * - 支撑 / 压力 / 量度目标：三数字行（含出处与触碰次数口径）；
 * - 底部特征 chips（confirmed=false 为近似口径 → 描边样式）；
 * - 历史阶段条：逐根阶段合并为连续段色块时间轴 + 首尾日期；
 * - 口径声明行（notes）不可省；面板可折叠（偏好 localStorage 记忆）。
 */
import * as React from 'react'
import { ChevronDown, Sparkles } from 'lucide-react'
import type { KlineAnalysis, KlinePhase } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { PHASE_CN, PHASE_COLORS, SENTIMENT_CN } from './phaseColors'

const COLLAPSE_KEY = 'ma:kline:analysis-collapsed'

function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

function writeCollapsed(v: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
  } catch {
    // 隐私模式 / 存储满：忽略
  }
}

function fmtPrice(v: number | null | undefined): string {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '—'
}

/** 连续同相合并（历史阶段条渲染用；减少 DOM 节点） */
function mergeBands(bands: Array<{ ts: number; phase: KlinePhase }>): Array<{ phase: KlinePhase; from: number; to: number; count: number }> {
  const out: Array<{ phase: KlinePhase; from: number; to: number; count: number }> = []
  for (const b of bands) {
    const last = out[out.length - 1]
    if (last && last.phase === b.phase) {
      last.to = b.ts
      last.count += 1
    } else {
      out.push({ phase: b.phase, from: b.ts, to: b.ts, count: 1 })
    }
  }
  return out
}

function dateOf(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n))
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function KlineAnalysisPanel({
  analysis,
  onTogglePhases,
  className,
}: {
  analysis: KlineAnalysis
  /** 「阶段」色带开关（纯信号；显隐状态由宿主持有并回传 KlineCanvas.showPhases） */
  onTogglePhases?: () => void
  className?: string
}): React.JSX.Element {
  const [collapsed, setCollapsed] = React.useState<boolean>(() => readCollapsed())
  const toggle = (): void => {
    setCollapsed((v) => {
      writeCollapsed(!v)
      return !v
    })
  }

  const phase = analysis.phases.current
  const color = PHASE_COLORS[phase]
  const segments = React.useMemo(() => mergeBands(analysis.phases.bands), [analysis.phases.bands])
  const firstDate = analysis.phases.bands.length > 0 ? dateOf(analysis.phases.bands[0].ts) : ''
  const lastDate = analysis.phases.bands.length > 0 ? dateOf(analysis.phases.bands[analysis.phases.bands.length - 1].ts) : ''

  return (
    <section className={cn('md-kline-analysis', className)} data-collapsed={collapsed}>
      <header className="md-kline-analysis-head">
        <Sparkles className="size-3.5 shrink-0" style={{ color }} />
        <span className="md-kline-analysis-title">阶段分析</span>
        <span className="md-kline-phase-badge" style={{ backgroundColor: color }}>
          {PHASE_CN[phase]}
        </span>
        <span className="md-kline-analysis-confidence">
          置信度 {analysis.phases.confidence}
          <span className="md-kline-confidence-track">
            <span className="md-kline-confidence-fill" style={{ width: `${Math.max(0, Math.min(100, analysis.phases.confidence))}%`, backgroundColor: color }} />
          </span>
        </span>
        {onTogglePhases && (
          <button type="button" className="md-kline-chip" title="阶段色带显隐" onClick={() => onTogglePhases()}>
            色带
          </button>
        )}
        <span className="md-kline-toolbar-spacer" />
        <button type="button" className="md-kline-chip" onClick={toggle} title={collapsed ? '展开分析' : '收起分析'}>
          <ChevronDown className={cn('size-3 transition-transform', collapsed && '-rotate-90')} />
        </button>
      </header>

      {!collapsed && (
        <div className="md-kline-analysis-body">
          <p className="md-kline-analysis-desc">
            {analysis.phases.description}
            {analysis.phases.since ? <span className="md-kline-analysis-meta">（自 {analysis.phases.since} 起）</span> : null}
          </p>

          <div className="md-kline-analysis-row">
            <span className="md-kline-analysis-label">市场情绪</span>
            <span className="md-kline-analysis-value">
              <b>{SENTIMENT_CN[analysis.sentiment.stage] ?? analysis.sentiment.stage}</b> {analysis.sentiment.score}/100
            </span>
            <span className="md-kline-analysis-meta">{analysis.sentiment.pathLabel}</span>
          </div>

          <div className="md-kline-analysis-row">
            <span className="md-kline-analysis-label">关键位</span>
            <span className="md-kline-analysis-value">
              支撑 <b>{fmtPrice(analysis.levels.support?.price)}</b>
              {analysis.levels.support ? <span className="md-kline-analysis-meta">（{analysis.levels.support.basis} · 触碰 {analysis.levels.support.touches} 次）</span> : null}
              <span className="md-kline-analysis-sep">｜</span>
              压力 <b>{fmtPrice(analysis.levels.resistance?.price)}</b>
              {analysis.levels.resistance ? <span className="md-kline-analysis-meta">（{analysis.levels.resistance.basis} · 触碰 {analysis.levels.resistance.touches} 次）</span> : null}
              <span className="md-kline-analysis-sep">｜</span>
              量度目标 <b>{fmtPrice(analysis.levels.target?.price)}</b>
              {analysis.levels.target ? <span className="md-kline-analysis-meta">（{analysis.levels.target.basis}）</span> : null}
            </span>
          </div>

          {analysis.features.length > 0 && (
            <div className="md-kline-analysis-row">
              <span className="md-kline-analysis-label">特征</span>
              <span className="md-kline-feature-chips">
                {analysis.features.map((f) => (
                  <span key={f.key} className={cn('md-kline-feature-chip', !f.confirmed && 'is-approx')} title={f.confirmed ? '已确认' : '近似口径'}>
                    {f.label}
                  </span>
                ))}
              </span>
            </div>
          )}

          {segments.length > 0 && (
            <div className="md-kline-analysis-row">
              <span className="md-kline-analysis-label">历史阶段</span>
              <span className="md-kline-phase-strip" title={`近 ${analysis.phases.bands.length} 根`}>
                {segments.map((s, i) => (
                  <span
                    key={`${s.from}-${i}`}
                    className="md-kline-phase-seg"
                    style={{ backgroundColor: PHASE_COLORS[s.phase], flexGrow: s.count }}
                    title={`${PHASE_CN[s.phase]}（${dateOf(s.from)} → ${dateOf(s.to)}）`}
                  />
                ))}
              </span>
              <span className="md-kline-analysis-meta">
                {firstDate} → {lastDate}
              </span>
            </div>
          )}

          {analysis.notes.length > 0 && <p className="md-kline-analysis-notes">{analysis.notes.join('；')}</p>}
        </div>
      )}
    </section>
  )
}
