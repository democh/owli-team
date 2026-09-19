/**
 * M25.2 测试：嵌入服务（provider / manager / 连接中心凭据链路 / 路由分支）。
 *
 * 覆盖策略：
 * - Mock：确定性（同文本两次逐元素一致）、共享 token 高余弦、空文本兜底、维度覆盖；
 * - Manager：休眠零调用、LLM_MOCK 解析、连接中心解析（config 优先 + secret 密钥不回传）、
 *   禁用 / 类型不符回退、双层缓存（LRU + SQLite 跨实例）、探测（与选中无关 / 缺模型报错）；
 * - 路由：embedding kind 放行、测试分支（mock 零网络 + 状态与审计落库）、bind 拒绝；
 *   M56：媒体连接同纪律（bind 拒绝，媒体连接全局共享）。
 */
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { AppConfig } from '../src/config.js'
import { loadConfig } from '../src/config.js'
import { SecretVault } from '../src/connections/crypto.js'
import { EmbeddingDisabledError, EmbeddingManager } from '../src/embeddings/manager.js'
import { MOCK_EMBED_DIM, MOCK_EMBED_MODEL, MockEmbeddingProvider } from '../src/embeddings/provider.js'
import { createConnectionsRouter } from '../src/routes/connections.js'
import type { ApiDeps } from '../src/routes/index.js'
import { AuditStore } from '../src/store/audit.js'
import { ConnectionStore } from '../src/store/connections.js'
import { openDatabase } from '../src/store/db.js'
import { EmbeddingCacheStore } from '../src/store/memory-vectors.js'
import { makeTmpDir } from './helpers.js'

/** 临时环境：独立主库（含迁移）+ 加密库 + 嵌入管理器（mock 默认开） */
function makeEnv(overrides: Partial<AppConfig> = {}) {
  const dir = makeTmpDir('ma-m25-embed-')
  const cfg: AppConfig = {
    ...loadConfig(),
    dataDir: dir,
    logLevel: 'silent',
    llmMock: true,
    embeddingConnectionId: '',
    embeddingModel: '',
    embeddingBaseUrl: '',
    embeddingApiKey: '',
    embeddingDim: 0,
    ...overrides,
  }
  const db = openDatabase(path.join(dir, 'app.db'))
  const vault = SecretVault.load({ keyFile: path.join(dir, 'secrets.key') })
  const connections = new ConnectionStore(db, vault)
  const audit = new AuditStore(db)
  const cache = new EmbeddingCacheStore(db)
  const embeddings = new EmbeddingManager({ cfg, connections, cache })
  return { dir, cfg, db, vault, connections, audit, cache, embeddings }
}

/** L2 归一向量内积 = 余弦 */
function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

// ---------- Mock 嵌入（确定性） ----------

