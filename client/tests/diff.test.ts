/**
 * Diff 视图纯逻辑（M8）：unified diff 解析（行号/增删/多 hunk）+ 长上下文折叠。
 */
import { describe, expect, it } from 'vitest'
import { buildDiffRows, parseUnifiedDiff } from '../src/components/artifacts/DiffView'

const SAMPLE = [
  '--- src/a.ts@v0',
  '+++ src/a.ts@v1',
  '@@ -1,4 +1,5 @@',
  ' const a = 1',
  '-const b = 2',
  '+const b = 3',
  '+const c = 4',
  ' export { a }',
  '',
].join('\n')

describe('parseUnifiedDiff', () => {
  it('跳过文件头，解析 hunk 与增删行（新旧行号各自推进）', () => {
    const lines = parseUnifiedDiff(SAMPLE)
    expect(lines.map((l) => l.kind)).toEqual(['hunk', 'context', 'del', 'add', 'add', 'context'])

    const add = lines.filter((l) => l.kind === 'add')
    expect(add.map((l) => l.newNo)).toEqual([2, 3])
    const del = lines.find((l) => l.kind === 'del')
    expect(del?.oldNo).toBe(2)
    expect(del?.newNo).toBeUndefined()
  })

  it('hunk 头重置行号（多 hunk 文件）', () => {
    const diff = [
      '@@ -1,1 +1,1 @@',
      '-old1',
      '+new1',
      '@@ -10,1 +20,1 @@',
      '-old10',
      '+new20',
    ].join('\n')
    const lines = parseUnifiedDiff(diff)
    const adds = lines.filter((l) => l.kind === 'add')
    expect(adds.map((l) => l.newNo)).toEqual([1, 20])
    const dels = lines.filter((l) => l.kind === 'del')
    expect(dels.map((l) => l.oldNo)).toEqual([1, 10])
  })

  it('空 diff → 空行模型', () => {
    expect(parseUnifiedDiff('')).toEqual([])
  })
})

describe('buildDiffRows 长上下文折叠', () => {
  const makeContext = (n: number) => Array.from({ length: n }, (_, i) => ` line ${i}`)

  it('连续上下文 ≤ 阈值不折叠', () => {
    const lines = parseUnifiedDiff(['@@ -1,12 +1,12 @@', ...makeContext(12)].join('\n'))
    const rows = buildDiffRows(lines, new Set())
    expect(rows.every((r) => r.kind === 'line')).toBe(true)
  })

  it('连续上下文 > 阈值折叠中段（首尾各保留 3 行）', () => {
    const lines = parseUnifiedDiff(['@@ -1,20 +1,20 @@', ...makeContext(20)].join('\n'))
    const rows = buildDiffRows(lines, new Set())
    const collapsed = rows.filter((r) => r.kind === 'collapsed')
    expect(collapsed).toHaveLength(1)
    expect(collapsed[0].hidden).toBe(20 - 6)
  })

  it('展开后中间行全部可见', () => {
    const lines = parseUnifiedDiff(['@@ -1,20 +1,20 @@', ...makeContext(20)].join('\n'))
    const groupStart = buildDiffRows(lines, new Set()).find((r) => r.kind === 'collapsed')!.groupStart!
    const rows = buildDiffRows(lines, new Set([groupStart]))
    expect(rows.some((r) => r.kind === 'collapsed')).toBe(false)
    // hunk 头 1 行 + 20 行上下文
    expect(rows).toHaveLength(21)
  })
})
