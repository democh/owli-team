/**
 * M27 测试：MCP 命名规范化 —— slug 校验 / 工具名清洗 / 64 字符截断稳定哈希 / 同服去重 / 映射解析。
 */
import { describe, expect, it } from 'vitest'
import {
  buildRegisteredName,
  isValidMcpSlug,
  isMcpToolName,
  MAX_TOOL_NAME_LEN,
  mcpSlugOf,
  mcpToolPrefix,
  planToolNames,
  sanitizeToolSegment,
  slugifyMcpName,
  stableHash6,
} from '../src/mcp/naming.js'

describe('M27：slug 校验与归一', () => {
  it('isValidMcpSlug：小写字母开头 + 小写字母/数字/连字符，总长 ≤ 40', () => {
    expect(isValidMcpSlug('echo')).toBe(true)
    expect(isValidMcpSlug('github-mcp')).toBe(true)
    expect(isValidMcpSlug('a1')).toBe(true)
    expect(isValidMcpSlug('a'.repeat(40))).toBe(true)
    expect(isValidMcpSlug('a'.repeat(41))).toBe(false)
    expect(isValidMcpSlug('Echo')).toBe(false)
    expect(isValidMcpSlug('1echo')).toBe(false)
    expect(isValidMcpSlug('-echo')).toBe(false)
    expect(isValidMcpSlug('ec_ho')).toBe(false)
    expect(isValidMcpSlug('')).toBe(false)
  })

  it('slugifyMcpName：尽力归一；数字开头补 mcp- 前缀；不可归一返回空串', () => {
    expect(slugifyMcpName('  My Server! ')).toBe('my-server')
    expect(slugifyMcpName('A--B')).toBe('a-b')
    expect(slugifyMcpName('123abc')).toBe('mcp-123abc')
    expect(slugifyMcpName('---')).toBe('')
    expect(slugifyMcpName('中文')).toBe('')
    // 超长：截到 40 位并去除残留连字符
    const long = slugifyMcpName('a'.repeat(30) + '-' + 'b'.repeat(30))
    expect(long.length).toBeLessThanOrEqual(40)
    expect(isValidMcpSlug(long)).toBe(true)
  })
})

describe('M27：工具名规范化与注册名', () => {
  it('sanitizeToolSegment：非法字符 → `_`；空段回落 `tool`', () => {
    expect(sanitizeToolSegment('echo')).toBe('echo')
    expect(sanitizeToolSegment('foo bar')).toBe('foo_bar')
    expect(sanitizeToolSegment('a.b/c')).toBe('a_b_c')
    expect(sanitizeToolSegment('工具')).toBe('__')
    expect(sanitizeToolSegment('')).toBe('tool')
  })

  it('stableHash6：同输入恒定、不同输入不同、长度 6', () => {
    expect(stableHash6('echo/tool')).toBe(stableHash6('echo/tool'))
    expect(stableHash6('echo/tool')).toHaveLength(6)
    expect(stableHash6('echo/tool')).not.toBe(stableHash6('echo/tool2'))
  })

  it('buildRegisteredName：正常拼装 / 超长截断+稳定哈希 / 同服去重 _2 _3', () => {
    const used = new Set<string>()
    const name = buildRegisteredName('echo', 'my-tool', used)
    expect(name).toBe('mcp__echo__my-tool')
    expect(used.has(name)).toBe(true)

    // 超长：截断 + `_<hash6>` 尾缀，总长恰好 64，且同输入跨调用稳定
    const raw = 'x'.repeat(100)
    const long1 = buildRegisteredName('echo', raw, new Set<string>())
    const long2 = buildRegisteredName('echo', raw, new Set<string>())
    expect(long1).toBe(long2)
    expect(long1).toHaveLength(MAX_TOOL_NAME_LEN)
    expect(long1).toBe(`mcp__echo__${'x'.repeat(46)}_${stableHash6(`echo/${raw}`)}`)

    // 去重：同服同（规范化后）名追加 _2 / _3
    const dupUsed = new Set<string>()
    const first = buildRegisteredName('echo', 'dup', dupUsed)
    const second = buildRegisteredName('echo', 'dup', dupUsed)
    const third = buildRegisteredName('echo', 'dup', dupUsed)
    expect(first).toBe('mcp__echo__dup')
    expect(second).toBe('mcp__echo__dup_2')
    expect(third).toBe('mcp__echo__dup_3')

    // 去重叠加截断：后缀后仍 ≤ 64
    const usedTrunc = new Set<string>()
    const t1 = buildRegisteredName('echo', raw, usedTrunc)
    const t2 = buildRegisteredName('echo', raw, usedTrunc)
    expect(t1).not.toBe(t2)
    expect(t2).toHaveLength(MAX_TOOL_NAME_LEN)
    expect(t2.endsWith('_2')).toBe(true)
  })

  it('planToolNames：保持输入顺序、输出 raw ↔ registered 映射、内部去重', () => {
    const planned = planToolNames('srv', ['b', 'a', 'b'])
    expect(planned.map((p) => p.rawName)).toEqual(['b', 'a', 'b'])
    expect(planned[0]!.registeredName).toBe('mcp__srv__b')
    expect(planned[1]!.registeredName).toBe('mcp__srv__a')
    expect(planned[2]!.registeredName).toBe('mcp__srv__b_2')
  })

  it('解析辅助：isMcpToolName / mcpSlugOf / mcpToolPrefix', () => {
    expect(isMcpToolName('mcp__echo__x')).toBe(true)
    expect(isMcpToolName('read_file')).toBe(false)
    expect(mcpSlugOf('mcp__echo__my-tool')).toBe('echo')
    expect(mcpSlugOf('mcp__echo')).toBeUndefined()
    expect(mcpSlugOf('read_file')).toBeUndefined()
    expect(mcpToolPrefix('echo')).toBe('mcp__echo__')
  })
})
