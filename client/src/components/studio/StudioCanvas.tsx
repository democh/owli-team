/**
 * M65-B：3D 工作台画布（scene 驱动）——three.js + @react-three/fiber 渲染 DesignScene。
 *
 * 懒加载边界（§6.2 红线）：本组件及整个 three 栈只允许经 `studio-lazy.tsx` 动态导入；
 * 其余文件不得静态 import 本模块。
 * 坐标：俯视 (x, y) mm → 三维 (X = x/1000, Z = -y/1000)；北 = -Z。
 * 修订（M65-B 实施）：墙体外露条带（非房间挤出，避免封闭顶面）；门窗为贴墙标记板
 * （真洞口布尔运算列 v2）；家具为程序化几何族（furniture-parts.ts）。
 */
import * as React from 'react'
import * as THREE from 'three'
import { Canvas } from '@react-three/fiber'
import { Grid, OrbitControls } from '@react-three/drei'
import type { DesignFurniture, DesignLights, DesignMaterialPalette, DesignOpening, DesignRoom, DesignScene } from '@multi-agent/shared'
import { sceneBounds, specOf } from './design-scene-model'
import { furniturePartsOf, type FurniturePart } from './furniture-parts'

const mm = (v: number): number => v / 1000

/** 材质解析（缺失时回退默认色；渲染层宽容） */
function colorOf(materials: DesignMaterialPalette, name: string | undefined, fallback: string): string {
  if (!name) return fallback
  return materials[name]?.color ?? fallback
}
function roughnessOf(materials: DesignMaterialPalette, name: string | undefined, fallback = 0.8): number {
  if (!name) return fallback
  return materials[name]?.roughness ?? fallback
}

/** 墙段派生：边 i 的（中点 / 长度 / 朝向弧度）——俯视 mm */
function wallSegmentsOf(polygon: [number, number][]): { cx: number; cy: number; len: number; rot: number }[] {
  const out: { cx: number; cy: number; len: number; rot: number }[] = []
  for (let i = 0; i < polygon.length; i++) {
    const [x1, y1] = polygon[i]!
    const [x2, y2] = polygon[(i + 1) % polygon.length]!
    const dx = x2 - x1
    const dy = y2 - y1
    out.push({ cx: (x1 + x2) / 2, cy: (y1 + y2) / 2, len: Math.hypot(dx, dy), rot: Math.atan2(dy, dx) })
  }
  return out
}

const WALL_T = 0.12

function RoomShell({ room, materials }: { room: DesignRoom; materials: DesignMaterialPalette }): React.JSX.Element {
  const floorColor = colorOf(materials, room.floor, '#e7ddcd')
  const wallColor = colorOf(materials, room.wall, '#f2efe9')
  const shape = React.useMemo(() => {
    const s = new THREE.Shape()
    room.polygon.forEach(([x, y], i) => {
      const X = mm(x)
      const Z = mm(-y)
      if (i === 0) s.moveTo(X, Z)
      else s.lineTo(X, Z)
    })
    s.closePath()
    return s
  }, [room.polygon])
  const segs = React.useMemo(() => wallSegmentsOf(room.polygon), [room.polygon])
  return (
    <group>
      {/* 地板（Shape 位于 XY 平面 → rotateX(-90°) 摊平到 XZ；顶点 Z = -y 已含翻转） */}
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <shapeGeometry args={[shape]} />
        <meshStandardMaterial color={floorColor} roughness={roughnessOf(materials, room.floor, 0.75)} />
      </mesh>
      {segs.map((seg, i) => (
        <mesh
          key={i}
          position={[mm(seg.cx), mm(room.height) / 2, mm(-seg.cy)]}
          rotation-y={seg.rot}
        >
          <boxGeometry args={[mm(seg.len), mm(room.height), WALL_T]} />
          <meshStandardMaterial color={wallColor} roughness={roughnessOf(materials, room.wall, 0.9)} />
        </mesh>
      ))}
    </group>
  )
}

function OpeningMark({ room, opening }: { room: DesignRoom; opening: DesignOpening }): React.JSX.Element | null {
  const segs = React.useMemo(() => wallSegmentsOf(room.polygon), [room.polygon])
  const seg = segs[opening.wallIndex]
  if (!seg) return null
  const [x1, y1] = room.polygon[opening.wallIndex]!
  const [x2, y2] = room.polygon[(opening.wallIndex + 1) % room.polygon.length]!
  const len = Math.hypot(x2 - x1, y2 - y1)
  const along = Math.min(opening.offset + opening.width / 2, Math.max(len - 100, 0))
  const ux = (x2 - x1) / (len || 1)
  const uy = (y2 - y1) / (len || 1)
  const cx = x1 + ux * along
  const cy = y1 + uy * along
  const isDoor = opening.type === 'door'
  const baseY = isDoor ? 0 : (opening.sill ?? 900)
  return (
    <mesh position={[mm(cx), mm(baseY + opening.height / 2), mm(-cy)]} rotation-y={seg.rot}>
      <boxGeometry args={[mm(opening.width), mm(opening.height), 0.05]} />
      <meshStandardMaterial
        color={isDoor ? '#8d6e52' : '#b9d4e2'}
        roughness={0.6}
        transparent={!isDoor}
        opacity={isDoor ? 1 : 0.55}
      />
    </mesh>
  )
}

