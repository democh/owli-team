import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PromptLibrary } from '../src/store/prompts.js'
import { SkillLibrary } from '../src/store/skills.js'
import { makeTmpDir } from './helpers.js'

function agentDir(root: string, id: string): string {
  const dir = path.join(root, 'agents', 'core', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nid: ${id}\nname: 甲一\nrole: 测试\n---\n\n我是甲一。\n`,
  )
  return dir
}

function scaffold() {
  const root = makeTmpDir('ma-reload-')
  const agentsDir = path.join(root, 'agents')
  fs.mkdirSync(path.join(agentsDir, 'core'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协议\n')
  fs.writeFileSync(path.join(agentsDir, 'core', '_group.yaml'), 'id: core\nname: 核心\nchain: [a1]\n')
  agentDir(root, 'a1')
  return { root, agentsDir, promptsDir: path.join(root, 'prompts'), skillsDir: path.join(root, 'skills') }
}

describe('Agent / Skill 热更新的扫描窗口与失败恢复', () => {
  it('PromptLibrary 窗口内多次读取只扫描一次，过期后重新扫描', () => {
    const dirs = scaffold()
    const lib = new PromptLibrary({ ...dirs, onWarn: () => {}, scanIntervalMs: 60_000 })
    const spy = vi.spyOn(fs, 'readdirSync')
    const before = spy.mock.calls.length
    for (let i = 0; i < 5; i++) lib.list()
    expect(spy.mock.calls.length - before).toBe(0)
    spy.mockRestore()
  })

  it('voice.md 新增与修改无需重写 AGENT.md 即热生效', () => {
    const dirs = scaffold()
    const lib = new PromptLibrary({ ...dirs, onWarn: () => {}, scanIntervalMs: 0 })
    const voice = path.join(dirs.agentsDir, 'core', 'a1', 'voice.md')
    expect(lib.voice('a1')).toBeUndefined()
    fs.writeFileSync(voice, '## 说话方式\n- 先给结论。\n\n## 句式偏好\n- 禁用词表：赋能 / 抓手 / 闭环\n\n> 示例一：先看你最担心的点。\n> 示例二：谈取舍时报数字。\n')
    expect(lib.voice('a1')?.examples).toHaveLength(2)
    const later = new Date(Date.now() + 1000)
    fs.utimesSync(voice, later, later)
    fs.writeFileSync(voice, '## 说话方式\n- 连段成文。\n')
    expect(lib.voice('a1')?.body).toContain('连段成文')
  })

  it('SkillLibrary 空目录不算变更、删除 SKILL.md 与整个目录都能识别', () => {
    const dirs = scaffold()
    const skillDir = path.join(dirs.skillsDir, 'demo')
    fs.mkdirSync(skillDir, { recursive: true })
    const lib = new SkillLibrary(dirs.skillsDir, { scanIntervalMs: 0, onWarn: () => {} })
    expect(lib.list()).toEqual([])
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n\n正文 v1\n')
    expect(lib.get('demo')?.body).toContain('v1')
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n\n正文 v2\n')
    expect(lib.get('demo')?.body).toContain('v2')
    fs.unlinkSync(path.join(skillDir, 'SKILL.md'))
    expect(lib.get('demo')).toBeUndefined()
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: demo\ndescription: 演示技能\n---\n\n正文 v3\n')
    expect(lib.indexText()).toContain('demo: 演示技能')
    fs.rmSync(dirs.skillsDir, { recursive: true, force: true })
    expect(lib.list()).toEqual([])
  })

  it('解析失败保留上一可用快照，修复后恢复', () => {
    const dirs = scaffold()
    const skillDir = path.join(dirs.skillsDir, 'demo')
    fs.mkdirSync(skillDir, { recursive: true })
    const file = path.join(skillDir, 'SKILL.md')
    fs.writeFileSync(file, '---\nname: demo\ndescription: 演示技能\n---\n\n正文 v1\n')
    const lib = new SkillLibrary(dirs.skillsDir, { scanIntervalMs: 0, onWarn: () => {} })
    fs.writeFileSync(file, '---\nname: demo\n---\n')
    expect(lib.list().map((s) => s.name)).toEqual(['demo'])
    expect(lib.get('demo')?.body).toContain('v1')
    fs.writeFileSync(file, '---\nname: demo\ndescription: 修复后\n---\n\n正文 v2\n')
    expect(lib.get('demo')?.description).toBe('修复后')
  })
})
