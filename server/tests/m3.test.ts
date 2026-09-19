/**
 * M3 编排可靠性测试：会话级互斥与插话 / 结构化 handoff / 任务落盘 /
 * 内容级循环检测 / thinking 状态 / Run 持久化与断点恢复。
 */
import { describe, expect, it } from 'vitest'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import { detectContentLoop, trigramDice } from '../src/orchestration/scheduler.js'
import { RunStore } from '../src/store/runs.js'
import { appendUserMessage, makeEnv, sendAndWait, waitRunFinished } from './helpers.js'

type ProbeScript = (req: ChatRequest, round: number) => LlmChunk[]

/** 高相似文本基座：差异仅尾部的 @ 目标（差异占比 <8%，Dice > 0.9） */
const LOOP_BASE = '正在按计划推进当前任务，'.repeat(10) + '。请'

/** 探针 Provider：按脚本分轮产出（零延时），记录每次请求 */
function probeScript(
  env: ReturnType<typeof makeEnv>,
  script: ProbeScript,
): { requests: ChatRequest[] } {
  const requests: ChatRequest[] = []
  let round = 0
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req: ChatRequest) {
    requests.push(req)
    const chunks = script(req, round)
    round++
    for (const chunk of chunks) yield chunk
  }
  return { requests }
}

function toolCall(id: string, name: string, args: Record<string, unknown>): LlmChunk {
  return { type: 'tool_calls', calls: [{ id, name, arguments: JSON.stringify(args) }] }
}

describe('M3：会话级互斥与插话', () => {
  it('同会话连发两条 → 只 1 个 Run + 1 条插话，且插话在下一回合被模型看到', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    const { requests } = probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          { type: 'text', text: '第一版方案完成，请 @architect 评估。' },
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: '已收到补充说明，进入下一阶段。\n@用户' }, { type: 'done' }]
    })

    const m1 = appendUserMessage(env, session.id, '做一个登录页 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)
    // 运行中再发送 → 插话（同一 Run）
    const m2 = appendUserMessage(env, session.id, '补充：支持短信验证码')
    const injected = env.engine.inject(session.id, m2.id)
    expect(injected.injected).toBe(true)
    expect(injected.runId).toBe(runId)
    expect(injected.position).toBe(1)

    // 插话同步落盘（runs.pending_user_messages）
    const row = env.db.get<{ pending_user_messages: string }>(
      'SELECT pending_user_messages FROM runs WHERE id = ?',
      runId,
    )
    expect(JSON.parse(row!.pending_user_messages)).toEqual([m2.id])

    await waitRunFinished(env.engine, runId)

    // 只产生 1 个 Run
    expect(env.published.filter((n) => n.type === 'notify:run-started')).toHaveLength(1)
    // 第二回合（architect）的请求里能看到插话原文
    expect(requests.length).toBe(2)
    const secondMessages = requests[1].messages.map((m) => m.content).join('\n')
    expect(secondMessages).toContain('补充：支持短信验证码')
    // 消费后插话队列清空且落盘
    const after = env.db.get<{ pending_user_messages: string }>(
      'SELECT pending_user_messages FROM runs WHERE id = ?',
      runId,
    )
    expect(JSON.parse(after!.pending_user_messages)).toEqual([])
  })

  it('运行中再启动 → launch 抛错（互斥守卫）；结束后可正常新建 Run', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])

    const m1 = appendUserMessage(env, session.id, '开始 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)
    const m2 = appendUserMessage(env, session.id, '再发一条')
    expect(() => env.engine.launch(session.id, m2.id)).toThrow('会话已有运行中的任务')
    expect(env.engine.activeRunOf(session.id)?.runId).toBe(runId)

    await waitRunFinished(env.engine, runId)
    expect(env.engine.activeRunOf(session.id)).toBeUndefined()

    const m3 = appendUserMessage(env, session.id, '第二轮 @pm')
    const second = env.engine.launch(session.id, m3.id)
    await waitRunFinished(env.engine, second.runId)
    expect(env.published.filter((n) => n.type === 'notify:run-started')).toHaveLength(2)
  })

  it('插话发生在收尾边界（队列已空）→ 按交接链补充接手人，Run 延续', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    const { requests } = probeScript(env, (_req, round) => {
      if (round === 0) {
        // 第一回合直接交还用户 → 队列清空
        return [{ type: 'text', text: '初版完成。\n@用户' }, { type: 'done' }]
      }
      return [{ type: 'text', text: '已按补充说明修订。\n@用户' }, { type: 'done' }]
    })

    const m1 = appendUserMessage(env, session.id, '先做初版 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)
    const m2 = appendUserMessage(env, session.id, '插话：把按钮改成主色')
    env.engine.inject(session.id, m2.id)

    await waitRunFinished(env.engine, runId)
    // Run 被插话延长：第二回合由未发言的 architect 接手
    expect(requests.length).toBe(2)
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'architect'])
    expect(requests[1].messages.map((m) => m.content).join('\n')).toContain('把按钮改成主色')
  })
})

