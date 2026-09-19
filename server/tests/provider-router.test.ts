/**
 * 多 Provider 测试：模型服务（llm 连接）按模型名路由。
 * - LlmProviderRouter：未指定 model / 未命中清单 / 停用连接 → 直通底层；
 *   命中清单 → 连接凭据 createFor（缓存复用 + updatedAt 失效重建）；同名以创建序先者为准；
 *   Mock 模式直通；
 * - PromptLibrary / engine：front-matter model 直传请求（命中路由由 provider 层解析）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SecretVault } from '../src/connections/crypto.js'
import type { ChatRequest, LlmChunk, LlmProvider } from '../src/llm/provider.js'
import { LlmProviderRouter, apiKeyOf, normalizeLlmConfig } from '../src/llm/provider-router.js'
import { ConnectionStore } from '../src/store/connections.js'
import { appendUserMessage, makeEnv, makeTmpDir, waitRunFinished } from './helpers.js'

/** 假 provider：按输出文本标注来源（base / inner） */
function fakeProvider(tag: string, hits: { count: number }): LlmProvider {
  return {
    async *chatStream(): AsyncIterable<LlmChunk> {
      hits.count += 1
      yield { type: 'text', text: tag }
    },
  }
}

/** 捕获型假 provider：记录收到的模型名（验证前缀改写） */
function captureProvider(tag: string, seen: string[]): LlmProvider {
  return {
    async *chatStream(req: ChatRequest): AsyncIterable<LlmChunk> {
      seen.push(req.model ?? '')
      yield { type: 'text', text: tag }
    },
  }
}

async function collect(provider: LlmProvider, req: Partial<ChatRequest>): Promise<string> {
  const full = {
    system: 's',
    messages: [{ role: 'user', content: 'hi' }],
    meta: { agentId: 'pm', participantIds: [] },
    ...req,
  } as ChatRequest
  let out = ''
  for await (const chunk of provider.chatStream(full, new AbortController().signal)) {
    if (chunk.type === 'text') out += chunk.text
  }
  return out
}

function makeFixture() {
  const env = makeEnv()
  const vault = SecretVault.load({ keyFile: path.join(env.cfg.dataDir, 'secrets.key') })
  const connections = new ConnectionStore(env.db, vault)
  return { env, connections }
}

