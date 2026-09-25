/**
 * M52-A：场景宿主——ChatArea 消息流区外层包裹（§7.8）。
 * 职责：解析 stage 声明（resolveStage：listMode / 非法 / arena 缺席位一律回退 stream）；
 * 组装 SceneCtx（会话 / 场景 / 成员 / 运行态 / 回填 / 定位）；按注册表渲染四形态容器 + 面板。
 */
import * as React from 'react'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { baseAgentId } from '@multi-agent/shared'
import { useMediaQuery } from '../../lib/hooks'
import { labelOfMemberKey } from '../../lib/members'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSceneStore } from '../../stores/scene-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { useUiStore } from '../../stores/ui-store'
import { SceneContext, type SceneCtx } from './context'
import { STAGE_CONTAINERS, STAGE_PANEL_COMPONENTS } from './registry'
import { resolveStage } from './resolve'
import { useSceneBusy, useScenePanelReady } from './use-scene-data'

/** 窄屏断点：与 AppLayout「会话抽屉」同口径（<900px） */
const NARROW_QUERY = '(max-width: 900px)'

export function SceneStage({
  group,
  participants,
  children,
}: {
  /** 当前会话主场景（stage 声明来源；无会话 / 零编制为 undefined → stream） */
  group?: AgentGroup
  participants: AgentDefinition[]
  children: React.ReactNode
}): React.JSX.Element {
  const currentId = useSessionStore((s) => s.currentId)
  const session = useCurrentSession()
  const agents = useAgentStore((s) => s.agents)
  const waitingIds = useRunStore((s) => s.queue)
  const narrow = useMediaQuery(NARROW_QUERY)
  const listMode = useSceneStore((s) => s.listMode)
  const insert = useUiStore((s) => s.insertToComposer)
  const focus = useUiStore((s) => s.focusMessage)
  const busy = useSceneBusy()

  const stage = React.useMemo(() => resolveStage(group?.stage, { listMode }), [group?.stage, listMode])
  // M58：面板「无数据不展示」——未就绪不渲染工作区（宿主零感知：dock 直通纯对话流 / roundtable 无 aside），
  // 数据到位后自动出现（挂载即已带真实数据）
  // M78：tarot 场景 chartboard 恒就绪——空态即有「亲手抽牌 / 图鉴 / 手记」研习入口（面板即入口，
  // 与 panelReady 纯函数解耦，不动其他场景「无数据不展示」口径）
  const panelReadyBase = useScenePanelReady(stage.panel)
  const ready = panelReadyBase || (group?.id === 'tarot' && stage.panel === 'chartboard')
  // M77：成员键容忍的成员解析——在场实例预生成显示克隆（id = 成员键、name = 实例标签；缓存保证引用稳定）；
  // 基础 id / 历史键走后补回退链（同角多实例时席位、卡片、时间轴均显示 `名字·灵魂名`）
  const displayMembers = React.useMemo(() => {
    const map = new Map<string, AgentDefinition>()
    for (const key of session?.participantIds ?? []) {
      const base = agents.find((a) => a.id === baseAgentId(key))
      if (!base) continue
      const label = labelOfMemberKey(agents, session, key)
      map.set(key, label === base.name ? base : { ...base, id: key, name: label })
    }
    return map
  }, [agents, session])
  const agentOf = React.useCallback(
    (agentId: string): AgentDefinition | undefined => {
      const hit = displayMembers.get(agentId)
      if (hit) return hit
      const base = agents.find((a) => a.id === baseAgentId(agentId))
      if (!base) return undefined
      const label = labelOfMemberKey(agents, session, agentId)
      return label === base.name ? base : { ...base, id: agentId, name: label }
    },
    [displayMembers, agents, session],
  )

  const ctxValue = React.useMemo<SceneCtx>(
    () => ({
      sessionId: currentId ?? undefined,
      group,
      stage,
      participants,
      narrow,
      speakingId: busy.speakingId,
      waitingIds,
      insert,
      focus,
      agentOf,
    }),
    [currentId, group, stage, participants, narrow, busy.speakingId, waitingIds, insert, focus, agentOf],
  )

  const Container = STAGE_CONTAINERS[stage.layout]
  const PanelComp = ready && stage.panel ? STAGE_PANEL_COMPONENTS[stage.panel] : undefined

  return (
    <SceneContext.Provider value={ctxValue}>
      <Container panel={PanelComp ? <PanelComp /> : undefined}>{children}</Container>
    </SceneContext.Provider>
  )
}
