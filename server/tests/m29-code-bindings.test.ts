/**
 * M29 测试：研发场景能力矩阵与编码代理能力基线（CAB）的可达性断言（真实 agents/ 资产）。
 *
 * 背景：全部 34 角色均显式声明 tools 白名单，工具“存在但不可达”是历史高发缺陷
 * （v11 browser_*、v12 db_* / ssh_exec 均为此类修复）。本文件以数据面断言守住
 * M29 的能力矩阵：handoff 全局接通、remember 研发全员、代码角色自测 / 自提交、
 * qa 只读数据面、designer 浏览器只读子集（职责边界不越权）。
 */
import { describe, expect, it } from 'vitest'
import { BLANK_SCENE_ID } from '@multi-agent/shared'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

const DEVELOPMENT_ROLES = ['pm', 'architect', 'designer', 'frontend', 'backend', 'qa', 'devops'] as const
const CODE_ROLES = ['frontend', 'backend', 'qa'] as const
const BROWSER_READONLY_SUBSET = [
  'browser_open',
  'browser_navigate',
  'browser_snapshot',
  'browser_screenshot',
  'browser_console',
  'browser_wait',
  'browser_close',
]
const BROWSER_INTERACTION = ['browser_click', 'browser_fill', 'browser_press', 'browser_eval', 'browser_scroll']

describe('M29：可达性基线（handoff / remember）', () => {
  it('业务角色白名单均含 handoff（结构化转交为第一通道，ADR 2；含后续扩张的新场景角色）', () => {
    const lib = realLibrary()
    // M50：空场景（blank）通用助手为单助手直聊、不参与接力 —— 唯一无 handoff 例外，不在基线约束内
    const all = lib.list().filter((agent) => agent.group !== BLANK_SCENE_ID)
    // 角色库随场景扩张增长（M29 基线时为 34），不锁定总数：只要求规模不回退、基线约束持续成立
    expect(all.length).toBeGreaterThanOrEqual(34)
    for (const agent of all) {
      expect(agent.tools, `${agent.group}/${agent.id} 缺少 handoff`).toContain('handoff')
    }
  })

  it('研发 7 角色白名单均含 remember（关键口径固化）', () => {
    const lib = realLibrary()
    for (const id of DEVELOPMENT_ROLES) {
      expect(lib.get(id)?.tools, `${id} 缺少 remember`).toContain('remember')
    }
  })
})

describe('M29：编码代理能力（执行验证 / 版本控制）', () => {
  it('代码角色（frontend / backend / qa）持有 run_command（自测与回归）', () => {
    const lib = realLibrary()
    for (const id of CODE_ROLES) {
      expect(lib.get(id)?.tools, `${id} 缺少 run_command`).toContain('run_command')
    }
  })

  it('实现者（frontend / backend）持有写类 git（分支 / 提交，走审批门）与只读 git', () => {
    const lib = realLibrary()
    for (const id of ['frontend', 'backend'] as const) {
      const tools = lib.get(id)?.tools ?? []
      for (const tool of ['git_status', 'git_diff', 'git_log', 'git_branch', 'git_commit', 'git_restore']) {
        expect(tools, `${id} 缺少 ${tool}`).toContain(tool)
      }
    }
  })

  it('验证方（qa）只持只读 git（无分支 / 提交 / 还原）', () => {
    const lib = realLibrary()
    const tools = lib.get('qa')?.tools ?? []
    for (const tool of ['git_status', 'git_diff', 'git_log']) {
      expect(tools, `qa 缺少 ${tool}`).toContain(tool)
    }
    for (const tool of ['git_branch', 'git_commit', 'git_restore']) {
      expect(tools, `qa 不应持有 ${tool}`).not.toContain(tool)
    }
  })

  it('devops 保留发布通道（run_command + git 全套 + ssh_exec）', () => {
    const lib = realLibrary()
    const tools = lib.get('devops')?.tools ?? []
    for (const tool of ['run_command', 'ssh_exec', 'git_branch', 'git_commit', 'git_restore']) {
      expect(tools, `devops 缺少 ${tool}`).toContain(tool)
    }
  })
})

describe('M29：数据与环境分权', () => {
  it('backend 持数据库全量能力，qa 仅持只读三件套（不含 db_execute）', () => {
    const lib = realLibrary()
    const backend = lib.get('backend')?.tools ?? []
    for (const tool of ['db_list_connections', 'db_schema', 'db_query', 'db_execute']) {
      expect(backend, `backend 缺少 ${tool}`).toContain(tool)
    }
    const qa = lib.get('qa')?.tools ?? []
    for (const tool of ['db_list_connections', 'db_schema', 'db_query']) {
      expect(qa, `qa 缺少 ${tool}`).toContain(tool)
    }
    expect(qa, 'qa 不应持有 db_execute（验证方不做写操作）').not.toContain('db_execute')
  })

  it('designer 持浏览器只读子集，不含交互类工具（只「看」不「动」）', () => {
    const lib = realLibrary()
    const designer = lib.get('designer')?.tools ?? []
    for (const tool of BROWSER_READONLY_SUBSET) {
      expect(designer, `designer 缺少 ${tool}`).toContain(tool)
    }
    for (const tool of BROWSER_INTERACTION) {
      expect(designer, `designer 不应持有 ${tool}`).not.toContain(tool)
    }
  })

  it('pm 持排期与指标口径工具（calc / date_calc）', () => {
    const lib = realLibrary()
    const pm = lib.get('pm')?.tools ?? []
    for (const tool of ['calc', 'date_calc']) {
      expect(pm, `pm 缺少 ${tool}`).toContain(tool)
    }
  })
})

describe('M29：技能层与场景协议', () => {
  it('代码角色预载 debugging 技能；code-review 维持按需加载（M29 设计范围内）', () => {
    const lib = realLibrary()
    for (const id of CODE_ROLES) {
      expect(lib.get(id)?.skills, `${id} 缺少 debugging 预载`).toContain('debugging')
    }
    // code-review 为按需加载技能：M29 设计范围内（研发 7 角色）不预载；
    // 专业评审类角色（如 security）按其场景设计可显式预载，不在本断言约束内
    for (const id of DEVELOPMENT_ROLES) {
      expect(lib.get(id)?.skills ?? [], `${id} 不应预载 code-review（按需加载）`).not.toContain('code-review')
    }
  })

  it('development 场景协议：工程纪律六条关键约束在场', () => {
    const lib = realLibrary()
    const protocol = lib.groupProtocol('development')
    expect(protocol).toContain('scene="development"')
    for (const keyword of ['先读后写', '最小 diff', '共享文件所有权', '验证闭环', '缺陷回交', '提交与发布纪律', '依赖与配置纪律']) {
      expect(protocol, `development 协议缺少「${keyword}」`).toContain(keyword)
    }
    // 跨场景协议保持独立：市场增长保留实验纪律。
    expect(lib.groupProtocol('marketing')).toContain('实验纪律')
  })
})
