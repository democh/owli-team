/**
 * M66-A 测试：堪舆阳宅资产与合规。
 *
 * - 资产：场景元数据（chain / stage / defaultSkills / 串行）；2 角色工具白名单（含 luopan_pan 与 handoff）；
 * - 协议：合规红线（不承诺 / 先盘后论 / 精度分级 / 流派口径）与「渲染容器约定」在位；
 * - 禁词扫描：协议 + 人设 + 技能 + mock 触发块文本过禁词表（大凶 / 血光 / 破财 / 化解费）零命中
 *   （含「禁用 / 不写 / 禁词 / 恐吓 / 反模式」豁免的规范句）；
 * - 触发词防碰撞：堪舆走查 / 户型走查 不出现在 agents 语料；
 * - 工具核心：luopanText 输出含盘面卡（::: pan luopan）与精度声明。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { computeLuopan } from '../src/pan/luopan.js'
import { luopanText } from '../src/tools/luopan.js'
import { PromptLibrary } from '../src/store/prompts.js'

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

function readAgentFile(cfg: ReturnType<typeof loadConfig>, rel: string): string {
  return fs.readFileSync(path.join(cfg.agentsDir, rel), 'utf8')
}

describe('M66-A：堪舆阳宅资产与合规', () => {
  it('场景与角色：chain / stage / defaultSkills / 工具白名单（含 luopan_pan 与 handoff）', () => {
    const lib = realLibrary()
    const group = lib.groups().find((g) => g.id === 'fengshui')
    expect(group).toBeTruthy()
    expect(group?.chain).toEqual(['plan-surveyor', 'yangzhai-master'])
    expect(group?.defaultSkills).toEqual(['fengshui'])
    expect(group?.parallel).toBe(false)
    expect(group?.stage).toEqual({ layout: 'dock', panel: 'chartboard' })

    const surveyor = lib.get('plan-surveyor')
    const master = lib.get('yangzhai-master')
    expect(surveyor?.group).toBe('fengshui')
    expect(master?.group).toBe('fengshui')
    expect(master?.tools).toContain('luopan_pan')
    expect(master?.tools).toContain('zeri_pan')
    expect(master?.tools).toContain('handoff')
    expect(surveyor?.tools).toContain('handoff')
    expect(master?.handoff).toContain('plan-surveyor')
    expect(surveyor?.handoff).toContain('yangzhai-master')
  })

  it('协议与技能：合规红线 / 先盘后论 / 精度分级 / 流派口径 / 盘面容器约定在位', () => {
    const cfg = loadConfig()
    const proto = readAgentFile(cfg, 'fengshui/_protocol.md')
    for (const key of [
      '不承诺吉凶必应',
      '先盘后论',
      'luopan_pan',
      'zeri_pan',
      'A 级',
      '坐山派',
      '::: pan luopan',
      '::: pan zeri',
      '需现场核实',
    ]) {
      expect(proto, `协议应含「${key}」`).toContain(key)
    }
    const skill = fs.readFileSync(path.join(cfg.skillsDir, 'fengshui', 'SKILL.md'), 'utf8')
    for (const key of ['四维评述', '改善参考', '洛书飞布', '合规红线', '不承诺吉凶必应', '择日（日课）']) {
      expect(skill, `技能应含「${key}」`).toContain(key)
    }
    // 角色人设底部渲染容器约定（司南：盘面整卡）
    const master = readAgentFile(cfg, 'fengshui/yangzhai-master/AGENT.md')
    expect(master).toContain('::: pan luopan')
  })

  it('禁词扫描：协议 / 人设 / 技能 / mock 触发块文本零命中（规范句豁免）', () => {
    const cfg = loadConfig()
    const BANNED = ['大凶', '血光', '破财', '化解费']
    const EXEMPT = ['禁用', '不写', '禁词', '恐吓', '反模式']
    const files: [string, string][] = [
      ['fengshui/_protocol.md', readAgentFile(cfg, 'fengshui/_protocol.md')],
      ['fengshui/plan-surveyor/AGENT.md', readAgentFile(cfg, 'fengshui/plan-surveyor/AGENT.md')],
      ['fengshui/yangzhai-master/AGENT.md', readAgentFile(cfg, 'fengshui/yangzhai-master/AGENT.md')],
      ['skills/fengshui/SKILL.md', fs.readFileSync(path.join(cfg.skillsDir, 'fengshui', 'SKILL.md'), 'utf8')],
      // mock 触发块（LUOPAN/SURVEY）文本随 mock.ts 内联——扫描其中 fengshui 段落
      ['server/src/llm/mock.ts（fengshui 段）', fs.readFileSync(path.join(process.cwd(), 'src/llm/mock.ts'), 'utf8')],
    ]
    for (const [label, text] of files) {
      for (const line of text.split('\n')) {
        if (EXEMPT.some((w) => line.includes(w))) continue
        for (const w of BANNED) {
          expect(line, `${label} 不应含禁词「${w}」：${line.trim()}`).not.toContain(w)
        }
      }
    }
  })

  it('触发词防碰撞：堪舆走查 / 户型走查 不出现在 agents 语料（协议 / 人设 / 预设 / 技能）', () => {
    const cfg = loadConfig()
    const roots = [cfg.agentsDir, cfg.skillsDir]
    const collect = (dir: string): string[] => {
      const out: string[] = []
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...collect(full))
        else if (/\.(md|yaml|yml)$/.test(entry.name)) out.push(full)
      }
      return out
    }
    for (const file of roots.flatMap((r) => collect(r))) {
      // 变更日志含触发词登记（历史文档，非运行时语料）
      if (file.endsWith('CHANGELOG.md')) continue
      const text = fs.readFileSync(file, 'utf8')
      expect(text.includes('堪舆走查'), `${file} 不应含触发词「堪舆走查」`).toBe(false)
      expect(text.includes('户型走查'), `${file} 不应含触发词「户型走查」`).toBe(false)
      expect(text.includes('择日走查'), `${file} 不应含触发词「择日走查」`).toBe(false)
    }
  })

  it('工具核心：luopanText 输出含盘面卡与精度声明（先盘后论的整卡口径）', () => {
    const r = computeLuopan({ facing: '坐北朝南', quality: 'B', year: 2026, label: '自宅' })
    const text = luopanText(r)
    expect(text).toContain('::: pan luopan 自宅')
    expect(text).toContain('坎宅（东四宅）')
    expect(text).toContain('一白入中')
    expect(text).toContain('数据等级：B')
    expect(text).toContain('坐山派')
    expect(text).toContain('不承诺吉凶必应')
    // 整卡字段行 / 条目行结构与 pan 容器口径一致（字段 `键：值` + 条目 `- 键 | 值`）
    expect(text).toContain('坐向：坐 子山')
    expect(text).toContain('- 口径声明 |')
  })
})
