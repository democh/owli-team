import * as React from 'react'

// 仅登记脏状态，不保存表单内容或密钥。
const dirtyForms = new Set<symbol>()
const DISCARD_MESSAGE = '有未保存的修改，确定放弃并继续吗？'

export function confirmDiscardChanges(): boolean {
  return dirtyForms.size === 0 || window.confirm(DISCARD_MESSAGE)
}

/** 应用内导航与刷新共用离开保护；返回值用于表单自身的取消、恢复操作。 */
export function useUnsavedChanges(dirty: boolean): () => boolean {
  const id = React.useRef(Symbol('form')).current
  React.useLayoutEffect(() => {
    if (dirty) dirtyForms.add(id)
    else dirtyForms.delete(id)
    return () => {
      dirtyForms.delete(id)
    }
  }, [dirty, id])
  React.useEffect(() => {
    if (!dirty) return
    const onUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])
  return React.useCallback(() => !dirty || window.confirm(DISCARD_MESSAGE), [dirty])
}
