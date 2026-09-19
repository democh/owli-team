/**
 * M31：React Flow 节点类型注册表（节点类型注册表扩展位：新增类型 = shared 联合类型 + 组件 + 此处登记）。
 */
import type { NodeTypes } from '@xyflow/react'
import { ArtifactNode } from './ArtifactNode'
import { GameNode } from './GameNode'
import { GroupNode } from './GroupNode'
import { ImageNode } from './ImageNode'
import { KlineNode } from './KlineNode'
import { MindNode } from './MindNode'
import { NoteNode } from './NoteNode'
import { PromptNode } from './PromptNode'
import { VideoNode } from './VideoNode'

export const CANVAS_NODE_TYPES: NodeTypes = {
  image: ImageNode,
  video: VideoNode,
  note: NoteNode,
  prompt: PromptNode,
  mind: MindNode,
  artifact: ArtifactNode,
  group: GroupNode,
  game: GameNode,
  kline: KlineNode,
}

export type { CanvasFlowNode, CanvasNodeProps } from './types'
