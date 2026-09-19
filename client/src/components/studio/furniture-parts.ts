/**
 * M65-B：家具程序化几何族——kind → parts 表（纯函数，可单测；渲染层只做映射）。
 *
 * 单位 mm（渲染时经 mmToM 换算）；原点 = 家具中心，底面贴地（y=0），x 向 = 宽，z 向（对应俯视 y）= 深。
 * 色槽：base = 规格主色；accent = 规格第二色（缺省回退 base）。
 */
import type { FurnitureKind } from '@multi-agent/shared'
import { specOf } from './design-scene-model'

export type FurniturePart =
  | { t: 'box'; w: number; h: number; d: number; x: number; y: number; z: number; slot: 'base' | 'accent' }
  | { t: 'cylinder'; r: number; h: number; x: number; y: number; z: number; slot: 'base' | 'accent' }
  | { t: 'sphere'; r: number; x: number; y: number; z: number; slot: 'base' | 'accent' }
  | { t: 'cone'; r: number; h: number; x: number; y: number; z: number; slot: 'base' | 'accent' }

const box = (w: number, h: number, d: number, x: number, y: number, z: number, slot: 'base' | 'accent' = 'base'): FurniturePart => ({
  t: 'box',
  w,
  h,
  d,
  x,
  y,
  z,
  slot,
})

/** 家具几何族派生（z 为俯视深向；坑位对齐规格表，越界不报错——渲染层宽容） */
export function furniturePartsOf(kind: FurnitureKind): FurniturePart[] {
  const s = specOf(kind)
  const w = s.width
  const d = s.depth
  const h = s.height
  switch (kind) {
    case 'bed':
      return [
        box(w, 300, d, 0, 150, 0),
        box(w * 0.94, 140, d * 0.62, 0, 370, d * 0.14, 'accent'), // 被面（枕侧留空）
        box(w * 0.9, 120, 420, 0, 380, -d * 0.36, 'accent'), // 枕区
      ]
    case 'sofa':
      return [
        box(w, 340, d, 0, 170, 0),
        box(w, 420, 160, 0, 620, -d / 2 + 80), // 靠背（贴后沿）
        box(140, 480, d - 60, -w / 2 + 70, 460, 30), // 左扶手
        box(140, 480, d - 60, w / 2 - 70, 460, 30), // 右扶手
      ]
    case 'table-dining':
    case 'desk': {
      const t = 60
      return [
        box(w, t, d, 0, h - t / 2, 0, 'accent'), // 桌面
        box(80, h - t, d * 0.8, -w / 2 + 60, (h - t) / 2, 0), // 左侧板
        box(80, h - t, d * 0.8, w / 2 - 60, (h - t) / 2, 0), // 右侧板
      ]
    }
    case 'table-coffee':
      return [box(w, 60, d, 0, h - 30, 0, 'accent'), box(w * 0.8, h - 60, d * 0.7, 0, (h - 60) / 2, 0)]
    case 'chair':
      return [box(w, 60, d, 0, h - 30, 0, 'accent'), box(w, h - 60, 80, 0, (h - 60) / 2 + 60, -d / 2 + 40)]
    case 'cabinet':
    case 'tv-stand':
    case 'wardrobe':
    case 'custom-box':
      return [box(w, h, d, 0, h / 2, 0), box(w * 0.96, 40, d * 0.96, 0, h - 20, 0, 'accent')]
    case 'plant':
      return [
        { t: 'cylinder', r: w * 0.22, h: 320, x: 0, y: 160, z: 0, slot: 'base' },
        { t: 'sphere', r: w * 0.42, x: 0, y: 320 + w * 0.42 + 120, z: 0, slot: 'accent' },
      ]
    case 'lamp':
      return [
        { t: 'cylinder', r: 40, h: h - 340, x: 0, y: (h - 340) / 2, z: 0, slot: 'base' },
        { t: 'cone', r: 200, h: 280, x: 0, y: h - 200, z: 0, slot: 'accent' },
        { t: 'cylinder', r: 140, h: 30, x: 0, y: 15, z: 0, slot: 'base' },
      ]
    case 'rug':
      return [box(w, 20, d, 0, 10, 0, 'base')]
    default:
      return [box(w, h, d, 0, h / 2, 0)]
  }
}

/** 家具包围盒（mm；拾取 / 高亮包框用） */
export function furnitureAabbOf(kind: FurnitureKind): { w: number; h: number; d: number } {
  const s = specOf(kind)
  return { w: s.width, h: s.height, d: s.depth }
}
