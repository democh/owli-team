/**
 * CLI：JSON → SQLite 一次性迁移（`npm run migrate:json`）。
 *
 * 用法：
 *   tsx src/scripts/migrate-json.ts                  # 默认 data/sessions → data/app.db
 *   tsx src/scripts/migrate-json.ts --dir <目录> --db <文件>
 *
 * 退出码：0 全部成功（含全部已标记跳过）；1 存在失败文件（原文件保留，可修后重跑）。
 */
import path from 'node:path'
import { loadConfig } from '../config.js'
import { openDatabase } from '../store/db.js'
import { importLegacySessions } from '../store/legacy-import.js'

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const cfg = loadConfig()
const sessionsDir = path.resolve(argValue('--dir') ?? path.join(cfg.dataDir, 'sessions'))
const dbFile = path.resolve(argValue('--db') ?? cfg.dbFile)

console.log(`[migrate] 源目录: ${sessionsDir}`)
console.log(`[migrate] 目标库: ${dbFile}`)

const db = openDatabase(dbFile)
const result = importLegacySessions(db, sessionsDir)
db.close()

console.log(`[migrate] 导入 ${result.imported.length} 个文件（${result.sessionCount} 会话 / ${result.messageCount} 消息）`)
if (result.skipped.length > 0) console.log(`[migrate] 已跳过（存在 .imported 标记）: ${result.skipped.join(', ')}`)
if (result.failed.length > 0) {
  for (const failure of result.failed) console.error(`[migrate] 失败 ${failure.file}: ${failure.error}`)
  console.error('[migrate] 存在失败文件，原 JSON 已保留，修复后可重新执行本脚本（幂等）')
  process.exit(1)
}
console.log('[migrate] 完成：原 JSON 未删除，确认无误后可自行清理')
