/**
 * M45（R-1，ADR 0081 预定口径）：轻回放派生——波次节点与活跃波次索引（纯函数，可单测）。
 * - 波次列表 = `waveOf` 中唯一 `runId~turnIndex` 的首次出现序（wave-sep 行与成员行同源，去重）；
 * - 单条波次（单成员消息）同样成节——回放粒度是「波」而非「并行组」；
 * - 跳转语义 = focusMessage（滚动 + 闪光复用），不做全状态时间旅行（ADR 0081 边界）。
 */
import type { WaveInfo } from './chat-rows'

export interface WaveNode {
  /** `runId~turnIndex`（与 deriveRows 的 segKey 同源） */
  key: string
  /** 1 基序号（展示与锚点用） */
  index: number
  runId: string
  turnIndex: number
  /** 跳转锚点：本波首条成员消息 id */
  firstMessageId: string
  /** 本波成员消息数 */
  count: number
}

/** 波次节点派生（`waveOf` → 去重有序节点；空锚点波次跳过） */
export function waveNodesOf(waveOf: readonly (WaveInfo | null)[]): WaveNode[] {
  const seen = new Set<string>()
  const out: WaveNode[] = []
  for (const w of waveOf) {
    if (!w) continue
    const key = `${w.runId}~${w.turnIndex}`
    if (seen.has(key)) continue
    const first = w.memberIds[0]
    if (!first) continue
    seen.add(key)
    out.push({
      key,
      index: out.length + 1,
      runId: w.runId,
      turnIndex: w.turnIndex,
      firstMessageId: first,
      count: w.memberIds.length,
    })
  }
  return out
}

/** 活跃波次序号（首个可见行起向前扫描的首个波次；无 → undefined）——与悬浮阶段条同源口径 */
export function activeWaveIndexOf(waveOf: readonly (WaveInfo | null)[], firstVisibleRow: number): number | undefined {
  let n = 0
  const seen = new Set<string>()
  for (let k = 0; k < waveOf.length; k++) {
    const w = waveOf[k]
    if (!w) continue
    const key = `${w.runId}~${w.turnIndex}`
    if (!seen.has(key)) {
      seen.add(key)
      n++
    }
    if (k >= firstVisibleRow) return n
  }
  return undefined
}

/**
 * 尾沿节流（leading + trailing，默认 150ms）——scrubber 连点跳转合并：
 * 首次立即触发（点选即时感），窗口内后续调用合并为一次尾沿（避免 focusMessage 机关枪）。
 */
export function createTrailingThrottle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms = 150,
): { run: (...args: A) => void; cancel: () => void } {
  let last = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: A | undefined
  const invoke = (args: A): void => {
    last = Date.now()
    fn(...args)
  }
  return {
    run: (...args: A): void => {
      const now = Date.now()
      const remain = ms - (now - last)
      pending = args
      if (remain <= 0) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        invoke(args)
        return
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          if (pending) invoke(pending)
        }, remain)
      }
    },
    cancel: (): void => {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      pending = undefined
    },
  }
}
