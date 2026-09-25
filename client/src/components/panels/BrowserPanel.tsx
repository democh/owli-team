/**
 * 浏览器面板（M22，右栏「浏览器」分段）：Agent 浏览器操作的控制中心。
 *
 * 与悬浮直播窗（LiveDock）的分工：
 * - 本面板：完整管理（接入方式 / 启动 / 关闭）、复盘（步骤时间轴 + 截图证据）、应急接管；
 * - 直播窗：任意页签下的实时画面（可拖动 / 折叠 / 吸附），用于边走边看。
 *
 * 能力：
 * - 帧流：`/ws/stream` 订阅（服务端节流 + 合并 + 背压丢帧），img 直出 base64 JPEG；
 * - 接管：watch → takeover 换发一次性 token；画面点击/滚轮/键盘直通 CDP（输入桥与直播窗共用）；
 * - 流所有权：本面板持有引用计数（retain / release），与直播窗共存时归零才断流；
 * - 兜底入口：系统浏览器打开当前地址（本地 headed 观察）。
 */
import * as React from 'react'
import {
  ArrowDownToLine,
  Chrome,
  ExternalLink,
  Hand,
  Loader2,
  Lock,
  Maximize2,
  MousePointerClick,
  PictureInPicture2,
  Power,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import type { BrowserBackend, BrowserState, BrowserStepInfo } from '@multi-agent/shared'
import { screenshotUrlOf, useBrowserStore } from '../../stores/browser-store'
import { useLiveDockStore } from '../../stores/live-dock-store'
import { useSessionStore } from '../../stores/session-store'
import { formatClock } from '../../lib/time'
import { useBrowserFrameInput } from '../../lib/frame-input'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

const STATE_TEXT: Record<BrowserState, string> = {
  launching: '启动中',
  reconnecting: '重连中',
  ready: '就绪',
  acting: 'Agent 操作中',
  human: '人工接管',
  awaiting_human: '等待人工',
  closed: '已关闭',
  error: '异常',
}

const STATE_CLS: Record<BrowserState, string> = {
  launching: 'border-amber-500/30 text-amber-700',
  reconnecting: 'border-amber-500/30 text-amber-700',
  ready: 'border-emerald-600/25 text-emerald-700',
  acting: 'border-sky-500/30 text-sky-700',
  human: 'border-violet-500/30 text-violet-700',
  awaiting_human: 'border-amber-500/30 text-amber-700',
  closed: 'border-border text-muted-foreground',
  error: 'border-rose-500/30 text-rose-700',
}

const BACKEND_LABEL: Record<BrowserBackend, string> = {
  managed: 'managed 独立',
  local: 'local 本机',
  remote: 'remote 远程',
}

/** 空态接入方式选择（radio 卡片） */
const BACKEND_META: Array<{ value: BrowserBackend; label: string; hint: string }> = [
  { value: 'local', label: 'local 本机', hint: '复用本机 Chrome' },
  { value: 'managed', label: 'managed 独立', hint: '独立实例，临时配置' },
  { value: 'remote', label: 'remote 远程', hint: '已有调试端点' },
]

/** 启动形态选项（仅对可自启的后端有意义；remote 由对方浏览器决定） */
const HEADLESS_OPTIONS: Array<{ value: boolean; label: string }> = [
  { value: true, label: '无头' },
  { value: false, label: '打开窗口' },
]

function StepRow({ step }: { step: BrowserStepInfo }): React.JSX.Element {
  const shot = screenshotUrlOf(step)
  const [broken, setBroken] = React.useState(false)
  return (
    <div className="flex items-start gap-1.5 rounded-lg border bg-card px-2 py-1.5 transition-colors hover:border-foreground/15">
      <span className="mt-px w-5 shrink-0 text-right font-mono text-[10px] text-muted-foreground">{step.seq}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-[11.5px]">
          <span
            className={cn(
              'shrink-0 rounded-full border px-1.5 text-[9.5px]',
              step.actor === 'human' ? 'border-violet-500/30 text-violet-700' : 'border-sky-500/25 text-sky-700',
            )}
          >
            {step.actor === 'human' ? '人工' : 'Agent'}
          </span>
          <span className={cn('min-w-0 flex-1 truncate font-medium', !step.ok && 'text-rose-600 line-through')}>
            {step.action}
          </span>
          {step.durationMs !== undefined && (
            <span className="shrink-0 tabular-nums text-[10px] text-muted-foreground">
              {step.durationMs >= 1000 ? `${(step.durationMs / 1000).toFixed(1)}s` : `${step.durationMs}ms`}
            </span>
          )}
          <span className="shrink-0 text-[10px] text-muted-foreground">{formatClock(step.ts)}</span>
        </div>
        {step.detail && <p className="mt-0.5 line-clamp-2 break-all text-[10.5px] text-muted-foreground">{step.detail}</p>}
        {step.url && <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/80">{step.url}</p>}
        {shot && !broken && (
          <a href={shot} target="_blank" rel="noreferrer" className="mt-1 block" title="查看截图">
            <img
              src={shot}
              alt={`步骤 ${step.seq} 截图`}
              loading="lazy"
              className="max-h-24 rounded-md border object-contain"
              onError={() => setBroken(true)}
            />
          </a>
        )}
      </div>
    </div>
  )
}

export function BrowserPanel(): React.JSX.Element {
  const sessionId = useSessionStore((s) => s.currentId)
  const session = useBrowserStore((s) => s.session)
  const history = useBrowserStore((s) => s.history)
  const steps = useBrowserStore((s) => s.steps)
  const frame = useBrowserStore((s) => s.frame)
  const streamStatus = useBrowserStore((s) => s.streamStatus)
  const mode = useBrowserStore((s) => s.mode)
  const maxFps = useBrowserStore((s) => s.maxFps)
  const busy = useBrowserStore((s) => s.busy)
  const loading = useBrowserStore((s) => s.loading)
  const error = useBrowserStore((s) => s.error)

  const [backend, setBackend] = React.useState<BrowserBackend>('local')
  const [headless, setHeadless] = React.useState(true)
  const [externalUrl, setExternalUrl] = React.useState('')
  const imgRef = React.useRef<HTMLImageElement>(null)
  const wrapRef = React.useRef<HTMLDivElement>(null)
  // M79-AF：只读共享（viewer）→ 接管 / 归还 / 关闭 / 画面输入全部只读（服务端另有写闸门兜底）
  const isViewer = useSessionStore((s) => s.current?.role) === 'viewer'
  const input = useBrowserFrameInput(wrapRef, imgRef, !isViewer)

  // 进入会话：加载活动会话 + 持有帧流引用；切会话 / 卸载：释放（与直播窗共享，归零才断流）
  React.useEffect(() => {
    if (!sessionId) return
    void useBrowserStore.getState().load(sessionId)
    useBrowserStore.getState().retainView()
    return () => useBrowserStore.getState().releaseView()
  }, [sessionId])

  React.useEffect(() => {
    if (externalUrl) return
    if (frame?.url ?? session?.currentUrl) setExternalUrl((frame?.url ?? session?.currentUrl) ?? '')
  }, [frame?.url, session?.currentUrl, externalUrl])

  const frameSrc = React.useMemo(() => (frame ? `data:image/jpeg;base64,${frame.data}` : undefined), [frame])
  const currentUrl = frame?.url ?? session?.currentUrl

  if (!session) {
    return (
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
        {/* 引导卡：接入方式 + 启动 */}
        <div className="rounded-xl border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border bg-muted/50">
              <Chrome className="size-3.5 text-muted-foreground" />
            </span>
            <div className="min-w-0">
              <p className="text-[12px] font-medium">未连接浏览器</p>
            </div>
          </div>
          <p className="mb-1 mt-2.5 text-[10.5px] font-medium text-muted-foreground">接入方式</p>
          <div className="space-y-1">
            {BACKEND_META.map((m) => (
              <button
                key={m.value}
                type="button"
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-left transition-colors',
                  backend === m.value ? 'border-primary/40 bg-accent/60' : 'hover:bg-accent/40',
                )}
                onClick={() => setBackend(m.value)}
              >
                <span
                  className={cn(
                    'flex size-3 shrink-0 items-center justify-center rounded-full border',
                    backend === m.value && 'border-primary',
                  )}
                >
                  {backend === m.value && <span className="size-1.5 rounded-full bg-primary" />}
                </span>
                <span className="text-[11.5px] font-medium">{m.label}</span>
                <span className="ml-auto truncate text-[10px] text-muted-foreground">{m.hint}</span>
              </button>
            ))}
          </div>
          <p className="mb-1 mt-2.5 text-[10.5px] font-medium text-muted-foreground">启动形态</p>
          <div className="flex gap-0.5 rounded-lg border p-0.5">
            {HEADLESS_OPTIONS.map((opt) => (
              <button
                key={String(opt.value)}
                type="button"
                className={cn(
                  'flex-1 rounded-md px-2 py-1 text-[11px] transition-colors',
                  headless === opt.value ? 'bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/40',
                )}
                onClick={() => setHeadless(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {backend === 'remote'
              ? '远程端点的形态由对方浏览器决定'
              : headless
                ? '后台静默运行（可在面板内接管）'
                : backend === 'local'
                  ? '弹出可见窗口；本机已有实例运行时将沿用它'
                  : '弹出可见窗口'}
          </p>
          <Button
            size="sm"
            className="mt-2.5 w-full"
            disabled={!sessionId || busy}
            onClick={() =>
              void useBrowserStore
                .getState()
                .start(backend === 'remote' ? { backend } : { backend, headless })
                .catch(() => undefined)
            }
          >
            {busy ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Maximize2 className="mr-1 size-3" />}
            打开浏览器
          </Button>
        </div>

        {/* 系统浏览器兜底 */}
        <div className="space-y-1.5 rounded-xl border bg-card p-2.5">
          <span className="text-[10.5px] text-muted-foreground">或用系统浏览器打开</span>
          <div className="flex items-center gap-1.5">
            <Input
              className="h-7 font-mono text-[11.5px]"
              value={externalUrl}
              placeholder="https://example.com"
              onChange={(e) => setExternalUrl(e.target.value)}
            />
            <Button
              size="xs"
              variant="outline"
              disabled={!externalUrl.trim()}
              onClick={() =>
                void useBrowserStore
                  .getState()
                  .openExternal(externalUrl.trim())
                  .then(() => toast('已交给系统浏览器打开'))
                  .catch((err: Error) => toast.error(err.message))
              }
            >
              <ExternalLink className="size-3" />
            </Button>
          </div>
        </div>

        {history.length > 0 && (
          <div className="space-y-1">
            <span className="text-[10.5px] text-muted-foreground">最近会话</span>
            {history.slice(0, 5).map((h) => (
              <div key={h.id} className="flex items-center gap-1.5 rounded-lg border bg-card px-2 py-1 text-[10.5px]">
                <span className={cn('rounded-full border px-1.5 py-px text-[9.5px]', STATE_CLS[h.state])}>{STATE_TEXT[h.state]}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted-foreground">{h.currentUrl ?? h.endpoint ?? h.id}</span>
                <span className="shrink-0 text-muted-foreground">{formatClock(h.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
        {error && <p className="rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">{error}</p>}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* chrome 条：窗口隐喻 + 地址栏 + 流状态 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b bg-muted/40 px-2 py-1.5">
        <span className="flex shrink-0 items-center gap-0.5">
          <span className="size-1.5 rounded-full bg-rose-400/60" />
          <span className="size-1.5 rounded-full bg-amber-400/60" />
          <span className="size-1.5 rounded-full bg-emerald-400/60" />
        </span>
        <span
          className="flex min-w-0 flex-1 items-center gap-1 rounded-full border bg-card px-2 py-0.5"
          title={currentUrl ?? 'about:blank'}
        >
          <Lock className="size-2.5 shrink-0 text-muted-foreground/60" />
          <span className="truncate font-mono text-[10px] text-muted-foreground">{currentUrl ?? 'about:blank'}</span>
        </span>
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            streamStatus === 'open' ? 'bg-emerald-500' : streamStatus === 'connecting' ? 'bg-amber-400' : 'bg-slate-300',
          )}
          title={`流状态：${streamStatus}`}
        />
      </div>

      {/* meta 行：状态徽标 + 帧率 / 刷新 */}
      <div className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
        <span className={cn('shrink-0 rounded-full border px-1.5 py-px text-[9.5px]', STATE_CLS[session.state])}>
          {STATE_TEXT[session.state]}
        </span>
        <span className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground">
          {BACKEND_LABEL[session.backend]}
        </span>
        {session.backend !== 'remote' && session.headless !== undefined && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground"
            title={session.headless ? '无头模式（不弹窗口）' : '打开窗口模式（可见）'}
          >
            {session.headless ? '无头' : '窗口'}
          </span>
        )}
        {session.external && (
          <span
            className="shrink-0 rounded-full border px-1.5 py-px text-[9.5px] text-muted-foreground"
            title="复用了你已运行的浏览器实例（同一账号的 local 持久配置）：启动形态由该实例决定，切换形态需先退出它"
          >
            复用实例
          </span>
        )}
        {mode === 'takeover' && (
          <span className="shrink-0 rounded-full border border-violet-500/30 px-1.5 py-px text-[9.5px] text-violet-700">接管中</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <select
            className="h-5 rounded border border-input bg-card px-1 text-[10px] text-muted-foreground"
            value={maxFps}
            title="帧率（服务端节流上限）"
            onChange={(e) => useBrowserStore.getState().setMaxFps(Number(e.target.value))}
          >
            <option value={5}>5fps</option>
            <option value={12}>12fps</option>
            <option value={24}>24fps</option>
          </select>
          <Button
            size="icon-sm"
            variant="ghost"
            title="刷新画面（重新拉取会话与步骤）"
            disabled={!sessionId || loading}
            onClick={() => sessionId && void useBrowserStore.getState().load(sessionId)}
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
          </Button>
        </span>
      </div>

      {/* 画面 + 输入通道 */}
      <div
        ref={wrapRef}
        tabIndex={0}
        className={cn(
          'relative shrink-0 bg-slate-900/95 outline-none',
          mode === 'takeover' ? 'cursor-crosshair ring-1 ring-inset ring-violet-500/40' : 'cursor-pointer',
        )}
        onMouseDown={input.onMouseDown}
        onMouseUp={input.onMouseUp}
        onMouseMove={input.onMouseMove}
        onKeyDown={input.onKeyDown}
        onContextMenu={input.onContextMenu}
      >
        {frameSrc ? (
          <img ref={imgRef} src={frameSrc} alt="浏览器画面" className="block max-h-[46vh] w-full select-none object-contain" draggable={false} />
        ) : (
          <div className="flex h-32 items-center justify-center text-[11.5px] text-slate-300">
            {streamStatus === 'open' ? '等待首帧…' : '未连接帧流'}
          </div>
        )}
        {mode !== 'takeover' && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-slate-900/80 to-transparent px-2 pb-1 pt-4 text-[10.5px] text-slate-200">
            <MousePointerClick className="size-3" />
            {isViewer ? '只读共享（viewer）：仅可观察画面' : '点击画面即可接管'}
          </div>
        )}
      </div>

      {/* 操作行 */}
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1.5">
        {mode === 'takeover' ? (
          <Button
            size="xs"
            variant="secondary"
            disabled={busy || isViewer}
            title={isViewer ? '只读共享（viewer）：无操作权限' : undefined}
            onClick={() => void useBrowserStore.getState().release()}
          >
            <RotateCcw className="mr-1 size-3" />
            归还给 Agent
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || session.state === 'closed' || isViewer}
            title={isViewer ? '只读共享（viewer）：无操作权限' : undefined}
            onClick={() => void useBrowserStore.getState().takeover().catch(() => undefined)}
          >
            <Hand className="mr-1 size-3" />
            人工接管
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={busy}
          title="窗口内无地址栏时，可在系统浏览器打开当前地址"
          onClick={() => void useBrowserStore.getState().openExternal(currentUrl ?? 'https://example.com').catch((err: Error) => toast.error(err.message))}
        >
          <ExternalLink className="mr-1 size-3" />
          系统打开
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title="在悬浮直播窗中查看（可拖动 / 折叠，跨页签不遮挡）"
          onClick={() => useLiveDockStore.getState().openDock('browser')}
        >
          <PictureInPicture2 className="mr-1 size-3" />
          直播窗
        </Button>
        <Button
          size="xs"
          variant="ghost"
          className="ml-auto text-rose-600 hover:text-rose-700"
          disabled={busy || isViewer}
          title={isViewer ? '只读共享（viewer）：无操作权限' : undefined}
          onClick={() => {
            if (!window.confirm('关闭该浏览器会话？Agent 后续调用 browser_* 时会重新启动。')) return
            void useBrowserStore.getState().closeSession()
          }}
        >
          <Power className="mr-1 size-3" />
          关闭
        </Button>
      </div>

      {/* 步骤时间轴 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error && (
          <div className="mb-1.5 flex items-start gap-1.5 rounded-lg bg-rose-50 px-2 py-1.5 text-[11px] text-rose-700">
            <span className="min-w-0 flex-1 break-all">{error}</span>
            <button type="button" className="shrink-0" onClick={() => useBrowserStore.setState({ error: undefined })}>
              <X className="size-3" />
            </button>
          </div>
        )}
        <div className="mb-1 flex items-center gap-1 text-[10.5px] text-muted-foreground">
          <ArrowDownToLine className="size-3" />
          <span>步骤时间轴（{steps.length}）</span>
        </div>
        <div className="space-y-1">
          {steps.length === 0 && <p className="px-1 py-4 text-center text-[11.5px] text-muted-foreground">暂无步骤记录</p>}
          {[...steps].reverse().map((step) => (
            <StepRow key={step.seq} step={step} />
          ))}
        </div>
      </div>
    </div>
  )
}
