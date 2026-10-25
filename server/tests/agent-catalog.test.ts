/**
 * 真实资产：展示元数据（category / catalog）完整性与引用有效性。
 *
 * 事实源仍是 agents/ 文件：本用例只断言「内置资产已补齐且自洽」，
 * 不覆盖第三方旧资产（缺省字段仍可加载，兼容性由 PromptLibrary 的 schema 保证）。
 */
import { describe, expect, it } from 'vitest'
import {
  CATALOG_CATEGORIES,
  RETIRED_AGENT_IDS,
  RETIRED_PRESET_IDS,
  RETIRED_SCENES,
  catalogCategory,
} from '@multi-agent/shared'
import { PromptLibrary } from '../src/store/prompts.js'
import { loadConfig } from '../src/config.js'

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

describe('真实资产：目录计数与下线残留', () => {
  it('34 场景 / 139 角色 / 37 预设，且不含已下线资产', () => {
    const lib = realLibrary()
    const groups = lib.groups()
    const agents = lib.list()
    const presets = lib.presets()

    expect(groups).toHaveLength(34)
    expect(agents).toHaveLength(139)
    expect(presets).toHaveLength(37)
    expect(lib.validate()).toEqual([])

    for (const scene of RETIRED_SCENES) expect(groups.map((g) => g.id)).not.toContain(scene.id)
    for (const preset of RETIRED_PRESET_IDS) expect(presets.map((p) => p.id)).not.toContain(preset)
    for (const agent of agents) expect(RETIRED_AGENT_IDS.has(agent.id)).toBe(false)
  })
})

describe('真实资产：展示元数据覆盖', () => {
  it('场景 / 预设均有有效分类；「通用助手」独立归为其他', () => {
    const lib = realLibrary()
    const others: string[] = []
    for (const g of lib.groups()) {
      const category = catalogCategory(g.category)
      if (category === 'other') others.push(g.id)
      else expect(Object.keys(CATALOG_CATEGORIES)).toContain(category)
    }
    expect(others).toEqual(['blank'])
    for (const p of lib.presets()) expect(catalogCategory(p.category)).not.toBe('other')
  })

  it('场景：关键词 / 资料 / 交付 / 边界齐备（不超过展示上限）', () => {
    const lib = realLibrary()
    for (const g of lib.groups()) {
      const catalog = g.catalog
      expect(catalog, `${g.id} 缺少 catalog`).toBeTruthy()
      expect(catalog!.keywords.length, `${g.id} 关键词`).toBeGreaterThan(0)
      expect(catalog!.inputs.length, `${g.id} 资料`).toBeGreaterThan(0)
      expect(catalog!.outputs.length, `${g.id} 交付`).toBeGreaterThan(0)
      expect(catalog!.boundary, `${g.id} 边界`).toBeTruthy()
      expect(catalog!.keywords.length).toBeLessThanOrEqual(8)
      expect(catalog!.inputs.length).toBeLessThanOrEqual(5)
      expect(catalog!.outputs.length).toBeLessThanOrEqual(5)
      expect(catalog!.boundary!.length).toBeLessThanOrEqual(200)
    }
  })

  it('角色：至少一项独立产出与职责边界；输入 / 关键词可留空', () => {
    const lib = realLibrary()
    for (const a of lib.list()) {
      const catalog = a.catalog
      expect(catalog, `${a.group}/${a.id} 缺少 catalog`).toBeTruthy()
      expect(catalog!.outputs.length, `${a.group}/${a.id} 缺少产出`).toBeGreaterThan(0)
      expect(catalog!.boundary, `${a.group}/${a.id} 缺少边界`).toBeTruthy()
      expect(catalog!.outputs.length).toBeLessThanOrEqual(5)
      expect(catalog!.boundary!.length).toBeLessThanOrEqual(200)
    }
  })

  it('预设：资料 / 交付 / 边界齐备，成员与开场点名均有效', () => {
    const lib = realLibrary()

    for (const p of lib.presets()) {
      expect(p.catalog, `${p.id} 缺少 catalog`).toBeTruthy()
      expect(p.catalog!.inputs.length, `${p.id} 资料`).toBeGreaterThan(0)
      expect(p.catalog!.outputs.length, `${p.id} 交付`).toBeGreaterThan(0)
      expect(p.catalog!.boundary, `${p.id} 边界`).toBeTruthy()
      const names = new Set(p.members.map((id) => lib.get(id)?.name).filter(Boolean))
      expect(names.size, `${p.id} 成员不可解析`).toBe(p.members.length)
      for (const match of p.prompt.matchAll(/@([^\s，。；：、（）()]+)/g)) {
        expect(names.has(match[1]), `${p.id} 点名了非成员 ${match[1]}`).toBe(true)
      }
    }
  })

  it('catalog 只供展示：不进入角色正文与协议（避免逐轮上下文膨胀）', () => {
    const lib = realLibrary()
    for (const a of lib.list()) {
      const body = lib.body(a.id)
      expect(body).not.toContain('catalog:')
      expect(body).not.toContain('keywords:')
    }
  })
})
