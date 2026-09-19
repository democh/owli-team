/**
 * M5 工具与 Harness 测试：
 * - 真中断：超时/sleep 后写工具不遗留文件（含临时文件）；外部取消 → AbortError 不重试；取消态写入直接拒绝；
 * - 幂等缓存：只读同参数命中，缓存命中标注，写类执行后整体失效；
 * - 并行/串行（引擎级）：相邻只读并行、写类串行、结果按调用顺序；
 * - apply_patch：多文件（修改+新建）成功；3 类错位（文件不存在 / 上下文不匹配 / hunk 越界）可修正错误；
 * - 敏感文件：读写拒绝 + ALLOW_SENSITIVE 放行 + glob/grep 剔除；
 * - glob / grep / write_file dry-run / run_command 白名单；
 * - web_fetch：白名单域名（本地假服务器）、未配置禁用、重定向域名校验；
 * - tool_metrics：聚合与引擎落库。
 */
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { abortError, type ChatRequest, type LlmChunk, type LlmToolCall } from '../src/llm/provider.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { ToolMetricsStore } from '../src/store/metrics.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { resetAntiBotState } from '../src/tools/http.js'
import { ToolRegistry, toolAbortError, type ToolRuntime, type TodoItem } from '../src/tools/registry.js'
import { writeFileAtomic } from '../src/util/paths.js'
import { makeEnv, makeTmpDir, routePassThrough, sendAndWait, waitRunFinished } from './helpers.js'

/** 独立工具运行时（与 tools.test 相同形态，补齐 M5 新增字段） */
function makeToolEnv(): { registry: ToolRegistry; runtime: ToolRuntime; workspace: string } {
  const cfg = loadConfig()
  const artifacts = new ArtifactStore(makeTmpDir('ma-m5-art-'))
  const sessionId = 's1'
  const workspace = artifacts.ensureSessionDir(sessionId)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(path.join(makeTmpDir('ma-m5-db-'), 'app.db'))
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    'M5 测试',
    JSON.stringify(['pm']),
    now,
    now,
  )
  const memory = new MemoryStore(db)
  const tasks = new TaskStore(db)
  const todos: TodoItem[] = []
  const runtime: ToolRuntime = {
    sessionId,
    runId: 'r1',
    agentId: 'pm',
    workspace,
    artifacts,
    skills,
    memory,
    tasks,
    participants: [{ id: 'pm', name: '费利' }],
    todos,
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: () => ({ ok: false, error: '测试未提供技能' }),
  }
  return { registry: createToolRegistry(cfg), runtime, workspace }
}

// ---------- M5：真中断与原子写 ----------

