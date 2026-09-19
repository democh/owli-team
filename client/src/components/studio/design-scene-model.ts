/**
 * M65-B：DesignScene 模型层（纯函数，零 three 依赖）——解析 / 校验 / 派生 / 规格表。
 *
 * 分工：本文件是工作台与消息卡共用的**唯一纯逻辑源**（可单测，无 WebGL）；
 * 渲染层（StudioCanvas）与面板层（StudioPanel）只消费本文件的输出。
 * 单位：场景内部 mm；显示与三维渲染经 mmToM 换算为 m。
 * 坐标系：俯视坐标 (x, y)，x 向右 / y 向上（北）；三维映射 x → X，y → -Z（北 = -Z）。
 */
import type {
  DesignFurniture,
  DesignScene,
  FurnitureKind,
} from '@multi-agent/shared'
import { DESIGN_SCENE_VERSION, FURNITURE_KINDS } from '@multi-agent/shared'

/** mm → m（三维与显示换算） */
export const mmToM = (v: number): number => v / 1000

// ---------- 家具规格表（13 类程序化几何族；渲染与家具库共用） ----------

export interface FurnitureSpec {
  label: string
  /** X 向宽（mm） */
  width: number
  /** Y 向深（mm） */
  depth: number
  /** 高度（mm） */
  height: number
  /** 默认色（引用 material 时被覆盖） */
  color: string
  /** 顶色（可选第二色：如被面 / 桌面） */
  accent?: string
}

export const FURNITURE_SPEC: Record<FurnitureKind, FurnitureSpec> = {
  bed: { label: '双人床', width: 1500, depth: 2000, height: 450, color: '#b08d6a', accent: '#efe7dc' },
  sofa: { label: '沙发', width: 1800, depth: 900, height: 780, color: '#a8a29e', accent: '#d6d3d1' },
  'table-dining': { label: '餐桌', width: 1400, depth: 800, height: 750, color: '#a67b5b' },
  'table-coffee': { label: '茶几', width: 1000, depth: 500, height: 420, color: '#b08d6a' },
  chair: { label: '单椅', width: 450, depth: 450, height: 450, color: '#9a8c7e' },
  cabinet: { label: '边柜', width: 800, depth: 400, height: 800, color: '#a67b5b' },
  desk: { label: '书桌', width: 1200, depth: 600, height: 750, color: '#b08d6a' },
  'tv-stand': { label: '电视柜', width: 1600, depth: 400, height: 450, color: '#8d7b68' },
  wardrobe: { label: '衣柜', width: 1200, depth: 600, height: 2200, color: '#a89a8a' },
  plant: { label: '绿植', width: 500, depth: 500, height: 1200, color: '#4a5d3a' },
  lamp: { label: '落地灯', width: 400, depth: 400, height: 1500, color: '#d6c7a1' },
  rug: { label: '地毯', width: 2000, depth: 1400, height: 20, color: '#cbbda9' },
  'custom-box': { label: '体块', width: 800, depth: 800, height: 800, color: '#b8b2aa' },
}

/** 家具规格查询（未知 kind fallback custom-box——宽容原则） */
export function specOf(kind: FurnitureKind): FurnitureSpec {
  return FURNITURE_SPEC[kind] ?? FURNITURE_SPEC['custom-box']
}

// ---------- 解析与校验（fail-safe：顶层结构错报错；条目级宽容过滤） ----------

export type ParseResult = { ok: true; scene: DesignScene; filtered: number } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v.length > 0 ? v : fallback)

/** 默认材质板（新场景 / 缺省补齐） */
export function defaultMaterials(): DesignScene['materials'] {
  return {
    地板: { color: '#e7ddcd', roughness: 0.75, texture: 'wood' },
    墙面: { color: '#f2efe9', roughness: 0.9, texture: 'wall' },
    木作: { color: '#a67b5b', roughness: 0.6, texture: 'wood' },
    织物: { color: '#cbbda9', roughness: 1, texture: 'fabric' },
  }
}

