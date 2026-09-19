/**
 * M52-A：场景上下文——宿主 SceneStage 注入，四形态容器 / 面板 / 元件经 useSceneCtx() 读取。
 * 未提供上下文（独立渲染 / 单测）时面板与元件降级为纯展示（回调缺省为空操作）。
 */
import * as React from 'react'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import type { ResolvedStage } from './resolve'

export interface SceneCtx {
  /** 当前会话 id（sessionStorage 交互态键用；无会话时为 undefined） */
  sessionId?: string
  /** 场景元数据（useGroup；stage 声明来源） */
  group?: AgentGroup
  /** 解析后的形态（含降级结果） */
  stage: ResolvedStage
  /** 在场成员（会话 participantIds 解析） */
  participants: AgentDefinition[]
  /** 窄屏（<900px）：dock / roundtable 右区抽屉化；arena 单流降级 */
  narrow: boolean
  /** 当前发言成员（最后一条成员消息作者） */
  speakingId?: string
  /** 等待序成员（run 队列中的成员 id） */
  waitingIds: string[]
  /** 统一回填：写 Composer 草稿（仅用户确认后发送；§7.3-2） */
  insert: (text: string) => void
  /** 消息定位（跳转 + 闪光；复用 ui-store.focusMessage） */
  focus: (messageId: string) => void
  /** 按 id 找成员（席位 / 卡片渲染用） */
  agentOf: (agentId: string) => AgentDefinition | undefined
}

export const SceneContext = React.createContext<SceneCtx | null>(null)

export function useSceneCtx(): SceneCtx | null {
  return React.useContext(SceneContext)
}

function noop(): void {
  // 无上下文（独立渲染 / 单测）时回调保持静默
}

/** 面板 / 元件专用：无上下文时回退空操作（独立渲染 / 单测安全） */
export function useSceneActions(): Pick<SceneCtx, 'insert' | 'focus'> {
  const ctx = React.useContext(SceneContext)
  const insert = ctx?.insert
  const focus = ctx?.focus
  return React.useMemo(() => ({ insert: insert ?? noop, focus: focus ?? noop }), [insert, focus])
}