describe('M5：真中断与原子写', () => {
  it('超时中断：sleep 后写的测试工具不遗留目标文件与临时文件', async () => {
    const { runtime, workspace } = makeToolEnv()
    const registry = new ToolRegistry(25)
    registry.register({
      name: 'sleep_write',
      description: '睡 120ms 后原子写文件',
      parameters: { type: 'object' },
      schema: z.object({}),
      async execute(_args, ctx) {
        await new Promise((r) => setTimeout(r, 120))
        writeFileAtomic(path.join(ctx.workspace, 'late.txt'), 'late', ctx.signal)
        return { ok: true, summary: 'written' }
      },
    })

    const result = await registry.execWithAbort('sleep_write', {}, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('超时')

    // 等工具从 sleep 中醒来（此时 signal 已 abort）：写入被拒，临时文件被清理
    await new Promise((r) => setTimeout(r, 260))
    expect(fs.existsSync(path.join(workspace, 'late.txt'))).toBe(false)
    expect(fs.readdirSync(workspace).filter((f) => f.includes('.tmp-'))).toEqual([])
  })

  it('外部取消：signal abort → 工具收到中断并抛 AbortError（不重试）', async () => {
    const { runtime } = makeToolEnv()
    const registry = new ToolRegistry(5_000)
    let executions = 0
    registry.register({
      name: 'hang',
      description: '挂起直到被中断',
      parameters: { type: 'object' },
      schema: z.object({}),
      async execute(_args, ctx) {
        executions++
        await new Promise<void>((resolve) => {
          if (ctx.signal?.aborted) return resolve()
          ctx.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        throw toolAbortError()
      },
    })

    const ctrl = new AbortController()
    const pending = registry.execWithAbort('hang', {}, runtime, ctrl.signal)
    setTimeout(() => ctrl.abort(), 30)
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(executions).toBe(1) // 中断不做失败重试
  })

  it('write_file：已取消的 signal → 直接拒绝且不落盘', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(
      registry.execWithAbort('write_file', { path: 'x.txt', content: 'x' }, runtime, ctrl.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(fs.existsSync(path.join(workspace, 'x.txt'))).toBe(false)
  })
})

// ---------- M5：幂等缓存 ----------

describe('M5：幂等缓存（只读 60s）', () => {
  it('只读工具同参数命中缓存并标注；写类执行后缓存整体失效', async () => {
    const { runtime } = makeToolEnv()
    const registry = new ToolRegistry(5_000)
    let reads = 0
    registry.register({
      name: 'cached_read',
      readOnly: true,
      description: '计数只读工具',
      parameters: { type: 'object' },
      schema: z.object({ q: z.string() }),
      async execute() {
        reads++
        return { ok: true, summary: `结果-${reads}` }
      },
    })
    registry.register({
      name: 'touch_write',
      description: '写类工具（触发缓存失效）',
      parameters: { type: 'object' },
      schema: z.object({}),
      async execute() {
        return { ok: true, summary: 'wrote' }
      },
    })

    const first = await registry.execWithAbort('cached_read', { q: 'a' }, runtime)
    expect(first.summary).toBe('结果-1')
    const second = await registry.execWithAbort('cached_read', { q: 'a' }, runtime)
    expect(second.summary).toContain('缓存命中')
    expect(reads).toBe(1)

    await registry.execWithAbort('cached_read', { q: 'b' }, runtime)
    expect(reads).toBe(2)

    await registry.execWithAbort('touch_write', {}, runtime)
    const afterWrite = await registry.execWithAbort('cached_read', { q: 'a' }, runtime)
    expect(reads).toBe(3)
    expect(afterWrite.summary).not.toContain('缓存命中')
  })
})

// ---------- M5：并行与串行（引擎级） ----------

describe('M5：并行与串行（引擎级）', () => {
  it('相邻只读并行执行、写类串行；工具记录保持调用顺序', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])

    const marks: Array<{ name: string; phase: 'start' | 'end'; t: number }> = []
    const registerTimed = (name: string, readOnly: boolean, delay: number): void => {
      env.tools.register({
        name,
        readOnly,
        description: `计时工具 ${name}`,
        parameters: { type: 'object' },
        schema: z.object({}),
        async execute() {
          marks.push({ name, phase: 'start', t: Date.now() })
          await new Promise((r) => setTimeout(r, delay))
          marks.push({ name, phase: 'end', t: Date.now() })
          return { ok: true, summary: `${name} ok` }
        },
      })
    }
    registerTimed('slow_read_a', true, 120)
    registerTimed('slow_read_b', true, 120)
    registerTimed('slow_write_a', false, 60)
    registerTimed('slow_write_b', false, 60)

    const calls: LlmToolCall[] = [
      { id: 'c1', name: 'slow_read_a', arguments: '{}' },
      { id: 'c2', name: 'slow_read_b', arguments: '{}' },
      { id: 'c3', name: 'slow_write_a', arguments: '{}' },
      { id: 'c4', name: 'slow_write_b', arguments: '{}' },
    ]
    let round = 0
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req: ChatRequest, signal: AbortSignal) {
      // M48：平台路由请求直通（不占 round）
      const route = routePassThrough(req)
      if (route) {
        for (const chunk of route) yield chunk
        return
      }
      const chunks: LlmChunk[] =
        round++ === 0
          ? [{ type: 'tool_calls', calls }, { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } }, { type: 'done' }]
          : [{ type: 'text', text: '完成。\n@用户' }, { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } }, { type: 'done' }]
      for (const chunk of chunks) {
        if (signal.aborted) throw abortError()
        yield chunk
      }
    }

    const message = env.sessions.appendMessage({ sessionId: session.id, role: 'user', content: '跑一组工具', mentions: [], status: 'complete' })
    const { runId } = env.engine.launch(session.id, message.id)
    await waitRunFinished(env.engine, runId)

    const agent = env.sessions.messages(session.id).find((m) => m.role === 'agent')!
    // 记录按模型调用顺序（重建顺序），状态全部 ok
    expect(agent.toolCalls?.map((c) => c.name)).toEqual(['slow_read_a', 'slow_read_b', 'slow_write_a', 'slow_write_b'])
    expect(agent.toolCalls?.every((c) => c.status === 'ok')).toBe(true)

    const mark = (name: string, phase: 'start' | 'end') =>
      marks.find((m) => m.name === name && m.phase === phase)!.t
    // 只读并行：两个只读工具执行区间重叠
    expect(mark('slow_read_b', 'start')).toBeLessThan(mark('slow_read_a', 'end'))
    expect(mark('slow_read_a', 'start')).toBeLessThan(mark('slow_read_b', 'end'))
    // 写类串行：写工具在只读批次结束后才开始，且写与写不重叠
    const readsDone = Math.max(mark('slow_read_a', 'end'), mark('slow_read_b', 'end'))
    expect(mark('slow_write_a', 'start')).toBeGreaterThanOrEqual(readsDone)
    expect(mark('slow_write_b', 'start')).toBeGreaterThanOrEqual(mark('slow_write_a', 'end'))
  })
})

