/**
 * 实况面板（M49 / ADR 0100）：右栏「实况」= 浏览器 / 交付件 / 数据库 / 终端 四面合一。
 *
 * - face 条即二级导航：图标 + 标签；运行中操作面脉冲点（useBusyOpFaces）/ 交付件未读计数徽标；
 * - 右侧动作：「暂停跟随」（本次运行不自动聚焦，beginRun 重置）＋「在主区展开当前面」
 *   （浏览器面无展开项；展开走 ui-store.expandWorkspace 深度工作台）；
 * - 浏览器面：BrowserPanel 原样并入（retainView/releaseView 引用计数不变，切面 = 断流/续流）；
 * - 数据库 / 终端面：复用 DockDbView / DockSshView（surface="panel"：不触悬浮直播窗，
 *   底栏提供「展开工作台 / 展开终端 + 连接管理」）；
 * - 交付件面：ArtifactFeedView（跟最新 / 钉住语义见 live-panel-store）；
 * - 「看到即已读」：交付件面可见时清零角标（挂载 + artifactVersion 变更为触发点）。
 *
 * face 切换统一走 live-panel-store.setFace（60s 面锁：自动聚焦本窗口内不抢切面）。
 */
import * as React from 'react'
import { Chrome, Database, Maximize2, PackageOpen, Pause, Play, SquareTerminal } from 'lucide-react'
import type { OpFace } from '../../lib/use-busy-ops'
import { useBusyOpFaces } from '../../lib/use-busy-ops'
import { cn } from '../../lib/utils'
import { useLivePanelStore, type LiveFace } from '../../stores/live-panel-store'
import { useSessionStore } from '../../stores/session-store'
import { useUiStore, type WorkspaceView } from '../../stores/ui-store'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { ArtifactFeedView } from '../artifacts/ArtifactFeedView'
import { BrowserPanel } from '../panels/BrowserPanel'
import { DockDbView } from './DockDbView'
import { DockSshView } from './DockSshView'

interface FaceMeta {
  id: LiveFace
  label: string
  icon: React.ComponentType<{ className?: string }>
  /** 运行中脉冲点对应的操作面（交付件面除外：其指示 = 未读计数徽标） */
  busy?: OpFace
  /** 主区展开目标（浏览器面无展开项） */
  expand?: WorkspaceView
  expandTitle?: string
}

const FACE_META: FaceMeta[] = [
  { id: 'browser', label: '浏览器', icon: Chrome },
  {
    id: 'artifacts',
    label: '交付件',
    icon: PackageOpen,
    expand: 'artifacts',
    expandTitle: '在主区展开交付件工作台（文件树 / 源码 / Diff）',
  },
  {
    id: 'db',
    label: '数据库',
    icon: Database,
    busy: 'db',
    expand: 'database',
    expandTitle: '在主区展开数据库工作台（对象树 / SQL 编辑 / 完整交互）',
  },
  {
    id: 'ssh',
    label: '终端',
    icon: SquareTerminal,
    busy: 'ssh',
    expand: 'terminal',
    expandTitle: '在主区展开 SSH 终端（完整交互）',
  },
]

export function LivePanel(): React.JSX.Element {
  const face = useLivePanelStore((s) => s.face)
  const setFace = useLivePanelStore((s) => s.setFace)
  const followPaused = useLivePanelStore((s) => s.followPaused)
  const toggleFollowPaused = useLivePanelStore((s) => s.toggleFollowPaused)
  const newArtifactCount = useUiStore((s) => s.newArtifactCount)
  const artifactVersion = useSessionStore((s) => s.artifactVersion)
  const busyFaces = useBusyOpFaces()

  // 看到即已读：交付件面可见（含刷新后新件到达）→ 清零未读角标
  React.useEffect(() => {
    if (face === 'artifacts') useUiStore.getState().clearArtifactCount()
  }, [face, artifactVersion])

  const meta = FACE_META.find((f) => f.id === face)

  return (
    <Tabs
      value={face}
      onValueChange={(v) => setFace(v as LiveFace)}
      className="flex h-full min-h-0 flex-col"
    >
      {/* face 条：二级导航 + 跟随控制 */}
      <div className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5">
        <TabsList className="h-7 min-w-0 gap-0 bg-muted/60 px-0.5">
          {FACE_META.map((f) => {
            const Icon = f.icon
            const running = f.busy ? busyFaces.has(f.busy) : false
            return (
              <TabsTrigger
                key={f.id}
                value={f.id}
                className="gap-1 px-1.5 py-0 text-[11px] data-[state=active]:bg-card"
                title={running ? `${f.label} · Agent 正在执行` : f.label}
              >
                <Icon className="size-3" />
                {f.label}
                {running && <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-sky-500" />}
                {f.id === 'artifacts' && newArtifactCount > 0 && (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1 text-[9.5px] font-semibold tabular-nums text-primary">
                    {newArtifactCount}
                  </span>
                )}
              </TabsTrigger>
            )
          })}
        </TabsList>
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            className={cn(followPaused && 'text-amber-600 hover:text-amber-700')}
            title={followPaused ? '恢复跟随（操作到达自动聚焦实况）' : '暂停跟随（本次运行不再自动聚焦）'}
            onClick={toggleFollowPaused}
          >
            {followPaused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
          </Button>
          {meta?.expand && (
            <Button
              size="icon-sm"
              variant="ghost"
              title={meta.expandTitle}
              onClick={() => useUiStore.getState().expandWorkspace(meta.expand!)}
            >
              <Maximize2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* 面内容（非活动面卸载：浏览器切面 = 断流/续流，与引用计数语义一致） */}
      <TabsContent value="browser" className="min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-h-0 flex-col">
          <BrowserPanel />
        </div>
      </TabsContent>
      <TabsContent value="artifacts" className="min-h-0 flex-1 overflow-hidden">
        <ArtifactFeedView />
      </TabsContent>
      <TabsContent value="db" className="min-h-0 flex-1 overflow-hidden">
        <DockDbView surface="panel" />
      </TabsContent>
      <TabsContent value="ssh" className="min-h-0 flex-1 overflow-hidden">
        <DockSshView surface="panel" />
      </TabsContent>
    </Tabs>
  )
}
