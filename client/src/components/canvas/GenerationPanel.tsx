/**
 * M31：媒体生成面板（画布右侧浮动）—— 能力切换 / 提示词（自动拾取上游 prompt 节点）/
 * 连接·模型·工作流选择 / 尺寸步数种子 / 批量数量 / 提交与取消 / 运行中任务 / 会话历史。
 *
 * - 未配置媒体连接时给「去设置」引导（M56：媒体连接全局配置于「设置 → 媒体生成」；最小权限：不静默失败，链接直达该分组）；
 * - 输入素材经 genRef 注入（节点右键「生成变体 / 设为首帧 / 设为尾帧」）；
 * - 提交携带 canvasTarget：完成后由 media-store 自动把产物落到画布（用户生成的核心闭环）。
 */
import * as React from 'react'
import { useReactFlow } from '@xyflow/react'
import {
  Ban,
  Cable,
  CheckCircle2,
  Film,
  ImagePlus,
  Loader2,
  Pencil,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
  X,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import type { CanvasImageData, CanvasNodeDataMap, MediaCapability, MediaJob, MediaProviderInfo } from '@multi-agent/shared'
import { artifactContentUrl } from '../../lib/artifacts'
import { NODE_SIZE } from '../../lib/canvas'
import { CAPABILITY_LABEL, inputKindOf, outputKindOf } from '../../lib/media'
import { cn } from '../../lib/utils'
import { useCanvasStore } from '../../stores/canvas-store'
import { useConnectionsStore } from '../../stores/connections-store'
import { useMediaStore } from '../../stores/media-store'
import { useUiStore } from '../../stores/ui-store'

/** 一次提交的变体数量上限（批量探索） */
const QUANTITY_MAX = 4
/** 历史列表展示条数 */
const HISTORY_VISIBLE = 6

const SIZE_PRESETS = [
  { label: '512', width: 512, height: 512 },
  { label: '768', width: 768, height: 768 },
  { label: '1024', width: 1024, height: 1024 },
  { label: '横 1280×720', width: 1280, height: 720 },
  { label: '竖 720×1280', width: 720, height: 1280 },
]

/** 从选中节点拾取提示词种子（prompt 节点直取；image / video 取上游 prompt 或自身谱系） */
function pickSeedText(): { prompt: string; negative?: string } | undefined {
  const { doc, selectedIds } = useCanvasStore.getState()
  if (!doc || selectedIds.length !== 1) return undefined
  const node = doc.nodes.find((n) => n.id === selectedIds[0])
  if (!node) return undefined
  if (node.type === 'prompt') {
    const d = node.data as CanvasNodeDataMap['prompt']
    return { prompt: d.text, negative: d.negative }
  }
  if (node.type === 'image' || node.type === 'video') {
    const upstream = new Set(doc.edges.filter((e) => e.target === node.id).map((e) => e.source))
    const promptNode = doc.nodes.find((n) => upstream.has(n.id) && n.type === 'prompt')
    if (promptNode) {
      const d = promptNode.data as CanvasNodeDataMap['prompt']
      return { prompt: d.text, negative: d.negative }
    }
    const own = (node.data as CanvasImageData).prompt
    if (own) return { prompt: own }
  }
  return undefined
}

/** 从选中节点取图片素材路径（单选 image 节点） */
function pickSelectedImage(): string | undefined {
  const { doc, selectedIds } = useCanvasStore.getState()
  if (!doc || selectedIds.length !== 1) return undefined
  const node = doc.nodes.find((n) => n.id === selectedIds[0])
  if (node?.type !== 'image') return undefined
  return (node.data as CanvasImageData).artifact
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
      <span className="shrink-0">{label}</span>
      {children}
    </label>
  )
}

const INPUT_CLS =
  'h-6 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-[11.5px] text-foreground outline-none focus-visible:border-primary/60'

