/**
 * check:skills：校验 skills/ 全部 Skill 文档（name 唯一 / description 非空 / 目录名一致）。
 */
import { loadConfig } from '../config.js'
import { SkillLibrary } from '../store/skills.js'

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
  } catch (err) {
    console.error(`✗ skills 解析失败：${(err as Error).message}`)
    process.exit(1)
  }
}

main()
