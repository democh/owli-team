/**
 * M52-A 元件 4/12：席位环（SeatRing）——roundtable 顶部（§7.6）。
 * 在场上成员环形排布：当前发言高亮、等待序描边；点击席位 onSelect 回填 @ 草稿。
 * M57 修订：几何修正——座位盒 = 头像盒（名字不参与盒居中），头像中心精确落位环周。
 * M59 修订：重设计为俯视圆桌——名字径向朝外四向锚定（上 / 右 / 下 / 左，与桌面、头像零交叉、
 * 去掉底色贴纸感）；桌面收为实心圆面（头像内缘微叠坐沿）；发言席头像主色描边 + 外光环。
 */
import * as React from 'react'
import type { AgentDefinition } from '@multi-agent/shared'
import { cn } from '../../../lib/utils'
import { AgentAvatar } from '../../agents/AgentAvatar'

/** 头像直径（与 CSS .scene-sr-seat 盒宽高联动） */
const AVATAR_SIZE = 26
/** 头像中心距环心 */
const RING_RADIUS = 40
/** 名字与头像外缘间隙 */
const NAME_GAP = 3
/** 名字行高（上 / 下向占位） */
const NAME_LINE = 13
/** 左 / 右向名字最大宽（超出省略；上 / 下向放宽见 CSS） */
const NAME_NARROW = 32

/** 环容器尺寸：恰好容纳四向朝外的名字（左 / 右名字最宽、上 / 下名字最高） */
const RING_W = 2 * (RING_RADIUS + AVATAR_SIZE / 2 + NAME_GAP + NAME_NARROW)
const RING_H = 2 * (RING_RADIUS + AVATAR_SIZE / 2 + NAME_GAP + NAME_LINE)

/** 名字朝外方位：按落位角就近取上 / 右 / 下 / 左（屏幕坐标系，y 向下） */
function nameDir(angle: number): 'up' | 'right' | 'down' | 'left' {
  // 落位公式 rotate(θ) translateY(−R) 使 θ=−90 落在正左向（而非正上）——页面方位角 = θ − 90°
  const a = (((angle - 90) % 360) + 360) % 360
  if (a < 45 || a >= 315) return 'right'
  if (a < 135) return 'down'
  if (a < 225) return 'left'
  return 'up'
}

export function SeatRing({
  agents,
  speakingId,
  waitingIds = [],
  onSelect,
}: {
  agents: AgentDefinition[]
  speakingId?: string
  waitingIds?: string[]
  onSelect?: (agentId: string) => void
}): React.JSX.Element {
  const waiting = new Set(waitingIds)
  const n = Math.max(agents.length, 1)
  return (
    <div className="scene-seat-ring" style={{ width: RING_W, height: RING_H }} role="list" aria-label="席位环">
      <span className="scene-sr-table" aria-hidden />
      {agents.map((agent, i) => {
        const angle = -90 + (360 / n) * i
        const speaking = agent.id === speakingId
        return (
          <button
            key={agent.id}
            type="button"
            role="listitem"
            className={cn('scene-sr-seat', speaking && 'scene-sr-speaking', waiting.has(agent.id) && 'scene-sr-waiting')}
            data-dir={nameDir(angle)}
            style={{
              transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-${RING_RADIUS}px) rotate(${-angle}deg)`,
            }}
            title={`${agent.name} · ${agent.role}`}
            onClick={() => onSelect?.(agent.id)}
          >
            <AgentAvatar agent={agent} size={AVATAR_SIZE} animated={speaking} className="scene-sr-avatar" />
            <span className="scene-sr-name">{agent.name}</span>
          </button>
        )
      })}
    </div>
  )
}
