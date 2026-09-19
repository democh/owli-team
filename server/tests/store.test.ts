/**
 * M1 地基测试：迁移幂等、写入-落盘-重读一致性、FTS 检索、JSON 导入、settings 覆盖。
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { applySettingsToConfig, readSettingsFile, writeSettingsFile } from '../src/settings.js'
import { applyMigrations, openDatabase } from '../src/store/db.js'
import { importLegacySessions, pendingLegacyFiles } from '../src/store/legacy-import.js'
import { SessionStore } from '../src/store/sessions.js'
import { makeTmpDir } from './helpers.js'

describe('数据库迁移', () => {
  it('空库迁移出全部表，且重复执行幂等', () => {
    const db = openDatabase(':memory:', { memory: true })
    const versions = db.all<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version')
    expect(versions.map((v) => Number(v.version))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

    const again = applyMigrations(db)
    expect(again.applied).toEqual([])

    const tables = db
      .all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .map((t) => t.name)
    for (const name of [
      'sessions',
      'messages',
      'runs',
      'summaries',
      'memory',
      'memory_vectors',
      'embedding_cache',
      'memory_embed_queue',
      'task_items',
      'artifact_versions',
      'plans',
      'reviews',
      'mcp_servers',
      'session_mcp_servers',
    ]) {
      expect(tables).toContain(name)
    }
    db.close()
  })

  it('旧库缺 v3 记录但列已存在：duplicate column 特赦并补记（审核 fix-low）', () => {
    const db = openDatabase(':memory:', { memory: true })
    // 模拟旧库：结构已达 v3（member_souls 列存在），但 schema_migrations 缺 v3 记录
    db.run('DELETE FROM schema_migrations WHERE version = 3')
    const report = applyMigrations(db)
    expect(report.skipped).toEqual([])
    expect(report.applied).toContain(3)
    const row = db.get<{ version: number }>('SELECT version FROM schema_migrations WHERE version = 3')
    expect(Number(row?.version)).toBe(3)
    db.close()
  })

  it('文件库：写入 → 落盘 → 新进程重读一致', () => {
    const dir = makeTmpDir('ma-db-')
    const file = path.join(dir, 'app.db')

    const db1 = openDatabase(file)
    const store1 = new SessionStore(db1)
    const session = store1.create(['pm', 'qa'], '落盘一致性')
    store1.appendMessage({ sessionId: session.id, role: 'user', content: '需求：登录', mentions: [], status: 'complete' })
    store1.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '已产出需求文档',
      mentions: ['qa'],
      status: 'complete',
      artifacts: ['docs/需求.md'],
    })
    store1.close()
    db1.close()

    const db2 = openDatabase(file)
    const store2 = new SessionStore(db2)
    const reloaded = store2.get(session.id)
    expect(reloaded?.messages).toHaveLength(2)
    expect(reloaded?.messages[0].content).toBe('需求：登录')
    expect(reloaded?.messages[0].turnIndex).toBe(-1)
    expect(reloaded?.messages[1].seq).toBe(2)
    expect(reloaded?.messages[1].artifacts).toEqual(['docs/需求.md'])
    expect(store2.countMessages(session.id)).toBe(2)
    db2.close()
  })

  it('启动恢复：streaming 遗留消息被标记为 stopped', () => {
    const db = openDatabase(':memory:', { memory: true })
    const store = new SessionStore(db)
    const session = store.create(['pm'])
    const message = store.appendMessage({
      sessionId: session.id,
      role: 'agent',
      agentId: 'pm',
      content: '半截',
      mentions: [],
      status: 'streaming',
    })
    store.saveNow(session.id)

    // 模拟进程重启：同一库上新建 Store
    const store2 = new SessionStore(db)
    expect(store2.messageById(session.id, message.id)?.status).toBe('stopped')
    db.close()
  })

  it('FTS：中文子串可检索（trigram）', () => {
    const db = openDatabase(':memory:', { memory: true })
    const store = new SessionStore(db)
    const session = store.create(['pm'])
    store.appendMessage({
      sessionId: session.id,
      role: 'user',
      content: '我们讨论一下支付回调的幂等设计',
      mentions: [],
      status: 'complete',
    })
    const hits = store.search('幂等设计')
    expect(hits.length).toBe(1)
    expect(hits[0].sessionId).toBe(session.id)
    expect(store.search('不存在的词')).toHaveLength(0)
    db.close()
  })
})

describe('旧 JSON 导入', () => {
  function writeLegacy(dir: string, id: string, count: number): string {
    const file = path.join(dir, `${id}.json`)
    fs.writeFileSync(
      file,
      JSON.stringify({
        session: {
          id,
          title: `历史会话 ${id}`,
          participantIds: ['pm', 'qa'],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:01.000Z',
        },
        messages: Array.from({ length: count }, (_, i) => ({
          id: `${id}_m${i}`,
          sessionId: id,
          runId: 'run_x',
          role: i % 2 === 0 ? 'user' : 'agent',
          agentId: i % 2 === 0 ? undefined : 'pm',
          content: `第 ${i} 条`,
          mentions: [],
          status: 'complete',
          createdAt: `2026-01-01T00:00:0${i}.000Z`,
        })),
      }),
    )
    return file
  }

  it('条数一致 + 标记文件 + 幂等重跑', () => {
    const sessionsDir = makeTmpDir('ma-legacy-')
    writeLegacy(sessionsDir, 's_old1', 5)
    writeLegacy(sessionsDir, 's_old2', 3)
    const db = openDatabase(':memory:', { memory: true })

    expect(pendingLegacyFiles(sessionsDir)).toHaveLength(2)
    const result = importLegacySessions(db, sessionsDir)
    expect(result.failed).toEqual([])
    expect(result.imported).toHaveLength(2)
    expect(result.messageCount).toBe(8)

    const counts = db.all<{ session_id: string; n: number }>(
      'SELECT session_id, COUNT(*) AS n FROM messages GROUP BY session_id ORDER BY session_id',
    )
    expect(counts.map((c) => Number(c.n))).toEqual([5, 3])

    // 原 JSON 保留 + 标记文件存在
    expect(fs.existsSync(path.join(sessionsDir, 's_old1.json'))).toBe(true)
    expect(fs.existsSync(path.join(sessionsDir, 's_old1.json.imported'))).toBe(true)

    // 幂等：再次导入 → 全部跳过，条数不变
    expect(pendingLegacyFiles(sessionsDir)).toHaveLength(0)
    const second = importLegacySessions(db, sessionsDir)
    expect(second.imported).toEqual([])
    expect(second.skipped).toHaveLength(2)
    expect(
      Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages')?.n),
    ).toBe(8)
    db.close()
  })

  it('坏文件：失败并保留原文件，不写入半份数据', () => {
    const sessionsDir = makeTmpDir('ma-legacy-bad-')
    fs.writeFileSync(path.join(sessionsDir, 'broken.json'), '{ not-json')
    const db = openDatabase(':memory:', { memory: true })
    const result = importLegacySessions(db, sessionsDir)
    expect(result.failed).toHaveLength(1)
    expect(result.imported).toEqual([])
    expect(fs.existsSync(path.join(sessionsDir, 'broken.json.imported'))).toBe(false)
    expect(Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n)).toBe(0)
    db.close()
  })
})

describe('运行期设置覆盖', () => {
  it('写入 → 读取 → 覆盖 cfg（含非法字段忽略）', () => {
    const dir = makeTmpDir('ma-settings-')
    const file = path.join(dir, 'settings.json')
    const cfg = loadConfig()

    writeSettingsFile(file, { llmModel: 'deepseek-reasoner', maxTurnsPerRun: 4, approvalMode: 'all' })
    const loaded = readSettingsFile(file)
    expect(loaded.llmModel).toBe('deepseek-reasoner')
    expect(loaded.maxTurnsPerRun).toBe(4)

    applySettingsToConfig(cfg, loaded)
    expect(cfg.llmModel).toBe('deepseek-reasoner')
    expect(cfg.maxTurnsPerRun).toBe(4)
    expect(cfg.approvalMode).toBe('all')
  })

  it('非法值：写入抛错，读取忽略并回退 env 默认', () => {
    const dir = makeTmpDir('ma-settings-')
    const file = path.join(dir, 'settings.json')
    expect(() => writeSettingsFile(file, { maxTurnsPerRun: 0 })).toThrow(/设置校验失败/)

    fs.writeFileSync(file, JSON.stringify({ maxTurnsPerRun: -3, llmModel: 'ok-model', unknownKey: 1 }))
    const loaded = readSettingsFile(file)
    expect(loaded.maxTurnsPerRun).toBeUndefined()
    expect(loaded.llmModel).toBe('ok-model')
    expect(Object.keys(loaded)).not.toContain('unknownKey')
  })

  it('损坏文件不阻断启动', () => {
    const dir = makeTmpDir('ma-settings-')
    const file = path.join(dir, 'settings.json')
    fs.writeFileSync(file, '{{{')
    expect(readSettingsFile(file)).toEqual({})
  })
})
