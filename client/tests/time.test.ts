import { describe, expect, it } from 'vitest'
import { formatClock, humanSize, timeAgo } from '../src/lib/time'

describe('timeAgo', () => {
  const now = new Date('2026-01-01T12:00:00Z').getTime()
  const at = (offsetSec: number): string => new Date(now - offsetSec * 1000).toISOString()

  it('分级文案：刚刚 / 分钟 / 小时 / 天', () => {
    expect(timeAgo(at(10), now)).toBe('刚刚')
    expect(timeAgo(at(60 * 5), now)).toBe('5 分钟前')
    expect(timeAgo(at(3600 * 3), now)).toBe('3 小时前')
    expect(timeAgo(at(86400 * 2), now)).toBe('2 天前')
  })

  it('未来时间按「刚刚」兜底，非法输入返回空串', () => {
    expect(timeAgo(new Date(now + 5000).toISOString(), now)).toBe('刚刚')
    expect(timeAgo('not-a-date', now)).toBe('')
  })
})

describe('formatClock', () => {
  it('输出小时:分钟', () => {
    const out = formatClock('2026-01-01T08:30:00Z')
    expect(out).toMatch(/\d{2}:\d{2}/)
  })

  it('非法输入返回空串', () => {
    expect(formatClock('nope')).toBe('')
  })
})

describe('humanSize', () => {
  it('B / KB / MB 分级', () => {
    expect(humanSize(512)).toBe('512B')
    expect(humanSize(2048)).toBe('2.0KB')
    expect(humanSize(3 * 1024 * 1024)).toBe('3.0MB')
  })
})
