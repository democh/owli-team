/**
 * 消息分页契约测试（2026-09-22）：
 * - GET /api/sessions/:id?limit=N → 最近 N 条 + hasMore / totalCount / memberStats（全量口径）；
 * - before=<seq> → 该 seq 之前的更早一页（游标前翻）；
 * - 缺省不带参数 = 全量返回（既有客户端 / 测试锚点零变化）；
 * - memberStats 覆盖全部历史（前端仅加载最近一页，统计不能缺）。
 */
import type { AddressInfo } from 'node:net'
import express from 'express'
import { describe, expect, it } from 'vitest'
import { createSessionsRouter } from '../src/routes/sessions.js'
import type { ApiDeps } from '../src/routes/index.js'
import { makeEnv } from './helpers.js'

type Env = ReturnType<typeof makeEnv>

async function mountApi(env: Env): Promise<{ url: string; close: () => Promise<void> }> {
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

/** 造 12 条消息（6 条用户 + 6 条 agent；agent 消息各带 1 个交付件） */
function seedMessages(env: Env, sessionId: string): void {
  for (let i = 1; i <= 6; i++) {
    env.sessions.appendMessage({ sessionId, role: 'user', content: `需求 ${i}`, mentions: [], status: 'complete' })
    env.sessions.appendMessage({
      sessionId,
      role: 'agent',
      agentId: 'backend',
      content: `实现 ${i}`,
      mentions: [],
      status: 'complete',
      artifacts: [`workspace/out-${i}.md`],
    })
  }
}

describe('消息分页（GET /api/sessions/:id?limit&before）', () => {
  it('limit=5 → 最近 5 条 + hasMore + totalCount + memberStats 全量口径', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], '分页')
    seedMessages(env, session.id)
    const api = await mountApi(env)
    try {
      const res = await fetch(`${api.url}/api/sessions/${session.id}?limit=5`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        messages: Array<{ seq?: number; content: string }>
        hasMore: boolean
        totalCount: number
        memberStats: Record<string, { speaks: number; artifacts: number }>
      }
      expect(body.messages).toHaveLength(5)
      expect(body.hasMore).toBe(true)
      expect(body.totalCount).toBe(12)
      // 最近一页 = seq 8..12（最后 5 条，升序：实现 4 / 需求 5 / 实现 5 / 需求 6 / 实现 6）
      expect(body.messages[0]!.content).toBe('实现 4')
      expect(body.messages[4]!.content).toBe('实现 6')
      // memberStats 覆盖全部 6 条 agent 消息与 6 件交付（而非仅页内 2 条）
      expect(body.memberStats['backend']).toEqual({ speaks: 6, artifacts: 6 })
    } finally {
      await api.close()
    }
  })

  it('before=<seq> → 更早一页；穷尽后 hasMore=false', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], '分页')
    seedMessages(env, session.id)
    const api = await mountApi(env)
    try {
      const first = await (await fetch(`${api.url}/api/sessions/${session.id}?limit=5`)).json() as {
        messages: Array<{ seq?: number }>
      }
      const oldestSeq = first.messages[0]!.seq!
      const res = await fetch(`${api.url}/api/sessions/${session.id}?limit=5&before=${oldestSeq}`)
      const body = (await res.json()) as { messages: Array<{ seq?: number; content: string }>; hasMore: boolean }
      expect(body.messages).toHaveLength(5)
      expect(body.messages.every((m) => (m.seq ?? 0) < oldestSeq)).toBe(true)
      expect(body.hasMore).toBe(true) // 还剩 seq 1..2
      const second = await (
        await fetch(`${api.url}/api/sessions/${session.id}?limit=5&before=${body.messages[0]!.seq}`)
      ).json() as { messages: unknown[]; hasMore: boolean }
      expect(second.messages).toHaveLength(2)
      expect(second.hasMore).toBe(false)
    } finally {
      await api.close()
    }
  })

  it('缺省不带参数 → 全量返回且无分页字段（兼容既有客户端）', async () => {
    const env = makeEnv()
    const session = env.sessions.create(['backend'], '分页')
    seedMessages(env, session.id)
    const api = await mountApi(env)
    try {
      const body = (await (await fetch(`${api.url}/api/sessions/${session.id}`)).json()) as {
        messages: unknown[]
        hasMore?: boolean
      }
      expect(body.messages).toHaveLength(12)
      expect(body.hasMore).toBeUndefined()
    } finally {
      await api.close()
    }
  })
})
