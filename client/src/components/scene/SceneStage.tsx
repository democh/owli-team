/**
 * M52-A：场景宿主——ChatArea 消息流区外层包裹（§7.8）。
 * 职责：解析 stage 声明（resolveStage：listMode / 非法 / arena 缺席位一律回退 stream）；
 * 组装 SceneCtx（会话 / 场景 / 成员 / 运行态 / 回填 / 定位）；按注册表渲染四形态容器 + 面板。
 */
import * as React from 'react'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { useMediaQuery } from '../../lib/hooks'
import { useAgentStore } from '../../stores/agent-store'
import { useRunStore } from '../../stores/run-store'
import { useSceneStore } from '../../stores/scene-store'
import { useSessionStore } from '../../stores/session-store'
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
  const ready = useScenePanelReady(stage.panel)
  const agentOf = React.useCallback((agentId: string) => agents.find((a) => a.id === agentId), [agents])

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