describe('多 Provider：LlmProviderRouter 按模型名路由', () => {
  it('命中模型清单 → 连接凭据 createFor（缓存复用 / updatedAt 失效）；未命中直通', async () => {
    const f = makeFixture()
    const conn = f.connections.create({
      name: 'DeepSeek 官方',
      kind: 'llm',
      config: { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash', 'deepseek-v4-pro'] },
      secret: { apiKey: 'sk-provider-12345678' },
    })
    f.connections.create({
      name: '停用服务',
      kind: 'llm',
      config: { baseUrl: 'https://stale.example.com/v1', models: ['stale-model'] },
      enabled: false,
    })
    const baseHits = { count: 0 }
    const created: Array<{ config: { baseUrl: string; apiKey: string }; connectionId: string }> = []
    const router = new LlmProviderRouter({
      base: fakeProvider('base', baseHits),
      cfg: f.env.cfg,
      connections: f.connections,
      createFor: (config, connectionId) => {
        created.push({ config, connectionId })
        return fakeProvider(`inner-${created.length}`, { count: 0 })
      },
    })

    // 未指定 model / 未命中清单 / 停用服务清单 → 直通底层
    expect(await collect(router, {})).toBe('base')
    expect(await collect(router, { model: 'gpt-5.2' })).toBe('base')
    expect(await collect(router, { model: 'stale-model' })).toBe('base')
    expect(baseHits.count).toBe(3)

    // 命中清单 → 连接凭据
    expect(await collect(router, { model: 'deepseek-v4-pro' })).toBe('inner-1')
    expect(created[0]).toEqual({
      config: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-provider-12345678' },
      connectionId: conn.id,
    })
    // 同连接另一模型：缓存复用（不再 createFor）
    expect(await collect(router, { model: 'deepseek-flash' })).toBe('inner-1')
    expect(created).toHaveLength(1)

    // updatedAt 变更 → 重建（下一次调用重新 createFor）
    await new Promise((r) => setTimeout(r, 5))
    f.connections.update(conn.id, { config: { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-v4-pro'] } })
    expect(await collect(router, { model: 'deepseek-v4-pro' })).toBe('inner-2')
    expect(created[1]?.connectionId).toBe(conn.id)
  })

  it('同名模型被多服务声明 → 以创建序先者为准', async () => {
    const f = makeFixture()
    const first = f.connections.create({
      name: '先建',
      kind: 'llm',
      config: { baseUrl: 'https://a.example.com/v1', models: ['shared-model'] },
    })
    f.connections.create({
      name: '后建',
      kind: 'llm',
      config: { baseUrl: 'https://b.example.com/v1', models: ['shared-model'] },
    })
    const created: string[] = []
    const router = new LlmProviderRouter({
      base: fakeProvider('base', { count: 0 }),
      cfg: f.env.cfg,
      connections: f.connections,
      createFor: (_config, id) => {
        created.push(id)
        return fakeProvider('inner', { count: 0 })
      },
    })
    expect(router.resolveForModel('shared-model')?.connection.id).toBe(first.id)
    expect(await collect(router, { model: 'shared-model' })).toBe('inner')
    expect(created).toEqual([first.id])
  })

  it('前缀形式「服务名/模型名」→ 经对应服务且端点收到去前缀裸名', async () => {
    const f = makeFixture()
    const conn = f.connections.create({
      name: 'deepseek',
      kind: 'llm',
      config: { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash'] },
      secret: { apiKey: 'sk-provider-12345678' },
    })
    const seen: string[] = []
    const created: Array<{ config: { baseUrl: string; apiKey: string }; connectionId: string }> = []
    const router = new LlmProviderRouter({
      base: fakeProvider('base', { count: 0 }),
      cfg: f.env.cfg,
      connections: f.connections,
      createFor: (config, connectionId) => {
        created.push({ config, connectionId })
        return captureProvider('inner', seen)
      },
    })

    expect(await collect(router, { model: 'deepseek/deepseek-flash' })).toBe('inner')
    expect(created[0]?.connectionId).toBe(conn.id)
    // 端点收到去前缀的裸模型名
    expect(seen).toEqual(['deepseek-flash'])

    // 大小写不敏感兜底（前缀 'DeepSeek' → 连接 'deepseek'）
    expect(router.resolveForModel('DeepSeek/deepseek-flash')?.connection.id).toBe(conn.id)
    // 前缀未命中 / 无前缀无清单 → undefined（透传）
    expect(router.resolveForModel('unknown/model')).toBeUndefined()
    expect(router.resolveForModel('deepseek/')).toBeUndefined()

    // 清单精确匹配优先：含「/」的模型名直接写在清单时按全串引用（upstream 保留全串）
    f.connections.update(conn.id, { config: { baseUrl: 'https://api.deepseek.com/v1', models: ['qwen/qwen2.5'] } })
    const hit = router.resolveForModel('qwen/qwen2.5')
    expect(hit?.connection.id).toBe(conn.id)
    expect(hit?.upstreamModel).toBe('qwen/qwen2.5')
  })

  it('Mock 模式恒直通底层（凭据仅生产路径生效）', async () => {
    const f = makeFixture()
    f.connections.create({
      name: 'DeepSeek 官方',
      kind: 'llm',
      config: { baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-flash'] },
      secret: { apiKey: 'sk-provider-12345678' },
    })
    const baseHits = { count: 0 }
    const router = new LlmProviderRouter({
      base: fakeProvider('base', baseHits),
      cfg: { ...f.env.cfg, llmMock: true },
      connections: f.connections,
      createFor: () => fakeProvider('inner', { count: 0 }),
    })
    expect(await collect(router, { model: 'deepseek-flash' })).toBe('base')
    expect(baseHits.count).toBe(1)
  })

  it('normalizeLlmConfig / apiKeyOf：宽容归一（baseUrl 缺失无效；模型过滤空白）', () => {
    expect(normalizeLlmConfig({})).toBeUndefined()
    expect(normalizeLlmConfig({ baseUrl: '  ' })).toBeUndefined()
    expect(normalizeLlmConfig({ baseUrl: ' https://x/v1 ', models: ['a', '', 2] })).toEqual({
      baseUrl: 'https://x/v1',
      models: ['a'],
    })
    expect(apiKeyOf({ apiKey: 'sk-1' })).toBe('sk-1')
    expect(apiKeyOf(undefined)).toBe('')
  })
})

describe('多 Provider：Agent model 直传（front-matter → engine 请求）', () => {
  it('临时资产目录：agent.model 进入 engine 请求；temperature 语义保持', async () => {
    const dir = makeTmpDir('ma-prov-')
    const agentsDir = path.join(dir, 'agents')
    fs.mkdirSync(path.join(agentsDir, 'testscene', 'writer'), { recursive: true })
    fs.writeFileSync(path.join(agentsDir, 'testscene', '_group.yaml'), 'id: testscene\nname: 测试场景\n')
    fs.writeFileSync(
      path.join(agentsDir, 'testscene', 'writer', 'AGENT.md'),
      `---
id: writer
name: 文手
role: 写手
handoff: []
model: deepseek/deepseek-v4-pro
temperature: 0.4
---

## 职责

测试正文。
`,
    )
    const env = makeEnv({ agentsDir })
    expect(env.prompts.get('writer')?.model).toBe('deepseek/deepseek-v4-pro')

    const requests: ChatRequest[] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req: ChatRequest) {
      requests.push(req)
      yield { type: 'text', text: '收到。@用户 完成。' }
      yield { type: 'done' }
    }

    const session = env.sessions.create(['writer'])
    const message = appendUserMessage(env, session.id, '@writer 写一段')
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.model).toBe('deepseek/deepseek-v4-pro')
    expect(requests[0]?.temperature).toBe(0.4)
  })
})
