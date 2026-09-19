/**
 * 旧 JSON 会话导入（M1）：`data/sessions/*.json` → SQLite。
 *
 * 幂等策略：每个文件导入并校验通过后写 `<file>.json.imported` 标记；原 JSON **保留不删**。
 * 校验策略：导入在事务内完成，随后对比「实际落库条数 == JSON 条数」，不一致即抛错回滚。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Session } from '@multi-agent/shared'
import type { AppDb } from './db.js'

export interface LegacyImportResult {
  imported: string[]
  skipped: string[]
  failed: Array<{ file: string; error: string }>
  sessionCount: number
  messageCount: number
}

interface LegacyFile {
  session: Session
  messages: ChatMessage[]
}

function parseLegacyFile(file: string): LegacyFile {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  const data = raw as Partial<LegacyFile>
  if (!data || typeof data !== 'object' || !data.session || !Array.isArray(data.messages)) {
    throw new Error('结构不符合 { session, messages } 约定')
  }
  const session = data.session
  if (!session.id || !Array.isArray(session.participantIds)) {
    throw new Error('session 字段缺失（id / participantIds）')
  }
  return { session, messages: data.messages }
}

/** 旧数据无 turnIndex：用户消息记为 -1，Agent 消息按同 Run 内出现次序推导（0 基） */
function deriveTurnIndexes(messages: ChatMessage[]): Map<string, number> {
  const indexes = new Map<string, number>()
  const perRun = new Map<string, number>()
  for (const message of messages) {
    if (message.role === 'user') {
      indexes.set(message.id, -1)
      continue
    }
    const runKey = message.runId ?? '__legacy__'
    const next = perRun.get(runKey) ?? 0
    indexes.set(message.id, next)
    perRun.set(runKey, next + 1)
  }
  return indexes
}

function flagFile(jsonFile: string): string {
  return `${jsonFile}.imported`
}

/** 列出待导入文件（.json 且无 .imported 标记） */
export function pendingLegacyFiles(sessionsDir: string): string[] {
  if (!fs.existsSync(sessionsDir)) return []
  return fs
    .readdirSync(sessionsDir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.imported'))
    .map((name) => path.join(sessionsDir, name))
    .filter((file) => !fs.existsSync(flagFile(file)))
}

function importOne(db: AppDb, jsonFile: string): { sessions: number; messages: number } {
  const { session, messages } = parseLegacyFile(jsonFile)
  const turnIndexes = deriveTurnIndexes(messages)
  db.tx(() => {
    db.run(
      `INSERT INTO sessions (id, project_id, title, participant_ids, workspace_dir, created_at, updated_at)
       VALUES (?, NULL, ?, ?, NULL, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, participant_ids = excluded.participant_ids,
         created_at = excluded.created_at, updated_at = excluded.updated_at`,
      session.id,
      session.title || '未命名会话',
      JSON.stringify(session.participantIds ?? []),
      session.createdAt ?? new Date().toISOString(),
      session.updatedAt ?? new Date().toISOString(),
    )
    messages.forEach((message, index) => {
      db.run(
        `INSERT INTO messages (id, session_id, run_id, turn_index, seq, role, agent_id, content, mentions, status, artifacts, tool_calls, reasoning, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           content = excluded.content, status = excluded.status,
           mentions = excluded.mentions, artifacts = excluded.artifacts, tool_calls = excluded.tool_calls`,
        message.id,
        session.id,
        message.runId ?? null,
        turnIndexes.get(message.id) ?? index,
        index + 1,
        message.role,
        message.agentId ?? null,
        message.content ?? '',
        JSON.stringify(message.mentions ?? []),
        message.status ?? 'complete',
        JSON.stringify(message.artifacts ?? null),
        message.toolCalls ? JSON.stringify(message.toolCalls) : null,
        message.reasoning ?? null,
        message.createdAt ?? new Date().toISOString(),
      )
    })
    // 事务内自校验：条数不一致直接回滚（宁可失败也不写入半份数据）
    const counted = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?', session.id)
    if (Number(counted?.n ?? -1) !== messages.length) {
      throw new Error(`条数校验失败：期望 ${messages.length}，实际 ${counted?.n ?? 0}`)
    }
  })
  return { sessions: 1, messages: messages.length }
}

/** 幂等导入全部待处理文件；单文件失败不影响其余 */
export function importLegacySessions(db: AppDb, sessionsDir: string): LegacyImportResult {
  const result: LegacyImportResult = {
    imported: [],
    skipped: [],
    failed: [],
    sessionCount: 0,
    messageCount: 0,
  }
  if (!fs.existsSync(sessionsDir)) return result
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!name.endsWith('.json') || name.endsWith('.imported')) continue
    const file = path.join(sessionsDir, name)
    if (fs.existsSync(flagFile(file))) {
      result.skipped.push(name)
      continue
    }
    try {
      const counts = importOne(db, file)
      result.sessionCount += counts.sessions
      result.messageCount += counts.messages
      result.imported.push(name)
      fs.writeFileSync(
        flagFile(file),
        `${JSON.stringify({ importedAt: new Date().toISOString(), ...counts })}\n`,
        'utf8',
      )
    } catch (err) {
      result.failed.push({ file: name, error: (err as Error).message })
    }
  }
  return result
}
