/**
 * M31：画布 UI 上下文 —— 跨节点组件的瞬态 UI 指令（不进文档数据）。
 * autoEditId：新建便签 / 提示词 / 脑图后要求对应节点「立即进入编辑态」一次性信令。
 */
import * as React from 'react'

export interface CanvasUiValue {
  autoEditId?: string
  beginAutoEdit(id: string): void
  endAutoEdit(): void
}

export const CanvasUiContext = React.createContext<CanvasUiValue>({
  beginAutoEdit: () => undefined,
  endAutoEdit: () => undefined,
})
