/**
 * M79-D 测试：人物会话（私聊 / 群聊 / 免路由 / 隐藏 / 列表标题 / 群邀请放宽）。
 *
 * 覆盖：
 * - POST /chats/direct：好友校验 / 自聊拒绝 / 创建（201）→ 复用（200 同 id）/ dm_key 唯一；
 * - GET /sessions：direct 标题 = 对端显示名（双向）；kind 随行；
 * - 免路由：chat 形态消息零引擎（无 runId、无活跃 Run；notify:turn-end 补播）；
 * - 隐藏：hide 后列表排除（无未读）；新消息 → 自动复现（有未读）；
 * - POST /chats/group：好友校验 / 系统事件条 / 成员就位；
 * - shares 群聊分支：成员可邀请自己的好友；非好友 → 403。
 */
import express from 'express'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { createAuthMiddleware } from '../src/middleware.js'
import { createChatsRouter } from '../src/routes/chats.js'
import { createInboxRouter } from '../src/routes/inbox.js'
import { createSharesRouter } from '../src/routes/shares.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ApiDeps } from '../src/routes/index.js'
import { FriendStore } from '../src/store/friends.js'
import { SessionHideStore } from '../src/store/session-hides.js'
import { SessionReadsStore } from '../src/store/session-reads.js'
import { InboxStore } from '../src/store/inbox.js'
import { makeEnv, waitRunFinished } from './helpers.js'

interface DFixture {
  env: ReturnType<typeof makeEnv>
  friends: FriendStore
  hides: SessionHideStore
  base: string
  ids: { me: string; bob: string; carol: string; dave: string }
  cookie: (userId: string) => string
  closes: Array<() => Promise<void>>
  delivered: string[]
  close: () => Promise<void>
}

async function makeFixture(): Promise<DFixture> {
  const env = makeEnv()
  const friends = new FriendStore(env.db)
  const hides = new SessionHideStore(env.db)
  const reads = new SessionReadsStore(env.db)
  const inbox = new InboxStore(env.db)
  await env.auth.setup({ username: 'admin', password: 'Str0ngPass!x' })
  const meLogin = await env.auth.login({ username: 'admin', password: 'Str0ngPass!x' })
  const tokens = new Map<string, string>([[meLogin.user.id, meLogin.rawToken]])
  const ids: Record<string, string> = { me: meLogin.user.id }
  for (const name of ['bob', 'carol', 'dave'] as const) {
    const created = await env.auth.createUser({ username: name, role: 'member' })
    const login = await env.auth.login({ username: name, password: created.initialPassword! })
    await env.auth.changePassword({
      userId: created.user.id,
      currentPassword: created.initialPassword!,
      newPassword: 'Str0ngPass!x2',
      keepSessionToken: login.rawToken,
    })
    tokens.set(created.user.id, login.rawToken)
    ids[name] = created.user.id
  }
  // 好友关系：me-bob、me-carol、bob-carol（dave 孤立）
  friends.accept(friends.request(ids.me!, ids.bob!).id)
  friends.accept(friends.request(ids.me!, ids.carol!).id)
  friends.accept(friends.request(ids.bob!, ids.carol!).id)

  const delivered: string[] = []
  const deliver = (input: { userId: string; title: string }): void => {
    delivered.push(`${input.userId}:${input.title}`)
  }
  const deps = { ...env, friends, hides, reads, inbox, deliverInbox: deliver } as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createAuthMiddleware(env.cfg, env.auth))
  const publish = (sessionId: string, userId: string, action: string, role?: string): void => {
    void sessionId
    void userId
    void action
    void role
  }
  app.use(
    '/api',
    createChatsRouter({ access: env.access, auth: env.auth, sessions: env.sessions, members: env.members, friends, hides, deliver, publishShareChanged: publish }),
  )
  app.use('/api', createInboxRouter({ inbox, reads, access: env.access, auth: env.auth }))
  app.use(
    '/api',
    createSharesRouter({
      access: env.access,
      auth: env.auth,
      members: env.members,
      audit: { record: () => undefined } as never,
      deliver,
      friends,
      // M79-AA 群管理补全：与生产装配同规（routes/index.ts）——退出 / 移出留痕（system 事件条 + turn-end 广播）
      appendSystem: (sessionId, content) => {
        if (!env.sessions.getSession(sessionId)) return
        const message = env.sessions.appendMessage({ sessionId, role: 'system', content, mentions: [], status: 'complete' })
        env.notify.publish({ type: 'notify:turn-end', sessionId, payload: { message } })
      },
    }),
  )
  app.use('/api', createSessionsRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((r) => server.once('listening', r))
  const port = (server.address() as AddressInfo).port
  return {
    env,
    friends,
    hides,
    base: `http://127.0.0.1:${port}`,
    ids: { me: ids.me!, bob: ids.bob!, carol: ids.carol!, dave: ids.dave! },
    cookie: (userId: string) => `sid=${tokens.get(userId)}`,
    closes: [],
    delivered,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      env.sessions.close()
      env.db.close()
    },
  }
}