function PartMesh({ part, base, accent }: { part: FurniturePart; base: string; accent: string }): React.JSX.Element {
  const color = part.slot === 'accent' ? accent : base
  const pos: [number, number, number] = [mm(part.x), mm(part.y), mm(part.z)]
  switch (part.t) {
    case 'box':
      return (
        <mesh position={pos}>
          <boxGeometry args={[mm(part.w), mm(part.h), mm(part.d)]} />
          <meshStandardMaterial color={color} roughness={0.75} />
        </mesh>
      )
    case 'cylinder':
      return (
        <mesh position={pos}>
          <cylinderGeometry args={[mm(part.r), mm(part.r), mm(part.h), 20]} />
          <meshStandardMaterial color={color} roughness={0.75} />
        </mesh>
      )
    case 'sphere':
      return (
        <mesh position={pos}>
          <sphereGeometry args={[mm(part.r), 20, 14]} />
          <meshStandardMaterial color={color} roughness={0.85} />
        </mesh>
      )
    case 'cone':
      return (
        <mesh position={pos}>
          <coneGeometry args={[mm(part.r), mm(part.h), 20]} />
          <meshStandardMaterial color={color} roughness={0.7} />
        </mesh>
      )
  }
}

function FurnitureMesh({
  item,
  materials,
  selected,
  onSelect,
}: {
  item: DesignFurniture
  materials: DesignMaterialPalette
  selected: boolean
  onSelect?: (id: string) => void
}): React.JSX.Element {
  const spec = specOf(item.kind)
  const scale = item.scale ?? 1
  const base = colorOf(materials, item.material, spec.color)
  const accent = colorOf(materials, item.material, spec.accent ?? spec.color)
  const parts = React.useMemo(() => furniturePartsOf(item.kind), [item.kind])
  const onClick = React.useCallback(
    (e: { stopPropagation: () => void }) => {
      e.stopPropagation()
      onSelect?.(item.id)
    },
    [item.id, onSelect],
  )
  return (
    <group
      position={[mm(item.x), 0, mm(-item.y)]}
      rotation-y={(item.rotation * Math.PI) / 180}
      scale={[scale, scale, scale]}
      onClick={onClick}
    >
      {parts.map((p, i) => (
        <PartMesh key={i} part={p} base={base} accent={accent} />
      ))}
      {selected ? (
        <mesh position={[0, mm(spec.height) / 2, 0]}>
          <boxGeometry args={[mm(spec.width) * 1.06, mm(spec.height) * 1.06, mm(spec.depth) * 1.06]} />
          <meshBasicMaterial color="#2dd4bf" wireframe transparent opacity={0.9} />
        </mesh>
      ) : null}
    </group>
  )
}

function SunLight({ lights }: { lights: DesignLights }): React.JSX.Element {
  const az = (lights.sunAzimuth * Math.PI) / 180
  const el = (lights.sunElevation * Math.PI) / 180
  const R = 14
  const pos: [number, number, number] = [R * Math.sin(az) * Math.cos(el), R * Math.sin(el), -R * Math.cos(az) * Math.cos(el)]
  return (
    <>
      <hemisphereLight intensity={lights.ambient} />
      <directionalLight position={pos} intensity={lights.intensity} />
    </>
  )
}

export interface StudioCanvasProps {
  scene: DesignScene
  /** 选中家具 id（wireframe 高亮） */
  selectedId?: string
  onSelect?: (id: string | null) => void
}

export function StudioCanvas({ scene, selectedId, onSelect }: StudioCanvasProps): React.JSX.Element {
  const b = React.useMemo(() => sceneBounds(scene), [scene])
  const cx = mm((b.minX + b.maxX) / 2)
  const cz = mm(-(b.minY + b.maxY) / 2)
  const w = mm(b.width)
  const d = mm(b.depth)
  const roomH = mm(scene.rooms[0]?.height ?? 2800)
  return (
    <Canvas
      data-studio-canvas
      dpr={[1, 2]}
      frameloop="demand"
      camera={{ position: [cx + w * 0.55, roomH * 1.7, cz + d * 1.15], fov: 50 }}
      gl={{ antialias: true, preserveDrawingBuffer: true }}
      onPointerMissed={() => onSelect?.(null)}
    >
      <color attach="background" args={['#f5f5f4']} />
      <SunLight lights={scene.lights} />
      {scene.rooms.map((room) => (
        <RoomShell key={room.id} room={room} materials={scene.materials} />
      ))}
      {scene.openings.map((o) => {
        const room = scene.rooms.find((r) => r.id === o.roomId)
        return room ? <OpeningMark key={o.id} room={room} opening={o} /> : null
      })}
      {scene.furniture.map((f) => (
        <FurnitureMesh key={f.id} item={f} materials={scene.materials} selected={f.id === selectedId} onSelect={onSelect ?? undefined} />
      ))}
      <Grid
        args={[30, 30]}
        cellSize={0.5}
        cellColor="#d6d3d1"
        sectionColor="#a8a29e"
        infiniteGrid
        fadeDistance={22}
        position={[cx, 0.002, cz]}
      />
      <OrbitControls makeDefault enableDamping={false} maxPolarAngle={Math.PI / 2.05} target={[cx, roomH / 3, cz]} />
    </Canvas>
  )
}
