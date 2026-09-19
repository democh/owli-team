/**
 * M33 测试：文档识别管道（document-extract）+ read_file 识别增强 + 二进制护栏。
 *
 * - docx → 语义 HTML → 文本（标题 / 列表 / 表格 / 实体）
 * - xlsx → 工作表头 + TSV + 日期还原
 * - pptx → 幻灯片标题与正文行
 * - pdf  → 压缩流字面量 / UTF-16BE hex 字符串还原、无文本层与乱码质量护栏
 * - read_file → office 自动提取 / 图片二进制拒绝
 */
import fs from 'node:fs'
import path from 'node:path'
import { deflateRawSync, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createToolRegistry } from '../src/tools/builtin.js'
import type { AgentTool, ToolRuntime } from '../src/tools/registry.js'
import { extractDocumentText } from '../src/util/document-extract.js'
import { makeTmpDir } from './helpers.js'

// ---------- zip / office fixtures（与 office-preview.test 同构） ----------

function buildZip(files: Array<[string, string]>, compress = false): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.from(text, 'utf8')
    const data = compress ? deflateRawSync(raw) : raw
    const method = compress ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    localParts.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cd, eocd])
}

const DOC_PARA = (runs: string, pPr = ''): string => `<w:p>${pPr}${runs}</w:p>`
const RUN = (text: string, rPr = ''): string => `<w:r>${rPr}<w:t xml:space="preserve">${text}</w:t></w:r>`

function docxFixture(): Buffer {
  const doc = [
    '<w:document><w:body>',
    DOC_PARA(RUN('季度报告'), '<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'),
    DOC_PARA(RUN('本季度营收 ') + RUN('增长 20%', '<w:rPr><w:b/></w:rPr>') + RUN('，感谢团队 &amp; 大家。')),
    '<w:p/>',
    DOC_PARA(RUN('第一条'), '<w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr>'),
    DOC_PARA(RUN('第二条'), '<w:pPr><w:numPr/></w:pPr>'),
    '<w:tbl>',
    '<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>',
    '<w:tr><w:tc><w:p><w:r><w:t>营收</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1,234 万</w:t></w:r></w:p></w:tc></w:tr>',
    '</w:tbl>',
    '</w:body></w:document>',
  ].join('')
  return buildZip([['word/document.xml', doc]])
}

function xlsxFixture(): Buffer {
  return buildZip([
    [
      'xl/workbook.xml',
      '<workbook><sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="汇总" sheetId="2" r:id="rId2"/></sheets></workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    ],
    ['xl/sharedStrings.xml', '<sst><si><t>姓名</t></si><si><t>年龄</t></si><si><t>张三</t></si></sst>'],
    [
      'xl/styles.xml',
      '<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="0"/><xf numFmtId="164"/></cellXfs></styleSheet>',
    ],
    [
      'xl/worksheets/sheet1.xml',
      [
        '<worksheet><sheetData>',
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="inlineStr"><is><t>入职日期</t></is></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c><c r="C2" s="2"><v>45123</v></c></row>',
        '</sheetData></worksheet>',
      ].join(''),
    ],
    ['xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData></worksheet>'],
  ])
}

function pptxFixture(): Buffer {
  const slide1 = [
    '<p:sld><p:cSld><p:spTree>',
    '<p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>市场概览</a:t></a:r></a:p></p:txBody></p:sp>',
    '<p:sp><p:txBody><a:p><a:r><a:t>增长率 12%</a:t></a:r></a:p></p:txBody></p:sp>',
    '</p:spTree></p:cSld></p:sld>',
  ].join('')
  const slide2 = '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>下一步计划</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return buildZip([
    ['ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'],
    ['ppt/slides/slide1.xml', slide1],
    ['ppt/slides/slide2.xml', slide2],
  ])
}

/** 最小 PDF：4 号对象携带内容流（可选 FlateDecode） */
function pdfFixture(stream: Buffer, compress = true): Buffer {
  const payload = compress ? deflateSync(stream) : stream
  const head = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' +
      '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' +
      '3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>\nendobj\n' +
      `4 0 obj\n<< /Length ${payload.length} >>\nstream\n`,
    'latin1',
  )
  const tail = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF', 'latin1')
  return Buffer.concat([head, payload, tail])
}

// ---------- document-extract ----------

describe('document-extract：office 文本提取', () => {
  it('docx：标题 / 列表 / 表格 / 实体 → 结构化文本', () => {
    const out = extractDocumentText('.docx', docxFixture())!
    expect(out.extractor).toBe('docx')
    expect(out.text).toContain('# 季度报告')
    expect(out.text).toContain('本季度营收 增长 20%，感谢团队 & 大家。')
    expect(out.text).toContain('- 第一条')
    expect(out.text).toContain('- 第二条')
    expect(out.text).toContain('指标\t数值')
    expect(out.text).toContain('营收\t1,234 万')
    expect(out.truncated).toBe(false)
  })

  it('xlsx：工作表头 + TSV + 日期还原', () => {
    const out = extractDocumentText('.xlsx', xlsxFixture())!
    expect(out.extractor).toBe('xlsx')
    expect(out.text).toContain('# 工作表：数据')
    expect(out.text).toContain('姓名\t年龄\t入职日期')
    expect(out.text).toMatch(/张三\t30\t\d{4}-\d{2}-\d{2}/)
    expect(out.text).toContain('# 工作表：汇总')
    expect(out.text).toContain('42')
  })

  it('pptx：幻灯片标题与正文行', () => {
    const out = extractDocumentText('.pptx', pptxFixture())!
    expect(out.extractor).toBe('pptx')
    expect(out.text).toContain('# 幻灯片 1：市场概览')
    expect(out.text).toContain('增长率 12%')
    expect(out.text).toContain('# 幻灯片 2')
    expect(out.text).toContain('下一步计划')
  })

  it('非文档扩展名 → undefined（不走识别管道）', () => {
    expect(extractDocumentText('.md', Buffer.from('# hi'))).toBeUndefined()
  })
})