/** 默认光照（午后侧光） */
export function defaultLights(): DesignScene['lights'] {
  return { sunAzimuth: 210, sunElevation: 45, intensity: 1.4, ambient: 0.55 }
}

/** 新建空白场景：一个 4200×3600 矩形房间 + 默认材质板（B0 尺寸基线） */
export function emptyScene(name = '未命名方案'): DesignScene {
  return {
    version: 1,
    name,
    unit: 'mm',
    rooms: [
      {
        id: 'room-1',
        name: '客厅',
        polygon: [
          [0, 0],
          [4200, 0],
          [4200, 3600],
          [0, 3600],
        ],
        height: 2800,
        floor: '地板',
        wall: '墙面',
      },
    ],
    openings: [
      { id: 'op-1', roomId: 'room-1', wallIndex: 0, type: 'window', offset: 1600, width: 1500, height: 1500, sill: 900 },
      { id: 'op-2', roomId: 'room-1', wallIndex: 3, type: 'door', offset: 1500, width: 900, height: 2100 },
    ],
    furniture: [],
    materials: defaultMaterials(),
    lights: defaultLights(),
  }
}

/**
 * 解析 DesignScene JSON（未知字段忽略；条目级宽容过滤并计数）。
 * 顶层结构错误（非对象 / 版本不符 / 无 rooms 数组）→ 结构化错误（调用方渲染错误卡 + 源码回退）。
 */
export function parseDesignScene(raw: unknown): ParseResult {
  if (!isObj(raw)) return { ok: false, error: '场景数据不是对象：无法解析（请检查文件内容）' }
  const version = raw.version
  if (version !== DESIGN_SCENE_VERSION) {
    return { ok: false, error: `不支持的场景版本（${String(version)}）：本工作台支持 v${DESIGN_SCENE_VERSION}（未知版本只读）` }
  }
  if (!Array.isArray(raw.rooms)) return { ok: false, error: '场景缺少 rooms 字段（房间列表）' }
  if (!Array.isArray(raw.furniture)) return { ok: false, error: '场景缺少 furniture 字段（家具列表）' }

  let filtered = 0
  const rooms: DesignScene['rooms'] = []
  for (const r of raw.rooms) {
    if (!isObj(r)) {
      filtered++
      continue
    }
    const rawPoly = Array.isArray(r.polygon) ? r.polygon : []
    const polygon = rawPoly
      .filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
      .map((p): [number, number] => [p[0], p[1]])
    if (polygon.length < 3) {
      filtered++
      continue
    }
    rooms.push({
      id: str(r.id, `room-${rooms.length + 1}`),
      name: str(r.name, `房间 ${rooms.length + 1}`),
      polygon,
      height: Math.max(2000, Math.min(4500, num(r.height, 2800))),
      floor: str(r.floor, '地板'),
      wall: str(r.wall, '墙面'),
    })
  }

  const openings: DesignScene['openings'] = []
  const rawOpenings = Array.isArray(raw.openings) ? raw.openings : []
  for (const o of rawOpenings) {
    if (!isObj(o)) {
      filtered++
      continue
    }
    const roomId = str(o.roomId, '')
    if (!rooms.some((r) => r.id === roomId)) {
      filtered++
      continue
    }
    openings.push({
      id: str(o.id, `op-${openings.length + 1}`),
      roomId,
      wallIndex: Math.max(0, Math.floor(num(o.wallIndex, 0))),
      type: o.type === 'door' ? 'door' : 'window',
      offset: Math.max(0, num(o.offset, 0)),
      width: Math.max(300, num(o.width, 900)),
      height: Math.max(300, num(o.height, 1200)),
      ...(typeof o.sill === 'number' ? { sill: Math.max(0, o.sill) } : {}),
    })
  }

  const furniture: DesignScene['furniture'] = []
  const rawFurniture = raw.furniture
  for (const f of rawFurniture) {
    if (!isObj(f)) {
      filtered++
      continue
    }
    const kind = f.kind as FurnitureKind
    if (!(FURNITURE_KINDS as readonly string[]).includes(kind)) {
      filtered++
      continue
    }
    furniture.push({
      id: str(f.id, `f-${furniture.length + 1}`),
      kind,
      ...(typeof f.label === 'string' && f.label ? { label: f.label } : {}),
      x: num(f.x, 0),
      y: num(f.y, 0),
      rotation: ((num(f.rotation, 0) % 360) + 360) % 360,
      ...(typeof f.scale === 'number' && f.scale > 0 ? { scale: f.scale } : {}),
      ...(typeof f.material === 'string' && f.material ? { material: f.material } : {}),
    })
  }

  // 空对象 / 缺失 → 默认材质板（fail-safe：无材质不可渲染）
  const materials: DesignScene['materials'] =
    isObj(raw.materials) && Object.keys(raw.materials).length > 0
      ? (raw.materials as DesignScene['materials'])
      : defaultMaterials()
  const lightsRaw = isObj(raw.lights) ? raw.lights : {}
  const lights: DesignScene['lights'] = {
    sunAzimuth: ((num(lightsRaw.sunAzimuth, 210) % 360) + 360) % 360,
    sunElevation: Math.max(10, Math.min(90, num(lightsRaw.sunElevation, 45))),
    intensity: Math.max(0, Math.min(3, num(lightsRaw.intensity, 1.4))),
    ambient: Math.max(0, Math.min(1, num(lightsRaw.ambient, 0.55))),
  }

  return {
    ok: true,
    filtered,
    scene: {
      version: 1,
      name: str(raw.name, '未命名方案'),
      unit: 'mm',
      rooms,
      openings,
      furniture,
      materials,
      lights,
    },
  }
}

