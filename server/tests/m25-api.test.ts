/**
 * M25.3d 测试：/api/memories 管理路由 + remember 工具扩展（scope / importance / supersedes）。
 *
 * 环境：内存主库（noExtensions 强制 JS 后端）+ mock 嵌入（确定性，零网络）+
 * express listen(0) 真实 HTTP 往返（仿 m25-embed.test.ts 夹具）。
 */
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type { MemoryItem } from '@multi-agent/shared'
import express from 'express'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { EmbeddingManager } from '../src/embeddings/manager.js'
import { MOCK_EMBED_DIM, MOCK_EMBED_MODEL } from '../src/embeddings/provider.js'
import type { MemoryService } from '../src/memory/service.js'
import { MemoryService as RealMemoryService } from '../src/memory/service.js'
import { createMemoriesRouter } from '../src/routes/memories.js'
import type { ApiDeps } from '../src/routes/index.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { EmbeddingCacheStore, EmbedQueueStore, MemoryVectorStore } from '../src/store/memory-vectors.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { ToolRuntime, TodoItem } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

const SESSION_ID = 's1'
const AGENT_ID = 'pm'

/** 记忆环境：内存主库 + 记忆三件套 + mock 嵌入（确定性） */
async function makeMemoryEnv(overrides: Partial<AppConfig> = {}) {
  const dir = makeTmpDir('ma-m25-api-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    workspaceDir: path.join(dir, 'ws'),
    logLevel: 'silent',
    llmMock: true,
    embeddingConnectionId: '',
    embeddingModel: '',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingDim: 0,
    memoryRecallEnabled: true,
    ...overrides,
  }
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    JSON.stringify([AGENT_ID]),
    now,
    now,
  )
  const queue = new EmbedQueueStore(db)
  const store = new MemoryStore(db, queue)
  const vectors = new MemoryVectorStore(db)
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const embeddings = new EmbeddingManager({ cfg, connections, cache: new EmbeddingCacheStore(db) })
  const memories = new RealMemoryService({ cfg, db, store, vectors, queue, embeddings })
  await memories.start()
  return { cfg, db, store, queue, vectors, embeddings, memories, dispose: () => memories.stop() }
}

/** 最小路由夹具（仅注入被访问的依赖） */
async function startApp(deps: { memory: MemoryStore; memories: MemoryService }): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use('/api', createMemoriesRouter(deps as unknown as ApiDeps))
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: `内部错误：${err.message}` })
  })
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const JSON_HEADERS = { 'content-type': 'application/json' }

// ---------- 路由：/api/memories ----------

