/**
 * M83 批 C：分析面板渲染测试（纯展示组件；无 klinecharts 依赖）。
 * 覆盖：阶段徽章 / 置信度 / 情绪 / 关键位 / 特征 chips / 历史阶段条 / 口径声明 / 折叠 / 色带开关回调。
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { KlineAnalysis } from '@multi-agent/shared'
import { KlineAnalysisPanel } from '../src/components/finance/chart/KlineAnalysisPanel'

const ANALYSIS: KlineAnalysis = {
  asOf: '2026-09-25T00:00:00.000Z',
  bars: 4,
  period: 'day',
  adjust: 'qfq',
  phases: {
    current: 'accumulation',
    confidence: 62,
    since: '2026-09-01',
    description: '低位缩量横盘、筹码集中，主力吸筹特征',
    bands: [
      { ts: 1757952000000, phase: 'markdown' },
      { ts: 1758038400000, phase: 'markdown' },
      { ts: 1758124800000, phase: 'accumulation' },
      { ts: 1758211200000, phase: 'accumulation' },
    ],
  },
  sentiment: { score: 42, stage: 'hesitate', pathLabel: '恐慌→犹豫→修复→乐观→狂热（当前：犹豫）' },
  levels: {
    support: { price: 1442, basis: '前低', touches: 3 },
    resistance: { price: 1520.5, basis: '密集区', touches: 2 },
    target: { price: 1600, basis: '箱体量度' },
  },
  features: [
    { key: 'platform', label: '平台整理', confirmed: true },
    { key: 'chip-concentration', label: '筹码集中', confirmed: false },
  ],
  drawings: [],
  notes: ['阶段判定为规则化统计口径，仅供复盘研究', '市场情绪为多因子加权（0-100），不构成涨跌预测'],
}

describe('M83 分析面板', () => {
  it('阶段卡 / 情绪 / 关键位 / 特征 / 口径声明齐备', () => {
    const { container } = render(<KlineAnalysisPanel analysis={ANALYSIS} />)
    expect(screen.getByText('阶段分析')).toBeInTheDocument()
    expect(screen.getByText('吸筹')).toBeInTheDocument()
    expect(screen.getByText(/置信度 62/)).toBeInTheDocument()
    expect(screen.getByText(/低位缩量横盘/)).toBeInTheDocument()
    expect(screen.getByText(/自 2026-09-01 起/)).toBeInTheDocument()
    expect(screen.getByText('犹豫')).toBeInTheDocument()
    expect(screen.getByText(/当前：犹豫/)).toBeInTheDocument()
    // 关键位（支撑 / 压力 / 量度目标 数值与口径）
    expect(container.textContent).toContain('1442')
    expect(container.textContent).toContain('密集区')
    expect(container.textContent).toContain('1600')
    expect(container.textContent).toContain('箱体量度')
    // 特征 chips：confirmed=false 走近似样式
    expect(screen.getByText('平台整理')).toBeInTheDocument()
    const approx = screen.getByText('筹码集中')
    expect(approx.className).toContain('is-approx')
    // 历史阶段条：连续同相合并（markdown×2 + accumulation×2 → 2 段）
    expect(container.querySelectorAll('.md-kline-phase-seg')).toHaveLength(2)
    // 口径声明
    expect(container.textContent).toContain('规则化统计口径')
  })

  it('折叠切换：收起后正文不渲染，再展开恢复', () => {
    const { container } = render(<KlineAnalysisPanel analysis={ANALYSIS} />)
    const collapse = screen.getByTitle('收起分析')
    fireEvent.click(collapse)
    expect(container.querySelector('.md-kline-analysis')?.getAttribute('data-collapsed')).toBe('true')
    expect(container.querySelector('.md-kline-analysis-body')).toBeNull()
    fireEvent.click(screen.getByTitle('展开分析'))
    expect(container.querySelector('.md-kline-analysis-body')).not.toBeNull()
  })

  it('色带开关回调（宿主回传 showPhases 用）', () => {
    const onToggle = vi.fn()
    render(<KlineAnalysisPanel analysis={ANALYSIS} onTogglePhases={onToggle} />)
    fireEvent.click(screen.getByTitle('阶段色带显隐'))
    expect(onToggle).toHaveBeenCalledTimes(1)
  })
})
