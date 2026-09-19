/**
 * M35 测试：定时任务能力绑定（真实 agents/ 资产）。
 *
 * 背景：M35 新增会话级定时任务三件套（schedule_task / list_schedules / manage_schedule，
 * tier=deferred，经 tool_search 检索激活）。工具行为本身由 m35-schedule-tools.test.ts 守护；
 * 本文件守护「角色侧」四件事：
 * ① 白名单可达性（8 个时间敏感角色：行政 / 运营 / SRE / 合规 / 内容 / 客户成功 / 情报 / 生活管家，
 *    "存在但不可达"为历史高发缺陷——v13 handoff 零绑定事故）；
 * ② 白名单边界（能力不扩散：仅这 8 个角色持有，未绑定角色连 tool_search 都无法发现——deferred
 *    可发现范围 = 白名单过滤后的工具集）；
 * ③ 引导在场（角色正文 / 全局协议 / 场景协议三处引导 deferred 工具，对齐 v16 ssh_exec 先例）；
 * ④ 运行时绑定与范式收敛（forAgent 真实解析白名单无拼写丢失；plan 只读集合只含 list_schedules）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { BLANK_SCENE_ID } from '@multi-agent/shared'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { createScheduleTools } from '../src/tools/schedule.js'

/** 绑定角色：id → 相对 agentsDir 的资产目录（正文引导断言用） */
const BOUND_ROLES: Array<[string, string]> = [
  ['assistant', 'ops/assistant'],
  ['ops', 'ops/ops'],
  ['sre', 'sre/sre'],
  ['compliance', 'finance/compliance'],
  ['content', 'marketing/content'],
  ['success', 'sales/success'],
  ['scout', 'research/scout'],
  ['life-admin', 'personal/life-admin'],
  // M69：时间敏感角色增补（习惯提醒 / 证照到期提醒）
  ['habit-coach', 'personal/habit-coach'],
  ['license-keeper', 'ops/license-keeper'],
]

/** 定时工具三件套（注册名） */
const SCHEDULE_TOOLS = ['schedule_task', 'list_schedules', 'manage_schedule']

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

describe('M35：定时任务白名单可达性（10 个时间敏感角色）', () => {
  it('10 角色全部持有 schedule_task / list_schedules / manage_schedule', () => {
    const lib = realLibrary()
    for (const [id] of BOUND_ROLES) {
      const agent = lib.get(id)
      expect(agent, `角色 ${id} 未加载`).toBeDefined()
      for (const tool of SCHEDULE_TOOLS) {
        expect(agent?.tools ?? [], `${id} 缺少 ${tool}`).toContain(tool)
      }
    }
  })

  it('原白名单不回归：8 角色的协作基线（handoff / remember / load_skill）仍在', () => {
    const lib = realLibrary()
    for (const [id] of BOUND_ROLES) {
      const tools = lib.get(id)?.tools ?? []
      // write_todos 不入基线：scout 为检索角色、原白名单即不含（research 场景以 handoff 接力为主）
      for (const tool of ['handoff', 'remember', 'load_skill']) {
        expect(tools, `${id} 缺少协作基线 ${tool}`).toContain(tool)
      }
    }
  })
})

describe('M35：白名单边界（能力不扩散）', () => {
  it('仅这 10 个角色持有：持有者集合精确匹配（未绑定角色无法经 tool_search 发现）', () => {
    const lib = realLibrary()
    // M50：空场景通用助手不纳入能力边界约束（单助手场景持全套工具，含定时任务三件套）
    const holders = lib
      .list()
      .filter((agent) => agent.group !== BLANK_SCENE_ID)
      .filter((agent) => (agent.tools ?? []).includes('schedule_task'))
      .map((agent) => agent.id)
      .sort()
    expect(holders).toEqual(BOUND_ROLES.map(([id]) => id).sort())
  })

  it('非绑定角色抽查：研发 / QA / BI / 设计 / 发布不持有（职责边界不变）', () => {
    const lib = realLibrary()
    for (const id of ['frontend', 'backend', 'qa', 'bi', 'designer', 'devops', 'pm']) {
      const tools = lib.get(id)?.tools ?? []
      for (const tool of SCHEDULE_TOOLS) {
        expect(tools, `${id} 不应持有 ${tool}（未纳入时间敏感角色集）`).not.toContain(tool)
      }
    }
  })
})