describe('M3：结构化 handoff（工具优先）', () => {
  it('handoff 到在场成员 → 该成员接手（工具形式，正文无 @）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          { type: 'text', text: '方案就绪，交给架构师。' },
          toolCall('c1', 'handoff', { target: 'architect', reason: '需要架构评估' }),
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: '架构评估完成。\n@用户' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'architect'])
    // 转交被记为工具调用（tool 卡可见）
    expect(agents[0].toolCalls?.some((c) => c.name === 'handoff' && c.status === 'ok')).toBe(true)
    expect(env.published.some((n) => n.type === 'notify:awaiting-user')).toBe(true)
  })

  it('handoff 完全未知目标 → 错误回灌让模型重选（资产存在未在场改走自动召集，见 M48）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    const { requests } = probeScript(env, (_req, round) => {
      if (round === 0) {
        return [toolCall('c1', 'handoff', { target: '运维官', reason: '需要运维' }), { type: 'done' }]
      }
      if (round === 1) {
        return [toolCall('c2', 'handoff', { target: 'architect', reason: '架构评估' }), { type: 'done' }]
      }
      return [{ type: 'text', text: '评估完成。\n@用户' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    // 第二步请求中回灌了「不在场」错误
    const toolMsg = requests[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg?.content).toContain('不在场')
    // 重选后成功：architect 接手并收尾
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'architect'])
  })

  it('handoff(user) → 交还用户并收尾', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          { type: 'text', text: '本轮到此为止，请确认。' },
          toolCall('c1', 'handoff', { target: 'user', reason: '等待用户确认' }),
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: '（等待确认）' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    const agentMsg = env.sessions.messages(session.id).find((m) => m.role === 'agent')!
    expect(agentMsg.mentions).toEqual(['user'])
    expect(env.published.some((n) => n.type === 'notify:awaiting-user')).toBe(true)
  })

  it('HANDOFF_MODE=text：忽略工具、以文本 @ 为准', async () => {
    const env = makeEnv({ handoffMode: 'text' })
    const session = env.sessions.create(['pm', 'architect', 'designer'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          { type: 'text', text: '交给 @designer 出视觉稿。' },
          toolCall('c1', 'handoff', { target: 'architect', reason: '被忽略' }),
          { type: 'done' },
        ]
      }
      // 工具调用产生同一回合的第 2 个子轮请求：返回无 @ 的过渡文本
      if (round === 1) return [{ type: 'text', text: '（等待视觉稿中）' }, { type: 'done' }]
      return [{ type: 'text', text: '视觉稿完成。\n@用户' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'designer'])
  })

  it('HANDOFF_MODE=tool：忽略文本 @，无工具调用时走收尾兜底', async () => {
    const env = makeEnv({ handoffMode: 'tool' })
    const session = env.sessions.create(['pm', 'architect', 'designer'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        // 文本 @designer 但 tool 模式下不解析 → 兜底按交接链选 architect
        return [{ type: 'text', text: '请 @designer 出视觉稿。' }, { type: 'done' }]
      }
      return [{ type: 'text', text: '就绪。\n@用户' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.map((m) => m.agentId)).toEqual(['pm', 'architect'])
  })
})

