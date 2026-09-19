/**
 * M24 测试：Office 交付件轻量预览（服务端零依赖解析）。
 *
 * 覆盖策略：
 * - zip 读取器：stored / deflate 两种压缩、条目越界与损坏容器报错；
 * - xlsx：共享字符串 / 内联字符串 / 布尔 / 日期样式序列号还原 / 多工作表 / 空单元格补齐；
 * - docx：标题 / 省略空段 / 粗体 run / 列表包装 / 表格 / XML 实体解码；
 * - pptx：占位符标题识别 / 正文行抽取 / 幻灯片数字序；
 * - classifyKind 与 isBinaryExt 全量映射（M24 新类型）。
 */
import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { classifyKind, isBinaryExt } from '../src/store/artifacts.js'
import { previewDocx, previewPptx, previewXlsx, previewOfficeFile } from '../src/util/office-preview.js'
import { readZipEntries } from '../src/util/zip.js'

// ---------- 测试用 zip 构造（stored / deflate） ----------

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
    [
      'xl/sharedStrings.xml',
      '<sst><si><t>姓名</t></si><si><t>年龄</t></si><si><r><t>张</t></r><r><t>三</t></r></si></sst>',
    ],
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
        '<row r="3"><c r="A3"/><c r="B3" t="str"><v>汇总</v></c><c r="D3" t="b"><v>1</v></c></row>',
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
    '<p:sp><p:txBody><a:p><a:r><a:t>增长率 12%</a:t></a:r></a:p><a:p><a:r><a:t>新客 340</a:t></a:r></a:p></p:txBody></p:sp>',
    '</p:spTree></p:cSld></p:sld>',
  ].join('')
  const slide2 = '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>下一步计划</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>'
  return buildZip([
    ['ppt/presentation.xml', '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>'],
    ['ppt/slides/slide1.xml', slide1],
    ['ppt/slides/slide2.xml', slide2],
  ])
}

// ---------- zip ----------

describe('zip：最小读取器', () => {
  it('stored / deflate 两种压缩均可读取，且只解出关心的条目', () => {
    for (const compress of [false, true]) {
      const buf = buildZip(
        [
          ['a.xml', '<a>1</a>'],
          ['dir/b.xml', '<b>2</b>'],
        ],
        compress,
      )
      const entries = readZipEntries(buf, (n) => n === 'dir/b.xml')
      expect([...entries.keys()]).toEqual(['dir/b.xml'])
      expect(entries.get('dir/b.xml')!.toString('utf8')).toBe('<b>2</b>')
    }
  })

  it('非 zip 容器 / 截断数据 → 报错', () => {
    expect(() => readZipEntries(Buffer.from('not a zip'), () => true)).toThrow('不是有效的 ZIP 容器')
    const buf = buildZip([['a.xml', '<a>1</a>']])
    expect(() => readZipEntries(buf.subarray(0, 20), () => true)).toThrow()
  })
})

// ---------- docx ----------

describe('docx：解析为语义化 HTML', () => {
  it('标题 / 段落（保留空格 + 实体解码）/ 粗体 / 列表 / 表格', () => {
    const { html } = previewDocx(docxFixture())
    expect(html).toContain('<h1>季度报告</h1>')
    expect(html).toContain('<p>本季度营收 <strong>增长 20%</strong>，感谢团队 &amp; 大家。</p>')
    expect(html).toContain('<ul><li>第一条</li><li>第二条</li></ul>')
    expect(html).toContain('<td>指标</td><td>数值</td>')
    expect(html).toContain('<td>营收</td><td>1,234 万</td>')
  })

  it('缺少 document.xml 的非 docx 容器 → 报错', () => {
    expect(() => previewDocx(buildZip([['word/other.xml', '<x/>']]))).toThrow('不是有效的 docx 文件')
  })
})

// ---------- xlsx ----------

describe('xlsx：解析为工作表二维数组', () => {
  it('共享字符串 / 内联字符串 / 数字 / 日期样式 / 布尔 / 空洞补齐', () => {
    const { sheets } = previewXlsx(xlsxFixture())
    expect(sheets.map((s) => s.name)).toEqual(['数据', '汇总'])
    expect(sheets[0].rows[0]).toEqual(['姓名', '年龄', '入职日期'])
    // 日期序列号 45123（yyyy-mm-dd 样式）→ 2023-07-16；缺列 A3 补空
    expect(sheets[0].rows[1]).toEqual(['张三', '30', '2023-07-16'])
    expect(sheets[0].rows[2]).toEqual(['', '汇总', '', 'TRUE'])
    expect(sheets[1].rows[0]).toEqual(['42'])
  })

  it('缺少 workbook.xml 的非 xlsx 容器 → 报错', () => {
    expect(() => previewXlsx(buildZip([['xl/other.xml', '<x/>']]))).toThrow('不是有效的 xlsx 文件')
  })
})