const post = (url: string, cookie: string, body?: unknown): Promise<globalThis.Response> =>
  fetch(url, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })

const getSessions = async (fx: DFixture, cookie: string): Promise<Array<{ id: string; title: string; kind?: string; unreadCount?: number }>> => {
  const res = (await (await fetch(`${fx.base}/api/sessions`, { headers: { cookie } })).json()) as {
    sessions: Array<{ id: string; title: string; kind?: string; unreadCount?: number }>
  }
  return res.sessions
}

describe('M79-H：拉黑后消息面切断（仅人物私聊；团队协作不受影响）', () => {
  it('拉黑对双方互发 403（文案按视角区分）；解除后恢复；共享团队会话仍可发', async () => {
    const fx = await makeFixture()
    try {
      // 建立 me ↔ bob 私聊
      const dmRes = await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.bob })
      expect(dmRes.status).toBe(201)
      const dmId = ((await dmRes.json()) as { session: { id: string } }).session.id
      // 拉黑前可发（基线）
      const before = await post(`${fx.base}/api/sessions/${dmId}/messages`, fx.cookie(fx.ids.me), { content: '基线消息' })
      expect(before.status).toBe(201)

      // me 拉黑 bob（存储级；路由面拉黑已有 m79-friends 覆盖）
      fx.friends.block(fx.ids.me, fx.ids.bob)

      // 拉黑方视角：可操作原因
      const byBlocker = await post(`${fx.base}/api/sessions/${dmId}/messages`, fx.cookie(fx.ids.me), { content: '拉黑后发送' })
      expect(byBlocker.status).toBe(403)
      expect(((await byBlocker.json()) as { error: string }).error).toContain('你已拉黑对方')
      // 被拉黑方视角：不泄漏拉黑事实（中性文案）
      const byBlocked = await post(`${fx.base}/api/sessions/${dmId}/messages`, fx.cookie(fx.ids.bob), { content: '被拉黑后发送' })
      expect(byBlocked.status).toBe(403)
      expect(((await byBlocked.json()) as { error: string }).error).toContain('对方设置了隐私限制')

      // 拒绝发生在落库前（用户消息数不增加；DM 创建时含 1 条系统事件条）
      expect(fx.env.sessions.messages(dmId).filter((m) => m.role === 'user')).toHaveLength(1)

      // 团队协作面不受拉黑影响（拉黑是社交面而非协作面）
      const team = fx.env.sessions.create(['pm'], '协作团队', { ownerId: fx.ids.me })
      fx.env.members.upsert(team.id, fx.ids.bob, 'editor')
      const inTeam = await post(`${fx.base}/api/sessions/${team.id}/messages`, fx.cookie(fx.ids.bob), { content: '团队里仍可协作' })
      expect(inTeam.status).toBe(201)

      // 解除拉黑 → 私聊恢复
      expect(fx.friends.unblock(fx.ids.me, fx.ids.bob)).toBe(true)
      const after = await post(`${fx.base}/api/sessions/${dmId}/messages`, fx.cookie(fx.ids.bob), { content: '解除后恢复' })
      expect(after.status).toBe(201)
    } finally {
      await fx.close()
    }
  })
})

