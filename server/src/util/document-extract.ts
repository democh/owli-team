/**
 * 文档文本提取（M33）：office / pdf 正文 → 纯文本（read_file 与识别管道共用）。
 *
 * - docx → 复用 previewDocx 的语义 HTML → 文本（标题 / 列表 / 表格行结构保留）
 * - xlsx → 复用 previewXlsx 结构化表 → TSV（含工作表头）
 * - pptx → 复用 previewPptx 大纲 → 文本（幻灯片分隔）
 * - pdf  → 零依赖：zlib inflate 内容流 + BT/ET 内字符串操作符还原 + 质量护栏
 *   （扫描件 / 加密文档无文本层场景返回 note，提示模型走视觉或要求用户转换）
 *
 * 取舍（沿用 ADR 46 零依赖约束）：不引入 pdfjs / SheetJS 等重型库；提取是
 * 「尽力而为」——输出带体积护栏（≤ MAX_TEXT_CHARS），绝不 OOM。
 */
import zlib from 'node:zlib'
import type { OfficeSheetPreview, OfficeSlidePreview } from '@multi-agent/shared'
import { previewDocx, previewPptx, previewXlsx } from './office-preview.js'

/** 可提取正文文本的文档扩展名（read_file 识别管道的入口判据） */
export const DOCUMENT_EXTS = new Set(['.docx', '.xlsx', '.pptx', '.pdf'])

/** 输出文本上限（字符） */
const MAX_TEXT_CHARS = 400 * 1024
/** 单个 PDF 流解压输出上限（防解压炸弹） */
const MAX_STREAM_OUTPUT = 32 * 1024 * 1024
/** PDF 扫描流数量上限 */
const MAX_STREAMS = 512

export interface DocumentText {
  /** 提取器标识 */
  extractor: 'pdf' | 'docx' | 'xlsx' | 'pptx'
  text: string
  truncated: boolean
  /** 降级说明（无文本层 / 还原质量低 / 截断），供调用方拼提示 */
  note?: string
}

/** 按扩展名提取文档文本；非可提取格式返回 undefined；损坏文件抛错由调用方兜底 */
export function extractDocumentText(ext: string, buf: Buffer): DocumentText | undefined {
  const lower = ext.toLowerCase()
  if (lower === '.pdf') return extractPdf(buf)
  if (lower === '.docx') {
    const { html, truncated } = previewDocx(buf)
    const clamped = clamp(htmlToText(html))
    return {
      extractor: 'docx',
      text: clamped.text,
      truncated: !!truncated || clamped.truncated,
      ...(clamped.truncated ? { note: truncatedNote() } : {}),
    }
  }
  if (lower === '.xlsx') {
    const { sheets, truncated } = previewXlsx(buf)
    const clamped = clamp(sheetsToText(sheets))
    return {
      extractor: 'xlsx',
      text: clamped.text,
      truncated: !!truncated || clamped.truncated,
      ...(clamped.truncated ? { note: truncatedNote() } : {}),
    }
  }
  if (lower === '.pptx') {
    const { slides, truncated } = previewPptx(buf)
    const clamped = clamp(slidesToText(slides))
    return {
      extractor: 'pptx',
      text: clamped.text,
      truncated: !!truncated || clamped.truncated,
      ...(clamped.truncated ? { note: truncatedNote() } : {}),
    }
  }
  return undefined
}

function truncatedNote(): string {
  return `内容超过提取上限（${Math.round(MAX_TEXT_CHARS / 1024)}K 字符），已截断——请用 search_text 定位关键段落。`
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
}

// ---------- docx：语义 HTML → 文本 ----------

