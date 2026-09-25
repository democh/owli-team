/**
 * M80 测试：表情回应 + 已读对外展示（docs/emoji-and-readreceipt-design.md）。
 *
 * 覆盖：
 * - PUT reactions：挂（201 幂等）/ 聚合投影（mine 按请求者）/ 非法字符 400 / 软限 8 种；
 * - DELETE reactions：仅摘本人（query 传参兼容）/ 广播 notify:reaction 全量替换帧；
 * - GET /sessions/:id：reactions 随行投影 + memberReads（关闭开关者不投影——对等原则；
 *   请求者自身关闭 → 空投影——对等双向）;
 * - POST /sessions/:id/read（REST 降级）：开关开 → publishReceipt 调用；关闭 → 不调用。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createInboxRouter } from '../src/routes/inbox.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ApiDeps } from '../src/routes/index.js'
import { ReactionStore } from '../src/store/reactions.js'
import { SessionReadsStore } from '../src/store/session-reads.js'
import { InboxStore } from '../src/store/inbox.js'
import { makeEnv } from './helpers.js'

interface Fixture {
  env: ReturnType<typeof makeEnv>
  reactions: ReactionStore
  base: string
  ids: { me: string; bob: string }
  cookie: (userId: string) => string
  receipts: Array<{ userId: string; sessionId: string; lastReadSeq: number }>
  close: () => Promise<void>
}

async function makeFixture(): Promise<Fixture> {
  const env = makeEnv()
  const reactions = new ReactionStore(env.db)
  const reads = new SessionReadsStore(env.db)
  const inbox = new InboxStore(env.db)
  await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
  const meLogin = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
  const tokens = new Map<string, string>([[meLogin.user.id, meLogin.rawToken]])
  const created = await env.auth.createUser({ username: 'bob', role: 'member' })
  const bobLogin = await env.auth.login({ username: 'bob', password: created.initialPassword! })
  await env.auth.changePassword({
    userId: created.user.id,
    currentPassword: created.initialPassword!,
    newPassword: 'Str0ngPass!x2',
    keepSessionToken: bobLogin.rawToken,
  })
  tokens.set(created.user.id, bobLogin.rawToken)
  const ids = { me: meLogin.user.id, bob: created.user.id }

  const receipts: Fixture['receipts'] = []
  const deps = { ...env, reads, inbox, reactions } as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createAuthMiddleware(env.cfg, env.auth))
  app.use(
    '/api',
    createInboxRouter({
      inbox,
      reads,
      access: env.access,
      auth: env.auth,
      readReceiptAllowed: (uid) => env.users.getPrefs(uid).showReadReceipts !== false,
      publishReceipt: (userId, sessionId, lastReadSeq) => receipts.push({ userId, sessionId, lastReadSeq }),
    }),
  )
  app.use('/api', createSessionsRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  return {
    env,
    reactions,
    base: `http://127.0.0.1:${port}`,
    ids,
    cookie: (uid) => `sid=${tokens.get(uid)}`,
    receipts,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      env.sessions.close()
      env.db.close()
    },
  }
}

/** 建一个 me 与 bob 共享的群聊式会话（直接落成员，绕开好友前置——本文件不测社交链路） */
function makeSharedSession(fx: Fixture): string {
  const session = fx.env.sessions.create([], 'M80 测试群', { ownerId: fx.ids.me, kind: 'group' })
  fx.env.members.upsert(session.id, fx.ids.bob, 'editor', fx.ids.me)
  return session.id
}

const put = (url: string, cookie: string, body?: unknown): Promise<globalThis.Response> =>
  fetch(url, { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const post = (url: string, cookie: string, body?: unknown): Promise<globalThis.Response> =>
  fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
const del = (url: string, cookie: string): Promise<globalThis.Response> => fetch(url, { method: 'DELETE', headers: { cookie } })

describe('M80-B：消息表情回应', () => {
  it('挂 / 聚合 / 幂等 / 摘除全链，广播全量替换帧', async () => {
    const fx = await makeFixture()
    try {
      const sid = makeSharedSession(fx)
      const msg = fx.env.sessions.appendMessage({ sessionId: sid, role: 'user', userId: fx.ids.bob, content: '大家好', mentions: [], status: 'complete' })

      // me 挂 👍
      const r1 = await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji: '👍' })
      expect(r1.status).toBe(200)
      const body1 = (await r1.json()) as { reactions: Array<{ emoji: string; count: number; mine: boolean }> }
      expect(body1.reactions).toEqual([{ emoji: '👍', count: 1, userIds: [fx.ids.me], mine: true }])

      // 幂等：重复挂同 emoji 不重复计数
      const r2 = await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji: '👍' })
      expect(((await r2.json()) as { reactions: Array<{ count: number }> }).reactions[0].count).toBe(1)

      // bob 同挂 👍 → 聚合 2；mine 按请求者投影
      const r3 = await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.bob), { emoji: '👍' })
      const body3 = (await r3.json()) as { reactions: Array<{ count: number; mine: boolean; userIds: string[] }> }
      expect(body3.reactions[0].count).toBe(2)
      expect(body3.reactions[0].mine).toBe(true)
      expect(body3.reactions[0].userIds).toEqual([fx.ids.me, fx.ids.bob])

      // 广播帧：会话主题 notify:reaction 全量替换（三次 PUT 三帧）
      const frames = fx.env.published.filter((p) => p.type === 'notify:reaction' && p.sessionId === sid)
      expect(frames.length).toBe(3)
      const lastPayload = frames[2].payload as { messageId: string; reactions: Array<{ count: number }> }
      expect(lastPayload.messageId).toBe(msg.id)
      expect(lastPayload.reactions[0].count).toBe(2)

      // GET 会话详情：reactions 随行投影（bob 视角 mine=true）
      const detail = await (await fetch(`${fx.base}/api/sessions/${sid}`, { headers: { cookie: fx.cookie(fx.ids.bob) } })).json() as {
        messages: Array<{ id: string; reactions?: Array<{ emoji: string; count: number; mine: boolean }> }>
      }
      const projected = detail.messages.find((m) => m.id === msg.id)
      expect(projected?.reactions?.[0]).toMatchObject({ emoji: '👍', count: 2, mine: true })

      // bob 摘除（query 传参通道）
      const r4 = await del(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions?emoji=${encodeURIComponent('👍')}`, fx.cookie(fx.ids.bob))
      expect(r4.status).toBe(200)
      expect(((await r4.json()) as { reactions: Array<{ count: number; mine: boolean }> }).reactions[0]).toMatchObject({ count: 1, mine: false })
    } finally {
      await fx.close()
    }
  })

  it('非法字符 400；超软限 429；他人摘除不动我的回应', async () => {
    const fx = await makeFixture()
    try {
      const sid = makeSharedSession(fx)
      const msg = fx.env.sessions.appendMessage({ sessionId: sid, role: 'user', userId: fx.ids.me, content: '测试', mentions: [], status: 'complete' })

      expect((await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji: 'abc' })).status).toBe(400)
      expect((await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji: '' })).status).toBe(400)

      // 软限：第 9 种拒绝
      const pool = ['👍', '❤️', '😂', '🎉', '👌', '🙏', '🔥', '✨']
      for (const emoji of pool) {
        const res = await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji })
        expect(res.status).toBe(200)
      }
      expect((await put(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions`, fx.cookie(fx.ids.me), { emoji: '💯' })).status).toBe(429)

      // bob 摘除自己未挂的 emoji：我的 👍 不受影响
      await del(`${fx.base}/api/sessions/${sid}/messages/${msg.id}/reactions?emoji=${encodeURIComponent('👍')}`, fx.cookie(fx.ids.bob))
      expect(fx.reactions.summaryFor(msg.id, fx.ids.me).find((r) => r.emoji === '👍')?.mine).toBe(true)
    } finally {
      await fx.close()
    }
  })
})

