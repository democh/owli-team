/**
 * M35 测试：定时任务内核（shared/src/schedule.ts 纯函数）。
 *
 * 守护四类不变量：
 * ① cron 解析（5 段 / 步长 / 范围 / 星期归一 / 非法拒绝）；
 * ② 下次触发计算（UTC 基准、时区换算、工作日、闰日、DST 空洞与二义）；
 * ③ 规格校验（once 未来约束、minGap 高频护栏、非法时区）；
 * ④ 中文描述（工具回灌与通知文案共用，格式稳定）。
 */
import { describe, expect, it } from 'vitest'
import {
  describeScheduleSpec,
  formatWallTime,
  isValidTimezone,
  nextCronAt,
  nextScheduleAt,
  parseCron,
  resolveScheduleTimezone,
  serverTimezone,
  validateScheduleSpec,
} from '@multi-agent/shared'
import type { CronFields } from '@multi-agent/shared'

const UTC = 'UTC'

function fieldsOf(expr: string): CronFields {
  const parsed = parseCron(expr)
  if (!parsed.ok) throw new Error(`parseCron 失败：${parsed.error}`)
  return parsed.fields
}

function nextOf(expr: string, fromIso: string, tz = UTC): string | null {
  const next = nextCronAt(fieldsOf(expr), new Date(fromIso), tz)
  return next ? next.toISOString() : null
}

describe('M35：cron 解析', () => {
  it('全通配与基础字段', () => {
    const parsed = parseCron('* * * * *')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.minute).toEqual(Array.from({ length: 60 }, (_, i) => i))
    expect(parsed.fields.domRestricted).toBe(false)
    expect(parsed.fields.dowRestricted).toBe(false)
  })

  it('单值 / 区间 / 列表 / 步长', () => {
    const parsed = parseCron('*/15 9-17 1,15 * 1-5')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.minute).toEqual([0, 15, 30, 45])
    expect(parsed.fields.hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17])
    expect(parsed.fields.dom).toEqual([1, 15])
    expect(parsed.fields.month).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    expect(parsed.fields.dow).toEqual([1, 2, 3, 4, 5])
    expect(parsed.fields.domRestricted).toBe(true)
    expect(parsed.fields.dowRestricted).toBe(true)
  })

  it('星期 7 归一为 0（周日）', () => {
    const parsed = parseCron('0 9 * * 7')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.fields.dow).toEqual([0])
  })

  it('非法输入均被拒绝且带中文原因', () => {
    for (const bad of ['', '0 9 * *', '0 9 * * * *', '60 9 * * *', '0 24 * * *', '0 0 0 * *', '0 0 * 13 *', '0 0 * * 8', '*/0 * * * *', 'a * * * *', '5-1 * * * *', '1,,2 * * * *']) {
      const parsed = parseCron(bad)
      expect(parsed.ok, `应拒绝：${bad}`).toBe(false)
      if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0)
    }
  })
})

describe('M35：下次触发计算（UTC 基准）', () => {
  it('每分钟：严格晚于 from，且落在分钟边界', () => {
    expect(nextOf('* * * * *', '2026-09-18T10:07:30.000Z')).toBe('2026-09-18T10:08:00.000Z')
    expect(nextOf('* * * * *', '2026-09-18T10:07:00.000Z')).toBe('2026-09-18T10:08:00.000Z')
  })

  it('每日定点：当天未到取当天，已到取次日', () => {
    expect(nextOf('0 9 * * *', '2026-09-18T00:30:00.000Z')).toBe('2026-09-18T09:00:00.000Z')
    expect(nextOf('0 9 * * *', '2026-09-18T09:00:00.000Z')).toBe('2026-09-19T09:00:00.000Z')
    expect(nextOf('0 9 * * *', '2026-09-18T23:59:00.000Z')).toBe('2026-09-19T09:00:00.000Z')
  })

  it('步长分钟 / 每小时 / 每小时间隔', () => {
    expect(nextOf('*/15 * * * *', '2026-09-18T10:07:00.000Z')).toBe('2026-09-18T10:15:00.000Z')
    expect(nextOf('30 * * * *', '2026-09-18T10:31:00.000Z')).toBe('2026-09-18T11:30:00.000Z')
    expect(nextOf('0 */6 * * *', '2026-09-18T07:00:00.000Z')).toBe('2026-09-18T12:00:00.000Z')
  })

  it('工作日：周五晚 → 跳过周末到周一', () => {
    // 2026-09-18 是周五；09-19 周六、09-20 周日
    expect(nextOf('0 9 * * 1-5', '2026-09-18T10:00:00.000Z')).toBe('2026-09-21T09:00:00.000Z')
  })

  it('日与周同时受限时取并集（标准 cron 语义）', () => {
    // 每月 1 日 ∪ 周一：2026-09-21 是周一、09-18 后首个周一是 09-21（同时 10-01 是周四）
    expect(nextOf('0 9 1 * 1', '2026-09-18T10:00:00.000Z')).toBe('2026-09-21T09:00:00.000Z')
    expect(nextOf('0 9 1 * 1', '2026-09-28T10:00:00.000Z')).toBe('2026-10-01T09:00:00.000Z')
  })

  it('闰日模式：2 月 29 日跨 4 年搜索', () => {
    expect(nextOf('0 0 29 2 *', '2026-03-01T00:00:00.000Z')).toBe('2028-02-29T00:00:00.000Z')
  })

  it('无解模式返回 null（4 年窗口内不存在）', () => {
    // 2 月 30 日：任何年份都不存在
    expect(nextCronAt(fieldsOf('0 0 30 2 *'), new Date('2026-01-01T00:00:00.000Z'), UTC)).toBeNull()
  })
})