describe('M3：任务清单落盘', () => {
  it('write_todos → task_items 落库 + notify:task-updated + 覆盖式 id 稳定', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, (_req, round) => {
      if (round === 0) {
        return [
          toolCall('t1', 'write_todos', {
            todos: [
              { content: '调研竞品', status: 'done' },
              { content: '输出方案', status: 'in_progress' },
            ],
          }),
          { type: 'done' },
        ]
      }
      return [{ type: 'text', text: '清单已更新。\n@用户' }, { type: 'done' }]
    })

    await sendAndWait(env, session.id, '做个登录页 @pm')
    const tasks = env.tasks.list(session.id)
    expect(tasks.map((t) => t.content)).toEqual(['调研竞品', '输出方案'])
    expect(tasks.map((t) => t.status)).toEqual(['done', 'in_progress'])
    expect(tasks.every((t) => t.ownerAgentId === 'pm')).toBe(true)
    expect(env.published.some((n) => n.type === 'notify:task-updated')).toBe(true)

    // 覆盖式更新：相同内容复用旧行 id（跨 Run 继承，前端 diff 稳定）
    const oldId = tasks[0].id
    const second = env.tasks.replace(session.id, 'run_next', [
      { content: '调研竞品', status: 'done', ownerAgentId: 'pm' },
      { content: '补一组埋点', status: 'pending', ownerAgentId: 'frontend' },
    ])
    expect(second).toHaveLength(2)
    expect(second[0].id).toBe(oldId)
    expect(second[1].ownerAgentId).toBe('frontend')
  })
})

describe('M3：内容级循环检测', () => {
  it('trigramDice：相同为 1、不同文本为低相似', () => {
    expect(trigramDice('完全一样的内容', '完全一样的内容')).toBe(1)
    const high = trigramDice(`${LOOP_BASE} @architect 继续`, `${LOOP_BASE} @pm 继续`)
    expect(high).toBeGreaterThan(0.9)
    const low = trigramDice('今天讨论登录页的交互细节', '后端要补一个短信验证码接口')
    expect(low).toBeLessThan(0.3)
  })

  it('detectContentLoop：连续 3 对高相似 → true', () => {
    const a = `${LOOP_BASE} @architect 继续`
    const b = `${LOOP_BASE} @pm 继续`
    expect(detectContentLoop([a, b, a, b])).toBe(true)
    expect(detectContentLoop([a, '完全不同的方案说明', a, b])).toBe(false)
    expect(detectContentLoop([a, b])).toBe(false) // 不足 4 条
  })

  it('引擎：第 4 条高相似回复 → 强制交还用户并标注 loopSuppressed', async () => {
    const env = makeEnv()
    // 3 人轮转：避免触发名字序列级 A/B 交替检测（那样内容级就无从验证）
    const session = env.sessions.create(['pm', 'architect', 'designer'])
    const targets = ['@architect', '@designer', '@pm', '@architect']
    probeScript(env, (_req, round) => [
      { type: 'text', text: `${LOOP_BASE} ${targets[Math.min(round, targets.length - 1)]} 继续` },
      { type: 'done' },
    ])

    await sendAndWait(env, session.id, '推进吧 @pm')
    const turnEnds = env.published.filter((n) => n.type === 'notify:turn-end')
    expect(turnEnds.length).toBe(4)
    expect(turnEnds[3].payload.loopSuppressed).toBe(true)
    const lastAgent = env.sessions.messages(session.id).filter((m) => m.role === 'agent').pop()!
    expect(lastAgent.mentions).toEqual(['user'])
  })
})

