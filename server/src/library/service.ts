/**
 * M68：用户素材库服务 —— 归属隔离 / 上传校验 / 文件双清 / copy-on-use 入仓。
 *
 * 职责边界：
 * - 存储布局：`workspace/_library/u_<uid>/<id><ext>`（`_` 前缀保留段，不与 s_* 会话目录冲突；
 *   位于 workspace 内 → 存储配额统计自然覆盖，见 QuotaService 的 libraryRootOf 注入）；
 * - 归属：owner 由路由从登录身份取（单用户兼容模式固定 'local'）；所有读写按 owner 过滤；
 * - 上传：配额闸门（配额服务缺省不限）→ 扩展名白名单（与附件通道同口径：图片 / 视频 / 音频）→ 落盘 → 建行；
 * - copy-on-use：放入画布 = 拷贝进 `workspace/<sid>/library/ref-*`（画布 / 生成 / agent 全按会话工作区解析，
 *   跨根引用一步化解）；入仓路径返回前端，由 `sendArtifact` 同逻辑落节点。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AppConfig } from '../config.js'
import { HttpError } from '../util/http-error.js'
import { ensureDir } from '../util/paths.js'
import { newMaterialId, type MaterialKind, type MaterialRecord, type MaterialStore } from '../store/materials.js'

/** 上传白名单（与 util/mime.ts 附件通道同口径：图片 / 视频 / 音频） */
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg'])
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov', '.m4v'])
const AUDIO_EXT = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac'])
const MAX_BYTES = 200 * 1024 * 1024
/** 展示名长度上限（超出截断保留扩展名） */
const NAME_MAX = 120

/** MIME 白名单（内容流响应头；未知回落 octet-stream——浏览器下载而非 inline） */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
}

export function mimeOf(ext: string): string | undefined {
  return MIME_BY_EXT[ext]
}

/** 文件名段安全化（同 WorkspaceService.sanitizeSegment 口径） */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 展示名安全化（去路径分隔 / 控制字符；限长保留扩展名） */
function safeDisplayName(raw: string, ext: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\u0000-\u001f/\\]+/g, ' ').trim() || `素材${ext}`
  if (cleaned.length <= NAME_MAX) return cleaned
  return `${cleaned.slice(0, NAME_MAX - ext.length - 1)}…${ext}`
}

export interface LibraryServiceDeps {
  cfg: AppConfig
  materials: MaterialStore
  /** 存储配额闸门（缺省不限 / 未装配放行） */
  assertUserStorage?: (userId: string, extraBytes: number) => void
  /** 会话可访问校验（to-canvas；缺省放行——测试） */
  canAccessSession?: (userId: string, sessionId: string) => boolean
  /** 会话工作区目录解析（to-canvas 入仓目标；缺省不可用） */
  sessionDirOf?: (sessionId: string) => string | undefined
}

export class LibraryService {
  private readonly root: string

  constructor(private readonly deps: LibraryServiceDeps) {
    this.root = path.join(deps.cfg.workspaceDir, '_library')
    ensureDir(this.root)
  }

  /** 属主素材目录（绝对路径） */
  userDirOf(ownerId: string): string {
    return path.join(this.root, `u_${sanitizeSegment(ownerId) || 'local'}`)
  }

  /** 行 + 绝对路径解析（内容流 / 拷贝共用；校验路径仍在素材根内） */
  private absOf(record: MaterialRecord): string {
    const abs = path.join(this.root, record.relPath)
    const rootResolved = path.resolve(this.root) + path.sep
    if (!path.resolve(abs).startsWith(rootResolved)) throw new Error('素材路径越界')
    return abs
  }

  list(ownerId: string, opts: { query?: string; kind?: MaterialKind; limit?: number } = {}): MaterialRecord[] {
    return this.deps.materials.list(ownerId, opts)
  }

  usageOf(ownerId: string): { count: number; bytes: number } {
    return { count: this.deps.materials.countOf(ownerId), bytes: this.deps.materials.bytesOf(ownerId) }
  }