// ---------- pptx ----------

describe('pptx：解析为幻灯片大纲', () => {
  it('占位符标题识别 + 正文行 + 数字序排列', () => {
    const { slides } = previewPptx(pptxFixture())
    expect(slides).toHaveLength(2)
    expect(slides[0].title).toBe('市场概览')
    expect(slides[0].lines).toEqual(['增长率 12%', '新客 340'])
    expect(slides[1].title).toBeUndefined()
    expect(slides[1].lines).toEqual(['下一步计划'])
  })

  it('缺少 presentation.xml 的非 pptx 容器 → 报错', () => {
    expect(() => previewPptx(buildZip([['ppt/slides/slide1.xml', '<x/>']]))).toThrow('不是有效的 pptx 文件')
  })
})

// ---------- 分发与分类 ----------

describe('previewOfficeFile：按扩展名分发', () => {
  it('docx / xlsx / pptx 命中；doc / xls / ppt / pdf 返回 undefined（引导下载）', () => {
    expect(previewOfficeFile('.docx', docxFixture())?.kind).toBe('docx')
    expect(previewOfficeFile('.xlsx', xlsxFixture())?.kind).toBe('xlsx')
    expect(previewOfficeFile('.pptx', pptxFixture())?.kind).toBe('pptx')
    expect(previewOfficeFile('.doc', Buffer.alloc(0))).toBeUndefined()
    expect(previewOfficeFile('.xls', Buffer.alloc(0))).toBeUndefined()
    expect(previewOfficeFile('.ppt', Buffer.alloc(0))).toBeUndefined()
    expect(previewOfficeFile('.pdf', Buffer.alloc(0))).toBeUndefined()
  })
})

describe('classifyKind：M24 全量映射', () => {
  it('文本与结构化类型', () => {
    expect(classifyKind('docs/需求文档-登录.md')).toBe('markdown')
    expect(classifyKind('web/index.html')).toBe('html')
    expect(classifyKind('web/page.htm')).toBe('html')
    expect(classifyKind('diagram/流程.mmd')).toBe('chart')
    expect(classifyKind('diagram/架构.mermaid')).toBe('chart')
    expect(classifyKind('charts/营收.chart.json')).toBe('chart')
    expect(classifyKind('data/销售.csv')).toBe('data')
    expect(classifyKind('data/导出.tsv')).toBe('data')
    expect(classifyKind('src/app.ts')).toBe('code')
    expect(classifyKind('配置/app.yaml')).toBe('code')
    expect(classifyKind('logs/run.log')).toBe('code')
    expect(classifyKind('Dockerfile')).toBe('code')
    expect(classifyKind('.env')).toBe('code')
    expect(classifyKind('misc/archive.xyz')).toBe('other')
  })

  it('二进制与 Office 类型', () => {
    expect(classifyKind('decks/提案.pptx')).toBe('office')
    expect(classifyKind('报表/财务模型.xlsx')).toBe('office')
    expect(classifyKind('docs/合同终稿.docx')).toBe('office')
    expect(classifyKind('docs/合同旧版.doc')).toBe('office')
    expect(classifyKind('docs/白皮书.pdf')).toBe('pdf')
    expect(classifyKind('assets/hero.svg')).toBe('image')
  })
})

describe('isBinaryExt：二进制判定（含 Office / PDF；svg 例外为文本）', () => {
  it('office / pdf / 图片为二进制；svg / csv / html 为文本', () => {
    expect(isBinaryExt('a.xlsx')).toBe(true)
    expect(isBinaryExt('a.docx')).toBe(true)
    expect(isBinaryExt('a.pdf')).toBe(true)
    expect(isBinaryExt('a.png')).toBe(true)
    expect(isBinaryExt('a.zip')).toBe(true)
    expect(isBinaryExt('a.svg')).toBe(false)
    expect(isBinaryExt('a.csv')).toBe(false)
    expect(isBinaryExt('a.html')).toBe(false)
  })
})
