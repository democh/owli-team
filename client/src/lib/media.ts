/**
 * M31：媒体生成前端共享常量与判定（生成面板 / 任务历史 / 完成落画布共用）。
 */
import type { MediaCapability, MediaJob } from '@multi-agent/shared'

/** 能力中文标签（与服务端 MEDIA_CAPABILITY_LABEL 对齐；UI 展示用） */
export const CAPABILITY_LABEL: Record<MediaCapability, string> = {
  text2image: '文生图',
  image2image: '图生图',
  text2video: '文生视频',
  image2video: '图生视频',
  firstlast2video: '首尾帧视频',
}

/** 能力的输入需求（面板槽位渲染 / 提交校验） */
export type MediaInputKind = 'none' | 'image' | 'firstlast'

export function inputKindOf(capability: MediaCapability): MediaInputKind {
  if (capability === 'image2image' || capability === 'image2video') return 'image'
  if (capability === 'firstlast2video') return 'firstlast'
  return 'none'
}

/** 能力产物类型（画布节点类型 / 历史缩略图共用） */
export function outputKindOf(capability: MediaCapability): 'image' | 'video' {
  return capability.endsWith('image') ? 'image' : 'video'
}

/** 产物数量描述（完成 toast / 历史条目标注） */
export function outputSummary(job: Pick<MediaJob, 'capability' | 'outputs'>): string {
  return outputKindOf(job.capability) === 'image' ? `${job.outputs.length} 张图片` : `${job.outputs.length} 段视频`
}
