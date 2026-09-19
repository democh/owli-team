/**
 * Office 交付件轻量预览（M24）：服务端零依赖解析 docx / xlsx / pptx。
 *
 * 设计取舍（ADR 46）：
 * - 前端构建产物门槛（≤ 50 文件）不允许引入 mammoth / SheetJS 等重型库，
 *   且解析在服务端可复用、可单测——浏览器只负责渲染结构化结果；
 * - docx → 语义化 HTML（标题 / 段落 / 列表 / 表格 / 粗斜体；图片降级为占位标记）；
 * - xlsx → 二维数组（共享字符串 / 内联字符串 / 布尔 / 日期样式序列号还原）；
 * - pptx → 幻灯片大纲（占位符标题 + 正文行）；
 * - 所有解析带体积与数量护栏，超限输出 `truncated: true`，绝不 OOM / 卡死。
 */
import type { ArtifactPreview, OfficeSheetPreview, OfficeSlidePreview } from '@multi-agent/shared'
import { readZipEntries } from './zip.js'

// ---------- 公共边界 ----------

/** docx HTML 输出上限（字符） */
const MAX_HTML_CHARS = 900 * 1024
/** docx 段落数上限 */
const MAX_PARAGRAPHS = 3000
/** docx 单表格行数上限 */
const MAX_TABLE_ROWS = 200
/** xlsx 单表行 / 列上限 */
const MAX_SHEET_ROWS = 300
const MAX_SHEET_COLS = 64
/** xlsx 工作表数上限 */
const MAX_SHEETS = 20
/** pptx 幻灯片数与单页正文行上限 */
const MAX_SLIDES = 60
const MAX_SLIDE_LINES = 40

function decodeXml(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num: string) => String.fromCodePoint(Number(num)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 拼接 XML 片段内的全部 `t` 文本（富文本 run 级拆分归一；兼容 `<t>` / `<w:t>` / `<a:t>` 带命名空间前缀） */
function joinTexts(xml: string): string {
  let out = ''
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out += decodeXml(m[1])
  return out
}

// ---------- docx ----------

export function previewDocx(buf: Buffer): { html: string; truncated?: boolean } {
  const xml = readZipEntries(buf, (n) => n === 'word/document.xml').get('word/document.xml')
  if (!xml) throw new Error('不是有效的 docx 文件（缺少 word/document.xml）')
  const body = bodyOf(xml.toString('utf8'))
  let html = ''
  let paragraphs = 0
  let truncated = false
  let pos = 0
  // 顶层块扫描：`<w:p>` 段落与 `<w:tbl>` 表格（两者均不嵌套自身；lookahead 排除 <w:pPr 等）
  const blockRe = /<w:(tbl|p)(?=[\s>/])/g
  while (pos < body.length) {
    blockRe.lastIndex = pos
    const m = blockRe.exec(body)
    if (!m) break
    if (m[1] === 'tbl') {
      const end = body.indexOf('</w:tbl>', m.index)
      const chunk = body.slice(m.index, end < 0 ? body.length : end + 8)
      const table = renderTable(chunk)
      if (table) {
        if (html.length + table.length > MAX_HTML_CHARS) {
          truncated = true
          break
        }
        html += table
      }
      pos = end < 0 ? body.length : end + 8
      continue
    }
    // 段落：跳过自闭合 `<w:p/>`
    const tagEnd = body.indexOf('>', m.index)
    if (tagEnd < 0) break
    if (body[tagEnd - 1] === '/') {
      pos = tagEnd + 1
      continue
    }
    const end = body.indexOf('</w:p>', tagEnd)
    const chunk = body.slice(m.index, end < 0 ? body.length : end + 6)
    const rendered = renderParagraph(chunk)
    if (rendered) {
      if (paragraphs >= MAX_PARAGRAPHS || html.length + rendered.length > MAX_HTML_CHARS) {
        truncated = true
        break
      }
      paragraphs++
      html += rendered
    }
    pos = end < 0 ? body.length : end + 6
  }
  // 连续列表项包装为 <ul>
  html = html.replace(/(?:<li>[\s\S]*?<\/li>)+/g, (list) => `<ul>${list}</ul>`)
  return { html, ...(truncated ? { truncated: true } : {}) }
}

function bodyOf(xml: string): string {
  const start = xml.indexOf('<w:body')
  const gt = start < 0 ? -1 : xml.indexOf('>', start)
  if (gt < 0) return xml
  const end = xml.lastIndexOf('</w:body>')
  return end > gt ? xml.slice(gt + 1, end) : xml.slice(gt + 1)
}

function renderParagraph(chunk: string): string {
  const text = renderRuns(chunk)
  if (!text.trim()) {
    return /<w:drawing(?=[\s>])/.test(chunk) ? '<p class="off-media">[图片]</p>' : ''
  }
  const style = /<w:pStyle[^>]*w:val="([^"]*)"/.exec(chunk)?.[1]
  const heading = style ? headingLevel(style) : 0
  if (heading) return `<h${heading}>${text}</h${heading}>`
  if (/<w:numPr(?=[\s/>])/.test(chunk)) return `<li>${text}</li>`
  return `<p>${text}</p>`
}

