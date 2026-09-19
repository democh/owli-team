/**
 * M65-C：工作室「打开方案」通道——layout 卡 → dock 工作台（跨组件信号）。
 * 先例：LIGHTS_EVENT（ma:sc:lights）跨实例广播；只传递路径，工作台侧负责校验与加载
 * （不存在 → 并入列表走加载错误卡，不静默吞）。
 */
export const STUDIO_OPEN_EVENT = 'ma:studio:open'

/** 请求工作台打开指定场景文件（session 内相对路径 design/*.scene.json） */
export function requestStudioOpen(path: string): void {
  window.dispatchEvent(new CustomEvent<string>(STUDIO_OPEN_EVENT, { detail: path }))
}
