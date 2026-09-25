/**
 * M83 跨端契约 fixture（设计稿 §7 / 批 E 审计收口）：server 引擎实际产出的
 * 块模板与快照 JSON 固化为 fixture（tmp 脚本以 analyzeKline + buildKlineSnapshot +
 * klineBlockTemplate 真实生成），client 解析器直接消费——双端契约漂移的常驻防线。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseKlineSpec } from '../src/lib/kline-spec'
import { parseSnapshotPayload } from '../src/components/chat/md-ext/KlineBlock'

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(process.cwd(), 'tests/fixtures', name), 'utf8')) as Record<string, unknown>
}

describe('M83 跨端契约：server 实际产出 → client 解析', () => {
  it('块模板（src + indicators + render）：parseKlineSpec 通过且显式渲染口径生效', () => {
    const parsed = parseKlineSpec(JSON.stringify(fixture('m83-block.json')))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.spec.src).toBe('charts/sh600519-day-202609250200.json')
    expect(parsed.spec.indicators).toEqual(['MA', 'VOL'])
    expect(parsed.spec.mainIndicator).toBe('MA')
    expect(parsed.spec.subIndicator).toBe('VOL')
    expect(parsed.spec.showPhases).toBe(true)
  })

  it('快照（bars + analysis + drawings + render）：parseSnapshotPayload 通过且分析结论完整', () => {
    const r = parseSnapshotPayload(fixture('m83-snapshot.json'))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.payload.dataset?.bars.length).toBe(80)
    const analysis = r.payload.analysis
    expect(analysis).toBeDefined()
    expect(analysis!.phases.bands.length).toBe(80)
    expect(analysis!.phases.confidence).toBeGreaterThan(0)
    expect(analysis!.notes.length).toBeGreaterThan(0)
    // 落图来自分析引擎（关键位 / 结构线等），随快照一并到达渲染层
    expect(r.payload.drawings.length).toBeGreaterThan(0)
    expect(r.payload.mainIndicator).toBe('MA')
    expect(r.payload.subIndicator).toBe('VOL')
    expect(r.payload.showPhases).toBe(true)
  })
})
