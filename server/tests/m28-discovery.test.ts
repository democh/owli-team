/**
 * M28 测试：工具发现内核 —— 分词（中英混排）/ BM25 / 词法打分（name 权重 + 子串强先验）/
 * 混合检索服务（嵌入融合 / 静默退化 / 向量缓存）/ 发现区块渲染 / tool_search 工具本体。
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import {
  bm25Scores,
  groupOf,
  lexicalScores,
  renderDiscoveryBlock,
  toActivation,
  tokenize,
  ToolDiscoveryService,
} from '../src/tools/discovery.js'
import type { ToolEmbedder, ToolSearchEntry } from '../src/tools/discovery.js'
import type { ToolRuntime } from '../src/tools/registry.js'

const entry = (
  name: string,
  description: string,
  source: 'builtin' | 'mcp' = 'builtin',
  server?: string,
): ToolSearchEntry => ({ name, description, source, server, category: '' })

describe('M28：分词（中英混排，无外部依赖）', () => {
  it('CJK：单字 + 相邻双字（2-gram）', () => {
    expect(tokenize('查询数据库')).toEqual(['查', '询', '数', '据', '库', '查询', '询数', '数据', '据库'])
  })

  it('拉丁：按词小写 + 复合名（_ . - /）拆分子词', () => {
    expect(tokenize('db_query')).toEqual(['db_query', 'db', 'query'])
    expect(tokenize('docs/需求.md')).toContain('docs')
    expect(tokenize('docs/需求.md')).toContain('需求')
  })

  it('中英混排：两类 token 并存', () => {
    const tokens = tokenize('Git 提交')
    expect(tokens).toContain('git')
    expect(tokens).toContain('提交')
  })
})

describe('M28：BM25 词法打分', () => {
  it('命中文档得分 > 0；无关文档为 0；空查询全 0', () => {
    const docs = [tokenize('数据库查询'), tokenize('浏览器自动化截图')]
    const scores = bm25Scores(tokenize('数据库'), docs)
    expect(scores[0]).toBeGreaterThan(0)
    expect(scores[1]).toBe(0)
    expect(bm25Scores([], docs)).toEqual([0, 0])
    expect(bm25Scores(tokenize('数据库'), [])).toEqual([])
  })
})

describe('M28：词法打分（归一化 + name 权重 + 子串强先验）', () => {
  it('name 命中权重高于 description 命中；查询整体子串命中工具名 → 强先验', () => {
    const gitStatus = entry('git_status', '查看工作区状态')
    const mention = entry('fetch_web', '获取 git 远程仓库信息')
    const scores = lexicalScores('git', [gitStatus, mention])
    expect(scores[0]).toBeGreaterThan(scores[1])
    expect(scores[0]).toBeGreaterThanOrEqual(0.9)
  })

  it('单字符查询不做子串强先验（避免噪声）', () => {
    const scores = lexicalScores('库', [entry('tool_x', '无关描述')])
    expect(scores[0]).toBeLessThan(0.9)
  })
})

describe('M28：ToolDiscoveryService 混合检索', () => {
  const entries = [
    entry('git_status', '查看 git 工作区状态'),
    entry('db_query', '执行数据库查询 SQL'),
    entry('browser_click', '点击浏览器页面元素'),
    entry('read_file', '读取工作区文件'),
  ]

  it('无嵌入：纯词法排序；空查询返回空', async () => {
    const service = new ToolDiscoveryService()
    expect(service.semanticReady).toBe(false)
    const hits = await service.rank('git', entries, 5)
    expect(hits[0]!.entry.name).toBe('git_status')
    expect(await service.rank('   ', entries, 5)).toEqual([])
    expect(await service.rank('git', [], 5)).toEqual([])
  })

  it('limit 上下限收敛（1-10）', async () => {
    const service = new ToolDiscoveryService()
    const many = Array.from({ length: 12 }, (_, i) => entry(`tool_${i}`, '通用工具描述'))
    expect((await service.rank('tool', many, 99)).length).toBe(10)
    expect((await service.rank('tool', many, 0)).length).toBe(1)
  })

  it('嵌入融合：词法无命中但语义相近的条目仍可召回', async () => {
    const embedder: ToolEmbedder = {
      embed: async (texts) =>
        texts.map((t) => (t.includes('天气') || t.includes('weather') ? [1, 0] : [0, 1])),
    }
    const service = new ToolDiscoveryService({ embedder })
    expect(service.semanticReady).toBe(true)
    const hits = await service.rank('今天天气如何', [entry('weather_now', 'get weather info'), entry('read_file', '读取文件')], 5)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.entry.name).toBe('weather_now')
  })

  it('嵌入失败 → 静默退化纯词法（结果与无嵌入一致）', async () => {
    const failing: ToolEmbedder = {
      embed: async () => {
        throw new Error('embedding down')
      },
    }
    const base = await new ToolDiscoveryService().rank('数据库', entries, 5)
    const degraded = await new ToolDiscoveryService({ embedder: failing }).rank('数据库', entries, 5)
    expect(degraded.map((h) => h.entry.name)).toEqual(base.map((h) => h.entry.name))
  })

  it('条目向量缓存：同条目二次检索不再请求嵌入（name+description 相同）', async () => {
    let embedded = 0
    const embedder: ToolEmbedder = {
      embed: async (texts) => {
        embedded += texts.length
        return texts.map(() => [1, 1])
      },
    }
    const service = new ToolDiscoveryService({ embedder })
    await service.rank('a', entries, 5)
    const afterFirst = embedded
    await service.rank('b', entries, 5)
    // 第二次仅嵌入 query（4 条条目向量命中缓存）
    expect(embedded - afterFirst).toBe(1)
  })
})

describe('M28：发现区块与投影', () => {
  it('groupOf：重型工具细分分组；MCP 按服务器聚合', () => {
    expect(groupOf(entry('git_status', 'x'))).toBe('Git')
    expect(groupOf(entry('browser_click', 'x'))).toBe('浏览器自动化')
    expect(groupOf(entry('db_query', 'x'))).toBe('数据库')
    expect(groupOf(entry('ssh_exec', 'x'))).toBe('SSH 远程')
    expect(groupOf(entry('web_fetch', 'x'))).toBe('联网')
    expect(groupOf(entry('run_command', 'x'))).toBe('命令执行')
    expect(groupOf(entry('mcp__fs__read', 'x', 'mcp', 'fs'))).toBe('MCP · fs')
  })

  it('renderDiscoveryBlock：空条目为空串；有条目含区块与 tool_search 引导', () => {
    expect(renderDiscoveryBlock([])).toBe('')
    const block = renderDiscoveryBlock([
      entry('git_status', 'x'),
      entry('db_query', 'x'),
      entry('mcp__fs__read', 'x', 'mcp', 'fs'),
    ])
    expect(block).toContain('<tool_discovery>')
    expect(block).toContain('tool_search')
    expect(block).toContain('Git（1 个）')
    expect(block).toContain('MCP · fs（1 个）')
  })

  it('toActivation：引擎回灌投影（不含 category）', () => {
    expect(toActivation(entry('db_query', '查询', 'mcp', 'pg'))).toEqual({
      name: 'db_query',
      description: '查询',
      source: 'mcp',
      server: 'pg',
    })
  })
})

describe('M28：tool_search 工具本体（回灌协议）', () => {
  const makeRuntime = (): ToolRuntime => ({ searchTools: undefined }) as unknown as ToolRuntime

  it('未装配 searchTools → 「直接可用」提示（M47：ok:true，非失败语义）', async () => {
    const registry = createToolRegistry(loadConfig())
    const result = await registry.execute('tool_search', { query: '数据库' }, makeRuntime())
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('直接可用')
  })

  it('发现未启用（direct 标记）：同为「直接可用」提示，不误报失败', async () => {
    const registry = createToolRegistry(loadConfig())
    const runtime = makeRuntime()
    runtime.searchTools = async () => ({ ok: true, activated: [], direct: true, note: '当前所有工具均已直接可用，无需检索' })
    const result = await registry.execute('tool_search', { query: '数据库' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('直接可用')
  })

  it('命中：summary 列激活名；detail 含「本任务内持续可用」与工具描述', async () => {
    const registry = createToolRegistry(loadConfig())
    const runtime = makeRuntime()
    runtime.searchTools = async () => ({
      ok: true,
      activated: [
        { name: 'db_query', description: '查询数据库', source: 'builtin' },
        { name: 'mcp__pg__sql', description: '执行 SQL', source: 'mcp', server: 'pg' },
      ],
    })
    const result = await registry.execute('tool_search', { query: '数据库' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('已激活 2 个工具')
    expect(result.summary).toContain('db_query')
    expect(result.detail).toContain('本任务内持续可用')
    expect(result.detail).toContain('MCP · pg')
  })

  it('空命中：note 兜底（防死路）', async () => {
    const registry = createToolRegistry(loadConfig())
    const runtime = makeRuntime()
    runtime.searchTools = async () => ({ ok: true, activated: [], note: '可用能力：Git（6 个）' })
    const result = await registry.execute('tool_search', { query: 'xyzzy' }, runtime)
    expect(result.ok).toBe(true)
    expect(result.summary).toContain('未命中')
    expect(result.detail).toContain('Git（6 个）')
  })

  it('检索失败：error 回灌', async () => {
    const registry = createToolRegistry(loadConfig())
    const runtime = makeRuntime()
    runtime.searchTools = async () => ({ ok: false, error: '后端不可用' })
    const result = await registry.execute('tool_search', { query: 'x' }, runtime)
    expect(result.ok).toBe(false)
    expect(result.summary).toContain('后端不可用')
  })
})
