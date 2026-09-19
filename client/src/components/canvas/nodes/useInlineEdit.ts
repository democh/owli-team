/**
 * M31：节点内联文本编辑（双击进入 / blur 或 ⌘Enter 提交 / Esc 取消）。
 * - 编辑态中忽略外部 value 变化（正在输入不被打断）；
 * - autoEditId 命中时自动进入编辑（新建节点后的一次性信令）。
 */
import * as React from 'react'
import { CanvasUiContext } from '../CanvasUiContext'

export interface InlineEdit {
  editing: boolean
  draft: string
  setDraft(value: string): void
  begin(): void
  commit(): void
  cancel(): void
  onKeyDown(event: React.KeyboardEvent): void
}

export function useInlineEdit(nodeId: string, value: string, commit: (text: string) => void): InlineEdit {
  const ui = React.useContext(CanvasUiContext)
  const [editing, setEditing] = React.useState(false)
  const [draft, setDraft] = React.useState(value)
  const valueRef = React.useRef(value)
  valueRef.current = value
  const draftRef = React.useRef(draft)
  draftRef.current = draft

  const begin = React.useCallback(() => {
    setDraft(valueRef.current)
    setEditing(true)
  }, [])

  const doCommit = React.useCallback(
    (text: string) => {
      setEditing(false)
      if (text !== valueRef.current) commit(text)
    },
    [commit],
  )

  const api = React.useMemo<InlineEdit>(
    () => ({
      editing,
      draft,
      setDraft,
      begin,
      commit: () => doCommit(draftRef.current),
      cancel: () => setEditing(false),
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          setEditing(false)
        }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          doCommit(draftRef.current)
        }
      },
    }),
    [editing, draft, begin, doCommit],
  )

  // 一次性自动编辑信令（新建节点）
  React.useEffect(() => {
    if (ui.autoEditId !== nodeId) return
    ui.endAutoEdit()
    setDraft(valueRef.current)
    setEditing(true)
  }, [ui, nodeId])

  return api
}