function headingLevel(styleId: string): number {
  const m = /^(?:Heading|heading)?\s*(\d)$/.exec(styleId) ?? /^Heading(\d+)$/i.exec(styleId)
  if (m) return Math.min(Math.max(Number(m[1]), 1), 6)
  if (/^Title$/i.test(styleId)) return 1
  if (/^Subtitle$/i.test(styleId)) return 2
  return 0
}

/** 段落内 run 级渲染：文本 + 粗 / 斜 / 下划线 + 图片占位 */
function renderRuns(chunk: string): string {
  const out: string[] = []
  const runRe = /<w:r(?=[\s>])[\s\S]*?<\/w:r>/g
  let m: RegExpExecArray | null
  while ((m = runRe.exec(chunk)) !== null) {
    const run = m[0]
    let text = ''
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
    let t: RegExpExecArray | null
    while ((t = tRe.exec(run)) !== null) text += decodeXml(t[1])
    if (/<w:drawing(?=[\s>])/.test(run)) out.push('<span class="off-media">[图片]</span>')
    if (!text) {
      if (/<w:(?:br|tab)(?=[\s/>])/.test(run)) out.push(' ')
      continue
    }
    let html = escapeHtml(text)
    if (isOn(run, 'b')) html = `<strong>${html}</strong>`
    if (isOn(run, 'i')) html = `<em>${html}</em>`
    if (isOn(run, 'u')) html = `<u>${html}</u>`
    out.push(html)
  }
  return out.join('')
}

/** 布尔属性判定：`<w:b/>` / `<w:b w:val="1"/>` 为开，`w:val="0|false|off"` 为关 */
function isOn(run: string, tag: string): boolean {
  const m = new RegExp(`<w:${tag}(?:\\s[^>]*)?/>`).exec(run)
  if (!m) return false
  return !/w:val="(?:0|false|off|none)"/.test(m[0])
}

function renderTable(chunk: string): string {
  const rows: string[] = []
  const trRe = /<w:tr(?=[\s>])[\s\S]*?<\/w:tr>/g
  let tr: RegExpExecArray | null
  let rowCount = 0
  while ((tr = trRe.exec(chunk)) !== null) {
    if (rowCount >= MAX_TABLE_ROWS) break
    rowCount++
    const cells: string[] = []
    const tcRe = /<w:tc(?=[\s>])[\s\S]*?<\/w:tc>/g
    let tc: RegExpExecArray | null
    while ((tc = tcRe.exec(tr[0])) !== null) {
      const span = /<w:gridSpan[^>]*w:val="(\d+)"/.exec(tc[0])?.[1]
      const spanN = span ? Math.min(Number(span), 20) : 1
      const text = renderRuns(tc[0]).trim()
      cells.push(`<td${spanN > 1 ? ` colspan="${spanN}"` : ''}>${text || '<span class="off-empty">—</span>'}</td>`)
    }
    if (cells.length) rows.push(`<tr>${cells.join('')}</tr>`)
  }
  return rows.length ? `<table>${rows.join('')}</table>` : ''
}

// ---------- xlsx ----------

