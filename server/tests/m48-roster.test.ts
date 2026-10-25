/**
 * M48：召集内核（inviteMembersCore）与可召集目录（roster_catalog）——调度平台化的落库链路。
 *
 * M46 的 invite_members 工具与「调度官召集端到端」已随角色撤销（覆盖迁移至 m48-routing.test.ts：
 * PRS 组队派发 / 未在场 handoff 自动增援）；本套件保留：
 * - 内核矩阵：成功（编制链排序 + 「召集了」事件条 + notify:members-changed）/ 幂等 / 未知 id /
 *   场景整链 / 场景不存在 / 单次上限；
 * - roster_catalog：只列未在场角色（场景行 + 角色行）/ 实时收缩 / 全员在场返回空串；
 * - 成员回合指令：未在场协作引导（handoff → 平台自动召集），范式模板零变化。
 */
import { describe, expect, it } from 'vitest'
import { buildTurnInstruction } from '../src/context/assembler.js'
import { buildRosterCatalogBlock } from '../src/orchestration/roster-catalog.js'
import { inviteMembersCore, INVITE_MAX_MEMBERS } from '../src/tools/roster.js'
import { makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

const coreDeps = (env: Env): Parameters<typeof inviteMembersCore>[0] => ({
  sessions: env.sessions,
  prompts: env.prompts,
  notify: env.notify,
})

const nameOf = (env: Env, id: string): string => env.prompts.get(id)?.name ?? id

// ---------- 内核矩阵 ----------

describe('M48：inviteMembersCore', () => {
  it('成功召集：编制链排序 + 「召集了」事件条 + notify:members-changed', () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief'], 'M48 内核')
    const before = env.published.length
    const result = inviteMembersCore(coreDeps(env), {
      sessionId: session.id,
      agentIds: ['qa', 'backend'],
      reason: '需要开发与验证',
      verb: '召集了',
      actorName: '平台',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    // 同批按编制链（development: pm → architect → designer → frontend → backend → qa → devops）
    expect(result.added).toEqual(['backend', 'qa'])
    expect(result.already).toEqual([])
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['chief', 'backend', 'qa'])
    const event = env.sessions.messages(session.id).find((m) => m.role === 'system')
    expect(event?.content).toBe(
      `平台 召集了 ${nameOf(env, 'backend')}、${nameOf(env, 'qa')} 加入协作（需要开发与验证）`,
    )
    const broadcast = env.published.slice(before).find((n) => n.type === 'notify:members-changed')
    expect(broadcast).toBeTruthy()
    expect((broadcast?.payload.session as { participantIds: string[] }).participantIds).toEqual([
      'chief',
      'backend',
      'qa',
    ])
  })

  it('幂等：已在场成员自动跳过（added 空 + 不落事件条 / 不广播）', () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief', 'backend'], 'M48 幂等')
    const messagesBefore = env.sessions.messages(session.id).length
    const publishedBefore = env.published.length
    const result = inviteMembersCore(coreDeps(env), {
      sessionId: session.id,
      agentIds: ['backend'],
      verb: '召集了',
      actorName: '平台',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toEqual([])
    expect(result.already).toEqual(['backend'])
    expect(env.sessions.messages(session.id).length).toBe(messagesBefore)
    expect(env.published.length).toBe(publishedBefore)
  })

  it('未知 id → ok:false + unknown 列表；状态零变化', () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief'], 'M48 未知')
    const result = inviteMembersCore(coreDeps(env), { sessionId: session.id, agentIds: ['nope'] })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('角色不存在：nope')
    expect(result.unknown).toEqual(['nope'])
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['chief'])
  })

  it('sceneId 整链召集：chain 全量加入（去重去已在场）', () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief'], 'M48 整链')
    const chain = env.prompts.groups().find((g) => g.id === 'development')?.chain ?? []
    expect(chain.length).toBeGreaterThan(3)

    const result = inviteMembersCore(coreDeps(env), {
      sessionId: session.id,
      sceneId: 'development',
      agentIds: ['pm'], // 与 sceneId 并用：pm 去重后不重复追加
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect([...result.added].sort()).toEqual([...chain].sort())
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['chief', ...result.added])
  })

  it('sceneId 不存在 → 列出可用场景 id', () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief'], 'M48 场景缺失')
    const result = inviteMembersCore(coreDeps(env), { sessionId: session.id, sceneId: 'nope' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('场景「nope」不存在')
    expect(result.error).toContain('development')
  })

  it(`单次上限：解析后新增 > ${INVITE_MAX_MEMBERS} 位 → 拒绝并提示分批`, () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief'], 'M48 上限')
    const ids = env.prompts
      .list()
      .map((a) => a.id)
      .filter((id) => id !== 'chief')
      .slice(0, INVITE_MAX_MEMBERS + 1)
    expect(ids.length).toBe(INVITE_MAX_MEMBERS + 1)

    const result = inviteMembersCore(coreDeps(env), { sessionId: session.id, agentIds: ids })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('请分批召集')
    expect(env.sessions.getSession(session.id)?.participantIds).toEqual(['chief'])
  })
})

