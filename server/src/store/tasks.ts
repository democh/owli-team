/**
 * 任务清单存储（M3：任务落盘 + 跨 Run 继承）。
 *
 * 语义：write_todos 为「覆盖式更新」——按 content 匹配复用旧行 id（前端 diff 稳定），
 * 状态 / 负责人 / 顺序可变；不再出现的条目删除。清单按会话维度保存，跨 Run 继承。
 */
import type { TaskItem, TaskStatus } from '@multi-agent/shared'
import type { AppDb } from './db.js'
import { newId, nowIso } from './sessions.js'

interface TaskRow {
  id: string
  session_id: string
  run_id: string | null
  content: string
  status: string
  owner_agent_id: string | null
  ord: number
  created_at: string
  updated_at: string
}

function rowToTask(row: TaskRow): TaskItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    runId: row.run_id ?? undefined,
    content: row.content,
    status: row.status as TaskStatus,
    ownerAgentId: row.owner_agent_id ?? undefined,
    ord: Number(row.ord),
  }
}

export interface TaskInput {
  content: string
  status: TaskStatus
  ownerAgentId?: string
}

export class TaskStore {
  constructor(private readonly db: AppDb) {}

  list(sessionId: string): TaskItem[] {
    return this.db
      .all<TaskRow>('SELECT * FROM task_items WHERE session_id = ? ORDER BY ord ASC', sessionId)
      .map(rowToTask)
  }

  /** write_todos 覆盖式更新：内容相同的复用旧行（id 稳定），多余的删除 */
  replace(sessionId: string, runId: string | undefined, items: TaskInput[]): TaskItem[] {
    const ts = nowIso()
    this.db.tx(() => {
      const existing = this.db.all<TaskRow>(
        'SELECT * FROM task_items WHERE session_id = ? ORDER BY ord ASC',
        sessionId,
      )
      const byContent = new Map<string, TaskRow>()
      for (const row of existing) if (!byContent.has(row.content)) byContent.set(row.content, row)

      const keptIds = new Set<string>()
      items.forEach((item, index) => {
        const old = byContent.get(item.content)
        if (old) {
          keptIds.add(old.id)
          this.db.run(
            `UPDATE task_items SET status = ?, owner_agent_id = ?, run_id = ?, ord = ?, updated_at = ? WHERE id = ?`,
            item.status,
            item.ownerAgentId ?? old.owner_agent_id,
            runId ?? old.run_id,
            index,
            ts,
            old.id,
          )
        } else {
          const id = newId('t')
          keptIds.add(id)
          this.db.run(
            `INSERT INTO task_items (id, session_id, run_id, content, status, owner_agent_id, ord, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            sessionId,
            runId ?? null,
            item.content,
            item.status,
            item.ownerAgentId ?? null,
            index,
            ts,
            ts,
          )
        }
      })
      for (const row of existing) {
        if (!keptIds.has(row.id)) this.db.run('DELETE FROM task_items WHERE id = ?', row.id)
      }
    })
    return this.list(sessionId)
  }

  clear(sessionId: string): void {
    this.db.run('DELETE FROM task_items WHERE session_id = ?', sessionId)
  }
}
