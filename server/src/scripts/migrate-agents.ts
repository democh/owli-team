/**
 * CLI：prompts/（平铺）→ agents/<场景>/<agent>/（包目录）幂等迁移（`npm run migrate:agents`）。
 *
 * 用法：
 *   tsx src/scripts/migrate-agents.ts                      # 迁移到 agents/development/
 *   tsx src/scripts/migrate-agents.ts --group <场景 id>     # 指定目标场景目录
 *   tsx src/scripts/migrate-agents.ts --prune              # 迁移成功后删除源文件（prompts/*.md + 旧头像）
 *
 * 约定（M15）：
 * - front-matter 中 avatar.image 在迁移时移除——新加载器自动发现 <agent 目录>/avatar.png；
 * - 幂等：目标已存在则跳过（绝不覆盖手工调整过的 AGENT.md），可反复执行；
 * - 源文件默认保留一个版本周期（与加载器 prompts/ 回退策略一致），`--prune` 显式清理；
 * - 退出码：0 全部完成（含跳过）；1 存在失败文件（源保留，修复后可重跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_CHAIN } from '@multi-agent/shared'
import { loadConfig } from '../config.js'
import { AgentFrontMatterSchema, parseFrontMatter } from '../store/prompts.js'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

/** 默认场景元数据模板（仅当 _group.yaml 缺失时生成；人工可随后调整） */
function groupFileTemplate(id: string, chain: string[]): string {
  return `id: ${id}
name: 研发团队
description: 需求到交付的完整研发接力链：产品澄清 → 架构设计 → 界面设计 → 实现 → 测试 → 部署
icon: code
theme: ["#3b82f6", "#60a5fa"]
objective: 把用户需求打磨成可落地、可验收的研发交付件
chain: [${chain.join(', ')}]
order: 10
`
}

/** 从原文中移除 front-matter 内的 avatar.image 行（正文保持字节级不变） */
function stripAvatarImage(raw: string): string {
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return raw
  const fm = raw
    .slice(0, end)
    .split('\n')
    .filter((line) => !/^ {2}image:\s+\S/.test(line))
    .join('\n')
  return fm + raw.slice(end)
}

