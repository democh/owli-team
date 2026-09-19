/**
 * 交付清单分层（lib/delivery，M37-6 续修订 / ADR 0123）：
 * - 过程产物判定 = 路径首段命中过程目录（charts / data / raw / cache / tmp / temp / logs）；
 * - 重要度分层：文档 > 图示与页面 > 媒体 > 源码文本 > 数据；
 * - 分层：最终交付按重要度稳定取前 N；过程产物与溢出项进「其他」（保持原交付顺序）。
 */
import { describe, expect, it } from 'vitest'
import { DELIVERY_PRIMARY_LIMIT, deliveryTier, firstSegment, isProcessArtifact, partitionDelivery } from '../src/lib/delivery'

describe('交付清单分层（lib/delivery）', () => {
  it('firstSegment：仅取路径首段，无目录返回空串', () => {
    expect(firstSegment('charts/sh600688-day-20260919.json')).toBe('charts')
    expect(firstSegment('README.md')).toBe('')
    expect(firstSegment('')).toBe('')
  })

  it('过程产物：首段命中过程目录（含嵌套），交付目录与根文件不命中', () => {
    expect(isProcessArtifact('charts/sh600688-day-20260919.json')).toBe(true)
    expect(isProcessArtifact('charts/game-maotai-20260919.json')).toBe(true)
    expect(isProcessArtifact('data/raw/quote.csv')).toBe(true)
    expect(isProcessArtifact('tmp/plan.txt')).toBe(true)
    expect(isProcessArtifact('logs/run.log')).toBe(true)
    // 交付目录与根文件：不判过程产物
    expect(isProcessArtifact('docs/基本面分析-增长主线.md')).toBe(false)
    expect(isProcessArtifact('docs/charts/x.json')).toBe(false)
    expect(isProcessArtifact('web/src/README-实现说明.md')).toBe(false)
    expect(isProcessArtifact('src/app.ts')).toBe(false)
    expect(isProcessArtifact('回测数据.csv')).toBe(false)
  })

  it('重要度分层：文档 0 > 图示与页面 1 > 媒体 2 > 源码文本 3 > 数据 4', () => {
    expect(deliveryTier('docs/需求文档.md')).toBe(0)
    expect(deliveryTier('docs/财务测算.xlsx')).toBe(0)
    expect(deliveryTier('docs/投研报告.pdf')).toBe(0)
    expect(deliveryTier('docs/总览.html')).toBe(1)
    expect(deliveryTier('docs/时序图.mmd')).toBe(1)
    expect(deliveryTier('assets/封面.png')).toBe(2)
    expect(deliveryTier('assets/演示.mp4')).toBe(2)
    expect(deliveryTier('src/app.ts')).toBe(3)
    expect(deliveryTier('回测数据.csv')).toBe(4)
    expect(deliveryTier('结果.json')).toBe(4)
  })

  it('分层：最终交付按重要度稳定排序取前 N；过程产物与溢出进「其他」且保持交付顺序', () => {
    const entries = [
      { path: 'charts/a.json' },
      { path: 'src/b.ts' },
      { path: 'docs/c.md' },
      { path: 'docs/d.md' },
      { path: 'charts/e.json' },
      { path: '回测数据.csv' },
    ]
    const { primary, others } = partitionDelivery(entries, 3)
    expect(primary.map((e) => e.path)).toEqual(['docs/c.md', 'docs/d.md', 'src/b.ts'])
    // 溢出（回测数据.csv）与过程产物按原交付顺序排列
    expect(others.map((e) => e.path)).toEqual(['charts/a.json', 'charts/e.json', '回测数据.csv'])
  })

  it('默认上限：DELIVERY_PRIMARY_LIMIT = 5，同层保持交付顺序', () => {
    expect(DELIVERY_PRIMARY_LIMIT).toBe(5)
    const entries = Array.from({ length: 7 }, (_, i) => ({ path: `docs/文档-${i}.md` }))
    const { primary, others } = partitionDelivery(entries)
    expect(primary.map((e) => e.path)).toEqual([
      'docs/文档-0.md',
      'docs/文档-1.md',
      'docs/文档-2.md',
      'docs/文档-3.md',
      'docs/文档-4.md',
    ])
    expect(others.map((e) => e.path)).toEqual(['docs/文档-5.md', 'docs/文档-6.md'])
  })

  it('全为过程产物：主区为空，「其他」收全量', () => {
    const entries = [{ path: 'charts/a.json' }, { path: 'charts/b.json' }]
    const { primary, others } = partitionDelivery(entries)
    expect(primary).toEqual([])
    expect(others.map((e) => e.path)).toEqual(['charts/a.json', 'charts/b.json'])
  })
})
