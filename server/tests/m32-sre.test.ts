/**
 * M32 测试：SRE 场景与 SSH 事故响应能力（真实 agents/ + skills/ 资产）。
 *
 * 背景：M32 新增「站点可靠性」场景与 SRE 工程师（江屿）——把 M23 已建成的 SSH 远程
 * 执行能力（会话绑定 / allowExec 开关 / 审批门 / 30s 超时与输出截断）组合为生产事故
 * 响应管道（分级 → 止血 → 证据采集 → 定位 → 复盘）。ssh_exec 为延迟加载（tier=deferred，
 * ADR 54），经 tool_search 激活后本 Run 可用，本文件守护四件事：
 * ① 白名单可达性（ssh_exec + run_command + git 只读 + 度量工具，"存在但不可达"为历史高发缺陷）；
 * ② 权限边界（git 写类不持有——SRE 不提交代码，与 qa 只读先例一致；无 db 写）；
 * ③ 运行时绑定（forAgent 真实解析全部白名单工具——resolveTools 对未知名静默丢弃）与 plan 范式收敛；
 * ④ 方法论文档在场（incident-response 技能五步响应 + sre 场景协议事故纪律）。
 */
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { SkillLibrary } from '../src/store/skills.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import { createSshTools } from '../src/tools/ssh.js'

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

function realSkills(): SkillLibrary {
  const cfg = loadConfig()
  return new SkillLibrary(cfg.skillsDir)
}

describe('M32：SRE 场景与角色资产', () => {
  it('sre 场景加载：元数据 / 编制链 / 排序正确', () => {
    const lib = realLibrary()
    const group = lib.groups().find((g) => g.id === 'sre')
    expect(group).toBeDefined()
    expect(group?.name).toBe('站点可靠性')
    expect(group?.chain).toEqual(['sre'])
    expect(group?.order).toBe(15) // development(10) 之后，研发可靠性职能
  })

  it('SRE 工程师加载：核心元数据与 handoff 交接对象正确', () => {
    const lib = realLibrary()
    const sre = lib.get('sre')
    expect(sre?.group).toBe('sre')
    expect(sre?.name).toBe('江屿')
    expect(sre?.role).toBe('SRE 工程师')
    expect(sre?.temperature).toBe(0.3)
    expect(sre?.handoff).toEqual(['devops', 'backend', 'qa'])
  })

  it('validate()：真实资产无语义问题（sre 的 handoff / preset 引用全部成立）', () => {
    const lib = realLibrary()
    expect(lib.validate()).toEqual([])
  })
})

describe('M32：SSH 事故响应能力与权限边界（可达性基线）', () => {
  it('SRE 持 ssh_exec（远程诊断核心通道）', () => {
    const lib = realLibrary()
    expect(lib.get('sre')?.tools ?? [], 'sre 缺少 ssh_exec').toContain('ssh_exec')
  })

  it('SRE 持本地验证（run_command）与 git 只读三件套（变更定位）', () => {
    const lib = realLibrary()
    const tools = lib.get('sre')?.tools ?? []
    for (const tool of ['run_command', 'git_status', 'git_diff', 'git_log']) {
      expect(tools, `sre 缺少 ${tool}`).toContain(tool)
    }
  })

  it('SRE 不持 git 写类（不提交代码；修复经 handoff 交实现者）', () => {
    const lib = realLibrary()
    const tools = lib.get('sre')?.tools ?? []
    for (const tool of ['git_branch', 'git_commit', 'git_restore']) {
      expect(tools, `sre 不应持有 ${tool}（写类 git 归实现者）`).not.toContain(tool)
    }
  })

  it('SRE 不持数据库写入（无 db_execute；数据侧取数归 bi 场景）', () => {
    const lib = realLibrary()
    expect(lib.get('sre')?.tools ?? [], 'sre 不应持有 db_execute').not.toContain('db_execute')
  })

  it('度量与检索工具齐备（calc / date_calc / web 检索 + 文件集）', () => {
    const lib = realLibrary()
    const tools = lib.get('sre')?.tools ?? []
    for (const tool of ['calc', 'date_calc', 'web_fetch', 'web_search', 'read_file', 'write_file', 'edit_file', 'apply_patch', 'grep', 'glob']) {
      expect(tools, `sre 缺少 ${tool}`).toContain(tool)
    }
  })

  it('协作基线工具齐备（handoff / remember / request_approval，变更报批通道）', () => {
    const lib = realLibrary()
    const tools = lib.get('sre')?.tools ?? []
    for (const tool of ['handoff', 'remember', 'request_approval', 'write_todos', 'load_skill']) {
      expect(tools, `sre 缺少 ${tool}`).toContain(tool)
    }
  })

  it('渐进披露契约：ssh 工具维持 deferred（经 tool_search 激活后才进工具清单）', () => {
    const tools = createSshTools()
    expect(tools.map((t) => t.name)).toEqual(['ssh_exec'])
    for (const tool of tools) {
      expect(tool.tier, `${tool.name} 应为 deferred（ADR 54）`).toBe('deferred')
    }
  })
})

