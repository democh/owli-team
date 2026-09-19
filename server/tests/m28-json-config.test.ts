/**
 * M28 测试：MCP JSON 直配 —— 解析（格式 / 变量展开 / 校验跳过 / 防误删白名单）、
 * 同步（增删改 / 冲突跳过 / 坏文件不清库 / 级联解绑 / secret 脱敏）、mtime 轮询、粘贴导入（ui 源）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { SecretVault } from '../src/connections/crypto.js'
import { McpJsonConfigService, expandVars, parseMcpJsonText } from '../src/mcp/json-config.js'
import type { McpRuntimeManager } from '../src/mcp/manager.js'
import { openDatabase } from '../src/store/db.js'
import { McpServerStore } from '../src/store/mcp-servers.js'
import { SessionStore } from '../src/store/sessions.js'
import { makeTmpDir } from './helpers.js'

const ENV = { TOKEN: 'tok-123' } as NodeJS.ProcessEnv

/** 测试环境：内存库 + 临时 mcp.json + 记录型 runtime 替身（connect/disconnect 仅留痕） */
function makeJsonEnv(pollMs = 0) {
  const db = openDatabase(':memory:', { memory: true, noExtensions: true })
  const vault = SecretVault.load({
    keyMaterial: 'c'.repeat(64),
    keyFile: path.join(makeTmpDir('ma-m28-vault-'), 'secrets.key'),
  })
  const store = new McpServerStore(db, vault)
  const sessions = new SessionStore(db)
  const connectCalls: string[] = []
  const disconnectCalls: string[] = []
  const published: Array<{ serverId?: string; action: string }> = []
  const runtime = {
    connect: async (id: string): Promise<void> => {
      connectCalls.push(id)
    },
    disconnect: async (id: string): Promise<void> => {
      disconnectCalls.push(id)
    },
  } as unknown as McpRuntimeManager
  const filePath = path.join(makeTmpDir('ma-m28-json-'), 'mcp.json')
  const service = new McpJsonConfigService({
    filePath,
    pollMs,
    store,
    runtime,
    publish: (payload) => published.push(payload),
    env: ENV,
  })
  const write = (text: unknown): void => {
    fs.writeFileSync(filePath, typeof text === 'string' ? text : JSON.stringify(text), 'utf8')
  }
  return { db, store, sessions, service, filePath, connectCalls, disconnectCalls, published, write }
}

