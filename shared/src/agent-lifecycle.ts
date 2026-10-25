/**
 * 已下线资产清单（直接删除：无退役目录、无软删除备份）。
 *
 * 唯一用途是历史兼容：识别「编制中含下线角色」的历史会话与仪式订阅，
 * 仅允许读取历史消息与交付件，并阻止继续发送 / 派发 / 重试 / 后台触发。
 * 不进入有效资产清单、不计数、不提供启用入口，也不参与路由目录与工具权限。
 */
import { baseAgentId } from './members.js'

export interface RetiredScene {
  id: string
  name: string
  agents: readonly string[]
}

/** 已下线场景（id / 展示名用于历史会话提示，不再作为可加载资产出现） */
export const RETIRED_SCENES: readonly RetiredScene[] = [
  { id: 'housing', name: '置业安家', agents: ['home-finder', 'mortgage-advisor', 'reno-designer'] },
  { id: 'care', name: '家庭照护', agents: ['care-escort', 'care-planner', 'elder-advisor'] },
  { id: 'trpg', name: '跑团工坊', agents: ['gm-host', 'npc-player', 'rule-keeper', 'scenario-writer'] },
  { id: 'home', name: '家庭生活', agents: ['chef', 'home', 'parenting', 'pet'] },
  { id: 'wealth', name: '财富管理', agents: ['big-ticket-advisor', 'insurance-planner', 'wealth'] },
  { id: 'legal-personal', name: '个人法务', agents: ['contract-checker', 'labor-advisor', 'rights-advisor'] },
  { id: 'sales', name: '销售客户', agents: ['bd', 'sales', 'success', 'support'] },
]

export const RETIRED_AGENT_IDS: ReadonlySet<string> = new Set(RETIRED_SCENES.flatMap((scene) => scene.agents))

/** 已下线预设（id 保留在历史记录中，不再出现在预设清单） */
export const RETIRED_PRESET_IDS: readonly string[] = [
  'home-purchase',
  'care-plan',
  'trpg-oneshot',
  'home-week',
  'wealth-checkup',
  'rights-check',
  'sales-sprint',
]

/** 历史会话只读的统一说明（HTTP 409 / 前端锁定 / 引擎异常共用同一措辞） */
export const RETIRED_SESSION_HINT = '该会话包含已下线的角色，仅可查看历史内容，不能继续发送或派发；请新建会话重新组队。'

const SCENE_OF_AGENT = new Map<string, string>(
  RETIRED_SCENES.flatMap((scene) => scene.agents.map((agent) => [agent, scene.name] as const)),
)

/** 角色（含分身成员键）是否已下线 */
export function isRetiredAgentId(agentId: string): boolean {
  return RETIRED_AGENT_IDS.has(baseAgentId(agentId))
}

/** 编制中的下线成员键（去重；空数组 = 可正常执行） */
export function retiredMembersOf(participantIds: readonly string[]): string[] {
  return [...new Set(participantIds.filter((key) => isRetiredAgentId(key)))]
}

/** 编制涉及的下线场景展示名（提示文案；空数组 = 可正常执行） */
export function retiredScenesOf(participantIds: readonly string[]): string[] {
  const names = new Set<string>()
  for (const key of participantIds) {
    const scene = SCENE_OF_AGENT.get(baseAgentId(key))
    if (scene) names.add(scene)
  }
  return [...names]
}