describe('M80-C：已读对外展示（对等原则）', () => {
  it('REST 已读上报按开关广播回执；memberReads 投影过滤关闭者', async () => {
    const fx = await makeFixture()
    try {
      const sid = makeSharedSession(fx)
      fx.env.sessions.appendMessage({ sessionId: sid, role: 'user', userId: fx.ids.me, content: '第一条', mentions: [], status: 'complete' })

      // bob 默认开关开：已读上报 → 回执广播
      const r1 = await post(`${fx.base}/api/sessions/${sid}/read`, fx.cookie(fx.ids.bob), { seq: 1 })
      expect(r1.status).toBe(200)
      expect(fx.receipts).toEqual([{ userId: fx.ids.bob, sessionId: sid, lastReadSeq: 1 }])

      // me 视角会话详情：memberReads 含 bob
      const d1 = (await (await fetch(`${fx.base}/api/sessions/${sid}`, { headers: { cookie: fx.cookie(fx.ids.me) } })).json()) as {
        memberReads: Array<{ userId: string; lastReadSeq: number }>
      }
      expect(d1.memberReads.some((m) => m.userId === fx.ids.bob && m.lastReadSeq === 1)).toBe(true)

      // bob 关闭开关 → 不再广播回执，且从投影消失（对等原则）
      fx.env.users.setPrefs(fx.ids.bob, { showReadReceipts: false })
      await post(`${fx.base}/api/sessions/${sid}/read`, fx.cookie(fx.ids.bob), { seq: 1 })
      expect(fx.receipts.length).toBe(1) // 无新增
      const d2 = (await (await fetch(`${fx.base}/api/sessions/${sid}`, { headers: { cookie: fx.cookie(fx.ids.me) } })).json()) as {
        memberReads: Array<{ userId: string }>
      }
      expect(d2.memberReads.some((m) => m.userId === fx.ids.bob)).toBe(false)
    } finally {
      await fx.close()
    }
  })

  it('对等双向：请求者自身关闭开关 → 也看不到他人已读（空投影）', async () => {
    const fx = await makeFixture()
    try {
      const sid = makeSharedSession(fx)
      fx.env.sessions.appendMessage({ sessionId: sid, role: 'user', userId: fx.ids.me, content: '第一条', mentions: [], status: 'complete' })

      // me（开关开）推进已读；bob 关闭自身开关
      await post(`${fx.base}/api/sessions/${sid}/read`, fx.cookie(fx.ids.me), { seq: 1 })
      fx.env.users.setPrefs(fx.ids.bob, { showReadReceipts: false })

      // bob 视角：他人（me）已读本应可见，但因自身关闭 → 空投影
      const dBob = (await (await fetch(`${fx.base}/api/sessions/${sid}`, { headers: { cookie: fx.cookie(fx.ids.bob) } })).json()) as {
        memberReads: Array<{ userId: string }>
      }
      expect(dBob.memberReads).toEqual([])

      // 对照组：me（开关开）视角仍正常投影自己，bob 因关闭不投影
      const dMe = (await (await fetch(`${fx.base}/api/sessions/${sid}`, { headers: { cookie: fx.cookie(fx.ids.me) } })).json()) as {
        memberReads: Array<{ userId: string }>
      }
      expect(dMe.memberReads.some((m) => m.userId === fx.ids.me)).toBe(true)
      expect(dMe.memberReads.some((m) => m.userId === fx.ids.bob)).toBe(false)
    } finally {
      await fx.close()
    }
  })
})