function main(): void {
  const cfg = loadConfig()
  const group = argValue('--group') ?? 'development'
  const prune = process.argv.includes('--prune')
  if (!/^[a-z][a-z0-9-]*$/.test(group)) {
    console.error(`[migrate] 非法场景 id "${group}"（需小写字母开头，可含数字与连字符）`)
    process.exit(1)
  }

  const promptsDir = cfg.promptsDir
  const avatarsDir = path.join(cfg.rootDir, 'client', 'public', 'avatars')
  if (!fs.existsSync(promptsDir)) {
    console.error(`[migrate] 源目录不存在：${promptsDir}`)
    process.exit(1)
  }

  console.log(`[migrate] 源目录: ${promptsDir}`)
  console.log(`[migrate] 目标目录: ${path.join(cfg.agentsDir, group)}`)

  const roleFiles = fs
    .readdirSync(promptsDir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== 'CHANGELOG.md')
    .sort()

  const created: string[] = []
  const skipped: string[] = []
  const failed: Array<{ file: string; error: string }> = []
  const okIds: string[] = []

  for (const file of roleFiles) {
    try {
      const raw = fs.readFileSync(path.join(promptsDir, file), 'utf8')
      const parsed = AgentFrontMatterSchema.safeParse(parseFrontMatter(raw).data)
      if (!parsed.success) {
        const issue = parsed.error.issues[0]
        throw new Error(`front-matter 校验失败：${issue.path.join('.') || 'front-matter'} ${issue.message}`)
      }
      const agent = parsed.data
      const stem = file.replace(/\.md$/, '')
      if (stem !== agent.id) {
        console.warn(`[migrate] 注意：${file} 的 id "${agent.id}" 与文件名不一致，目标目录按 id 命名`)
      }

      const targetDir = path.join(cfg.agentsDir, group, agent.id)
      const targetFile = path.join(targetDir, 'AGENT.md')
      if (fs.existsSync(targetFile)) {
        skipped.push(`${agent.id}/AGENT.md（已存在，跳过）`)
      } else {
        const migrated = stripAvatarImage(raw)
        // 出口自检：迁移后的 front-matter 仍须可解析（避免误删破坏了结构）
        const check = AgentFrontMatterSchema.safeParse(parseFrontMatter(migrated).data)
        if (!check.success) throw new Error(`迁移结果校验失败：${check.error.issues[0].message}`)
        fs.mkdirSync(targetDir, { recursive: true })
        fs.writeFileSync(targetFile, migrated)
        created.push(`${agent.id}/AGENT.md`)
      }

      const avatarSrc = path.join(avatarsDir, `${agent.id}.png`)
      const avatarTarget = path.join(targetDir, 'avatar.png')
      if (fs.existsSync(avatarTarget)) {
        skipped.push(`${agent.id}/avatar.png（已存在，跳过）`)
      } else if (fs.existsSync(avatarSrc)) {
        fs.mkdirSync(targetDir, { recursive: true })
        fs.copyFileSync(avatarSrc, avatarTarget)
        created.push(`${agent.id}/avatar.png`)
      } else {
        console.warn(`[migrate] 未找到头像 ${avatarSrc}（可后补 <agent 目录>/avatar.png）`)
      }

      okIds.push(agent.id)
    } catch (err) {
      failed.push({ file, error: (err as Error).message })
    }
  }

  // 根级资产：全局协议 + 变更日志（已存在则跳过，保护迁移后的修订）
  fs.mkdirSync(path.join(cfg.agentsDir, group), { recursive: true })
  for (const name of ['_protocol.md', 'CHANGELOG.md']) {
    const src = path.join(promptsDir, name)
    const target = path.join(cfg.agentsDir, name)
    if (!fs.existsSync(src)) continue
    if (fs.existsSync(target)) {
      skipped.push(`${name}（已存在，跳过）`)
    } else {
      fs.copyFileSync(src, target)
      created.push(name)
    }
  }

  // 场景元数据：缺失时按默认模板生成（链序沿用 DEFAULT_CHAIN）
  const groupFile = path.join(cfg.agentsDir, group, '_group.yaml')
  if (!fs.existsSync(groupFile)) {
    const chain = DEFAULT_CHAIN.filter((id) => okIds.includes(id)).concat(okIds.filter((id) => !DEFAULT_CHAIN.includes(id)))
    fs.writeFileSync(groupFile, groupFileTemplate(group, chain))
    created.push(`${group}/_group.yaml（模板已生成，建议按需调整）`)
  } else {
    skipped.push(`${group}/_group.yaml（已存在，跳过）`)
  }

  for (const item of created) console.log(`[migrate] + ${item}`)
  for (const item of skipped) console.log(`[migrate] = ${item}`)

  if (failed.length > 0) {
    for (const f of failed) console.error(`[migrate] 失败 ${f.file}: ${f.error}`)
    console.error('[migrate] 存在失败文件，源文件已保留，修复后可重新执行本脚本（幂等）')
    process.exit(1)
  }

  if (prune) {
    let removed = 0
    for (const file of roleFiles) {
      const id = file.replace(/\.md$/, '')
      if (!okIds.includes(id)) continue
      if (!fs.existsSync(path.join(cfg.agentsDir, group, id, 'AGENT.md'))) continue
      fs.rmSync(path.join(promptsDir, file), { force: true })
      const avatar = path.join(avatarsDir, `${id}.png`)
      if (fs.existsSync(path.join(cfg.agentsDir, group, id, 'avatar.png'))) fs.rmSync(avatar, { force: true })
      removed++
    }
    console.log(`[migrate] --prune：已清理 ${removed} 组源文件（prompts/*.md 与旧头像）`)
  } else {
    console.log('[migrate] 完成：源文件未删除（一个版本周期后可用 --prune 清理）')
  }
}

main()