describe('M79-J：成员编制管理权限（§16 矩阵：team 仅 owner；group 放宽 editor）', () => {
  it('team：editor 增 / 移 agent 一律 403，owner 放行；group：editor 可拉 agent 进群', async () => {
    const fx = await makeFixture()
    try {
      // team：me 属主 + bob editor
      const team = fx.env.sessions.create([], '权限团队', { ownerId: fx.ids.me })
      fx.env.members.upsert(team.id, fx.ids.bob, 'editor')
      const byEditor = await post(`${fx.base}/api/sessions/${team.id}/members`, fx.cookie(fx.ids.bob), { agentIds: ['pm'] })
      expect(byEditor.status).toBe(403)
      expect(((await byEditor.json()) as { error: string }).error).toContain('仅会话属主')
      const byOwner = await post(`${fx.base}/api/sessions/${team.id}/members`, fx.cookie(fx.ids.me), { agentIds: ['pm'] })
      expect(byOwner.status).toBe(201)
      const del = await fetch(`${fx.base}/api/sessions/${team.id}/members/pm`, {
        method: 'DELETE',
        headers: { cookie: fx.cookie(fx.ids.bob) },
      })
      expect(del.status).toBe(403)

      // group：me 属主 + bob 成员 → bob（editor）可把 agent 拉进群（混编群）
      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { title: '混编群', memberIds: [fx.ids.bob] })
      expect(groupRes.status).toBe(201)
      const groupId = ((await groupRes.json()) as { session: { id: string } }).session.id
      const inGroup = await post(`${fx.base}/api/sessions/${groupId}/members`, fx.cookie(fx.ids.bob), { agentIds: ['pm'] })
      expect(inGroup.status).toBe(201)
      expect(
        ((await inGroup.json()) as { session: { participantIds: string[] } }).session.participantIds,
      ).toContain('pm')
    } finally {
      await fx.close()
    }
  })
})

describe('M79-M：混编群 @agent 触发与纯人聊天边界', () => {
  it('纯人群 @agent 名 → 仅存储（不触发）；agent 入编后 @agent → 触发 Run（201 + runId）', async () => {
    const fx = await makeFixture()
    try {
      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { title: '混编边界群', memberIds: [fx.ids.bob] })
      expect(groupRes.status).toBe(201)
      const gid = ((await groupRes.json()) as { session: { id: string } }).session.id

      // 纯人聊天：@费利（未入编）→ 人类定向语义仅存储（无 runId）
      const plain = await post(`${fx.base}/api/sessions/${gid}/messages`, fx.cookie(fx.ids.bob), { content: '@费利 帮看下' })
      expect(plain.status).toBe(201)
      expect('runId' in ((await plain.json()) as Record<string, unknown>)).toBe(false)

      // agent 入编（owner 编制权限）→ @费利 → 混编群唤起 Run
      const add = await post(`${fx.base}/api/sessions/${gid}/members`, fx.cookie(fx.ids.me), { agentIds: ['pm'] })
      expect(add.status).toBe(201)
      const hit = await post(`${fx.base}/api/sessions/${gid}/messages`, fx.cookie(fx.ids.bob), { content: '@费利 请给方案' })
      expect(hit.status).toBe(201)
      expect(typeof ((await hit.json()) as { runId?: string }).runId).toBe('string')
    } finally {
      await fx.close()
    }
  })
})

