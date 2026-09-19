/**
 * 博弈推演节点（画布，M34 增强）：
 * - 节点内选模型 / 填标的与话题（或一键装载场景预设）→ 「运行推演」走 POST /api/finance/game（纯计算毫秒级）；
 * - 「高级参数」折叠区：随机种子 + 各模型核心参数（与消息块共用 MODEL_FIELDS 定义；数组型参数走基线值）；
 * - 结果可视化与消息块（GameBlock）共用 GameResultView 内核（懒加载独立 chunk，不进主包）；
 * - 数据内联进 node.data（CanvasGameData）：无 result = 配置态；有 result = 结果态（「调整参数」回配置态，草稿保留）；
 * - 运行成功即写回（画布自动保存 + 进撤销历史）；失败在节点内展示服务端中文原因。
 */
import * as React from 'react'
import { ChevronDown, Dices, Loader2, Play, SlidersHorizontal } from 'lucide-react'
import type { CanvasGameData, CanvasNodeDataMap } from '@multi-agent/shared'
import { GAME_MODELS, GAME_MODEL_LABELS, type GameModelName } from '../../../lib/game-spec'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { GAME_PRESETS, MODEL_FIELDS, MODEL_PARAM_DEFAULTS, type GamePreset } from '../../finance/game/presets'
import { runGame } from '../../finance/finance-api'
import { NodeShell } from './NodeShell'
import type { CanvasNodeProps } from './types'

/** 渲染内核懒加载（echarts / SVG 内核与 GameBlock 同一实现） */
const GameResultView = React.lazy(() => import('../../game/GameResultView').then((m) => ({ default: m.GameResultView })))

function asModelName(value: string | undefined): GameModelName {
  return value !== undefined && (GAME_MODELS as readonly string[]).includes(value) ? (value as GameModelName) : 'matrix'
}

