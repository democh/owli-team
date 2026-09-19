/**
 * 角色、场景与技能元数据：启动加载一次；运行状态表由 SSE / WS 共同驱动（§19.4 五态）。
 */
import { create } from 'zustand'
import type { AgentDefinition, AgentGroup, AgentRunState, RosterPreset, SkillMeta } from '@multi-agent/shared'
import { apiGet } from '../lib/api'

interface AgentState {
  agents: AgentDefinition[]
  /** M16：场景（分组）元数据（agents/<场景>/_group.yaml） */
  groups: AgentGroup[]
  /** M21：快速组队预设（agents/_presets.yaml；为空数组时建会话对话框隐藏该区块） */
  presets: RosterPreset[]
  skills: SkillMeta[]
  loaded: boolean
  loading: boolean
  /** agentId → 五态 */
  statuses: Record<string, AgentRunState>
  load: () => Promise<void>
  /** M26：强制重拉（绕过 loaded 守卫；资产控制台写盘 / notify:assets-changed 后调用） */
  reload: () => Promise<void>
  setStatus: (agentId: string, status: AgentRunState) => void
  resetStatuses: () => void
}

async function fetchAll(): Promise<{
  agents: AgentDefinition[]
  groups: AgentGroup[]
  presets: RosterPreset[]
  skills: SkillMeta[]
}> {
  const [agentsRes, skillsRes] = await Promise.all([
    apiGet<{ agents: AgentDefinition[]; groups?: AgentGroup[]; presets?: RosterPreset[] }>('/api/agents'),
    apiGet<{ skills: SkillMeta[] }>('/api/skills'),
  ])
  return {
    agents: agentsRes.agents,
    groups: agentsRes.groups ?? [],
    presets: agentsRes.presets ?? [],
    skills: skillsRes.skills,
  }
}

export const useAgentStore = create<AgentState>((set, get) => ({
  agents: [],
  groups: [],
  presets: [],
  skills: [],
  loaded: false,
  loading: false,
  statuses: {},

  load: async () => {
    if (get().loaded || get().loading) return
    set({ loading: true })
    try {
      set({ ...(await fetchAll()), loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  reload: async () => {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ ...(await fetchAll()), loaded: true })
    } finally {
      set({ loading: false })
    }
  },

  setStatus: (agentId, status) => set((s) => ({ statuses: { ...s.statuses, [agentId]: status } })),

  resetStatuses: () => set({ statuses: {} }),
}))

/** 便捷 selector：按 id 取角色定义 */
export function useAgent(agentId?: string): AgentDefinition | undefined {
  return useAgentStore((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined))
}

/** 便捷 selector：按 id 取场景元数据 */
export function useGroup(groupId?: string): AgentGroup | undefined {
  return useAgentStore((s) => (groupId ? s.groups.find((g) => g.id === groupId) : undefined))
}
