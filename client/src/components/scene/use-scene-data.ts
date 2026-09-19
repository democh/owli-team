/**
 * M52-A：场景数据派生 hooks——500ms 节流订阅（复用 MessageRail 先例）；
 * 流式期间工作区冻结（完成态才更新，§7.3-4）；仅订阅本会话 store 切片（getState 快照，不拖消息流渲染）。
 * M60（§81）：新增实时通道 useSceneLiveMessages（不冻结）——仅纯文本投影面（SideFeed）消费，
 * 容器解析面（containers / verdicts / panelReady / 博弈面板）仍走冻结口径。
 */
import * as React from 'react'
import type { ChatMessage, StagePanel } from '@multi-agent/shared'
import { messagesOf, useSessionStore } from '../../stores/session-store'
import {
  containersOf,
  verdictsOf,
  type SceneContainer,
  type SceneVerdict,
} from './derive'
import { panelReady } from './panel-ready'

const THROTTLE_MS = 500

/** 会话消息快照（节流 + 流式冻结） */
export function useSceneMessages(): ChatMessage[] {
  const [messages, setMessages] = React.useState<ChatMessage[]>([])

  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const compute = (): void => {
      const s = useSessionStore.getState()
      // 流式期间冻结工作区（半截内容不进面板；完成后由状态变更再次触发）
      for (const id of s.order) {
        if (s.byId.get(id)?.status === 'streaming') return
      }
      setMessages(messagesOf({ byId: s.byId, order: s.order }))
    }
    compute()
    const unsub = useSessionStore.subscribe(() => {
      if (t) return
      t = setTimeout(() => {
        t = null
        compute()
      }, THROTTLE_MS)
    })
    return () => {
      unsub()
      if (t) clearTimeout(t)
    }
  }, [])

  return messages
}

/**
 * M60：实时消息快照（不冻结）——仅纯文本投影面（arena 席位发言流 SideFeed）消费：
 * 流式期间照常刷新（500ms 节流）——条目即时入流并随发言增长；
 * 半截容器不进 containers / verdicts / panelReady 派生（冻结口径不变，ADR 0129）。
 */
export function useSceneLiveMessages(): ChatMessage[] {
  const [messages, setMessages] = React.useState<ChatMessage[]>([])

  React.useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const compute = (): void => {
      const s = useSessionStore.getState()
      setMessages(messagesOf({ byId: s.byId, order: s.order }))
    }
    compute()
    const unsub = useSessionStore.subscribe(() => {
      if (t) return
      t = setTimeout(() => {
        t = null
        compute()
      }, THROTTLE_MS)
    })
    return () => {
      unsub()
      if (t) clearTimeout(t)
    }
  }, [])

  return messages
}

/** 容器实例集合（::: pan / verdict / checklist 等；面板数据源） */
export function useSceneContainers(): SceneContainer[] {
  const messages = useSceneMessages()
  return React.useMemo(() => containersOf(messages), [messages])
}

/** 裁决实例（versus / arena 计分数据源） */
export function useSceneVerdicts(): SceneVerdict[] {
  const messages = useSceneMessages()
  return React.useMemo(() => verdictsOf(messages), [messages])
}

/**
 * 面板就绪态（M58「无数据不展示」）：false = 宿主不渲染工作区（dock 右区 / 汇聚板），
 * 数据到位后自动变 true（挂载即已带真实数据，无「空态闪一下」）。
 * 未声明面板（stream / arena）恒定 false，订阅开销与节流口径同 useSceneMessages。
 */
export function useScenePanelReady(panel?: StagePanel): boolean {
  const messages = useSceneMessages()
  return React.useMemo(() => {
    if (!panel) return false
    return panelReady(panel, { containers: containersOf(messages), verdicts: verdictsOf(messages), messages })
  }, [panel, messages])
}

export interface SceneBusy {
  /** 是否有消息处于流式（工作区冻结中） */
  streaming: boolean
  /** 当前发言者（最后一条成员消息作者） */
  speakingId?: string
  /** 波次总数（无波次为 0） */
  waveCount: number
}

/**
 * 场景运行态（席位高亮 / 回合轴）。三路 selector 均返回原始值（Object.is 稳定）——
 * 流式 delta 不改这些字段时不触发宿主重渲染（§7.3-5 性能）。
 */
export function useSceneBusy(): SceneBusy {
  const streaming = useSessionStore((s) => {
    for (const id of s.order) {
      if (s.byId.get(id)?.status === 'streaming') return true
    }
    return false
  })
  const speakingId = useSessionStore((s) => {
    for (let i = s.order.length - 1; i >= 0; i--) {
      const m = s.byId.get(s.order[i]!)
      if (m?.role === 'agent' && m.agentId) return m.agentId
    }
    return undefined
  })
  const waveCount = useSessionStore((s) => {
    let last = -1
    for (const id of s.order) {
      const m = s.byId.get(id)
      if (m?.role === 'agent' && m.turnIndex != null && m.turnIndex > last) last = m.turnIndex
    }
    return last + 1
  })
  return { streaming, speakingId, waveCount }
}