describe('M25.3d：/api/memories 管理路由', () => {
  it('GET /memories：scope/owner/kind/q 过滤 + status=all 透传 + 非法枚举 400', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    try {
      env.store.upsertScoped('session', SESSION_ID, 'decision', '会话决策：使用 40001 错误码')
      env.store.upsertScoped('agent', AGENT_ID, 'lesson', '经验：排查先看服务端日志')
      env.store.upsertScoped('global', 'global', 'fact', '全局事实：发布窗口每周四')

      const all = (await (await fetch(`${app.url}/api/memories`)).json()) as { memory: MemoryItem[] }
      expect(all.memory).toHaveLength(3)

      const scoped = (await (
        await fetch(`${app.url}/api/memories?scope=agent&owner=${AGENT_ID}&kind=lesson`)
      ).json()) as { memory: MemoryItem[] }
      expect(scoped.memory).toHaveLength(1)
      expect(scoped.memory[0]!.content).toContain('服务端日志')

      const searched = (await (await fetch(`${app.url}/api/memories?q=${encodeURIComponent('发布')}`)).json()) as {
        memory: MemoryItem[]
      }
      expect(searched.memory).toHaveLength(1)
      expect(searched.memory[0]!.scope).toBe('global')

      // status=all → 视为不过滤
      const statusAll = (await (await fetch(`${app.url}/api/memories?status=all`)).json()) as { memory: MemoryItem[] }
      expect(statusAll.memory).toHaveLength(3)

      expect((await fetch(`${app.url}/api/memories?scope=bad`)).status).toBe(400)
      expect((await fetch(`${app.url}/api/memories?kind=bad`)).status).toBe(400)
      expect((await fetch(`${app.url}/api/memories?status=bad`)).status).toBe(400)
    } finally {
      await app.close()
      env.dispose()
    }
  })

  it('GET /memories/stats：后端/模型/维度/队列 + 召回命中率', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    try {
      env.store.upsertScoped('agent', AGENT_ID, 'constraint', '构建产物必须输出到 workspace/dist 目录')
      expect(await env.memories.poke()).toBe(1)
      // 先召回一次制造 hits 回写
      await fetch(`${app.url}/api/memories/recall`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ query: '构建产物必须输出到 workspace/dist 目录', agentId: AGENT_ID }),
      })

      const body = (await (await fetch(`${app.url}/api/memories/stats`)).json()) as {
        stats: {
          configured: boolean
          source: string
          model: string
          dim: number
          backend: string
          pending: number
          vectorTotal: number
          hits: { active: number; hitItems: number; totalHits: number; hitRate: number }
        }
      }
      expect(body.stats).toMatchObject({
        configured: true,
        source: 'mock',
        model: MOCK_EMBED_MODEL,
        dim: MOCK_EMBED_DIM,
        backend: 'js',
        pending: 0,
        vectorTotal: 1,
      })
      expect(body.stats.hits.active).toBe(1)
      expect(body.stats.hits.hitRate).toBe(1)
      expect(body.stats.hits.totalHits).toBeGreaterThanOrEqual(1)
    } finally {
      await app.close()
      env.dispose()
    }
  })

  it('POST /memories/recall：query 必填；命中返回评分明细；休眠静默 skipped', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    try {
      const item = env.store.upsertScoped('agent', AGENT_ID, 'constraint', '接口错误码统一使用 40001 规范')!.item
      expect(await env.memories.poke()).toBe(1)

      const missing = await fetch(`${app.url}/api/memories/recall`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ agentId: AGENT_ID }),
      })
      expect(missing.status).toBe(400)
      expect(((await missing.json()) as { error: string }).error).toContain('query')

      const res = await fetch(`${app.url}/api/memories/recall`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ query: '接口错误码统一使用 40001 规范', agentId: AGENT_ID }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        outcome: { items: Array<{ id: string; score: number; scope: string; signals?: unknown }>; skipped?: string }
      }
      expect(body.outcome.skipped).toBeUndefined()
      expect(body.outcome.items.length).toBeGreaterThanOrEqual(1)
      expect(body.outcome.items[0]!.id).toBe(item.id)
      expect(body.outcome.items[0]!.score).toBeGreaterThan(0)
      expect(body.outcome.items[0]!.scope).toBe('agent')
      expect(body.outcome.items[0]!.signals).toBeDefined()
    } finally {
      await app.close()
      env.dispose()
    }

    // 休眠：无任何嵌入配置 → 静默 skipped（200，不抛错）
    const dormant = await makeMemoryEnv({ llmMock: false })
    const app2 = await startApp({ memory: dormant.store, memories: dormant.memories })
    try {
      const res = await fetch(`${app2.url}/api/memories/recall`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ query: '任意查询' }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { outcome: { items: unknown[]; skipped?: string } }
      expect(body.outcome.items).toHaveLength(0)
      expect(body.outcome.skipped).toContain('休眠')
    } finally {
      await app2.close()
      dormant.dispose()
    }
  })

  it('POST /memories/:id/supersede：同 scope 同 owner 取代成功；跨 scope / 自我取代 400；缺失 404', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    const supersede = (id: string, newId: string): Promise<Response> =>
      fetch(`${app.url}/api/memories/${id}/supersede`, {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ newId }),
      })
    try {
      const old = env.store.upsertScoped('agent', AGENT_ID, 'decision', '旧决策：接口用 PUT')!.item
      const next = env.store.upsertScoped('agent', AGENT_ID, 'decision', '新决策：接口改用 POST')!.item
      const other = env.store.upsertScoped('global', 'global', 'decision', '全局决策：不受影响')!.item

      expect((await supersede(old.id, '')).status).toBe(400) // newId 空
      expect((await supersede(old.id, 'nope')).status).toBe(404)
      expect((await supersede('nope', next.id)).status).toBe(404)
      expect((await supersede(old.id, old.id)).status).toBe(400) // 自我取代
      const cross = await supersede(old.id, other.id)
      expect(cross.status).toBe(400)
      expect(((await cross.json()) as { error: string }).error).toContain('同 scope 同 owner')

      const ok = await supersede(old.id, next.id)
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { item: MemoryItem }
      expect(body.item.status).toBe('superseded')
      expect(body.item.supersededBy).toBe(next.id)
      expect(env.store.get(old.id)!.status).toBe('superseded')
      expect(env.store.get(next.id)!.supersedes).toBe(old.id)
      expect(env.store.get(other.id)!.status).toBe('active')
    } finally {
      await app.close()
      env.dispose()
    }
  })

  it('PATCH /memories/:id/status：候选 → active 回写；非法 400；不存在 404', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    const patch = (id: string, status: string): Promise<Response> =>
      fetch(`${app.url}/api/memories/${id}/status`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status }),
      })
    try {
      const item = env.store.upsertScoped('session', SESSION_ID, 'lesson', '候选经验：先跑单测再提交')!.item
      env.store.setStatus(item.id, 'candidate')

      expect((await patch(item.id, 'bogus')).status).toBe(400)
      expect((await patch('nope', 'active')).status).toBe(404)

      const ok = await patch(item.id, 'active')
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { item: MemoryItem }
      expect(body.item.status).toBe('active')
      expect(env.store.get(item.id)!.status).toBe('active')
    } finally {
      await app.close()
      env.dispose()
    }
  })

  it('POST /memories/reindex：mock 下重建成功返回模型/维度；休眠 400', async () => {
    const env = await makeMemoryEnv()
    const app = await startApp({ memory: env.store, memories: env.memories })
    try {
      const res = await fetch(`${app.url}/api/memories/reindex`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { result: { ok: boolean; model?: string; dim?: number } }
      expect(body.result).toMatchObject({ ok: true, model: MOCK_EMBED_MODEL, dim: MOCK_EMBED_DIM })
    } finally {
      await app.close()
      env.dispose()
    }

    const dormant = await makeMemoryEnv({ llmMock: false })
    const app2 = await startApp({ memory: dormant.store, memories: dormant.memories })
    try {
      const res = await fetch(`${app2.url}/api/memories/reindex`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('休眠')
    } finally {
      await app2.close()
      dormant.dispose()
    }
  })
})

