/**
 * M54 续完善：摇卦台全局宿主（§5.1 模态性修复）——宿主自 PanView（消息行内）上提到 AppLayout 级：
 * 弹窗不再随虚拟列表行回收 / 面板卸载而消失（请求经 ui-store.panToss 下发，与组件树解耦）；
 * 请解草稿仍走 insertToComposer 全局通道；成卦 / 请教程在此落账（研习足迹），
 * PanView 页脚经 subscribeTrail 订阅跳组件刷新。
 */
import * as React from 'react'
import { useUiStore } from '../../../../stores/ui-store'
import { recordAsk, recordThrow } from './trail'
import { TsToss } from './TsToss'

export function PanTossHost(): React.JSX.Element | null {
  const req = useUiStore((s) => s.panToss)
  const closePanToss = useUiStore((s) => s.closePanToss)
  const insertToComposer = useUiStore((s) => s.insertToComposer)

  if (!req) return null
  const { compare, sessionId } = req
  return (
    <TsToss
      open
      onClose={closePanToss}
      onDone={(text) => {
        insertToComposer(text)
        if (sessionId) recordAsk(sessionId)
      }}
      onThrow={sessionId ? () => recordThrow(sessionId) : undefined}
      compare={compare}
    />
  )
}
