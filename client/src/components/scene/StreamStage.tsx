/**
 * M52-A：stream 纯对话流形态——零新增结构（children 原样直通；§7.2）。
 */
import type * as React from 'react'

export function StreamStage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <>{children}</>
}