describe('M79-D：私聊创建与列表', () => {
  it('好友校验 / 自聊拒绝 / 创建 → 复用（同 id）；双向标题 = 对端显示名', async () => {
    const fx = await makeFixture()
    try {
      // 非好友（dave）→ 403
      const denied = await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.dave })
      expect(denied.status).toBe(403)
      expect(((await denied.json()) as { error: string }).error).toContain('仅好友')
      // 自聊 → 400
      expect((await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.me })).status).toBe(400)

      const first = await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.bob })
      expect(first.status).toBe(201)
      const firstBody = (await first.json()) as { session: { id: string; kind?: string }; created: boolean }
      expect(firstBody.created).toBe(true)
      expect(firstBody.session.kind).toBe('direct')

      // 复用（bob 发起同一对）→ 200 同 id
      const second = await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.bob), { userId: fx.ids.me })
      expect(second.status).toBe(200)
      const secondBody = (await second.json()) as { session: { id: string }; created: boolean }
      expect(secondBody.created).toBe(false)
      expect(secondBody.session.id).toBe(firstBody.session.id)

      // 双向标题（对端显示名；admin 的 displayName 默认 = username）
      const meList = await getSessions(fx, fx.cookie(fx.ids.me))
      const myDirect = meList.find((s) => s.id === firstBody.session.id)!
      expect(myDirect.title).toBe('bob')
      expect(myDirect.kind).toBe('direct')
      const bobList = await getSessions(fx, fx.cookie(fx.ids.bob))
      expect(bobList.find((s) => s.id === firstBody.session.id)!.title).toBe('admin')

      // 系统事件条（开始了对话）
      const messages = fx.env.sessions.messages(firstBody.session.id)
      expect(messages.some((m) => m.role === 'system' && m.content.includes('开始了对话'))).toBe(true)
      // 被邀请人 inbox 投递
      expect(fx.delivered.some((d) => d.startsWith(`${fx.ids.bob}:`))).toBe(true)
    } finally {
      await fx.close()
    }
  })

  it('免路由：chat 消息零引擎；隐藏后列表排除，新消息自动复现', async () => {
    const fx = await makeFixture()
    try {
      const created = (await (await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.bob })).json()) as {
        session: { id: string }
      }
      const sid = created.session.id
      const before = fx.env.published.length

      // 发消息：零引擎（无 runId；无活跃 Run；notify:turn-end 补播）
      const sent = await post(`${fx.base}/api/sessions/${sid}/messages`, fx.cookie(fx.ids.bob), { content: '在吗？看下这个方案' })
      expect(sent.status).toBe(201)
      const sentBody = (await sent.json()) as { message: { id: string }; runId?: string }
      expect(sentBody.runId).toBeUndefined()
      expect(fx.env.engine.listActiveRuns()).toHaveLength(0)
      expect(fx.env.published.slice(before).some((n) => n.type === 'notify:turn-end')).toBe(true)

      // bob 读完消息后隐藏 → 列表排除（无未读才隐藏）
      const lastSeq = fx.env.sessions.messages(sid).at(-1)!.seq!
      const readRes = await post(`${fx.base}/api/sessions/${sid}/read`, fx.cookie(fx.ids.bob), { seq: lastSeq })
      expect(readRes.status).toBe(200)
      expect((await post(`${fx.base}/api/sessions/${sid}/hide`, fx.cookie(fx.ids.bob))).status).toBe(200)
      const afterHide = await getSessions(fx, fx.cookie(fx.ids.bob))
      expect(afterHide.some((s) => s.id === sid)).toBe(false)
      // 对方不受影响
      expect((await getSessions(fx, fx.cookie(fx.ids.me))).some((s) => s.id === sid)).toBe(true)

      // 新消息 → 自动复现（有未读）
      await post(`${fx.base}/api/sessions/${sid}/messages`, fx.cookie(fx.ids.me), { content: '帮我确认下原型' })
      const afterNew = await getSessions(fx, fx.cookie(fx.ids.bob))
      const revived = afterNew.find((s) => s.id === sid)
      expect(revived).toBeTruthy()
      expect(revived!.unreadCount).toBeGreaterThan(0)
    } finally {
      await fx.close()
    }
  })
})

