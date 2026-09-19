/**
 * M77 同角多魂 / 成员分身：成员键（agentId~soulId）解析、编制校验、
 * 上下文装配（标签 / 寻址指南 / 灵魂解析）、引擎多实例（点名 / 裸名全伞 / memberKey）、
 * 换装（经典覆盖 / 分身键替换 / 冲突拒绝）、移出与 fork。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, Session } from '@multi-agent/shared'
import { textOfContent } from '../src/llm/content.js'
import { resolveMembers } from '../src/orchestration/members.js'
import { buildMentionTokens, parseMentionsWithTokens } from '../src/orchestration/parser.js'
import type { ChatRequest, LlmChunk } from '../src/llm/provider.js'
import type { ApiDeps } from '../src/routes/index.js'
import { createSessionsRouter } from '../src/routes/sessions.js'
import { appendUserMessage, makeEnv, waitRunFinished } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

async function waitFor(cond: () => boolean, timeoutMs = 5000, label = '条件'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`${label}未在预期时间内满足`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function mountSessionsApi(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
  const deps = env as unknown as ApiDeps
  const app = express()
  app.use(express.json())
  app.use('/api', createSessionsRouter(deps))
  const server = app.listen(0)
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function postJson(url: string, body: unknown): Promise<globalThis.Response> {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

function patchJson(url: string, body: unknown): Promise<globalThis.Response> {
  return fetch(url, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

interface SseEvent {
  type: string
  [key: string]: unknown
}

function attachEvents(env: Env, runId: string): SseEvent[] {
  const events: SseEvent[] = []
  const res = {
    writableEnded: false,
    write: (payload: string) => {
      for (const line of payload.split('\n')) {
        if (!line.startsWith('data: ')) continue
        try {
          events.push(JSON.parse(line.slice(6)) as SseEvent)
        } catch {
          // 心跳等非 JSON 帧忽略
        }
      }
      return true
    },
    end: () => undefined,
  }
  env.engine.attach(runId, res as unknown as Parameters<typeof env.engine.attach>[1])
  return events
}

/** 覆写 provider：按请求脚本产出（收集请求供断言） */
function scriptProvider(env: Env, script: (req: ChatRequest) => LlmChunk[]): ChatRequest[] {
  const calls: ChatRequest[] = []
  const provider = env.provider as unknown as {
    chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
  }
  provider.chatStream = async function* (req) {
    const chunks = script(req)
    calls.push(req)
    for (const chunk of chunks) yield chunk
  }
  return calls
}

const AGENT_MESSAGES = (env: Env, session: Session): ChatMessage[] =>
  env.sessions.messages(session.id).filter((m) => m.role === 'agent')

// ---------- 成员解析与 @ 寻址 ----------