/** 场景 → JSON 文本（保存 / 导出；2 空格缩进稳定输出） */
export function serializeDesignScene(scene: DesignScene): string {
  return JSON.stringify(scene, null, 2) + '\n'
}

// ---------- 几何派生（面积 / 包围盒 / 平面几何） ----------

/** 多边形面积（鞋带公式；mm² → 返回 m²，保留 1 位） */
export function roomAreaM2(polygon: [number, number][]): number {
  let s = 0
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!
    const [x2, y2] = polygon[(i + 1) % polygon.length]!
    s += x1 * y2 - x2 * y1
  }
  return Math.round((Math.abs(s) / 2 / 1e6) * 10) / 10
}

export interface SceneBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
  width: number
  depth: number
}

/** 场景包围盒（mm；无房间时给默认 4200×3600 兜底） */
export function sceneBounds(scene: DesignScene): SceneBounds {
  if (scene.rooms.length === 0) return { minX: 0, minY: 0, maxX: 4200, maxY: 3600, width: 4200, depth: 3600 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const room of scene.rooms) {
    for (const [x, y] of room.polygon) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  return { minX, minY, maxX, maxY, width: maxX - minX, depth: maxY - minY }
}

// ---------- 平面（俯视 SVG）几何派生：工作台平面视图 + 缩略图共用 ----------

export interface PlanRect {
  id: string
  kind: FurnitureKind
  /** SVG 坐标系（左上原点，y 向下）中心点 */
  cx: number
  cy: number
  /** 旋转（度；SVG 顺时针为正，与场景 rotation 同向） */
  rotation: number
  w: number
  d: number
}

export interface PlanPolygon {
  id: string
  name: string
  /** SVG path d（闭合多边形） */
  d: string
  /** 面积（m²） */
  areaM2: number
}

export interface PlanGeometry {
  viewBox: string
  width: number
  height: number
  rooms: PlanPolygon[]
  furniture: PlanRect[]
}

/**
 * 俯视几何派生：世界坐标（x 右 / y 北）→ SVG（x 右 / y 下，北在上）。
 * 等比适配到 size×size 方框内（letterbox 居中；8% 边距）。
 */
export function planGeometryOf(scene: DesignScene, size = 200): PlanGeometry {
  const b = sceneBounds(scene)
  const pad = size * 0.08
  const inner = size - pad * 2
  const scale = Math.min(inner / Math.max(b.width, 1), inner / Math.max(b.depth, 1))
  const offX = pad + (inner - b.width * scale) / 2
  const offY = pad + (inner - b.depth * scale) / 2
  // 世界 (x,y) → SVG：x 同向；y 北向上 → svg y = (maxY - y)
  const toX = (x: number): number => offX + (x - b.minX) * scale
  const toY = (y: number): number => offY + (b.maxY - y) * scale

  const rooms: PlanPolygon[] = scene.rooms.map((room) => ({
    id: room.id,
    name: room.name,
    d: room.polygon.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${toX(x).toFixed(1)} ${toY(y).toFixed(1)}`).join(' ') + ' Z',
    areaM2: roomAreaM2(room.polygon),
  }))

  const furniture: PlanRect[] = scene.furniture.map((f) => {
    const spec = specOf(f.kind)
    const s = f.scale ?? 1
    return {
      id: f.id,
      kind: f.kind,
      cx: toX(f.x),
      cy: toY(f.y),
      rotation: f.rotation,
      w: spec.width * s * scale,
      d: spec.depth * s * scale,
    }
  })

  return { viewBox: `0 0 ${size} ${size}`, width: size, height: size, rooms, furniture }
}

// ---------- 编辑操作（不可变更新；供 hook / 测试共用） ----------

/** 家具置入（场景中心略偏随机位错开叠放；返回新场景） */
export function addFurniture(scene: DesignScene, kind: FurnitureKind): DesignScene {
  const b = sceneBounds(scene)
  const n = scene.furniture.length
  const item: DesignFurniture = {
    id: `f-${Date.now().toString(36)}-${n}`,
    kind,
    x: Math.round(b.minX + b.width / 2 + ((n % 3) - 1) * 600),
    y: Math.round(b.minY + b.depth / 2 + (((n / 3) | 0) % 3 - 1) * 600),
    rotation: 0,
  }
  return { ...scene, furniture: [...scene.furniture, item] }
}

/** 家具更新（就地替换；未知 id 原样返回） */
export function updateFurniture(scene: DesignScene, id: string, patch: Partial<DesignFurniture>): DesignScene {
  return { ...scene, furniture: scene.furniture.map((f) => (f.id === id ? { ...f, ...patch } : f)) }
}

/** 家具删除 */
export function removeFurniture(scene: DesignScene, id: string): DesignScene {
  return { ...scene, furniture: scene.furniture.filter((f) => f.id !== id) }
}

/** 家具移动（增量 mm；吸附 50mm） */
export function nudgeFurniture(scene: DesignScene, id: string, dx: number, dy: number): DesignScene {
  const snap = (v: number): number => Math.round(v / 50) * 50
  return {
    ...scene,
    furniture: scene.furniture.map((f) => (f.id === id ? { ...f, x: snap(f.x + dx), y: snap(f.y + dy) } : f)),
  }
}

/** 家具旋转（增量度；吸附 15°） */
export function rotateFurniture(scene: DesignScene, id: string, delta: number): DesignScene {
  return {
    ...scene,
    furniture: scene.furniture.map((f) =>
      f.id === id ? { ...f, rotation: ((Math.round((f.rotation + delta) / 15) * 15) % 360 + 360) % 360 } : f,
    ),
  }
}

/** 材质应用：把命名材质替换为新色（地板 / 墙面 / 木作 / 织物 + 自定义名） */
export function applyMaterialColor(scene: DesignScene, name: string, color: string): DesignScene {
  const base = scene.materials[name] ?? { color, roughness: 0.7 }
  return { ...scene, materials: { ...scene.materials, [name]: { ...base, color } } }
}