export function GameNode({ id, data, selected }: CanvasNodeProps): React.JSX.Element {
  const d = data as unknown as CanvasNodeDataMap['game']
  const updateNodeData = useCanvasStore((s) => s.updateNodeData)
  const hasResult = d.result !== undefined && d.result !== null
  const [configuring, setConfiguring] = React.useState(!hasResult)
  const [model, setModel] = React.useState<GameModelName>(() => asModelName(d.model))
  const [topic, setTopic] = React.useState(d.topic ?? '')
  const [symbol, setSymbol] = React.useState(d.symbol ?? '')
  const [seed, setSeed] = React.useState(d.seed !== undefined ? String(d.seed) : '')
  const [params, setParams] = React.useState<Record<string, unknown>>(() => ({
    ...MODEL_PARAM_DEFAULTS[asModelName(d.model)],
    ...(d.params ?? {}),
  }))
  const [advanced, setAdvanced] = React.useState(false)
  const [running, setRunning] = React.useState(false)
  const [error, setError] = React.useState<string | undefined>(undefined)

  // 外部写入结果（agent canvas_write / 实验室送上画布）→ 自动切到结果态
  React.useEffect(() => {
    if (hasResult) setConfiguring(false)
  }, [hasResult])

  /** 切模型：参数回该模型基线（与实验室行为一致） */
  const pickModel = (m: GameModelName): void => {
    setModel(m)
    setParams({ ...MODEL_PARAM_DEFAULTS[m] })
  }

  /** 场景预设：模型 / 话题 / 参数集一键装载 */
  const applyPreset = (preset: GamePreset): void => {
    setModel(preset.model)
    setTopic(preset.topic)
    setParams({ ...MODEL_PARAM_DEFAULTS[preset.model], ...preset.params })
  }

  const setField = (key: string, value: unknown): void => {
    setParams((prev) => ({ ...prev, [key]: value }))
  }

  const run = async (): Promise<void> => {
    if (running) return
    setRunning(true)
    setError(undefined)
    const seedNum = Number.parseInt(seed, 10)
    try {
      const res = await runGame({
        action: model,
        topic: topic.trim() || GAME_MODEL_LABELS[model],
        params,
        ...(symbol.trim() ? { symbol: symbol.trim() } : {}),
        ...(Number.isFinite(seedNum) ? { seed: seedNum } : {}),
      })
      updateNodeData(id, {
        model: res.model,
        topic: res.topic,
        ...(res.symbol ? { symbol: res.symbol } : {}),
        seed: res.seed,
        params: res.params,
        stats: res.stats,
        narrative: res.narrative,
        result: res.result,
      } as Partial<CanvasGameData>)
      setConfiguring(false)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const resultModel = asModelName(d.model)

  return (
    <NodeShell nodeId={id} selected={selected} resizable={{ minWidth: 380, minHeight: 280 }}>
      <div className="flex h-full flex-col overflow-hidden rounded-[inherit]">
        {configuring ? (
          <div className="flex h-full flex-col gap-2 overflow-auto p-2.5">
            <div className="grid grid-cols-2 gap-1">
              {GAME_MODELS.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={cn(
                    'nodrag rounded-md border px-1.5 py-1 text-left text-[10.5px] leading-tight transition-colors',
                    model === m ? 'border-primary/40 bg-primary/5 font-medium' : 'hover:bg-accent/40',
                  )}
                  onClick={() => pickModel(m)}
                >
                  {GAME_MODEL_LABELS[m]}
                </button>
              ))}
            </div>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">标的（可选，仅作标注）</span>
              <input
                className="nodrag h-6 rounded-md border border-input bg-card px-1.5 text-[11.5px] focus-visible:border-primary/40 focus-visible:outline-none"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="如 sh600519"
              />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[10px] text-muted-foreground">话题</span>
              <input
                className="nodrag h-6 rounded-md border border-input bg-card px-1.5 text-[11.5px] focus-visible:border-primary/40 focus-visible:outline-none"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                placeholder="如：茅台多空对峙推演"
              />
            </label>
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-muted-foreground">预设</span>
              {GAME_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="nodrag rounded-full border px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
                  title={preset.desc}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.name}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="nodrag flex items-center gap-1 self-start text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setAdvanced((v) => !v)}
            >
              <ChevronDown className={cn('size-3 transition-transform', advanced && 'rotate-180')} />
              高级参数（种子 · 模型参数）
            </button>
            {advanced && (
              <div className="flex flex-col gap-1.5 rounded-md border border-dashed p-1.5" data-testid="game-node-advanced">
                <label className="flex items-center justify-between gap-2 text-[10.5px]">
                  <span className="text-muted-foreground">随机种子</span>
                  <span className="flex items-center gap-1">
                    <input
                      className="nodrag h-6 w-24 rounded-md border border-input bg-card px-1.5 text-right font-mono text-[10.5px] tabular-nums focus-visible:border-primary/40 focus-visible:outline-none"
                      value={seed}
                      inputMode="numeric"
                      placeholder="默认"
                      aria-label="随机种子"
                      onChange={(e) => setSeed(e.target.value)}
                    />
                    <button
                      type="button"
                      className="nodrag rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
                      title="换一个随机种子"
                      onClick={() => setSeed(String(Math.floor(Math.random() * 100_000_000)))}
                    >
                      <Dices className="size-3" />
                    </button>
                  </span>
                </label>
                {MODEL_FIELDS[model].map((field) =>
                  field.kind === 'number' ? (
                    <label key={field.key} className="flex items-center justify-between gap-2 text-[10.5px]">
                      <span className="text-muted-foreground">{field.label}</span>
                      <input
                        type="number"
                        className="nodrag h-6 w-24 rounded-md border border-input bg-card px-1.5 text-right font-mono text-[10.5px] tabular-nums focus-visible:border-primary/40 focus-visible:outline-none"
                        value={String(params[field.key] ?? '')}
                        {...(field.min !== undefined ? { min: field.min } : {})}
                        {...(field.max !== undefined ? { max: field.max } : {})}
                        {...(field.step !== undefined ? { step: field.step } : {})}
                        aria-label={field.label}
                        onChange={(e) => setField(field.key, Number(e.target.value))}
                      />
                    </label>
                  ) : (
                    <label key={field.key} className="flex items-center justify-between gap-2 text-[10.5px]">
                      <span className="text-muted-foreground">{field.label}</span>
                      <select
                        className="nodrag h-6 rounded-md border border-input bg-card px-1 text-[10.5px] focus-visible:border-primary/40 focus-visible:outline-none"
                        value={String(params[field.key] ?? '')}
                        aria-label={field.label}
                        onChange={(e) => setField(field.key, e.target.value)}
                      >
                        {field.options.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ),
                )}
              </div>
            )}
            <button
              type="button"
              className="nodrag mt-auto flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary text-[11.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              disabled={running}
              onClick={() => void run()}
            >
              {running ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
              {running ? '推演中…' : '运行推演'}
            </button>
            {error && <div className="shrink-0 text-[10.5px] leading-snug text-rose-600">运行失败：{error}</div>}
          </div>
        ) : (
          <>
            <div className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-1.5 text-[10px] text-muted-foreground">
              <span className="truncate text-[11px] font-medium text-foreground">
                {d.topic || GAME_MODEL_LABELS[resultModel]}
              </span>
              <span className="shrink-0">{GAME_MODEL_LABELS[resultModel]}</span>
              {d.symbol && <span className="shrink-0 rounded bg-muted px-1 leading-4">{d.symbol}</span>}
              {d.seed !== undefined && <span className="shrink-0 font-mono tabular-nums">种子 {d.seed}</span>}
              <button
                type="button"
                className="nodrag ml-auto flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 hover:bg-accent hover:text-foreground"
                title="回到配置（模型 / 标的 / 话题）"
                onClick={() => setConfiguring(true)}
              >
                <SlidersHorizontal className="size-3" />
                调整
              </button>
            </div>
            <div className="nowheel min-h-0 flex-1 overflow-auto p-1.5">
              <React.Suspense
                fallback={<div className="p-2 text-[10.5px] text-muted-foreground">博弈内核加载中…</div>}
              >
                <GameResultView
                  model={resultModel}
                  result={d.result}
                  {...(d.stats ? { stats: d.stats } : {})}
                  {...(d.narrative ? { narrative: d.narrative } : {})}
                  {...(d.seed !== undefined ? { seed: d.seed } : {})}
                />
              </React.Suspense>
            </div>
          </>
        )}
      </div>
    </NodeShell>
  )
}
