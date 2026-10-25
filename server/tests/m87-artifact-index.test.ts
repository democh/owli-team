/**
 * M87：交付件索引（写时登记 + 低频校准 + 增量）。
 * 断言重点：revision 单调、元数据去重、过程产物分层、软删墓碑、校准预算与 git 变更集语义。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Artifact } from '@multi-agent/shared'
import { describe, expect, it } from 'vitest'
import { createArtifactsRouter } from '../src/routes/artifacts.js'
import type { ApiDeps } from '../src/routes/index.js'
import { ArtifactIndex } from '../src/store/artifact-index.js'
import { makeEnv } from './helpers.js'

function write(env: ReturnType<typeof makeEnv>, sessionId: string, rel: string, content = 'x'): void {
  const full = path.join(env.artifacts.ensureSessionDir(sessionId), rel)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, content, 'utf8')
}

describe('M87：交付件索引', () => {
  it('写时登记：revision 单调 / 元数据去重 / 分层 / 软删墓碑 / 精确路径查询', () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], '索引')
    write(env, session.id, 'docs/需求.md', '# 需求')

    const first = env.index.upsert(session.id, [
      {
        path: 'docs/需求.md',
        origin: 'tool',
        authorAgentId: 'pm',
        runId: 'run_1',
        messageId: 'm1',
        version: 1,
      },
    ])
    expect(first.revision).toBe(1)
    expect(first.entries).toHaveLength(1)
    expect(first.entries[0]?.deliveryClass).toBe('final')
    expect(env.index.getMany(session.id, ['docs/需求.md'])[0]?.authorAgentId).toBe('pm')

    // 相同元数据重复登记：不推进 revision（校准 / 重复声明零噪声）
    const again = env.index.upsert(session.id, [
      {
        path: 'docs/需求.md',
        origin: 'tool',
        authorAgentId: 'pm',
        runId: 'run_1',
        messageId: 'm1',
        version: 1,
      },
    ])
    expect(again.revision).toBe(1)
    expect(again.entries).toHaveLength(0)

    // 版本推进（同尺寸同 mtime 的覆盖写）：revision 前进
    const second = env.index.upsert(session.id, [{ path: 'docs/需求.md', origin: 'tool', version: 2 }])
    expect(second.revision).toBe(2)
    expect(env.index.getMany(session.id, ['docs/需求.md'])[0]?.version).toBe(2)

    // 过程产物 / 附件分层（服务端单点判定，替代客户端路径启发式）
    write(env, session.id, 'charts/sh600000-day.json', '{}')
    write(env, session.id, 'uploads/123-a.png', 'png')
    env.index.upsert(session.id, [
      { path: 'charts/sh600000-day.json', origin: 'tool' },
      { path: 'uploads/123-a.png', origin: 'upload' },
    ])
    const byPath = new Map(env.index.list(session.id).entries.map((entry) => [entry.path, entry]))
    expect(byPath.get('charts/sh600000-day.json')?.deliveryClass).toBe('process')
    expect(byPath.get('uploads/123-a.png')?.deliveryClass).toBe('attachment')

    // 软删：列表剔除、增量带墓碑、绕过路径归一化
    const revision = env.index.remove(session.id, ['docs/需求.md', '../escape.md'])
    expect(revision).toBe(4)
    expect(env.index.list(session.id).entries.map((entry) => entry.path)).not.toContain('docs/需求.md')
    const changes = env.index.changes(session.id, 3)
    expect(changes.deletes).toEqual(['docs/需求.md'])
  })

  it('校准：首次 ensureReady 扫描工作区；TTL 内不重复扫盘；force 后收录外部新增', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], '校准')
    write(env, session.id, 'docs/a.md', 'a')
    write(env, session.id, 'docs/b.md', 'b')

    await env.index.ensureReady(session.id)
    expect(env.index.list(session.id).total).toBe(2)
    expect(env.index.list(session.id).entries.every((entry) => entry.origin === 'scan')).toBe(true)

    // TTL 内（非 force）：不重新扫盘，外部新增不可见（依赖写时登记）
    write(env, session.id, 'docs/c.md', 'c')
    await env.index.ensureReady(session.id)
    expect(env.index.list(session.id).total).toBe(2)

    // 面板刷新（force）：完整校准收录外部新增
    await env.index.ensureReady(session.id, { force: true })
    expect(env.index.list(session.id).total).toBe(3)

    // 外部删除：完整校准后回收（软删）
    fs.rmSync(path.join(env.artifacts.sessionDir(session.id), 'docs/b.md'))
    await env.index.ensureReady(session.id, { force: true })
    expect(env.index.list(session.id).entries.map((entry) => entry.path)).not.toContain('docs/b.md')
  })

  it('HTTP 契约：分页 / paths 精确查询 / ETag 304 / 增量删除', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], '索引 API')
    write(env, session.id, 'docs/a.md', 'a')
    env.index.upsert(session.id, [{ path: 'docs/a.md', origin: 'tool' }])

    const app = express()
    app.use(express.json())
    app.use('/api', createArtifactsRouter(env as unknown as ApiDeps))
    const server = app.listen(0)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const list = await fetch(`${base}/api/sessions/${session.id}/artifacts`)
      expect(list.status).toBe(200)
      const body = (await list.json()) as { artifacts: Artifact[]; revision: number; total: number }
      expect(body.artifacts.map((a) => a.path)).toEqual(['docs/a.md'])
      expect(body.revision).toBe(1)
      const etag = list.headers.get('etag')
      expect(etag).toBeTruthy()

      // 同一 revision → 304 零重传
      const cached = await fetch(`${base}/api/sessions/${session.id}/artifacts`, {
        headers: { 'If-None-Match': etag! },
      })
      expect(cached.status).toBe(304)

      // paths 精确查询只返回元数据子集
      const exact = await fetch(`${base}/api/sessions/${session.id}/artifacts?paths=docs/a.md,docs/none.md`)
      const exactBody = (await exact.json()) as { artifacts: Artifact[] }
      expect(exactBody.artifacts.map((a) => a.path)).toEqual(['docs/a.md'])

      // 增量：删除墓碑
      env.index.remove(session.id, ['docs/a.md'])
      const changes = await fetch(`${base}/api/sessions/${session.id}/artifacts/changes?since=1`)
      const changesBody = (await changes.json()) as { deletes: string[]; upserts: Artifact[] }
      expect(changesBody.deletes).toEqual(['docs/a.md'])
      expect(changesBody.upserts).toHaveLength(0)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('git 模式：以变更集校准并回收已消失条目（不遍历仓库）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], 'git 索引')
    write(env, session.id, 'src/app.ts', 'app')
    let changed: Artifact[] = [
      {
        path: 'src/app.ts',
        size: 3,
        mtime: Date.now(),
        kind: 'code',
        updatedAt: new Date().toISOString(),
        gitStatus: 'M',
      },
    ]
    const index = new ArtifactIndex(env.db, env.artifacts, {
      changedArtifacts: async () => changed,
    })
    await index.ensureReady(session.id)
    const entry = index.list(session.id).entries[0]
    expect(entry?.origin).toBe('git')
    expect(entry?.gitStatus).toBe('M')

    // 变更集清空 → 旧 git 条目被回收（软删）
    changed = []
    await index.ensureReady(session.id, { force: true })
    expect(index.list(session.id).total).toBe(0)
  })
})