describe('M25.2：Mock 嵌入（确定性）', () => {
  it('同文本两次投影逐元素一致；L2 归一（范数 ≈ 1）', async () => {
    const provider = new MockEmbeddingProvider()
    const [a] = await provider.embed(['向量记忆模块 sqlite-vec'])
    const [b] = await provider.embed(['向量记忆模块 sqlite-vec'])
    expect(a.length).toBe(MOCK_EMBED_DIM)
    expect(Array.from(a)).toEqual(Array.from(b))
    const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('共享 token 越多余弦越高（近语义 > 无关文本）', async () => {
    const provider = new MockEmbeddingProvider(64)
    const [base] = await provider.embed(['sqlite 向量索引 双后端'])
    const [near] = await provider.embed(['sqlite 向量索引 双后端 兜底'])
    const [far] = await provider.embed(['天气 美食 旅游 摄影'])
    expect(cosine(base, near)).toBeGreaterThan(cosine(base, far))
  })

  it('空文本与纯符号输入落入确定性兜底（非全零）', async () => {
    const provider = new MockEmbeddingProvider(32)
    const [empty] = await provider.embed([''])
    const [symbols] = await provider.embed(['——…!!!'])
    expect(Array.from(empty).some((v) => v !== 0)).toBe(true)
    expect(Array.from(symbols).some((v) => v !== 0)).toBe(true)
  })
})

// ---------- Manager：解析 / 缓存 / 探测 ----------

describe('M25.2：EmbeddingManager 解析与缓存', () => {
  it('无任何配置 → 休眠：resolve null、embed 抛错、零真实调用', async () => {
    const env = makeEnv({ llmMock: false })
    expect(env.embeddings.resolve()).toBeNull()
    expect(env.embeddings.configured).toBe(false)
    await expect(env.embeddings.embed(['x'])).rejects.toBeInstanceOf(EmbeddingDisabledError)
    expect(env.embeddings.stats).toMatchObject({ configured: false, calls: 0, texts: 0 })
  })

  it('LLM_MOCK=true → 确定性 mock；第二次同文本走缓存不增调用计数', async () => {
    const env = makeEnv()
    expect(env.embeddings.resolve()).toMatchObject({ source: 'mock', model: MOCK_EMBED_MODEL, dim: MOCK_EMBED_DIM })
    const first = await env.embeddings.embed(['缓存测试文本', '第二条'])
    expect(first.cacheHits).toBe(0)
    expect(first.vecs).toHaveLength(2)
    const second = await env.embeddings.embed(['缓存测试文本'])
    expect(second.cacheHits).toBe(1)
    expect(env.embeddings.stats.calls).toBe(1)
    expect(Array.from(second.vecs[0]!)).toEqual(Array.from(first.vecs[0]!))
  })

  it('EMBEDDING_DIM 覆盖 mock 维度', async () => {
    const env = makeEnv({ embeddingDim: 128 })
    expect(env.embeddings.resolve()?.dim).toBe(128)
    const result = await env.embeddings.embed(['维度覆盖'])
    expect(result.vecs[0]!.length).toBe(128)
  })

  it('缓存持久化：新管理器实例（同库）直接命中 SQLite 缓存', async () => {
    const env = makeEnv()
    await env.embeddings.embed(['跨实例缓存'])
    const again = new EmbeddingManager({ cfg: env.cfg, connections: env.connections, cache: env.cache })
    const result = await again.embed(['跨实例缓存'])
    expect(result.cacheHits).toBe(1)
    expect(again.stats.calls).toBe(0)
  })

  it('连接中心解析：config 优先、密钥进内存但不回传；禁用即休眠', () => {
    const env = makeEnv({ llmMock: false })
    const conn = env.connections.create({
      name: '嵌入端点',
      kind: 'embedding',
      config: { baseUrl: 'http://127.0.0.1:9/v1', model: 'text-embedding-3-small', dim: 512, batchSize: 4, timeoutMs: 2000 },
      secret: { apiKey: 'sk-test-123' },
    })
    expect(conn.secretSet).toBe(true)
    expect(JSON.stringify(conn)).not.toContain('sk-test-123')
    expect(env.connections.list().some((c) => JSON.stringify(c).includes('sk-test-123'))).toBe(false)

    // 未选中 → 休眠
    expect(env.embeddings.resolve()).toBeNull()
    env.cfg.embeddingConnectionId = conn.id
    expect(env.embeddings.resolve()).toMatchObject({
      source: 'connection',
      connectionId: conn.id,
      model: 'text-embedding-3-small',
      dim: 512,
      baseUrl: 'http://127.0.0.1:9/v1',
      apiKey: 'sk-test-123',
      batchSize: 4,
      timeoutMs: 2000,
    })
    // 禁用 → 不再解析（env 未配置 → 休眠）
    env.connections.update(conn.id, { enabled: false })
    expect(env.embeddings.resolve()).toBeNull()
  })

  it('非 embedding 类型连接被拒绝解析；env 后备仍在', () => {
    const env = makeEnv({
      llmMock: false,
      embeddingModel: 'env-embed',
      embeddingBaseUrl: 'http://env.local',
      embeddingApiKey: 'env-key',
    })
    const conn = env.connections.create({ name: '业务库', kind: 'sqlite', config: { path: '/tmp/x.db' } })
    env.cfg.embeddingConnectionId = conn.id
    expect(env.embeddings.resolve()).toMatchObject({
      source: 'env',
      model: 'env-embed',
      baseUrl: 'http://env.local',
      apiKey: 'env-key',
    })
  })

  it('probeConnection：与选中状态无关；mock 零网络；缺模型 / 类型不符给明确错误', async () => {
    const env = makeEnv()
    const conn = env.connections.create({ name: '嵌入A', kind: 'embedding', config: { model: 'ignored-in-mock' } })
    const ok = await env.embeddings.probeConnection(conn.id)
    expect(ok.ok).toBe(true)
    expect(ok.source).toBe('mock')
    expect(ok.dim).toBe(MOCK_EMBED_DIM)
    const missing = await env.embeddings.probeConnection('not-exist')
    expect(missing.ok).toBe(false)
    expect(missing.error).toContain('不存在')

    const env2 = makeEnv({ llmMock: false })
    const noModel = env2.connections.create({ name: '嵌入B', kind: 'embedding', config: {} })
    const r2 = await env2.embeddings.probeConnection(noModel.id)
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('缺少模型配置')
    const sqlite = env2.connections.create({ name: '库', kind: 'sqlite', config: { path: '/tmp/x.db' } })
    const r3 = await env2.embeddings.probeConnection(sqlite.id)
    expect(r3.error).toContain('不是 embedding')
  })
})

// ---------- 路由：embedding 分支 ----------

/** 最小路由夹具：仅注入被访问的依赖（其余字段故意缺省，cast 供类型闭合） */
async function startApp(partial: Record<string, unknown>): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use('/api', createConnectionsRouter(partial as unknown as ApiDeps))
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

describe('M25.2：connections 路由（embedding 分支）', () => {
  it('POST /connections 放行 embedding kind 且不回传密钥', async () => {
    const env = makeEnv()
    const app = await startApp({ connections: env.connections, audit: env.audit })
    try {
      const res = await fetch(`${app.url}/api/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: '嵌入端点', kind: 'embedding', config: { model: 'm' }, secret: { apiKey: 'sk-secret-xyz' } }),
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { connection: { secretSet: boolean; kind: string } }
      expect(body.connection.kind).toBe('embedding')
      expect(body.connection.secretSet).toBe(true)
      expect(JSON.stringify(body)).not.toContain('sk-secret-xyz')
    } finally {
      await app.close()
    }
  })

  it('POST /:id/test 嵌入分支：mock 零网络探测 + 状态与审计落库', async () => {
    const env = makeEnv()
    const conn = env.connections.create({ name: '嵌入端点', kind: 'embedding', config: { model: 'm' } })
    const app = await startApp({ connections: env.connections, audit: env.audit, embeddings: env.embeddings })
    try {
      const res = await fetch(`${app.url}/api/connections/${conn.id}/test`, { method: 'POST' })
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        result: { ok: boolean; detail?: string; latencyMs?: number }
        connection: { status: string }
      }
      expect(body.result.ok).toBe(true)
      expect(body.result.detail).toContain('mock-embed')
      expect(body.result.detail).toContain(String(MOCK_EMBED_DIM))
      expect(body.connection.status).toBe('ok')

      const audits = env.audit.list({ action: 'connection.test' })
      expect(audits).toHaveLength(1)
      expect(audits[0]!.ok).toBe(true)
      expect(audits[0]!.detail).toMatchObject({ model: MOCK_EMBED_MODEL, dim: MOCK_EMBED_DIM })
    } finally {
      await app.close()
    }
  })

  it('bind 拒绝 embedding 连接（400）', async () => {
    const env = makeEnv()
    const conn = env.connections.create({ name: '嵌入端点', kind: 'embedding', config: { model: 'm' } })
    const app = await startApp({
      connections: env.connections,
      audit: env.audit,
      sessions: { getSession: () => ({ id: 's1' }) },
    })
    try {
      const res = await fetch(`${app.url}/api/sessions/s1/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('不参与会话绑定')
    } finally {
      await app.close()
    }
  })
})

describe('M56：connections 路由（media 绑定守卫）', () => {
  it('bind 拒绝 media 连接（400）——媒体连接全局共享，不参与会话绑定', async () => {
    const env = makeEnv()
    const conn = env.connections.create({
      name: '本地生图',
      kind: 'media',
      config: { provider: 'comfyui', baseUrl: 'http://127.0.0.1:8188', capabilities: ['text2image'] },
    })
    const app = await startApp({
      connections: env.connections,
      audit: env.audit,
      sessions: { getSession: () => ({ id: 's1' }) },
    })
    try {
      const res = await fetch(`${app.url}/api/sessions/s1/connections`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ connectionId: conn.id }),
      })
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('不参与会话绑定')
      expect(body.error).toContain('设置 → 媒体生成')
    } finally {
      await app.close()
    }
  })
})
