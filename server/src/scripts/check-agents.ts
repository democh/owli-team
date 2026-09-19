/**
 * check:agents：校验 agents/ 全部资产（目录结构 / _group.yaml / id 唯一 / handoff / 协议 / 灵魂 / 预设）。
 *
 * 旧名 `check:prompts` 为同脚本别名（package.json）；agents/ 缺失时自动按 prompts/
 * 回退模式校验（迁移期安全网）并提示迁移。
 */
import { loadConfig } from '../config.js'
import { PromptLibrary } from '../store/prompts.js'

function main(): void {
  const cfg = loadConfig()
  try {
    const library = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir })
    const problems = library.validate()
    if (problems.length > 0) {
      console.error('✗ agents 校验失败：')
      for (const p of problems) console.error(`  - ${p}`)
      process.exit(1)
    }
    const mode = library.currentMode()
    const groups = library.groups()
    const agents = library.list()
    if (mode === 'legacy') {
      console.warn(`⚠ 未找到 agents/ 目录：按旧 prompts/ 回退模式校验通过（${agents.length} 个角色）；建议运行 npm run migrate:agents`)
    } else {
      console.log(`✓ agents 校验通过（${groups.length} 个场景 / ${agents.length} 个角色）`)
    }
    for (const g of groups) {
      // M52：stage 声明概览（形态走查用）
      const stageInfo = g.stage
        ? ` stage:${g.stage.layout}${g.stage.panel ? `/${g.stage.panel}` : ''}${g.stage.seats ? '/seats' : ''}`
        : ''
      console.log(`  ◆ ${g.id}（${g.name}）chain: ${g.chain.join(' → ') || '（未配置）'}${stageInfo}`)
      for (const a of agents.filter((x) => x.group === g.id)) {
        const souls = a.souls?.length ? ` 灵魂:[${a.souls.map((s) => s.id).join('/')}]` : ''
        const dft = a.defaultSoul ? ` 默认:${a.defaultSoul}` : ''
        const avatar = library.avatarFile(a.id) ? ' avatar:✓' : ''
        console.log(`    - ${a.id}：${a.name}（${a.role}）${souls}${dft}${avatar}`)
      }
    }
    const presets = library.presets()
    if (mode === 'agents') {
      console.log(`  预设（${presets.length}）：${presets.length === 0 ? '（无 _presets.yaml）' : ''}`)
      for (const p of presets) {
        console.log(`    ★ ${p.id}（${p.name}）：${p.members.join(' + ')}`)
      }
    }
  } catch (err) {
    console.error(`✗ agents 解析失败：${(err as Error).message}`)
    process.exit(1)
  }
}

main()
