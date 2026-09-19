/**
 * check:agents：校验 agents/ 全部资产（目录结构 / _group.yaml / id 唯一 / handoff / 协议 / 灵魂 / 预设）。
 *
 * 旧名 `check:prompts` 为同脚本别名（package.json）；agents/ 缺失时自动按 prompts/
 * 回退模式校验（迁移期安全网）并提示迁移。
 *
 * 专家级质量报告（默认非阻塞，随每次校验输出达标率；`--strict` 或 QUALITY_STRICT=1
 * 时未达标即失败——全量升级完成后切换为门禁）：
 * - 角色：六段骨架齐备（## 职责 / ## 专业判断 / ## 工作方式 / ## 质量与自检 / ## 交付契约 / ## 协作接口）+ 正文 ≥ QUALITY_MIN_CHARS 字符；
 * - 协议（v65 配套）：_protocol.md ≥ PROTOCOL_MIN_LINES 行且含「## 质量红线」「## 典型失败模式」两段（29 份场景协议统一标准）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '../config.js'
import { parseFrontMatter, PromptLibrary } from '../store/prompts.js'

/** 专家级六段骨架（顺序即建议顺序；缺任一段即未达标） */
const QUALITY_SECTIONS = [
  '## 职责',
  '## 专业判断',
  '## 工作方式',
  '## 质量与自检',
  '## 交付契约',
  '## 协作接口',
] as const
/** 专家级正文深度门槛（字符数，不含 front-matter；目标带 1200–2400） */
const QUALITY_MIN_CHARS = 1200
/** 未达标清单展示上限（超出折叠为计数） */
const QUALITY_LIST_MAX = 15
/** 场景协议必备两段（v65 配套：质量红线 + 典型失败模式） */
const PROTOCOL_SECTIONS = ['## 质量红线', '## 典型失败模式'] as const
/** 场景协议行数门槛（29 份协议统一标准 ≥28 行） */
const PROTOCOL_MIN_LINES = 28

interface QualityFinding {
  id: string
  group: string
  chars: number
  missing: string[]
}

/** 逐角色质量体检（agents 模式；文件缺失 / 解析失败按缺全部段计） */
function qualityReport(agentsDir: string, agents: ReturnType<PromptLibrary['list']>): QualityFinding[] {
  const findings: QualityFinding[] = []
  for (const a of agents) {
    let body = ''
    try {
      const raw = fs.readFileSync(path.join(agentsDir, a.group, a.id, 'AGENT.md'), 'utf8')
      body = parseFrontMatter(raw).body
    } catch {
      // 文件缺失已在结构校验阶段报错，此处按空正文计
    }
    const missing = QUALITY_SECTIONS.filter((s) => !body.includes(s))
    const chars = body.trim().length
    if (missing.length > 0 || chars < QUALITY_MIN_CHARS) {
      findings.push({ id: a.id, group: a.group, chars, missing: [...missing] })
    }
  }
  return findings
}

/** 逐场景协议体检（agents 模式）：行数与必备两段（文件缺失按未达标计） */
function protocolReport(
  agentsDir: string,
  groups: ReturnType<PromptLibrary['groups']>,
): Array<{ id: string; lines: number; missing: string[] }> {
  const findings: Array<{ id: string; lines: number; missing: string[] }> = []
  for (const g of groups) {
    let raw = ''
    try {
      raw = fs.readFileSync(path.join(agentsDir, g.id, '_protocol.md'), 'utf8')
    } catch {
      // 协议缺失已在结构校验阶段报错，此处按空计（行数 0 + 缺两段）
    }
    const lines = (raw.match(/\n/g) ?? []).length
    const missing = PROTOCOL_SECTIONS.filter((s) => !raw.includes(s))
    if (lines < PROTOCOL_MIN_LINES || missing.length > 0)
      findings.push({ id: g.id, lines, missing: [...missing] })
  }
  return findings
}
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
      console.warn(
        `⚠ 未找到 agents/ 目录：按旧 prompts/ 回退模式校验通过（${agents.length} 个角色）；建议运行 npm run migrate:agents`,
      )
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
      // 专家级质量报告（默认非阻塞；--strict / QUALITY_STRICT=1 时未达标即失败）
      const strict = process.argv.includes('--strict') || process.env.QUALITY_STRICT === '1'
      const findings = qualityReport(cfg.agentsDir, agents)
      const total = agents.length
      const sixReady = total - findings.filter((f) => f.missing.length > 0).length
      const deepReady = total - findings.filter((f) => f.chars < QUALITY_MIN_CHARS).length
      console.log(
        `\n◆ 专家级质量报告（六段骨架 + 正文 ≥${QUALITY_MIN_CHARS} 字符；${strict ? 'strict 门禁' : '报告模式，--strict 切门禁'}）`,
      )
      console.log(
        `  达标 ${total - findings.length}/${total}（${total === 0 ? 0 : Math.round(((total - findings.length) / total) * 100)}%）｜六段齐备 ${sixReady}/${total}｜正文达标 ${deepReady}/${total}`,
      )
      for (const f of findings.slice(0, QUALITY_LIST_MAX)) {
        const parts = [`正文 ${f.chars} 字符`]
        if (f.missing.length > 0)
          parts.push(`缺段：${f.missing.map((s) => s.replace('## ', '')).join(' / ')}`)
        console.log(`    - ${f.group}/${f.id}：${parts.join('；')}`)
      }
      if (findings.length > QUALITY_LIST_MAX) {
        console.log(`    …（其余 ${findings.length - QUALITY_LIST_MAX} 个未达标角色略）`)
      }
      if (strict && findings.length > 0) {
        console.error(`\n✗ 专家级质量门槛未通过（${findings.length} 个角色未达标）`)
        process.exit(1)
      }
      // 协议质量报告（同 strict 口径）：v65 配套——质量红线 + 典型失败模式两段门禁
      const protoFindings = protocolReport(cfg.agentsDir, groups)
      const protoTotal = groups.length
      console.log(
        `\n◆ 协议质量报告（≥${PROTOCOL_MIN_LINES} 行 + ${PROTOCOL_SECTIONS.map((s) => s.replace('## ', '')).join(' / ')}；${strict ? 'strict 门禁' : '报告模式，--strict 切门禁'}）`,
      )
      console.log(
        `  达标 ${protoTotal - protoFindings.length}/${protoTotal}（${protoTotal === 0 ? 0 : Math.round(((protoTotal - protoFindings.length) / protoTotal) * 100)}%）`,
      )
      for (const f of protoFindings.slice(0, QUALITY_LIST_MAX)) {
        const parts = [`${f.lines} 行`]
        if (f.lines < PROTOCOL_MIN_LINES) parts.push(`低于下限`)
        if (f.missing.length > 0)
          parts.push(`缺段：${f.missing.map((s) => s.replace('## ', '')).join(' / ')}`)
        console.log(`    - ${f.id}：${parts.join('；')}`)
      }
      if (protoFindings.length > QUALITY_LIST_MAX) {
        console.log(`    …（其余 ${protoFindings.length - QUALITY_LIST_MAX} 个未达标协议略）`)
      }
      if (strict && protoFindings.length > 0) {
        console.error(`\n✗ 协议质量门槛未通过（${protoFindings.length} 个场景协议未达标）`)
        process.exit(1)
      }
    }
  } catch (err) {
    console.error(`✗ agents 解析失败：${(err as Error).message}`)
    process.exit(1)
  }
}

main()