// ---------- remember 工具扩展 ----------

/** 工具夹具：真实 MemoryStore + 桩 MemoryService（观察 poke 触发） */
function makeToolEnv() {
  const cfg = { ...loadConfig(), logLevel: 'silent' as const }
  const artifacts = new ArtifactStore(makeTmpDir('ma-m25-api-tool-'))
  const workspace = artifacts.ensureSessionDir(SESSION_ID)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    SESSION_ID,
    '测试会话',
    JSON.stringify([AGENT_ID]),
    now,
    now,
  )
  const queue = new EmbedQueueStore(db)
  const store = new MemoryStore(db, queue)
  const tasks = new TaskStore(db)
  const poke = vi.fn(async () => 0)
  const memories = { poke } as unknown as MemoryService
  const todos: TodoItem[] = []
  const runtime: ToolRuntime = {
    sessionId: SESSION_ID,
    runId: 'r1',
    agentId: AGENT_ID,
    workspace,
    artifacts,
    skills,
    memory: store,
    memories,
    tasks,
    participants: [{ id: AGENT_ID, name: '费利' }],
    todos,
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webFetchAllowedDomains: [],
    webSearch: { enabled: false, apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: (name) => {
      const skill = skills.get(name)
      return skill ? { ok: true, body: skill.body } : { ok: false, error: `技能「${name}」不存在` }
    },
  }
  return { registry: createToolRegistry(cfg), runtime, store, poke }
}

