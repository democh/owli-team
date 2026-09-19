/**
 * M78：抽牌台全局宿主（见 docs/tarot-ritual-design.md §7.3）——与 PanTossHost 并列挂载于 AppLayout：
 * 弹窗不随消息行回收 / 面板卸载消失（请求经 ui-store 下发，与组件树解耦）；
 * 请解草稿走 insertToComposer 全局通道（ADR 0064：只写草稿不直发）；
 * 图鉴 / 手记同族（React.lazy 分块——不随主 chunk）；会话 id 取 session-store.currentId。
 */
import * as React from 'react'
import { useSessionStore } from '../../../../stores/session-store'
import { useUiStore } from '../../../../stores/ui-store'

const TarotRitual = React.lazy(() => import('./TarotRitual').then((m) => ({ default: m.TarotRitual })))
const JournalDialog = React.lazy(() => import('./JournalDialog').then((m) => ({ default: m.JournalDialog })))
const CodexDialog = React.lazy(() => import('./CodexDialog').then((m) => ({ default: m.CodexDialog })))

export function TarotRitualHost(): React.JSX.Element | null {
  const req = useUiStore((s) => s.tarotDraw)
  const closeTarotDraw = useUiStore((s) => s.closeTarotDraw)
  const insertToComposer = useUiStore((s) => s.insertToComposer)
  const codexOpen = useUiStore((s) => s.tarotCodex)
  const closeCodex = useUiStore((s) => s.closeTarotCodex)
  const journalOpen = useUiStore((s) => s.tarotJournal)
  const closeJournal = useUiStore((s) => s.closeTarotJournal)
  const sessionId = useSessionStore((s) => s.currentId)

  return (
    <>
      {req ? (
        <React.Suspense fallback={null}>
          <TarotRitual
            open
            onClose={closeTarotDraw}
            onDone={(draft) => insertToComposer(draft)}
            sessionId={req.sessionId ?? sessionId ?? undefined}
            presetSpread={req.presetSpread}
            presetQuestion={req.presetQuestion}
          />
        </React.Suspense>
      ) : null}
      <React.Suspense fallback={null}>
        {codexOpen ? <CodexDialog open onClose={closeCodex} sessionId={sessionId ?? undefined} /> : null}
        {journalOpen ? <JournalDialog open onClose={closeJournal} sessionId={sessionId ?? undefined} /> : null}
      </React.Suspense>
    </>
  )
}