/** 保留标题 / 列表 / 表格的行结构（`# 标题`、`- 列表项`、单元格以制表符分隔） */
function htmlToText(html: string): string {
  return html
    .replace(/<h([1-6])>/g, (_m, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<li>/g, '- ')
    .replace(/<\/td>/g, '\t')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/(?:h[1-6]|p|li|tr|table|ul)>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------- xlsx / pptx：结构化数据 → 文本 ----------

/** 工作表标题 + 逐行制表符分隔（尾部空单元格剔除，行内换行折叠） */
function sheetsToText(sheets: OfficeSheetPreview[]): string {
  const lines: string[] = []
  sheets.forEach((sheet, index) => {
    if (index > 0) lines.push('')
    lines.push(`# 工作表：${sheet.name}`)
    for (const row of sheet.rows) {
      const cells = row.map((cell) => cell.replace(/[\t\n\r]+/g, ' '))
      while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop()
      if (cells.some((cell) => cell !== '')) lines.push(cells.join('\t'))
    }
  })
  return lines.join('\n')
}

/** 幻灯片编号 + 标题 + 正文行 */
function slidesToText(slides: OfficeSlidePreview[]): string {
  const lines: string[] = []
  slides.forEach((slide, index) => {
    if (index > 0) lines.push('')
    lines.push(`# 幻灯片 ${index + 1}${slide.title ? `：${slide.title}` : ''}`)
    for (const line of slide.lines) lines.push(line)
  })
  return lines.join('\n')
}

// ---------- pdf：零依赖文本层还原 ----------

function extractPdf(buf: Buffer): DocumentText {
  const chunks: string[] = []
  let total = 0
  let pos = 0
  let streams = 0
  let sawTextLayer = false
  while (streams < MAX_STREAMS) {
    const s = buf.indexOf('stream', pos)
    if (s < 0) break
    // `endstream` 的 `stream` 片段跳过
    if (s > 0 && buf[s - 1] === 0x64 /* 'd' */) {
      pos = s + 6
      continue
    }
    let dataStart = s + 6
    if (buf[dataStart] === 0x0d) dataStart++
    if (buf[dataStart] === 0x0a) dataStart++
    const e = buf.indexOf('endstream', dataStart)
    if (e < 0) break
    pos = e + 9
    streams++
    const raw = buf.subarray(dataStart, e)
    const data = inflateSafe(raw) ?? raw
    const text = textOfContentStream(data)
    if (text) {
      sawTextLayer = true
      chunks.push(text)
      total += text.length
      if (total > MAX_TEXT_CHARS * 2) break
    }
  }

  const cleaned = cleanupText(chunks.join('\n'))
  if (!sawTextLayer || cleaned.length === 0) {
    return {
      extractor: 'pdf',
      text: '',
      truncated: false,
      note:
        '未能从该 PDF 提取到文本层（可能是扫描件 / 纯图片 PDF / 加密文档）。' +
        '请让用户转换为文字格式重传，或在对话中直接发送关键页截图（模型可视觉识别）。',
    }
  }
  const clamped = clamp(cleaned)
  const notes: string[] = []
  if (printableRatio(cleaned) < 0.8) {
    notes.push('文本层还原质量较低（可能使用了特殊字体编码），部分字符可能失真——关键信息请对照原文核实。')
  }
  if (clamped.truncated) notes.push(truncatedNote())
  return {
    extractor: 'pdf',
    text: clamped.text,
    truncated: clamped.truncated,
    ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
  }
}

/** FlateDecode 解压（含 raw 变体）；失败返回 undefined（无压缩流由调用方按原文处理） */
function inflateSafe(raw: Buffer): Buffer | undefined {
  try {
    return zlib.inflateSync(raw, { maxOutputLength: MAX_STREAM_OUTPUT })
  } catch {
    try {
      return zlib.inflateRawSync(raw, { maxOutputLength: MAX_STREAM_OUTPUT })
    } catch {
      return undefined
    }
  }
}

/** 内容流文本还原：跟踪 BT/ET 状态，收集字面量 / 十六进制字符串，Td / TD / T* / Tm 视为换行 */
function textOfContentStream(data: Buffer): string {
  const s = data.toString('latin1')
  if (!s.includes('Tj') && !s.includes('TJ') && !s.includes('T*')) return ''
  let out = ''
  let inText = false
  let i = 0
  const n = s.length
  while (i < n) {
    const code = s.charCodeAt(i)
    if (inText && code === 0x28 /* ( */) {
      const literal = readPdfLiteral(s, i)
      out += literal.text
      i = literal.next
      continue
    }
    if (inText && code === 0x3c /* < */ && s.charCodeAt(i + 1) !== 0x3c) {
      const hex = readPdfHex(s, i)
      out += hex.text
      i = hex.next
      continue
    }
    if (isPdfOp(s, i, 'BT')) {
      inText = true
      i += 2
      continue
    }
    if (isPdfOp(s, i, 'ET')) {
      inText = false
      i += 2
      continue
    }
    if (inText && (isPdfOp(s, i, 'Td') || isPdfOp(s, i, 'TD') || isPdfOp(s, i, 'T*') || isPdfOp(s, i, 'Tm'))) {
      out += '\n'
      i += 2
      continue
    }
    i++
  }
  return out
}

/** 操作符边界判定：前后非字母数字（避免命中 "ABCBT" 之类子串） */
function isPdfOp(s: string, i: number, op: string): boolean {
  if (!s.startsWith(op, i)) return false
  const before = i > 0 ? s.charCodeAt(i - 1) : 0x20
  const after = i + op.length < s.length ? s.charCodeAt(i + op.length) : 0x20
  return !isWordCode(before) && !isWordCode(after)
}

function isWordCode(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)
}

/** PDF 字面量字符串（平衡括号 + 转义序列还原） */
function readPdfLiteral(s: string, start: number): { text: string; next: number } {
  let i = start + 1
  let depth = 1
  let out = ''
  while (i < s.length && depth > 0) {
    const ch = s[i]
    if (ch === '\\') {
      const next = s[i + 1]
      i += 2
      if (next === undefined) break
      if (next === 'n') out += '\n'
      else if (next === 'r') out += '\r'
      else if (next === 't') out += '\t'
      else if (next === 'b') out += '\b'
      else if (next === 'f') out += '\f'
      else if (next === '\n') {
        // 行继续：丢弃
      } else if (next === '\r') {
        if (s[i] === '\n') i++
      } else if (next >= '0' && next <= '7') {
        let oct = next
        while (oct.length < 3 && s[i] >= '0' && s[i] <= '7') {
          oct += s[i]
          i++
        }
        out += String.fromCharCode(parseInt(oct, 8))
      } else {
        out += next
      }
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { text: out, next: i + 1 }
    }
    out += ch
    i++
  }
  return { text: out, next: i }
}

/** PDF 十六进制字符串 `<...>`（启发式：强 UTF-16BE 信号时按 UTF-16BE 解码，否则 latin1） */
function readPdfHex(s: string, start: number): { text: string; next: number } {
  const end = s.indexOf('>', start + 1)
  if (end < 0) return { text: '', next: s.length }
  const hex = s.slice(start + 1, end).replace(/[^0-9a-fA-F]/g, '')
  const bytes = Buffer.from(hex, 'hex')
  let text = ''
  if (bytes.length > 0) {
    text = looksUtf16Be(bytes) ? bytes.swap16().toString('utf16le') : bytes.toString('latin1')
  }
  return { text, next: end + 1 }
}

function looksUtf16Be(bytes: Buffer): boolean {
  if (bytes.length % 2 !== 0) return false
  let asciiPairs = 0
  for (let i = 0; i < bytes.length; i += 2) {
    if (bytes[i] === 0 && bytes[i + 1] >= 0x20) asciiPairs++
  }
  return asciiPairs > 0 && asciiPairs >= (bytes.length / 2) * 0.5
}

/** 文本清理：行内空白折叠 + 行首尾 trim + 连续空行压缩 */
function cleanupText(text: string): string {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trim()
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out.join('\n')
}

/** 可打印比例（乱码检测：控制字符 / C1 区 / 私用区 / 替换符视为坏字） */
function printableRatio(text: string): number {
  if (!text) return 0
  let good = 0
  let bad = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (ch === '\n' || ch === '\t') {
      good++
      continue
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd || (code >= 0xe000 && code <= 0xf8ff)) bad++
    else good++
  }
  return good / (good + bad)
}
