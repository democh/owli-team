/**
 * M65-B 测试：设计场景工作区文件路由（GET 列表 / PUT 保存）。
 *
 * - 保存：写盘（2 空格缩进 JSON）+ mtimeMs 回传 + 列表可见 + artifact 广播；
 * - 路径白名单：非 design/ 前缀 / 嵌套路径 / 非 .scene.json 后缀 → 400；
 * - 体积上限 >2MB → 413；乐观锁 mtime 不符 → 409（匹配 → 200）；
 * - 列表：非 .scene.json 忽略 / 目录不存在 → 空数组；会话不存在 → 404。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import { createDesignScenesRouter } from '../src/routes/design-scenes.js'
import type { ApiDeps } from '../src/routes/index.js'
import { makeEnv } from './helpers.js'

async function startApi(env: ReturnType<typeof makeEnv>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  // 与生产对齐（src/index.ts 全局 express.json limit 4mb；应用层场景上限 2MB）
  app.use('/api', express.json({ limit: '4mb' }))
  app.use('/api', createDesignScenesRouter(env as unknown as ApiDeps))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const sceneBody = (name = '方案 A') => ({
  version: 1,
  name,
  unit: 'mm',
  rooms: [
    { id: 'r1', name: '客厅', polygon: [[0, 0], [4200, 0], [4200, 3600], [0, 3600]], height: 2800, floor: '地板', wall: '墙面' },
  ],
  openings: [],
  furniture: [{ id: 'f1', kind: 'sofa', x: 1000, y: 1000, rotation: 0 }],
  materials: { 地板: { color: '#e7ddcd', roughness: 0.75 } },
  lights: { sunAzimuth: 210, sunElevation: 45, intensity: 1.4, ambient: 0.55 },
})

async function putScene(
  url: string,
  sessionId: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${url}/api/sessions/${sessionId}/design-scenes`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json()) as Record<string, unknown> }
}

describe('M65-B：design-scenes 路由', () => {
  it('PUT 保存 → 写盘 + mtimeMs 回传；GET 列表可见；内容为 2 空格缩进 JSON', async () => {
    const env = makeEnv()
    const session = env.sessions.create([])
    const app = await startApi(env)
    try {
      const r = await putScene(app.url, session.id, { path: 'design/plan-a.scene.json', data: sceneBody() })
      expect(r.status).toBe(200)
      expect(typeof r.json.mtimeMs).toBe('number')
      // 写盘内容可读 + 缩进稳定
      const full = path.join(env.workspace.resolveDir(session.id), 'design/plan-a.scene.json')
      expect(fs.readFileSync(full, 'utf8')).toContain('"version": 1')
      // 列表
      const listRes = await fetch(`${app.url}/api/sessions/${session.id}/design-scenes`)
      const list = (await listRes.json()) as { scenes: { path: string }[] }
      expect(list.scenes.map((s) => s.path)).toEqual(['design/plan-a.scene.json'])
    } finally {
      await app.close()
    }
  })

  it('路径白名单：非 design/ 前缀 / 嵌套 / 非 .scene.json 后缀 → 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create([])
    const app = await startApi(env)
    try {
      for (const bad of ['docs/x.scene.json', 'design/sub/x.scene.json', 'design/x.json', '../evil.scene.json']) {
        const r = await putScene(app.url, session.id, { path: bad, data: sceneBody() })
        expect(r.status, bad).toBe(400)
      }
    } finally {
      await app.close()
    }
  })

  it('体积上限：>2MB → 413', async () => {
    const env = makeEnv()
    const session = env.sessions.create([])
    const app = await startApi(env)
    try {
      const big = { ...sceneBody(), blob: 'x'.repeat(2 * 1024 * 1024 + 100) }
      const r = await putScene(app.url, session.id, { path: 'design/big.scene.json', data: big })
      expect(r.status).toBe(413)
    } finally {
      await app.close()
    }
  })

  it('乐观锁：ifUnmodifiedSince 不符 → 409；匹配 → 200；缺省 → 无条件覆盖', async () => {
    const env = makeEnv()
    const session = env.sessions.create([])
    const app = await startApi(env)
    try {
      const first = await putScene(app.url, session.id, { path: 'design/plan-a.scene.json', data: sceneBody('v1') })
      const mtime = first.json.mtimeMs as number
      // 外部更新（模拟成员重写）
      await new Promise((r) => setTimeout(r, 8))
      await putScene(app.url, session.id, { path: 'design/plan-a.scene.json', data: sceneBody('v2-external') })
      const conflict = await putScene(app.url, session.id, {
        path: 'design/plan-a.scene.json',
        data: sceneBody('v3'),
        ifUnmodifiedSince: mtime,
      })
      expect(conflict.status).toBe(409)
      // 拿最新 mtime 重试 → 200
      const latest = conflict.json.mtimeMs as number
      const retry = await putScene(app.url, session.id, {
        path: 'design/plan-a.scene.json',
        data: sceneBody('v3'),
        ifUnmodifiedSince: latest,
      })
      expect(retry.status).toBe(200)
    } finally {
      await app.close()
    }
  })

  it('列表忽略非 .scene.json 文件；会话不存在 → 404', async () => {
    const env = makeEnv()
    const session = env.sessions.create([])
    const app = await startApi(env)
    try {
      await putScene(app.url, session.id, { path: 'design/plan-a.scene.json', data: sceneBody() })
      // 混入无关文件（直接写工作区）
      const dir = path.join(env.workspace.resolveDir(session.id), 'design')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'note.txt'), 'x')
      const listRes = await fetch(`${app.url}/api/sessions/${session.id}/design-scenes`)
      const list = (await listRes.json()) as { scenes: { path: string }[] }
      expect(list.scenes).toHaveLength(1)
      // 未知会话
      const missing = await fetch(`${app.url}/api/sessions/ghost/design-scenes`)
      expect(missing.status).toBe(404)
    } finally {
      await app.close()
    }
  })
})
