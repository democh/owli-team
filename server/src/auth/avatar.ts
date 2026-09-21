/**
 * M79-Q：真人图片头像工具——魔数嗅探 / 落盘 / 删除 / 公开 URL 映射。
 *
 * 安全约束（全链路）：
 * - 仅接受 PNG / JPEG / WebP（**拒绝 SVG**——可执行内容 XSS 面）；服务端以魔数重算格式，不信 content-type；
 * - 文件名一律服务端生成（`<userId>-<ts>.<ext>`），读取侧白名单正则防路径穿越；
 * - 落盘于 `dataDir/avatars/`（随 data 目录进入备份面）；单文件上限 AVATAR_MAX_BYTES。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { UserAvatar } from '@multi-agent/shared'

/** 单图上限（客户端已裁 256²，正常 <200KB；2MB 为防御性余量） */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** 头像文件名格式（服务端生成；读取白名单） */
const AVATAR_FILE_RE = /^[A-Za-z0-9_-]+-\d+\.(png|jpe?g|webp)$/

export function imagesDirOf(dataDir: string): string {
  return path.join(dataDir, 'avatars')
}

/** 文件名是否为合法头像文件（防穿越：仅 `[A-Za-z0-9_-]` + 时间戳 + 白名单扩展） */
export function avatarFileWellFormed(name: string): boolean {
  return AVATAR_FILE_RE.test(name)
}

/** 魔数嗅探（返回扩展名与 MIME；非白名单格式 → undefined） */
export function sniffImage(buf: Buffer): { ext: 'png' | 'jpg' | 'webp'; mime: string } | undefined {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' }
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  // RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { ext: 'webp', mime: 'image/webp' }
  }
  return undefined
}

/** 扩展名 → MIME（读取侧 Content-Type） */
export function mimeOfAvatarFile(name: string): string {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}

/** 保存头像文件（服务端命名；返回文件名）。userId 中的非法字符剔除后仅作命名前缀，不参与路径解析 */
export function saveAvatarFile(dataDir: string, userId: string, buf: Buffer, ext: string): string {
  const dir = imagesDirOf(dataDir)
  fs.mkdirSync(dir, { recursive: true })
  const safeUser = userId.replace(/[^A-Za-z0-9_-]/g, '') || 'u'
  const name = `${safeUser}-${Date.now()}.${ext}`
  fs.writeFileSync(path.join(dir, name), buf)
  return name
}

/** 删除头像文件（白名单校验后静默；不存在 / 非法名不抛错） */
export function removeAvatarFile(dataDir: string, name: string): void {
  if (!avatarFileWellFormed(name)) return
  try {
    fs.rmSync(path.join(imagesDirOf(dataDir), name), { force: true })
  } catch {
    // 清理失败不阻塞主流程（残留文件随 data 目录回收）
  }
}

/** 投影：文件名 → 公开 URL（含 ts 版本化，天然缓存击穿；配合 immutable 缓存） */
export function avatarPublicUrl(fileName: string): string {
  return `/api/avatars/${fileName}`
}

/** 类型守卫：图片头像 */
export function isImageAvatar(avatar: UserAvatar | undefined): avatar is UserAvatar & { kind: 'image' } {
  return avatar?.kind === 'image'
}