describe('M32：方法论文档在场（技能层与场景协议）', () => {
  it('技能预载：incident-response / debugging', () => {
    const lib = realLibrary()
    expect(lib.get('sre')?.skills).toEqual(['incident-response', 'debugging'])
  })

  it('incident-response 技能在场：描述含触发场景，正文含五步响应与 SSH 命令库', () => {
    const skills = realSkills()
    const skill = skills.get('incident-response')
    expect(skill).toBeDefined()
    expect(skill?.description).toContain('事故')
    const body = skill?.body ?? ''
    for (const keyword of ['止血', 'SEV', '复盘', 'ssh_exec', 'systemctl', 'journalctl']) {
      expect(body, `incident-response 技能缺少「${keyword}」`).toContain(keyword)
    }
  })

  it('sre 场景协议：事故纪律关键约束在场', () => {
    const lib = realLibrary()
    const protocol = lib.groupProtocol('sre')
    expect(protocol).toContain('scene="sre"')
    for (const keyword of ['证据先行', '止血', '审批', '只读命令', '时间线', '复盘无责', '脱敏', 'tool_search']) {
      expect(protocol, `sre 协议缺少「${keyword}」`).toContain(keyword)
    }
    // 新增场景协议后回归：marketing 也持有专属协议（实验纪律在场）
    expect(lib.groupProtocol('marketing')).toContain('实验纪律')
  })

  it('运行态保障与变更交付分工：SRE 管运行态，发布动作仍归 devops', () => {
    const lib = realLibrary()
    const sre = lib.get('sre')?.tools ?? []
    expect(sre, 'SRE 不做代码提交').not.toContain('git_commit')
    expect(lib.get('devops')?.tools ?? [], 'devops 保留发布通道').toContain('git_commit')
    expect(lib.get('devops')?.tools ?? [], 'devops 保留 SSH 通道').toContain('ssh_exec')
  })
})

describe('M32：运行时绑定（工具名到工具对象的真实解析；resolveTools 对未知名静默丢弃的守护）', () => {
  it('forAgent(execute) 完整解析 sre 白名单：全部工具真实绑定（无拼写错误静默丢失）', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
    const sre = lib.get('sre')
    expect(sre).toBeDefined()
    const registry = createToolRegistry(cfg)
    const bound = new Set(registry.forAgent(sre!).map((t) => t.name))
    const whitelist = sre?.tools ?? []
    expect(whitelist.length).toBeGreaterThanOrEqual(20)
    for (const name of whitelist) {
      expect(bound.has(name), `白名单工具 ${name} 未在运行时绑定（拼写错误 / 未注册）`).toBe(true)
    }
  })

  it('范式收敛：plan 只读集合含 git 只读三件套，不含 ssh_exec / run_command 等非只读工具', () => {
    const cfg = loadConfig()
    const lib = new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
    const sre = lib.get('sre')
    const registry = createToolRegistry(cfg)
    const readonly = new Set(registry.forAgent(sre!, 'plan').map((t) => t.name))
    for (const tool of ['git_status', 'git_diff', 'git_log', 'read_file', 'list_dir']) {
      expect(readonly.has(tool), `plan 范式缺少只读工具 ${tool}`).toBe(true)
    }
    for (const tool of ['ssh_exec', 'run_command', 'write_file', 'edit_file', 'apply_patch']) {
      expect(readonly.has(tool), `${tool} 为非只读工具，不应出现在 plan 只读集合`).toBe(false)
    }
  })
})