describe('M77：成员解析与 @ 寻址', () => {
  it('resolveMembers：多实例标签 = 名字·灵魂名；单实例保持角色名（零外观回归）', () => {
    const env = makeEnv()
    const multi = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '多实例', { souls: {} })
    const infos = resolveMembers(multi, env.prompts)
    expect(infos.map((m) => m.key)).toEqual(['ideator', 'ideator~zen', 'pm'])
    expect(infos.map((m) => m.label)).toEqual(['卢娜·狂野', '卢娜·禅意', '费利'])
    expect(infos[0].soulId).toBe('wild')
    expect(infos[1].soulId).toBe('zen')
    expect(infos[0].siblingCount).toBe(2)

    const single = env.sessions.create(['ideator', 'pm'], '单实例', { souls: { ideator: 'zen' } })
    expect(resolveMembers(single, env.prompts).map((m) => m.label)).toEqual(['卢娜', '费利'])
  })

  it('buildMentionTokens：裸名/角色 id → 主实例（编制序首位）；名字·灵魂名 / 分身键 → 单实例', () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], 'token')
    const tokens = buildMentionTokens(resolveMembers(session, env.prompts))
    const map = new Map(tokens.map((t) => [t.token, t.members]))
    // 裸名 = 主实例（首人格 / 编制首位）：全伞改为逐一点名（Composer「全部 N 位」一键插入）
    expect(map.get('卢娜')).toEqual(['ideator'])
    expect(map.get('ideator')).toEqual(['ideator'])
    expect(map.get('卢娜·狂野')).toEqual(['ideator'])
    expect(map.get('卢娜·禅意')).toEqual(['ideator~zen'])
    expect(map.get('ideator~zen')).toEqual(['ideator~zen'])
    expect(map.get('费利')).toEqual(['pm'])
    // 单实例无后缀 token（存量外观）：若把 pm 单列，'费利·无' 不出现
    expect(map.has('费利·')).toBe(false)
    // 主实例换装后（分身键替换）：裸名仍指向当前编制首位对应实例
    const swapped = resolveMembers(
      { ...session, participantIds: ['ideator~zen', 'ideator', 'pm'] },
      env.prompts,
    )
    const map2 = new Map(buildMentionTokens(swapped).map((t) => [t.token, t.members]))
    expect(map2.get('卢娜')).toEqual(['ideator~zen'])
  })

  it('parseMentionsWithTokens：点名只命中实例；裸名 = 主实例；显式双 token = 全伞（去重按出现序）；边界不误配', () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], 'parse')
    const tokens = buildMentionTokens(resolveMembers(session, env.prompts))

    expect(parseMentionsWithTokens('@卢娜·禅意 出个点子', tokens).mentions).toEqual(['ideator~zen'])
    // 裸名 = 主实例（不再 fan-out）
    expect(parseMentionsWithTokens('@卢娜 你先说说', tokens).mentions).toEqual(['ideator'])
    // 显式全伞：逐一点名（编制序去重）
    expect(parseMentionsWithTokens('@卢娜·狂野 @卢娜·禅意 你俩都来说说', tokens).mentions).toEqual([
      'ideator',
      'ideator~zen',
    ])
    expect(parseMentionsWithTokens('先 @卢娜·禅意 再 @卢娜·狂野', tokens).mentions).toEqual(['ideator~zen', 'ideator'])
    // 裸名 + 点名混用：主实例与另一实例均命中
    expect(parseMentionsWithTokens('@卢娜 加上 @卢娜·禅意', tokens).mentions).toEqual(['ideator', 'ideator~zen'])
    // BOUNDARY：`@卢娜·狂野哦` 视为更长名字，不命中（防误配）
    expect(parseMentionsWithTokens('@卢娜·狂野哦 你好', tokens).mentions).toEqual([])
    expect(parseMentionsWithTokens('@卢娜·狂野，请继续', tokens).mentions).toEqual(['ideator'])
  })
})

// ---------- 编制校验（创建 / 换装 / 移出） ----------

