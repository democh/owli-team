/**
 * 协作图谱画布类型（§28.4，M21）：React Flow v12 的 data 需具备隐式索引签名（用 type 而非 interface）。
 * - FlowNodeData：节点卡渲染数据（M17 状态 + M21 焦点 / 过渡 / 脉冲）
 * - RelayEdgeData：边渲染数据（接力能量层 / 编制虚线 / 焦点态）
 * - CoreData：圆桌中心图腾（场景名 + 成员数 + 主题色）
 */
import type { GraphNodeData } from '../../../lib/graph'
import type { LayoutMode } from '../../../lib/graph-layout'

export type FlowNodeData = GraphNodeData & {
  /** 焦点态：非关联节点降透明 */
  dimmed: boolean
  /** 选中（档案面板打开） */
  pinned: boolean
  /** 入场动画延迟（ms，按列 / 角度编排） */
  enterDelay: number
  /** 布局过渡（切换布局 / 整理时开启；拖动中关闭避免跟手滞后） */
  smooth: boolean
  /** 接力脉冲 nonce（递增触发目标节点一次性「接收」光环） */
  flash: number
  /** 布局模式（radial 下节点描边更圆润） */
  layout: LayoutMode
}

export type CoreData = {
  /** 场景名（圆桌中心） */
  name: string
  /** 在场成员数 */
  count: number
  /** 分组主题色（缺省 primary） */
  color: string | null
  /** 入场动画延迟（ms） */
  enterDelay: number
}

export type RelayEdgeData = {
  kind: 'relay' | 'chain'
  /** 接手次数（接力边；编制边恒 0） */
  count: number
  layout: LayoutMode
  /** 最近一棒：最近一条 agent 消息派生的交接边（琥珀高亮 + 光晕，与节点 recent 同源） */
  recent: boolean
  /** 回退接力：目标排名在源之前（长虚线 + 语义色；仅接力链布局有排名口径） */
  backward: boolean
  /** 运行中：能量持续流动（安静模式除外） */
  flowing: boolean
  /** 接力脉冲 nonce（>0 时渲染能量层并播一次性爆发） */
  pulse: number
  /** 接力溯源重放 nonce（点击边触发一次性加速流光；与 pulse 独立） */
  replay: number
  /** 焦点态：hover / 选中节点的关联边 */
  incident: boolean
  /** 焦点态下与焦点无关的边 */
  muted: boolean
  /** 焦点态标签（接手 N 次 · 最近时间） */
  text?: string
  /** 安静模式：关闭流动动画 */
  quiet: boolean
}
