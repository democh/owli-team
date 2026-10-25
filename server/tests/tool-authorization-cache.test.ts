import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { loadConfig } from '../src/config.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { ToolRegistry, type AgentTool, type ToolRuntime } from '../src/tools/registry.js'

const runtime = (overrides: Partial<ToolRuntime> = {}): ToolRuntime => ({
  sessionId: 'session', runId: 'run', agentId: 'pm', memberKey: 'pm', triggerUserId: 'user', ...overrides,
}) as ToolRuntime
const tool = (name: string, overrides: Partial<AgentTool> = {}): AgentTool => ({
  name, description: name, parameters: {}, schema: z.object({}), readOnly: true,
  execute: vi.fn(async () => ({ ok: true, summary: name, detail: '完整正文' })), ...overrides,
})

describe('范式授权与工具结果缓存边界', () => {
  it.each(['plan', 'review'] as const)('%s 不扩张角色的 DB/MCP 只读授权', (mode) => {
    const registry = new ToolRegistry(1000)
    for (const name of ['read_file', 'db_query', 'mcp__private__read', 'mcp__allowed__read']) registry.register(tool(name))
    registry.register(tool('write_plan', { readOnly: false }))
    registry.register(tool('submit_review', { readOnly: false }))
    registry.register(tool('update_plan_step', { readOnly: false }))
    const names = registry.forAgent({ tools: ['read_file', 'mcp__allowed__*'] }, mode, ['update_plan_step']).map((t) => t.name)
    expect(names).toEqual(['read_file', 'mcp__allowed__read', mode === 'plan' ? 'write_plan' : 'submit_review', 'update_plan_step'])
    expect(registry.forAgent({ tools: ['read_file'] }).map((t) => t.name)).toEqual(['read_file'])
  })

  it('同成员同 Run 缓存命中仍返回完整正文，不同成员与 Run 隔离', async () => {
    const registry = new ToolRegistry(1000)
    const read = tool('read_file')
    registry.register(read)
    await registry.execute(read.name, {}, runtime())
    const cached = await registry.execute(read.name, {}, runtime())
    expect(cached.detail).toBe('完整正文')
    expect(cached.summary).toContain('缓存命中')
    await registry.execute(read.name, {}, runtime({ memberKey: 'pm~strict' }))
    await registry.execute(read.name, {}, runtime({ runId: 'next' }))
    await registry.execute(read.name, {}, runtime({ memberKey: undefined, agentId: 'qa' }))
    expect(read.execute).toHaveBeenCalledTimes(4)
  })

  it('已取消的请求不能借缓存返回成功', async () => {
    const registry = new ToolRegistry(1000)
    const read = tool('read_file')
    registry.register(read)
    await registry.execute(read.name, {}, runtime())
    const controller = new AbortController()
    controller.abort()
    await expect(registry.execWithAbort(read.name, {}, runtime(), controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(read.execute).toHaveBeenCalledTimes(1)
  })

  it('tool_search 每次执行当前激活回调，跨成员与 Run 不共享执行结果', async () => {
    const registry = createToolRegistry(loadConfig())
    const searchTools = vi.fn(async () => ({ ok: true, activated: [{ name: 'probe', description: '测试', source: 'builtin' as const }] }))
    for (const patch of [{}, {}, { memberKey: 'qa', agentId: 'qa' }, { runId: 'next' }]) {
      const result = await registry.execute('tool_search', { query: '测试工具' }, runtime({ ...patch, searchTools }))
      expect(result.ok).toBe(true)
      expect(result.summary).not.toContain('缓存命中')
    }
    expect(searchTools).toHaveBeenCalledTimes(4)
    expect(registry.isReadOnly('tool_search')).toBe(true)
  })

  it('不可缓存的只读工具不清空其他读缓存，仍允许只读重试', async () => {
    const registry = new ToolRegistry(1000)
    const read = tool('read_file')
    const activate = tool('activate', { cacheable: false })
    registry.register(read)
    registry.register(activate)
    await registry.execute(read.name, {}, runtime())
    await registry.execute(activate.name, {}, runtime())
    await registry.execute(activate.name, {}, runtime())
    expect((await registry.execute(read.name, {}, runtime())).summary).toContain('缓存命中')
    expect(activate.execute).toHaveBeenCalledTimes(2)
    vi.mocked(activate.execute).mockRejectedValueOnce(new Error('暂时失败'))
    expect((await registry.execute(activate.name, {}, runtime())).ok).toBe(true)
    expect(activate.execute).toHaveBeenCalledTimes(4)
  })

  it('真实写工具执行失败也失效读缓存，不自动重试', async () => {
    const registry = new ToolRegistry(1000)
    const read = tool('read_file')
    const write = tool('write_file', { readOnly: false, execute: vi.fn(async () => { throw new Error('写入后连接中断') }) })
    registry.register(read)
    registry.register(write)
    await registry.execute(read.name, {}, runtime())
    expect((await registry.execute(write.name, {}, runtime())).ok).toBe(false)
    await registry.execute(read.name, {}, runtime())
    expect(write.execute).toHaveBeenCalledTimes(1)
    expect(read.execute).toHaveBeenCalledTimes(2)
  })
})
