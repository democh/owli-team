/**
 * M57 P3 测试：BYOK（用户 LLM 凭据）。
 * - Store：加密落库 / 解密回读 / status 不含密钥 / 清除；
 * - ByokProvider：无会话 / 无属主 / 无凭据 → 直通底层；有凭据 → 每用户 provider（缓存复用 / invalidate 重建）；
 *   Mock 模式恒直通；modelFor 归因解析；
 * - HTTP：GET 默认未配置 / PUT 保存（响应不含密钥 + 审计 + onChange）/ 校验（短 Key / 非法 baseUrl）/ DELETE 清除 / 兼容模式 400。
 */
import path from 'node:path'
import express from 'express'
import type { Server } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { AuthUser } from '../src/auth/service.js'
import { SecretVault } from '../src/connections/crypto.js'
import { ByokProvider } from '../src/llm/byok.js'
import type { ChatRequest, LlmChunk, LlmProvider } from '../src/llm/provider.js'
import { createLlmCredsRouter } from '../src/routes/llm-credentials.js'
import { AuditStore } from '../src/store/audit.js'
import { LlmCredentialStore } from '../src/store/llm-credentials.js'
import { makeEnv } from './helpers.js'

function makeFixture(cfgOverrides: Record<string, unknown> = {}) {
  const env = makeEnv(cfgOverrides)
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const store = new LlmCredentialStore(env.db, vault)
  const user = env.users.create({ username: 'alice', displayName: 'Alice', passwordHash: 'x', role: 'member' })
  return { env, vault, store, user }
}

/** 假 provider：按输出文本标注来源（base / user） */
function fakeProvider(tag: string, hits: { count: number }): LlmProvider {
  return {
    async *chatStream(): AsyncIterable<LlmChunk> {
      hits.count += 1
      yield { type: 'text', text: tag }
    },
  }
}

async function collect(provider: LlmProvider, req: ChatRequest): Promise<string> {
  let out = ''
  for await (const chunk of provider.chatStream(req, new AbortController().signal)) {
    if (chunk.type === 'text') out += chunk.text
  }
  return out
}

const baseReq = (sessionId?: string): ChatRequest => ({
  system: 's',
  messages: [{ role: 'user', content: 'hi' }],
  sessionId,
  meta: { agentId: 'pm', participantIds: [] },
})

describe('M57 P3：LlmCredentialStore', () => {
  it('加密落库 / 解密回读 / status 不含密钥 / 清除', () => {
    const f = makeFixture()
    expect(f.store.status(f.user.id)).toEqual({ configured: false })

    const status = f.store.upsert(f.user.id, { apiKey: 'sk-test-12345678', baseUrl: 'https://api.example.com/v1', model: 'my-model' })
    expect(status.configured).toBe(true)
    expect(status.baseUrl).toBe('https://api.example.com/v1')
    expect(status.model).toBe('my-model')
    expect(JSON.stringify(status)).not.toContain('sk-test-12345678')

    const creds = f.store.get(f.user.id)
    expect(creds?.apiKey).toBe('sk-test-12345678')
    // 落库为密文（非明文）
    const raw = f.env.db.get<{ secret_enc: string }>('SELECT secret_enc FROM user_llm_credentials WHERE user_id = ?', f.user.id)
    expect(raw?.secret_enc).toBeTruthy()
    expect(raw?.secret_enc).not.toContain('sk-test-12345678')

    // 更新：baseUrl / model 留空 → 清除为系统默认
    const cleared = f.store.upsert(f.user.id, { apiKey: 'sk-next-12345678' })
    expect(cleared.baseUrl).toBeUndefined()
    expect(cleared.model).toBeUndefined()
    expect(f.store.get(f.user.id)?.apiKey).toBe('sk-next-12345678')

    expect(f.store.clear(f.user.id)).toBe(true)
    expect(f.store.status(f.user.id)).toEqual({ configured: false })
  })
})

