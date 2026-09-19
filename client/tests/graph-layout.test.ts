/**
 * 协作图谱布局引擎（M21，§28.4）：
 * 接力链 dagre 分层（列递增 + 同列共享入场延迟）/ 折行选档（pickChainPerRow）与蛇形赛道 /
 * 圆桌均布（半径 · 角度 · 顶点起排）/ 中心图腾坐标 / 节点尺寸常量。
 * M22 扩展：方向键几何导航（nextNodeInDirection）。
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition, AgentGroup } from '@multi-agent/shared'
import { buildGraph, type GraphModel } from '../src/lib/graph'
import {
  COL_GAP,
  CORE_SIZE,
  NODE_H,
  NODE_W,
  ROW_GAP,
  layoutGraph,
  nextNodeInDirection,
  pickChainPerRow,
  radialRadius,
} from '../src/lib/graph-layout'

function agent(id: string): AgentDefinition {
  return {
    id,
    name: id.toUpperCase(),
    role: '角色',
    title: '头衔',
    description: '',
    capabilities: [],
    avatar: { gradient: ['#000000', '#ffffff'], icon: 'user' },
    group: 'development',
    handoff: [],
  }
}

function group(chain: string[]): AgentGroup {
  return {
    id: 'development',
    name: '研发团队',
    description: '',
    icon: 'code',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain,
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
  }
}

function modelOf(ids: string[], chain: string[] = []): GraphModel {
  return buildGraph([], ids.map(agent), chain.length > 1 ? [group(chain)] : [])
}

function centerOf(
  model: GraphModel,
  result: ReturnType<typeof layoutGraph>,
  id: string,
): { x: number; y: number } {
  expect(model.nodes.map((n) => n.id)).toContain(id)
  const pos = result.positions.get(id)!
  return { x: pos.x + NODE_W / 2, y: pos.y + NODE_H / 2 }
}

describe('layoutGraph：接力链（dagre LR）', () => {
  it('链式成员按列递增排布，入场延迟随列递增', () => {
    const model = modelOf(['pm', 'architect', 'qa'], ['pm', 'architect', 'qa'])
    const result = layoutGraph(model, 'chain')
    const xs = ['pm', 'architect', 'qa'].map((id) => result.positions.get(id)!.x)
    expect(xs[0]!).toBeLessThan(xs[1]!)
    expect(xs[1]!).toBeLessThan(xs[2]!)
    expect(result.delays.get('pm')).toBe(0)
    expect(result.delays.get('architect')).toBe(70)
    expect(result.delays.get('qa')).toBe(140)
    expect(result.core).toBeUndefined()
  })

  it('无边成员同列堆叠（y 相异）；位置表覆盖全部节点', () => {
    const model = modelOf(['pm', 'qa'])
    const result = layoutGraph(model, 'chain')
    expect(result.positions.size).toBe(2)
    const a = result.positions.get('pm')!
    const b = result.positions.get('qa')!
    expect(a.x).toBe(b.x)
    expect(a.y).not.toBe(b.y)
  })

  it('ranks：排名 0 起递增（供回退接力判定），折行重排不改变语义；圆桌无排名口径', () => {
    const model = modelOf(['pm', 'architect', 'qa'], ['pm', 'architect', 'qa'])
    const single = layoutGraph(model, 'chain')
    expect(single.ranks?.get('pm')).toBe(0)
    expect(single.ranks?.get('architect')).toBe(1)
    expect(single.ranks?.get('qa')).toBe(2)
    // 折行赛道：位置重排但排名跟随 dagre（折返边仍是顺向，不误报回退）
    const folded = layoutGraph(model, 'chain', { chainPerRow: 2 })
    expect(folded.ranks?.get('qa')).toBe(2)
    expect(layoutGraph(model, 'radial').ranks).toBeUndefined()
  })
})

describe('layoutGraph：圆桌（radial）', () => {
  it('成员等距均布于圆周，12 点方向起排；中心图腾位于原点', () => {
    const model = modelOf(['pm', 'architect', 'qa', 'designer'])
    const result = layoutGraph(model, 'radial')
    const radius = radialRadius(4)
    // 每位成员到中心距离 = 半径
    for (const id of ['pm', 'architect', 'qa', 'designer']) {
      const c = centerOf(model, result, id)
      expect(Math.hypot(c.x, c.y)).toBeCloseTo(radius, 4)
    }
    // 首位成员在正上方（-π/2 起）
    const first = centerOf(model, result, 'pm')
    expect(first.x).toBeCloseTo(0, 4)
    expect(first.y).toBeCloseTo(-radius, 4)
    // 角度均分：相邻成员夹角 90°（四分圆）
    const second = centerOf(model, result, 'architect')
    expect(second.x).toBeCloseTo(radius, 4)
    expect(second.y).toBeCloseTo(0, 4)
    // 官方图腾：左上角 = -CORE_SIZE/2
    expect(result.core).toEqual({ x: -CORE_SIZE / 2, y: -CORE_SIZE / 2 })
    // 入场延迟按角度顺序编排
    expect(result.delays.get('pm')).toBe(0)
    expect(result.delays.get('designer')).toBe(120)
  })

  it('单人圆桌：半径取下限；单节点位于顶点', () => {
    const model = modelOf(['pm'])
    const result = layoutGraph(model, 'radial')
    expect(radialRadius(1)).toBe(150)
    const c = centerOf(model, result, 'pm')
    expect(Math.hypot(c.x, c.y)).toBeCloseTo(150, 4)
  })

  it('空图：位置表为空但图腾坐标存在（防御性）', () => {
    const model = modelOf([])
    const result = layoutGraph(model, 'radial')
    expect(result.positions.size).toBe(0)
    expect(result.core).toEqual({ x: -CORE_SIZE / 2, y: -CORE_SIZE / 2 })
  })
})

describe('pickChainPerRow：折行选档（M21）', () => {
  it('窄容器折行：7 人在 330×560 选 2 列；全屏宽容器保持单行', () => {
    expect(pickChainPerRow(7, 330, 560)).toBe(2)
    expect(pickChainPerRow(7, 1280, 600)).toBe(7)
  })

  it('单行可容纳 / 缩放达阈值 → 单行；人数不足 / 尺寸异常 → 防御单行', () => {
    expect(pickChainPerRow(3, 1280, 600)).toBe(3)
    expect(pickChainPerRow(1, 330, 560)).toBe(1)
    expect(pickChainPerRow(7, 0, 0)).toBe(7)
  })
})

describe('layoutGraph：折行赛道（chainPerRow）', () => {
  it('蛇形铺网格：偶数行左→右，奇数行右→左，折返处上下相邻', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const model = modelOf(ids, ids)
    const r = layoutGraph(model, 'chain', { chainPerRow: 3 })
    const at = (id: string): { x: number; y: number } => r.positions.get(id)!
    // 行 0：左→右
    expect(at('a')).toEqual({ x: 0, y: 0 })
    expect(at('b')).toEqual({ x: NODE_W + COL_GAP, y: 0 })
    expect(at('c')).toEqual({ x: 2 * (NODE_W + COL_GAP), y: 0 })
    // 行 1（折返）：d 在 c 正下方，右→左折回
    expect(at('d')).toEqual({ x: 2 * (NODE_W + COL_GAP), y: NODE_H + ROW_GAP })
    expect(at('e').x).toBe(NODE_W + COL_GAP)
    expect(at('f')).toEqual({ x: 0, y: NODE_H + ROW_GAP })
    // 行 2：g 从最左继续（f 正下方）
    expect(at('g')).toEqual({ x: 0, y: 2 * (NODE_H + ROW_GAP) })
    // 入场按蛇形顺序递增
    expect(r.delays.get('a')).toBe(0)
    expect(r.delays.get('g')).toBe(6 * 45)
  })

  it('chainPerRow 不小于人数（或未传）→ 走 dagre 单行长链', () => {
    const model = modelOf(['pm', 'architect', 'qa'], ['pm', 'architect', 'qa'])
    const r = layoutGraph(model, 'chain', { chainPerRow: 3 })
    const xs = ['pm', 'architect', 'qa'].map((id) => r.positions.get(id)!.x)
    expect(xs[0]!).toBeLessThan(xs[1]!)
    expect(xs[1]!).toBeLessThan(xs[2]!)
  })
})

describe('nextNodeInDirection：方向键几何导航（M22）', () => {
  /** 十字布局（down 刻意带水平偏移，避免与 right 同分） */
  const grid = new Map([
    ['center', { x: 0, y: 0 }],
    ['right', { x: 200, y: 10 }],
    ['left', { x: -200, y: -10 }],
    ['up', { x: 10, y: -200 }],
    ['down', { x: -30, y: 200 }],
  ])

  it('各方向取主轴上最顺路候选（允许小幅垂直偏移）', () => {
    expect(nextNodeInDirection(grid, 'center', 'right')).toBe('right')
    expect(nextNodeInDirection(grid, 'center', 'left')).toBe('left')
    expect(nextNodeInDirection(grid, 'center', 'up')).toBe('up')
    expect(nextNodeInDirection(grid, 'center', 'down')).toBe('down')
  })

  it('评分 = 主轴距离 + 2×垂直偏移：正对候选优先于更近的斜向候选', () => {
    const p = new Map([
      ['a', { x: 0, y: 0 }],
      ['straight', { x: 70, y: 0 }],
      ['skewed', { x: 60, y: 20 }],
    ])
    // straight：70 + 0 = 70；skewed：60 + 40 = 100 → 正对胜出
    expect(nextNodeInDirection(p, 'a', 'right')).toBe('straight')
  })

  it('仅严格正方向入选：反方向 / 无候选 / 起点缺省均返回 undefined', () => {
    // 最右侧节点向右无候选（其余节点主轴增量均非正）
    expect(nextNodeInDirection(grid, 'right', 'right')).toBeUndefined()
    // 向左回到中心
    expect(nextNodeInDirection(grid, 'right', 'left')).toBe('center')
    const solo = new Map([['solo', { x: 0, y: 0 }]])
    expect(nextNodeInDirection(solo, 'solo', 'up')).toBeUndefined()
    // 起点不在位置表（防御）
    expect(nextNodeInDirection(grid, 'ghost', 'right')).toBeUndefined()
  })
})