describe('M79-D：群聊与邀请放宽', () => {
  it('群创建：好友校验 / 系统事件条；成员可邀请自己的好友，非好友 403', async () => {
    const fx = await makeFixture()
    try {
      // me 邀请 dave（非好友）→ 403
      const denied = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { title: '测试群', memberIds: [fx.ids.dave] })
      expect(denied.status).toBe(403)

      const created = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { title: '三人组', memberIds: [fx.ids.bob, fx.ids.carol] })
      expect(created.status).toBe(201)
      const gsid = ((await created.json()) as { session: { id: string } }).session.id
      expect(fx.env.members.list(gsid).map((m) => m.userId).sort()).toEqual([fx.ids.bob, fx.ids.carol].sort())
      expect(fx.env.sessions.messages(gsid).some((m) => m.content.includes('创建了群聊并邀请'))).toBe(true)
      // bob/carol 收到 inbox
      expect(fx.delivered.filter((d) => d.includes('群聊')).length).toBeGreaterThanOrEqual(2)

      // 群成员 bob（editor）邀请自己的好友 carol？carol 已在群 → 跳过；bob 邀 dave（非好友）→ 403
      const bobInviteNonFriend = await fetch(`${fx.base}/api/sessions/${gsid}/shares`, {
        method: 'POST',
        headers: { cookie: fx.cookie(fx.ids.bob), 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'dave' }),
      })
      expect(bobInviteNonFriend.status).toBe(403)

      // 团队会话邀请仍是属主专属：bob 对非成员团队会话不可见（404 不泄漏存在性——M57 语义）
      const team = fx.env.sessions.create(['pm'], '团队', { ownerId: fx.ids.me })
      const bobTeamInvite = await fetch(`${fx.base}/api/sessions/${team.id}/shares`, {
        method: 'POST',
        headers: { cookie: fx.cookie(fx.ids.bob), 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'carol' }),
      })
      expect(bobTeamInvite.status).toBe(404)
    } finally {
      await fx.close()
    }
  })

  it('群聊消息零引擎（无 @agent；participantIds 空）', async () => {
    const fx = await makeFixture()
    try {
      const created = (await (await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { memberIds: [fx.ids.bob] })).json()) as {
        session: { id: string }
      }
      const sent = await post(`${fx.base}/api/sessions/${created.session.id}/messages`, fx.cookie(fx.ids.me), { content: '大家同步一下进度' })
      expect(sent.status).toBe(201)
      expect(((await sent.json()) as { runId?: string }).runId).toBeUndefined()
      expect(fx.env.engine.listActiveRuns()).toHaveLength(0)
    } finally {
      await fx.close()
    }
  })
})

describe('M79-U：agent 回合收尾广播携带完整消息（多真人会话实时补投）', () => {
  it('混编群触发 Run → notify:turn-end 帧 payload.message = 完整 agent 消息（其他成员同会话 upsert 依据）', async () => {
    const fx = await makeFixture()
    try {
      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), { title: '补投群', memberIds: [fx.ids.bob] })
      expect(groupRes.status).toBe(201)
      const gid = ((await groupRes.json()) as { session: { id: string } }).session.id
      await post(`${fx.base}/api/sessions/${gid}/members`, fx.cookie(fx.ids.me), { agentIds: ['pm'] })

      const hit = await post(`${fx.base}/api/sessions/${gid}/messages`, fx.cookie(fx.ids.bob), { content: '@费利 给个方案' })
      expect(hit.status).toBe(201)
      const { runId, message } = (await hit.json()) as { runId: string; message: { id: string } }
      await waitRunFinished(fx.env.engine, runId, 15_000)

      // M79-W：触发型人类消息同样广播（此前仅 SSE 单播，其他真人成员看不到该消息）
      const humanFrame = fx.env.published.find(
        (x) =>
          x.type === 'notify:turn-end' &&
          x.sessionId === gid &&
          (x.payload as { message?: { id?: string } }).message?.id === message.id,
      )
      expect(humanFrame, '未找到触发型人类消息的广播帧').toBeTruthy()
      expect((humanFrame!.payload as { message: { role: string } }).message.role).toBe('user')

      const frame = fx.env.published.find(
        (x) =>
          x.type === 'notify:turn-end' &&
          x.sessionId === gid &&
          (x.payload as { message?: { role?: string } }).message?.role === 'agent',
      )
      expect(frame, '未找到携带 message 的 notify:turn-end 帧').toBeTruthy()
      const payload = frame!.payload as { messageId: string; message: { id: string; role: string; status: string; content: string } }
      expect(payload.message.role).toBe('agent')
      expect(payload.message.status).toBe('complete')
      expect(payload.message.id).toBe(payload.messageId)
      expect(payload.message.content.length).toBeGreaterThan(0)
    } finally {
      await fx.close()
    }
  })
})

