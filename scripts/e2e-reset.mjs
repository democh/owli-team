#!/usr/bin/env node
/**
 * E2E 数据目录治理工具（M79-AG 收尾）：清理 / 轮换 Playwright 测试数据目录。
 *
 * 用法：
 *   npm run e2e:reset                  # 清理默认主链路目录（data/e2e-main + workspace/e2e-main）
 *   npm run e2e:reset -- e2e-probe e2e-clean   # 清理指定 slug（可多个）
 *
 * 背景：
 * - main 链路默认共用 `data/e2e-main`，长期多轮全量累积（实测 1700+ 会话）会拖慢
 *   页面渲染，导致个别长链用例超时（m31-canvas-ux / m77 型）——建议按轮次轮换：
 *   `PW_DATA_DIR=e2e-r1 npx playwright test --project=main`，并定期清理旧 slug；
 * - slug 严格校验（`e2e-<a-z0-9->+`），防止误传路径造成越界删除。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const SLUG_RE = /^e2e-[a-z0-9-]+$/
const slugs = process.argv.slice(2).filter(Boolean)
if (slugs.length === 0) slugs.push('e2e-main')

let failed = false
for (const slug of slugs) {
  if (!SLUG_RE.test(slug)) {
    console.error(`非法 slug（须形如 e2e-xxx）：${slug}`)
    failed = true
    continue
  }
  for (const base of ['data', 'workspace']) {
    const target = path.join(base, slug)
    const existed = fs.existsSync(target)
    fs.rmSync(target, { recursive: true, force: true })
    console.log(`${existed ? 'removed' : 'absent '} ${target}`)
  }
}
process.exit(failed ? 1 : 0)