// ---------- M5：apply_patch ----------

describe('M5：apply_patch', () => {
  it('多文件补丁：修改已有文件 + /dev/null 新建，一次写入', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'line1\nline2\nline3\n')
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+LINE-TWO',
      ' line3',
      '--- /dev/null',
      '+++ b/b.txt',
      '@@ -0,0 +1,2 @@',
      '+hello',
      '+world',
      '',
    ].join('\n')

    const result = await registry.execute('apply_patch', { patch }, runtime)
    expect(result.ok).toBe(true)
    expect(result.artifacts?.sort()).toEqual(['a.txt', 'b.txt'])
    expect(result.detail).toContain('修改 a.txt（+1/-1）')
    expect(result.detail).toContain('新建 b.txt（+2/-0）')
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toContain('LINE-TWO')
    expect(fs.readFileSync(path.join(workspace, 'b.txt'), 'utf8')).toBe('hello\nworld\n')
  })

  it('错位 1：目标文件不存在 → 可修正错误（提示 write_file / 核对路径）', async () => {
    const { registry, runtime } = makeToolEnv()
    const patch = ['--- a/missing.txt', '+++ b/missing.txt', '@@ -1 +1 @@', '-old', '+new', ''].join('\n')
    const result = await registry.execute('apply_patch', { patch }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('目标文件不存在')
    expect(result.detail).toContain('/dev/null')
  })

  it('错位 2：上下文不匹配 → 提示相似内容实际行号与 read_file 续读', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'line1\nline2\nline3\n')
    const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -1,2 +1,2 @@', ' line1', '-nonexistent-line', '+changed', ''].join('\n')
    const result = await registry.execute('apply_patch', { patch }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('上下文不匹配')
    expect(result.detail).toContain('第 1 行附近')
    expect(result.detail).toContain('read_file')
    // 文件未被改动
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('line1\nline2\nline3\n')
  })

  it('错位 3：hunk 行号越界 → 明确报越界并提示重新生成', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'line1\nline2\nline3\n')
    const patch = ['--- a/a.txt', '+++ b/a.txt', '@@ -50,2 +50,2 @@', ' line1', '-line2', '+LINE', ''].join('\n')
    const result = await registry.execute('apply_patch', { patch }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('定位越界')
    expect(result.detail).toContain('read_file')
  })

  it('新建补丁撞已有文件 → 拒绝并提示改用修改补丁', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'exists\n')
    const patch = ['--- /dev/null', '+++ b/a.txt', '@@ -0,0 +1 @@', '+new', ''].join('\n')
    const result = await registry.execute('apply_patch', { patch }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('已存在')
    expect(fs.readFileSync(path.join(workspace, 'a.txt'), 'utf8')).toBe('exists\n')
  })
})

// ---------- M5：敏感文件策略 ----------

describe('M5：敏感文件策略', () => {
  it('read_file / write_file 默认拒绝 .env；ALLOW_SENSITIVE=true 放行', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1')

    const read = await registry.execute('read_file', { path: '.env' }, runtime)
    expect(read.ok).toBe(false)
    expect(read.summary).toContain('敏感文件已受保护')

    const write = await registry.execute('write_file', { path: '.env', content: 'x' }, runtime)
    expect(write.ok).toBe(false)
    expect(write.summary).toContain('敏感文件已受保护')

    const allowed = await registry.execute('read_file', { path: '.env' }, { ...runtime, allowSensitive: true })
    expect(allowed.ok).toBe(true)
    expect(allowed.detail).toContain('SECRET=1')
  })

  it('glob / grep 结果剔除敏感文件（id_rsa）', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'ok.txt'), 'SECRET 出现在这里\n第二行')
    fs.writeFileSync(path.join(workspace, 'id_rsa'), 'SECRET 私钥内容')
    fs.writeFileSync(path.join(workspace, '.env'), 'SECRET=1')

    const glob = await registry.execute('glob', { pattern: '**/*' }, runtime)
    expect(glob.ok).toBe(true)
    expect(glob.detail).toContain('ok.txt')
    expect(glob.detail).not.toContain('id_rsa')
    expect(glob.detail).not.toContain('.env')

    const grep = await registry.execute('grep', { pattern: 'SECRET' }, runtime)
    expect(grep.ok).toBe(true)
    expect(grep.detail).toContain('ok.txt')
    expect(grep.detail).not.toContain('id_rsa')
    expect(grep.detail).not.toContain('.env')
  })
})

