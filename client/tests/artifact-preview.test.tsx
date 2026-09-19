/**
 * 交付件多格式预览（M24）测试：
 * - lib/artifacts：语言映射 / 文本类判定 / Office 可预览判定 / chart.json 约定 / URL 构造；
 * - lib/csv：RFC4180 解析（引号 / 转义 / 引号内换行 / CRLF / BOM）、分隔符检测、行列护栏、列宽归一；
 * - DataTable / CsvPreview 渲染；
 * - ArtifactsView 分派：html → 沙箱 iframe（raw=1）、csv → 表格、docx → 服务端解析 HTML、
 *   image → img 直出（不请求 content）、markdown → 正文 + 工具条按钮按 kind 收放。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Artifact } from '@multi-agent/shared'
import { ArtifactsView } from '../src/components/artifacts/ArtifactsView'
import { CsvPreview } from '../src/components/artifacts/CsvPreview'
import { DataTable } from '../src/components/artifacts/DataTable'
import {
  artifactContentUrl,
  artifactPreviewUrl,
  isChartJson,
  isPreviewableOffice,
  isTextKind,
  langForFile,
} from '../src/lib/artifacts'
import { delimiterLabel, detectDelimiter, parseDelimited } from '../src/lib/csv'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

// ---------- lib/artifacts ----------

describe('langForFile', () => {
  it('常见扩展映射到 shiki 语言', () => {
    expect(langForFile('src/a.ts')).toBe('typescript')
    expect(langForFile('docs/README.md')).toBe('markdown')
    expect(langForFile('api/schema.sql')).toBe('sql')
    expect(langForFile('styles/main.scss')).toBe('scss')
  })

  it('构建文件按 basename 特判（Dockerfile / Makefile 无扩展名）', () => {
    expect(langForFile('Dockerfile')).toBe('dockerfile')
    expect(langForFile('deploy/makefile')).toBe('makefile')
  })

  it('未知扩展回退 text', () => {
    expect(langForFile('notes.txt')).toBe('text')
    expect(langForFile('data.bin')).toBe('text')
    expect(langForFile('noext')).toBe('text')
  })
})

describe('kind 判定', () => {
  it('文本类：markdown / code / html / chart / data', () => {
    for (const kind of ['markdown', 'code', 'html', 'chart', 'data'] as const) {
      expect(isTextKind(kind)).toBe(true)
    }
    for (const kind of ['image', 'office', 'pdf', 'other'] as const) {
      expect(isTextKind(kind)).toBe(false)
    }
  })

  it('Office 可预览格式仅 docx / xlsx / pptx', () => {
    expect(isPreviewableOffice('a.docx')).toBe(true)
    expect(isPreviewableOffice('dir/b.XLSX')).toBe(true)
    expect(isPreviewableOffice('c.pptx')).toBe(true)
    expect(isPreviewableOffice('old.doc')).toBe(false)
    expect(isPreviewableOffice('old.xls')).toBe(false)
    expect(isPreviewableOffice('a.pdf')).toBe(false)
  })

  it('chart.json 约定：必须以 .chart.json 结尾', () => {
    expect(isChartJson('out/sales.chart.json')).toBe(true)
    expect(isChartJson('out/chart.json')).toBe(false)
    expect(isChartJson('out/data.json')).toBe(false)
  })
})

describe('URL 构造', () => {
  it('content URL：path 编码，download / raw 参数按需附加', () => {
    const url = new URL(artifactContentUrl('s1', '报告/明细 v2.csv'), 'http://test.local')
    expect(url.pathname).toBe('/api/sessions/s1/artifacts/content')
    expect(url.searchParams.get('path')).toBe('报告/明细 v2.csv')
    expect(url.searchParams.get('download')).toBeNull()

    const raw = artifactContentUrl('s1', 'site/index.html', { raw: true })
    expect(new URL(raw, 'http://test.local').searchParams.get('raw')).toBe('1')

    const dl = artifactContentUrl('s1', 'docs/周报.docx', { download: true })
    expect(new URL(dl, 'http://test.local').searchParams.get('download')).toBe('1')
  })

  it('preview URL 携带 path', () => {
    const url = new URL(artifactPreviewUrl('s1', 'docs/周报.docx'), 'http://test.local')
    expect(url.pathname).toBe('/api/sessions/s1/artifacts/preview')
    expect(url.searchParams.get('path')).toBe('docs/周报.docx')
  })
})

// ---------- lib/csv ----------

describe('parseDelimited', () => {
  it('基本逗号分隔 + 行拆分（尾随换行不产生空行）', () => {
    const p = parseDelimited('a,b,c\n1,2,3\n')
    expect(p.delimiter).toBe(',')
    expect(p.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
    expect(p.truncated).toBe(false)
  })

  it('引号包裹：分隔符 / 换行 / 双引号转义', () => {
    const p = parseDelimited('name,note\n"张,三","第一行\n第二行"\n"a""b",x')
    expect(p.rows).toEqual([
      ['name', 'note'],
      ['张,三', '第一行\n第二行'],
      ['a"b', 'x'],
    ])
  })

  it('CRLF 与 BOM 剥离', () => {
    const p = parseDelimited('\uFEFFa,b\r\n1,2\r\n')
    expect(p.rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('跳过完全空行；列宽归一（短行补空串）', () => {
    const p = parseDelimited('a,b,c\n\n1,2\n')
    expect(p.rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', ''],
    ])
  })

  it('行列护栏：maxRows / maxCols 截断并标记 truncated；长单元格截断 500 字', () => {
    const many = Array.from({ length: 10 }, (_, i) => `${i},x`).join('\n')
    const limited = parseDelimited(many, { maxRows: 3 })
    expect(limited.rows).toHaveLength(3)
    expect(limited.truncated).toBe(true)

    const wide = parseDelimited('a,b,c,d', { maxCols: 2 })
    expect(wide.rows[0]).toEqual(['a', 'b'])
    expect(wide.truncated).toBe(true)

    const long = parseDelimited(`a\n${'x'.repeat(600)}`)
    expect(long.rows[1]![0]).toHaveLength(501)
    expect(long.rows[1]![0]!.endsWith('…')).toBe(true)
  })

  it('显式 delimiter 覆盖自动检测', () => {
    const p = parseDelimited('a;b\n1;2', { delimiter: ',' })
    expect(p.delimiter).toBe(',')
    expect(p.rows).toEqual([['a;b'], ['1;2']])
  })
})

describe('detectDelimiter / delimiterLabel', () => {
  it('按首行引号外出现次数检测分隔符', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
    expect(detectDelimiter('a|b\n1|2')).toBe('|')
  })

  it('忽略引号内字符；空文件回退逗号', () => {
    expect(detectDelimiter('"a,b";c;d')).toBe(';')
    expect(detectDelimiter('')).toBe(',')
  })

  it('展示名', () => {
    expect(delimiterLabel('\t')).toBe('Tab')
    expect(delimiterLabel(',')).toBe('逗号')
    expect(delimiterLabel(';')).toBe('分号')
    expect(delimiterLabel('|')).toBe('竖线')
  })
})

// ---------- 组件渲染 ----------

describe('DataTable / CsvPreview', () => {
  it('DataTable：首行表头 + 数据行', () => {
    render(<DataTable rows={[['名称', '数量'], ['甲', '1']]} />)
    expect(screen.getByRole('columnheader', { name: '名称' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '甲' })).toBeInTheDocument()
  })

  it('CsvPreview：信息条显示数据行数 × 列数与分隔符', () => {
    render(<CsvPreview content={'a,b\n1,2\n3,4'} />)
    expect(screen.getByText(/2 行 × 2 列/)).toBeInTheDocument()
    expect(screen.getByText(/逗号/)).toBeInTheDocument()
  })

  it('CsvPreview：无数据行时给出空态', () => {
    render(<CsvPreview content={''} />)
    expect(screen.getByText(/没有可展示的数据行/)).toBeInTheDocument()
  })
})

// ---------- ArtifactsView 多格式分派 ----------

function makeArtifact(path: string, kind: Artifact['kind']): Artifact {
  return { path, kind, size: 1024, mtime: 1_700_000_000_000, updatedAt: '2026-06-01T08:00:00.000Z' }
}

const LIST: Artifact[] = [
  makeArtifact('site/index.html', 'html'),
  makeArtifact('data/orders.csv', 'data'),
  makeArtifact('docs/周报.docx', 'office'),
  makeArtifact('notes.md', 'markdown'),
  makeArtifact('docs/草稿.md', 'markdown'),
  makeArtifact('assets/logo.png', 'image'),
]

const CONTENT: Record<string, string> = {
  'site/index.html': '<!doctype html><html><body><h1>首页</h1></body></html>',
  'data/orders.csv': 'id,amount\n1,10\n2,20',
  'notes.md': '# 会议纪要\n\n结论：按计划推进。',
  'docs/草稿.md': '# 草稿\n\n<!-- §1 待填 -->\n\n## 一节\n\n粗稿。',
}

const fetchMock = vi.fn(async (input: unknown) => {
  const url = String(input)
  if (url.includes('/artifacts/preview')) {
    return jsonResponse({ kind: 'docx', html: '<h1>季度经营报告</h1><p>摘要正文</p>' })
  }
  if (url.includes('/artifacts/content')) {
    const path = new URL(url, 'http://test.local').searchParams.get('path') ?? ''
    return jsonResponse({ path, kind: 'code', size: 100, truncated: false, content: CONTENT[path] ?? '' })
  }
  if (/\/artifacts$/.test(url)) return jsonResponse({ artifacts: LIST })
  return jsonResponse({})
})

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 等列表加载完成（默认选中首个 html 且 iframe 就绪） */
async function waitFirstFile(container: HTMLElement): Promise<void> {
  await waitFor(() => expect(container.querySelector('iframe')).not.toBeNull())
}