describe('M35：时区换算', () => {
  it('Asia/Shanghai：09:00 本地 = 01:00 UTC', () => {
    expect(nextOf('0 9 * * *', '2026-09-18T00:30:00.000Z', 'Asia/Shanghai')).toBe('2026-09-18T01:00:00.000Z')
    expect(nextOf('0 9 * * *', '2026-09-18T01:00:00.000Z', 'Asia/Shanghai')).toBe('2026-09-19T01:00:00.000Z')
  })

  it('America/New_York：普通日 09:00 本地 = 13:00 UTC（EDT）', () => {
    expect(nextOf('0 9 * * *', '2026-09-18T00:00:00.000Z', 'America/New_York')).toBe('2026-09-18T13:00:00.000Z')
  })

  it('DST 春季空洞：02:30 不存在 → 顺延为 03:30 EDT（07:30Z）', () => {
    // 2026-03-08 02:00 EST 直接跳至 03:00 EDT
    expect(nextOf('30 2 * * *', '2026-03-08T05:00:00.000Z', 'America/New_York')).toBe('2026-03-08T07:30:00.000Z')
  })

  it('DST 秋季二义：01:30 出现两次 → 取较早那一档（EDT）', () => {
    // 2026-11-01 01:00 EDT 回拨为 01:00 EST；01:30 EDT = 05:30Z、01:30 EST = 06:30Z
    expect(nextOf('30 1 * * *', '2026-11-01T04:00:00.000Z', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z')
  })

  it('DST 边界后正常收敛：秋季回拨日 02:30（仅 EST 一次）', () => {
    expect(nextOf('30 2 * * *', '2026-11-01T04:00:00.000Z', 'America/New_York')).toBe('2026-11-01T07:30:00.000Z')
  })

  it('时区合法性 / 解析 / 服务器默认', () => {
    expect(isValidTimezone('Asia/Shanghai')).toBe(true)
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(resolveScheduleTimezone({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' }, UTC)).toBe('Asia/Tokyo')
    expect(resolveScheduleTimezone({ kind: 'cron', expr: '0 9 * * *' }, 'Asia/Shanghai')).toBe('Asia/Shanghai')
    expect(serverTimezone().length).toBeGreaterThan(0)
  })

  it('非法时区：计算返回 null（不抛异常）', () => {
    expect(nextOf('0 9 * * *', '2026-09-18T00:00:00.000Z', 'Bad/Zone')).toBeNull()
  })
})

describe('M35：nextScheduleAt（once / cron 统一入口）', () => {
  it('once 返回其绝对时刻（与 from 无关）', () => {
    const at = nextScheduleAt({ kind: 'once', at: '2026-10-01T01:30:00.000Z' }, new Date('2026-09-18T00:00:00.000Z'), UTC)
    expect(at?.toISOString()).toBe('2026-10-01T01:30:00.000Z')
  })

  it('once 时刻非法 / 缺失返回 null', () => {
    expect(nextScheduleAt({ kind: 'once' }, new Date(), UTC)).toBeNull()
    expect(nextScheduleAt({ kind: 'once', at: 'not-a-date' }, new Date(), UTC)).toBeNull()
  })

  it('cron 走表达式路径（含 tz 缺省回退）', () => {
    const at = nextScheduleAt({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Shanghai' }, new Date('2026-09-18T00:30:00.000Z'), UTC)
    expect(at?.toISOString()).toBe('2026-09-18T01:00:00.000Z')
    const fallback = nextScheduleAt({ kind: 'cron', expr: '0 9 * * *' }, new Date('2026-09-18T00:30:00.000Z'), 'Asia/Shanghai')
    expect(fallback?.toISOString()).toBe('2026-09-18T01:00:00.000Z')
  })
})

describe('M35：规格校验（创建 / 更新 / 恢复共用）', () => {
  const now = new Date('2026-09-18T02:00:00.000Z')
  const opts = { defaultTz: 'Asia/Shanghai', minGapMs: 5 * 60_000, now }

  it('once 必须为未来（≥1 分钟）', () => {
    expect(validateScheduleSpec({ kind: 'once', at: '2026-09-18T01:00:00.000Z' }, opts).ok).toBe(false)
    expect(validateScheduleSpec({ kind: 'once', at: '2026-09-18T02:00:30.000Z' }, opts).ok).toBe(false)
    const ok = validateScheduleSpec({ kind: 'once', at: '2026-09-18T03:00:00.000Z' }, opts)
    expect(ok.ok).toBe(true)
    expect(ok.next?.toISOString()).toBe('2026-09-18T03:00:00.000Z')
    expect(ok.timezone).toBe('Asia/Shanghai')
  })

  it('cron 非法表达式透传中文原因', () => {
    const bad = validateScheduleSpec({ kind: 'cron', expr: '61 * * * *' }, opts)
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('cron')
  })

  it('cron 非法时区被拒绝', () => {
    const bad = validateScheduleSpec({ kind: 'cron', expr: '0 9 * * *', tz: 'Bad/Zone' }, opts)
    expect(bad.ok).toBe(false)
    expect(bad.error).toContain('时区')
  })

  it('minGap 高频护栏：每分钟 / 每 2 分钟被拒，每 5 分钟放行', () => {
    expect(validateScheduleSpec({ kind: 'cron', expr: '* * * * *' }, opts).ok).toBe(false)
    expect(validateScheduleSpec({ kind: 'cron', expr: '*/2 * * * *' }, opts).ok).toBe(false)
    const ok = validateScheduleSpec({ kind: 'cron', expr: '*/5 * * * *' }, opts)
    expect(ok.ok).toBe(true)
    expect(ok.next?.toISOString()).toBe('2026-09-18T02:05:00.000Z')
  })

  it('校验成功返回归一化时区与 next', () => {
    const ok = validateScheduleSpec({ kind: 'cron', expr: '0 9 * * *', tz: 'Asia/Tokyo' }, opts)
    expect(ok.ok).toBe(true)
    expect(ok.timezone).toBe('Asia/Tokyo')
    expect(ok.next?.toISOString()).toBe('2026-09-19T00:00:00.000Z') // 东京 09:00 = 00:00Z，今日已过 → 明日
  })
})

describe('M35：中文描述与墙钟格式化', () => {
  it('常用模式描述稳定', () => {
    expect(describeScheduleSpec({ kind: 'cron', expr: '* * * * *' })).toBe('每分钟')
    expect(describeScheduleSpec({ kind: 'cron', expr: '*/30 * * * *' })).toBe('每 30 分钟')
    expect(describeScheduleSpec({ kind: 'cron', expr: '0 * * * *' })).toBe('每小时第 0 分')
    expect(describeScheduleSpec({ kind: 'cron', expr: '0 */6 * * *' })).toBe('每 6 小时')
    expect(describeScheduleSpec({ kind: 'cron', expr: '0 9 * * 1-5' })).toBe('工作日 09:00')
    expect(describeScheduleSpec({ kind: 'cron', expr: '30 8 * * 1' })).toBe('每周一 08:30')
    expect(describeScheduleSpec({ kind: 'cron', expr: '0 9 * * *' })).toBe('每天 09:00')
    expect(describeScheduleSpec({ kind: 'cron', expr: '0 9 1 * *' })).toBe('每月 1 日 09:00')
  })

  it('复杂表达式回退为原文，once 渲染墙钟', () => {
    expect(describeScheduleSpec({ kind: 'cron', expr: '5,35 8-18 * * 1,3' })).toContain('cron')
    expect(describeScheduleSpec({ kind: 'once', at: '2026-10-01T01:30:00.000Z', tz: 'Asia/Shanghai' })).toBe(
      '一次性 2026-10-01 09:30',
    )
  })

  it('formatWallTime 按 tz 渲染（UTC+8 跨日校验）', () => {
    expect(formatWallTime(new Date('2026-09-18T17:30:00.000Z'), 'Asia/Shanghai')).toBe('2026-09-19 01:30')
    expect(formatWallTime(new Date('2026-09-18T17:30:00.000Z'), UTC)).toBe('2026-09-18 17:30')
  })
})
