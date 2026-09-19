/**
 * M42（§71）：圆桌例会链路（mock）——主持人开场声明 / 议题推进回标 / 收尾回交主持人 / 纪要。
 * 与 eval opc-weekly-review 同构：串行 5 波（turns_lte 5 临界）；容器块由 remark-ext / scene 派生两侧同构解析。
 * 覆盖 strategy（chief 主持）与 brainstorm（facilitator 主持）两种例会形态；非例会消息不产出会议容器（回归）。
 */
import { describe, expect, it } from 'vitest'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

function lastTurn(agents: Array<{ turnIndex?: number }>): number {
  return Math.max(...agents.map((m) => m.turnIndex ?? 0)) + 1
}

describe('M42 圆桌例会链路（mock）', () => {
  it('OPC 周经营例会（串行）：开场声明 → 逐项回标 → 回交主持人 → 纪要 → 交还用户（5 波）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief', 'finance', 'growth', 'sales'], 'M42 例会')
    const user = appendUserMessage(
      env,
      session.id,
      '主持本周经营例会：幕僚长开场定议程，财务给出测算与口径，增长汇报指标与实验结论，销售更新重点客户与回款风险，最后收敛为经营简报与下周优先级。',
    )
    const { runId } = env.engine.launch(session.id, user.id)
    await waitRunFinished(env.engine, runId)

    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    // 链路序：chief（开场）→ growth → finance → sales（回交）→ chief（纪要）= 5 波（eval turns_lte 5 临界）
    expect(agents.map((m) => m.agentId)).toEqual(['chief', 'growth', 'finance', 'sales', 'chief'])
    expect(lastTurn(agents)).toBe(5)

    // 开场声明：会议容器 + 四项议题 + 转交 growth
    const opening = agents[0]!.content
    expect(opening).toContain('::: meeting 本周经营例会')
    for (const item of ['增长复盘：渠道与内容', '财务盘点：回款与成本', '客户与回款：重点跟进', '经营简报：优先级与下周动作']) {
      expect(opening).toContain(`- ${item}`)
    }
    expect(opening).toContain('@高扬 接力棒给你了。')

    // 议题推进回标（容器更新：后声明显式态覆盖）
    expect(agents[1]!.content).toContain('- [x] 增长复盘：渠道与内容')
    expect(agents[2]!.content).toContain('- [x] 财务盘点：回款与成本')
    expect(agents[3]!.content).toContain('- [x] 客户与回款：重点跟进')

    // 收尾回交主持人（非主持人全体议毕）
    expect(agents[3]!.content).toContain('@柏川 议题都过完了，请主持收尾并出纪要。')
    expect(agents[3]!.mentions).toContain('chief')

    // 纪要：三栏 + 待办派活（动态 owner）+ 自己议题回标 + 交还用户
    const tail = agents[4]!.content
    expect(tail).toContain('::: minutes 本周经营例会纪要')
    expect(tail).toContain('- [x] 经营简报：优先级与下周动作')
    expect(tail).toContain('- 决议 | ')
    expect(tail).toContain('- 待办 | @周正 按本周结论更新执行排期并同步工作区')
    expect(tail).toContain('- 待办 | @高扬 补齐数据口径说明与风险备注')
    expect(tail).toContain('- 风险 | ')
    expect(tail).toContain('@用户 ')
    // 收尾仅一次纪要（历史扫描去重）
    expect(tail.match(/:::[ \t]*minutes/g)).toHaveLength(1)
  })

  it('头脑风暴圆桌（facilitator 主持）：开场声明 → 三阶段回标 → 回交 → 圆桌纪要', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['facilitator', 'ideator', 'challenger', 'refiner'], 'M42 圆桌')
    const user = appendUserMessage(env, session.id, '开个例会，把本周的推广方案收敛一下。')
    const { runId } = env.engine.launch(session.id, user.id)
    await waitRunFinished(env.engine, runId)

    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['facilitator', 'ideator', 'challenger', 'refiner', 'facilitator'])
    expect(lastTurn(agents)).toBe(5)

    expect(agents[0]!.content).toContain('::: meeting 议题圆桌')
    expect(agents[0]!.content).toContain('- 方案发散：先量后质')
    expect(agents[1]!.content).toContain('- [x] 方案发散：先量后质')
    expect(agents[2]!.content).toContain('- [x] 红队挑刺：找最弱环节')
    expect(agents[3]!.content).toContain('- [x] 收敛方案：最小可行版')
    expect(agents[3]!.content).toContain('@梅森 议题都过完了，请主持收尾并出纪要。')
    expect(agents[4]!.content).toContain('::: minutes 议题圆桌纪要')
    expect(agents[4]!.content).toContain('- [x] 圆桌纪要：收口与行动项')
  })

  it('非例会消息（回归）：不产出会议容器，普通接力链不变', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['chief', 'growth'], 'M42 回归')
    const user = appendUserMessage(env, session.id, '帮我把增长实验的优先级捋一遍，给个取舍建议。')
    const { runId } = env.engine.launch(session.id, user.id)
    await waitRunFinished(env.engine, runId)

    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['chief', 'growth'])
    for (const m of agents) {
      expect(m.content).not.toContain('::: meeting')
      expect(m.content).not.toContain('::: minutes')
    }
    expect(agents[0]!.content).toContain('@高扬 接力棒给你了。')
  })
})