// ---------- M5：新增工具能力 ----------

describe('M5：新增工具能力', () => {
  it('glob：模式匹配 + 默认忽略 node_modules + ignore 参数', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.mkdirSync(path.join(workspace, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true })
    fs.writeFileSync(path.join(workspace, 'docs', 'a.md'), '# a')
    fs.writeFileSync(path.join(workspace, 'docs', 'b.md'), '# b')
    fs.writeFileSync(path.join(workspace, 'node_modules', 'x', 'c.md'), '# c')
    fs.writeFileSync(path.join(workspace, 'main.ts'), 'export {}')

    const md = await registry.execute('glob', { pattern: '**/*.md' }, runtime)
    expect(md.ok).toBe(true)
    expect(md.detail).toContain('docs/a.md')
    expect(md.detail).toContain('docs/b.md')
    expect(md.detail).not.toContain('node_modules')

    const ignored = await registry.execute('glob', { pattern: '**/*.md', ignore: ['docs/**'] }, runtime)
    expect(ignored.ok).toBe(true)
    expect(ignored.detail).not.toContain('docs/a.md')
  })

  it('grep：正则命中 + context 上下文行 + glob 过滤 + 非法正则报错', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    fs.writeFileSync(path.join(workspace, 'ok.txt'), 'alpha\nbeta\ngamma\nneedle here\nomega')
    fs.writeFileSync(path.join(workspace, 'other.txt'), 'alpha only')

    const plain = await registry.execute('grep', { pattern: 'needle' }, runtime)
    expect(plain.ok).toBe(true)
    expect(plain.detail).toContain('ok.txt:4:')
    expect(plain.detail).toContain('needle here')

    const withCtx = await registry.execute('grep', { pattern: 'needle', context: 1 }, runtime)
    expect(withCtx.ok).toBe(true)
    expect(withCtx.detail).toContain('ok.txt:3-')
    expect(withCtx.detail).toContain('ok.txt:5-')

    const filtered = await registry.execute('grep', { pattern: 'alpha', glob: '**/other.txt' }, runtime)
    expect(filtered.ok).toBe(true)
    expect(filtered.detail).toContain('other.txt')
    expect(filtered.detail).not.toContain('ok.txt')

    const bad = await registry.execute('grep', { pattern: '[' }, runtime)
    expect(bad.ok).toBe(false)
    expect(bad.summary).toContain('正则表达式无效')
  })

  it('write_file dry-run：返回 diff 预览不写入；随后正式覆盖', async () => {
    const { registry, runtime, workspace } = makeToolEnv()
    await registry.execute('write_file', { path: 'a.md', content: 'v1\n' }, runtime)

    const dry = await registry.execute('write_file', { path: 'a.md', content: 'v2\n', dry_run: true }, runtime)
    expect(dry.ok).toBe(true)
    expect(dry.summary).toContain('dry-run')
    expect(dry.detail).toContain('未写入')
    expect(fs.readFileSync(path.join(workspace, 'a.md'), 'utf8')).toBe('v1\n')

    const real = await registry.execute('write_file', { path: 'a.md', content: 'v2\n' }, runtime)
    expect(real.ok).toBe(true)
    expect(real.summary).toContain('已覆盖')
    expect(fs.readFileSync(path.join(workspace, 'a.md'), 'utf8')).toBe('v2\n')
  })

  it('run_command：ALLOWED_COMMANDS 覆盖内置白名单', async () => {
    const { registry, runtime } = makeToolEnv()
    const rt = { ...runtime, allowRunCommand: true, allowedCommands: ['echo '] }
    const ok = await registry.execute('run_command', { command: 'echo hello-m5' }, rt)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('hello-m5')
    const denied = await registry.execute('run_command', { command: 'node -v' }, rt)
    expect(denied.ok).toBe(false)
    expect(denied.summary).toContain('白名单')
  })
})

// ---------- M5：web_fetch（任意 http/https URL，无访问限制） ----------

