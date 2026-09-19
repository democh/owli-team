/**
 * M65-B：DesignScene 模型层单测（纯函数：解析 / 几何 / 编辑操作）。
 */
import { describe, expect, it } from 'vitest'
import {
  addFurniture,
  applyMaterialColor,
  emptyScene,
  nudgeFurniture,
  parseDesignScene,
  planGeometryOf,
  removeFurniture,
  roomAreaM2,
  rotateFurniture,
  sceneBounds,
  serializeDesignScene,
  specOf,
} from '../src/components/studio/design-scene-model'

describe('M65-B：DesignScene 模型层', () => {
  it('emptyScene → serialize → parse 往返一致（单位 mm / 默认材质与光照）', () => {
    const scene = emptyScene('测试方案')
    const parsed = parseDesignScene(JSON.parse(serializeDesignScene(scene)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.filtered).toBe(0)
    expect(parsed.scene.name).toBe('测试方案')
    expect(parsed.scene.rooms).toHaveLength(1)
    expect(parsed.scene.rooms[0]!.polygon).toHaveLength(4)
    expect(parsed.scene.materials['地板']!.color).toBe('#e7ddcd')
    expect(parsed.scene.lights.sunElevation).toBe(45)
  })

  it('parse：顶层结构错误逐类报错（非对象 / 版本不符 / 缺 rooms / 缺 furniture）', () => {
    expect(parseDesignScene(42).ok).toBe(false)
    expect(parseDesignScene({ version: 2, rooms: [], furniture: [] }).ok).toBe(false)
    const noRooms = parseDesignScene({ version: 1, furniture: [] })
    expect(noRooms.ok).toBe(false)
    if (!noRooms.ok) expect(noRooms.error).toContain('rooms')
    expect(parseDesignScene({ version: 1, rooms: [] }).ok).toBe(false)
  })

  it('parse：条目级宽容过滤（坏多边形 / 未知 kind / 悬挂门窗）并计数', () => {
    const parsed = parseDesignScene({
      version: 1,
      name: '过滤',
      rooms: [
        { id: 'r1', name: '客厅', polygon: [[0, 0], [3000, 0], [3000, 3000]], height: 2800, floor: '地板', wall: '墙面' },
        { id: 'r2', polygon: [[0, 0], [1, 1]], height: 2800 }, // 顶点不足 → 过滤
        'bad', // 非对象 → 过滤
      ],
      openings: [
        { id: 'o1', roomId: 'r1', wallIndex: 0, type: 'window', offset: 500, width: 1200, height: 1400 },
        { id: 'o2', roomId: 'ghost', wallIndex: 0, type: 'door', offset: 0, width: 900, height: 2100 }, // 房间不存在 → 过滤
      ],
      furniture: [
        { id: 'f1', kind: 'sofa', x: 1000, y: 500, rotation: 90 },
        { id: 'f2', kind: 'spaceship', x: 0, y: 0, rotation: 0 }, // 未知 kind → 过滤
      ],
      materials: {},
      lights: {},
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.filtered).toBe(4) // r2 + 'bad' + o2 + f2
    expect(parsed.scene.rooms).toHaveLength(1)
    expect(parsed.scene.openings).toHaveLength(1)
    expect(parsed.scene.furniture).toHaveLength(1)
    // 缺省填充：materials → 默认板；lights → 缺省值
    expect(parsed.scene.materials['墙面']).toBeTruthy()
    expect(parsed.scene.lights.intensity).toBe(1.4)
    // rotation 归一化
    expect((parseDesignScene({ version: 1, rooms: [], furniture: [{ kind: 'chair', x: 0, y: 0, rotation: 450 }] }) as { ok: true; scene: { furniture: { rotation: number }[] } }).scene.furniture[0]!.rotation).toBe(90)
  })

  it('几何派生：面积（鞋带）/ 包围盒 / 俯视平面几何（北在上，等比 letterbox）', () => {
    const scene = emptyScene()
    expect(roomAreaM2(scene.rooms[0]!.polygon)).toBe(15.1) // 4.2 × 3.6
    const b = sceneBounds(scene)
    expect([b.width, b.depth]).toEqual([4200, 3600])

    const withBed = addFurniture(scene, 'bed')
    const plan = planGeometryOf(withBed, 200)
    expect(plan.viewBox).toBe('0 0 200 200')
    expect(plan.rooms[0]!.d.startsWith('M')).toBe(true)
    expect(plan.rooms[0]!.d.endsWith('Z')).toBe(true)
    expect(plan.furniture).toHaveLength(1)
    // 北在上：房间底边（世界 y=0，南）的 SVG y 应大于顶边（世界 y=3600，北）
    const d = plan.rooms[0]!.d
    expect(d.length).toBeGreaterThan(10)
    const bed = plan.furniture[0]!
    // 床 1500×2000（宽 < 深）：缩放后 SVG w < d
    expect(bed.w).toBeLessThan(bed.d)
  })

  it('编辑操作：置入 / 移动（50 吸附）/ 旋转（15 吸附）/ 删除 / 材质换色（不可变）', () => {
    const s0 = emptyScene()
    const s1 = addFurniture(s0, 'sofa')
    expect(s0.furniture).toHaveLength(0) // 不可变
    expect(s1.furniture).toHaveLength(1)
    const id = s1.furniture[0]!.id

    const s2 = nudgeFurniture(s1, id, 123, -88)
    expect(s2.furniture[0]!.x % 50).toBe(0)
    expect(s2.furniture[0]!.y % 50).toBe(0)

    const s3 = rotateFurniture(s2, id, 7)
    expect(s3.furniture[0]!.rotation % 15).toBe(0)
    const s4 = rotateFurniture(s3, id, 350) // 回绕归一
    expect(s4.furniture[0]!.rotation).toBeGreaterThanOrEqual(0)
    expect(s4.furniture[0]!.rotation).toBeLessThan(360)

    const s5 = removeFurniture(s4, id)
    expect(s5.furniture).toHaveLength(0)

    const s6 = applyMaterialColor(s5, '地板', '#ccbbaa')
    expect(s6.materials['地板']!.color).toBe('#ccbbaa')
    expect(s6.materials['地板']!.texture).toBe('wood') // 既有属性保留
  })

  it('家具规格表：13 类齐备；未知 kind 回退 custom-box', () => {
    expect(specOf('sofa').label).toBe('沙发')
    expect(specOf('bed').depth).toBe(2000)
    expect(specOf('unknown' as 'sofa').label).toBe('体块')
  })
})
