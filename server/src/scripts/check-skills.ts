/**
 * check:skills：校验 skills/ 全部 Skill 文档（name 唯一 / description 非空 / 目录名一致）。
 *
 * 技能质量报告（默认非阻塞；`--strict` / SKILL_STRICT=1 切门禁——CI 已启用）：
 * - 正文行数 ≥ 60（规范 60–150 行）；超过 150 行仅提示考虑拆分，不判失败。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { SkillLibrary } from '../store/skills.js'

/** 正文行数下限（规范 60–150 行） */
const MIN_LINES = 60
/** 正文行数上限（超出仅提示，不判失败） */
const MAX_LINES = 150
/** 未达标清单展示上限 */
const LIST_MAX = 15

function main(): void {
  const cfg = loadConfig()
  try {
    const library = new SkillLibrary(cfg.skillsDir)
    const problems = library.validate()
    if (problems.length > 0) {
      console.error('✗ skills 校验失败：')
      for (const p of problems) console.error(`  - ${p}`)
      process.exit(1)
    }
    const skills = library.list()
    console.log(`✓ skills 校验通过（${skills.length} 个技能）`)
    for (const s of skills) console.log(`  - ${s.name}：${s.description}`)

    // 技能质量报告（行数；默认非阻塞，--strict / SKILL_STRICT=1 时未达标即失败）
    const strict = process.argv.includes('--strict') || process.env.SKILL_STRICT === '1'
    const under: Array<{ name: string; lines: number }> = []
    const over: Array<{ name: string; lines: number }> = []
    for (const s of skills) {
      try {
        const raw = fs.readFileSync(path.join(cfg.skillsDir, s.name, 'SKILL.md'), 'utf8')
        const lines = (raw.match(/\n/g) ?? []).length
        if (lines < MIN_LINES) under.push({ name: s.name, lines })
        else if (lines > MAX_LINES) over.push({ name: s.name, lines })
      } catch {
        under.push({ name: s.name, lines: 0 })
      }
    }
    const ready = skills.length - under.length
    const pct = skills.length === 0 ? 0 : Math.round((ready / skills.length) * 100)
    console.log(`\n◆ 技能质量报告（正文 ≥${MIN_LINES} 行；${strict ? 'strict 门禁' : '报告模式，--strict 切门禁'}）`)
    console.log(`  达标 ${ready}/${skills.length}（${pct}%）`)
    for (const f of under.slice(0, LIST_MAX)) console.log(`    - ${f.name}：${f.lines} 行（低于下限）`)
    if (under.length > LIST_MAX) console.log(`    …（其余 ${under.length - LIST_MAX} 个未达标技能略）`)
    if (over.length > 0) {
      console.log(`  >${MAX_LINES} 行建议拆分（${over.length} 个，仅提示）：${over.map((o) => `${o.name}(${o.lines})`).join('、')}`)
    }
    if (strict && under.length > 0) {
      console.error(`\n✗ 技能质量门槛未通过（${under.length} 个技能低于 ${MIN_LINES} 行）`)
      process.exit(1)
    }
  } catch (err) {
    console.error(`✗ skills 解析失败：${(err as Error).message}`)
    process.exit(1)
  }
}

main()
