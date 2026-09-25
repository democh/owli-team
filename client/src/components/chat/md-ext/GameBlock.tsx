/**
 * 博弈块（```game，M34 §6.4）：
 * - 解析走 lib/game-spec（零依赖纯函数）；渲染走 components/game/GameResultView
 *   （React.lazy 独立 chunk，与画布博弈节点共用，同一套内核）；
 * - 数据：内联 data 直接用；否则按 src 取会话交付件内容（src-dataset 统一通道，M6 零新增）；
 * - 流式期间显示源码；解析 / 取数失败 → 错误卡 + 源码回退；
 * - 工具条：源码开关 / 全屏 / 复制 / 送上画布（落为 game 节点，与画布内核同一份数据）。
 */
import * as React from 'react'
import { toast } from 'sonner'
import { FileCode2, Frame, Maximize2, TriangleAlert } from 'lucide-react'
import { gameDefaultTitle, GAME_MODEL_LABELS, parseGameSpec, type GameDataset, type GameModelName } from '../../../lib/game-spec'
import { cn } from '../../../lib/utils'
import { useCanvasStore } from '../../../stores/canvas-store'
import { CopyButton } from './CopyButton'
import { Overlay } from './Overlay'
import { useSrcDataset } from './src-dataset'
import { useStreaming } from './streaming'

/** 渲染内核懒加载（独立 chunk：echarts / SVG 内核不进入主包） */
const GameResultView = React.lazy(() =>
  import('../../game/GameResultView').then((m) => ({ default: m.GameResultView })),
)

interface KernelProps {
  model: GameModelName
  dataset: GameDataset
}

function Kernel({ model, dataset }: KernelProps): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="md-game-note">博弈内核加载中…</div>}>
      <GameResultView
        model={model}
        result={dataset.result}
        {...(dataset.stats ? { stats: dataset.stats } : {})}
        {...(dataset.narrative ? { narrative: dataset.narrative } : {})}
        {...(dataset.seed !== undefined ? { seed: dataset.seed } : {})}
      />
    </React.Suspense>
  )
}

function SourceFallback({ code }: { code: string }): React.JSX.Element {
  return (
    <pre className="md-code-plain">
      <code>{code}</code>
    </pre>
  )
}

/** 快照 JSON → 数据集（结构化透传过解析器校验；顶层 model 缺失时以块内模型兜底） */
function parseSnapshotPayload(
  json: Record<string, unknown>,
  fallbackModel: GameModelName | undefined,
): { ok: true; payload: GameDataset } | { ok: false; error: string } {
  const wrapped = { data: json, ...(json.model === undefined && fallbackModel ? { model: fallbackModel } : {}) }
  const parsed = parseGameSpec(JSON.stringify(wrapped))
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (!parsed.spec.data) return { ok: false, error: '快照缺少博弈数据集' }
  return { ok: true, payload: parsed.spec.data }
}

function ErrorCard({ message, code }: { message: string; code: string }): React.JSX.Element {
  return (
    <div className="md-chart-error">
      <div className="md-chart-error-head">
        <TriangleAlert className="size-3.5 shrink-0" />
        <span>{message}</span>
      </div>
      <SourceFallback code={code} />
    </div>
  )
}

export function GameBlock({ code, title }: { code: string; title?: string }): React.JSX.Element {
  const streaming = useStreaming()
  const parsed = React.useMemo(() => parseGameSpec(code), [code])
  const spec = parsed.ok ? parsed.spec : undefined
  const [showSource, setShowSource] = React.useState(false)
  const [zoom, setZoom] = React.useState(false)
  const fetched = useSrcDataset<GameDataset>(
    spec?.src,
    spec?.data,
    (json) => parseSnapshotPayload(json, spec?.model),
    '博弈快照',
  )

  if (streaming) return <SourceFallback code={code} />
  if (!parsed.ok) return <ErrorCard message={`博弈配置无效：${parsed.error}`} code={code} />
  if (fetched.error) return <ErrorCard message={fetched.error} code={code} />

  const dataset = fetched.payload
  const model = spec!.model
  const modelLabel = GAME_MODEL_LABELS[model]
  const label = title || spec!.title || gameDefaultTitle(spec!)

  /** 送上画布：数据集落为 game 节点（含结果 = 结果态直出；无结果 = 配置态，可在节点内继续调参运行） */
  const toCanvas = async (): Promise<void> => {
    if (!dataset) return
    const id = await useCanvasStore.getState().sendGame({
      model,
      topic: dataset.topic ?? label,
      ...(dataset.symbol ? { symbol: dataset.symbol } : {}),
      ...(dataset.seed !== undefined ? { seed: dataset.seed } : {}),
      ...(dataset.meta?.params ? { params: dataset.meta.params } : {}),
      ...(dataset.stats ? { stats: dataset.stats } : {}),
      ...(dataset.narrative ? { narrative: dataset.narrative } : {}),
      ...(dataset.result !== undefined ? { result: dataset.result } : {}),
    })
    if (id) toast.success('已送上画布 · 顶部「画布」Tab 查看')
  }

  return (
    <figure className="md-gameblock">
      <div className="md-block-bar">
        <span className="md-block-title">{label}</span>
        <span className="md-block-lang">game</span>
        <span className="md-block-meta">{modelLabel}</span>
        {dataset?.symbol && <span className="md-block-meta">{dataset.symbol}</span>}
        <span className="md-block-actions">
          {dataset && (
            <button type="button" className="md-block-btn" title="送上画布（落为博弈节点，可继续调参推演）" onClick={() => void toCanvas()}>
              <Frame className="size-3.5" />
              <span>送上画布</span>
            </button>
          )}
          <button
            type="button"
            className={cn('md-block-btn', showSource && 'is-active')}
            title={showSource ? '收起源码' : '查看源码'}
            onClick={() => setShowSource((v) => !v)}
          >
            <FileCode2 className="size-3.5" />
            <span>源码</span>
          </button>
          <button type="button" className="md-block-btn" title="全屏查看" onClick={() => setZoom(true)}>
            <Maximize2 className="size-3.5" />
            <span>全屏</span>
          </button>
          <CopyButton text={code} />
        </span>
      </div>

      {showSource && <SourceFallback code={code} />}

      {dataset ? (
        <div className="md-game-frame">
          <Kernel model={model} dataset={dataset} />
        </div>
      ) : (
        <div className="md-game-frame">
          <div className="md-game-note">{fetched.loading ? '快照加载中…' : '暂无数据'}</div>
        </div>
      )}

      {dataset && (
        <Overlay open={zoom} title={label} onClose={() => setZoom(false)}>
          <div className="md-game-frame md-game-frame-zoom">
            <Kernel model={model} dataset={dataset} />
          </div>
        </Overlay>
      )}
    </figure>
  )
}
