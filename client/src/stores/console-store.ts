/**
 * M26：资产控制台数据层（Agent / Skill / 场景 / 工具清单 / 校验聚合）。
 * - 变更动作全部走 /api/console；写盘成功后服务端会广播 notify:assets-changed，
 *   本标签页自身 + 其它标签页都经 refreshAll() 重拉（幂等 GET，双保险）；
 * - refreshAll 同时强制刷新 agent-store，建会话成员选择器 / 团队面板立即反映；
 * - 删除冲突（409 + 引用清单）以 ApiError.refs 上抛，由 UI 二次确认后 force=true 重试。
 */
import { create } from 'zustand'
import type {
  AgentCreateInput,
  AgentDraftPayload,
  AgentGroup,
  AgentWriteInput,
  ConsoleAgentDetail,
  ConsoleAgentSummary,
  ConsoleSkillDetail,
  ConsoleSkillSummary,
  ConsoleToolInfo,
  GenerateDraftResult,
  GroupWriteInput,
  SkillDraftPayload,
  SkillWriteInput,
  SoulWriteInput,
  ValidationIssue,
} from '@multi-agent/shared'
import { apiDelete, apiGet, apiPost, apiPut } from '../lib/api'
import { useAgentStore } from './agent-store'

interface ConsoleState {
  agents: ConsoleAgentSummary[]
  skills: ConsoleSkillSummary[]
  groups: AgentGroup[]
  tools: ConsoleToolInfo[]
  issues: ValidationIssue[]
  loading: boolean
  loadAgents: () => Promise<void>
  loadSkills: () => Promise<void>
  loadGroups: () => Promise<void>
  loadTools: () => Promise<void>
  loadValidate: () => Promise<void>
  /** 全量刷新：控制台三列表 + 校验 + agent-store（写盘成功 / notify:assets-changed 共用） */
  refreshAll: () => Promise<void>
  getAgent: (id: string) => Promise<ConsoleAgentDetail>
  getSkill: (name: string) => Promise<ConsoleSkillDetail>
  createAgent: (input: AgentCreateInput) => Promise<ConsoleAgentDetail>
  updateAgent: (id: string, input: AgentWriteInput) => Promise<ConsoleAgentDetail>
  duplicateAgent: (id: string) => Promise<ConsoleAgentDetail>
  deleteAgent: (id: string, force?: boolean) => Promise<{ deletedGroup: boolean }>
  uploadAvatar: (id: string, data: string) => Promise<ConsoleAgentDetail>
  deleteAvatar: (id: string) => Promise<ConsoleAgentDetail>
  saveSoul: (agentId: string, soulId: string, input: SoulWriteInput) => Promise<ConsoleAgentDetail>
  deleteSoul: (agentId: string, soulId: string) => Promise<ConsoleAgentDetail>
  createGroup: (input: GroupWriteInput) => Promise<AgentGroup>
  createSkill: (name: string, input: SkillWriteInput) => Promise<ConsoleSkillDetail>
  updateSkill: (name: string, input: SkillWriteInput) => Promise<ConsoleSkillDetail>
  deleteSkill: (name: string, force?: boolean) => Promise<void>
  /** Agent Studio：AI 生成 Agent 草稿（POST /api/console/generate/agent；不落盘） */
  generateAgent: (description: string, sceneHint?: string) => Promise<GenerateDraftResult<AgentDraftPayload>>
  /** Agent Studio：AI 生成 Skill 草稿（POST /api/console/generate/skill；不落盘） */
  generateSkill: (requirement: string) => Promise<GenerateDraftResult<SkillDraftPayload>>
}

