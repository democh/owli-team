#!/usr/bin/env node
/**
 * 本地数据目录清理（默认 dry-run）。
 *
 * 清理对象（仅限 data/ 与 workspace/ 下由 E2E / 手工备份产生的目录）：
 *   - data/e2e-*、workspace/e2e-*
 *   - data/m*-backup-*、data/*-backup-*（手工快照目录）
 *   - test-results-*（Playwright 报告）
 *
 * 用法：
 *   node scripts/prune-data.mjs           # 只列出将要删除的内容
 *   node scripts/prune-data.mjs --yes     # 实际删除
 *
 * 安全边界：只处理上述白名单模式，且路径必须位于仓库根内的 data/、workspace/ 或根级
 * test-results-*；data/app.db 等业务数据永不命中。
 */
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const apply = process.argv.includes('--yes')

const TARGET_DIRS = [path.join(ROOT, 'data'), path.join(ROOT, 'workspace')]
const DIR_PATTERNS = [/^e2e-/, /^m\d+-backup-/, /-backup-\d{4}-\d{2}-\d{2}$/]

function dirBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size
        } catch {
          /* 单文件统计失败忽略 */
        }
      }
    }
  }
  return total
}

const hits = []
const isTargetDir = (entry) => entry.isDirectory() && DIR_PATTERNS.some((re) => re.test(entry.name))
for (const base of TARGET_DIRS) {
  if (!fs.existsSync(base)) continue
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (isTargetDir(entry)) hits.push(path.join(base, entry.name))
  }
}
for (const name of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (name.isDirectory() && /^test-results-/.test(name.name)) hits.push(path.join(ROOT, name.name))
}

if (hits.length === 0) {
  console.log('[prune] 没有匹配的临时目录，无需清理')
  process.exit(0)
}

let totalBytes = 0
for (const dir of hits) {
  // 兜底：只允许删除仓库内的目录，且路径必须包含 data/ workspace/ 或根级 test-results-
  const rel = path.relative(ROOT, dir)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    console.warn(`[prune] 跳过可疑路径：${dir}`)
    continue
  }
  const bytes = dirBytes(dir)
  totalBytes += bytes
  console.log(`[prune] ${apply ? '删除' : '将删除'} ${rel}  (${(bytes / 1024 / 1024).toFixed(1)} MB)`)
  if (apply) fs.rmSync(dir, { recursive: true, force: true })
}

console.log(
  `[prune] 共 ${hits.length} 个目录 / ${(totalBytes / 1024 / 1024).toFixed(0)} MB${apply ? ' 已删除' : '（dry-run，加 --yes 执行删除）'}`,
)
