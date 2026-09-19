/**
 * 浏览器路由（M22）：自动发现 / 会话清单与步骤 / 帧流 token / 接管与归还 / 系统浏览器打开 / 关闭。
 *
 * 分权模型：
 * - watch token：只能看帧流（只读观察）；
 * - takeover token：可发人工输入（键盘 / 鼠标），一次性签发（服务端 StreamTokenService 消费）；
 * - 输入通道走 /ws/stream（StreamHub），本文件只负责签发与状态操作。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Router } from 'express'
import { z } from 'zod'
import type { ApiDeps } from './index.js'

const StreamTokenQuery = z.object({
  mode: z.enum(['watch', 'takeover']).default('watch'),
})

const OpenExternalSchema = z.object({ url: z.string().min(1).max(2_000) })

const StartSchema = z.object({
  backend: z.enum(['managed', 'local', 'remote']).optional(),
  url: z.string().max(2_000).optional(),
  connectionId: z.string().min(1).optional(),
  /** 启动形态：true=无头 / false=打开窗口（缺省走连接配置 / 全局 BROWSER_HEADLESS） */
  headless: z.boolean().optional(),
})

function wrap(
  fn: (req: import('express').Request, res: import('express').Response) => Promise<void>,
): import('express').RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next)
  }
}

/** 浏览器会话 id → 校验存在（未命中直接 404 JSON） */
function requireSession(deps: ApiDeps, id: string): ReturnType<ApiDeps['browser']['get']> {
  return deps.browser.get(id)
}