beforeEach(() => {
  fetchMock.mockClear()
  vi.stubGlobal('fetch', fetchMock)
  useSessionStore.setState({ currentId: 's1', artifactVersion: 0 })
  useUiStore.setState({ requestedArtifactPath: undefined, lastArtifactPath: undefined })
  useAgentStore.setState({ agents: [] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ArtifactsView 多格式分派', () => {
  it('html → 沙箱 iframe（raw=1）直出；源码 / Diff 可用', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    const frame = container.querySelector('iframe')!
    expect(frame.getAttribute('src')).toContain('raw=1')
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-forms allow-modals')
    expect(screen.getByRole('button', { name: '源码' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument()
  })

  it('data（CSV）→ 表格预览 + 行列信息条', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    await userEvent.click(screen.getByTitle('data/orders.csv'))
    expect(await screen.findByText(/2 行 × 2 列/)).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: 'amount' })).toBeInTheDocument()
    expect(screen.getByRole('cell', { name: '10' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '源码' })).toBeInTheDocument()
  })

  it('office（docx）→ 服务端解析 HTML 渲染；工具条收起源码 / Diff', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    await userEvent.click(screen.getByTitle('docs/周报.docx'))
    await waitFor(() => expect(container.querySelector('.off-doc')).not.toBeNull())
    expect(screen.getByText('季度经营报告')).toBeInTheDocument()
    expect(screen.getByText('摘要正文')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '源码' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Diff' })).toBeNull()
    const previewCall = fetchMock.mock.calls.find(([u]) => String(u).includes('/artifacts/preview'))
    expect(String(previewCall?.[0])).toContain(encodeURIComponent('docs/周报.docx'))
  })

  it('image → img 直出且不请求 content', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    const before = fetchMock.mock.calls.filter(([u]) => String(u).includes('/artifacts/content')).length
    await userEvent.click(screen.getByTitle('assets/logo.png'))
    const img = await screen.findByAltText('assets/logo.png')
    expect(img.getAttribute('src')).toContain('/artifacts/content?')
    expect(img.getAttribute('src')).toContain('v=0')
    const after = fetchMock.mock.calls.filter(([u]) => String(u).includes('/artifacts/content')).length
    expect(after).toBe(before)
  })

  it('markdown → 正文渲染；源码 / Diff 可用', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    await userEvent.click(screen.getByTitle('notes.md'))
    expect(await screen.findByRole('heading', { name: '会议纪要' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '源码' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Diff' })).toBeInTheDocument()
  })

  it('markdown → 交付体检条（与 server write_file 同口径）：字数 / 章节 / 表格 / 来源', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    await userEvent.click(screen.getByTitle('notes.md'))
    expect(await screen.findByRole('heading', { name: '会议纪要' })).toBeInTheDocument()
    expect(screen.getByText('交付体检')).toBeInTheDocument()
    expect(screen.getByText(/\d+ 字/)).toBeInTheDocument()
    expect(screen.getByText(/(\d+) 章节/)).toBeInTheDocument()
    expect(screen.getByText(/表格 \d+/)).toBeInTheDocument()
    expect(screen.getByText(/来源 \d+/)).toBeInTheDocument()
  })

  it('markdown 占位残留 → 体检条显示 ⚠ 警告', async () => {
    const { container } = render(<ArtifactsView />)
    await waitFirstFile(container)
    await userEvent.click(screen.getByTitle('docs/草稿.md'))
    expect(await screen.findByText(/占位残留 1 处/)).toBeInTheDocument()
  })
})
