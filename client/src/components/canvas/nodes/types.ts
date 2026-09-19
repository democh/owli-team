/**
 * M31：画布 React Flow 节点类型（data 使用宽松索引签名，shared 具体 data 由各节点组件内部收窄）。
 */
import type { Node, NodeProps } from '@xyflow/react'
import type { CanvasNodeType } from '@multi-agent/shared'

export type CanvasFlowNode = Node<Record<string, unknown>, CanvasNodeType>

export type CanvasNodeProps = NodeProps<CanvasFlowNode>