export function createBrowserRouter(deps: ApiDeps): Router {
  const router = Router()

  // ---------- 自动发现（连接表单「自动检测」） ----------
  router.get(
    '/browser/discover',
    wrap(async (_req, res) => {
      const { discoverExecutables, discoverEndpoints } = await import('../browser/discover.js')
      const [executables, endpoints] = await Promise.all([
        discoverExecutables(deps.cfg.browserExecutable || undefined),
        discoverEndpoints(),
      ])
      res.json({ executables, endpoints })
    }),
  )

  // ---------- 业务会话的浏览器视图（面板数据源） ----------
  router.get('/sessions/:id/browser', (req, res) => {
    const sessionId = req.params.id
    if (!deps.sessions.getSession(sessionId)) {
      res.status(404).json({ error: '会话不存在' })
      return
    }
    const active = deps.browser.activeFor(sessionId)
    res.json({
      active: active && !active.isClosed() ? active.info() : null,
      history: deps.browser.history(sessionId, 10),
    })
  })

  router.get('/browser/sessions/:bsid/steps', (req, res) => {
    const session = requireSession(deps, req.params.bsid)
    if (!session) {
      // 已关闭会话仍可回放（步骤在库）
      const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 500)
      res.json({ steps: deps.browser.steps(req.params.bsid, limit) })
      return
    }
    const limit = Math.min(Math.max(Number(req.query.limit ?? 200) || 200, 1), 500)
    res.json({ steps: deps.browser.steps(session.id, limit) })
  })

  // ---------- 启动 / 接入（面板「打开浏览器」；与 Agent 工具共用 runtime 懒启动） ----------
  router.post(
    '/sessions/:id/browser',
    wrap(async (req, res) => {
      const sessionId = req.params.id
      if (!deps.sessions.getSession(sessionId)) {
        res.status(404).json({ error: '会话不存在' })
        return
      }
      const parsed = StartSchema.safeParse(req.body ?? {})
      if (!parsed.success) {
        res.status(400).json({ error: '参数校验失败：backend 需为 managed / local / remote' })
        return
      }
      try {
        const session = await deps.browser.ensureForSession(sessionId, {
          backend: parsed.data.backend,
          startUrl: parsed.data.url,
          connectionId: parsed.data.connectionId,
          headless: parsed.data.headless,
        })
        deps.audit.record({
          actor: 'user',
          action: 'browser.action',
          resourceType: 'browser_session',
          resourceId: session.id,
          sessionId,
          detail: {
            action: 'open',
            backend: session.info().backend,
            url: parsed.data.url,
            headless: session.info().headless,
          },
        })
        res.json({ session: session.info() })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  // ---------- 步骤截图（时间轴证据；路径白名单防穿越） ----------
  router.get('/browser/screenshots/:bsid/:name', (req, res) => {
    const { bsid, name } = req.params
    if (!/^[A-Za-z0-9_-]+$/.test(bsid) || !/^[A-Za-z0-9._-]+\.(jpe?g|png)$/i.test(name)) {
      res.status(400).json({ error: '非法截图路径' })
      return
    }
    const root = path.resolve(deps.cfg.browserScreenshotDir)
    const file = path.resolve(root, bsid, name)
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      res.status(404).json({ error: '截图不存在' })
      return
    }
    res.sendFile(file)
  })

  // ---------- 帧流 token（watch / takeover 由服务端分权） ----------
  router.get('/browser/sessions/:bsid/stream-token', (req, res) => {
    const parsed = StreamTokenQuery.safeParse(req.query)
    if (!parsed.success) {
      res.status(400).json({ error: 'mode 需为 watch / takeover' })
      return
    }
    const session = requireSession(deps, req.params.bsid)
    if (!session || session.isClosed()) {
      res.status(404).json({ error: '浏览器会话不存在或已关闭' })
      return
    }
    if (parsed.data.mode === 'takeover') {
      deps.audit.record({
        actor: 'user',
        action: 'browser.takeover',
        resourceType: 'browser_session',
        resourceId: session.id,
        sessionId: session.sessionId,
      })
    }
    res.json(deps.streamTokens.issue(`browser:${session.id}`, parsed.data.mode))
  })

  // ---------- 接管 / 归还（面板按钮；输入走 WS input 频道） ----------
  router.post(
    '/browser/sessions/:bsid/takeover',
    wrap(async (req, res) => {
      const session = requireSession(deps, req.params.bsid)
      if (!session || session.isClosed()) {
        res.status(404).json({ error: '浏览器会话不存在或已关闭' })
        return
      }
      await session.takeover('user')
      deps.audit.record({
        actor: 'user',
        action: 'browser.takeover',
        resourceType: 'browser_session',
        resourceId: session.id,
        sessionId: session.sessionId,
      })
      res.json({ session: session.info() })
    }),
  )

  router.post(
    '/browser/sessions/:bsid/release',
    wrap(async (req, res) => {
      const session = requireSession(deps, req.params.bsid)
      if (!session || session.isClosed()) {
        res.status(404).json({ error: '浏览器会话不存在或已关闭' })
        return
      }
      await session.release('user')
      deps.audit.record({
        actor: 'user',
        action: 'browser.release',
        resourceType: 'browser_session',
        resourceId: session.id,
        sessionId: session.sessionId,
      })
      res.json({ session: session.info() })
    }),
  )

  // ---------- 系统浏览器打开（面板 / 工具的「自动打开」语义） ----------
  router.post(
    '/browser/open-external',
    wrap(async (req, res) => {
      const parsed = OpenExternalSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: '参数校验失败：需要 url' })
        return
      }
      try {
        await deps.browser.openExternal(parsed.data.url)
        deps.audit.record({
          actor: 'user',
          action: 'browser.action',
          resourceType: 'external',
          detail: { action: 'open-external', url: parsed.data.url.slice(0, 500) },
        })
        res.json({ ok: true })
      } catch (err) {
        res.status(400).json({ error: (err as Error).message })
      }
    }),
  )

  // ---------- 关闭 ----------
  router.post(
    '/browser/sessions/:bsid/close',
    wrap(async (req, res) => {
      const closed = await deps.browser.close(req.params.bsid, 'user')
      if (!closed) {
        res.status(404).json({ error: '浏览器会话不存在' })
        return
      }
      res.json({ ok: true })
    }),
  )

  return router
}