describe('M77：编制校验与成员三写', () => {
  it('创建：合法混合编制 201；同角同魂 400；分身灵魂不存在 400；无灵魂角色分身 400；souls 携带分身键 400', async () => {
    const env = makeEnv()
    const api = await mountSessionsApi(env)
    try {
      const ok = await postJson(`${api.url}/api/sessions`, {
        participantIds: ['pm', 'ideator', 'ideator~zen'],
        souls: { ideator: 'wild' },
      })
      expect(ok.status).toBe(201)
      const body = (await ok.json()) as { session: Session }
      // 排序：按资产链序（场景 → 链序），同角色实例保持相对顺序
      expect(body.session.participantIds).toEqual(['pm', 'ideator', 'ideator~zen'])

      const dup = await postJson(`${api.url}/api/sessions`, {
        participantIds: ['ideator', 'ideator~wild'],
      })
      expect(dup.status).toBe(400)
      expect(((await dup.json()) as { error: string }).error).toContain('不能使用相同灵魂')

      const ghost = await postJson(`${api.url}/api/sessions`, {
        participantIds: ['ideator~ghost'],
      })
      expect(ghost.status).toBe(400)
      expect(((await ghost.json()) as { error: string }).error).toContain('灵魂不存在：ideator/ghost')

      const noSoul = await postJson(`${api.url}/api/sessions`, {
        participantIds: ['pm~wild'],
      })
      expect(noSoul.status).toBe(400)

      const soulsPinned = await postJson(`${api.url}/api/sessions`, {
        participantIds: ['ideator~zen'],
        souls: { 'ideator~zen': 'zen' },
      })
      expect(soulsPinned.status).toBe(400)
      expect(((await soulsPinned.json()) as { error: string }).error).toContain('灵魂内嵌在成员键中')
    } finally {
      await api.close()
    }
  })

  it('经典换装：与同角实例灵魂冲突 400；换到未占用灵魂 200（memberSouls + 事件条）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '换装')
    const api = await mountSessionsApi(env)
    try {
      const clash = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator`, { soul: 'zen' })
      expect(clash.status).toBe(400)
      expect(((await clash.json()) as { error: string }).error).toContain('其他实例占用')

      const ok = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator`, { soul: 'scholar' })
      expect(ok.status).toBe(200)
      const body = (await ok.json()) as { session: Session; message: ChatMessage }
      expect(body.session.memberSouls).toEqual({ ideator: 'scholar' })
      // 同角多实例：事件条用实例标签（单实例仍为角色名，零回归）
      expect(body.message.content).toBe('卢娜·狂野 换上了『考据派』灵魂')
    } finally {
      await api.close()
    }
  })

  it('分身换装：键替换（participantIds 原位替换 + 事件条带实例标签）；恢复默认 400；同灵魂 400；冲突 400', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '分身换装')
    const api = await mountSessionsApi(env)
    try {
      const reset = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { soul: null })
      expect(reset.status).toBe(400)
      expect(((await reset.json()) as { error: string }).error).toContain('不支持恢复默认灵魂')

      const same = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { soul: 'zen' })
      expect(same.status).toBe(400)

      const swap = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { soul: 'scholar' })
      expect(swap.status).toBe(200)
      const body = (await swap.json()) as { session: Session; message: ChatMessage }
      expect(body.session.participantIds).toEqual(['ideator', 'ideator~scholar', 'pm'])
      expect(body.message.content).toBe('卢娜·禅意 换上了『考据派』灵魂')

      // 换回 zen？zen 已空出；再把经典实例换成 scholar → 应被分身占用拒绝
      const clash = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator`, { soul: 'scholar' })
      expect(clash.status).toBe(400)
    } finally {
      await api.close()
    }
  })

  it('移出分身：实例移除 + 事件条带标签；经典换装恢复默认后成员键不变', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen'], '移出')
    const api = await mountSessionsApi(env)
    try {
      const del = await fetch(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { method: 'DELETE' })
      expect(del.status).toBe(200)
      const body = (await del.json()) as { session: Session; message: ChatMessage }
      expect(body.session.participantIds).toEqual(['ideator'])
      expect(body.message.content).toBe('卢娜·禅意 离开了协作')

      // 经典恢复默认（无覆盖）：保持现状文案
      const session2 = env.sessions.create(['ideator'], '恢复', { souls: { ideator: 'zen' } })
      const reset = await patchJson(`${api.url}/api/sessions/${session2.id}/members/ideator`, { soul: null })
      expect(reset.status).toBe(200)
      const resetBody = (await reset.json()) as { session: Session; message: ChatMessage }
      expect(resetBody.session.memberSouls).toBeUndefined()
      expect(resetBody.message.content).toBe('卢娜 恢复了默认灵魂')
    } finally {
      await api.close()
    }
  })

  it('邀请：可追加分身（已占用灵魂 400；未占用 201）；fork 保留成员键与灵魂覆盖', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen'], '邀请', { souls: { ideator: 'wild' } })
    const api = await mountSessionsApi(env)
    try {
      const clash = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['ideator~wild'],
      })
      expect(clash.status).toBe(400)
      expect(((await clash.json()) as { error: string }).error).toContain('相同灵魂')

      const add = await postJson(`${api.url}/api/sessions/${session.id}/members`, {
        agentIds: ['ideator~scholar'],
      })
      expect(add.status).toBe(201)
      const added = (await add.json()) as { session: Session }
      expect(added.session.participantIds).toEqual(['ideator', 'ideator~zen', 'ideator~scholar'])

      // fork：成员键与 memberSouls 原样复制
      const user = appendUserMessage(env, session.id, '定个方向')
      const fork = await postJson(`${api.url}/api/sessions/${session.id}/fork`, { fromMessageId: user.id })
      expect(fork.status).toBe(201)
      const forkBody = (await fork.json()) as { session: Session }
      expect(forkBody.session.participantIds).toEqual(['ideator', 'ideator~zen', 'ideator~scholar'])
      expect(forkBody.session.memberSouls).toEqual({ ideator: 'wild' })
    } finally {
      await api.close()
    }
  })
})

// ---------- 上下文装配 ----------

describe('M77：上下文装配（roster / 寻址指南 / 灵魂解析）', () => {
  it('多实例：roster 行带实例键与标签、注入寻址指南与身份标识；分身灵魂段命中键后缀', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '装配')
    const prepared = await env.context.prepareTurn({ sessionId: session.id, agentId: 'ideator~zen', runId: 'run_x', queue: [] })
    expect(prepared.system).toContain('卢娜·狂野（ideator｜狂想发散者）')
    expect(prepared.system).toContain('卢娜·禅意（ideator~zen｜狂想发散者）')
    expect(prepared.system).toContain(
      '同名多实例寻址：@名字 只召集该角色的主实例（编制首位）；想让同角多位分身同时上场，请逐一点名（@名字·灵魂名）。',
    )
    expect(prepared.system).toContain('你的灵魂：禅意（zen）')
    expect(prepared.system).toContain('你在本会话的身份标识：卢娜·禅意（ideator~zen）')

    // 经典实例（同角多实例）也注入身份标识（标签含默认灵魂名）
    const classic = await env.context.prepareTurn({ sessionId: session.id, agentId: 'ideator', runId: 'run_x', queue: [] })
    expect(classic.system).toContain('你在本会话的身份标识：卢娜·狂野（ideator）')
    expect(classic.system).toContain('你的灵魂：狂野（wild）')

    // 单实例回归：无寻址指南、无身份标识（存量外观零变化）
    const single = env.sessions.create(['ideator', 'pm'], '单实例')
    const sp = await env.context.prepareTurn({ sessionId: single.id, agentId: 'ideator', runId: 'run_x', queue: [] })
    expect(sp.system).not.toContain('同名多实例寻址')
    expect(sp.system).not.toContain('你在本会话的身份标识')
  })
})

// ---------- 引擎集成 ----------

describe('M77：引擎多实例（点名单实例 / 裸名全伞 / memberKey 透传）', () => {
  it('@点名分身：仅该实例出场，soul 透传；消息 agentId=基础角色、memberKey=实例键；turn 事件携带 memberKey', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '点名')
    const requests = scriptProvider(env, (req) => {
      const text = req.meta.agentId === 'ideator~zen' ? '禅意点子一枚。\n@用户' : '不应出场。'
      return [
        { type: 'text', text },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '@卢娜·禅意 出个点子')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    expect(requests).toHaveLength(1)
    const req = requests[0]
    expect(req.meta.agentId).toBe('ideator~zen')
    expect(req.meta.soul).toBe('zen')
    expect(req.meta.participantIds).toEqual(['ideator', 'ideator~zen', 'pm'])
    expect(req.meta.memberLabels?.['ideator~zen']).toBe('卢娜·禅意')

    const msgs = AGENT_MESSAGES(env, session)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].agentId).toBe('ideator')
    expect(msgs[0].memberKey).toBe('ideator~zen')
    expect(msgs[0].content).toContain('禅意点子一枚')

    const turnStart = events.find((e) => e.type === 'turn:start')!
    expect(turnStart.agentId).toBe('ideator')
    expect(turnStart.memberKey).toBe('ideator~zen')
    // 用户消息 mentions 持久化为实例键
    expect(env.sessions.messages(session.id).find((m) => m.role === 'user')?.mentions).toEqual(['ideator~zen'])
  })

  it('显式全伞（逐一点名）：两实例依次出场（串行），各自灵魂透传；交接点到名实例', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '全伞')
    const requests = scriptProvider(env, (req) => {
      if (req.meta.agentId === 'ideator') {
        return [
          { type: 'text', text: '狂野点子先来。\n@卢娜·禅意 你也补一个' },
          { type: 'done' },
        ]
      }
      return [
        { type: 'text', text: '禅意点子收尾。\n@用户' },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '@卢娜·狂野 @卢娜·禅意 你俩都来说说')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves.map((w) => w.members)).toEqual([['ideator'], ['ideator~zen']])
    const souls = requests.map((r) => r.meta.soul)
    expect(souls).toEqual(['wild', 'zen'])
    const msgs = AGENT_MESSAGES(env, session)
    expect(msgs.map((m) => m.memberKey)).toEqual(['ideator', 'ideator~zen'])
    expect(msgs.map((m) => m.agentId)).toEqual(['ideator', 'ideator'])
    // 显式全伞：用户消息 mentions = 两个实例（逐一点名，编制序）
    expect(env.sessions.messages(session.id).find((m) => m.role === 'user')?.mentions).toEqual([
      'ideator',
      'ideator~zen',
    ])
  })

  it('@裸名 = 主实例：只编制首位实例出场（未点名的分身不入队）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '裸名主实例')
    const requests = scriptProvider(env, () => [
      { type: 'text', text: '狂野先说。\n@用户' },
      { type: 'done' },
    ])
    const user = appendUserMessage(env, session.id, '@卢娜 你先说说')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves.map((w) => w.members)).toEqual([['ideator']])
    expect(requests.map((r) => r.meta.soul)).toEqual(['wild'])
    expect(AGENT_MESSAGES(env, session).map((m) => m.memberKey)).toEqual(['ideator'])
    // 裸名持久化为单个主实例键（不再 fan-out）
    expect(env.sessions.messages(session.id).find((m) => m.role === 'user')?.mentions).toEqual(['ideator'])
  })

  it('并行波：serial=false + 显式全伞 → 两实例同波并行（各带灵魂、并行指令含双方标签）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen', 'pm'], '并行多实例', { serial: false })
    const requests = scriptProvider(env, (req) => {
      const text = req.meta.agentId === 'ideator' ? '狂野角度。\n@用户' : '禅意角度。\n@用户'
      return [
        { type: 'text', text },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '@卢娜·狂野 @卢娜·禅意 同时来两版')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    await waitRunFinished(env.engine, runId)

    const waves = events.filter((e) => e.type === 'wave:start')
    expect(waves).toHaveLength(1)
    expect(waves[0].members).toEqual(['ideator', 'ideator~zen'])
    expect(requests.map((r) => r.meta.soul).sort()).toEqual(['wild', 'zen'])
    // 并行波指令按实例标签展示（双方互见同一并行成员行）
    const bi = requests.find((r) => r.meta.agentId === 'ideator')!
    const bz = requests.find((r) => r.meta.agentId === 'ideator~zen')!
    expect(textOfContent(bi.messages.at(-1)?.content ?? '')).toContain('本波并行成员：卢娜·狂野、卢娜·禅意')
    expect(textOfContent(bz.messages.at(-1)?.content ?? '')).toContain('本波并行成员：卢娜·狂野、卢娜·禅意')
  })

  it('运行中分身换装：键替换同步队列与交接解析（旧队列 → 新实例接手，灵魂随之切换）', async () => {
    const env = makeEnv()
    // 同角双实例在场（多实例 → 实例级 token「@卢娜·禅意」可解析；单实例时展示与 token 均为裸名，属另一口径）
    const session = env.sessions.create(['pm', 'ideator', 'ideator~zen'], '运行中换装')
    // 门控 provider：pm 回合悬起（保持 zen 在队列中），待换装后再放行
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const requests: ChatRequest[] = []
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      requests.push(req)
      if (req.meta.agentId === 'pm') await gate
      const text = req.meta.agentId === 'pm' ? '收到，我先把需求定下来。\n@卢娜·考据派 接力给你。' : '考据角度收尾。\n@用户'
      yield { type: 'text', text }
      yield { type: 'done' }
    }
    // 用户 @pm 首棒（@卢娜·禅意 排在其后入队）
    const user = appendUserMessage(env, session.id, '@费利 先定需求，@卢娜·禅意 随后补充')
    const { runId } = env.engine.launch(session.id, user.id)
    const api = await mountSessionsApi(env)
    try {
      await waitFor(() => env.engine.isMemberActive(runId, 'pm'), 5000, 'pm 回合开始')
      expect(env.engine.activeRunOf(session.id)?.queue).toEqual(['ideator~zen'])

      const swap = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { soul: 'scholar' })
      expect(swap.status).toBe(200)
      const body = (await swap.json()) as { session: Session }
      expect(body.session.participantIds).toEqual(['pm', 'ideator', 'ideator~scholar'])
      // 队列同步：旧实例键已替换为新实例键（未出手位次不变）
      expect(env.engine.activeRunOf(session.id)?.queue).toEqual(['ideator~scholar'])

      release?.()
      await waitRunFinished(env.engine, runId)
      const msgs = AGENT_MESSAGES(env, session)
      expect(msgs.map((m) => m.memberKey)).toEqual(['pm', 'ideator~scholar'])
      const second = requests.find((r) => r.meta.agentId === 'ideator~scholar')!
      expect(second.meta.soul).toBe('scholar')
    } finally {
      release?.()
      await api.close()
    }
  })

  it('自描述回退：实例已移除，历史发言在路由上下文仍以 `名字·灵魂名` 署名', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator~zen', 'pm'], '回退标签')
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'ideator',
      memberKey: 'ideator~zen',
      content: '禅意点子先放这里。',
      mentions: [],
      status: 'complete',
    })
    // 移除分身 → 历史消息仅在 memberKey 中留痕（键内嵌灵魂可自描述还原）
    env.sessions.setParticipants(session.id, ['pm'])

    const requests = scriptProvider(env, (req) => {
      if (req.meta.agentId === '__router__') {
        const plan = {
          members: [],
          assignments: [{ agentId: 'pm', task: '接续推进并把结论落成交付件' }],
          reason: '在场成员可覆盖',
        }
        return [
          { type: 'text', text: JSON.stringify(plan) },
          { type: 'done' },
        ]
      }
      return [
        { type: 'text', text: '收到，继续推进。\n@用户' },
        { type: 'done' },
      ]
    })
    const user = appendUserMessage(env, session.id, '继续推进一下')
    const { runId } = env.engine.launch(session.id, user.id)
    await waitRunFinished(env.engine, runId)

    const routerReq = requests.find((r) => r.meta.agentId === '__router__')!
    expect(routerReq).toBeTruthy()
    const text = routerReq.messages.map((m) => textOfContent(m.content)).join('\n')
    // routeByPlatform 最近上下文署名：自描述回退 → 卢娜·禅意（不裸秀 memberKey）
    expect(text).toContain('[卢娜·禅意]')
  })

  it('会话列表预览：lastMessage.memberKey 落库回读（分身署名；无键历史消息缺省）', () => {
    const env = makeEnv()
    const session = env.sessions.create(['ideator', 'ideator~zen'], '预览署名')
    env.sessions.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'ideator',
      memberKey: 'ideator~zen',
      content: '禅意收官。',
      mentions: [],
      status: 'complete',
    })
    const row = env.sessions.list(null).find((s) => s.id === session.id)!
    expect(row.lastMessage?.agentId).toBe('ideator')
    expect(row.lastMessage?.memberKey).toBe('ideator~zen')
    // 存量 / 历史语义：无 memberKey 的消息 → 预览不携带（前端按角色名回退）
    const legacy = env.sessions.create(['pm'], '经典')
    env.sessions.appendMessage({
      sessionId: legacy.id,
      role: 'agent',
      agentId: 'pm',
      content: '经典收官。',
      mentions: [],
      status: 'complete',
    })
    const row2 = env.sessions.list(null).find((s) => s.id === legacy.id)!
    expect(row2.lastMessage?.agentId).toBe('pm')
    expect(row2.lastMessage?.memberKey).toBeUndefined()
  })

  it('运行中换装：已发言席位随键迁移（同一 Run 内不借换装重复出手）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['pm', 'ideator~zen', 'ideator'], '换装台账')
    const requests: ChatRequest[] = []
    let release: (() => void) | undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const provider = env.provider as unknown as {
      chatStream: (req: ChatRequest, signal: AbortSignal) => AsyncIterable<LlmChunk>
    }
    provider.chatStream = async function* (req) {
      requests.push(req)
      if (req.meta.agentId === 'ideator~zen') {
        yield { type: 'text', text: '禅意开场。\n@费利 接力' }
        yield { type: 'done' }
        return
      }
      if (req.meta.agentId === 'pm') {
        // 门控：pm 回合悬起（此时 zen 已出手、可安全换装）
        await gate
        yield { type: 'text', text: '收到，先按这个来。' }
        yield { type: 'done' }
        return
      }
      yield { type: 'text', text: '补一版角度。\n@用户' }
      yield { type: 'done' }
    }
    const user = appendUserMessage(env, session.id, '@卢娜·禅意 先开场')
    const { runId } = env.engine.launch(session.id, user.id)
    const events = attachEvents(env, runId)
    const api = await mountSessionsApi(env)
    try {
      await waitFor(() => env.engine.isMemberActive(runId, 'pm'), 5000, 'pm 回合开始')
      const swap = await patchJson(`${api.url}/api/sessions/${session.id}/members/ideator~zen`, { soul: 'scholar' })
      expect(swap.status).toBe(200)
      release?.()
      await waitRunFinished(env.engine, runId)
      // 已发言史随席位移交：pm 无交接 → fallback 选未出手的经典实例（而非被换上的新键）
      const waves = events.filter((e) => e.type === 'wave:start')
      expect(waves.map((w) => w.members)).toEqual([['ideator~zen'], ['pm'], ['ideator']])
    } finally {
      release?.()
      await api.close()
    }
  })
})
