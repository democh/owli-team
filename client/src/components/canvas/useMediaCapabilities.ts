/**
 * M31 修订：画布媒体能力派生 —— 生成语义入口的门控判定源（未配置即不出现）。
 *
 * - canImage：任一启用连接声明文生图 / 图生图；canVideo：任一连接声明三种视频能力；
 * - providersLoaded=false（尚未拉取完成）按无能力处理——门控元素宁可晚一拍出现，也不闪烁；
 * - 判定对象为「已启用连接的全局清单」（media-store.providers，M56 起全局，与会话无关）。
 */
import * as React from 'react'
import type { MediaProviderInfo } from '@multi-agent/shared'
import { useMediaStore } from '../../stores/media-store'

const IMAGE_CAPS = new Set(['text2image', 'image2image'])
const VIDEO_CAPS = new Set(['text2video', 'image2video', 'firstlast2video'])

export interface MediaCapabilities {
  providers: MediaProviderInfo[]
  providersLoaded: boolean
  /** 生图可用（工具栏生成钮 / studio 模板 / 生成变体等） */
  canImage: boolean
  /** 生视频可用（首尾帧菜单 / storyboard 模板等） */
  canVideo: boolean
  /** 任意生成能力可用（生成入口总开关） */
  canGenerate: boolean
}

export function useMediaCapabilities(): MediaCapabilities {
  const providers = useMediaStore((s) => s.providers)
  const providersLoaded = useMediaStore((s) => s.providersLoaded)
  return React.useMemo(() => {
    let canImage = false
    let canVideo = false
    for (const p of providers) {
      for (const c of p.capabilities) {
        if (IMAGE_CAPS.has(c)) canImage = true
        else if (VIDEO_CAPS.has(c)) canVideo = true
      }
      if (canImage && canVideo) break
    }
    return { providers, providersLoaded, canImage, canVideo, canGenerate: canImage || canVideo }
  }, [providers, providersLoaded])
}
