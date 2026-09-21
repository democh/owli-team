/**
 * M79-E 测试：触发判断矩阵 + 人类 @ 寻址 + 持球方生命周期。
 *
 * 覆盖：
 * - parser：人类 token 注册降级链（显示名冲突 / 重名 / username 回退）+ 行首指名 handedTo；
 * - 触发矩阵（路由层）：team auto 无 @ → launch（现状）；team mention 无 @ → 仅存储；
 *   team auto + @真人 → 仅存储（人类定向不触发）；chat + @agent（混编）→ launch；
 * - waiting：被点名者回复 → 集合差清除 + session-meta 广播；waiting 命中越过 mention 策略强制触发；
 * - store：setWaitingOn 并集 / clearWaitingOn / clearWaitingForUsers。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ApiDeps } from '../src/routes/index.js'
import { buildHumanMentionTokens, parseHumanMentions } from '../src/orchestration/parser.js'
import { InboxStore } from '../src/store/inbox.js'
import { SessionReadsStore } from '../src/store/session-reads.js'
import { SessionHideStore } from '../src/store/session-hides.js'
import { waitRunFinished, makeEnv } from './helpers.js'

describe('M79-E：人类 @ 寻址（parser）', () => {
  it('token 注册降级链：与 agent 撞名不注册显示名；人类重名不注册；username 恒可回退', () => {
    const humans = [
      { userId: 'u_bob', displayName: 'Bob', username: 'bob' },
      { userId: 'u_luna2', displayName: '卢娜', username: 'luna2' }, // 与 agent「卢娜」撞名
      { userId: 'u_dup1', displayName: '小明', username: 'xiaoming1' },
      { userId: 'u_dup2', displayName: '小明', username: 'xiaoming2' },
    ]
    const reserved = new Set(['卢娜', 'luna2']) // 注意：luna2 的 username 也撞 reserved（防双命中）
    const tokens = buildHumanMentionTokens(humans, reserved)
    const names = tokens.map((t) => t.token)
    expect(names).toContain('Bob')
    // 大小写不敏感去重：username 'bob' 与显示名 'Bob' 同 token（@bob 亦命中）
    expect(parseHumanMentions('@bob 在吗', tokens).humanMentions).toEqual(['u_bob'])
    expect(names).not.toContain('卢娜') // 与 agent 撞名 → 不注册
    expect(names).not.toContain('小明') // 人类重名 → 不注册
    expect(names).toContain('xiaoming1')
    expect(names).toContain('xiaoming2')
    expect(names).not.toContain('luna2') // username 撞 reserved → 不注册（极端边界）
  })

  it('解析：句中命中 humanMentions；行首 @具体人 → handedTo', () => {
    const tokens = buildHumanMentionTokens(
      [
        { userId: 'u_bob', displayName: 'Bob', username: 'bob' },
        { userId: 'u_li', displayName: '李四', username: 'lisi' },
      ],
      new Set(),
    )
    const mid = parseHumanMentions('这个方案 @Bob 看下，另外请 @李四 复核', tokens)
    expect(mid.humanMentions.sort()).toEqual(['u_bob', 'u_li'])
    expect(mid.handedTo).toEqual([])

    const lead = parseHumanMentions('@李四 请拍板\n其余照旧', tokens)
    expect(lead.handedTo).toEqual(['u_li'])
    // minutes 容器内不参与解析（复用既有剥离口径）
    const stripped = parseHumanMentions('::: minutes\n- 待办 | @Bob 跟进\n:::', tokens)
    expect(stripped.humanMentions).toEqual([])
  })
})

describe('M79-E：持球方存储', () => {
  it('setWaitingOn 并集去重；clearWaitingOn 集合差；clearWaitingForUsers 清洗', () => {
    const env = makeEnv()
    try {
      const session = env.sessions.create(['pm'], '持球')
      env.sessions.setWaitingOn(session.id, ['u_a'])
      env.sessions.setWaitingOn(session.id, ['u_a', 'u_b'])
      expect(env.sessions.getSession(session.id)?.waitingOn?.sort()).toEqual(['u_a', 'u_b'])
      expect(env.sessions.clearWaitingOn(session.id, 'u_a')).toBe(true)
      expect(env.sessions.clearWaitingOn(session.id, 'u_a')).toBe(false) // 幂等
      expect(env.sessions.getSession(session.id)?.waitingOn).toEqual(['u_b'])
      expect(env.sessions.clearWaitingForUsers(session.id, ['u_b'])).toBe(true)
      expect(env.sessions.getSession(session.id)?.waitingOn).toBeUndefined()
    } finally {
      env.sessions.close()
      env.db.close()
    }
  })
})

describe('M79-E：触发矩阵（路由层）', () => {
  async function makeFixture(): Promise<{
    env: ReturnType<typeof makeEnv>
    base: string
    cookie: string
    bobId: string
    close: () => Promise<void>
  }> {
    const env = makeEnv()
    const inbox = new InboxStore(env.db)
    const reads = new SessionReadsStore(env.db)
    const hides = new SessionHideStore(env.db)
    await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
    const login = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
    const bob = await env.auth.createUser({ username: 'bob', role: 'member' })
    const bobLogin = await env.auth.login({ username: 'bob', password: bob.initialPassword! })
    await env.auth.changePassword({
      userId: bob.user.id,
      currentPassword: bob.initialPassword!,
      newPassword: 'Str0ngPass!x2',
      keepSessionToken: bobLogin.rawToken,
    })
    const delivered: string[] = []
    const deps = {
      ...env,
      inbox,
      reads,
      hides,
      deliverInbox: (input: { userId: string; type: string }) => delivered.push(`${input.userId}:${input.type}`),
    } as unknown as ApiDeps
    const app = express()
    app.use(express.json())
    app.use('/api', createAuthMiddleware(env.cfg, env.auth))
    app.use('/api', createSessionsRouter(deps))
    const server = app.listen(0)
    await new Promise<void>((r) => server.once('listening', r))
    const port = (server.address() as AddressInfo).port
    return {
      env,
      base: `http://127.0.0.1:${port}`,
      cookie: `sid=${login.rawToken}`,
      bobId: bob.user.id,
      close: async () => {
        await new Promise<void>((r) => server.close(() => r()))
        env.sessions.close()
        env.db.close()
      },
    }
  }

  const send = (fx: Awaited<ReturnType<typeof makeFixture>>, sid: string, content: string): Promise<globalThis.Response> =>
    fetch(`${fx.base}/api/sessions/${sid}/messages`, {
      method: 'POST',
      headers: { cookie: fx.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content }),
    })

  it('team auto 无 @ → 触发（runId）；切 mention 后无 @ → 仅存储（零 Run）', async () => {
    const fx = await makeFixture()
    try {
      const session = fx.env.sessions.create(['pm'], '触发矩阵', { ownerId: fx.env.users.getByUsername('admin')!.id })
      // auto（默认）：无 @ → launch（现状）
      const autoRes = (await (await send(fx, session.id, '帮我写一个需求说明')).json()) as { runId?: string }
      expect(autoRes.runId).toBeTruthy()
      await waitRunFinished(fx.env.engine, autoRes.runId!)

      // 切换 mention：无 @ → 仅存储
      const patch = await fetch(`${fx.base}/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { cookie: fx.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ routeMode: 'mention' }),
      })
      expect(patch.status).toBe(200)
      const before = fx.env.published.length
      const silentRes = (await (await send(fx, session.id, '大家同步一下进度')).json()) as { runId?: string }
      expect(silentRes.runId).toBeUndefined()
      expect(fx.env.engine.listActiveRuns()).toHaveLength(0)
      expect(fx.env.published.slice(before).some((n) => n.type === 'notify:turn-end')).toBe(true)
    } finally {
      await fx.close()
    }
  })

  it('@真人（人类定向）在 auto 下不触发；waiting 命中越过 mention 强制触发', async () => {
    const fx = await makeFixture()
    try {
      const adminId = fx.env.users.getByUsername('admin')!.id
      const session = fx.env.sessions.create(['pm'], '人类定向', { ownerId: adminId })
      fx.env.members.upsert(session.id, fx.bobId, 'editor', adminId)

      // auto + @Bob（真人）→ 仅存储 + inbox 提及投递
      const res = (await (await send(fx, session.id, '@Bob 你看下这个方案')).json()) as { runId?: string }
      expect(res.runId).toBeUndefined()
      const msg = fx.env.sessions.messages(session.id).at(-1)!
      expect(msg.humanMentions).toEqual([fx.bobId])
      expect(fx.env.engine.listActiveRuns()).toHaveLength(0)

      // mention 模式 + waiting 命中（bob 被点名）→ 强制触发
      fx.env.sessions.setRouteMode(session.id, 'mention')
      fx.env.sessions.setWaitingOn(session.id, [fx.bobId])
      const bobCookie = (await fx.env.auth.login({ username: 'bob', password: 'Str0ngPass!x2' })).rawToken
      const hit = await fetch(`${fx.base}/api/sessions/${session.id}/messages`, {
        method: 'POST',
        headers: { cookie: `sid=${bobCookie}`, 'content-type': 'application/json' },
        body: JSON.stringify({ content: '同意，就按方案 B 做' }),
      })
      const hitBody = (await hit.json()) as { runId?: string }
      expect(hitBody.runId).toBeTruthy() // waiting 命中：越过 mention 策略
      // 持球清除（集合差）
      expect(fx.env.sessions.getSession(session.id)?.waitingOn).toBeUndefined()
      await waitRunFinished(fx.env.engine, hitBody.runId!)
    } finally {
      await fx.close()
    }
  })

  it('chat（混编群）@agent → launch；无 @ 消息零 Run', async () => {
    const fx = await makeFixture()
    try {
      const adminId = fx.env.users.getByUsername('admin')!.id
      const group = fx.env.sessions.create(['pm'], '混编群', { ownerId: adminId, kind: 'group' })
      // 无 @ → 零 Run
      const silent = (await (await send(fx, group.id, '晚上吃啥')).json()) as { runId?: string }
      expect(silent.runId).toBeUndefined()
      // @pm（在场 agent）→ launch
      const fired = (await (await send(fx, group.id, '@pm 帮查一下资料')).json()) as { runId?: string }
      expect(fired.runId).toBeTruthy()
      await waitRunFinished(fx.env.engine, fired.runId!)
    } finally {
      await fx.close()
    }
  })
})