// ---------- roster_catalog ----------

describe('M48：roster_catalog（可召集角色目录，PRS 输入）', () => {
  it('只列未在场角色：场景行（objective + 编制链）+ 角色行；已在场不重复列出', () => {
    const env = makeEnv()
    const block = buildRosterCatalogBlock(env.prompts, ['chief'])

    expect(block).toContain('<roster_catalog>')
    expect(block).toContain('</roster_catalog>')
    expect(block).toContain(`${nameOf(env, 'chief')}(chief)`)
    expect(block).toContain('## 研发团队 development')
    expect(block).toContain('objective：把用户需求打磨成可落地、可验收的研发交付件')
    expect(block).toContain('编制：pm → architect → designer → frontend → backend → qa → devops')
    expect(block).toContain(`- backend ${nameOf(env, 'backend')} · `)
    expect(block).not.toContain('- chief ')
  })

  it('在场成员变更 → 目录实时收缩（召集后不再列出）', () => {
    const env = makeEnv()
    const before = buildRosterCatalogBlock(env.prompts, ['chief'])
    const after = buildRosterCatalogBlock(env.prompts, ['chief', 'backend'])

    expect(before).toContain('- backend ')
    expect(after).not.toContain('- backend ')
    expect(after).toContain(`${nameOf(env, 'backend')}(backend)`)
  })

  it('全员在场 / 空库 → 空串（不注入）', () => {
    const env = makeEnv()
    const all = env.prompts.list().map((a) => a.id)
    expect(buildRosterCatalogBlock(env.prompts, all)).toBe('')
  })
})

describe('目录缓存展示输入', () => {
  const agents = [
    { id: 'pm', name: '产品', role: '产品', description: '', group: 'dev' },
    { id: 'qa', name: '测试', role: '测试', description: '', group: 'dev' },
    { id: 'backend', name: '后端', role: '后端', description: '', group: 'dev' },
  ]
  const prompts = {
    list: () => agents,
    groups: () => [{ id: 'dev', name: '研发', objective: '', chain: ['pm', 'qa', 'backend'] }],
    get: (id: string) => agents.find((a) => a.id === id),
  } as unknown as Parameters<typeof buildRosterCatalogBlock>[0]

  it('展示标签改变时不复用旧标签，成员顺序也是缓存输入', () => {
    const first = buildRosterCatalogBlock(prompts, ['pm', 'qa'], { pm: '产品甲' })
    const second = buildRosterCatalogBlock(prompts, ['pm', 'qa'], { pm: '产品乙' })
    expect(first).toContain('产品甲(pm)')
    expect(second).toContain('产品乙(pm)')
    expect(second).not.toContain('产品甲')
    const reversed = buildRosterCatalogBlock(prompts, ['qa', 'pm'], { pm: '产品乙' })
    expect(reversed).toContain('测试(qa)、产品乙(pm)')
    expect(buildRosterCatalogBlock(prompts, ['qa', 'pm'], { pm: '产品乙' })).toBe(reversed)
  })
})

// ---------- 成员回合指令 ----------

describe('M48：成员回合指令（buildTurnInstruction）', () => {
  const instruction = (env: Env, agentId: string, mode: 'execute' | 'plan' | 'review' = 'execute') =>
    buildTurnInstruction(env.prompts.get(agentId)!, env.prompts.list(), [], [], mode, {})

  it('execute 回合：未在场协作引导 = handoff（平台自动召集）；无调度官痕迹', () => {
    const env = makeEnv()
    const execute = instruction(env, 'backend')

    expect(execute).toContain('现在轮到你（')
    expect(execute).toContain('需要暂时不在场的角色协作时，直接 handoff 该角色（平台会自动召集后接手）')
    expect(execute).not.toContain('【开场调度】')
    expect(execute).not.toContain('invite_members')
  })

  it('范式模板零变化：plan / review 不吃成员分支（无未在场引导行）', () => {
    const env = makeEnv()
    const plan = instruction(env, 'backend', 'plan')
    expect(plan).toContain('以规划范式发言')
    expect(plan).not.toContain('暂时不在场')
    const review = instruction(env, 'backend', 'review')
    expect(review).toContain('以评审范式发言')
    expect(review).not.toContain('暂时不在场')
  })

  it('三范式回合指令统一声明输出语言纪律（简体中文）', () => {
    const env = makeEnv()
    for (const mode of ['execute', 'plan', 'review'] as const) {
      expect(instruction(env, 'backend', mode)).toContain('全程使用简体中文输出')
    }
  })
})
