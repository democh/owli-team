import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { AgentFrontMatterSchema, PromptLibrary, parseFrontMatter } from '../src/store/prompts.js'
import { makeTmpDir } from './helpers.js'

function writeAgent(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content, 'utf8')
}

const VALID = (id: string, name: string) => `---
id: ${id}
name: ${name}
role: 测试角色
handoff: []
---

我是 ${name}。
`

/** 旧 prompts/ 平铺模式：agentsDir 不存在 → 触发兼容回退（告警静音） */
function legacyLibrary(dir: string): PromptLibrary {
  return new PromptLibrary({ agentsDir: path.join(dir, '__agents__'), promptsDir: dir, onWarn: () => {} })
}

describe('prompts：front-matter 解析', () => {
  it('缺少 front-matter → 精确报错', () => {
    expect(() => parseFrontMatter('没有头部的文档')).toThrowError('缺少 front-matter')
  })

  it('front-matter 未闭合 → 精确报错', () => {
    expect(() => parseFrontMatter('---\nid: pm\n\n正文')).toThrowError('未闭合')
  })

  it('zod 校验：name 缺失 → 精确字段报错', () => {
    const result = AgentFrontMatterSchema.safeParse({ id: 'pm', role: '产品' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path.join('.')).toBe('name')
    }
  })

  it('zod 校验：gradient 非两元组 → 报错', () => {
    const result = AgentFrontMatterSchema.safeParse({
      id: 'pm',
      name: '费利',
      role: '产品',
      avatar: { gradient: ['#fff'] },
    })
    expect(result.success).toBe(false)
  })
})

describe('prompts：库加载与校验', () => {
  it('合法目录 → list 返回全部角色，body 可读', () => {
    const dir = makeTmpDir()
    writeAgent(dir, 'a.md', VALID('a', '阿尔法'))
    writeAgent(dir, 'b.md', VALID('b', '贝塔'))
    const library = legacyLibrary(dir)
    expect(library.list().map((a) => a.id).sort()).toEqual(['a', 'b'])
    expect(library.body('a')).toContain('我是 阿尔法')
  })

  it('id 重复 → 加载即报错', () => {
    const dir = makeTmpDir()
    writeAgent(dir, 'a1.md', VALID('dup', '甲'))
    writeAgent(dir, 'a2.md', VALID('dup', '乙'))
    expect(() => legacyLibrary(dir)).toThrowError('重复')
  })

  it('handoff 指向不存在的角色 → validate 报告问题', () => {
    const dir = makeTmpDir()
    writeAgent(
      dir,
      'a.md',
      `---
id: a
name: 阿尔法
role: 测试
handoff: [ghost]
---

正文
`,
    )
    const library = legacyLibrary(dir)
    const problems = library.validate()
    expect(problems.length).toBe(1)
    expect(problems[0]).toContain('ghost')
  })

  it('mtime 热更新：改文件后 list 立即反映', () => {
    const dir = makeTmpDir()
    writeAgent(dir, 'a.md', VALID('a', '旧名'))
    const library = legacyLibrary(dir)
    expect(library.get('a')?.name).toBe('旧名')

    const file = path.join(dir, 'a.md')
    fs.writeFileSync(file, VALID('a', '新名'), 'utf8')
    fs.utimesSync(file, new Date(), new Date(Date.now() + 2000))
    expect(library.get('a')?.name).toBe('新名')
  })
})
