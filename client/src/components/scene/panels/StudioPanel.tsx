/**
 * M65-B：studio 3D 工作台面板（第 7 类面板，§7）——方案加载 / 编辑 / 保存 + 3D·平面双视图 + 工具组。
 *
 * - three 栈经 StudioSurface 懒加载（vite 'three-stack' 独立 chunk；首屏零增量，§6.2 红线）——
 *   本文件与注册链只静态引用 studio-lazy 边界，不得直接 import StudioCanvas；
 * - 编辑操作全部经 design-scene-model 纯函数（不可变更新）；保存走 design-scenes PUT（乐观锁 409 提示）；
 * - v1 能力：视角（轨道 / 俯视网格）/ 家具（置入·移动·旋转·删除）/ 材质（命名材质换色）/ 光照
 *   （方位·高度角·强度·环境光）/ 快照（PNG 导出）/ 持久化（加载·保存·另存为 v2）；
 *   自由多边形绘制与平面拖拽编辑列 v2（平面视图 v1 为只读展示 + 选中，坐标级编辑在 3D 操作条）。
 */
import * as React from 'react'
import { Box, Camera, Loader2, Move, Printer, RotateCw, Save, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { FURNITURE_KINDS, type FurnitureKind } from '@multi-agent/shared'
import { apiGet } from '../../../lib/api'
import { tplRelinkScene, tplSnapshotToRender } from '../../../lib/ds-templates'
import { useSessionStore } from '../../../stores/session-store'
import { useUiStore } from '../../../stores/ui-store'
import { renderProductPath } from '../../chat/md-ext/RenderCard'
import type { SwatchData } from '../../chat/md-ext/remark-ext'
import { StudioPlanView } from '../../studio/StudioPlanView'
import { StudioPrintSheet } from '../../studio/StudioPrintSheet'
import { StudioSurface } from '../../studio/studio-lazy'
import { STUDIO_OPEN_EVENT } from '../../studio/studio-open'
import {
  addFurniture,
  applyMaterialColor,
  nudgeFurniture,
  removeFurniture,
  rotateFurniture,
  FURNITURE_SPEC,
  specOf,
} from '../../studio/design-scene-model'
import { useDesignScene } from '../../studio/use-design-scene'
import { useSceneCtx } from '../context'
import { useSceneContainers } from '../use-scene-data'
import { PanelEmpty, PanelShell } from './PanelShell'

/** 从 layout 容器行提取「方案源：<path>」（去重保序；非法行忽略——fail-safe） */
export function sceneSourcesOf(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    const m = /方案源[：:]\s*(\S+\.scene\.json)/.exec(line)
    if (m && !out.includes(m[1]!)) out.push(m[1]!)
  }
  return out
}

type StudioView = '3d' | 'plan'
type StudioTool = 'furniture' | 'material' | 'light'

const TOOL_LABEL: Record<StudioTool, string> = { furniture: '家具', material: '材质', light: '光照' }

