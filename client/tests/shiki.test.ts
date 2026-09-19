/**
 * M13：shiki 白名单高亮（lib/shiki）。
 * - 预载语言（typescript）直接高亮；
 * - 白名单内非预载语言（css）走懒加载分支；
 * - 白名单外语言（abap）与别名归一（ts → typescript）回退行为正确。
 */
import { describe, expect, it } from 'vitest'
import { SHIKI_THEME, highlightCode } from '../src/lib/shiki'

describe('highlightCode 白名单（M13）', () => {
  it('预载语言 typescript：输出 shiki HTML 并携带主题', async () => {
    const html = await highlightCode('const a: number = 1', 'typescript')
    expect(html).toContain('class="shiki')
    expect(html).toContain(SHIKI_THEME)
    expect(html).toContain('const')
  })

  it('别名 + 白名单内懒加载：ts 归一到 typescript、css 走懒加载分支', async () => {
    const ts = await highlightCode('let x = 1', 'ts')
    expect(ts).toContain('class="shiki')
    const css = await highlightCode('body { color: red }', 'css')
    expect(css).toContain('class="shiki')
    expect(css).toContain('<span style="color:')
  })

  it('白名单外语言（abap）回退 text：不抛错且仍输出纯文本代码', async () => {
    const html = await highlightCode('WRITE !hello', 'abap')
    expect(html).toContain('class="shiki')
    expect(html).toContain('WRITE')
  })
})
