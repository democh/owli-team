import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import type { SkillMeta } from '@multi-agent/shared'
import { parseFrontMatter } from './prompts.js'

export const SkillFrontMatterSchema = z.object({
  name: z.string().min(1, 'name 不能为空'),
  description: z.string().min(1, 'description 不能为空（说明何时使用）'),
  tags: z.array(z.string()).default([]),
})

export interface SkillRecord extends SkillMeta {
  body: string
  dir: string
}

/** Skill 库：skills/<name>/SKILL.md，mtime 热更新（§23） */
export class SkillLibrary {
  private skills = new Map<string, SkillRecord>()
  private mtimes = new Map<string, number>()

  constructor(private readonly dir: string) {
    this.reload()
  }

  reload(): void {
    const skills = new Map<string, SkillRecord>()
    const mtimes = new Map<string, number>()
    if (fs.existsSync(this.dir)) {
      for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(this.dir, entry.name)
        const file = path.join(skillDir, 'SKILL.md')
        if (!fs.existsSync(file)) continue
        const raw = fs.readFileSync(file, 'utf8')
        mtimes.set(entry.name, fs.statSync(file).mtimeMs)
        const parsed = parseFrontMatter(raw)
        const result = SkillFrontMatterSchema.safeParse(parsed.data)
        if (!result.success) {
          const issue = result.error.issues[0]
          throw new Error(`skills/${entry.name}/SKILL.md: ${issue.path.join('.') || 'front-matter'} ${issue.message}`)
        }
        if (result.data.name !== entry.name) {
          throw new Error(`skills/${entry.name}/SKILL.md: name "${result.data.name}" 与目录名不一致`)
        }
        skills.set(entry.name, { ...result.data, body: parsed.body, dir: skillDir })
      }
    }
    this.skills = skills
    this.mtimes = mtimes
  }

  list(): SkillMeta[] {
    this.maybeReload()
    return [...this.skills.values()].map(({ name, description, tags }) => ({ name, description, tags }))
  }

  get(name: string): SkillRecord | undefined {
    this.maybeReload()
    return this.skills.get(name)
  }

  /** 注入系统提示的 <available_skills> 索引（仅元数据，§23.3） */
  indexText(): string {
    this.maybeReload()
    if (this.skills.size === 0) return ''
    const lines = [...this.skills.values()].map((s) => `- ${s.name}: ${s.description}`)
    return `<available_skills>\n${lines.join('\n')}\n</available_skills>`
  }

  validate(): string[] {
    this.reload()
    return []
  }

  private maybeReload(): void {
    try {
      const entries = fs.existsSync(this.dir)
        ? fs.readdirSync(this.dir, { withFileTypes: true }).filter((e) => e.isDirectory())
        : []
      let changed = entries.length !== this.mtimes.size
      for (const entry of entries) {
        const file = path.join(this.dir, entry.name, 'SKILL.md')
        if (!fs.existsSync(file)) continue
        if (this.mtimes.get(entry.name) !== fs.statSync(file).mtimeMs) changed = true
      }
      if (changed) this.reload()
    } catch (err) {
      console.warn(`[skills] 热更新失败，保留旧版本：${(err as Error).message}`)
    }
  }
}