describe('M57 P3：ByokProvider 包装', () => {
  it('无会话 / 无属主 / 无凭据 → 直通底层', async () => {
    const f = makeFixture()
    const baseHits = { count: 0 }
    const userHits = { count: 0 }
    const byok = new ByokProvider({
      base: fakeProvider('base', baseHits),
      cfg: f.env.cfg,
      sessions: f.env.sessions,
      credentials: f.store,
      createFor: () => fakeProvider('user', userHits),
    })
    expect(await collect(byok, baseReq())).toBe('base') // 无 sessionId
    const sessionNoOwner = f.env.sessions.create(['pm'], '无属主')
    expect(await collect(byok, baseReq(sessionNoOwner.id))).toBe('base') // 无属主
    const owned = f.env.sessions.create(['pm'], '有属主', { ownerId: f.user.id })
    expect(await collect(byok, baseReq(owned.id))).toBe('base') // 有属主但无凭据
    expect(baseHits.count).toBe(3)
    expect(userHits.count).toBe(0)
  })

  it('有凭据 → 每用户 provider（缓存复用）；invalidate 后重建；Mock 模式直通', async () => {
    const f = makeFixture()
    f.store.upsert(f.user.id, { apiKey: 'sk-test-12345678', model: 'byok-model' })
    const owned = f.env.sessions.create(['pm'], '会话', { ownerId: f.user.id })
    let created = 0
    const baseHits = { count: 0 }
    const byok = new ByokProvider({
      base: fakeProvider('base', baseHits),
      cfg: f.env.cfg,
      sessions: f.env.sessions,
      credentials: f.store,
      createFor: () => {
        created += 1
        return fakeProvider(`user-${created}`, { count: 0 })
      },
    })
    expect(await collect(byok, baseReq(owned.id))).toBe('user-1')
    expect(await collect(byok, baseReq(owned.id))).toBe('user-1') // 缓存复用
    expect(created).toBe(1)
    expect(byok.modelFor(owned.id)).toBe('byok-model')
    expect(byok.modelFor(undefined)).toBeUndefined()

    byok.invalidate(f.user.id)
    expect(await collect(byok, baseReq(owned.id))).toBe('user-2') // 重建
    expect(created).toBe(2)

    // Mock 模式：即便有凭据也直通底层（E2E / 测试确定性）
    const mockByok = new ByokProvider({
      base: fakeProvider('base', baseHits),
      cfg: { ...f.env.cfg, llmMock: true },
      sessions: f.env.sessions,
      credentials: f.store,
      createFor: () => fakeProvider('user', { count: 0 }),
    })
    expect(await collect(mockByok, baseReq(owned.id))).toBe('base')
  })
})

describe('M57 P3：BYOK HTTP', () => {
  async function mount(f: ReturnType<typeof makeFixture>, multiUser = true): Promise<{ url: string; close: () => Promise<void>; changes: string[] }> {
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      const uid = String(req.header('x-test-user') ?? '')
      if (uid) (req as unknown as { user?: AuthUser }).user = f.env.auth.getUser(uid) as unknown as AuthUser
      next()
    })
    const changes: string[] = []
    const audit = new AuditStore(f.env.db)
    app.use(
      '/api',
      createLlmCredsRouter({
        multiUser: () => multiUser,
        credentials: f.store,
        audit,
        onChange: (uid) => changes.push(uid),
      }),
    )
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s))
    })
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}`,
      changes,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    }
  }

  const asUser = (uid: string): Record<string, string> => ({ 'x-test-user': uid, 'content-type': 'application/json' })

  it('GET 默认未配置 / PUT 保存（响应不含密钥 + 审计 + onChange）/ DELETE 清除', async () => {
    const f = makeFixture()
    const api = await mount(f)
    try {
      const before = (await (await fetch(`${api.url}/api/auth/llm-credentials`, { headers: asUser(f.user.id) })).json()) as {
        status: { configured: boolean }
      }
      expect(before.status.configured).toBe(false)

      const put = await fetch(`${api.url}/api/auth/llm-credentials`, {
        method: 'PUT',
        headers: asUser(f.user.id),
        body: JSON.stringify({ apiKey: 'sk-live-12345678', baseUrl: 'https://api.example.com/v1', model: 'my-model' }),
      })
      expect(put.status).toBe(200)
      const putText = await put.text()
      expect(putText).not.toContain('sk-live-12345678') // 密钥永不回显
      expect(JSON.parse(putText)).toMatchObject({ status: { configured: true, model: 'my-model' } })
      expect(api.changes).toContain(f.user.id)
      const auditRow = f.env.db.get<{ action: string; user_id: string | null }>(
        "SELECT action, user_id FROM audit_log WHERE action = 'auth.llm-credential-set' ORDER BY id DESC LIMIT 1",
      )
      expect(auditRow?.user_id).toBe(f.user.id)

      const del = await fetch(`${api.url}/api/auth/llm-credentials`, { method: 'DELETE', headers: asUser(f.user.id) })
      expect(del.status).toBe(200)
      expect(((await del.json()) as { status: { configured: boolean } }).status.configured).toBe(false)
      expect(
        f.env.db.get("SELECT id FROM audit_log WHERE action = 'auth.llm-credential-clear' LIMIT 1"),
      ).toBeTruthy()
    } finally {
      await api.close()
    }
  })

  it('校验：短 Key 400 / 非法 baseUrl 400 / 兼容模式 PUT 400', async () => {
    const f = makeFixture()
    const api = await mount(f)
    try {
      expect(
        (
          await fetch(`${api.url}/api/auth/llm-credentials`, {
            method: 'PUT',
            headers: asUser(f.user.id),
            body: JSON.stringify({ apiKey: 'short' }),
          })
        ).status,
      ).toBe(400)
      expect(
        (
          await fetch(`${api.url}/api/auth/llm-credentials`, {
            method: 'PUT',
            headers: asUser(f.user.id),
            body: JSON.stringify({ apiKey: 'sk-12345678', baseUrl: 'ftp://bad' }),
          })
        ).status,
      ).toBe(400)
    } finally {
      await api.close()
    }
    const compatApi = await mount(f, false)
    try {
      expect(
        (
          await fetch(`${compatApi.url}/api/auth/llm-credentials`, {
            method: 'PUT',
            headers: asUser(f.user.id),
            body: JSON.stringify({ apiKey: 'sk-12345678' }),
          })
        ).status,
      ).toBe(400)
    } finally {
      await compatApi.close()
    }
  })
})
