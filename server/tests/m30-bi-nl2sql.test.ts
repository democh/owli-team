/**
 * M30 测试：BI 场景与 NL2SQL 取数能力（真实 agents/ + skills/ 资产）。
 *
 * 背景：v15 新增「商业智能」场景与 BI 分析师（沈析）——把业务问题转译为可复现 SQL
 * 的取数管道（口径 → 库表探索 → SQL → 校验 → 解读）。数据库工具为延迟加载
 * （tier=deferred，ADR 54），经 tool_search 激活后本 Run 可用，本文件守护三件事：
 * ① 白名单可达性（db 只读三件套 + 文件侧 / 协作基线工具，"存在但不可达"为历史高发缺陷）；
 * ② 只读边界（不持 db_execute，写操作转交数据工程，与 qa 只读三件套同先例）；
 * ③ 方法论文档在场（nl2sql 技能六步法 + bi 场景协议取数纪律）。
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { SkillLibrary } from '../src/store/skills.js'
import { createDbTools } from '../src/tools/db.js'

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

function realSkills(): SkillLibrary {
  const cfg = loadConfig()
  return new SkillLibrary(cfg.skillsDir)
}

describe('M30：BI 场景与角色资产', () => {
  it('bi 场景加载：元数据 / 编制链 / 排序正确', () => {
    const lib = realLibrary()
    const group = lib.groups().find((g) => g.id === 'bi')
    expect(group).toBeDefined()
    expect(group?.name).toBe('商业智能')
    expect(group?.chain).toEqual(['bi'])
    expect(group?.order).toBe(65) // finance(60) 与 ops(70) 之间
  })

  it('BI 分析师加载：核心元数据与 handoff 交接对象正确', () => {
    const lib = realLibrary()
    const bi = lib.get('bi')
    expect(bi?.group).toBe('bi')
    expect(bi?.name).toBe('沈析')
    expect(bi?.role).toBe('BI 分析师')
    expect(bi?.temperature).toBe(0.3)
    expect(bi?.handoff).toEqual(['insight', 'finance', 'data-engineer'])
  })

  it('validate()：真实资产无语义问题（bi 的 handoff / preset 引用全部成立）', () => {
    const lib = realLibrary()
    expect(lib.validate()).toEqual([])
  })
})

describe('M30：取数能力与只读边界（可达性基线）', () => {
  it('BI 分析师持数据库只读三件套（NL2SQL 取数管道）', () => {
    const lib = realLibrary()
    const tools = lib.get('bi')?.tools ?? []
    for (const tool of ['db_list_connections', 'db_schema', 'db_query']) {
      expect(tools, `bi 缺少 ${tool}`).toContain(tool)
    }
  })

  it('BI 分析师不持 db_execute（只读取数；写操作转交数据工程）', () => {
    const lib = realLibrary()
    expect(lib.get('bi')?.tools ?? [], 'bi 不应持有 db_execute').not.toContain('db_execute')
  })

  it('文件侧分析工具齐备（csv_analyze / calc / date_calc 与读写文件集）', () => {
    const lib = realLibrary()
    const tools = lib.get('bi')?.tools ?? []
    for (const tool of ['list_dir', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'search_text', 'glob', 'grep', 'csv_analyze', 'calc', 'date_calc']) {
      expect(tools, `bi 缺少 ${tool}`).toContain(tool)
    }
  })

  it('协作基线工具齐备（handoff / remember / request_approval，口径确认与转交通道）', () => {
    const lib = realLibrary()
    const tools = lib.get('bi')?.tools ?? []
    for (const tool of ['handoff', 'remember', 'request_approval', 'write_todos', 'load_skill']) {
      expect(tools, `bi 缺少 ${tool}`).toContain(tool)
    }
  })

  it('渐进披露契约：db 工具维持 deferred（经 tool_search 激活后才进工具清单）', () => {
    const tools = createDbTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['db_execute', 'db_list_connections', 'db_query', 'db_schema'])
    for (const tool of tools) {
      expect(tool.tier, `${tool.name} 应为 deferred（ADR 54）`).toBe('deferred')
    }
  })
})

describe('M30：方法论文档在场（技能层与场景协议）', () => {
  it('技能预载：nl2sql / data-visualization / spreadsheet-modeling', () => {
    const lib = realLibrary()
    expect(lib.get('bi')?.skills).toEqual(['nl2sql', 'data-visualization', 'spreadsheet-modeling', 'report-authoring'])
  })

  it('nl2sql 技能在场：描述含触发场景，正文含六步法与纪律关键词', () => {
    const skills = realSkills()
    const skill = skills.get('nl2sql')
    expect(skill).toBeDefined()
    expect(skill?.description).toContain('NL2SQL')
    const body = skill?.body ?? ''
    for (const keyword of ['口径', 'SELECT', 'LIMIT', '只读', '脱敏', 'tool_search']) {
      expect(body, `nl2sql 技能缺少「${keyword}」`).toContain(keyword)
    }
  })

  it('bi 场景协议：取数纪律关键约束在场', () => {
    const lib = realLibrary()
    const protocol = lib.groupProtocol('bi')
    expect(protocol).toContain('scene="bi"')
    for (const keyword of ['口径先行', '只读取数', 'SQL 纪律', '结果校验', '数据安全', '可复现', 'tool_search']) {
      expect(protocol, `bi 协议缺少「${keyword}」`).toContain(keyword)
    }
    // 跨场景协议保持独立：市场增长保留实验纪律。
    expect(lib.groupProtocol('marketing')).toContain('实验纪律')
  })

  it('取数口径与经营解读分工：bi 交付件路径与 insight 不重叠', () => {
    const lib = realLibrary()
    const bi = lib.get('bi')
    expect(bi?.tools).not.toContain('web_search') // 外部数据拼接经 research 场景分层，不在取数管道内
    expect(bi?.group).toBe('bi')
    expect(lib.get('insight')?.group).toBe('strategy') // 经营解读仍归 strategy 场景（职责切割不越权）
  })
})