describe('M79-X：编辑 / 删除消息与会话删除的广播（群聊式全同步）', () => {
  it('编辑广播更新内容且仅作者可编辑；删除与会话删除广播对应帧', async () => {
    const fx = await makeFixture()
    try {
      const patch = (url: string, cookie: string, body: unknown): Promise<globalThis.Response> =>
        fetch(url, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const del = (url: string, cookie: string): Promise<globalThis.Response> =>
        fetch(url, { method: 'DELETE', headers: { cookie } })

      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '广播群',
        memberIds: [fx.ids.bob],
      })
      expect(groupRes.status).toBe(201)
      const gid = ((await groupRes.json()) as { session: { id: string } }).session.id
      // 仅点名唤起：避免无 @ 消息触发 Run，专测消息级广播
      const mode = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.me), { routeMode: 'mention' })
      expect(mode.ok).toBeTruthy()

      const sent = await post(`${fx.base}/api/sessions/${gid}/messages`, fx.cookie(fx.ids.bob), { content: '可编辑消息' })
      expect(sent.status).toBe(201)
      const msgId = ((await sent.json()) as { message: { id: string } }).message.id

      // 编辑（作者本人）→ turn-end(message) 广播更新内容（upsert 语义）
      fx.env.published.length = 0
      const edited = await patch(`${fx.base}/api/sessions/${gid}/messages/${msgId}`, fx.cookie(fx.ids.bob), {
        content: '可编辑消息 v2',
      })
      expect(edited.status).toBe(200)
      const editFrame = fx.env.published.find(
        (x) =>
          x.type === 'notify:turn-end' &&
          x.sessionId === gid &&
          (x.payload as { message?: { id?: string } }).message?.id === msgId,
      )
      expect(editFrame, '未找到编辑广播帧').toBeTruthy()
      expect((editFrame!.payload as { message: { content: string } }).message.content).toBe('可编辑消息 v2')

      // 非作者编辑 → 403（属主亦不可代编辑）
      const deny = await patch(`${fx.base}/api/sessions/${gid}/messages/${msgId}`, fx.cookie(fx.ids.me), {
        content: '越权编辑',
      })
      expect(deny.status).toBe(403)

      // 删除（作者本人）→ notify:message-deleted 广播
      fx.env.published.length = 0
      const removed = await del(`${fx.base}/api/sessions/${gid}/messages/${msgId}`, fx.cookie(fx.ids.bob))
      expect(removed.ok).toBeTruthy()
      const delFrame = fx.env.published.find(
        (x) =>
          x.type === 'notify:message-deleted' &&
          x.sessionId === gid &&
          (x.payload as { messageId?: string }).messageId === msgId,
      )
      expect(delFrame, '未找到消息删除广播帧').toBeTruthy()

      // 会话删除（属主）→ notify:session-deleted 广播
      fx.env.published.length = 0
      const gone = await del(`${fx.base}/api/sessions/${gid}?deleteWorkspace=false`, fx.cookie(fx.ids.me))
      expect(gone.ok).toBeTruthy()
      expect(fx.env.published.find((x) => x.type === 'notify:session-deleted' && x.sessionId === gid)).toBeTruthy()
    } finally {
      await fx.close()
    }
  })
})