describe('M3：thinking 状态与 Run 持久化', () => {
  it('agent-status 序列：thinking(prepare) → speaking → done', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])

    await sendAndWait(env, session.id, '开始 @pm')
    const statuses = env.published.filter((n) => n.type === 'notify:agent-status')
    expect(statuses[0].payload).toMatchObject({ agentId: 'pm', status: 'thinking', phase: 'prepare' })
    expect(statuses.some((n) => n.payload.status === 'speaking')).toBe(true)
    expect(statuses[statuses.length - 1].payload.status).toBe('done')
  })

  it('Run 快照：运行中 state=running，收尾 state=done 且含队列/发言史', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])

    const m1 = appendUserMessage(env, session.id, '开始 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)
    // 同步阶段：waiting → running（startRun 已调用）
    const mid = env.runs.get(runId)!
    expect(['waiting', 'running']).toContain(mid.state)

    await waitRunFinished(env.engine, runId)
    const done = env.runs.get(runId)!
    expect(done.state).toBe('done')
    expect(done.spoken).toContain('pm')
    expect(done.endedAt).toBeTruthy()
  })

  it('RunStore 启动恢复：活跃态 → interrupted', () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    const ts = new Date().toISOString()
    env.db.run(
      `INSERT INTO runs (id, session_id, state, queue, spoken, turn_index, fallback_used, handed_to_user, pending_user_messages, created_at, updated_at)
       VALUES ('run_stale', ?, 'running', '["pm"]', '[]', 0, 0, 0, '[]', ?, ?)`,
      session.id,
      ts,
      ts,
    )
    const fresh = new RunStore(env.db)
    expect(fresh.get('run_stale')!.state).toBe('interrupted')
    expect(fresh.latestInterrupted(session.id)!.id).toBe('run_stale')
  })

  it('resume：以中断快照（队列 + 发言史）继续，旧快照标记已恢复', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])

    const m1 = appendUserMessage(env, session.id, '做个登录页 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)
    await waitRunFinished(env.engine, runId)

    // 伪造「进程中断遗留」：队列里还有 architect 未执行
    env.db.run(
      `UPDATE runs SET state = 'interrupted', queue = '["architect"]', spoken = '["pm"]' WHERE id = ?`,
      runId,
    )
    const result = env.engine.resume(session.id)
    expect(result.queue).toEqual(['architect'])
    await waitRunFinished(env.engine, result.runId)

    // 旧快照标记已恢复（防止重复继续）
    expect(env.runs.get(runId)!.state).toBe('done')
    // 恢复的运行里 architect 完成发言
    const agents = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agents.some((m) => m.agentId === 'architect')).toBe(true)
    expect(env.engine.activeRunOf(session.id)).toBeUndefined()
  })
})

describe('M3：Run 异常收尾（审核 H-2）', () => {
  it('stop 排队中的 Run → 立即收尾（不悬挂），后续 Run 正常完成', async () => {
    const env = makeEnv({ asyncRunMax: 1 })
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])
    const sessionA = env.sessions.create(['pm'])
    const sessionB = env.sessions.create(['pm'])

    const m1 = appendUserMessage(env, sessionA.id, '开始 A')
    const a = env.engine.launch(sessionA.id, m1.id)
    // 同步紧接启动 → 并发槽已满，B 进入等待队列
    const m2 = appendUserMessage(env, sessionB.id, '开始 B')
    const b = env.engine.launch(sessionB.id, m2.id)
    expect(b.queued).toBe(true)

    expect(env.engine.stop(b.runId)).toBe(true)
    // 排队 Run 直接清退：内存记录移除 + 落库 done + 广播 run-completed
    expect(env.engine.hasRun(b.runId)).toBe(false)
    expect(env.engine.activeRunOf(sessionB.id)).toBeUndefined()
    expect(env.runs.get(b.runId)!.state).toBe('done')
    expect(env.published.some((n) => n.type === 'notify:run-completed' && n.runId === b.runId)).toBe(true)

    // A 不受影响，正常完成
    await waitRunFinished(env.engine, a.runId)
    expect(env.runs.get(a.runId)!.state).toBe('done')
  })

  it('收尾环节失败（saveNow 抛错）→ Run 仍完成收尾（run:end 广播 / 快照 done）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    probeScript(env, () => [{ type: 'text', text: '完成。\n@用户' }, { type: 'done' }])
    const m1 = appendUserMessage(env, session.id, '开始 @pm')
    const { runId } = env.engine.launch(session.id, m1.id)

    // launch 后拦截 saveNow：模拟收尾落盘失败（回合内 touch → scheduleSave 定时器路径不受影响）
    const store = env.sessions as unknown as { saveNow: (id: string) => void }
    const original = store.saveNow.bind(env.sessions)
    store.saveNow = () => {
      throw new Error('磁盘写失败（模拟）')
    }
    try {
      await waitRunFinished(env.engine, runId)
    } finally {
      store.saveNow = original
    }

    // 收尾链路逐环节容错：单点失败不阻断后续（快照 / 广播照常）
    expect(env.runs.get(runId)!.state).toBe('done')
    // 剧本以「@用户」收尾 → handedToUser 走 notify:awaiting-user
    expect(env.published.some((n) => n.type === 'notify:awaiting-user' && n.runId === runId)).toBe(true)
    expect(env.engine.activeRunOf(session.id)).toBeUndefined()
  })
})