export function previewXlsx(buf: Buffer): { sheets: OfficeSheetPreview[]; truncated?: boolean } {
  const entries = readZipEntries(
    buf,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      n === 'xl/styles.xml' ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
  )
  const workbook = entries.get('xl/workbook.xml')?.toString('utf8')
  if (!workbook) throw new Error('不是有效的 xlsx 文件（缺少 xl/workbook.xml）')
  const shared = parseSharedStrings(entries.get('xl/sharedStrings.xml')?.toString('utf8'))
  const dateStyles = parseDateStyles(entries.get('xl/styles.xml')?.toString('utf8'))
  const rels = parseWorkbookRels(entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8'))
  const sheets: OfficeSheetPreview[] = []
  let truncated = false
  for (const ref of parseSheetRefs(workbook)) {
    if (sheets.length >= MAX_SHEETS) {
      truncated = true
      break
    }
    const target = (ref.rid ? rels.get(ref.rid) : undefined) ?? `xl/worksheets/sheet${ref.index}.xml`
    const xml = entries.get(target)?.toString('utf8')
    if (!xml) continue
    const parsed = parseSheet(xml, shared, dateStyles)
    if (parsed.truncated) truncated = true
    sheets.push({ name: ref.name, rows: parsed.rows, ...(parsed.truncated ? { truncated: true } : {}) })
  }
  if (!sheets.length) throw new Error('工作簿中没有可预览的工作表')
  return { sheets, ...(truncated ? { truncated: true } : {}) }
}

interface SheetRef {
  name: string
  rid?: string
  index: number
}

function parseSheetRefs(workbook: string): SheetRef[] {
  const out: SheetRef[] = []
  const re = /<sheet\b([^>]*)\/>/g
  let m: RegExpExecArray | null
  let index = 0
  while ((m = re.exec(workbook)) !== null) {
    index++
    const name = /name="([^"]*)"/.exec(m[1])?.[1]
    out.push({ name: name ? decodeXml(name) : `Sheet${index}`, rid: /r:id="([^"]*)"/.exec(m[1])?.[1], index })
  }
  return out
}

function parseWorkbookRels(xml?: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!xml) return map
  const re = /<Relationship\b([^>]*)\/>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const id = /Id="([^"]*)"/.exec(m[1])?.[1]
    const target = /Target="([^"]*)"/.exec(m[1])?.[1]
    if (!id || !target) continue
    const normalized = target.startsWith('/')
      ? target.slice(1)
      : `xl/${target}`.replace(/\/[^/]+\/\.\.\//g, '/')
    map.set(id, normalized)
  }
  return map
}

/** 共享字符串表：`<si>` 自闭合也要占位，避免索引错位 */
function parseSharedStrings(xml?: string): string[] {
  if (!xml) return []
  const out: string[] = []
  const re = /<si(?:\s[^>]*)?\/>|<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    out.push(m[1] === undefined ? '' : joinTexts(m[1]))
    if (out.length >= 100_000) break
  }
  return out
}

/** 日期格式样式索引集合：cellXfs 顺序 = 单元格 `s` 属性索引 */
function parseDateStyles(xml?: string): Set<number> {
  const set = new Set<number>()
  if (!xml) return set
  const custom = new Map<number, string>()
  const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = nfRe.exec(xml)) !== null) custom.set(Number(m[1]), decodeXml(m[2]))
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  const xfRe = /<xf\b([^>]*?)\/>|<xf\b([^>]*?)>/g
  let idx = 0
  while ((m = xfRe.exec(xfs)) !== null) {
    const id = Number(/numFmtId="(\d+)"/.exec(m[1] ?? m[2] ?? '')?.[1] ?? '0')
    if (isDateFmt(id, custom.get(id))) set.add(idx)
    idx++
  }
  return set
}

const DATE_FMT_IDS = new Set([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52,
  53, 54, 55, 56, 57, 58,
])

function isDateFmt(id: number, code?: string): boolean {
  if (DATE_FMT_IDS.has(id)) return true
  if (!code) return false
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '')
  return /[ymdhs]/i.test(stripped)
}

function parseSheet(
  xml: string,
  shared: string[],
  dateStyles: Set<number>,
): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = []
  let truncated = false
  const rowRe = /<row\b([^>]*)\/>|<row\b[^>]*>([\s\S]*?)<\/row>/g
  let m: RegExpExecArray | null
  while ((m = rowRe.exec(xml)) !== null) {
    if (rows.length >= MAX_SHEET_ROWS) {
      truncated = true
      break
    }
    const inner = m[2] ?? ''
    const cells: string[] = []
    if (inner) {
      const cellRe = /<c\b([^>]*?)\/>|<c\b([^>]*?)>([\s\S]*?)<\/c>/g
      let c: RegExpExecArray | null
      let lastCol = -1
      while ((c = cellRe.exec(inner)) !== null) {
        const attrs = c[1] ?? c[2] ?? ''
        const col = colIndex(/r="([A-Z]+)\d+"/.exec(attrs)?.[1]) ?? lastCol + 1
        lastCol = col
        if (col >= MAX_SHEET_COLS) {
          truncated = true
          continue
        }
        while (cells.length < col) cells.push('')
        cells[col] = cellValue(attrs, c[3] ?? '', shared, dateStyles)
      }
    }
    while (cells.length && cells[cells.length - 1] === '') cells.pop()
    rows.push(cells)
  }
  while (rows.length && rows[rows.length - 1].every((x) => x === '')) rows.pop()
  return { rows, truncated }
}

