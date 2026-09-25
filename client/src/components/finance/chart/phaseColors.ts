/**
 * 阶段配色与中文名（M83 §5.1）：阶段色带 overlay / 分析面板 / 历史阶段条共享。
 * key 与 shared `KlinePhase`（服务端分析引擎输出）一一对应，缺一即类型错误。
 */
import type { KlinePhase } from '@multi-agent/shared'

export const PHASE_COLORS: Record<KlinePhase, string> = {
  accumulation: '#38bdf8',
  bottoming: '#2dd4bf',
  wash: '#fbbf24',
  markup: '#f87171',
  climax: '#fb923c',
  distribution: '#86efac',
  markdown: '#34d399',
  panic: '#047857',
  rebound: '#c084fc',
  range: '#a1a1aa',
}

export const PHASE_CN: Record<KlinePhase, string> = {
  accumulation: '吸筹',
  bottoming: '筑底',
  wash: '洗盘',
  markup: '拉升',
  climax: '主升',
  distribution: '派发',
  markdown: '下跌',
  panic: '恐慌',
  rebound: '反弹',
  range: '震荡',
}

/** 情绪档位中文（分析面板展示） */
export const SENTIMENT_CN: Record<string, string> = {
  panic: '恐慌',
  hesitate: '犹豫',
  repair: '修复',
  optimistic: '乐观',
  euphoric: '狂热',
}
