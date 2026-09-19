/**
 * Game 块配置解析（纯函数，零依赖；可被主包安全静态引用）。
 * ```game 代码块 → GameSpec；宽松校验 + 面向用户的中文错误信息。
 *
 * JSON 形状（src 快照引用与 data 内联数据至少一项；渲染优先 data）：
 * {
 *   "src": "charts/game-maotai-duikang-202609181030.json",   // 会话工作区相对路径（快照）
 *   "data": { "kind":"game","model":"matrix","topic":"…","seed":20260918,
 *             "meta":{ "params":{…},"asOf":"…" }, "stats":{…},"narrative":"…","result":{…} },
 *   "model": "matrix" | "sequence" | "evolve" | "simulate",  // 缺省取 data.model
 *   "title": "茅台多空对峙推演"
 * }
 *
 * 对齐 server/src/finance/game/index.ts 的 GameSnapshot schema（kind: 'game'）。
 * matrix / sequence 结果小可内联；simulate / evolve 默认 src 引用（快照为分位带 + 抽样路径）。
 */
export const GAME_MODELS = ['matrix', 'sequence', 'evolve', 'simulate'] as const
export type GameModelName = (typeof GAME_MODELS)[number]

/** 中文模型标签（与 server game/types.ts 的 MODEL_LABELS 对齐） */
export const GAME_MODEL_LABELS: Record<GameModelName, string> = {
  matrix: '静态矩阵博弈',
  sequence: '序贯博弈（逆向归纳）',
  evolve: '演化博弈（复制动态）',
  simulate: 'ABM 蒙特卡洛',
}

/** 默认随机种子（与 server DEFAULT_GAME_SEED 对齐；相同种子可重放） */
export const DEFAULT_GAME_SEED = 20260918

/** 内联数据集（同 game 快照 schema；结构松校验，细节由各模型视图组件按需取用） */
export interface GameDataset {
  kind?: string
  model?: string
  topic?: string
  symbol?: string
  seed?: number
  meta?: { params?: Record<string, unknown>; asOf?: string; note?: string }
  stats?: Record<string, unknown>
  narrative?: string
  result?: unknown
}

export interface GameSpec {
  model: GameModelName
  /** 快照路径（会话工作区相对；与 data 至少一项） */
  src?: string
  /** 内联数据（渲染优先；无 src 时必填） */
  data?: GameDataset
  title?: string
}

export type GameParseResult = { ok: true; spec: GameSpec } | { ok: false; error: string }

/** 会话工作区相对路径防御（拒绝绝对路径与 `..` 上跳；与 server snapshot.ts safeDir 同口径） */
function isSafeRelPath(p: string): boolean {
  if (p.startsWith('/') || p.startsWith('\\') || /^[a-zA-Z]:/.test(p)) return false
  return !p.split(/[\\/]/).some((seg) => seg === '..')
}

function normalizeModel(v: unknown): GameModelName | undefined {
  if (typeof v !== 'string') return undefined
  const key = v.trim().toLowerCase()
  return (GAME_MODELS as readonly string[]).includes(key) ? (key as GameModelName) : undefined
}

export function parseGameSpec(source: string): GameParseResult {
  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (err) {
    return { ok: false, error: `JSON 解析失败：${(err as Error).message}` }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: '顶层结构必须是 JSON 对象（如 {"src":"charts/game-xxx.json","model":"simulate"}）' }
  }
  const obj = raw as Record<string, unknown>

  // src（可选；提供时须为安全工作区相对路径）
  let src: string | undefined
  if (obj.src !== undefined && obj.src !== null) {
    if (typeof obj.src !== 'string' || obj.src.trim() === '') {
      return { ok: false, error: 'src 必须是非空字符串（快照路径，如 charts/game-xxx-202609181030.json）' }
    }
    src = obj.src.trim()
    if (!isSafeRelPath(src)) {
      return { ok: false, error: `src 必须是会话工作区相对路径（不可使用绝对路径或 ..）：${src}` }
    }
  }

  // data（可选；对象形态为快照数据集）
  let data: GameDataset | undefined
  if (obj.data !== undefined && obj.data !== null) {
    if (typeof obj.data !== 'object' || Array.isArray(obj.data)) {
      return { ok: false, error: 'data 必须是对象（同 game 快照 schema 的内联数据）' }
    }
    const row = obj.data as Record<string, unknown>
    data = {
      ...(typeof row.kind === 'string' ? { kind: row.kind } : {}),
      ...(typeof row.model === 'string' ? { model: row.model } : {}),
      ...(typeof row.topic === 'string' ? { topic: row.topic } : {}),
      ...(typeof row.symbol === 'string' ? { symbol: row.symbol } : {}),
      ...(typeof row.seed === 'number' && Number.isFinite(row.seed) ? { seed: row.seed } : {}),
      ...(typeof row.meta === 'object' && row.meta !== null && !Array.isArray(row.meta)
        ? { meta: row.meta as GameDataset['meta'] }
        : {}),
      ...(typeof row.stats === 'object' && row.stats !== null && !Array.isArray(row.stats)
        ? { stats: row.stats as Record<string, unknown> }
        : {}),
      ...(typeof row.narrative === 'string' ? { narrative: row.narrative } : {}),
      ...(row.result !== undefined && row.result !== null ? { result: row.result } : {}),
    }
  }

  if (!src && !data) {
    return { ok: false, error: '缺少 src（快照路径）或 data（内联数据）：两者至少提供一项' }
  }

  // model（必填；缺省容忍 data.model 兜底——快照自带模型口径）
  const model = normalizeModel(obj.model) ?? normalizeModel(data?.model)
  if (!model) {
    const shown = obj.model !== undefined ? `"${String(obj.model)}"` : '（缺失）'
    return { ok: false, error: `不支持的博弈模型 ${shown}（可选：${GAME_MODELS.join(' / ')}）` }
  }

  const title = typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : undefined
  return {
    ok: true,
    spec: {
      model,
      ...(src ? { src } : {}),
      ...(data ? { data } : {}),
      ...(title ? { title } : {}),
    },
  }
}

/** 渲染标题缺省组合：`<主题或标题> · <模型中文标签>`（数据缺项时优雅降级） */
export function gameDefaultTitle(spec: GameSpec): string {
  const topic = spec.data?.topic || spec.title || '博弈推演'
  return `${topic} · ${GAME_MODEL_LABELS[spec.model]}`
}