describe('M79-AA 群管理补全：退出 / 移出留痕 / 改名归属 / 解散广播 kind', () => {
  it('成员退群（/leave）：失去访问 + 系统事件条 + turn-end 帧；direct 退出 400 防护', async () => {
    const fx = await makeFixture()
    try {
      const created = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '退群群',
        memberIds: [fx.ids.bob, fx.ids.carol],
      })
      const gid = ((await created.json()) as { session: { id: string } }).session.id

      // bob 自助退群 → 成员表移除 + 群仍存在（owner/carol 视角）
      fx.env.published.length = 0
      const left = await post(`${fx.base}/api/sessions/${gid}/leave`, fx.cookie(fx.ids.bob))
      expect(left.status).toBe(200)
      expect(fx.env.members.list(gid).map((m) => m.userId).sort()).toEqual([fx.ids.carol].sort())
      expect(fx.env.sessions.getSession(gid)).toBeTruthy()
      // 留痕：system 事件条「bob 退出了群聊」+ 同帧广播（其他成员即时可见）
      expect(fx.env.sessions.messages(gid).some((m) => m.role === 'system' && m.content.includes('bob 退出了群聊'))).toBe(true)
      const leftFrame = fx.env.published.find(
        (x) =>
          x.type === 'notify:turn-end' &&
          x.sessionId === gid &&
          (x.payload as { message?: { content?: string } }).message?.content?.includes('bob 退出了群聊'),
      )
      expect(leftFrame, '未找到退群留痕广播帧').toBeTruthy()
      // bob 侧列表不再含该群（可见性由列表过滤决定；路由级守卫不在本夹具内）
      const bobList = (await (
        await fetch(`${fx.base}/api/sessions`, { headers: { cookie: fx.cookie(fx.ids.bob) } })
      ).json()) as { sessions: Array<{ id: string }> }
      expect(bobList.sessions.some((s) => s.id === gid)).toBe(false)
      // owner / carol 仍在群（不受他人退出影响）
      const carolList = (await (
        await fetch(`${fx.base}/api/sessions`, { headers: { cookie: fx.cookie(fx.ids.carol) } })
      ).json()) as { sessions: Array<{ id: string }> }
      expect(carolList.sessions.some((s) => s.id === gid)).toBe(true)

      // direct：退出 400 防护（设计 §12.2——只有隐藏；对方不受影响）
      const dm = (await (
        await post(`${fx.base}/api/chats/direct`, fx.cookie(fx.ids.me), { userId: fx.ids.bob })
      ).json()) as { session: { id: string } }
      const dmLeave = await post(`${fx.base}/api/sessions/${dm.session.id}/leave`, fx.cookie(fx.ids.bob))
      expect(dmLeave.status).toBe(400)
      expect(((await dmLeave.json()) as { error: string }).error).toContain('私聊不支持退出')
    } finally {
      await fx.close()
    }
  })

  it('群主移出成员：系统事件条「移出了群聊」；群名仅群主可改（editor 403）', async () => {
    const fx = await makeFixture()
    try {
      const patch = (url: string, cookie: string, body: unknown): Promise<globalThis.Response> =>
        fetch(url, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const created = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '改名群',
        memberIds: [fx.ids.bob, fx.ids.carol],
      })
      const gid = ((await created.json()) as { session: { id: string } }).session.id

      // 移出 carol → 留痕「me 将 carol 移出了群聊」
      const removed = await fetch(`${fx.base}/api/sessions/${gid}/shares/${fx.ids.carol}`, {
        method: 'DELETE',
        headers: { cookie: fx.cookie(fx.ids.me) },
      })
      expect(removed.ok).toBeTruthy()
      const meName = fx.env.auth.getUser(fx.ids.me)!.displayName
      expect(
        fx.env.sessions
          .messages(gid)
          .some((m) => m.role === 'system' && m.content.includes(`${meName} 将 carol 移出了群聊`)),
      ).toBe(true)

      // 群名：member（bob，editor）403；群主（me）200
      const deny = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.bob), { title: '越权改名' })
      expect(deny.status).toBe(403)
      expect(((await deny.json()) as { error: string }).error).toContain('属主')
      const ok = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.me), { title: '新群名' })
      expect(ok.status).toBe(200)
      expect(fx.env.sessions.getSession(gid)!.title).toBe('新群名')
      // M79-AE：治理字段统一收敛为属主——routeMode 亦仅 owner 可改（editor 403；原 M79-E 为可写）
      const bobRoute = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.bob), { routeMode: 'mention' })
      expect(bobRoute.status).toBe(403)
      const ownerRoute = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.me), { routeMode: 'mention' })
      expect(ownerRoute.status).toBe(200)
    } finally {
      await fx.close()
    }
  })

  it('解散群聊（属主删除）：广播 payload.kind=group；成员侧访问 404', async () => {
    const fx = await makeFixture()
    try {
      const created = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '解散群',
        memberIds: [fx.ids.bob],
      })
      const gid = ((await created.json()) as { session: { id: string } }).session.id

      fx.env.published.length = 0
      const gone = await fetch(`${fx.base}/api/sessions/${gid}?deleteWorkspace=false`, {
        method: 'DELETE',
        headers: { cookie: fx.cookie(fx.ids.me) },
      })
      expect(gone.ok).toBeTruthy()
      const frame = fx.env.published.find((x) => x.type === 'notify:session-deleted' && x.sessionId === gid)
      expect(frame, '未找到会话删除广播帧').toBeTruthy()
      expect((frame!.payload as { kind?: string }).kind).toBe('group')
      // 成员端后续访问 404（不可见性）
      expect((await fetch(`${fx.base}/api/sessions/${gid}`, { headers: { cookie: fx.cookie(fx.ids.bob) } })).status).toBe(404)
    } finally {
      await fx.close()
    }
  })
})