export function StudioPanel(): React.JSX.Element {
  const ctx = useSceneCtx()
  const sessionId = ctx?.sessionId
  const containers = useSceneContainers()

  // 方案列表 = 工作区文件（真实存在，优先）∪ layout 容器「方案源」声明
  const containerSources = React.useMemo(
    () => containers.filter((c) => c.name === 'layout').flatMap((c) => sceneSourcesOf(c.lines)),
    [containers],
  )
  const [fileSources, setFileSources] = React.useState<string[]>([])
  /** M65-C：layout 卡「打开」通道并入的方案（可能尚未在列表中出现） */
  const [extraSources, setExtraSources] = React.useState<string[]>([])
  /** M65-C：最近一次存入工作区的快照路径（「送图生图」前置） */
  const [lastSnapshot, setLastSnapshot] = React.useState<string>()
  /** M65-C：方案书打印预览开关 */
  const [printOpen, setPrintOpen] = React.useState(false)
  const refreshFiles = React.useCallback((): void => {
    if (!sessionId) return
    void apiGet<{ scenes: { path: string }[] }>(`/api/sessions/${sessionId}/design-scenes`)
      .then((r) => setFileSources(r.scenes.map((s) => s.path)))
      .catch(() => setFileSources([]))
  }, [sessionId])
  // 交付件版本（agent 落盘 / 工作台保存 / 附件）→ 刷新方案列表；当前方案「未落盘」时自动重载（成员补落盘后自愈）
  const artifactVersion = useSessionStore((s) => s.artifactVersion)
  const notFoundRef = React.useRef(false)
  const reloadRef = React.useRef<() => void>(() => {})
  const lastVersionRef = React.useRef(artifactVersion)
  React.useEffect(() => {
    refreshFiles()
    // 仅交付件版本实际变化时自愈（挂载首跑不重复加载）
    const changed = artifactVersion !== lastVersionRef.current
    lastVersionRef.current = artifactVersion
    if (changed && notFoundRef.current) reloadRef.current()
    // 交付件版本驱动；notFound / reload 经 ref 瞬时读取（避免把 ds 全量拉进依赖）
  }, [refreshFiles, artifactVersion])

  // M65-C：layout 卡 → 工作台打开联动（跨组件通道；路径合法性在加载侧校验）
  React.useEffect(() => {
    const onOpen = (e: Event): void => {
      const path = (e as CustomEvent<string>).detail
      if (typeof path !== 'string' || !path.endsWith('.scene.json')) return
      setExtraSources((prev) => (prev.includes(path) ? prev : [...prev, path]))
      setCurrent(path)
      setSelectedId(null)
    }
    window.addEventListener(STUDIO_OPEN_EVENT, onOpen)
    return () => window.removeEventListener(STUDIO_OPEN_EVENT, onOpen)
  }, [])

  const sources = React.useMemo(() => {
    const merged = [...fileSources]
    for (const s of [...containerSources, ...extraSources]) if (!merged.includes(s)) merged.push(s)
    return merged
  }, [fileSources, containerSources, extraSources])

  const [current, setCurrent] = React.useState('')
  React.useEffect(() => {
    setCurrent((prev) => (prev && sources.includes(prev) ? prev : (sources[0] ?? '')))
  }, [sources])

  const ds = useDesignScene(sessionId, current || undefined)
  const scene = ds.scene
  // 自愈重载引用：交付件版本变化时读取最新值（文件补落盘 → 自动重载当前方案）
  notFoundRef.current = ds.notFound
  reloadRef.current = ds.reload

  const [view, setView] = React.useState<StudioView>('3d')
  const [tool, setTool] = React.useState<StudioTool | null>(null)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const viewportRef = React.useRef<HTMLDivElement | null>(null)

  const selected = scene?.furniture.find((f) => f.id === selectedId)

  const insertToComposer = useUiStore((s) => s.insertToComposer)
  /** 最近 styleboard 容器标题（快照→图生图草稿的风格词；缺省不带风格） */
  const styleTheme = React.useMemo(() => containers.find((c) => c.name === 'styleboard')?.arg || undefined, [containers])

  /** M65-C：方案书数据组装（containers 只读派生；冻结口径） */
  const printData = React.useMemo(() => {
    const photoPaths: string[] = []
    for (const c of containers) {
      if (c.name !== 'render') continue
      for (const line of c.lines) {
        const m = /^[-*]\s*来源\s*[|｜]\s*(.+)$/.exec(line.trim())
        if (!m) continue
        const p = renderProductPath(m[1])
        if (p && !photoPaths.includes(p)) photoPaths.push(p)
      }
    }
    const board = [...containers].reverse().find((c) => c.name === 'styleboard')
    const swatches: SwatchData[] = []
    let texture: string | undefined
    if (board) {
      for (const raw of board.lines) {
        const line = raw.trim().replace(/^[-*]\s+/, '')
        const tm = /^质感[：:]\s*(.+)$/.exec(line)
        if (tm) {
          texture = tm[1]!.trim()
          continue
        }
        const seg = line.split('|').map((s) => s.trim())
        if (seg.length >= 2 && seg[0]) swatches.push({ name: seg[0]!, hex: seg[1] ?? '', usage: seg.slice(2).join(' | ') })
      }
    }
    return { photoPaths, swatches, ...(texture ? { texture } : {}) }
  }, [containers])

  const onSave = React.useCallback(async (): Promise<void> => {
    const res = await ds.save()
    if (res.ok) {
      toast.success('已保存到工作区')
      refreshFiles()
    } else if (res.conflict) {
      toast.error(`${res.error ?? '文件已在别处被更新'}：请重新加载后再改（避免覆盖成员改动）`)
    } else {
      toast.error(res.error ?? '保存失败')
    }
  }, [ds, refreshFiles])

  const onSnapshot = React.useCallback(async (): Promise<void> => {
    const el = viewportRef.current?.querySelector('canvas')
    if (!(el instanceof HTMLCanvasElement)) {
      toast.error('3D 画布尚未就绪')
      return
    }
    const dataUrl = el.toDataURL('image/png')
    // ① 本地下载（始终执行——离线也不丢）
    const a = document.createElement('a')
    a.href = dataUrl
    a.download = `${scene?.name ?? 'scene'}-snapshot.png`
    a.click()
    // ② M65-C：存入工作区（canvas/media 通道；失败降级为仅下载）
    if (sessionId) {
      try {
        const blob = await (await fetch(dataUrl)).blob()
        const res = await fetch(`/api/sessions/${sessionId}/media/upload`, {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-file-name': encodeURIComponent(`snapshot-${Date.now().toString(36)}.png`),
          },
          body: blob,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as { path?: string }
        if (data.path) {
          setLastSnapshot(data.path)
          toast.success(`快照已存入工作区：${data.path}（可「送图生图」）`)
          return
        }
      } catch {
        // 静默降级（下载已完成）
      }
    }
    toast.success('快照已导出（存入工作区失败——可稍后重试）')
  }, [scene?.name, sessionId])

  if (sources.length === 0) {
    return (
      <PanelShell title="3D 工作台" icon={Box}>
        <PanelEmpty
          icon={Box}
          text="方案文件就位后在这里打开 3D 工作台"
          hint="流程：@规方 产出 design/*.scene.json → 布局卡「在 3D 工作台打开」"
        />
      </PanelShell>
    )
  }

  return (
    <PanelShell
      title="3D 工作台"
      icon={Box}
      badge={sources.length > 1 ? <span className="scene-panel-count">{sources.length}</span> : undefined}
    >
      <div className="studio-panel" data-studio-panel>
        <div className="studio-panel-bar">
          <select
            className="studio-panel-pick"
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value)
              setSelectedId(null)
            }}
            aria-label="方案选择"
            data-studio-pick
          >
            {sources.map((s) => (
              <option key={s} value={s}>
                {s.replace(/^design\//, '').replace(/\.scene\.json$/, '')}
              </option>
            ))}
          </select>
          <span className="studio-panel-file" title={current}>
            {current}
          </span>
          <div className="studio-panel-btns">
            <button
              type="button"
              className="studio-btn"
              title={view === '3d' ? '切换到平面图' : '切换到 3D 视图'}
              data-studio-view-toggle
              onClick={() => setView((v) => (v === '3d' ? 'plan' : '3d'))}
            >
              {view === '3d' ? '平面' : '3D'}
            </button>
            <button
              type="button"
              className={ds.dirty ? 'studio-btn studio-btn-dirty' : 'studio-btn'}
              title={ds.dirty ? '有未保存改动' : '保存到工作区'}
              data-studio-save
              onClick={() => void onSave()}
            >
              <Save size={12} />
              保存
            </button>
            <button
              type="button"
              className="studio-btn"
              title="导出当前视角快照（下载 + 存入工作区）"
              data-studio-snapshot
              disabled={view !== '3d'}
              onClick={() => void onSnapshot()}
            >
              <Camera size={12} />
              快照
            </button>
            <button
              type="button"
              className="studio-btn"
              title={lastSnapshot ? `基于 ${lastSnapshot} 回填图生图草稿` : '先拍一张快照（存入工作区后可用）'}
              data-studio-to-render
              disabled={!lastSnapshot}
              onClick={() => {
                if (lastSnapshot) {
                  insertToComposer(
                    tplSnapshotToRender({ snapshot: lastSnapshot, ...(styleTheme ? { style: styleTheme } : {}) }),
                  )
                }
              }}
            >
              送图生图
            </button>
            <button
              type="button"
              className="studio-btn"
              title="方案书打印预览（浏览器存 PDF；内容：平面图 + 效果图 + 风格板 + 房间清单）"
              data-studio-print-open
              disabled={!scene}
              onClick={() => setPrintOpen(true)}
            >
              <Printer size={12} />
              打印
            </button>
          </div>
        </div>

        {ds.loading ? (
          <div className="studio-note" data-studio-loading-scene>
            <Loader2 size={12} className="animate-spin" />
            正在加载场景…
          </div>
        ) : null}
        {ds.error ? (
          <div className="studio-note studio-note-error" data-studio-error>
            <TriangleAlert size={12} className="shrink-0" />
            {ds.error}
            {ds.notFound && current ? (
              <button
                type="button"
                className="studio-btn ml-auto"
                title="回填「补落盘」指令到输入框（发给 @规方）"
                data-studio-relink
                onClick={() => insertToComposer(tplRelinkScene({ path: current }))}
              >
                请 @规方 补落盘
              </button>
            ) : null}
            <button type="button" className={ds.notFound ? 'studio-btn' : 'studio-btn ml-auto'} onClick={ds.reload}>
              重试
            </button>
          </div>
        ) : null}
        {!ds.loading && !ds.error && ds.filtered > 0 ? (
          <div className="studio-note" data-studio-filtered>
            已忽略 {ds.filtered} 条无法识别的数据条目（文件其余部分正常加载）
          </div>
        ) : null}

        <div className="studio-panel-viewport" ref={viewportRef}>
          {scene ? (
            view === '3d' ? (
              <StudioSurface className="h-full" scene={scene} selectedId={selectedId ?? undefined} onSelect={setSelectedId} />
            ) : (
              <StudioPlanView scene={scene} selectedId={selectedId ?? undefined} onSelect={setSelectedId} />
            )
          ) : null}
        </div>

        {scene && selected ? (
          <div className="studio-ops" data-studio-ops>
            <span className="studio-ops-name">
              <Move size={12} />
              {specOf(selected.kind).label}
            </span>
            <div className="studio-ops-btns">
              <button type="button" title="左移 100mm" onClick={() => ds.update((s) => nudgeFurniture(s, selected.id, -100, 0))}>
                ←
              </button>
              <button type="button" title="右移 100mm" onClick={() => ds.update((s) => nudgeFurniture(s, selected.id, 100, 0))}>
                →
              </button>
              <button type="button" title="北移 100mm" onClick={() => ds.update((s) => nudgeFurniture(s, selected.id, 0, 100))}>
                ↑
              </button>
              <button type="button" title="南移 100mm" onClick={() => ds.update((s) => nudgeFurniture(s, selected.id, 0, -100))}>
                ↓
              </button>
              <button
                type="button"
                title="逆时针旋转 15°"
                onClick={() => ds.update((s) => rotateFurniture(s, selected.id, -15))}
              >
                <RotateCw size={12} className="-scale-x-100" />
              </button>
              <button type="button" title="顺时针旋转 15°" onClick={() => ds.update((s) => rotateFurniture(s, selected.id, 15))}>
                <RotateCw size={12} />
              </button>
              <button
                type="button"
                title="删除该家具"
                onClick={() => {
                  ds.update((s) => removeFurniture(s, selected.id))
                  setSelectedId(null)
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
        ) : null}

        {scene ? (
          <div className="studio-panel-tools">
            <div className="studio-tool-tabs">
              {(Object.keys(TOOL_LABEL) as StudioTool[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  className={tool === t ? 'studio-tool-tab studio-tool-tab-on' : 'studio-tool-tab'}
                  data-studio-tool={t}
                  onClick={() => setTool((prev) => (prev === t ? null : t))}
                >
                  {TOOL_LABEL[t]}
                </button>
              ))}
            </div>
            {tool === 'furniture' ? (
              <div className="studio-furn-grid" data-studio-furniture>
                {FURNITURE_KINDS.map((kind: FurnitureKind) => (
                  <button
                    key={kind}
                    type="button"
                    className="studio-furn-btn"
                    title={`置入${FURNITURE_SPEC[kind].label}`}
                    onClick={() => ds.update((s) => addFurniture(s, kind))}
                  >
                    {FURNITURE_SPEC[kind].label}
                  </button>
                ))}
              </div>
            ) : null}
            {tool === 'material' ? (
              <div className="studio-mat-list" data-studio-material>
                {Object.entries(scene.materials).map(([name, m]) => (
                  <label key={name} className="studio-mat-row">
                    <span>{name}</span>
                    <input
                      type="color"
                      value={m.color}
                      aria-label={`${name}颜色`}
                      onChange={(e) => ds.update((s) => applyMaterialColor(s, name, e.target.value))}
                    />
                  </label>
                ))}
              </div>
            ) : null}
            {tool === 'light' ? (
              <div className="studio-light-list" data-studio-light>
                <label className="studio-light-row">
                  <span>方位 {Math.round(scene.lights.sunAzimuth)}°</span>
                  <input
                    type="range"
                    min={0}
                    max={360}
                    value={scene.lights.sunAzimuth}
                    aria-label="日光方位"
                    onChange={(e) => ds.update((s) => ({ ...s, lights: { ...s.lights, sunAzimuth: Number(e.target.value) } }))}
                  />
                </label>
                <label className="studio-light-row">
                  <span>高度角 {Math.round(scene.lights.sunElevation)}°</span>
                  <input
                    type="range"
                    min={10}
                    max={90}
                    value={scene.lights.sunElevation}
                    aria-label="日光高度角"
                    onChange={(e) => ds.update((s) => ({ ...s, lights: { ...s.lights, sunElevation: Number(e.target.value) } }))}
                  />
                </label>
                <label className="studio-light-row">
                  <span>强度 {scene.lights.intensity.toFixed(1)}</span>
                  <input
                    type="range"
                    min={0}
                    max={3}
                    step={0.1}
                    value={scene.lights.intensity}
                    aria-label="日照强度"
                    onChange={(e) => ds.update((s) => ({ ...s, lights: { ...s.lights, intensity: Number(e.target.value) } }))}
                  />
                </label>
                <label className="studio-light-row">
                  <span>环境光 {scene.lights.ambient.toFixed(2)}</span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={scene.lights.ambient}
                    aria-label="环境光强度"
                    onChange={(e) => ds.update((s) => ({ ...s, lights: { ...s.lights, ambient: Number(e.target.value) } }))}
                  />
                </label>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {scene && printOpen ? (
        <StudioPrintSheet
          scene={scene}
          photoPaths={printData.photoPaths}
          swatches={printData.swatches}
          {...(printData.texture ? { texture: printData.texture } : {})}
          onClose={() => setPrintOpen(false)}
        />
      ) : null}
    </PanelShell>
  )
}