function colIndex(letters?: string): number | undefined {
  if (!letters) return undefined
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function cellValue(attrs: string, body: string, shared: string[], dateStyles: Set<number>): string {
  const t = /t="([^"]*)"/.exec(attrs)?.[1] ?? 'n'
  if (t === 'inlineStr') {
    return joinTexts(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
  if (v === undefined) return ''
  const raw = decodeXml(v)
  if (t === 's') {
    const idx = Number(raw)
    return Number.isInteger(idx) ? (shared[idx] ?? '') : ''
  }
  if (t === 'b') return raw === '1' ? 'TRUE' : 'FALSE'
  if (t === 'n') {
    const num = Number(raw)
    const sIdx = Number(/s="(\d+)"/.exec(attrs)?.[1])
    if (Number.isFinite(num) && Number.isInteger(sIdx) && dateStyles.has(sIdx)) {
      return excelSerialToText(num)
    }
  }
  return raw
}

/** Excel 日期序列号 → 文本（1900 体系；UTc 基准 1899-12-30） */
function excelSerialToText(serial: number): string {
  const ms = Math.round((serial - 25569) * 86400 * 1000)
  if (!Number.isFinite(ms)) return String(serial)
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  return time === '00:00' ? date : `${date} ${time}`
}

// ---------- pptx ----------

export function previewPptx(buf: Buffer): { slides: OfficeSlidePreview[]; truncated?: boolean } {
  const entries = readZipEntries(
    buf,
    (n) => n === 'ppt/presentation.xml' || /^ppt\/slides\/slide\d+\.xml$/.test(n),
  )
  if (!entries.has('ppt/presentation.xml')) throw new Error('不是有效的 pptx 文件（缺少 ppt/presentation.xml）')
  const slideNames = [...entries.keys()]
    .filter((n) => n.startsWith('ppt/slides/'))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const slides: OfficeSlidePreview[] = []
  let truncated = false
  for (const name of slideNames) {
    if (slides.length >= MAX_SLIDES) {
      truncated = true
      break
    }
    slides.push(parseSlide(entries.get(name)!.toString('utf8')))
  }
  if (!slides.length) throw new Error('演示文稿中没有可预览的幻灯片')
  return { slides, ...(truncated ? { truncated: true } : {}) }
}

function slideNo(name: string): number {
  return Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? 0)
}

function parseSlide(xml: string): OfficeSlidePreview {
  const shapes: Array<{ isTitle: boolean; lines: string[] }> = []
  const spRe = /<p:sp(?=[\s>])[\s\S]*?<\/p:sp>/g
  let m: RegExpExecArray | null
  while ((m = spRe.exec(xml)) !== null) {
    const lines = paragraphsOf(m[0])
    if (lines.length) shapes.push({ isTitle: /<p:ph[^>]*type="(?:title|ctrTitle)"/.test(m[0]), lines })
  }
  let title: string | undefined
  const lines: string[] = []
  for (const s of shapes) {
    if (s.isTitle && title === undefined) {
      title = s.lines[0]
      lines.push(...s.lines.slice(1))
    } else {
      lines.push(...s.lines)
    }
  }
  return { ...(title ? { title } : {}), lines: lines.slice(0, MAX_SLIDE_LINES) }
}

function paragraphsOf(shape: string): string[] {
  const out: string[] = []
  const pRe = /<a:p(?=[\s>])[\s\S]*?<\/a:p>/g
  let m: RegExpExecArray | null
  while ((m = pRe.exec(shape)) !== null) {
    const text = joinTexts(m[0]).trim()
    if (text) out.push(text)
  }
  return out
}

// ---------- 路由分发 ----------

/** 按扩展名解析 Office 文件；非可预览格式返回 undefined（由路由给出下载引导） */
export function previewOfficeFile(ext: string, buf: Buffer): ArtifactPreview | undefined {
  if (ext === '.docx') return { kind: 'docx', ...previewDocx(buf) }
  if (ext === '.xlsx') return { kind: 'xlsx', ...previewXlsx(buf) }
  if (ext === '.pptx') return { kind: 'pptx', ...previewPptx(buf) }
  return undefined
}
