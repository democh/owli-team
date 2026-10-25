#!/usr/bin/env node
/**
 * 前端产物体积预算（CI 门禁）。
 *
 * 解析 client/dist/index.html 的首屏预载图（entry script + modulepreload），统计
 * gzip 后体积并校验上限——防止「误把懒加载依赖卷回主包」这类回归再次发生
 * （历史事故：manualChunks 规则让 three-stack / shiki-core 变成 entry 静态依赖，
 * 首屏多拉 1.6MB）。
 *
 * 用法：node scripts/check-bundle.mjs [distDir]
 * 退出码：超预算 = 1（CI 失败）；缺产物 = 2。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const DIST = path.resolve(process.argv[2] ?? 'client/dist')
const HTML = path.join(DIST, 'index.html')

const BUDGET = {
  /** 首屏 JS（entry + modulepreload）gzip 后总字节 */
  firstPaintGzipKb: 650,
  /** 首屏 CSS gzip 后总字节 */
  cssGzipKb: 120,
  /** 任一 chunk 原始体积（懒加载 chunk 也计；超限说明缺少拆分） */
  maxChunkRawKb: 1600,
}

if (!fs.existsSync(HTML)) {
  console.error(`[bundle] 找不到 ${HTML}：请先执行 npm run build -w @multi-agent/client`)
  process.exit(2)
}

const html = fs.readFileSync(HTML, 'utf8')
const assetOf = (href) => path.join(DIST, href.replace(/^\//, ''))

/** 首屏 JS：<script type="module" src> + <link rel="modulepreload"> */
const firstPaint = new Set()
for (const m of html.matchAll(/<script[^>]+src="(\/assets\/[^"]+\.js)"/g)) firstPaint.add(m[1])
for (const m of html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="(\/assets\/[^"]+\.js)"/g)) firstPaint.add(m[1])
/** 首屏 CSS */
const firstPaintCss = new Set()
for (const m of html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="(\/assets\/[^"]+\.css)"/g)) firstPaintCss.add(m[1])

const kb = (bytes) => Math.max(1, Math.round(bytes / 1024))
const gzipKb = (file) => kb(zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length)

function sum(list, fn) {
  let total = 0
  for (const href of list) {
    const file = assetOf(href)
    if (!fs.existsSync(file)) {
      console.error(`[bundle] 缺失产物：${href}`)
      process.exit(2)
    }
    total += fn(file)
  }
  return total
}

const jsGzipKb = sum(firstPaint, gzipKb)
const cssGzipKb = sum(firstPaintCss, gzipKb)

/** 非模块 chunk 的静态资产（`?url` 引入，按需下载，不参与首屏）：mermaid 经典脚本单文件 bundle */
const CHUNK_ALLOWLIST = [/^mermaid\.min-/]

let maxChunk = { name: '', rawKb: 0 }
const assetsDir = path.join(DIST, 'assets')
if (fs.existsSync(assetsDir)) {
  for (const name of fs.readdirSync(assetsDir)) {
    if (!name.endsWith('.js')) continue
    if (CHUNK_ALLOWLIST.some((re) => re.test(name))) continue
    const rawKb = kb(fs.statSync(path.join(assetsDir, name)).size)
    if (rawKb > maxChunk.rawKb) maxChunk = { name, rawKb }
  }
}

const rows = [
  ['首屏 JS（gzip）', `${jsGzipKb} KB`, `≤ ${BUDGET.firstPaintGzipKb} KB`, jsGzipKb <= BUDGET.firstPaintGzipKb],
  ['首屏 CSS（gzip）', `${cssGzipKb} KB`, `≤ ${BUDGET.cssGzipKb} KB`, cssGzipKb <= BUDGET.cssGzipKb],
  ['最大 chunk', `${maxChunk.rawKb} KB (${maxChunk.name || '-'})`, `≤ ${BUDGET.maxChunkRawKb} KB`, maxChunk.rawKb <= BUDGET.maxChunkRawKb],
]

console.log('[bundle] 首屏预载清单：')
for (const href of [...firstPaint].sort()) console.log(`  - ${href}  ${gzipKb(assetOf(href))} KB(gz)`)
console.log('[bundle] 预算校验：')
for (const [name, actual, budget, ok] of rows) {
  console.log(`  ${ok ? '✓' : '✗'} ${name}: ${actual}  ${budget}`)
}

const failed = rows.filter((row) => !row[3])
if (failed.length > 0) {
  console.error(`[bundle] 超出预算 ${failed.length} 项：请检查 manualChunks 与 React.lazy 边界`)
  process.exit(1)
}