  /** 上传：配额闸门 → 白名单 → 落盘 → 建行；返回记录或带引导的错误 */
  upload(ownerId: string, input: { name: string; buffer: Buffer; mime?: string }): MaterialRecord | { error: string } {
    if (input.buffer.length === 0) return { error: '文件内容为空' }
    if (input.buffer.length > MAX_BYTES) return { error: '文件过大：单文件上限 200MB' }
    const ext = path.extname(input.name).toLowerCase()
    const kind: MaterialKind | undefined = IMAGE_EXT.has(ext)
      ? 'image'
      : VIDEO_EXT.has(ext)
        ? 'video'
        : AUDIO_EXT.has(ext)
          ? 'audio'
          : undefined
    if (!kind) return { error: `不支持的文件类型：${ext || '（无扩展名）'}（素材库仅支持图片 / 视频 / 音频）` }
    // 配额闸门（工作区体积 + 素材目录体积；超限 HttpError 403）
    try {
      this.deps.assertUserStorage?.(ownerId, input.buffer.length)
    } catch (err) {
      return { error: err instanceof HttpError ? err.message : '存储空间校验失败' }
    }
    const id = newMaterialId()
    const relPath = `u_${sanitizeSegment(ownerId) || 'local'}/${id}${ext}`
    const dir = this.userDirOf(ownerId)
    ensureDir(dir)
    fs.writeFileSync(path.join(this.root, relPath), input.buffer)
    return this.deps.materials.insert({
      id,
      ownerId,
      name: safeDisplayName(input.name, ext),
      kind,
      ext,
      mime: input.mime ?? mimeOf(ext),
      sizeBytes: input.buffer.length,
      relPath,
      source: 'upload',
    })
  }

  /** 删除：行 + 文件双清（非属主 / 不存在 → false） */
  remove(ownerId: string, id: string): boolean {
    const removed = this.deps.materials.remove(ownerId, id)
    if (!removed) return false
    try {
      fs.rmSync(this.absOf(removed), { force: true })
    } catch {
      /* 文件缺失（外部清理）不阻断行删除 */
    }
    return true
  }

  /** 内容流路径解析（Range 响应）；非属主 / 文件缺失 → undefined */
  contentOf(ownerId: string, id: string): { record: MaterialRecord; abs: string } | undefined {
    const record = this.deps.materials.get(ownerId, id)
    if (!record) return undefined
    let abs: string
    try {
      abs = this.absOf(record)
    } catch {
      return undefined
    }
    if (!fs.existsSync(abs)) return undefined
    return { record, abs }
  }

  /** copy-on-use 入仓：拷贝到会话工作区 `library/ref-*`；返回相对路径（供 sendArtifact 落节点） */
  toSession(ownerId: string, id: string, sessionId: string): { path: string; kind: MaterialKind } | { error: string } {
    const record = this.deps.materials.get(ownerId, id)
    if (!record) return { error: '素材不存在' }
    if (this.deps.canAccessSession && !this.deps.canAccessSession(ownerId, sessionId)) {
      return { error: '会话不存在或无权访问' }
    }
    const sessionDir = this.deps.sessionDirOf?.(sessionId)
    if (!sessionDir) return { error: '会话工作区不可用' }
    const src = this.absOf(record)
    if (!fs.existsSync(src)) return { error: '素材文件缺失（可能已被外部清理）' }
    const rel = `library/ref-${Date.now().toString(36)}-${record.id}${record.ext}`
    const dest = path.join(sessionDir, rel)
    ensureDir(path.dirname(dest))
    fs.copyFileSync(src, dest)
    return { path: rel, kind: record.kind }
  }

  /** 账号删除级联：行全删 + 属主目录整清（文件双清） */
  removeOf(ownerId: string): number {
    const rows = this.deps.materials.removeOf(ownerId)
    const dir = path.resolve(this.userDirOf(ownerId))
    const rootResolved = path.resolve(this.root) + path.sep
    if (dir.startsWith(rootResolved)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 目录缺失不阻断 */
      }
    }
    return rows.length
  }
}
