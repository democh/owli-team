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

export interface SkillLibraryOptions {
  /** 热更新扫描节流（毫秒）：0 = 每次读都扫（测试口径） */
  scanIntervalMs?: number
  onWarn?: (message: string) => void
}

/** Skill 库：skills/<name>/SKILL.md，mtime 热更新（§23） */
export class SkillLibrary {
  private skills = new Map<string, SkillRecord>()
  /** 实际有效 SKILL.md 的 mtime 签名（目录存在但没有 SKILL.md 不算技能） */
  private mtimes = new Map<string, number>()
  private listCache?: SkillMeta[]
  private indexCache?: string
  private readonly scanIntervalMs: number
  private lastScanAt = 0
  private readonly warn: (message: string) => void

  constructor(
    private readonly dir: string,
    opts: SkillLibraryOptions = {},
  ) {
    this.scanIntervalMs = opts.scanIntervalMs ?? (process.env.NODE_ENV === 'test' ? 0 : 500)
    this.warn = opts.onWarn ?? ((message: string) => console.warn(message))
    this.reload()
  }

  /** 解析成功整体替换；失败保留上一可用版本，避免半新半旧的技能索引。 */
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
    this.listCache = undefined
    this.indexCache = undefined
    this.lastScanAt = Date.now()
  }

  list(): SkillMeta[] {
    this.maybeReload()
    this.listCache ??= [...this.skills.values()].map(({ name, description, tags }) => ({ name, description, tags }))
    return this.listCache
  }

  get(name: string): SkillRecord | undefined {
    this.maybeReload()
    return this.skills.get(name)
  }

  /** 注入系统提示的 <available_skills> 索引（仅元数据，§23.3） */
  indexText(): string {
    this.maybeReload()
    if (this.indexCache !== undefined) return this.indexCache
    this.indexCache = this.skills.size === 0
      ? ''
      : `<available_skills>\n${[...this.skills.values()].map((s) => `- ${s.name}: ${s.description}`).join('\n')}\n</available_skills>`
    return this.indexCache
  }

  validate(): string[] {
    this.reload()
    return []
  }

  private maybeReload(): void {
    if (this.scanIntervalMs > 0 && Date.now() - this.lastScanAt < this.scanIntervalMs) return
    // 到期扫描即推进窗口：无变更 / 扫描失败都不在窗口内重复扫盘。
    this.lastScanAt = Date.now()
    try {
      const current = this.collectSignature()
      let changed = current.size !== this.mtimes.size
      if (!changed) {
        for (const [name, mtime] of current) {
          if (this.mtimes.get(name) !== mtime) {
            changed = true
            break
          }
        }
      }
      if (changed) this.reload()
    } catch (err) {
      this.warn(`[skills] 热更新失败，保留旧版本：${(err as Error).message}`)
    }
  }

  /** 有效技能集合签名：新增 / 删除 / 目录保留但 SKILL.md 移除都能识别。 */
  private collectSignature(): Map<string, number> {
    const signature = new Map<string, number>()
    if (!fs.existsSync(this.dir)) return signature
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = path.join(this.dir, entry.name, 'SKILL.md')
      try {
        signature.set(entry.name, fs.statSync(file).mtimeMs)
      } catch {
        // 没有 SKILL.md 的子目录不算技能
      }
    }
    return signature
  }
}