describe('document-extract：pdf 文本层还原', () => {
  const literalStream = Buffer.from(
    'BT\n/F1 12 Tf\n72 720 Td\n(Hello World) Tj\n72 706 Td\n(Second line) Tj\nET',
    'latin1',
  )

  it('压缩流 + 字面量字符串（转义与换行）', () => {
    const out = extractDocumentText('.pdf', pdfFixture(literalStream))!
    expect(out.extractor).toBe('pdf')
    expect(out.text).toContain('Hello World')
    expect(out.text).toContain('Second line')
    expect(out.text.split('\n')).toHaveLength(2)
  })

  it('未压缩流同样可提取（inflate 失败回退原文）', () => {
    const out = extractDocumentText('.pdf', pdfFixture(literalStream, false))!
    expect(out.text).toContain('Hello World')
  })

  it('UTF-16BE hex 字符串还原', () => {
    const stream = Buffer.from('BT\n/F1 12 Tf\n<00480065006C006C006F> Tj\nET', 'latin1')
    const out = extractDocumentText('.pdf', pdfFixture(stream))!
    expect(out.text).toBe('Hello')
  })

  it('无文本层（扫描件）→ 空文本 + 降级提示', () => {
    const stream = Buffer.from('q 1 0 0 1 0 0 cm Q', 'latin1')
    const out = extractDocumentText('.pdf', pdfFixture(stream))!
    expect(out.text).toBe('')
    expect(out.note).toContain('未能从该 PDF 提取到文本层')
  })

  it('乱码质量护栏：低可打印比例 → 提示还原质量低', () => {
    const stream = Buffer.concat([
      Buffer.from('BT\n(', 'latin1'),
      Buffer.from([0x81, 0x82, 0x8d, 0x90, 0x9f]),
      Buffer.from(') Tj\nET', 'latin1'),
    ])
    const out = extractDocumentText('.pdf', pdfFixture(stream))!
    expect(out.text.length).toBeGreaterThan(0)
    expect(out.note).toContain('还原质量较低')
  })
})

// ---------- read_file 集成 ----------

function readFileTool(): AgentTool<{ path: string; offset: number; limit: number }> {
  const registry = createToolRegistry(loadConfig())
  const tool = registry
    .forAgent({ tools: ['read_file'] }, 'execute')
    .find((t) => t.name === 'read_file') as AgentTool<{ path: string; offset: number; limit: number }> | undefined
  if (!tool) throw new Error('read_file 未注册')
  return tool
}

function makeReadRuntime(workspace: string): ToolRuntime {
  return { sessionId: 's1', runId: 'r1', agentId: 'pm', workspace, allowSensitive: false } as unknown as ToolRuntime
}

describe('read_file：M33 识别增强', () => {
  it('office 文档自动提取正文（替代 utf8 乱码）', async () => {
    const dir = makeTmpDir('m33-doc-')
    fs.writeFileSync(path.join(dir, 'report.docx'), docxFixture())
    const res = await readFileTool().execute({ path: 'report.docx', offset: 1, limit: 400 }, makeReadRuntime(dir))
    expect(res.ok).toBe(true)
    expect(res.summary).toContain('docx 文档')
    expect(res.detail).toContain('# 季度报告')
    expect(res.detail).toContain('营收\t1,234 万')
  })

  it('pdf 无文本层 → 拒绝并给出降级引导', async () => {
    const dir = makeTmpDir('m33-pdf-')
    const stream = Buffer.from('q 1 0 0 1 0 0 cm Q', 'latin1')
    fs.writeFileSync(path.join(dir, 'scan.pdf'), pdfFixture(stream))
    const res = await readFileTool().execute({ path: 'scan.pdf', offset: 1, limit: 400 }, makeReadRuntime(dir))
    expect(res.ok).toBe(false)
    expect(res.detail).toContain('未能从该 PDF 提取到文本层')
  })

  it('图片二进制 → 拒绝并引导视觉通道', async () => {
    const dir = makeTmpDir('m33-img-')
    fs.writeFileSync(path.join(dir, 'shot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const res = await readFileTool().execute({ path: 'shot.png', offset: 1, limit: 400 }, makeReadRuntime(dir))
    expect(res.ok).toBe(false)
    expect(res.summary).toContain('二进制文件')
    expect(res.detail).toContain('视觉')
  })

  it('文本文件行为不变（分页读取）', async () => {
    const dir = makeTmpDir('m33-txt-')
    fs.writeFileSync(path.join(dir, 'note.md'), '第一行\n第二行\n第三行\n')
    const res = await readFileTool().execute({ path: 'note.md', offset: 2, limit: 1 }, makeReadRuntime(dir))
    expect(res.ok).toBe(true)
    expect(res.detail).toContain('第二行')
    expect(res.detail).not.toContain('第一行')
  })
})
