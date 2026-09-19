/**
 * M52-A：roundtable 形态——中消息流 + 顶席位环（当前发言高亮 + 等待序）+ 右汇聚板（§7.2）。
 * M42（§71.3）：议题进度容器化——会话内含 `::: meeting` 容器时，顶部议程条改由会议议题驱动
 * （容器更新优先、本地勾选兜底；running 时首未决项点亮），点击议题定位到对应首条发言；
 * 无会议容器时回退波次驱动（M52-A 原行为）。
 * M58：无数据不渲染汇聚板（panelReady 口径）。
 * M59：顶区收为浅色卡片带（席位环 + 议程步骤条 + 右端摘要）；汇聚板补折叠 / 关闭（chrome 注入
 * 标题行，偏好落 localStorage；折叠为窄条 rail、关闭为浮动恢复胶囊，口径同 dock）。
 * M59 续：顶区居中（内容组整体居中）+ 顶区可收起/展开（收起为单行迷你条：小头像堆叠 + 摘要 + 展开钮）。
 * 窄屏：席位横条 + 单流 + 底部抽屉（默认收起，§7.3-4）。
 */
import * as React from 'react'
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, LayoutGrid, X } from 'lucide-react'
import {
  meetingItemsOfLines,
  mergeMeetingItems,
  meetingLabelHead,
  meetingProgress,
  useMeetingChecks,
} from '../../lib/meeting'
import { cn } from '../../lib/utils'
import { AgentAvatar } from '../agents/AgentAvatar'
import { useSceneCtx } from './context'
import { containersOf } from './derive'
import { PanelChromeProvider, type PanelChrome } from './panels/chrome'
import { AgendaTrack, SeatRing, type AgendaStep } from './parts'
import { loadRtPref, saveRtPref, type RtPref } from './persist'
import { SceneDrawer } from './SceneDrawer'
import { SeatStrip } from './SeatStrip'
import { useSceneBusy, useSceneMessages } from './use-scene-data'