describe('M25.3d：remember 工具扩展（scope / importance / supersedes / poke）', () => {
  it('scope=agent：owner 为当前成员，summary 标注 scope，poke 触发', async () => {
    const env = makeToolEnv()
    const result = await env.registry.execute(
      'remember',
      { kind: 'fact', content: '本组成员长期偏好 pnpm', scope: 'agent' },
      env.runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('已写入记忆')
    expect(result.summary).toContain('scope=agent')
    expect(result.detail).toContain('跨会话')
    const items = env.store.query({ scope: 'agent', ownerId: AGENT_ID })
    expect(items).toHaveLength(1)
    expect(items[0]!.content).toContain('pnpm')
    expect(items[0]!.source).toContain(`agent:${AGENT_ID}`)
    expect(env.poke).toHaveBeenCalledTimes(1)
  })

  it('scope=project：未关联项目拒绝写入；关联后可写', async () => {
    const env = makeToolEnv()
    const denied = await env.registry.execute(
      'remember',
      { kind: 'fact', content: '项目事实 x', scope: 'project' },
      env.runtime,
    )
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('未关联项目')
    expect(env.store.query({ scope: 'project' })).toHaveLength(0)

    const allowed = await env.registry.execute(
      'remember',
      { kind: 'fact', content: '项目事实 x', scope: 'project' },
      { ...env.runtime, projectId: 'p-1' },
    )
    expect(allowed.ok).toBe(true)
    expect(env.store.query({ scope: 'project', ownerId: 'p-1' })).toHaveLength(1)
  })

  it('scope=global：owner 固定 global；importance 透传（默认 3）', async () => {
    const env = makeToolEnv()
    await env.registry.execute(
      'remember',
      { kind: 'constraint', content: '全局高重要度约束', scope: 'global', importance: 5 },
      env.runtime,
    )
    await env.registry.execute('remember', { kind: 'constraint', content: '全局默认重要度约束', scope: 'global' }, env.runtime)
    const items = env.store.query({ scope: 'global', ownerId: 'global' })
    expect(items).toHaveLength(2)
    expect(items.find((x) => x.content.includes('高重要度'))!.importance).toBe(5)
    expect(items.find((x) => x.content.includes('默认重要度'))!.importance).toBe(3)
  })

  it('supersedes：同 scope+owner 的 active 旧条目被取代；跨 scope 忽略并提示', async () => {
    const env = makeToolEnv()
    const old = env.store.upsertScoped('agent', AGENT_ID, 'decision', '旧结论：缓存用内存 LRU')!.item
    const replaced = await env.registry.execute(
      'remember',
      { kind: 'decision', content: '新结论：缓存改用 SQLite 持久层', scope: 'agent', supersedes: old.id },
      env.runtime,
    )
    expect(replaced.ok).toBe(true)
    expect(replaced.summary).toContain('已取代')
    expect(env.store.get(old.id)!.status).toBe('superseded')
    expect(env.store.get(old.id)!.supersededBy).toBeDefined()

    // 跨 scope：global 条目不能被 agent 写入取代（防误伤）
    const globalItem = env.store.upsertScoped('global', 'global', 'fact', '全局事实不受影响')!.item
    const ignored = await env.registry.execute(
      'remember',
      { kind: 'fact', content: '另一条事实', scope: 'agent', supersedes: globalItem.id },
      env.runtime,
    )
    expect(ignored.ok).toBe(true)
    expect(ignored.summary).toContain('未命中')
    expect(env.store.get(globalItem.id)!.status).toBe('active')
  })
})
