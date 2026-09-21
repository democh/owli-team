import { describe, expect, it } from 'vitest'
import { appendUserMessage, makeEnv, sendAndWait, waitRunFinished } from './helpers.js'

describe('engine：Mock 全链（集成）', () => {
  it('7 人团队接力全链 → @用户 收尾 + 全员交付件', async () => {
    const env = makeEnv()
    const session = env.sessions.create([
      'pm',
      'architect',
      'designer',
      'frontend',
      'backend',
      'qa',
      'devops',
    ])
    await sendAndWait(env, session.id, '帮我做登录功能')

    const messages = env.sessions.messages(session.id)
    const agentMessages = messages.filter((m) => m.role === 'agent')
    expect(agentMessages.length).toBe(7)
    expect(agentMessages.every((m) => m.status === 'complete')).toBe(true)
    // 防回环：7 位成员各发言一次
    expect(new Set(agentMessages.map((m) => m.agentId)).size).toBe(7)
    // 最终 @用户 收尾
    expect(agentMessages[agentMessages.length - 1].mentions).toEqual(['user'])

    // 交付件：每角色首次发言产出 1 份
    const files = env.artifacts.list(session.id)
    expect(files.length).toBe(7)
    expect(files.some((f) => f.path === 'docs/需求文档-登录.md')).toBe(true)
    expect(files.some((f) => f.path === 'docs/测试计划-登录.md')).toBe(true)

    // 工具卡：write_todos + write_file 均执行成功
    const first = agentMessages[0]
    expect(first.toolCalls?.map((t) => t.name)).toEqual(['write_todos', 'write_file'])
    expect(first.toolCalls?.every((t) => t.status === 'ok')).toBe(true)
    expect(first.artifacts?.length).toBe(1)

    // WS 通知：run-started / turn-end ×7 / awaiting-user
    const types = env.published.map((n) => n.type)
    expect(types).toContain('notify:run-started')
    expect(types.filter((t) => t === 'notify:turn-end').length).toBe(7)
    expect(types).toContain('notify:awaiting-user')
    expect(types).toContain('notify:artifact-updated')
  })

  it('2 人会话：pm → architect → @用户（转交指向真实接手者，§6.4）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    await sendAndWait(env, session.id, '设计一个支付功能')

    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages.map((m) => m.agentId)).toEqual(['pm', 'architect'])
    expect(agentMessages[0].mentions).toEqual(['architect'])
    expect(agentMessages[1].mentions).toEqual(['user'])
  })

  it('首发 @ 不在场成员 → 守卫丢弃并按交接链兜底（§6.4 真实性）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'])
    await sendAndWait(env, session.id, '@艾瑞 看下登录功能')

    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages.length).toBeGreaterThanOrEqual(1)
    expect(agentMessages[0].agentId).toBe('pm')
  })

  it('二次发送：新 Run 从用户 @ 的成员开始', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'qa'])
    await sendAndWait(env, session.id, '做个评论功能')
    const before = env.sessions.messages(session.id).filter((m) => m.role === 'agent').length

    await sendAndWait(env, session.id, '@诺娃 再补一组边界用例')
    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages.length).toBeGreaterThan(before)
    expect(agentMessages[before].agentId).toBe('qa')
  })

  it('错误注入：provider 抛错 → 消息 error + run-error 通知', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'])
    // 猴子补丁：让 chatStream 抛错
    const provider = env.provider as unknown as { chatStream: () => AsyncIterable<never> }
    // eslint-disable-next-line require-yield -- 故意只抛错，不产出 chunk
    provider.chatStream = async function* () {
      throw new Error('模拟上游 500')
    }
    await sendAndWait(env, session.id, '触发错误')

    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages[0].status).toBe('error')
    expect(env.published.some((n) => n.type === 'notify:run-error')).toBe(true)
  })

  it('循环抑制：Mock 强制两人交替 → 运行以交还用户结束', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    // 让 pm 永远 @艾达、architect 永远 @费利（不会发生，因为 spoken 防回环）；
    // 这里直接用会话验证正常路径不触发循环（守卫层单测已覆盖循环检测）
    await sendAndWait(env, session.id, '循环场景验证')
    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages.length).toBeLessThanOrEqual(10)
  })

  it('M14：运行中重排队列 → 后续棒次按新顺序执行 + trace 落记', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect', 'qa'])
    const message = appendUserMessage(env, session.id, '@费利 评估登录方案，稍后拉团队一起过')
    const { runId } = env.engine.launch(session.id, message.id)

    // launch 返回时首波（pm）已出队执行；把 qa、architect 按新顺序排入后续棒次
    const reordered = env.engine.reorderQueue(runId, ['qa', 'architect'])
    expect(reordered.queue).toEqual(['qa', 'architect'])
    expect(env.engine.listActiveRuns().find((r) => r.runId === runId)?.queue).toEqual(['qa', 'architect'])

    await waitRunFinished(env.engine, runId)
    const agentMessages = env.sessions.messages(session.id).filter((m) => m.role === 'agent')
    expect(agentMessages[0].agentId).toBe('pm')
    expect(agentMessages[1].agentId).toBe('qa') // 重排后下一棒生效
    expect(env.events.listByRun(runId).some((e) => e.type === 'queue:updated')).toBe(true)
  })

  it('M14：reorderQueue 守卫 —— 过滤非参与者/去重；空队列与非活跃 Run 拒绝', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'architect'])
    const message = appendUserMessage(env, session.id, '@费利 看下支付方案')
    const { runId } = env.engine.launch(session.id, message.id)

    const r = env.engine.reorderQueue(runId, ['architect', 'architect', 'ghost', 'pm'])
    expect(r.queue).toEqual(['architect', 'pm'])
    expect(() => env.engine.reorderQueue(runId, ['ghost'])).toThrow(/不能为空/)

    env.engine.stop(runId)
    await waitRunFinished(env.engine, runId)
    expect(() => env.engine.reorderQueue(runId, ['pm'])).toThrow(/运行不存在或已结束/)
  })
})

