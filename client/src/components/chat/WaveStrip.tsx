/**
 * M37-3：悬浮阶段条（ADR 0065）——滚动位置派生的「当前波次」方位提示（不用 CSS sticky）：
 * 首个可见行向前扫描到的波次 → 波次号 + 成员头像流；点击跳波起点（focusMessage 定位闪光）。
 * 由调用侧在「上滑离开底部」且存在波次时挂载；头像订阅为 primitive key，不随流式增量重渲染。
 * 续修订（顶部方位条，ADR 0065 决策 4）：顶部渐隐遮罩 + 轻量化药丸——滚过顶端的消息在边缘
 * 自然淡出，消除「药丸与消息头部同排交错」的观感（用户实测红框反馈）；补「共 N 波」方位读数
 * （总数 ≥2 才显示，与波次分隔行同门限）；药丸偏移 `top-3.5` → `top-1`（贴顶边——用户二次实测
 * 红框「需要上移」：贴边后不再下探到首条消息，渐隐区内呈边缘读数；覆盖 v70 的 14px 判定）。
 * M39（§97，ADR 0149）：生产型场景换显示——development / sre 传 group 且本波成员命中阶段映射时，
 * 药丸改为「阶段名 + 阶段进度段（x/y）」；未命中 → 回退波次数字（口径零变化）。
 */
import * as React from 'react'
import { Waves } from 'lucide-react'
import type { AgentGroup } from '@multi-agent/shared'
import type { WaveInfo } from '../../lib/chat-rows'
import { baseAgentId } from '@multi-agent/shared'
import { labelOfMemberKey } from '../../lib/members'
import { waveStage } from '../../lib/stage-map'
import { useAgentStore } from '../../stores/agent-store'
import { useSessionStore, useCurrentSession } from '../../stores/session-store'
import { AgentAvatar } from '../agents/AgentAvatar'

export function WaveStrip({
  info,
  total,
  group,
  onJump,
}: {
  info: WaveInfo
  /** 波次总数（「共 N 波」读数；缺省 / 单波不显示） */
  total?: number
  /** M39：场景元数据（development / sre → 阶段名换显示；缺省保持波次数字） */
  group?: AgentGroup
  onJump: () => void
}): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const session = useCurrentSession()
  // M77：成员键（分身实例）——头像 / 署名按实例，阶段映射（M39）仍按基础角色口径
  const memberKey = useSessionStore((s) =>
    info.memberIds
      .map((id) => {
        const m = s.byId.get(id)
        return m?.memberKey ?? m?.agentId ?? ''
      })
      .join(','),
  )

  const keys = memberKey.split(',').filter(Boolean)
  const members = keys
    .map((k) => agents.find((a) => a.id === baseAgentId(k)))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
  const labels = keys.map((k) => labelOfMemberKey(agents, session, k))

  // M39：阶段换显示（未命中阶段映射 → stage 为 undefined，回退波次数字）
  const stage = React.useMemo(() => waveStage(group?.id, members), [group?.id, members])

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30">
      {/* 顶部渐隐遮罩：让滚过顶端的内容淡出，药丸不再与消息头部同排交错 */}
      <div aria-hidden data-wave-scrim="" className="h-12 bg-gradient-to-b from-background via-background/80 to-transparent" />
      <div className="absolute inset-x-0 top-1 flex justify-center">
        <button
          type="button"
          data-wave-strip={info.turnIndex}
          {...(stage ? { 'data-wave-stage': stage.label } : {})}
          onClick={onJump}
          title={stage ? `跳到第 ${info.turnIndex + 1} 波起点（${stage.label}）` : `跳到第 ${info.turnIndex + 1} 波起点`}
          className="pointer-events-auto flex max-w-[80%] animate-fade-in items-center gap-1.5 rounded-full border border-border/70 bg-card/95 py-0.5 pl-2 pr-2.5 text-[11px] shadow-sm backdrop-blur transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Waves className="size-3.5 shrink-0 text-primary" />
          {stage ? (
            <>
              <span className="shrink-0 font-medium">{stage.label}</span>
              {typeof stage.index === 'number' && typeof stage.total === 'number' ? (
                <>
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  <span className="shrink-0 text-muted-foreground/70">阶段 {stage.index}/{stage.total}</span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <span className="shrink-0 font-medium">第 {info.turnIndex + 1} 波</span>
              {typeof total === 'number' && total >= 2 ? (
                <>
                  <span className="shrink-0 text-muted-foreground/40">·</span>
                  <span className="shrink-0 text-muted-foreground/70">共 {total} 波</span>
                </>
              ) : null}
            </>
          )}
          {members.length > 0 && (
            <span className="flex shrink-0 -space-x-1.5">
              {members.slice(0, 6).map((a, i) => (
                <AgentAvatar key={`${a.id}-${i}`} agent={a} size={18} animated={false} className="ring-1 ring-card" />
              ))}
            </span>
          )}
          {labels.length > 0 && (
            <span className="min-w-0 truncate text-muted-foreground">{labels.join('、')}</span>
          )}
        </button>
      </div>
    </div>
  )
}
