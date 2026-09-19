/**
 * M58：面板就绪判定（纯函数）——「无数据不展示」口径的单一事实来源。
 * 未就绪 = 宿主不渲染工作区（dock 右区 / roundtable 汇聚板），有内容后自动出现（挂载即带真实数据）；
 * 判定与各面板空态分支逐一对应（空态分支保留作组件级兜底）；口径「宁可多显示不可漏显示」——
 * 判 true 时面板最多渲染空态，判 false 才隐藏。
 */
import type { ChatMessage, StagePanel } from '@multi-agent/shared'
import { claimMetaOf } from '../../lib/pk'
import { artifactsOf, headingsOf, panRowsOf, type SceneContainer, type SceneVerdict } from './derive'

/** 识别为管道看板的容器名（与 ConsolePanel.KANBAN_NAMES 同口径） */
const KANBAN_NAMES = new Set(['kanban', 'pipe', 'board'])

export interface PanelReadyData {
  containers: SceneContainer[]
  verdicts: SceneVerdict[]
  messages: ChatMessage[]
}

/** 容器是否有结构化行（条目 / 字段）——PoolPanel 卡 total 与 ConsolePanel 列 cards 同口径 */
function hasRows(c: SceneContainer): boolean {
  const { fields, items } = panRowsOf(c.lines)
  return items.length + fields.length > 0
}

export function panelReady(panel: StagePanel, data: PanelReadyData): boolean {
  switch (panel) {
    case 'chartboard':
      // ChartboardPanel：有 `::: pan` 盘面容器 或 `::: cards` 牌阵容器（M69 塔罗牌阵台）
      return data.containers.some((c) => c.name === 'pan' || c.name === 'cards')
    case 'pool':
      // PoolPanel：存在「有结构化行或带标题」的容器卡
      return data.containers.some((c) => hasRows(c) || c.arg !== '')
    case 'versus':
      // VersusPanel：有 `::: verdict` 裁决实例；M63 扩展——带「视角」字段的 claim（四路观点卡）
      // 或 ```game 围栏（博弈走子板）亦视为就绪（面板段有数据即可展示）
      return (
        data.verdicts.length > 0 ||
        data.containers.some((c) => c.name === 'claim' && claimMetaOf(c.lines).perspective !== undefined) ||
        data.messages.some((m) => m.content.includes('```game'))
      )
    case 'board':
      // BoardPanel：成员消息带 Markdown 标题（目录树）或存在交付件
      return (
        data.messages.some((m) => m.role === 'agent' && headingsOf(m.content).length > 0) ||
        artifactsOf(data.messages).length > 0
      )
    case 'console':
      // ConsolePanel：有成员消息（活动时间轴）/ 管道列 / 交付件，任一非空即就绪
      return (
        data.messages.some((m) => m.role === 'agent' && m.agentId) ||
        data.containers.some((c) => KANBAN_NAMES.has(c.name) && hasRows(c)) ||
        artifactsOf(data.messages).length > 0
      )
    case 'coach':
      // CoachPanel：有 `::: checklist` 清单容器
      return data.containers.some((c) => c.name === 'checklist')
    case 'studio':
      // StudioPanel（M65-A/B）：有 `::: layout` 容器（方案已声明）或 .scene.json 交付件（§7.1）
      return (
        data.containers.some((c) => c.name === 'layout') ||
        artifactsOf(data.messages).some((p) => p.endsWith('.scene.json'))
      )
  }
}
