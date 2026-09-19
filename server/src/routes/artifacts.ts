import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { createTwoFilesPatch } from 'diff'
import { classifyKind } from '../store/artifacts.js'
import { PathEscapeError } from '../util/paths.js'
import { previewOfficeFile } from '../util/office-preview.js'
import type { ApiDeps } from './index.js'

/**
 * 交付件浏览（§22.3 / M6）：
 * - 列表：sandbox 模式深度遍历按 mtime 降序；repo / worktree 模式 = git 变更集（git status）；
 * - 内容：文本内联 JSON（≤ ARTIFACT_MAX_BYTES）；二进制 / 超限 / download=1 走文件流；
 *   `raw=1` 文本原样直出（M24：HTML / PDF 预览 iframe 需要浏览器原生解析，而非 JSON 包裹）；
 * - 预览：M24 Office 轻量解析（docx → HTML / xlsx → 工作表二维数组 / pptx → 幻灯片大纲）。
 */
export function createArtifactsRouter(deps: ApiDeps): Router {
  const router = Router()

  router.get('/sessions/:id/artifacts', async (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    // M6：repo / worktree 模式下交付件 = git 变更集（而非全量文件列表）
    if (deps.workspace.isGitMode(session.id)) {
      try {
        const artifacts = await deps.workspace.changedArtifacts(session.id)
        return res.json({ artifacts, source: 'git' })
      } catch {
        // git 失败时回退文件遍历（不阻断交付件面板）
      }
    }
    res.json({ artifacts: deps.artifacts.list(session.id), source: 'files' })
  })

  router.get('/sessions/:id/artifacts/content', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!relPath) return res.status(400).json({ error: '缺少 path 参数' })
    const download = req.query.download === '1' || req.query.download === 'true'
    const raw = req.query.raw === '1' || req.query.raw === 'true'
    try {
      const result = deps.artifacts.read(session.id, relPath, deps.cfg.artifactMaxBytes)
      const kind = classifyKind(relPath)
      if (result.binary) {
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(relPath))}`)
        return res.sendFile(path.resolve(result.fullPath))
      }
      if (download) {
        res.setHeader(
          'Content-Disposition',
          `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(relPath))}`,
        )
        return res.sendFile(path.resolve(result.fullPath))
      }
      if (raw) {
        // M24：文本原样直出（HTML 预览 iframe / PDF 兜底）；Content-Type 按扩展名推断并携带 charset
        res.type(path.extname(relPath) || 'txt')
        res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(path.basename(relPath))}`)
        return res.sendFile(path.resolve(result.fullPath))
      }
      if (result.content === undefined) {
        // 超过内联上限 → 引导下载
        return res.status(413).json({ error: `文件超过内联上限（${Math.round(deps.cfg.artifactMaxBytes / 1024)}KB），请下载查看` })
      }
      res.json({
        path: relPath,
        kind,
        size: result.size,
        truncated: result.truncated ?? false,
        content: result.content,
      })
    } catch (err) {
      if (err instanceof PathEscapeError) return res.status(400).json({ error: err.message })
      const message = (err as Error).message
      const status = message === '交付件不存在' ? 404 : 500
      res.status(status).json({ error: message })
    }
  })

  /**
   * M24：Office 交付件预览（docx / xlsx / pptx 服务端轻量解析，零依赖）。
   * - 8MB 上限；解析失败（损坏 / 加密）→ 422；不支持的文件格式 → 415（前端引导下载）。
   */
  router.get('/sessions/:id/artifacts/preview', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!relPath) return res.status(400).json({ error: '缺少 path 参数' })
    const ext = path.extname(relPath).toLowerCase()
    try {
      const fullPath = deps.artifacts.resolveSafe(session.id, relPath)
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
        return res.status(404).json({ error: '交付件不存在' })
      }
      const size = fs.statSync(fullPath).size
      if (size > OFFICE_PREVIEW_MAX_BYTES) {
        return res
          .status(413)
          .json({ error: `文件超过预览上限（${Math.round(OFFICE_PREVIEW_MAX_BYTES / 1024 / 1024)}MB），请下载查看` })
      }
      const preview = previewOfficeFile(ext, fs.readFileSync(fullPath))
      if (!preview) {
        return res.status(415).json({ error: '该格式暂不支持在线预览（支持 docx / xlsx / pptx），请下载查看' })
      }
      res.json(preview)
    } catch (err) {
      if (err instanceof PathEscapeError) return res.status(400).json({ error: err.message })
      res.status(422).json({ error: `无法解析该文件：${(err as Error).message}` })
    }
  })

  /**
   * M8：交付件版本列表（Diff 视图左栏）：`path` 维度的全部历史版本（新→旧，不带正文）。
   */
  router.get('/sessions/:id/artifacts/versions', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!relPath) return res.status(400).json({ error: '缺少 path 参数' })
    res.json({ versions: deps.versions.list(session.id, relPath) })
  })

  /**
   * M8：两个版本间的 unified diff。
   * - `to` 缺省 = 最新版本；`from` 缺省 = 上一版（to=1 时为 0，即“空文件 → 首版”）；
   * - from=0 表示空文件基线；版本内容未落库（二进制 / 超限）时 400 给出提示。
   */
  router.get('/sessions/:id/artifacts/diff', (req, res) => {
    const session = deps.sessions.getSession(req.params.id)
    if (!session) return res.status(404).json({ error: '会话不存在' })
    const relPath = typeof req.query.path === 'string' ? req.query.path : ''
    if (!relPath) return res.status(400).json({ error: '缺少 path 参数' })
    const versions = deps.versions.list(session.id, relPath) // 新→旧
    if (versions.length === 0) return res.status(404).json({ error: '该文件暂无版本记录' })
    const toRaw = Number(req.query.to)
    const to = Number.isInteger(toRaw) && toRaw > 0 ? toRaw : versions[0].version
    const fromRaw = Number(req.query.from)
    const from = Number.isInteger(fromRaw) && fromRaw >= 0 ? fromRaw : Math.max(0, to - 1)
    if (from > to) return res.status(400).json({ error: 'from 不能大于 to' })

    const right = deps.versions.get(session.id, relPath, to)
    if (!right) return res.status(404).json({ error: `版本 v${to} 不存在` })
    const left = from > 0 ? deps.versions.get(session.id, relPath, from) : undefined
    if (from > 0 && !left) return res.status(404).json({ error: `版本 v${from} 不存在` })
    const leftContent = from > 0 ? left!.content : ''
    const rightContent = right.content
    if (leftContent === undefined || rightContent === undefined) {
      return res.status(400).json({ error: '版本内容未落库（二进制或超限），无法生成 diff' })
    }
    const diff = createTwoFilesPatch(
      `${relPath}@v${from}`,
      `${relPath}@v${to}`,
      leftContent ?? '',
      rightContent,
      '',
      '',
      { context: 3 },
    )
    res.json({
      path: relPath,
      from,
      to,
      diff,
      left: from > 0 ? left : undefined,
      right,
    })
  })

  return router
}

/** Office 预览读取上限（超过引导下载） */
const OFFICE_PREVIEW_MAX_BYTES = 8 * 1024 * 1024
