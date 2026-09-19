/**
 * M39（§97，ADR 0149）：场景阶段映射（渲染知识）——生产型场景的「角色 → 阶段名」常量表，
 * 供悬浮阶段条（DEV-1 / SR-1）与交付明细行阶段标签（DEV-2）消费。
 * - 落点口径（ADR 0069）：常量表集中在本文件（渲染知识），不进 `_group.yaml` 资产、不进服务端；
 *   新场景在表内扩展；未收录场景 → 映射函数返回 undefined，调用方回退波次数字 / 不渲染标签。
 */
import type { AgentDefinition } from '@multi-agent/shared'

export interface SceneStageMap {
  /** 阶段显示序（进度段分母；未入序的标签只显示、不计进度） */
  order: string[]
  /** 角色 id → 阶段名 */
  byRole: Record<string, string>
}

export const SCENE_STAGE_MAPS: Record<string, SceneStageMap> = {
  // development：交付流水线七段（pm → devops 主链；旁路角色折叠进相邻段）
  development: {
    order: ['需求', '架构', '设计', '前端', '后端', '测试', '部署'],
    byRole: {
      pm: '需求',
      architect: '架构',
      designer: '设计',
      'ux-researcher': '设计',
      'ux-writer': '设计',
      frontend: '前端',
      backend: '后端',
      'ai-engineer': '后端',
      'data-engineer': '后端',
      security: '安全',
      'tech-writer': '文档',
      qa: '测试',
      devops: '部署',
    },
  },
  // sre：事故处置五段（收尾波 → 复盘）
  sre: {
    order: ['分级止血', '回滚', '修复', '回归', '复盘'],
    byRole: {
      sre: '分级止血',
      devops: '回滚',
      backend: '修复',
      qa: '回归',
    },
  },
}

/** 取场景阶段表（未收录 → undefined） */
export function stageMapOf(groupId: string | undefined): SceneStageMap | undefined {
  return groupId ? SCENE_STAGE_MAPS[groupId] : undefined
}

/** 单个角色 → 阶段名（未收录场景 / 未映射角色 → undefined） */
export function stageOf(groupId: string | undefined, agentId: string | undefined): string | undefined {
  const map = stageMapOf(groupId)
  if (!map || !agentId) return undefined
  return map.byRole[agentId]
}

export interface WaveStage {
  /** 本波阶段名（多阶段并行时以「·」连接去重，按阶段序排列） */
  label: string
  /** 阶段进度（命中 order 时为 1 基序号；否则缺省——只显示标签不计进度） */
  index?: number
  total?: number
}

/**
 * 波次阶段判定：本波成员 → 阶段名集合（去重、按 order 排序）+ 进度段。
 * 本波所有成员均无映射 → undefined（调用方回退波次数字）。
 */
export function waveStage(groupId: string | undefined, agents: readonly Pick<AgentDefinition, 'id'>[]): WaveStage | undefined {
  const map = stageMapOf(groupId)
  if (!map) return undefined
  const labels: string[] = []
  for (const a of agents) {
    const label = map.byRole[a.id]
    if (label && !labels.includes(label)) labels.push(label)
  }
  if (labels.length === 0) return undefined
  labels.sort((a, b) => {
    const ia = map.order.indexOf(a)
    const ib = map.order.indexOf(b)
    return (ia < 0 ? Number.MAX_SAFE_INTEGER : ia) - (ib < 0 ? Number.MAX_SAFE_INTEGER : ib)
  })
  const idx = map.order.indexOf(labels[labels.length - 1]!)
  return {
    label: labels.join('·'),
    ...(idx >= 0 ? { index: idx + 1, total: map.order.length } : {}),
  }
}
