/**
 * CLI：工作区布局搬迁（M57）——`workspace/<sid>` → `workspace/u_<uid>/<sid>`；
 * 画布 `data/canvas/<sid>.json` → `data/canvas/u_<uid>/<sid>.json`。
 *
 * 用法：
 *   npm run migrate:workspace                 # 实际搬迁（幂等，可重复执行）
 *   npm run migrate:workspace -- --dry-run    # 只打印计划，不动文件
 *
 * 说明：
 * - 仅处理有属主（owner_id 非空）的会话；worktree 目录不搬迁（既有位置由 sessions.workspace_dir 显式记录）；
 * - 源不存在（会话从未使用工作区）→ 静默；目标已存在 → 记为跳过（幂等）；同盘 rename，跨设备回退 cp+rm；
 * - 兼容期读取回退：服务端 `WorkspaceService.resolveDir` / `canvasFileFor` 在「新目录未建且旧目录存在」时
 *   继续读旧路径，因此本脚本可随时执行、也可不执行；
 * - 退出码：0 完成（含跳过）；1 存在失败项（可修复后重跑）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig } from '../config.js'
import { openDatabase, type AppDb } from '../store/db.js'

export interface WorkspaceMigrationOptions {
  dryRun?: boolean
}

export interface WorkspaceMigrationResult {
  /** 已搬迁的工作区（相对 WORKSPACE_DIR 的新路径） */
  moved: string[]
  /** 已搬迁的画布（相对 DATA_DIR 的新路径） */
  movedCanvas: string[]
  /** 源与目标同时存在（重复执行 / 手动处理过）→ 跳过 */
  skipped: Array<{ path: string; reason: string }>
  failed: Array<{ path: string; error: string }>
}

/** 目录段安全清洗（与会话 id / 用户 id 口径一致） */
function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '')
}

/** 移动文件或目录（跨设备 EXDEV 自动回退 cp + rm） */
function moveFileOrDir(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true })
      fs.rmSync(src, { recursive: true, force: true })
      return
    }
    throw err
  }
}

/**
 * 执行布局搬迁（幂等；导出供测试直接调用）。
 * @param db 已打开的数据库（sessions.owner_id 为搬迁依据）
 * @param dirs 目录配置（workspaceDir / dataDir）
 */
export function migrateWorkspaceLayout(
  db: AppDb,
  dirs: { workspaceDir: string; dataDir: string },
  opts: WorkspaceMigrationOptions = {},
): WorkspaceMigrationResult {
  const result: WorkspaceMigrationResult = { moved: [], movedCanvas: [], skipped: [], failed: [] }
  const rows = db.all<{ id: string; owner_id: string | null }>(
    `SELECT id, owner_id FROM sessions WHERE owner_id IS NOT NULL AND deleted_at IS NULL ORDER BY created_at ASC`,
  )
  const canvasDir = path.join(dirs.dataDir, 'canvas')
  for (const row of rows) {
    const owner = row.owner_id ? sanitizeSegment(row.owner_id) : ''
    const sid = sanitizeSegment(row.id)
    if (!owner || !sid) {
      result.skipped.push({ path: row.id, reason: 'id 非法（含非 [A-Za-z0-9_-] 字符）' })
      continue
    }
    // ---------- 工作区 ----------
    const src = path.join(dirs.workspaceDir, sid)
    const dst = path.join(dirs.workspaceDir, `u_${owner}`, sid)
    if (fs.existsSync(src)) {
      if (fs.existsSync(dst)) {
        result.skipped.push({ path: src, reason: '目标已存在（重复执行）' })
      } else {
        try {
          if (!opts.dryRun) {
            fs.mkdirSync(path.dirname(dst), { recursive: true })
            moveFileOrDir(src, dst)
          }
          result.moved.push(path.join('u_' + owner, sid))
        } catch (err) {
          result.failed.push({ path: src, error: (err as Error).message })
        }
      }
    }
    // ---------- 画布 ----------
    const csrc = path.join(canvasDir, `${sid}.json`)
    const cdst = path.join(canvasDir, `u_${owner}`, `${sid}.json`)
    if (fs.existsSync(csrc)) {
      if (fs.existsSync(cdst)) {
        result.skipped.push({ path: csrc, reason: '目标已存在（重复执行）' })
      } else {
        try {
          if (!opts.dryRun) {
            fs.mkdirSync(path.dirname(cdst), { recursive: true })
            moveFileOrDir(csrc, cdst)
          }
          result.movedCanvas.push(path.join('u_' + owner, `${sid}.json`))
        } catch (err) {
          result.failed.push({ path: csrc, error: (err as Error).message })
        }
      }
    }
  }
  return result
}

// ---------- CLI ----------

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const dryRun = process.argv.includes('--dry-run')
  const cfg = loadConfig()
  console.log(`[migrate:workspace] 工作区根: ${cfg.workspaceDir}`)
  console.log(`[migrate:workspace] 数据目录: ${cfg.dataDir}${dryRun ? '（--dry-run：只预览不落盘）' : ''}`)
  const db = openDatabase(cfg.dbFile)
  const result = migrateWorkspaceLayout(db, { workspaceDir: cfg.workspaceDir, dataDir: cfg.dataDir }, { dryRun })
  db.close()
  console.log(
    `[migrate:workspace] ${dryRun ? '将搬迁' : '已搬迁'} 工作区 ${result.moved.length} 个 / 画布 ${result.movedCanvas.length} 个；跳过 ${result.skipped.length} 项`,
  )
  for (const item of result.skipped) console.log(`[migrate:workspace] 跳过 ${item.path}：${item.reason}`)
  if (result.failed.length > 0) {
    for (const failure of result.failed) console.error(`[migrate:workspace] 失败 ${failure.path}: ${failure.error}`)
    console.error('[migrate:workspace] 存在失败项，修复后可重新执行（幂等）')
    process.exit(1)
  }
  console.log('[migrate:workspace] 完成（旧路径文件已移至新布局；服务端兼容回退仍可读未搬迁的旧数据）')
}
