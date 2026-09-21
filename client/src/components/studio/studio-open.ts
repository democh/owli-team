/**
 * M79-AD：工作室「打开方案」通道——layout 卡 → 工作台（跨组件请求）。
 * 由 window 事件迁移为 ui-store 状态：打开请求可在工作台挂载后消费——
 * 根治「面板尚未挂载时事件无人接收、点击静默失效」的时序竞态
 * （此前"在 3D 工作台打开"有时有效有时无反应的根因）。
 */
import { useUiStore } from '../../stores/ui-store'

/** 请求工作台打开指定场景文件（session 内相对路径 design/*.scene.json） */
export function requestStudioOpen(path: string): void {
  useUiStore.getState().setPendingStudioOpen(path)
}