export function RoundtableStage({
  children,
  panel,
}: {
  children: React.ReactNode
  panel?: React.ReactNode
}): React.JSX.Element {
  const ctx = useSceneCtx()
  const narrow = ctx?.narrow ?? false
  const busy = useSceneBusy()
  const messages = useSceneMessages()
  const containers = React.useMemo(() => containersOf(messages), [messages])
  const [pref, setPref] = React.useState<RtPref>(() => loadRtPref())

  const update = React.useCallback((patch: Partial<RtPref>): void => {
    setPref((p) => {
      const next = { ...p, ...patch }
      saveRtPref(next)
      return next
    })
  }, [])

  // M59：折叠 / 关闭钮注入汇聚板标题行（口径同 dock；窄屏抽屉不注入——抽屉自带收起）
  const chrome = React.useMemo<PanelChrome>(
    () =>
      narrow
        ? {}
        : {
            actions: (
              <>
                <button type="button" className="scene-rt-act" title="折叠汇聚板" onClick={() => update({ collapsed: true })}>
                  <ChevronRight size={14} />
                </button>
                <button type="button" className="scene-rt-act" title="关闭汇聚板" onClick={() => update({ closed: true })}>
                  <X size={13} />
                </button>
              </>
            ),
          },
    [narrow, update],
  )

  const onSeat = (agentId: string): void => {
    const agent = ctx?.agentOf(agentId)
    if (agent) ctx?.insert(`@${agent.name} `)
  }

  // M42：会议议题——全部 `::: meeting` 容器按标签合并（容器更新优先），无容器时回退波次驱动
  const meetingItems = React.useMemo(
    () =>
      mergeMeetingItems(
        containers.filter((c) => c.name === 'meeting').map((c) => meetingItemsOfLines(c.lines)),
      ),
    [containers],
  )
  const meetingAnchorId = React.useMemo(() => containers.find((c) => c.name === 'meeting')?.messageId, [containers])
  const hasMeeting = meetingItems.length > 0
  const checks = useMeetingChecks(ctx?.sessionId)
  const localDone = React.useMemo(() => new Set(checks), [checks])
  const running = busy.streaming || (ctx?.waitingIds.length ?? 0) > 0
  const progress = React.useMemo(() => meetingProgress(meetingItems, localDone, running), [meetingItems, localDone, running])

  const agenda = ctx?.group?.agenda ?? []
  const steps: AgendaStep[] = hasMeeting
    ? progress.view.map((it) => ({ label: it.label, state: it.state }))
    : // 无会议容器：波次进度映射到 agenda 步骤（前 N-1 步 done、当前步 doing）
      agenda.map((a, i) => ({
        label: a.label,
        state: busy.waveCount === 0 ? 'todo' : i < busy.waveCount - 1 ? 'done' : i === busy.waveCount - 1 ? 'doing' : 'todo',
        prompt: a.prompt,
      }))

  const heading = hasMeeting
    ? progress.currentIndex >= 0
      ? `议题 ${progress.doneCount}/${progress.view.length} · 当前：${progress.view[progress.currentIndex]!.label}`
      : `议题 ${progress.doneCount}/${progress.view.length} · 已全部议决`
    : steps.length === 0
      ? undefined
      : steps.every((s) => s.state === 'done')
        ? '研讨步骤已全部完成'
        : busy.waveCount > 0
          ? `研讨推进中 · ${steps.filter((s) => s.state === 'done').length}/${steps.length}`
          : undefined

  const onPick = (step: AgendaStep): void => {
    if (hasMeeting) {
      // RT-3：点击议题 → 定位首条含「议题头词」的成员发言；无则回到会议声明消息
      const head = meetingLabelHead(step.label)
      const hit = messages.find((m) => m.role === 'agent' && m.content.includes(head))
      const anchor = hit?.id ?? meetingAnchorId
      if (anchor) ctx?.focus(anchor)
      return
    }
    if (step.prompt) ctx?.insert(step.prompt)
  }

  return (
    <PanelChromeProvider value={chrome}>
      <div className={cn('scene-rt', narrow && 'scene-rt-narrow')}>
        {pref.topMini ? (
          /* M59 续：顶区收起态——单行迷你条（小头像堆叠 + 摘要 + 展开钮） */
          <div className="scene-rt-top scene-rt-top-mini">
            <div className="scene-rt-mini-seats" role="presentation">
              {(ctx?.participants ?? []).map((a) => (
                <span key={a.id} className="scene-rt-mini-seat" title={`${a.name} · ${a.role}`}>
                  <AgentAvatar agent={a} size={16} />
                </span>
              ))}
            </div>
            <span className="scene-rt-mini-heading">{heading ?? `${ctx?.participants.length ?? 0} 席圆桌`}</span>
            <button
              type="button"
              className="scene-rt-top-toggle"
              title="展开席位环与议程"
              onClick={() => update({ topMini: false })}
            >
              <ChevronDown size={14} />
            </button>
          </div>
        ) : (
          <div className="scene-rt-top">
            {narrow ? (
              <SeatStrip
                agents={ctx?.participants ?? []}
                speakingId={busy.speakingId}
                waitingIds={ctx?.waitingIds ?? []}
                onSelect={onSeat}
              />
            ) : (
              <SeatRing
                agents={ctx?.participants ?? []}
                speakingId={busy.speakingId}
                waitingIds={ctx?.waitingIds ?? []}
                onSelect={onSeat}
              />
            )}
            {steps.length > 0 ? (
              <AgendaTrack items={steps} heading={heading} onPick={onPick} />
            ) : null}
            <button
              type="button"
              className="scene-rt-top-toggle"
              title="收起席位环与议程"
              onClick={() => update({ topMini: true })}
            >
              <ChevronUp size={14} />
            </button>
          </div>
        )}
        <div className="scene-rt-body">
          <div className="scene-rt-main">
            {children}
            {panel && !narrow && pref.closed ? (
              <button type="button" className="scene-rt-reopen" title="显示汇聚板" onClick={() => update({ closed: false })}>
                <LayoutGrid size={13} />
                汇聚板
              </button>
            ) : null}
          </div>
          {panel && !narrow ? (
            pref.closed ? null : pref.collapsed ? (
              <aside className="scene-rt-aside scene-rt-rail">
                <button type="button" className="scene-rt-expand" title="展开汇聚板" onClick={() => update({ collapsed: false })}>
                  <ChevronLeft size={14} />
                </button>
                <span className="scene-rt-side-label">汇聚板</span>
              </aside>
            ) : (
              <aside className="scene-rt-aside">{panel}</aside>
            )
          ) : null}
        </div>
        {panel && narrow ? <SceneDrawer label="汇聚板">{panel}</SceneDrawer> : null}
      </div>
    </PanelChromeProvider>
  )
}
