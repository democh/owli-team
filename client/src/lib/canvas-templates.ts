/**
 * M31：画布模板（空态四卡片落位）—— 创作台 / 脑图工坊 / 分镜台 / 素材墙。
 *
 * 模板先按局部坐标构建，再整体平移使外接框中心落在 origin（落点）；
 * 画框模板的子节点使用相对坐标（parentId）。
 */
import type { CanvasEdge, CanvasNode } from '@multi-agent/shared'
import { createNode, newEdgeId, boundingBox } from './canvas'

export type CanvasTemplateId = 'studio' | 'mind' | 'storyboard' | 'wall'

export interface CanvasTemplateMeta {
  id: CanvasTemplateId
  name: string
  desc: string
}

export const CANVAS_TEMPLATES: CanvasTemplateMeta[] = [
  { id: 'studio', name: '创作台', desc: '写提示词 → 生图 → 变体迭代' },
  { id: 'mind', name: '脑图工坊', desc: '把一个主题铺开成一棵树' },
  { id: 'storyboard', name: '分镜台', desc: '分镜格排开，连首尾帧出片' },
  { id: 'wall', name: '素材墙', desc: '图片视频钉满一面墙' },
]

function link(source: string, target: string, kind: CanvasEdge['kind']): CanvasEdge {
  return { id: newEdgeId(), source, target, kind }
}

/** 构建模板内容（局部坐标 → origin 居中） */
export function buildTemplate(
  id: CanvasTemplateId,
  origin: { x: number; y: number },
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const nodes: CanvasNode[] = []
  const edges: CanvasEdge[] = []

  switch (id) {
    case 'studio': {
      const prompt = createNode('prompt', { x: 0, y: 24 }, { text: '一只戴工程师帽的猫，扁平插画，柔和晨光', negative: '' })
      const image = createNode('image', { x: 340, y: 0 }, { prompt: '生成结果会落在图片节点上', source: 'generate' })
      const note = createNode('note', { x: 340, y: 250 }, { text: '选中图片节点后打开生成面板；也可以直接让 Agent 帮你生成。', accent: 'sky' })
      nodes.push(prompt, image, note)
      edges.push(link(prompt.id, image.id, 'flow'))
      break
    }
    case 'mind': {
      const root = createNode('mind', { x: 0, y: 84 }, { text: '中心主题' })
      const children = ['先想清楚的问题', '下一步要做的', '需要谁的输入'].map((text, i) =>
        createNode('mind', { x: 300, y: i * 84 }, { text }),
      )
      nodes.push(root, ...children)
      for (const c of children) edges.push(link(root.id, c.id, 'mind'))
      break
    }
    case 'storyboard': {
      const group = createNode('group', { x: 0, y: 0 }, { title: '分镜脚本' }, { width: 680, height: 260 })
      const shots = ['镜头 1 · 建立场景', '镜头 2 · 冲突升级', '镜头 3 · 收束落点'].map((prompt, i) =>
        createNode('video', { x: 24 + i * 216, y: 64 }, { prompt }, { width: 200, height: 156, parentId: group.id }),
      )
      const note = createNode('note', { x: 0, y: 300 }, { text: '把每格与首尾帧素材连线，选中即可生成视频。', accent: 'rose' })
      nodes.push(group, ...shots, note)
      break
    }
    case 'wall': {
      const group = createNode('group', { x: 0, y: 0 }, { title: '素材墙' }, { width: 640, height: 420 })
      const slot = (x: number, y: number): CanvasNode =>
        createNode('image', { x, y }, {}, { width: 276, height: 156, parentId: group.id })
      const cells = [slot(24, 64), slot(340, 64), slot(24, 240), slot(340, 240)]
      const note = createNode('note', { x: 700, y: 24 }, { text: '把图片 / 视频拖进画布，素材会自动落墙；也可以从交付件「送上画布」。', accent: 'emerald' })
      nodes.push(group, ...cells, note)
      break
    }
  }

  // 整体平移：外接框中心 → origin
  const box = boundingBox(nodes)
  if (box) {
    const dx = Math.round(origin.x - (box.x + box.width / 2))
    const dy = Math.round(origin.y - (box.y + box.height / 2))
    if (dx !== 0 || dy !== 0) {
      for (const n of nodes) {
        if (n.parentId) continue // 子节点保持相对坐标
        n.position = { x: n.position.x + dx, y: n.position.y + dy }
      }
    }
  }
  return { nodes, edges }
}