describe('M79-AA：交还目标具体化（@用户 → 全体在场真人）', () => {
  it('默认交还句（@用户）→ 该 agent 消息 humanMentions = 全部真人（交接条渲染具体名字）', async () => {
    const fx = await makeFixture()
    try {
      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '交还目标群',
        memberIds: [fx.ids.bob],
      })
      expect(groupRes.status).toBe(201)
      const gid = ((await groupRes.json()) as { session: { id: string } }).session.id
      await post(`${fx.base}/api/sessions/${gid}/members`, fx.cookie(fx.ids.me), { agentIds: ['pm'] })

      const hit = await post(`${fx.base}/api/sessions/${gid}/messages`, fx.cookie(fx.ids.bob), {
        content: '@费利 给个方案',
      })
      expect(hit.status).toBe(201)
      const { runId } = (await hit.json()) as { runId: string }
      await waitRunFinished(fx.env.engine, runId, 15_000)

      const detail = (await (
        await fetch(`${fx.base}/api/sessions/${gid}`, { headers: { cookie: fx.cookie(fx.ids.me) } })
      ).json()) as { messages: Array<{ role: string; mentions?: string[]; humanMentions?: string[] }> }
      const agentMsg = [...detail.messages].reverse().find((m) => m.role === 'agent' && m.mentions?.includes('user'))
      expect(agentMsg, '未找到交还用户的 agent 消息').toBeTruthy()
      expect(new Set(agentMsg!.humanMentions)).toEqual(new Set([fx.ids.me, fx.ids.bob]))
    } finally {
      await fx.close()
    }
  })
})

describe('M79-AE：会话治理权限收敛（owner-only）与操作通知', () => {
  it('改名 / 触发策略仅属主：editor 403；属主 200；预算外字段无影响', async () => {
    const fx = await makeFixture()
    try {
      const patch = (url: string, cookie: string, body: unknown): Promise<globalThis.Response> =>
        fetch(url, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })

      const groupRes = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '治理群',
        memberIds: [fx.ids.bob],
      })
      const gid = ((await groupRes.json()) as { session: { id: string } }).session.id

      // editor（bob）：改名 / 触发策略 均 403
      const denyTitle = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.bob), { title: '改名尝试' })
      expect(denyTitle.status).toBe(403)
      const denyMode = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.bob), { routeMode: 'mention' })
      expect(denyMode.status).toBe(403)

      // 属主（me）：通过
      const okTitle = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.me), { title: '治理群-已改名' })
      expect(okTitle.ok).toBeTruthy()
      const okMode = await patch(`${fx.base}/api/sessions/${gid}`, fx.cookie(fx.ids.me), { routeMode: 'mention' })
      expect(okMode.ok).toBeTruthy()
    } finally {
      await fx.close()
    }
  })

  it('删除会话 → 共享成员收「会话已被删除」通知；移出成员 → 被移出者收通知', async () => {
    const fx = await makeFixture()
    try {
      const del = (url: string, cookie: string): Promise<globalThis.Response> =>
        fetch(url, { method: 'DELETE', headers: { cookie } })

      // 场景一：成员在群 → 删除 → 成员收通知
      const g1Res = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '待删群',
        memberIds: [fx.ids.bob],
      })
      const g1 = ((await g1Res.json()) as { session: { id: string } }).session.id
      const gone = await del(`${fx.base}/api/sessions/${g1}?deleteWorkspace=false`, fx.cookie(fx.ids.me))
      expect(gone.ok).toBeTruthy()
      expect(fx.delivered).toContain(`${fx.ids.bob}:会话已被删除`)

      // 场景二：移出成员 → 被移出者收通知
      const g2Res = await post(`${fx.base}/api/chats/group`, fx.cookie(fx.ids.me), {
        title: '移出群',
        memberIds: [fx.ids.bob],
      })
      const g2 = ((await g2Res.json()) as { session: { id: string } }).session.id
      const removedShare = await del(`${fx.base}/api/sessions/${g2}/shares/${fx.ids.bob}`, fx.cookie(fx.ids.me))
      expect(removedShare.ok).toBeTruthy()
      expect(fx.delivered).toContain(`${fx.ids.bob}:你已被移出会话`)
    } finally {
      await fx.close()
    }
  })
})