async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('等待条件超时')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('M28：mcp.json 解析（纯函数）', () => {
  it('stdio / http / streamable-http / 缺省推断；扩展字段透传；未知字段告警', () => {
    const text = JSON.stringify({
      mcpServers: {
        stdio1: {
          command: 'npx',
          args: ['-y', 'pkg'],
          env: { TOKEN: '${TOKEN}' },
          cwd: '/tmp/work',
          timeoutMs: 5_000,
          approvalPolicy: 'never',
          readOnlyOverride: 'readonly',
          eagerLoad: true,
          displayName: '演示服务器',
          enabled: false,
          unknownX: 1,
        },
        http1: { type: 'http', url: 'https://a.example/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } },
        shttp: { type: 'streamable-http', url: 'https://b.example/mcp' },
        bycommand: { command: 'node' },
        byurl: { url: 'http://127.0.0.1:9999/mcp' },
      },
    })
    const result = parseMcpJsonText(text, ENV)
    expect(result.ok).toBe(true)
    expect(result.entries).toHaveLength(5)

    const stdio1 = result.entries.find((entry) => entry.name === 'stdio1')!
    expect(stdio1.transport).toBe('stdio')
    expect(stdio1.config.command).toBe('npx')
    expect(stdio1.config.args).toEqual(['-y', 'pkg'])
    expect(stdio1.config.cwd).toBe('/tmp/work')
    expect(stdio1.config.timeoutMs).toBe(5_000)
    expect(stdio1.config.approvalPolicy).toBe('never')
    expect(stdio1.config.readOnlyOverride).toBe('readonly')
    expect(stdio1.config.eagerLoad).toBe(true)
    expect(stdio1.displayName).toBe('演示服务器')
    expect(stdio1.enabled).toBe(false)
    expect(stdio1.secret).toEqual({ env: { TOKEN: 'tok-123' } })
    expect(result.warnings.some((w) => w.includes('unknownX'))).toBe(true)

    const http1 = result.entries.find((entry) => entry.name === 'http1')!
    expect(http1.transport).toBe('http')
    expect(http1.secret).toEqual({ headers: { Authorization: 'Bearer tok-123' } })
    expect(result.entries.find((entry) => entry.name === 'shttp')!.transport).toBe('http')
    expect(result.entries.find((entry) => entry.name === 'bycommand')!.transport).toBe('stdio')
    expect(result.entries.find((entry) => entry.name === 'byurl')!.transport).toBe('http')
    expect(result.entries.find((entry) => entry.name === 'bycommand')!.enabled).toBe(true)
  })

  it('变量展开：${VAR} 替换 / ${VAR:-default} 缺省 / 未定义无默认 → 条目跳过且名字计入 declaredNames', () => {
    const missing = new Set<string>()
    expect(expandVars('a-${TOKEN}-b', ENV, missing)).toBe('a-tok-123-b')
    expect(expandVars('${X:-fallback}', ENV, missing)).toBe('fallback')
    expect(expandVars('${X}', ENV, missing)).toBe('${X}')
    expect([...missing]).toEqual(['X'])

    const result = parseMcpJsonText(
      JSON.stringify({
        mcpServers: {
          defaults: { command: 'node', args: ['${MISSING_VAR:-fb}'] },
          broken: { command: 'node', args: ['${NO_SUCH_VAR}'] },
        },
      }),
      ENV,
    )
    expect(result.ok).toBe(true)
    expect(result.entries.map((entry) => entry.name)).toEqual(['defaults'])
    expect(result.entries[0]!.config.args).toEqual(['fb'])
    expect(result.errors.some((err) => err.includes('NO_SUCH_VAR'))).toBe(true)
    // 防误删：条目级解析失败的名字仍视为「文件已声明」
    expect(result.declaredNames).toContain('broken')
  })

  it('整体失败：JSON 语法错 / 根非对象 / 缺 mcpServers / mcpServers 非对象', () => {
    expect(parseMcpJsonText('{oops').ok).toBe(false)
    expect(parseMcpJsonText('[1,2]').ok).toBe(false)
    expect(parseMcpJsonText('{}').ok).toBe(false)
    expect(parseMcpJsonText('{}').errors[0]).toContain('mcpServers')
    expect(parseMcpJsonText('{"mcpServers": []}').ok).toBe(false)
  })

  it('条目级校验跳过：非法 slug / 非对象 / 不支持传输 / 缺必填 / 字段类型错误', () => {
    const result = parseMcpJsonText(
      JSON.stringify({
        mcpServers: {
          'Bad Name': { command: 'x' },
          notObject: 5,
          sseSrv: { type: 'sse', url: 'https://x.example/mcp' },
          noCmd: { type: 'stdio' },
          noUrl: { type: 'http' },
          both: { command: 'x', url: 'https://x.example/mcp' },
          badArgs: { command: 'x', args: [1, 2] },
          badEnv: { command: 'x', env: { A: 1 } },
          badProto: { url: 'ftp://x' },
          badTimeout: { command: 'x', timeoutMs: 10 },
          badPolicy: { command: 'x', approvalPolicy: 'maybe' },
          ok: { command: 'x' },
        },
      }),
      ENV,
    )
    expect(result.ok).toBe(true)
    expect(result.entries.map((entry) => entry.name)).toEqual(['ok'])
    expect(result.errors).toHaveLength(11)
    // 非法 slug 不入 declaredNames；合法名即使条目级解析失败也保留（防误删）
    expect(result.declaredNames).not.toContain('Bad Name')
    expect([...result.declaredNames].sort()).toEqual(['both', 'ok'])
  })
})

describe('M28：McpJsonConfigService 同步', () => {
  it('创建：source=json / 计数 / 连接触发 / 广播 / status 回读', async () => {
    const env = makeJsonEnv()
    env.write({
      mcpServers: {
        alpha: { command: 'node', args: ['a.mjs'] },
        beta: { url: 'https://b.example/mcp' },
      },
    })
    const result = await env.service.sync('manual')
    expect(result.ok).toBe(true)
    expect(result.trigger).toBe('manual')
    expect(result.summary).toEqual({ created: 2, updated: 0, removed: 0, skipped: 0 })

    const alpha = env.store.findByName('alpha')!
    const beta = env.store.findByName('beta')!
    expect(alpha.source).toBe('json')
    expect(alpha.transport).toBe('stdio')
    expect(beta.transport).toBe('http')
    expect(env.connectCalls.sort()).toEqual([alpha.id, beta.id].sort())
    expect(env.published.some((payload) => payload.action === 'json-synced')).toBe(true)

    const status = env.service.currentStatus()
    expect(status.exists).toBe(true)
    expect(status.lastResult).toBe('ok')
    expect([...status.entries].sort()).toEqual(['alpha', 'beta'])
    expect(status.summary.created).toBe(2)
    expect(status.file).toBe(env.filePath)
  })

  it('幂等：无变更二次同步零计数、无重连、无广播', async () => {
    const env = makeJsonEnv()
    env.write({ mcpServers: { alpha: { command: 'node' } } })
    await env.service.sync('manual')
    env.connectCalls.length = 0
    env.published.length = 0

    const again = await env.service.sync('poll')
    expect(again.summary).toEqual({ created: 0, updated: 0, removed: 0, skipped: 0 })
    expect(env.connectCalls).toEqual([])
    expect(env.published).toEqual([])
  })

  it('更新：config / secret 变更 → 更新 + 重连；enabled=false → 更新 + 断开', async () => {
    const env = makeJsonEnv()
    env.write({ mcpServers: { alpha: { command: 'node', args: ['v1'], env: { TOKEN: '${TOKEN}' } } } })
    await env.service.sync('manual')
    const id = env.store.findByName('alpha')!.id
    expect(env.store.getSecret(id)).toEqual({ env: { TOKEN: 'tok-123' } })

    env.connectCalls.length = 0
    env.write({ mcpServers: { alpha: { command: 'node', args: ['v2'], env: { TOKEN: 'changed' } } } })
    const updated = await env.service.sync('poll')
    expect(updated.summary.updated).toBe(1)
    expect(env.store.findByName('alpha')!.config.args).toEqual(['v2'])
    expect(env.store.getSecret(id)).toEqual({ env: { TOKEN: 'changed' } })
    expect(env.connectCalls).toEqual([id])

    env.disconnectCalls.length = 0
    env.write({
      mcpServers: { alpha: { command: 'node', args: ['v2'], env: { TOKEN: 'changed' }, enabled: false } },
    })
    const disabled = await env.service.sync('poll')
    expect(disabled.summary.updated).toBe(1)
    expect(env.store.findByName('alpha')!.enabled).toBe(false)
    expect(env.disconnectCalls).toEqual([id])
  })

  it('删除：文件移除 → 断开 + 移除 + 会话绑定级联；env/ui 源与保留项不受影响', async () => {
    const env = makeJsonEnv()
    const ui = env.store.create({ name: 'manual', transport: 'stdio', config: { command: 'x' }, source: 'ui' })
    env.write({ mcpServers: { alpha: { command: 'node' }, keep: { command: 'node' } } })
    await env.service.sync('manual')
    const alphaId = env.store.findByName('alpha')!.id
    const keepId = env.store.findByName('keep')!.id
    const session = env.sessions.create(['pm'], 'M28 json 级联')
    env.store.bind(session.id, alphaId)

    env.write({ mcpServers: { keep: { command: 'node' } } })
    const result = await env.service.sync('poll')
    expect(result.summary).toEqual({ created: 0, updated: 0, removed: 1, skipped: 0 })
    expect(env.store.findByName('alpha')).toBeUndefined()
    expect(env.disconnectCalls).toContain(alphaId)
    expect(env.store.isBound(session.id, alphaId)).toBe(false)
    expect(env.store.get(keepId)).toBeTruthy()
    expect(env.store.get(ui.id)).toBeTruthy()
  })

  it('冲突：同名非 json 源占用 → 跳过 + 告警，手动版零改动', async () => {
    const env = makeJsonEnv()
    const ui = env.store.create({
      name: 'alpha',
      displayName: '手动版',
      transport: 'stdio',
      config: { command: 'manual-cmd' },
      source: 'ui',
    })
    env.write({ mcpServers: { alpha: { command: 'json-cmd' } } })
    const result = await env.service.sync('manual')
    expect(result.summary).toEqual({ created: 0, updated: 0, removed: 0, skipped: 1 })
    expect(result.warnings.some((w) => w.includes('ui 源'))).toBe(true)
    expect(env.store.get(ui.id)!.config.command).toBe('manual-cmd')
    expect(env.connectCalls).toEqual([])
  })

  it('防误删：坏文件 / 文件缺失 / 条目级解析失败 均不动库', async () => {
    const env = makeJsonEnv()
    env.write({ mcpServers: { alpha: { command: 'node' }, beta: { command: 'node' } } })
    await env.service.sync('manual')
    const alphaId = env.store.findByName('alpha')!.id
    const betaId = env.store.findByName('beta')!.id

    // JSON 语法错 → 整次跳过 + 广播 json-sync-skipped
    fs.writeFileSync(env.filePath, '{oops', 'utf8')
    const bad = await env.service.sync('poll')
    expect(bad.ok).toBe(false)
    expect(bad.summary.removed).toBe(0)
    expect(env.store.get(alphaId)).toBeTruthy()
    expect(env.store.get(betaId)).toBeTruthy()
    expect(env.service.currentStatus().lastResult).toBe('skipped')
    expect(env.published.some((payload) => payload.action === 'json-sync-skipped')).toBe(true)

    // 文件缺失 → 同样跳过（绝不删库）
    fs.rmSync(env.filePath)
    const missing = await env.service.sync('poll')
    expect(missing.ok).toBe(false)
    expect(missing.missing).toBe(true)
    expect(env.store.get(alphaId)).toBeTruthy()
    expect(env.store.get(betaId)).toBeTruthy()

    // 条目级失败但名字已声明 → 不视为删除；合法条目照常同步
    env.write({ mcpServers: { alpha: { url: 'ftp://bad' }, beta: { command: 'node' } } })
    const entryLevel = await env.service.sync('poll')
    expect(entryLevel.ok).toBe(true)
    expect(entryLevel.summary.removed).toBe(0)
    expect(entryLevel.errors).toHaveLength(1)
    expect(env.store.get(alphaId)!.config.command).toBe('node')
  })

  it('secret：加密落库、明文不回传（定义视图脱敏）', async () => {
    const env = makeJsonEnv()
    env.write({ mcpServers: { secured: { command: 'node', env: { API_TOKEN: '${TOKEN}' } } } })
    await env.service.sync('manual')
    const server = env.store.findByName('secured')!
    expect(server.secretSet).toBe(true)
    expect(JSON.stringify(env.store.list())).not.toContain('tok-123')
    expect(env.store.getSecret(server.id)).toEqual({ env: { API_TOKEN: 'tok-123' } })
  })

  it('轮询：mtime 变化触发自动同步；stop 后不再同步', async () => {
    const env = makeJsonEnv(30)
    env.service.start()
    env.write({ mcpServers: { late: { command: 'node' } } })
    await waitFor(() => Boolean(env.store.findByName('late')))
    env.service.stop()
    expect(env.store.findByName('late')!.source).toBe('json')

    env.write({ mcpServers: { late: { command: 'node' }, after: { command: 'node' } } })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(env.store.findByName('after')).toBeUndefined()
  })
})

describe('M28：粘贴导入（ui 源）', () => {
  it('创建为 ui 源；同名冲突跳过并报告；不触碰 json 源；坏 JSON 零创建', async () => {
    const env = makeJsonEnv()
    env.write({ mcpServers: { fromfile: { command: 'node' } } })
    await env.service.sync('manual')

    const outcome = await env.service.importAsUi(
      JSON.stringify({
        mcpServers: {
          imported1: { command: 'node', args: ['i.mjs'] },
          fromfile: { command: 'node' },
          imported2: { url: 'https://i.example/mcp' },
        },
      }),
    )
    expect(outcome.created).toEqual(['imported1', 'imported2'])
    expect(outcome.skipped).toHaveLength(1)
    expect(outcome.skipped[0]!.name).toBe('fromfile')
    expect(outcome.skipped[0]!.reason).toContain('已存在')
    expect(env.store.findByName('imported1')!.source).toBe('ui')
    expect(env.store.findByName('fromfile')!.source).toBe('json')
    expect(env.published.some((payload) => payload.action === 'json-imported')).toBe(true)

    const bad = await env.service.importAsUi('{oops')
    expect(bad.created).toEqual([])
    expect(bad.errors.length).toBeGreaterThan(0)
  })
})