describe('M35：渐进披露契约（deferred 加载层级与只读边界）', () => {
  it('三工具维持 deferred（经 tool_search 激活后才进工具清单）', () => {
    const tools = createScheduleTools()
    expect(tools.map((t) => t.name)).toEqual(SCHEDULE_TOOLS)
    for (const tool of tools) {
      expect(tool.tier, `${tool.name} 应为 deferred（渐进披露，对齐 M28 画布先例）`).toBe('deferred')
    }
  })

  it('只读边界：list_schedules 只读；创建 / 管理为写类（触发运行须经调度服务留痕）', () => {
    const byName = new Map(createScheduleTools().map((t) => [t.name, t]))
    expect(byName.get('list_schedules')?.readOnly).toBe(true)
    expect(byName.get('schedule_task')?.readOnly).toBeFalsy()
    expect(byName.get('manage_schedule')?.readOnly).toBeFalsy()
  })
})

describe('M35：引导在场（角色正文 / 全局协议 / 场景协议）', () => {
  it('10 角色正文含定时工具引导（先 tool_search 检索「定时」激活）', () => {
    const cfg = loadConfig()
    for (const [id, dir] of BOUND_ROLES) {
      const text = fs.readFileSync(path.join(cfg.agentsDir, dir, 'AGENT.md'), 'utf8')
      expect(text, `${id} 正文缺少 tool_search 引导`).toContain('tool_search')
      expect(text, `${id} 正文缺少 schedule_task 引用`).toContain('schedule_task')
    }
  })

  it('全局协议 tool_policy 含定时任务纪律（激活方式 / 最小间隔 / 与 write_todos 区隔）', () => {
    const protocol = realLibrary().protocolText
    for (const keyword of ['schedule_task', 'tool_search', '5 分钟', 'write_todos', '定时']) {
      expect(protocol, `全局协议缺少「${keyword}」`).toContain(keyword)
    }
  })

  it('场景协议含场景化定时纪律（sre 观察窗口 / finance 申报节点 / research 长周期课题）', () => {
    const lib = realLibrary()
    const expectations: Array<[string, string]> = [
      ['sre', '观察窗口'],
      ['finance', '申报与整改节点'],
      ['research', '长周期课题'],
    ]
    for (const [groupId, keyword] of expectations) {
      const protocol = lib.groupProtocol(groupId)
      expect(protocol, `${groupId} 场景协议缺少「${keyword}」`).toContain(keyword)
      expect(protocol, `${groupId} 场景协议缺少 schedule_task`).toContain('schedule_task')
      expect(protocol, `${groupId} 场景协议缺少 tool_search 引导`).toContain('tool_search')
    }
    // 新增场景协议后回归：marketing 也持有专属协议（实验纪律在场）
    expect(lib.groupProtocol('marketing')).toContain('实验纪律')
  })
})

describe('M35：运行时绑定（工具名到工具对象的真实解析）与范式收敛', () => {
  it('forAgent(execute) 完整解析 8 角色白名单：全部工具真实绑定（无拼写错误静默丢失）', () => {
    const cfg = loadConfig()
    const lib = realLibrary()
    const registry = createToolRegistry(cfg)
    for (const [id] of BOUND_ROLES) {
      const agent = lib.get(id)
      expect(agent).toBeDefined()
      const bound = new Set(registry.forAgent(agent!).map((t) => t.name))
      for (const name of agent?.tools ?? []) {
        // MCP 通配条目（mcp__<slug>__* / mcp__*）为运行时模式：随服务器连接动态解析，
        // 不属于本用例的「静态绑定」断言范围（拼写守卫仅针对具体工具名）；此处只做格式守卫
        if (name.endsWith('*')) {
          expect(name, `${id} MCP 通配格式非法`).toMatch(/^mcp__\*$|^mcp__[a-z][a-z0-9-]{0,39}__\*$/)
          continue
        }
        expect(bound.has(name), `${id} 白名单工具 ${name} 未在运行时绑定（拼写错误 / 未注册）`).toBe(true)
      }
    }
  })

  it('范式收敛：plan 只读集合含 list_schedules，不含 schedule_task / manage_schedule（只读规划不建任务）', () => {
    const cfg = loadConfig()
    const lib = realLibrary()
    const registry = createToolRegistry(cfg)
    const agent = lib.get('assistant')
    const readonly = new Set(registry.forAgent(agent!, 'plan').map((t) => t.name))
    expect(readonly.has('list_schedules'), 'plan 范式缺少只读的 list_schedules').toBe(true)
    for (const tool of ['schedule_task', 'manage_schedule']) {
      expect(readonly.has(tool), `${tool} 为写类工具，不应出现在 plan 只读集合`).toBe(false)
    }
  })
})