function InputSlot({
  label,
  path,
  onPick,
  onClear,
}: {
  label: string
  path?: string
  onPick(): void
  onClear(): void
}): React.JSX.Element {
  const sessionId = useCanvasStore((s) => s.sessionId)
  return (
    <div className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-[11px] text-muted-foreground">{label}</span>
      {path ? (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-muted/40 px-1.5 py-1">
          {sessionId && (
            <img
              src={artifactContentUrl(sessionId, path)}
              alt={label}
              className="size-7 shrink-0 rounded object-cover"
              draggable={false}
            />
          )}
          <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/80">{path.split('/').pop()}</span>
          <button
            type="button"
            title="清除"
            className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
            onClick={onClear}
          >
            <X className="size-3" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-md border border-dashed text-[10.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
          onClick={onPick}
        >
          <ImagePlus className="size-3" aria-hidden />
          从选中图片拾取
        </button>
      )}
    </div>
  )
}

function statusIcon(job: MediaJob): React.JSX.Element {
  if (job.status === 'succeeded') return <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" aria-hidden />
  if (job.status === 'failed') return <XCircle className="size-3.5 shrink-0 text-rose-500" aria-hidden />
  return <Ban className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
}

export function GenerationPanel(): React.JSX.Element | null {
  const panelOpen = useMediaStore((s) => s.panelOpen)
  const providers = useMediaStore((s) => s.providers)
  const jobs = useMediaStore((s) => s.jobs)
  const loading = useMediaStore((s) => s.loading)
  const genRef = useMediaStore((s) => s.genRef)
  const lastError = useMediaStore((s) => s.lastError)
  const sessionId = useCanvasStore((s) => s.sessionId)
  const { screenToFlowPosition } = useReactFlow()

  const [providerId, setProviderId] = React.useState<string>()
  const [capability, setCapability] = React.useState<MediaCapability>('text2image')
  const [model, setModel] = React.useState('')
  const [prompt, setPrompt] = React.useState('')
  const [negative, setNegative] = React.useState('')
  const [width, setWidth] = React.useState(768)
  const [height, setHeight] = React.useState(768)
  const [steps, setSteps] = React.useState(20)
  const [seed, setSeed] = React.useState('')
  const [duration, setDuration] = React.useState(5)
  const [quantity, setQuantity] = React.useState(1)
  const [submitting, setSubmitting] = React.useState(false)
  /** M31 修订：画布选中节点对应的任务 id（任务行高亮：点选画布节点 → 面板行互链） */
  const selectedJobId = useCanvasStore((s) => {
    if (s.selectedIds.length !== 1) return undefined
    const n = s.doc?.nodes.find((x) => x.id === s.selectedIds[0])
    return (n?.data as { jobId?: string } | undefined)?.jobId
  })

  const provider: MediaProviderInfo | undefined = providers.find((p) => p.connectionId === providerId) ?? providers[0]
  const capabilities = React.useMemo(() => provider?.capabilities ?? [], [provider])
  const inputKind = inputKindOf(capability)
  const isVideo = outputKindOf(capability) === 'video'

  // 提供方列表变化：校正选择（连接可能在「设置 → 媒体生成」中启用 / 停用）
  React.useEffect(() => {
    if (providers.length === 0) return
    if (!providers.some((p) => p.connectionId === providerId)) setProviderId(providers[0]!.connectionId)
  }, [providers, providerId])

  // 能力校正：当前提供方不支持时切到可用能力
  React.useEffect(() => {
    if (!panelOpen || !provider) return
    if (!capabilities.includes(capability)) {
      const next = capabilities.includes('text2image') ? 'text2image' : capabilities[0]
      if (next) setCapability(next)
    }
  }, [panelOpen, provider, capabilities, capability])

  // 模型校正：提供方切换 / 模型失效时回落到缺省
  React.useEffect(() => {
    if (!provider) return
    if (model && provider.models.includes(model)) return
    setModel(provider.defaultModel ?? provider.models[0] ?? '')
  }, [provider, model])

  // 打开面板：空提示词时自动拾取选中节点（prompt 节点 / 上游 / 谱系）
  React.useEffect(() => {
    if (!panelOpen || prompt.trim()) return
    const seedText = pickSeedText()
    if (seedText?.prompt) {
      setPrompt(seedText.prompt)
      if (seedText.negative !== undefined) setNegative(seedText.negative)
    }
  }, [panelOpen, prompt])

  // genRef 消费：右键注入的输入素材 / 谱系回填（应用后清 mark，防重复覆盖用户输入）
  React.useEffect(() => {
    if (!panelOpen) return
    if (genRef.firstFrame || genRef.lastFrame) setCapability('firstlast2video')
    else if (genRef.images.length > 0) setCapability((c) => (c === 'image2video' ? c : 'image2image'))
    if (genRef.prompt) {
      setPrompt(genRef.prompt)
      setNegative(genRef.params?.negative ?? '')
      if (genRef.params?.width) setWidth(genRef.params.width)
      if (genRef.params?.height) setHeight(genRef.params.height)
    }
    if (genRef.prompt !== undefined || genRef.params !== undefined) {
      useMediaStore.getState().setGenRef({ ...genRef, prompt: undefined, params: undefined })
    }
  }, [panelOpen, genRef])

  if (!panelOpen) return null

  const close = (): void => useMediaStore.getState().closePanel()

  const setInput = (patch: Partial<typeof genRef>): void =>
    useMediaStore.getState().setGenRef({ ...genRef, ...patch })

  const canSubmit =
    !!provider &&
    prompt.trim().length > 0 &&
    !submitting &&
    (inputKind === 'none' ||
      (inputKind === 'image' && genRef.images.length > 0) ||
      (inputKind === 'firstlast' && !!genRef.firstFrame && !!genRef.lastFrame))

  const submit = async (): Promise<void> => {
    if (!canSubmit || !provider) return
    setSubmitting(true)
    const count = Math.max(1, Math.min(QUANTITY_MAX, quantity))
    const size = NODE_SIZE[outputKindOf(capability)]
    const base = screenToFlowPosition({ x: window.innerWidth * 0.42, y: window.innerHeight * 0.45 })
    try {
      for (let i = 0; i < count; i += 1) {
        await useMediaStore.getState().createJob({
          connectionId: provider.connectionId,
          capability,
          model: model || undefined,
          prompt: prompt.trim(),
          negative: negative.trim() || undefined,
          inputs:
            inputKind === 'none'
              ? undefined
              : inputKind === 'image'
                ? { images: genRef.images }
                : { firstFrame: genRef.firstFrame, lastFrame: genRef.lastFrame },
          params: {
            width,
            height,
            steps: isVideo ? undefined : steps,
            seed: seed.trim() === '' ? undefined : Number(seed),
            duration: isVideo ? duration : undefined,
          },
          canvasTarget: { x: Math.round(base.x + i * (size.width + 24)), y: Math.round(base.y) },
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const activeJobs = jobs.filter((j) => j.status === 'queued' || j.status === 'running')
  const history = jobs.filter((j) => j.status === 'succeeded' || j.status === 'failed' || j.status === 'canceled')

  /** M31 修订：任务行 hover → 画布上该任务的节点闪环（节点↔面板互链） */
  const pulseJobNodes = (jobId: string): void => {
    const d = useCanvasStore.getState().doc
    const ids = (d?.nodes ?? []).filter((n) => (n.data as { jobId?: string }).jobId === jobId).map((n) => n.id)
    if (ids.length > 0) useCanvasStore.getState().pulseNodes(ids)
  }

  return (
    <div
      className="absolute right-3 top-3 z-30 flex w-[300px] flex-col overflow-hidden rounded-lg border bg-card/95 shadow-soft backdrop-blur"
      style={{ maxHeight: 'calc(100% - 1.5rem)' }}
    >
      <header className="flex shrink-0 items-center gap-1.5 border-b px-2.5 py-2">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        <span className="text-[12px] font-medium">媒体生成</span>
        {provider && (
          <button
            type="button"
            title={`在「设置 → 媒体生成」中编辑「${provider.connectionName}」（提供方 / 能力 / 模型 / 工作流）`}
            className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => {
              useConnectionsStore.getState().requestEdit(provider.connectionId)
              useUiStore.getState().requestSettingsFocus('media')
              useUiStore.getState().setAppView('settings')
            }}
          >
            <Pencil className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          title="关闭"
          className={cn(
            'flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground',
            !provider && 'ml-auto',
          )}
          onClick={close}
        >
          <X className="size-3.5" />
        </button>
      </header>

      {providers.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-6 text-center">
          {loading ? (
            <>
              <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
              <span className="text-[11.5px] text-muted-foreground">正在检测可用的媒体连接…</span>
            </>
          ) : (
            <>
              <Cable className="size-5 text-muted-foreground/50" aria-hidden />
              <span className="text-[11.5px] leading-5 text-muted-foreground">
                还没有可用的媒体生成连接。
                <br />
                到「设置 → 媒体生成」创建并启用后即可在画布直接生成。
              </span>
              <div className="mt-1 flex items-center gap-1.5">
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] text-primary-foreground transition-opacity hover:opacity-90"
                  onClick={() => {
                    useUiStore.getState().requestSettingsFocus('media')
                    useUiStore.getState().setAppView('settings')
                  }}
                >
                  <Cable className="size-3" aria-hidden />
                  去设置
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1 rounded-md border px-2.5 py-1 text-[11.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  onClick={() => void useMediaStore.getState().refreshProviders()}
                >
                  <RefreshCw className="size-3" aria-hidden />
                  重新检测
                </button>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-2.5">
          {/* 能力切换 */}
          <div className="flex flex-wrap gap-1">
            {capabilities.map((cap) => (
              <button
                key={cap}
                type="button"
                className={cn(
                  'rounded-md border px-2 py-0.5 text-[11px] transition-colors',
                  cap === capability
                    ? 'border-primary/60 bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                onClick={() => setCapability(cap)}
              >
                {CAPABILITY_LABEL[cap]}
              </button>
            ))}
          </div>

          {/* 连接（多提供方时）与模型 */}
          {providers.length > 1 && (
            <Field label="连接">
              <select
                className={INPUT_CLS}
                value={provider?.connectionId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.connectionId} value={p.connectionId}>
                    {p.connectionName}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(provider?.models.length ?? 0) > 0 && (
            <Field label="模型">
              <select className={INPUT_CLS} value={model} onChange={(e) => setModel(e.target.value)}>
                {provider!.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {/* 输入素材槽位 */}
          {inputKind === 'image' && (
            <InputSlot
              label="输入图"
              path={genRef.images[0]}
              onPick={() => {
                const picked = pickSelectedImage()
                if (!picked) {
                  toast('先在画布选中一张图片节点')
                  return
                }
                setInput({ images: [picked] })
              }}
              onClear={() => setInput({ images: [] })}
            />
          )}
          {inputKind === 'firstlast' && (
            <>
              <InputSlot
                label="首帧"
                path={genRef.firstFrame}
                onPick={() => {
                  const picked = pickSelectedImage()
                  if (!picked) {
                    toast('先在画布选中一张图片节点')
                    return
                  }
                  setInput({ firstFrame: picked })
                }}
                onClear={() => setInput({ firstFrame: undefined })}
              />
              <InputSlot
                label="尾帧"
                path={genRef.lastFrame}
                onPick={() => {
                  const picked = pickSelectedImage()
                  if (!picked) {
                    toast('先在画布选中一张图片节点')
                    return
                  }
                  setInput({ lastFrame: picked })
                }}
                onClear={() => setInput({ lastFrame: undefined })}
              />
            </>
          )}

          {/* 提示词 */}
          <div className="flex flex-col gap-1">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想要的画面…（⌘Enter 生成）"
              rows={3}
              className="w-full resize-none rounded-md border bg-background px-2 py-1.5 text-[12px] leading-5 outline-none focus-visible:border-primary/60"
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            <input
              value={negative}
              onChange={(e) => setNegative(e.target.value)}
              placeholder="负面提示词（可选）"
              className="h-6 w-full rounded-md border bg-background px-2 text-[11.5px] outline-none focus-visible:border-primary/60"
            />
            <button
              type="button"
              className="self-end text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                const seedText = pickSeedText()
                if (!seedText?.prompt) {
                  toast('选中一个提示词节点，或选中由它生成的图片')
                  return
                }
                setPrompt(seedText.prompt)
                if (seedText.negative !== undefined) setNegative(seedText.negative)
              }}
            >
              从选中节点的提示词拾取
            </button>
          </div>

          {/* 参数 */}
          <div className="flex flex-col gap-1.5 rounded-md border bg-muted/30 p-2">
            <Field label="尺寸">
              <select
                className={INPUT_CLS}
                value={`${width}x${height}`}
                onChange={(e) => {
                  const preset = SIZE_PRESETS.find((p) => `${p.width}x${p.height}` === e.target.value)
                  if (preset) {
                    setWidth(preset.width)
                    setHeight(preset.height)
                  }
                }}
              >
                {SIZE_PRESETS.map((p) => (
                  <option key={p.label} value={`${p.width}x${p.height}`}>
                    {p.label}
                  </option>
                ))}
              </select>
            </Field>
            {isVideo ? (
              <Field label="时长（秒）">
                <input
                  type="number"
                  min={1}
                  max={60}
                  className={INPUT_CLS}
                  value={duration}
                  onChange={(e) => setDuration(Math.max(1, Math.min(60, Number(e.target.value) || 1)))}
                />
              </Field>
            ) : (
              <Field label="步数">
                <input
                  type="number"
                  min={1}
                  max={150}
                  className={INPUT_CLS}
                  value={steps}
                  onChange={(e) => setSteps(Math.max(1, Math.min(150, Number(e.target.value) || 1)))}
                />
              </Field>
            )}
            <div className="flex items-center gap-2">
              <Field label="种子">
                <input
                  className={INPUT_CLS}
                  value={seed}
                  placeholder="留空随机"
                  onChange={(e) => setSeed(e.target.value.replace(/[^\d-]/g, ''))}
                />
              </Field>
              <Field label="数量">
                <input
                  type="number"
                  min={1}
                  max={QUANTITY_MAX}
                  className="h-6 w-12 rounded-md border bg-background px-1.5 text-[11.5px] outline-none focus-visible:border-primary/60"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, Math.min(QUANTITY_MAX, Number(e.target.value) || 1)))}
                />
              </Field>
            </div>
          </div>

          {lastError && <p className="rounded-md bg-rose-500/10 px-2 py-1 text-[10.5px] text-rose-600">{lastError}</p>}

          <button
            type="button"
            disabled={!canSubmit}
            className="flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary text-[12px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
            onClick={() => void submit()}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Wand2 className="size-3.5" aria-hidden />
            )}
            {submitting ? '提交中…' : `${CAPABILITY_LABEL[capability]}${quantity > 1 ? ` ×${quantity}` : ''}`}
          </button>

          {/* 运行中任务 */}
          {activeJobs.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {activeJobs.slice(0, 3).map((job) => (
                <div
                  key={job.id}
                  className={cn(
                    'rounded-md border bg-background/60 px-2 py-1.5 transition-colors',
                    selectedJobId === job.id && 'border-primary/40 bg-primary/5',
                  )}
                  onMouseEnter={() => pulseJobNodes(job.id)}
                >
                  <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                    <span className="shrink-0">{CAPABILITY_LABEL[job.capability]}</span>
                    <span className="min-w-0 flex-1 truncate">{job.prompt}</span>
                    <span className="shrink-0 tabular-nums">{job.progress != null ? `${job.progress}%` : job.progressText}</span>
                    <button
                      type="button"
                      title="取消"
                      className="shrink-0 transition-colors hover:text-rose-500"
                      onClick={() => void useMediaStore.getState().cancelJob(job.id)}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={cn('h-full rounded-full bg-primary transition-all', job.progress == null && 'animate-pulse')}
                      style={{ width: `${job.progress ?? 30}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 会话历史 */}
          {history.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-[10.5px] font-medium text-muted-foreground/80">最近任务</span>
              {history.slice(0, HISTORY_VISIBLE).map((job) => (
                <div
                  key={job.id}
                  className={cn(
                    'group flex items-center gap-1.5 rounded-md px-1 py-0.5 hover:bg-accent/60',
                    selectedJobId === job.id && 'bg-primary/5 ring-1 ring-primary/30',
                  )}
                  onMouseEnter={() => pulseJobNodes(job.id)}
                >
                  {statusIcon(job)}
                  {job.status === 'succeeded' && job.outputs[0] && sessionId ? (
                    outputKindOf(job.capability) === 'image' ? (
                      <img
                        src={artifactContentUrl(sessionId, job.outputs[0])}
                        alt=""
                        className="size-6 shrink-0 rounded object-cover"
                        draggable={false}
                      />
                    ) : (
                      <Film className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
                    )
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-[10.5px] text-foreground/80" title={job.prompt}>
                    {job.prompt}
                  </span>
                  <button
                    type="button"
                    title="再生成"
                    className="hidden shrink-0 text-muted-foreground transition-colors hover:text-foreground group-hover:block"
                    onClick={() => void useMediaStore.getState().retryJob(job.id)}
                  >
                    <RefreshCw className="size-3" />
                  </button>
                  <button
                    type="button"
                    title="删除任务记录"
                    className="hidden shrink-0 text-muted-foreground transition-colors hover:text-rose-500 group-hover:block"
                    onClick={() => {
                      const { jobs: all } = useMediaStore.getState()
                      useMediaStore.setState({ jobs: all.filter((j) => j.id !== job.id) })
                    }}
                  >
                    <Trash2 className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
