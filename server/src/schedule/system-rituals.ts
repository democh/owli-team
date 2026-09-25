/**
 * P5：系统内置仪式（不依赖场景 `_group.yaml` 声明；订阅通道与场景仪式共用）。
 *
 * - 「每日复盘」：工作日 21:00 自动开一场复盘会话——编制 = 场景 chain（coach → life-admin），
 *   opener 对齐 P5「晚间复盘」愿景（状态感知链路可由全局记忆 + elevate 承接）；
 * - 订阅归属去重键 = ritual_id（与场景声明的 scene_id 键独立，同场景可并存两类订阅）；
 * - 新增系统仪式只需在本表追加（服务端单一事实源；前端经 /api/rituals 投影感知）。
 */
import type { RitualDeclaration } from '@multi-agent/shared'

export interface SystemRitual {
  /** 系统仪式 id（订阅去重键；与场景 id 命名空间独立） */
  id: string
  /** 归属场景（建会话编制 = 该场景 chain；会话列表按此归类展示） */
  sceneId: string
  declaration: RitualDeclaration
}

export const SYSTEM_RITUALS: SystemRitual[] = [
  {
    id: 'morning-brief',
    sceneId: 'ops',
    declaration: {
      title: '晨间安排',
      cron: '0 8 * * 1-5',
      opener: '生成今日安排：汇总日程与待办（可用 web_search 时补今日天气），给出今天的时间线建议。',
      members: ['assistant', 'wellness'],
      description: '工作日 08:00 生成今日安排卡',
    },
  },
  {
    id: 'daily-review',
    sceneId: 'personal',
    declaration: {
      title: '每日复盘',
      cron: '0 21 * * 1-5',
      opener: '复盘今天：完成了什么、卡在哪、明天最重要的三件事。',
      description: '工作日 21:00 自动开一场复盘会话',
    },
  },
]

export function findSystemRitual(id: string): SystemRitual | undefined {
  return SYSTEM_RITUALS.find((r) => r.id === id)
}
