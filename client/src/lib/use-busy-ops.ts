/**
 * 「运行中操作面」推导（M23+）：从当前会话消息的工具调用实时态推导哪些面在跑。
 *
 * 数据源是 run-store / session-store 已有的 tool:call / tool:result 归约（ChatMessage.toolCalls
 * 的 status 字段），零服务端改动；直播窗 tab 状态点与胶囊「进行中」文案的共用入口。
 * 签名式 selector（字符串）保证 zustand 引用稳定，不触发多余重渲染。
 */
import * as React from 'react'
import type { ChatMessage } from '@multi-agent/shared'
import { useRunStore } from '../stores/run-store'
import { useSessionStore } from '../stores/session-store'

export type OpFace = 'db' | 'ssh' | 'browser'

/** 工具名 → 操作面（非实况类工具返回 undefined） */
export function opFaceOfTool(name: string): OpFace | undefined {
  if (name === 'ssh_exec') return 'ssh'
  if (name.startsWith('db_')) return 'db'
  if (name.startsWith('browser_')) return 'browser'
  return undefined
}

/** 扫描消息集合中处于 running 的工具调用 → 排序后的面签名（'' = 无） */
export function busyFaceSignature(byId: Map<string, ChatMessage>): string {
  const faces = new Set<OpFace>()
  for (const message of byId.values()) {
    for (const call of message.toolCalls ?? []) {
      if (call.status !== 'running') continue
      const face = opFaceOfTool(call.name)
      if (face) faces.add(face)
    }
  }
  return [...faces].sort().join(':')
}

const EMPTY: ReadonlySet<OpFace> = new Set<OpFace>()

export function parseBusySignature(signature: string): ReadonlySet<OpFace> {
  return signature ? new Set(signature.split(':') as OpFace[]) : EMPTY
}

/** 当前会话中正在执行的实况操作面（运行结束即清空，避免中断后的 running 残留） */
export function useBusyOpFaces(): ReadonlySet<OpFace> {
  const active = useRunStore((s) => s.active)
  const signature = useSessionStore((s) => busyFaceSignature(s.byId))
  return React.useMemo(() => (active ? parseBusySignature(signature) : EMPTY), [active, signature])
}
