/**
 * M33：附件上传通道（对话附件托盘的服务端入口）。
 *
 * - POST /sessions/:id/attachments：raw 二进制直传（无 base64 膨胀，body 上限由
 *   index.ts 的 express.raw 控制）；文件名经 `x-file-name`（URL 编码）传递，
 *   媒体元数据（视频时长等）经 `x-file-metadata`（JSON）可选传递；
 * - 类型白名单：图片 / 视频 / 音频 / 文档（Office / PDF / 文本）/ 压缩包；其余拒绝（安全边界）；
 * - 落盘：workspace/<sid>/uploads/<ts>-<name>（成为普通交付件，artifact:updated 广播）；
 * - 图片尺寸服务端解析文件头（PNG/JPEG/GIF/WebP/BMP）；视频时长由客户端读取元数据提交。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import type { MessageAttachment } from '@multi-agent/shared'
import type { ApiDeps } from './index.js'
import { classifyKind } from '../store/artifacts.js'
import { safeFileName } from '../util/attachments.js'
import { probeImageSize } from '../util/image-meta.js'
import { ATTACHMENT_ACCEPT_EXT, isVisionImage, mimeOfExt } from '../util/mime.js'

/** 附件体积上限（与 M31 画布素材同口径；视觉注入另有单图护栏） */
export const ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024

/** 解析可选媒体元数据头（非法 JSON / 越界值静默丢弃，不阻断上传） */
function parseMetadataHeader(raw: string | undefined): { durationMs?: number; width?: number; height?: number } {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: { durationMs?: number; width?: number; height?: number } = {}
    const durationMs = Number(parsed.durationMs)
    if (Number.isFinite(durationMs) && durationMs > 0 && durationMs < 24 * 3600 * 1000) out.durationMs = Math.round(durationMs)
    for (const key of ['width', 'height'] as const) {
      const value = Number(parsed[key])
      if (Number.isFinite(value) && value > 0 && value <= 65535) out[key] = Math.round(value)
    }
    return out
  } catch {
    return {}
  }
}

export function createAttachmentsRouter(deps: ApiDeps): Router {
  const router = Router()

  router.post('/sessions/:id/attachments', (req, res) => {
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) return res.status(404).json({ error: '会话不存在' })
    const body = req.body as unknown
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return res.status(400).json({ error: '请求体为空：请以 raw 二进制上传文件内容' })
    }
    if (body.length > ATTACHMENT_MAX_BYTES) {
      return res.status(413).json({ error: `文件过大：单文件上限 ${Math.round(ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB` })
    }
    // M57 P3：存储配额闸门（工作区体积 + 本次增量；超限 403）
    if (deps.quotas) {
      try {
        deps.quotas.assertUploadAllowed(sessionId, body.length)
      } catch (err) {
        const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 403
        return res.status(status).json({ error: (err as Error).message })
      }
    }
    let rawName = 'file'
    try {
      rawName = decodeURIComponent(String(req.header('x-file-name') ?? 'file'))
    } catch {
      return res.status(400).json({ error: '文件名编码非法（x-file-name 需为 URL 编码）' })
    }
    const ext = path.extname(rawName).toLowerCase()
    if (!ATTACHMENT_ACCEPT_EXT.has(ext)) {
      return res.status(400).json({
        error: `不支持的文件类型：${ext || '（无扩展名）'}（支持图片 / 视频 / 音频 / Office 文档 / PDF / 文本 / 压缩包）`,
      })
    }

    const name = safeFileName(rawName)
    const relPath = `uploads/${Date.now().toString(36)}-${name}`
    try {
      const root = deps.artifacts.ensureSessionDir(sessionId)
      const full = path.join(root, relPath)
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, body)
    } catch (err) {
      return res.status(500).json({ error: `上传失败：${(err as Error).message}` })
    }

    const mime = mimeOfExt(ext)
    const meta = parseMetadataHeader(req.header('x-file-metadata'))
    // 图片尺寸：服务端解析文件头优先（客户端不可伪造）；视频时长取客户端元数据
    const size = isVisionImage(mime) || ext === '.avif' || ext === '.bmp' ? probeImageSize(body) : undefined
    const attachment: MessageAttachment = {
      path: relPath,
      name: rawName.split(/[\\/]/).pop() ?? name,
      kind: classifyKind(relPath),
      mime,
      size: body.length,
      ...(size ? { width: size.width, height: size.height } : meta.width && meta.height ? { width: meta.width, height: meta.height } : {}),
      ...(meta.durationMs ? { durationMs: meta.durationMs } : {}),
      uploadedAt: new Date().toISOString(),
    }
    deps.notify.publish({ type: 'notify:artifact-updated', sessionId, payload: { path: relPath } })
    res.status(201).json({ attachment })
  })

  return router
}