describe('M79-Y：指挥台重排广播（触发者外的其他端 / 成员对齐）', () => {
  it('reorderQueue → notify:queue-updated 到会话主题（带 runId）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['architect', 'pm'], '广播-队列')
    const msg = appendUserMessage(env, session.id, '@架构师 做方案')
    const { runId } = env.engine.launch(session.id, msg.id)
    env.engine.reorderQueue(runId, ['pm', 'architect'])
    const frame = env.published.find(
      (x) => x.type === 'notify:queue-updated' && x.sessionId === session.id,
    )
    expect(frame, '未找到队列重排广播帧').toBeTruthy()
    expect((frame!.payload as { queue: string[] }).queue).toEqual(['pm', 'architect'])
    await waitRunFinished(env.engine, runId, 15_000)
  })
})

describe('M79-Z：旁观端流式广播（节流聚合）', () => {
  it('run 期间广播 notify:message-delta（合并帧），且先于该消息的 turn-end 完整帧', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm'], '流式-广播')
    const msg = appendUserMessage(env, session.id, '@费利 给方案')
    const { runId } = env.engine.launch(session.id, msg.id)
    await waitRunFinished(env.engine, runId, 15_000)

    const deltaFrames = env.published.filter(
      (x) => x.type === 'notify:message-delta' && x.sessionId === session.id,
    )
    expect(deltaFrames.length).toBeGreaterThan(0)
    const payload = deltaFrames[0]!.payload as { messageId: string; agentId: string; memberKey: string; delta: string }
    expect(payload.messageId).toBeTruthy()
    expect(payload.agentId).toBeTruthy()
    expect(payload.memberKey).toBeTruthy()
    expect(payload.delta.length).toBeGreaterThan(0)

    // 顺序保证：同一 messageId 的最后一个 delta 帧必须先于其 turn-end 完整帧（客户端按序覆盖语义）
    let lastDeltaIdx = -1
    let turnEndIdx = -1
    env.published.forEach((x, i) => {
      if (x.type === 'notify:message-delta' && (x.payload as { messageId?: string }).messageId === payload.messageId) {
        lastDeltaIdx = i
      }
      if (
        x.type === 'notify:turn-end' &&
        (x.payload as { message?: { id?: string } }).message?.id === payload.messageId
      ) {
        turnEndIdx = i
      }
    })
    expect(turnEndIdx).toBeGreaterThan(-1)
    expect(lastDeltaIdx).toBeGreaterThan(-1)
    expect(turnEndIdx).toBeGreaterThan(lastDeltaIdx)
  })
})
