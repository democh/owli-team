/**
 * M15 测试：Agent 包目录加载器（PromptLibrary）。
 * 覆盖：目录即分组 / _group.yaml 校验与场景排序 / 场景协议追加 / 灵魂解析（默认与显式、
 * id 一致性与引用校验、quirks 不外露）/ 头像自动发现 / 场景 defaultSkills /
 * validate 语义问题 / prompts 回退模式与运行时模式切换 / mtime 热更新。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PromptLibrary } from '../src/store/prompts.js'
import { makeTmpDir } from './helpers.js'

const AGENT_MD = (id: string, name: string, extra = 'handoff: []\n'): string => `---
id: ${id}
name: ${name}
role: 测试角色
${extra}---

我是 ${name}。
`

const GROUP_YAML = (id: string, extra = ''): string => `id: ${id}
name: ${id} 场景
description: ${id} 的测试场景
${extra}`

const SOUL_MD = (id: string, name: string, extra = ''): string => `---
id: ${id}
name: ${name}
tagline: ${name}的标语
traits: [特质一]
tone: 测试语气
quirks: [口头禅]
${extra}---

${name}的灵魂正文。
`

interface Scaffold {
  root: string
  agentsDir: string
  promptsDir: string
}

function scaffold(): Scaffold {
  const root = makeTmpDir('ma-m15-')
  const agentsDir = path.join(root, 'agents')
  fs.mkdirSync(agentsDir, { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协议\n\n遵守协作规则。\n')
  return { root, agentsDir, promptsDir: path.join(root, 'prompts') }
}

function writeGroup(s: Scaffold, groupId: string, yaml: string): string {
  const dir = path.join(s.agentsDir, groupId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '_group.yaml'), yaml)
  return dir
}

function writeAgent(s: Scaffold, groupId: string, agentId: string, content: string): string {
  const dir = path.join(s.agentsDir, groupId, agentId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'AGENT.md'), content)
  return dir
}

function library(s: Scaffold, warns?: string[]): PromptLibrary {
  return new PromptLibrary({
    agentsDir: s.agentsDir,
    promptsDir: s.promptsDir,
    onWarn: (m) => warns?.push(m),
  })
}

describe('M15：agents 包目录加载（目录即分组 / 链序）', () => {
  it('目录即分组 + 场景 order 排序 + list() 按场景 → 编制链序', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha', 'order: 20\nchain: [b1, a1]\n'))
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    writeAgent(s, 'alpha', 'b1', AGENT_MD('b1', '乙一'))
    writeAgent(s, 'alpha', 'a2', AGENT_MD('a2', '甲二')) // 不在 chain：排 chain 成员之后
    writeGroup(s, 'beta', GROUP_YAML('beta', 'order: 10\nchain: [c1]\n'))
    writeAgent(s, 'beta', 'c1', AGENT_MD('c1', '丙一'))

    const lib = library(s)
    expect(lib.currentMode()).toBe('agents')
    expect(lib.groups().map((g) => g.id)).toEqual(['beta', 'alpha']) // order 10 < 20
    expect(lib.list().map((a) => a.id)).toEqual(['c1', 'b1', 'a1', 'a2'])
    // group 由目录推导写入
    expect(lib.get('b1')?.group).toBe('alpha')
    expect(lib.get('c1')?.group).toBe('beta')
    expect(lib.body('b1')).toContain('我是 乙一')
  })

  it('场景协议：groupProtocol 读取内容；无场景协议返回空串', () => {
    const s = scaffold()
    const dir = writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    fs.writeFileSync(path.join(dir, '_protocol.md'), '# 场景协议\n\n发散期禁止评判。\n')
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    writeGroup(s, 'beta', GROUP_YAML('beta'))
    writeAgent(s, 'beta', 'c1', AGENT_MD('c1', '丙一'))

    const lib = library(s)
    expect(lib.protocolText).toContain('全局协议')
    expect(lib.groupProtocol('alpha')).toContain('发散期禁止评判')
    expect(lib.groupProtocol('beta')).toBe('')
  })

  it('_group.yaml 缺失 / id 与目录不一致 → 加载即报错', () => {
    const missing = scaffold()
    fs.mkdirSync(path.join(missing.agentsDir, 'alpha'), { recursive: true })
    expect(() => library(missing)).toThrowError('_group.yaml')

    const mismatch = scaffold()
    writeGroup(mismatch, 'alpha', GROUP_YAML('not-alpha'))
    expect(() => library(mismatch)).toThrowError('与目录名不一致')
  })

  it('AGENT.md 手写 group / id 与目录不一致 / 跨场景重复 → 加载即报错', () => {
    const manual = scaffold()
    writeGroup(manual, 'alpha', GROUP_YAML('alpha'))
    writeAgent(manual, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'group: other\nhandoff: []\n'))
    expect(() => library(manual)).toThrowError('由目录推导')

    const mismatch = scaffold()
    writeGroup(mismatch, 'alpha', GROUP_YAML('alpha'))
    writeAgent(mismatch, 'alpha', 'a1', AGENT_MD('other-id', '甲一'))
    expect(() => library(mismatch)).toThrowError('目录即 id')

    const dup = scaffold()
    writeGroup(dup, 'alpha', GROUP_YAML('alpha'))
    writeGroup(dup, 'beta', GROUP_YAML('beta'))
    writeAgent(dup, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    writeAgent(dup, 'beta', 'a1', AGENT_MD('a1', '甲二'))
    expect(() => library(dup)).toThrowError('全局唯一')
  })

  it('场景 defaultSkills：未显式配置时生效；显式配置不覆盖', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha', 'defaultSkills: [test-plan]\n'))
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    writeAgent(s, 'alpha', 'a2', AGENT_MD('a2', '甲二', 'skills: [deep-research]\nhandoff: []\n'))
    const lib = library(s)
    expect(lib.get('a1')?.skills).toEqual(['test-plan'])
    expect(lib.get('a2')?.skills).toEqual(['deep-research'])
  })
})

describe('M15：灵魂解析', () => {
  it('souls/default.md → 默认灵魂；元数据含 tagline/traits/tone（quirks 不外露）', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    fs.mkdirSync(path.join(dir, 'souls'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'souls', 'default.md'), SOUL_MD('default', '默认风'))

    const lib = library(s)
    const agent = lib.get('a1')
    expect(agent?.defaultSoul).toBe('default')
    expect(agent?.souls).toEqual([
      { id: 'default', name: '默认风', tagline: '默认风的标语', traits: ['特质一'], tone: '测试语气' },
    ])
    const doc = lib.soul('a1')
    expect(doc?.meta.id).toBe('default')
    expect(doc?.quirks).toEqual(['口头禅'])
    expect(doc?.body).toContain('默认风的灵魂正文')
  })

  it('front-matter soul 指定默认；soul(agentId, soulId) 显式覆盖', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'soul: wild\nhandoff: []\n'))
    fs.mkdirSync(path.join(dir, 'souls'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'souls', 'wild.md'), SOUL_MD('wild', '狂野'))
    fs.writeFileSync(path.join(dir, 'souls', 'zen.md'), SOUL_MD('zen', '禅意'))

    const lib = library(s)
    expect(lib.get('a1')?.defaultSoul).toBe('wild')
    expect(lib.soul('a1')?.meta.name).toBe('狂野')
    expect(lib.soul('a1', 'zen')?.meta.name).toBe('禅意')
    expect(lib.soul('a1', 'ghost')).toBeUndefined()
    // souls 元数据按文件名排序
    expect(lib.get('a1')?.souls?.map((x) => x.id)).toEqual(['wild', 'zen'])
  })

  it('soul id 与文件名不一致 / front soul 引用不存在 → 加载即报错', () => {
    const mismatch = scaffold()
    writeGroup(mismatch, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(mismatch, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    fs.mkdirSync(path.join(dir, 'souls'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'souls', 'wild.md'), SOUL_MD('other', '错位'))
    expect(() => library(mismatch)).toThrowError('与文件名不一致')

    const ghost = scaffold()
    writeGroup(ghost, 'alpha', GROUP_YAML('alpha'))
    const d2 = writeAgent(ghost, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'soul: ghost\nhandoff: []\n'))
    fs.mkdirSync(path.join(d2, 'souls'), { recursive: true })
    fs.writeFileSync(path.join(d2, 'souls', 'wild.md'), SOUL_MD('wild', '狂野'))
    expect(() => library(ghost)).toThrowError('souls/ 下不存在')
  })

  it('无 souls 目录 → 无灵魂；front-matter 指定 soul 但目录缺失 → 报错', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    const lib = library(s)
    expect(lib.get('a1')?.souls).toBeUndefined()
    expect(lib.get('a1')?.defaultSoul).toBeUndefined()
    expect(lib.soul('a1')).toBeUndefined()

    const bad = scaffold()
    writeGroup(bad, 'alpha', GROUP_YAML('alpha'))
    writeAgent(bad, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'soul: wild\nhandoff: []\n'))
    expect(() => library(bad)).toThrowError('souls/ 目录不存在或为空')
  })
})

describe('M15：头像自动发现', () => {
  it('avatar.png 存在 → image 自动指向 /api/agents/<id>/avatar + avatarFile 可读', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一'))
    fs.writeFileSync(path.join(dir, 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const lib = library(s)
    expect(lib.get('a1')?.avatar.image).toBe('/api/agents/a1/avatar')
    expect(lib.avatarFile('a1')).toBe(path.join(dir, 'avatar.png'))
    expect(lib.avatarFile('nope')).toBeUndefined()
  })

  it('front-matter 显式 avatar.image 优先（自动发现让位，但仍可读文件）', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'avatar:\n  image: /custom/a1.png\nhandoff: []\n'))
    fs.writeFileSync(path.join(dir, 'avatar.png'), Buffer.from([0x89]))
    const lib = library(s)
    expect(lib.get('a1')?.avatar.image).toBe('/custom/a1.png')
    expect(lib.avatarFile('a1')).toBe(path.join(dir, 'avatar.png'))
  })
})

describe('M15：validate 语义校验', () => {
  it('handoff / chain 指向不存在、场景无 Agent、协议缺失 → 逐条报告', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha', 'chain: [ghost-chain]\n'))
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'handoff: [ghost-handoff]\n'))
    writeGroup(s, 'empty', GROUP_YAML('empty')) // 场景下无任何 Agent
    fs.writeFileSync(path.join(s.agentsDir, '_protocol.md'), '') // 全局协议为空

    const problems = library(s).validate()
    expect(problems.some((p) => p.includes('handoff') && p.includes('ghost-handoff'))).toBe(true)
    expect(problems.some((p) => p.includes('chain') && p.includes('ghost-chain'))).toBe(true)
    expect(problems.some((p) => p.includes('empty') && p.includes('没有任何 Agent'))).toBe(true)
    expect(problems.some((p) => p.includes('_protocol.md'))).toBe(true)
  })

  it('合法资产 → validate 无问题', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha', 'chain: [a1, a2]\n'))
    writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '甲一', 'handoff: [a2]\n'))
    writeAgent(s, 'alpha', 'a2', AGENT_MD('a2', '甲二'))
    expect(library(s).validate()).toEqual([])
  })
})

describe('M15：prompts 回退与热更新', () => {
  it('agents/ 缺失 → legacy 模式：合成 development 场景 + 启动告警 + 无灵魂', () => {
    const s = scaffold()
    fs.rmSync(s.agentsDir, { recursive: true, force: true })
    fs.mkdirSync(s.promptsDir, { recursive: true })
    fs.writeFileSync(path.join(s.promptsDir, '_protocol.md'), '# 旧协议\n')
    fs.writeFileSync(path.join(s.promptsDir, 'pm.md'), AGENT_MD('pm', '费利'))

    const warns: string[] = []
    const lib = library(s, warns)
    expect(lib.currentMode()).toBe('legacy')
    expect(lib.list().map((a) => a.id)).toEqual(['pm'])
    expect(lib.get('pm')?.group).toBe('development')
    expect(lib.groups().map((g) => g.id)).toEqual(['development'])
    expect(lib.soul('pm')).toBeUndefined()
    expect(warns.some((w) => w.includes('migrate:agents'))).toBe(true)
  })

  it('运行时模式切换：agents/ 出现 → 自动升级为包目录模式', () => {
    const s = scaffold()
    fs.rmSync(s.agentsDir, { recursive: true, force: true })
    fs.mkdirSync(s.promptsDir, { recursive: true })
    fs.writeFileSync(path.join(s.promptsDir, 'pm.md'), AGENT_MD('pm', '旧费利'))
    const lib = library(s)
    expect(lib.currentMode()).toBe('legacy')

    fs.mkdirSync(s.agentsDir, { recursive: true })
    fs.writeFileSync(path.join(s.agentsDir, '_protocol.md'), '# 全局协议\n')
    writeGroup(s, 'development', GROUP_YAML('development'))
    writeAgent(s, 'development', 'pm', AGENT_MD('pm', '新费利'))

    expect(lib.get('pm')?.name).toBe('新费利') // 读触发 maybeReload → 检测到 agents/ 出现
    expect(lib.currentMode()).toBe('agents')
  })

  it('mtime 热更新：改 AGENT.md / 新增 soul 文件即时生效', () => {
    const s = scaffold()
    writeGroup(s, 'alpha', GROUP_YAML('alpha'))
    const dir = writeAgent(s, 'alpha', 'a1', AGENT_MD('a1', '旧名'))
    const lib = library(s)
    expect(lib.get('a1')?.name).toBe('旧名')
    expect(lib.soul('a1')).toBeUndefined()

    const file = path.join(dir, 'AGENT.md')
    fs.writeFileSync(file, AGENT_MD('a1', '新名'))
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000))
    expect(lib.get('a1')?.name).toBe('新名')

    fs.mkdirSync(path.join(dir, 'souls'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'souls', 'default.md'), SOUL_MD('default', '默认风'))
    expect(lib.get('a1')?.defaultSoul).toBe('default')
    expect(lib.soul('a1')?.meta.name).toBe('默认风')
  })
})
