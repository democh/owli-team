/**
 * M52-A：场景形态解析（stage 声明 → 可渲染形态；scene-expansion §7.8 降级链）。
 * 纯函数（vitest 直测）：未声明 / 非法 / arena 缺席位 / 用户「切回纯列表」→ 一律回退 stream。
 */
import {
  STAGE_LAYOUTS,
  STAGE_PANELS,
  type StageLayout,
  type StagePanel,
  type StageSeats,
} from '@multi-agent/shared'

export interface ResolvedStage {
  layout: StageLayout
  /** 仅 dock / roundtable 且声明合法时存在 */
  panel?: StagePanel
  /** 仅 arena（且至少一席非空）时存在 */
  seats?: StageSeats
  /** 启用元件清单（空数组 = 场景默认集由容器决定） */
  parts: string[]
  /** true = 异常回退（声明缺失 / 非法 / arena 无席位）；用户纯列表模式不算异常 */
  fallback: boolean
}

export function resolveStage(stage: unknown, opts: { listMode?: boolean } = {}): ResolvedStage {
  // 「切回纯列表」：用户显式兜底，优先于声明
  if (opts.listMode) return { layout: 'stream', parts: [], fallback: false }
  if (!isRecord(stage)) return { layout: 'stream', parts: [], fallback: true }
  const layout = stage.layout
  if (typeof layout !== 'string' || !(STAGE_LAYOUTS as readonly string[]).includes(layout)) {
    return { layout: 'stream', parts: [], fallback: true }
  }
  if (layout === 'stream') return { layout: 'stream', parts: [], fallback: false }

  const panel =
    typeof stage.panel === 'string' && (STAGE_PANELS as readonly string[]).includes(stage.panel)
      ? (stage.panel as StagePanel)
      : undefined
  const seats = normalizeSeats(stage.seats)
  // arena：无有效席位 → 无法分席，回退 stream（§3 红线 3：形态异常一律回退纯对话流）
  if (layout === 'arena' && !seats) return { layout: 'stream', parts: [], fallback: true }
  const parts = Array.isArray(stage.parts)
    ? stage.parts.filter((p): p is string => typeof p === 'string' && p !== '')
    : []
  return {
    layout: layout as StageLayout,
    ...(panel ? { panel } : {}),
    ...(seats ? { seats } : {}),
    parts,
    fallback: false,
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function normalizeSeats(raw: unknown): StageSeats | undefined {
  if (!isRecord(raw)) return undefined
  const out: StageSeats = {}
  for (const key of ['left', 'right', 'center'] as const) {
    const v = raw[key]
    if (!Array.isArray(v)) continue
    const ids = v.filter((x): x is string => typeof x === 'string' && x !== '')
    if (ids.length > 0) out[key] = ids
  }
  return out.left || out.right || out.center ? out : undefined
}
