/**
 * M21 测试：OPC 业务场景与角色资产（v14/v15/M32/M34/M46/M50/M51-A/M51-B/M51-C/M51-D/M51-E / M65-A 扩展后 30 场景 / 117 角色）、快速组队预设（_presets.yaml）与校验。
 * 覆盖：真实资产加载（场景 order 排序 / 编制链 / 并行与 rounds 特性 / 场景协议）、
 * 新角色元数据（tools / temperature / handoff / 技能预载）、presets 解析与排序、
 * 非法预设（成员缺失 / id 重复 / members 为空 / YAML 破损）的 validate 与加载报错。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { PromptLibrary } from '../src/store/prompts.js'
import { makeTmpDir } from './helpers.js'

// ---------- 真实资产（仓库 agents/） ----------

function realLibrary(): PromptLibrary {
  const cfg = loadConfig()
  return new PromptLibrary({ agentsDir: cfg.agentsDir, promptsDir: cfg.promptsDir, onWarn: () => {} })
}

describe('M21：OPC 场景与角色资产（真实 agents/ 目录）', () => {
  it('41 个场景按 order 排序加载，各场景特性正确', () => {
    const lib = realLibrary()
    const groups = lib.groups()
    expect(groups.map((g) => g.id)).toEqual([
      'blank',
      'strategy',
      'development',
      'sre',
      'brainstorm',
      'research',
      'marketing',
      'sales',
      'finance',
      'invest',
      'bi',
      'ops',
      'funding',
      'health',
      'learning',
      'travel',
      'wealth',
      'home',
      'personal',
      'debate',
      'negotiation',
      'society',
      'gamedesign',
      'writing',
      'career',
      'housing',
      'care',
      'metaphysics',
      'interior',
      'astrology',
      'ecommerce',
      'fengshui',
      'creator',
      'legal-personal',
      'academic',
      'relationship',
      'trpg',
      'tarot',
      'moot-court',
      'business-sim',
      'philosophy',
    ])
    const byId = new Map(groups.map((g) => [g.id, g]))
    expect(byId.get('strategy')?.rounds).toBe(true)
    expect(byId.get('marketing')?.parallel).toBe(true)
    expect(byId.get('marketing')?.parallelMax).toBe(3)
    expect(byId.get('marketing')?.defaultSkills).toEqual(['content-marketing'])
    expect(byId.get('marketing')?.chain).toEqual(['growth', 'content', 'seo', 'brand'])
    expect(byId.get('sales')?.chain).toEqual(['sales', 'success', 'support'])
    expect(byId.get('funding')?.chain).toEqual(['fundraiser', 'ir'])
    expect(byId.get('health')?.parallel).toBe(true)
    expect(byId.get('health')?.chain).toEqual(['fitness', 'nutrition', 'wellness'])
    expect(byId.get('home')?.chain).toEqual(['chef', 'home', 'pet', 'parenting'])
    expect(byId.get('invest')?.parallel).toBe(true)
    expect(byId.get('invest')?.chain).toEqual(['invest-lead', 'analyst-fa', 'analyst-ta', 'analyst-news', 'quant'])
    expect(byId.get('debate')?.rounds).toBe(true)
    expect(byId.get('debate')?.parallel).toBe(true)
    expect(byId.get('debate')?.chain).toEqual(['judge', 'affirmative', 'negative', 'evidence'])
    expect(byId.get('negotiation')?.rounds).toBe(true)
    expect(byId.get('negotiation')?.parallel).toBe(false)
    expect(byId.get('negotiation')?.chain).toEqual(['negotiator', 'counterpart', 'tactician'])
    expect(byId.get('society')?.rounds).toBe(true)
    expect(byId.get('society')?.parallel).toBe(true)
    expect(byId.get('society')?.chain).toEqual(['moderator', 'fact-checker', 'stakeholder', 'policy-advisor'])
    expect(byId.get('gamedesign')?.parallel).toBe(true)
    expect(byId.get('gamedesign')?.rounds).toBe(false)
    expect(byId.get('gamedesign')?.chain).toEqual(['game-designer', 'balance-designer', 'narrative-designer', 'playtester'])
    expect(byId.get('writing')?.parallel).toBe(false)
    expect(byId.get('writing')?.chain).toEqual(['storyline', 'author', 'editor', 'publisher'])
    expect(byId.get('career')?.parallel).toBe(false)
    expect(byId.get('career')?.chain).toEqual(['career-advisor', 'resume-coach', 'interview-coach', 'comp-advisor'])
    expect(byId.get('housing')?.parallel).toBe(false)
    expect(byId.get('housing')?.chain).toEqual(['home-finder', 'mortgage-advisor', 'reno-designer'])
    expect(byId.get('care')?.parallel).toBe(false)
    expect(byId.get('care')?.chain).toEqual(['care-planner', 'care-escort', 'elder-advisor'])
    expect(byId.get('metaphysics')?.parallel).toBe(true)
    expect(byId.get('metaphysics')?.parallelMax).toBe(4)
    expect(byId.get('metaphysics')?.defaultSkills).toEqual(['chinese-metaphysics'])
    expect(byId.get('metaphysics')?.chain).toEqual(['bazi', 'ziwei', 'liuyao', 'meihua', 'qizheng', 'daliuren', 'qimen'])
    expect(byId.get('astrology')?.parallel).toBe(true)
    expect(byId.get('astrology')?.parallelMax).toBe(4)
    expect(byId.get('astrology')?.defaultSkills).toEqual(['western-astrology'])
    expect(byId.get('astrology')?.chain).toEqual(['natal', 'transit', 'synastry', 'horary'])
    // M65-A：家装设计工作室（dock · studio 面板——第 7 类面板）
    expect(byId.get('interior')?.parallel).toBe(true)
    expect(byId.get('interior')?.parallelMax).toBe(2)
    expect(byId.get('interior')?.defaultSkills).toEqual(['interior-design'])
    expect(byId.get('interior')?.chain).toEqual(['interior-designer', 'space-planner', 'visualizer'])
    expect(byId.get('interior')?.stage).toEqual({ layout: 'dock', panel: 'studio' })
    // M66-A：堪舆阳宅（dock · chartboard 面板；先解析后判读串行）
    expect(byId.get('fengshui')?.parallel).toBe(false)
    expect(byId.get('fengshui')?.defaultSkills).toEqual(['fengshui'])
    expect(byId.get('fengshui')?.chain).toEqual(['plan-surveyor', 'yangzhai-master'])
    expect(byId.get('fengshui')?.stage).toEqual({ layout: 'dock', panel: 'chartboard' })
    // M69：场景扩展二批（十场景特性抽查）
    expect(byId.get('trpg')?.rounds).toBe(true)
    expect(byId.get('trpg')?.parallel).toBe(false)
    expect(byId.get('tarot')?.parallel).toBe(true)
    expect(byId.get('tarot')?.parallelMax).toBe(2)
    expect(byId.get('tarot')?.rounds).toBe(false)
    expect(byId.get('moot-court')?.rounds).toBe(true)
    expect(byId.get('moot-court')?.parallel).toBe(false)
    expect(byId.get('business-sim')?.rounds).toBe(true)
    expect(byId.get('business-sim')?.parallel).toBe(false)
    expect(byId.get('philosophy')?.rounds).toBe(true)
    expect(byId.get('philosophy')?.parallel).toBe(false)
    expect(byId.get('ecommerce')?.chain).toEqual(['category-scout', 'listing-optimizer', 'store-operator', 'shop-support'])
    expect(byId.get('academic')?.chain).toEqual(['lit-reviewer', 'methodologist', 'paper-editor', 'submit-advisor'])
    expect(byId.get('relationship')?.chain).toEqual(['rel-coach', 'date-coach', 'mediator'])
    expect(byId.get('tarot')?.defaultSkills).toEqual(['tarot-reading'])
    expect(byId.get('trpg')?.defaultSkills).toEqual(['trpg-hosting'])
  })

  it('M52-A/B stage 声明：M51 十场景形态齐备（arena 2 / roundtable 1 / dock 7）', () => {
    const lib = realLibrary()
    const byId = new Map(lib.groups().map((g) => [g.id, g]))
    // arena：席位分组完整（左 / 右 / 中）+ v68 parts 精细化声明（debate 无报价流 / negotiation 无计分板）
    expect(byId.get('debate')?.stage).toEqual({
      layout: 'arena',
      seats: { left: ['affirmative'], right: ['negative'], center: ['judge', 'evidence'] },
      parts: ['round-track', 'scoreboard', 'verdicts', 'cross-fire', 'claim-tree'],
    })
    expect(byId.get('negotiation')?.stage).toEqual({
      layout: 'arena',
      seats: { left: ['negotiator'], right: ['counterpart'], center: ['tactician'] },
      parts: ['round-track', 'verdicts', 'claim-tree', 'offers'],
    })
    // roundtable：汇聚板
    expect(byId.get('society')?.stage).toEqual({ layout: 'roundtable', panel: 'pool' })
    // dock：七场景面板声明（board ×3 / coach ×2 / chartboard ×2）
    expect(byId.get('gamedesign')?.stage).toEqual({ layout: 'dock', panel: 'board' })
    expect(byId.get('writing')?.stage).toEqual({ layout: 'dock', panel: 'board' })
    expect(byId.get('housing')?.stage).toEqual({ layout: 'dock', panel: 'board' })
    expect(byId.get('career')?.stage).toEqual({ layout: 'dock', panel: 'coach' })
    expect(byId.get('care')?.stage).toEqual({ layout: 'dock', panel: 'coach' })
    expect(byId.get('metaphysics')?.stage).toEqual({ layout: 'dock', panel: 'chartboard' })
    expect(byId.get('astrology')?.stage).toEqual({ layout: 'dock', panel: 'chartboard' })
    // stream 四场景保持未声明（缺省即 stream；M52-C 定稿）
    expect(byId.get('development')?.stage).toBeUndefined()
    expect(byId.get('finance')?.stage).toBeUndefined()
    expect(byId.get('ops')?.stage).toBeUndefined()
    expect(byId.get('home')?.stage).toBeUndefined()
  })

  it('M52-C 既有场景接入：14 场景声明合入（roundtable·pool ×3 / dock ×11）', () => {
    const lib = realLibrary()
    const byId = new Map(lib.groups().map((g) => [g.id, g]))
    // C1 研讨域：roundtable · pool（与 society 共用形态与面板）
    for (const id of ['brainstorm', 'research', 'strategy']) {
      expect(byId.get(id)?.stage).toEqual({ layout: 'roundtable', panel: 'pool' })
    }
    // C2 工作域：console ×5（sre / bi / marketing / sales / funding）+ versus ×1（invest）
    for (const id of ['sre', 'bi', 'marketing', 'sales', 'funding']) {
      expect(byId.get(id)?.stage).toEqual({ layout: 'dock', panel: 'console' })
    }
    expect(byId.get('invest')?.stage).toEqual({ layout: 'dock', panel: 'versus' })
    // M69：场景扩展二批十场景 stage 声明（dock ×6 / roundtable ×2 / arena ×2）
    expect(byId.get('ecommerce')?.stage).toEqual({ layout: 'dock', panel: 'console' })
    expect(byId.get('creator')?.stage).toEqual({ layout: 'dock', panel: 'board' })
    expect(byId.get('legal-personal')?.stage).toEqual({ layout: 'dock', panel: 'console' })
    expect(byId.get('academic')?.stage).toEqual({ layout: 'dock', panel: 'board' })
    expect(byId.get('relationship')?.stage).toEqual({ layout: 'dock', panel: 'coach' })
    expect(byId.get('trpg')?.stage).toEqual({ layout: 'roundtable', panel: 'pool' })
    expect(byId.get('tarot')?.stage).toEqual({ layout: 'dock', panel: 'chartboard' })
    expect(byId.get('moot-court')?.stage).toEqual({
      layout: 'arena',
      seats: { left: ['plaintiff-counsel'], right: ['defense-counsel'], center: ['presiding-judge'] },
      parts: ['round-track', 'claim-tree', 'verdicts'],
    })
    expect(byId.get('business-sim')?.stage).toEqual({
      layout: 'arena',
      seats: { left: ['sim-host'], right: ['market-referee'], center: ['review-coach'] },
      parts: ['round-track', 'scoreboard', 'verdicts'],
    })
    expect(byId.get('philosophy')?.stage).toEqual({ layout: 'roundtable', panel: 'pool' })
    // C3 生活域：coach ×5（health / learning / travel / wealth / personal）
    for (const id of ['health', 'learning', 'travel', 'wealth', 'personal']) {
      expect(byId.get(id)?.stage).toEqual({ layout: 'dock', panel: 'coach' })
    }
    // 全量总账：30 组（29 业务场景 + blank）中 25 组已声明，仅余 stream 四场景未声明（M65-A：+ interior）
    expect(lib.groups().filter((g) => g.stage)).toHaveLength(36)
  })

  it('165 个角色全量加载：新角色 tools / temperature / handoff 与资产一致', () => {
    const lib = realLibrary()
    expect(lib.list()).toHaveLength(165)
    // 编制链序：blank 场景（order 最小）居首（general），其次 strategy —— chief → strategist → pricing，场景内非链条目（insight）排后
    expect(
      lib
        .list()
        .slice(0, 4)
        .map((a) => a.id),
    ).toEqual(['general', 'chief', 'strategist', 'pricing'])

    const chief = lib.get('chief')
    expect(chief?.group).toBe('strategy')
    expect(chief?.name).toBe('柏川')
    expect(chief?.temperature).toBe(0.4)
    expect(chief?.handoff).toEqual(['strategist', 'growth', 'sales', 'finance'])
    expect(chief?.tools).toContain('date_calc')
    expect(chief?.skills).toEqual(['business-review', 'deck-authoring', 'report-authoring'])

    const finance = lib.get('finance')
    expect(finance?.group).toBe('finance')
    expect(finance?.tools).toContain('calc')
    expect(finance?.tools).toContain('csv_analyze')
    expect(finance?.tools).toContain('template_fill')
    expect(finance?.skills).toEqual(['financial-modeling', 'spreadsheet-modeling'])

    const legal = lib.get('legal')
    expect(legal?.skills).toEqual(['contract-review', 'formal-document'])
    expect(legal?.handoff).toEqual(['sales', 'finance', 'ops'])

    // v14 新角色抽样：生活场景 + 职能角色（handoff 白名单可达性）
    const fitness = lib.get('fitness')
    expect(fitness?.group).toBe('health')
    expect(fitness?.handoff).toEqual(['nutrition', 'wellness'])
    expect(fitness?.tools).toContain('date_calc')
    expect(fitness?.tools).toContain('handoff')

    const security = lib.get('security')
    expect(security?.group).toBe('development')
    expect(security?.skills).toEqual(['code-review', 'red-team', 'secure-coding'])

    const compliance = lib.get('compliance')
    expect(compliance?.group).toBe('finance')
    expect(compliance?.handoff).toEqual(['legal', 'finance', 'ops'])

    const bd = lib.get('bd')
    expect(bd?.group).toBe('sales')
    expect(bd?.skills).toEqual(['sales-outreach', 'deck-authoring'])

    // M51-A 新角色抽样：辩论场 + 谈判桌（handoff 可达性 / 技能预载 / 白名单）
    const affirmative = lib.get('affirmative')
    expect(affirmative?.group).toBe('debate')
    expect(affirmative?.handoff).toEqual(['negative', 'scout'])
    expect(affirmative?.skills).toEqual(['debate'])
    expect(affirmative?.tools).toContain('handoff')

    const judge = lib.get('judge')
    expect(judge?.group).toBe('debate')
    expect(judge?.handoff).toEqual(['affirmative', 'evidence', 'moderator'])
    expect(judge?.temperature).toBe(0.4)

    const negotiator = lib.get('negotiator')
    expect(negotiator?.group).toBe('negotiation')
    expect(negotiator?.handoff).toEqual(['legal', 'finance'])
    expect(negotiator?.skills).toEqual(['negotiation'])
    expect(negotiator?.tools).toContain('template_fill')

    const tactician = lib.get('tactician')
    expect(tactician?.group).toBe('negotiation')
    expect(tactician?.handoff).toEqual(['negotiator', 'comp-advisor'])

    // M51-B 新角色抽样：议题圆桌（handoff 可达性 / 技能预载 / 白名单）
    const moderator = lib.get('moderator')
    expect(moderator?.group).toBe('society')
    expect(moderator?.handoff).toEqual(['fact-checker', 'stakeholder', 'policy-advisor'])
    expect(moderator?.skills).toEqual(['formal-document'])
    expect(moderator?.tools).toContain('handoff')

    const factChecker = lib.get('fact-checker')
    expect(factChecker?.group).toBe('society')
    expect(factChecker?.handoff).toEqual(['stakeholder', 'moderator'])
    expect(factChecker?.skills).toEqual(['source-verification'])
    expect(factChecker?.tools).toContain('web_search')

    const stakeholder = lib.get('stakeholder')
    expect(stakeholder?.group).toBe('society')
    expect(stakeholder?.handoff).toEqual(['policy-advisor', 'moderator'])

    const policyAdvisor = lib.get('policy-advisor')
    expect(policyAdvisor?.group).toBe('society')
    expect(policyAdvisor?.handoff).toEqual(['moderator'])
    expect(policyAdvisor?.skills).toEqual(['formal-document'])

    // M51-C 新角色抽样：游戏工坊 / 创作工作室 / 职业发展（handoff 可达性 / 技能预载 / 白名单）
    const gameDesigner = lib.get('game-designer')
    expect(gameDesigner?.group).toBe('gamedesign')
    expect(gameDesigner?.handoff).toEqual(['balance-designer', 'narrative-designer', 'playtester'])
    expect(gameDesigner?.skills).toEqual(['game-design', 'doc-coauthoring'])
    expect(gameDesigner?.tools).toContain('handoff')

    const balanceDesigner = lib.get('balance-designer')
    expect(balanceDesigner?.group).toBe('gamedesign')
    expect(balanceDesigner?.skills).toEqual(['game-design', 'spreadsheet-modeling'])
    expect(balanceDesigner?.temperature).toBe(0.3)

    const author = lib.get('author')
    expect(author?.group).toBe('writing')
    expect(author?.temperature).toBe(0.7)

    const publisher = lib.get('publisher')
    expect(publisher?.group).toBe('writing')
    expect(publisher?.handoff).toEqual(['ip', 'pr'])
    expect(publisher?.skills).toEqual(['formal-document', 'deck-authoring'])

    const compAdvisor = lib.get('comp-advisor')
    expect(compAdvisor?.group).toBe('career')
    expect(compAdvisor?.handoff).toEqual(['negotiator', 'career-advisor'])
    expect(compAdvisor?.skills).toEqual(['negotiation', 'spreadsheet-modeling'])
    expect(compAdvisor?.tools).toContain('web_search')

    // M51-D 新角色抽样：置业安家 / 家庭照护（handoff 可达性 / 技能预载 / 白名单）
    const homeFinder = lib.get('home-finder')
    expect(homeFinder?.group).toBe('housing')
    expect(homeFinder?.handoff).toEqual(['mortgage-advisor', 'reno-designer'])
    expect(homeFinder?.skills).toEqual(['deep-research', 'spreadsheet-modeling'])
    expect(homeFinder?.tools).toContain('web_search')

    const mortgageAdvisor = lib.get('mortgage-advisor')
    expect(mortgageAdvisor?.group).toBe('housing')
    expect(mortgageAdvisor?.handoff).toEqual(['wealth', 'legal'])
    expect(mortgageAdvisor?.temperature).toBe(0.3)

    const renoDesigner = lib.get('reno-designer')
    expect(renoDesigner?.group).toBe('housing')
    expect(renoDesigner?.handoff).toEqual(['home-finder', 'mortgage-advisor'])

    const carePlanner = lib.get('care-planner')
    expect(carePlanner?.group).toBe('care')
    expect(carePlanner?.handoff).toEqual(['care-escort', 'elder-advisor'])
    expect(carePlanner?.skills).toEqual(['process-improvement', 'doc-coauthoring'])
    expect(carePlanner?.tools).toContain('handoff')

    const elderAdvisor = lib.get('elder-advisor')
    expect(elderAdvisor?.group).toBe('care')
    expect(elderAdvisor?.handoff).toEqual(['care-planner'])
    expect(elderAdvisor?.skills).toEqual(['source-verification', 'doc-coauthoring'])

    // M51-E 新角色抽样：传统数术 / 星象占星（handoff 可达性 / 跨场景衔接 / 技能预载 / 白名单）
    const bazi = lib.get('bazi')
    expect(bazi?.group).toBe('metaphysics')
    expect(bazi?.handoff).toEqual(['ziwei'])
    expect(bazi?.skills).toEqual(['chinese-metaphysics', 'data-visualization'])
    expect(bazi?.tools).toContain('bazi_pan')

    const qizheng = lib.get('qizheng')
    expect(qizheng?.group).toBe('metaphysics')
    expect(qizheng?.handoff).toEqual(['natal']) // 跨场景：七政四余 → 星盘
    expect(qizheng?.temperature).toBe(0.3)

    const qimen = lib.get('qimen')
    expect(qimen?.group).toBe('metaphysics')
    expect(qimen?.handoff).toEqual(['horary']) // 跨场景：奇门 → 择时

    const natal = lib.get('natal')
    expect(natal?.group).toBe('astrology')
    expect(natal?.handoff).toEqual(['transit', 'qizheng'])
    expect(natal?.skills).toEqual(['western-astrology', 'data-visualization'])

    const horary = lib.get('horary')
    expect(horary?.group).toBe('astrology')
    expect(horary?.handoff).toEqual(['natal'])
    expect(horary?.temperature).toBe(0.3)
  })

  it('M22 浏览器工具绑定：qa / frontend 白名单覆盖完整 browser_* 清单（可达性保障）', () => {
    const lib = realLibrary()
    const browserTools = [
      'browser_open',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_fill',
      'browser_press',
      'browser_scroll',
      'browser_wait',
      'browser_screenshot',
      'browser_console',
      'browser_eval',
      'browser_close',
      'browser_request_human',
    ]
    for (const id of ['qa', 'frontend']) {
      const agent = lib.get(id)
      for (const tool of browserTools) {
        expect(agent?.tools, `${id} 缺少 ${tool}`).toContain(tool)
      }
    }
  })

  it('M22 / M23 数据库与 SSH 工具绑定：backend / devops 白名单覆盖（可达性保障）', () => {
    const lib = realLibrary()
    for (const tool of ['db_list_connections', 'db_schema', 'db_query', 'db_execute']) {
      expect(lib.get('backend')?.tools, `backend 缺少 ${tool}`).toContain(tool)
    }
    expect(lib.get('devops')?.tools, 'devops 缺少 ssh_exec').toContain('ssh_exec')
  })

  it('M34 投研工具绑定：invest 5 角色 fin_* 白名单覆盖（可达性保障）', () => {
    const lib = realLibrary()
    const allFin = [
      'fin_env',
      'fin_search',
      'fin_quote',
      'fin_kline',
      'fin_indicator',
      'fin_fundamental',
      'fin_fund',
      'fin_news',
      'fin_screen',
      'fin_watch',
      'fin_backtest',
      'fin_game',
    ]
    // 主管持全量 12 个；四路按职责取子集
    for (const tool of allFin) {
      expect(lib.get('invest-lead')?.tools, `invest-lead 缺少 ${tool}`).toContain(tool)
    }
    expect(lib.get('analyst-fa')?.tools).toEqual(
      expect.arrayContaining(['fin_env', 'fin_search', 'fin_quote', 'fin_kline', 'fin_fundamental', 'fin_fund', 'fin_news']),
    )
    expect(lib.get('analyst-ta')?.tools).toEqual(
      expect.arrayContaining(['fin_env', 'fin_search', 'fin_quote', 'fin_kline', 'fin_indicator', 'fin_news']),
    )
    expect(lib.get('quant')?.tools).toEqual(
      expect.arrayContaining(['fin_env', 'fin_search', 'fin_quote', 'fin_kline', 'fin_indicator', 'fin_backtest', 'fin_screen', 'fin_fund', 'fin_game']),
    )
    expect(lib.get('analyst-news')?.tools).toEqual(expect.arrayContaining(['fin_env', 'fin_search', 'fin_quote', 'fin_news']))
    // 四路不持有回测 / 博弈（职责边界：策略与推演归 quant）
    expect(lib.get('analyst-ta')?.tools).not.toContain('fin_backtest')
    expect(lib.get('analyst-fa')?.tools).not.toContain('fin_game')
    // 技能预载
    expect(lib.get('analyst-fa')?.skills).toEqual(['fundamental-analysis', 'report-authoring'])
    expect(lib.get('analyst-ta')?.skills).toEqual(['technical-analysis', 'report-authoring'])
    expect(lib.get('analyst-news')?.skills).toEqual(['market-news-analysis', 'report-authoring'])
    expect(lib.get('quant')?.skills).toEqual(['investment-strategy', 'game-theory-trading', 'report-authoring'])
    // 协作基线：全部含 handoff（结构化转交为第一通道）
    for (const id of ['invest-lead', 'analyst-fa', 'analyst-ta', 'analyst-news', 'quant']) {
      expect(lib.get(id)?.tools, `${id} 缺少 handoff`).toContain('handoff')
    }
  })

  it('M51-E 排盘工具绑定：metaphysics / astrology 全量角色四件套白名单覆盖（可达性保障）', () => {
    const lib = realLibrary()
    const panTools = ['bazi_pan', 'ziwei_pan', 'natal_pan', 'gua_pan']
    for (const group of ['metaphysics', 'astrology']) {
      for (const agent of lib.list().filter((a) => a.group === group)) {
        for (const tool of panTools) {
          expect(agent.tools, `${agent.id} 缺少 ${tool}`).toContain(tool)
        }
        expect(agent.tools, `${agent.id} 缺少 handoff`).toContain('handoff')
      }
    }
  })

  it('技能预载：marketing 成员显式配置（group defaultSkills 仅作兜底）', () => {
    const lib = realLibrary()
    expect(lib.get('growth')?.skills).toEqual(['content-marketing', 'spreadsheet-modeling'])
    expect(lib.get('content')?.skills).toEqual(['content-marketing', 'doc-coauthoring', 'natural-writing'])
    expect(lib.get('seo')?.skills).toEqual(['content-marketing', 'seo-optimizer'])
    expect(lib.get('brand')?.skills).toEqual(['brand-system', 'visual-design', 'brand-naming'])
    expect(lib.get('ads')?.skills).toEqual(['content-marketing', 'spreadsheet-modeling'])
    expect(lib.get('localizer')?.skills).toEqual(['doc-coauthoring', 'comms-writing', 'translation-quality'])
  })

  it('场景协议：strategy / finance / bi / sre / invest / sales / debate / negotiation / society / writing / career / gamedesign / housing / care / metaphysics / astrology 有专属协议', () => {
    const lib = realLibrary()
    expect(lib.groupProtocol('strategy')).toContain('决策留痕')
    expect(lib.groupProtocol('finance')).toContain('合规红线')
    expect(lib.groupProtocol('bi')).toContain('口径先行')
    expect(lib.groupProtocol('sre')).toContain('止血')
    expect(lib.groupProtocol('invest')).toContain('数据可溯')
    expect(lib.groupProtocol('sales')).toContain('报价纪律')
    expect(lib.groupProtocol('debate')).toContain('观点与证据分离')
    expect(lib.groupProtocol('negotiation')).toContain('BATNA')
    expect(lib.groupProtocol('society')).toContain('议题边界')
    expect(lib.groupProtocol('writing')).toContain('原创底线')
    expect(lib.groupProtocol('career')).toContain('履历真实')
    expect(lib.groupProtocol('gamedesign')).toContain('核心循环先行')
    expect(lib.groupProtocol('housing')).toContain('预算纪律')
    expect(lib.groupProtocol('care')).toContain('非医疗诊断')
    expect(lib.groupProtocol('metaphysics')).toContain('表述纪律')
    expect(lib.groupProtocol('astrology')).toContain('参考区间')
  })

  it('validate()：真实资产无语义问题（handoff / chain / presets 引用全部成立）', () => {
    const lib = realLibrary()
    expect(lib.validate()).toEqual([])
  })
})

// ---------- 合成目录：缺省与非法预设 ----------

const AGENT_MD = (id: string, name: string): string => `---
id: ${id}
name: ${name}
role: 测试角色
handoff: []
---

我是 ${name}。
`

function scaffold(): { agentsDir: string; promptsDir: string } {
  const root = makeTmpDir('ma-m21-')
  const agentsDir = path.join(root, 'agents')
  fs.mkdirSync(path.join(agentsDir, 'core'), { recursive: true })
  fs.writeFileSync(path.join(agentsDir, '_protocol.md'), '# 全局协议\n')
  fs.writeFileSync(path.join(agentsDir, 'core', '_group.yaml'), 'id: core\nname: 核心\nchain: [a1, a2]\n')
  for (const [id, name] of [
    ['a1', '甲一'],
    ['a2', '乙二'],
  ] as const) {
    fs.mkdirSync(path.join(agentsDir, 'core', id), { recursive: true })
    fs.writeFileSync(path.join(agentsDir, 'core', id, 'AGENT.md'), AGENT_MD(id, name))
  }
  return { agentsDir, promptsDir: path.join(root, 'prompts') }
}

function lib(s: { agentsDir: string; promptsDir: string }): PromptLibrary {
  return new PromptLibrary({ agentsDir: s.agentsDir, promptsDir: s.promptsDir, onWarn: () => {} })
}

function writePresets(s: { agentsDir: string }, yaml: string): void {
  fs.writeFileSync(path.join(s.agentsDir, '_presets.yaml'), yaml)
}

describe('M21：快速组队预设（_presets.yaml）', () => {
  it('真实预设：33 条按 order 排序，成员引用全部存在且 prompt 可预填', () => {
    const lib = realLibrary()
    const presets = lib.presets()
    expect(presets.map((p) => p.id)).toEqual([
      'weekly-review',
      'content-campaign',
      'product-launch',
      'tax-season',
      'funding-round',
      'hiring-outsourcing',
      'health-sprint',
      'learning-season',
      'trip-planning',
      'growth-localization',
      'data-briefing',
      'incident-response',
      'invest-review',
      'strategy-research',
      'bull-bear-duel',
      'classic-debate',
      'negotiation-rehearsal',
      'issue-roundtable',
      'writing-sprint',
      'job-hunt-sprint',
      'game-kickoff',
      'home-purchase',
      'care-plan',
      'chart-combo',
      'oracle-crossread',
      'full-horoscope',
      'home-makeover',
      'startup-launch',
      'career-pivot',
      'annual-review',
      'ecommerce-growth',
      'content-monetize',
      'move-in-check',
    ])
    const makeover = presets.find((p) => p.id === 'home-makeover')
    expect(makeover?.members).toEqual(['interior-designer', 'space-planner', 'visualizer'])
    const moveIn = presets.find((p) => p.id === 'move-in-check')
    expect(moveIn?.members).toEqual(['plan-surveyor', 'yangzhai-master', 'reno-designer'])
    const startup = presets.find((p) => p.id === 'startup-launch')
    expect(startup?.members).toEqual(['chief', 'finance', 'legal', 'growth', 'pm'])
    const monetize = presets.find((p) => p.id === 'content-monetize')
    expect(monetize?.members).toEqual(['account-strategist', 'script-writer', 'monetizer', 'finance'])
    const weekly = presets.find((p) => p.id === 'weekly-review')
    expect(weekly?.members).toEqual(['chief', 'finance', 'growth', 'sales'])
    expect(weekly?.prompt).toContain('@')
    const classicDebate = presets.find((p) => p.id === 'classic-debate')
    expect(classicDebate?.members).toEqual(['judge', 'affirmative', 'negative', 'evidence'])
    const rehearsal = presets.find((p) => p.id === 'negotiation-rehearsal')
    expect(rehearsal?.members).toEqual(['tactician', 'negotiator', 'counterpart'])
    const issueRoundtable = presets.find((p) => p.id === 'issue-roundtable')
    expect(issueRoundtable?.members).toEqual(['moderator', 'fact-checker', 'stakeholder', 'policy-advisor'])
    const writingSprint = presets.find((p) => p.id === 'writing-sprint')
    expect(writingSprint?.members).toEqual(['storyline', 'author', 'editor'])
    const jobHunt = presets.find((p) => p.id === 'job-hunt-sprint')
    expect(jobHunt?.members).toEqual(['career-advisor', 'resume-coach', 'interview-coach', 'comp-advisor'])
    const gameKickoff = presets.find((p) => p.id === 'game-kickoff')
    expect(gameKickoff?.members).toEqual(['game-designer', 'balance-designer', 'narrative-designer', 'playtester'])
    const homePurchase = presets.find((p) => p.id === 'home-purchase')
    expect(homePurchase?.members).toEqual(['home-finder', 'mortgage-advisor', 'reno-designer'])
    const carePlan = presets.find((p) => p.id === 'care-plan')
    expect(carePlan?.members).toEqual(['care-planner', 'care-escort', 'elder-advisor'])
    const chartCombo = presets.find((p) => p.id === 'chart-combo')
    expect(chartCombo?.members).toEqual(['bazi', 'ziwei'])
    const oracleCrossread = presets.find((p) => p.id === 'oracle-crossread')
    expect(oracleCrossread?.members).toEqual(['liuyao', 'meihua'])
    const fullHoroscope = presets.find((p) => p.id === 'full-horoscope')
    expect(fullHoroscope?.members).toEqual(['natal', 'transit', 'synastry'])
    for (const preset of presets) {
      expect(preset.members.length).toBeGreaterThanOrEqual(2)
      expect(preset.prompt.trim().length).toBeGreaterThan(0)
      for (const member of preset.members) expect(lib.get(member)).toBeDefined()
    }
  })

  it('缺失 _presets.yaml：presets() 为空数组，validate() 不报问题', () => {
    const s = scaffold()
    const l = lib(s)
    expect(l.presets()).toEqual([])
    expect(l.validate()).toEqual([])
  })

  it('order 升序排序 + 缺省字段回退（theme / icon / prompt）', () => {
    const s = scaffold()
    writePresets(
      s,
      `presets:
  - id: late
    name: 后位
    members: [a1]
    order: 30
  - id: early
    name: 前位
    members: [a2, a1]
    order: 10
`,
    )
    const l = lib(s)
    const presets = l.presets()
    expect(presets.map((p) => p.id)).toEqual(['early', 'late'])
    expect(presets[0]?.theme).toEqual(['#6366f1', '#818cf8'])
    expect(presets[0]?.icon).toBe('users')
    expect(presets[0]?.prompt).toBe('')
  })

  it('成员引用不存在角色：validate() 报告语义问题（加载不崩）', () => {
    const s = scaffold()
    writePresets(
      s,
      `presets:
  - id: bad-preset
    name: 坏预设
    members: [a1, ghost]
`,
    )
    const l = lib(s)
    expect(l.presets()).toHaveLength(1)
    const problems = l.validate()
    expect(problems.some((p) => p.includes('bad-preset') && p.includes('ghost'))).toBe(true)
  })

  it('M52-A stage.seats 引用不存在角色：validate() 报告语义问题（加载不崩）', () => {
    const s = scaffold()
    fs.writeFileSync(
      path.join(s.agentsDir, 'core', '_group.yaml'),
      'id: core\nname: 核心\nchain: [a1, a2]\nstage:\n  layout: arena\n  seats:\n    left: [a1]\n    right: [ghost]\n',
    )
    const l = lib(s)
    expect(l.groups()[0]?.stage?.layout).toBe('arena')
    const problems = l.validate()
    expect(problems.some((p) => p.includes('stage.seats') && p.includes('ghost'))).toBe(true)
  })

  it('预设 id 重复：加载即报错（全局唯一）', () => {
    const s = scaffold()
    writePresets(
      s,
      `presets:
  - id: dup
    name: 甲
    members: [a1]
  - id: dup
    name: 乙
    members: [a2]
`,
    )
    expect(() => lib(s)).toThrowError(/重复/)
  })

  it('members 为空数组：schema 校验报错', () => {
    const s = scaffold()
    writePresets(
      s,
      `presets:
  - id: empty
    name: 空编制
    members: []
`,
    )
    expect(() => lib(s)).toThrowError(/members 不能为空/)
  })

  it('YAML 解析失败：加载即报错（不静默吞掉）', () => {
    const s = scaffold()
    writePresets(s, 'presets: [')
    expect(() => lib(s)).toThrowError(/YAML 解析失败/)
  })
})
