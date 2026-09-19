/**
 * 交付件版本存储（M8：Diff 视图与版本回溯）。
 *
 * 设计：
 * - 每次写类工具成功落地文件后，引擎读取磁盘内容并记录一版（version 按 (session, path) 自增）；
 * - 内容相同（hash 一致）的重复写不产生新版本，避免噪声；
 * - 文本内容超过 MAX_CONTENT_BYTES 只记元数据（content = null），diff 时给出提示；
 * - 列表查询不返回 content（体积控制），单版本查询才带。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { AppDb } from './db.js'

/** 单版本内容上限（超过只存元数据） */
export const MAX_VERSION_CONTENT_BYTES = 200 * 1024

export interface ArtifactVersion {
  id: string
  sessionId: string
  path: string
  version: number
  content?: string
  size: number
  hash: string
  authorAgentId?: string
  messageId?: string
  createdAt: string
}

interface VersionRow {
  id: string
  session_id: string
  path: string
  version: number
  content: string | null
  size: number
  hash: string
  author_agent_id: string | null
  message_id: string | null
  created_at: string
}

function rowToVersion(row: VersionRow, withContent: boolean): ArtifactVersion {
  return {
    id: row.id,
    sessionId: row.session_id,
    path: row.path,
    version: row.version,
    ...(withContent ? { content: row.content ?? undefined } : {}),
    size: row.size,
    hash: row.hash,
    authorAgentId: row.author_agent_id ?? undefined,
    messageId: row.message_id ?? undefined,
    createdAt: row.created_at,
  }
}

export function contentHash(content: string | Buffer): string {
  return createHash('sha1').update(content).digest('hex')
}

export class ArtifactVersionStore {
  constructor(private readonly db: AppDb) {}

  /**
   * 记录一版；内容与最新版本一致时跳过（返回 undefined）。
   * 写入失败不得影响工具主流程（调用方已 try/catch）。
   */
  record(input: {
    sessionId: string
    path: string
    content?: string
    size: number
    authorAgentId?: string
    messageId?: string
  }): ArtifactVersion | undefined {
    const hash = contentHash(input.content ?? String(input.size))
    const latest = this.latest(input.sessionId, input.path)
    if (latest && latest.hash === hash) return undefined
    const version = (latest?.version ?? 0) + 1
    const row: VersionRow = {
      id: `av_${randomUUID().slice(0, 8)}`,
      session_id: input.sessionId,
      path: input.path,
      version,
      content: input.content !== undefined && input.size <= MAX_VERSION_CONTENT_BYTES ? input.content : null,
      size: input.size,
      hash,
      author_agent_id: input.authorAgentId ?? null,
      message_id: input.messageId ?? null,
      created_at: new Date().toISOString(),
    }
    this.db.run(
      `INSERT INTO artifact_versions (id, session_id, path, version, content, size, hash, author_agent_id, message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.session_id,
      row.path,
      row.version,
      row.content,
      row.size,
      row.hash,
      row.author_agent_id,
      row.message_id,
      row.created_at,
    )
    return rowToVersion(row, true)
  }

  /** 版本列表（新→旧，不带 content） */
  list(sessionId: string, path: string): ArtifactVersion[] {
    return this.db
      .all<VersionRow>(
        'SELECT * FROM artifact_versions WHERE session_id = ? AND path = ? ORDER BY version DESC',
        sessionId,
        path,
      )
      .map((row) => rowToVersion(row, false))
  }

  latest(sessionId: string, path: string): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>(
      'SELECT * FROM artifact_versions WHERE session_id = ? AND path = ? ORDER BY version DESC LIMIT 1',
      sessionId,
      path,
    )
    return row ? rowToVersion(row, false) : undefined
  }

  /** 单版本（带 content；内容未落库时 content = undefined） */
  get(sessionId: string, path: string, version: number): ArtifactVersion | undefined {
    const row = this.db.get<VersionRow>(
      'SELECT * FROM artifact_versions WHERE session_id = ? AND path = ? AND version = ?',
      sessionId,
      path,
      version,
    )
    return row ? rowToVersion(row, true) : undefined
  }
}
