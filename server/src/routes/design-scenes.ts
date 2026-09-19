/**
 * M65-B：设计场景（DesignScene）工作区文件路由（挂载于 /api 之下）。
 *
 * - GET /sessions/:id/design-scenes：列出 design/*.scene.json（路径 + mtimeMs + size）
 * - PUT /sessions/:id/design-scenes：保存场景（body { path, data, ifUnmodifiedSince? }）
 *   - 路径白名单：design/<名>.scene.json 单层命名（resolveSafe 越界二次防御）
 *   - 体积上限 2MB（场景 JSON；超限 413）
 *   - 配额闸门：复用 QuotaService.assertUploadAllowed（工作区体积口径，与附件通道一致）
 *   - 乐观锁：ifUnmodifiedSince（mtimeMs）不符 → 409（前端提示「文件已被更新」）
 *   - 写后广播 notify:artifact-updated（交付件视图 / 场景选择器同步）
 * - 内容读取复用 GET /sessions/:id/artifacts/content（raw=1；M6 通道零新增）
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { z } from 'zod'
import type { ApiDeps } from './index.js'

/** 场景文件路径白名单：design/<名>.scene.json（单层；防路径穿越 / 嵌套） */
const SCENE_PATH_RE = /^design\/[^/\\]+\.scene\.json$/
/** 场景 JSON 体积上限（2MB） */
const SCENE_MAX_BYTES = 2 * 1024 * 1024

const DesignSceneSaveSchema = z.object({
  path: z.string().min(1).max(200).regex(SCENE_PATH_RE, '路径须为 design/<名>.scene.json'),
  /** 场景数据（深层结构校验由设计侧承担：版本 / 字段；服务端保证 JSON 序列化与体积） */
  data: z.unknown(),
  /** 乐观锁：上次加载时的 mtimeMs（缺省 = 无条件覆盖） */
  ifUnmodifiedSince: z.number().optional(),
})

export function createDesignScenesRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/sessions/:id/design-scenes', (req, res) => {
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) return res.status(404).json({ error: '会话不存在' })
    const scenes: { path: string; mtimeMs: number; size: number }[] = []
    try {
      const dir = path.join(deps.artifacts.ensureSessionDir(sessionId), 'design')
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.scene.json')) continue
        const full = path.join(dir, name)
        const st = fs.statSync(full)
        if (st.isFile()) scenes.push({ path: `design/${name}`, mtimeMs: st.mtimeMs, size: st.size })
      }
    } catch {
      // 目录不存在 / 不可读 = 空列表（fail-safe）
    }
    scenes.sort((a, b) => a.path.localeCompare(b.path))
    res.json({ scenes })
  })

  router.put('/sessions/:id/design-scenes', (req, res) => {
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) return res.status(404).json({ error: '会话不存在' })
    const parsed = DesignSceneSaveSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return res.status(400).json({ error: `场景保存参数非法：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}` })
    }
    const { path: relPath, data, ifUnmodifiedSince } = parsed.data
    const text = JSON.stringify(data, null, 2) + '\n'
    const bytes = Buffer.byteLength(text)
    if (bytes > SCENE_MAX_BYTES) {
      return res.status(413).json({ error: `场景数据过大（上限 ${SCENE_MAX_BYTES / 1024 / 1024}MB）` })
    }
    let full: string
    try {
      // 新会话工作区可能尚未创建（首存路径）：先确保根目录存在再解析（resolveSafe 要求工作区存在）
      deps.artifacts.ensureSessionDir(sessionId)
      full = deps.artifacts.resolveSafe(sessionId, relPath)
    } catch (err) {
      return res.status(400).json({ error: `路径非法：${(err as Error).message}` })
    }
    // 配额闸门（与附件上传同口径：工作区体积）
    if (deps.quotas) {
      try {
        deps.quotas.assertUploadAllowed(sessionId, bytes)
      } catch (err) {
        const status = typeof (err as { status?: number }).status === 'number' ? (err as { status: number }).status : 403
        return res.status(status).json({ error: (err as Error).message })
      }
    }
    // 乐观锁：文件已被外部更新（成员重写 / 另存）→ 409 带最新 mtime（前端提示后由用户决策）
    if (typeof ifUnmodifiedSince === 'number' && fs.existsSync(full)) {
      const st = fs.statSync(full)
      if (Math.abs(st.mtimeMs - ifUnmodifiedSince) > 1) {
        return res.status(409).json({ error: '场景文件已在别处被更新（可能由成员重写或另存）', mtimeMs: st.mtimeMs })
      }
    }
    try {
      fs.mkdirSync(path.dirname(full), { recursive: true })
      fs.writeFileSync(full, text)
    } catch (err) {
      return res.status(500).json({ error: `保存失败：${(err as Error).message}` })
    }
    const st = fs.statSync(full)
    deps.notify.publish({ type: 'notify:artifact-updated', sessionId, payload: { path: relPath } })
    res.json({ path: relPath, mtimeMs: st.mtimeMs, size: st.size })
  })

  return router
}