export const useConsoleStore = create<ConsoleState>((set, get) => {
  /** 三个清单的一次性重拉（写盘后与 notify 共用；幂等 GET） */
  const loadLists = async (): Promise<void> => {
    const [agentsRes, skillsRes, groupsRes] = await Promise.all([
      apiGet<{ agents: ConsoleAgentSummary[] }>('/api/console/agents'),
      apiGet<{ skills: ConsoleSkillSummary[] }>('/api/console/skills'),
      apiGet<{ groups: AgentGroup[] }>('/api/console/groups'),
    ])
    set({ agents: agentsRes.agents, skills: skillsRes.skills, groups: groupsRes.groups })
  }

  /** 写操作收尾：控制台视图 + agent-store 全量对齐（服务端已 reload，读侧立即一致） */
  const afterWrite = async (): Promise<void> => {
    await get().refreshAll()
  }

  return {
    agents: [],
    skills: [],
    groups: [],
    tools: [],
    issues: [],
    loading: false,

    loadAgents: async () => {
      const res = await apiGet<{ agents: ConsoleAgentSummary[] }>('/api/console/agents')
      set({ agents: res.agents })
    },
    loadSkills: async () => {
      const res = await apiGet<{ skills: ConsoleSkillSummary[] }>('/api/console/skills')
      set({ skills: res.skills })
    },
    loadGroups: async () => {
      const res = await apiGet<{ groups: AgentGroup[] }>('/api/console/groups')
      set({ groups: res.groups })
    },
    loadTools: async () => {
      const res = await apiGet<{ tools: ConsoleToolInfo[] }>('/api/console/tools')
      set({ tools: res.tools })
    },
    loadValidate: async () => {
      const res = await apiPost<{ issues: ValidationIssue[] }>('/api/console/validate')
      set({ issues: res.issues })
    },

    refreshAll: async () => {
      set({ loading: true })
      try {
        await Promise.all([loadLists(), get().loadValidate(), useAgentStore.getState().reload()])
      } finally {
        set({ loading: false })
      }
    },

    getAgent: async (id) => {
      const res = await apiGet<{ agent: ConsoleAgentDetail }>(`/api/console/agents/${encodeURIComponent(id)}`)
      return res.agent
    },
    getSkill: async (name) => {
      const res = await apiGet<{ skill: ConsoleSkillDetail }>(`/api/console/skills/${encodeURIComponent(name)}`)
      return res.skill
    },

    createAgent: async (input) => {
      const res = await apiPost<{ agent: ConsoleAgentDetail }>('/api/console/agents', input)
      await afterWrite()
      return res.agent
    },
    updateAgent: async (id, input) => {
      const res = await apiPut<{ agent: ConsoleAgentDetail }>(`/api/console/agents/${encodeURIComponent(id)}`, input)
      await afterWrite()
      return res.agent
    },
    duplicateAgent: async (id) => {
      const res = await apiPost<{ agent: ConsoleAgentDetail }>(`/api/console/agents/${encodeURIComponent(id)}/duplicate`)
      await afterWrite()
      return res.agent
    },
    deleteAgent: async (id, force) => {
      const res = await apiDelete<{ deletedGroup: boolean }>(
        `/api/console/agents/${encodeURIComponent(id)}${force ? '?force=1' : ''}`,
      )
      await afterWrite()
      return res
    },
    uploadAvatar: async (id, data) => {
      const res = await apiPut<{ agent: ConsoleAgentDetail }>(`/api/console/agents/${encodeURIComponent(id)}/avatar`, { data })
      await afterWrite()
      return res.agent
    },
    deleteAvatar: async (id) => {
      const res = await apiDelete<{ agent: ConsoleAgentDetail }>(`/api/console/agents/${encodeURIComponent(id)}/avatar`)
      await afterWrite()
      return res.agent
    },
    saveSoul: async (agentId, soulId, input) => {
      const res = await apiPut<{ agent: ConsoleAgentDetail }>(
        `/api/console/agents/${encodeURIComponent(agentId)}/souls/${encodeURIComponent(soulId)}`,
        input,
      )
      await afterWrite()
      return res.agent
    },
    deleteSoul: async (agentId, soulId) => {
      const res = await apiDelete<{ agent: ConsoleAgentDetail }>(
        `/api/console/agents/${encodeURIComponent(agentId)}/souls/${encodeURIComponent(soulId)}`,
      )
      await afterWrite()
      return res.agent
    },
    createGroup: async (input) => {
      const res = await apiPost<{ group: AgentGroup }>('/api/console/groups', input)
      await afterWrite()
      return res.group
    },

    createSkill: async (name, input) => {
      const res = await apiPost<{ skill: ConsoleSkillDetail }>('/api/console/skills', { name, ...input })
      await afterWrite()
      return res.skill
    },
    updateSkill: async (name, input) => {
      const res = await apiPut<{ skill: ConsoleSkillDetail }>(`/api/console/skills/${encodeURIComponent(name)}`, input)
      await afterWrite()
      return res.skill
    },
    deleteSkill: async (name, force) => {
      await apiDelete<{ ok: boolean }>(`/api/console/skills/${encodeURIComponent(name)}${force ? '?force=1' : ''}`)
      await afterWrite()
    },

    // Agent Studio：生成只产草稿（不写盘、不刷新列表——落盘走既有 createAgent / createSkill）
    generateAgent: async (description, sceneHint) => {
      return await apiPost<GenerateDraftResult<AgentDraftPayload>>('/api/console/generate/agent', {
        description,
        ...(sceneHint ? { sceneHint } : {}),
      })
    },
    generateSkill: async (requirement) => {
      return await apiPost<GenerateDraftResult<SkillDraftPayload>>('/api/console/generate/skill', { requirement })
    },
  }
})
