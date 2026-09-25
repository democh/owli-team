/**
 * M80-A：内置表情库（shared/emoji-data）。
 * - 结构完整：8 分类、常用 48 均在库内、无重复字符；
 * - 搜索：中文名 / 英文关键词 / 拼音均可命中；
 * - isEmojiLike：库内放行、肤色变体放行、普通文本拒绝、超长序列拒绝。
 */
import { describe, expect, it } from 'vitest'
import { ALL_EMOJIS, EMOJI_CATEGORIES, EMOJI_COMMON, isEmojiLike, isKnownEmoji, searchEmoji } from '@multi-agent/shared'

describe('M80-A：表情数据集', () => {
  it('结构完整：8 分类 / 常用 48 全部在库 / 无重复', () => {
    expect(EMOJI_CATEGORIES.length).toBe(8)
    expect(ALL_EMOJIS.length).toBeGreaterThanOrEqual(300)
    const chars = new Set(ALL_EMOJIS.map((i) => i.char))
    expect(chars.size).toBe(ALL_EMOJIS.length)
    for (const c of EMOJI_COMMON) expect(isKnownEmoji(c)).toBe(true)
    expect(EMOJI_COMMON.length).toBe(48)
  })

  it('搜索：中文 / 英文 / 拼音命中；无结果返回空', () => {
    expect(searchEmoji('笑').some((i) => i.char === '😂')).toBe(true)
    expect(searchEmoji('joy').some((i) => i.char === '😂')).toBe(true)
    expect(searchEmoji('zan').some((i) => i.char === '👍')).toBe(true)
    expect(searchEmoji('咖啡').some((i) => i.char === '☕')).toBe(true)
    expect(searchEmoji('zzzznothing')).toEqual([])
  })

  it('isEmojiLike：库内 / 肤色变体放行；文本与超长序列拒绝', () => {
    expect(isEmojiLike('👍')).toBe(true)
    expect(isEmojiLike('👍🏽')).toBe(true) // 库外肤色变体（形态合法）
    expect(isEmojiLike('a')).toBe(false)
    expect(isEmojiLike('你好')).toBe(false)
    expect(isEmojiLike('😀😀😀😀😀😀😀')).toBe(false) // >6 码点
    expect(isEmojiLike('')).toBe(false)
  })
})