describe('M5：web_fetch', () => {
  beforeEach(() => {
    resetAntiBotState()
  })

  it('任意域名可抓取（无白名单）→ 抓取并转纯文本', async () => {
    const { registry, runtime } = makeToolEnv()

    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><body><h1>工具文档</h1><p>正文内容在这里</p><script>bad()</script></body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      // ADR 0136：无白名单 / 无启用门控——任意 http/https 地址均可抓取
      const fetched = await registry.execute('web_fetch', { url: `http://127.0.0.1:${port}/doc` }, runtime)
      expect(fetched.ok).toBe(true)
      expect(fetched.detail).toContain('工具文档')
      expect(fetched.detail).toContain('正文内容在这里')
      expect(fetched.detail).not.toContain('bad()')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('响应超限：content-length 声明 / chunked 流式兜底 → 拒绝（审核 M-5）', async () => {
    const { registry, runtime } = makeToolEnv()
    const big = 'x'.repeat(600 * 1024) // 600KB > 512KB 上限
    const server = http.createServer((req, res) => {
      res.on('error', () => undefined) // 客户端超限取消后写响应可能报错，静默
      if (req.url === '/declared') {
        res.writeHead(200, { 'content-type': 'text/plain', 'content-length': String(big.length) })
        res.end(big)
      } else {
        // 不声明 content-length（chunked）→ 流式累计超限兜底
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end(big)
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const declared = await registry.execute('web_fetch', { url: `http://127.0.0.1:${port}/declared` }, runtime)
      expect(declared.ok).toBe(false)
      expect(declared.summary).toContain('响应过大')
      const chunked = await registry.execute('web_fetch', { url: `http://127.0.0.1:${port}/chunked` }, runtime)
      expect(chunked.ok).toBe(false)
      expect(chunked.summary).toContain('响应过大')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('反爬增强：GBK 页面正确解码 + 风控页拦截提示（本地假服务器）', async () => {
    const { registry, runtime } = makeToolEnv()
    const gbkPage = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body><h1>', 'latin1'),
      Buffer.from([0xb0, 0xd9, 0xb6, 0xc8]), // “百度”的 GBK 编码
      Buffer.from('</h1></body></html>', 'latin1'),
    ])
    const server = http.createServer((req, res) => {
      if (req.url === '/gbk') {
        res.writeHead(200, { 'content-type': 'text/html; charset=gbk' })
        res.end(gbkPage)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html><head><title>百度安全验证</title></head><body>请进行验证</body></html>')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const port = (server.address() as AddressInfo).port
      const gbk = await registry.execute('web_fetch', { url: `http://127.0.0.1:${port}/gbk` }, runtime)
      expect(gbk.ok).toBe(true)
      expect(gbk.detail).toContain('百度')

      const blocked = await registry.execute('web_fetch', { url: `http://127.0.0.1:${port}/blocked` }, runtime)
      expect(blocked.ok).toBe(false)
      expect(blocked.summary).toContain('风控')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

// ---------- M5：tool_metrics 观测 ----------

describe('M5：tool_metrics 观测', () => {
  it('ToolMetricsStore：按工具聚合次数 / 失败率 / 平均耗时', () => {
    const env = makeEnv()
    const store = new ToolMetricsStore(env.db)
    store.record({ toolName: 'grep', ok: true, durationMs: 20, sessionId: 's1', agentId: 'pm' })
    store.record({ toolName: 'grep', ok: true, durationMs: 40, sessionId: 's1' })
    store.record({ toolName: 'grep', ok: false, durationMs: 60, sessionId: 's1' })
    store.record({ toolName: 'glob', ok: true, durationMs: 10, sessionId: 's1' })

    const rows = store.summary()
    const grep = rows.find((r) => r.toolName === 'grep')!
    expect(grep.calls).toBe(3)
    expect(grep.failures).toBe(1)
    expect(grep.failureRate).toBeCloseTo(0.333, 2)
    expect(grep.avgDurationMs).toBe(40)
    expect(grep.maxDurationMs).toBe(60)
    expect(rows.find((r) => r.toolName === 'glob')?.calls).toBe(1)
  })

  it('引擎跑一次含工具的 Run → tool_metrics 落库且无失败', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    await sendAndWait(env, session.id, '做一个登录页')

    const rows = env.db.all<{ tool_name: string; ok: number; duration_ms: number }>(
      'SELECT tool_name, ok, duration_ms FROM tool_metrics',
    )
    const names = rows.map((r) => r.tool_name)
    expect(names).toContain('write_todos')
    expect(names).toContain('write_file')
    expect(rows.every((r) => r.ok === 1)).toBe(true)
    expect(rows.every((r) => r.duration_ms >= 0)).toBe(true)
  })
})
