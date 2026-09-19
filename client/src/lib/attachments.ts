/**
 * 附件工具（M33）：上传白名单 / 体积与时长格式化 / 视觉分类 / 预览 URL / 本地元数据探测。
 *
 * - 白名单与服务端 ATTACHMENT_ACCEPT_EXT 对齐（前端先行拦截，服务端仍兜底拒绝）；
 * - 视觉分类决定卡片图标与渲染方式（图片网格 / 视频播放器 / 音频条 / 文档卡）；
 * - 探测函数在发送前补齐元数据（视频时长 / 分辨率；图片尺寸服务端为准，本地仅先行展示）。
 */
import type { MessageAttachment } from '@multi-agent/shared'
import { artifactContentUrl } from './artifacts'

/** 上传接受串（与服务端 util/mime.ts 的 ATTACHMENT_ACCEPT_EXT 对应） */
export const ATTACHMENT_ACCEPT = [
  'image/*',
  'video/*',
  'audio/*',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.zip',
].join(',')

/** 单文件体积上限（与服务端 ATTACHMENT_MAX_BYTES 一致） */
export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024
/** 单条消息附件数上限（与服务端 sendMessageSchema 一致） */
export const ATTACHMENT_MAX_COUNT = 10

/** 前端白名单扩展名（与 ACCEPT 串对齐；用于拖拽 / 粘贴路径的拦截） */
const ACCEPT_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg',
  'mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi',
  'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
  'pdf', 'docx', 'xlsx', 'pptx', 'doc', 'xls', 'ppt',
  'txt', 'md', 'csv', 'tsv', 'json',
  'zip',
])

export function extOfFile(name: string): string {
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function isAcceptedFile(name: string): boolean {
  return ACCEPT_EXT.has(extOfFile(name))
}

/** 人类可读体积 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size}B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`
  if (size < 1024 * 1024 * 1024) return `${(size / 1024 / 1024).toFixed(1)}MB`
  return `${(size / 1024 / 1024 / 1024).toFixed(2)}GB`
}

/** 时长格式化（mm:ss / h:mm:ss） */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`
}

/** 视觉分类：决定卡片图标与渲染形态 */
export type AttachmentVisual = 'image' | 'video' | 'audio' | 'pdf' | 'word' | 'excel' | 'ppt' | 'archive' | 'text' | 'file'

const EXT_VISUAL: Record<string, AttachmentVisual> = {
  pdf: 'pdf',
  docx: 'word', doc: 'word',
  xlsx: 'excel', xls: 'excel', csv: 'excel', tsv: 'excel',
  pptx: 'ppt', ppt: 'ppt',
  zip: 'archive',
  txt: 'text', md: 'text', json: 'text',
}

export function attachmentVisual(att: Pick<MessageAttachment, 'kind' | 'mime' | 'name'>): AttachmentVisual {
  if (att.kind === 'image') return 'image'
  if (att.kind === 'video') return 'video'
  if (att.mime.startsWith('audio/')) return 'audio'
  return EXT_VISUAL[extOfFile(att.name)] ?? 'file'
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'])

/** 浏览器可直出的视频容器（mkv / avi 等不作播放器预览：按文件卡渲染，避免渲染破损的视频元素） */
const PLAYABLE_VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v'])

/** File（选择 / 拖拽 / 粘贴）→ 视觉分类：MIME 优先，缺失时按扩展名回退；不可播放容器先降级为文件 */
export function visualOfFile(name: string, mime: string): AttachmentVisual {
  const ext = extOfFile(name)
  if (VIDEO_EXT.has(ext) && !PLAYABLE_VIDEO_EXT.has(ext)) return 'file'
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return EXT_VISUAL[ext] ?? 'file'
}

/** 视觉分类的中文标签（文档卡角标） */
export const VISUAL_LABEL: Record<AttachmentVisual, string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  pdf: 'PDF',
  word: 'Word',
  excel: '表格',
  ppt: '幻灯片',
  archive: '压缩包',
  text: '文本',
  file: '文件',
}

/**
 * 附件内容 URL：媒体直出必须带 raw=1（否则 svg / flac / aac 等文本态扩展名会走 JSON 包裹分支而破图）；
 * download=1 强制下载（浏览器另存，不带 raw）。
 */
export function attachmentUrl(sessionId: string, path: string, opts?: { download?: boolean }): string {
  return artifactContentUrl(sessionId, path, opts?.download ? { download: true } : { raw: true })
}

/** 图片附件是否可走视觉理解（与服务端 isVisionImage 对齐：png/jpeg/webp/gif） */
export function isVisionImageMime(mime: string): boolean {
  return mime === 'image/png' || mime === 'image/jpeg' || mime === 'image/webp' || mime === 'image/gif'
}

// ---------- 本地元数据探测（发送前） ----------

export interface LocalMediaMeta {
  durationMs?: number
  width?: number
  height?: number
}

/** 用 object URL 加载图片探测尺寸（失败静默：服务端仍会解析文件头） */
export function probeImageMeta(file: File): Promise<{ width: number; height: number } | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      resolve(undefined)
      URL.revokeObjectURL(url)
    }
    img.src = url
  })
}

/** 用隐藏 video 加载元数据探测时长与分辨率（失败静默：附件仍可正常发送） */
export function probeVideoMeta(file: File): Promise<LocalMediaMeta | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'metadata'
    video.muted = true
    const done = (meta: LocalMediaMeta | undefined): void => {
      resolve(meta)
      video.removeAttribute('src')
      video.load()
      URL.revokeObjectURL(url)
    }
    video.onloadedmetadata = () => {
      done({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined,
        width: video.videoWidth || undefined,
        height: video.videoHeight || undefined,
      })
    }
    video.onerror = () => done(undefined)
    video.src = url
  })
}
