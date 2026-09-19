/**
 * M33：附件类型工具 —— 扩展名 → MIME 映射 + 视觉支持判定 + 上传白名单。
 *
 * 上传白名单（附件通道）覆盖五类，其余扩展名拒绝：
 * - 图片 / 视频 / 音频（媒体）；
 * - 文档（Office / PDF / RTF / ODF / 文本 / 数据）；
 * - 压缩包（归档）。
 * 可执行 / 脚本 / 字体 / 数据库等类型不属于对话附件场景，拒绝（安全边界）。
 */

export const ATTACHMENT_IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.tiff', '.tif', '.ico',
])
export const ATTACHMENT_VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi'])
export const ATTACHMENT_AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'])
export const ATTACHMENT_DOC_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.rtf', '.odt', '.ods', '.odp',
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.html', '.htm', '.log',
])
export const ATTACHMENT_ARCHIVE_EXT = new Set(['.zip', '.tar', '.gz', '.tgz', '.7z'])

/** 全量白名单（附件通道可接受的扩展名并集） */
export const ATTACHMENT_ACCEPT_EXT = new Set<string>([
  ...ATTACHMENT_IMAGE_EXT,
  ...ATTACHMENT_VIDEO_EXT,
  ...ATTACHMENT_AUDIO_EXT,
  ...ATTACHMENT_DOC_EXT,
  ...ATTACHMENT_ARCHIVE_EXT,
])

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.log': 'text/plain',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.7z': 'application/x-7z-compressed',
}

/** 扩展名 → MIME（未知回退 application/octet-stream） */
export function mimeOfExt(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream'
}

/** 视觉通道支持的图片 MIME（DeepSeek 兼容：png / jpeg / webp / gif；svg 等为文本/其他格式，不注入） */
const VISION_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

export function isVisionImage(mime: string): boolean {
  return VISION_MIME.has(mime.toLowerCase())
}
