/**
 * Markdown 扩展（M14+）测试：
 * - 容器语法：::: cols/col 分栏（含跨段落块级内容）、callout 变体、details 折叠；
 * - fail-safe：未闭合容器内容展开、未知容器名保持原文、游离闭标记不误吞；
 * - 代码块：title 工具条 + 行高亮 + 长代码折叠 + 复制按钮；
 * - mermaid / chart：mock 渲染库（懒加载 chunk 不进测试），成功/失败/流式三态；
 * - 图片灯箱 / 表格横向包裹；
 * - 业务卡容器（M21）：::: kpi / ::: timeline / ::: mail / ::: option 解析、结构化条目、
 *   涨跌色与进度条、今天高亮、邮件字段解析与复制正文、状态徽标降级、懒续行收口；
 * - 裁决卡容器（M34-3）：::: verdict 解析（多方/空方/僵持状态色、结构化条目、未知词降级、fail-safe；
 *   M52-E：自然语言状态前缀「空方领先」→ short，标题保留原文）；
 * - 会议容器（M42）：::: meeting / ::: minutes fail-safe（未闭合内容展开 / 容器名严格匹配）；
 * - TurnCard：组色主题条、角色与波次徽章、流式进度线；
 * - remark-ext 纯函数：parseCodeMeta / parseLinesAttr。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { AgentDefinition, AgentGroup, ChatMessage } from '@multi-agent/shared'
import { Markdown } from '../src/components/chat/Markdown'
import { MessageItem } from '../src/components/chat/MessageItem'
import { buildChecklistBackfill, parseChecklistItems } from '../src/components/chat/md-ext/ChecklistCard'
import { buildChoiceBackfill } from '../src/components/chat/md-ext/ChoiceCard'
import { parseVerdictItems } from '../src/components/chat/md-ext/VerdictCard'
import { parseCodeMeta, parseLinesAttr } from '../src/components/chat/md-ext/remark-ext'
import { clearMarkdownCaches } from '../src/lib/md-cache'
import { createChart } from '../src/lib/chart'
import { renderMermaid } from '../src/lib/mermaid'
import { useAgentStore } from '../src/stores/agent-store'
import { useSessionStore } from '../src/stores/session-store'
import { useUiStore } from '../src/stores/ui-store'

vi.mock('../src/lib/mermaid', () => ({
  renderMermaid: vi.fn(async () => '<svg data-mock="mermaid"></svg>'),
}))
vi.mock('../src/lib/chart', () => ({
  createChart: vi.fn(() => ({ dispose: vi.fn() })),
}))

// ---------- fixtures ----------

const T0 = '2026-06-01T08:00:00.000Z'

function makeAgent(overrides: Partial<AgentDefinition> & { id: string; name: string }): AgentDefinition {
  return {
    role: '角色',
    title: '',
    description: '',
    capabilities: [],
    group: 'development',
    avatar: { gradient: ['#3b82f6', '#f59e0b'], icon: 'user' },
    handoff: [],
    ...overrides,
  }
}

const PM = makeAgent({ id: 'pm', name: '费利', role: '产品经理' })
const ARCHITECT = makeAgent({ id: 'architect', name: '艾达', role: '架构师' })

const GROUPS: AgentGroup[] = [
  {
    id: 'development',
    name: '研发团队',
    description: '',
    icon: 'users',
    theme: ['#3b82f6', '#60a5fa'],
    objective: '',
    chain: ['pm', 'architect'],
    defaultSkills: [],
    parallel: false,
    rounds: false,
    order: 0,
  },
]

function agentMsg(id: string, agentId: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    sessionId: 'sa',
    runId: 'r1',
    turnIndex: 0,
    role: 'agent',
    agentId,
    content: '消息内容',
    mentions: [],
    status: 'complete',
    createdAt: T0,
    ...overrides,
  }
}

beforeEach(() => {
  clearMarkdownCaches()
  vi.mocked(renderMermaid).mockClear()
  vi.mocked(createChart).mockClear()
  useAgentStore.setState({
    agents: [PM, ARCHITECT],
    groups: GROUPS,
    skills: [],
    loaded: true,
    loading: false,
    statuses: {},
  })
  useSessionStore.setState({ byId: new Map(), order: [] })
})

// ---------- remark-ext 纯函数 ----------

describe('remark-ext 纯函数', () => {
  it('parseCodeMeta：title（三种引号形态）+ 行号与范围', () => {
    expect(parseCodeMeta('title="app.ts" {2,5-7}')).toEqual({ title: 'app.ts', lines: [2, 5, 6, 7] })
    expect(parseCodeMeta("title='a.css'")).toEqual({ title: 'a.css' })
    expect(parseCodeMeta('title=main.go {1}')).toEqual({ title: 'main.go', lines: [1] })
    expect(parseCodeMeta('{7-5}')).toEqual({ lines: [5, 6, 7] })
    expect(parseCodeMeta(undefined)).toEqual({})
  })

  it('parseLinesAttr：逗号序列 → number[]，非法值过滤', () => {
    expect(parseLinesAttr('2,5,6')).toEqual([2, 5, 6])
    expect(parseLinesAttr('0,-1,abc')).toBeUndefined()
    expect(parseLinesAttr(undefined)).toBeUndefined()
  })
})

// ---------- 容器语法 ----------

describe('Markdown 容器：分栏 / callout / details', () => {
  it('::: cols / ::: col（紧凑写法）：渲染网格与列标题', () => {
    const { container } = render(
      <Markdown
        content={'::: cols 2\n::: col 前端\n页面与状态管理\n:::\n::: col 后端\n接口与数据模型\n:::\n:::'}
      />,
    )
    const cols = container.querySelector('.md-cols')
    expect(cols).not.toBeNull()
    expect(cols!.getAttribute('data-cols')).toBe('2')
    const colEls = container.querySelectorAll('.md-col')
    expect(colEls).toHaveLength(2)
    expect(colEls[0]!.getAttribute('data-title')).toBe('前端')
    expect(container.textContent).toContain('页面与状态管理')
    expect(container.textContent).toContain('接口与数据模型')
  })

  it('::: cols（空行 + 块级内容）：列表等落入对应列', () => {
    const content = [
      '::: cols',
      '',
      '::: col 交付物',
      '',
      '- 原型稿',
      '- 接口文档',
      '',
      ':::',
      '',
      '::: col 里程碑',
      '',
      'M1 建库，M2 联调。',
      '',
      ':::',
      '',
      ':::',
    ].join('\n')
    const { container } = render(<Markdown content={content} />)
    const cols = container.querySelectorAll('.md-col')
    expect(cols).toHaveLength(2)
    expect(cols[0]!.querySelectorAll('li')).toHaveLength(2)
    expect(cols[0]!.textContent).toContain('原型稿')
    expect(cols[1]!.textContent).toContain('M1 建库，M2 联调。')
  })

  it('::: tip 标题：渲染 callout 卡（变体类 + 标题 + 正文）', () => {
    const { container } = render(<Markdown content={'::: tip 建议\n先跑通最小闭环。\n:::'} />)
    const box = container.querySelector('.md-callout-tip')
    expect(box).not.toBeNull()
    expect(box!.querySelector('.md-callout-head')?.textContent).toContain('建议')
    expect(box!.textContent).toContain('先跑通最小闭环。')
  })

  it('callout 六变体与默认标签：::: warning 无语义标题 → 显示「注意」', () => {
    const { container } = render(<Markdown content={'::: warning\n不要删除生产数据。\n:::'} />)
    const box = container.querySelector('.md-callout-warning')
    expect(box).not.toBeNull()
    expect(box!.querySelector('.md-callout-head')?.textContent).toContain('注意')
  })

  it('::: details 标题：渲染原生 details/summary 折叠块', () => {
    const content = ['::: details 展开查看附录', '', '- 附一', '- 附二', '', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const details = container.querySelector('details.md-details')
    expect(details).not.toBeNull()
    expect(details!.querySelector('summary.md-details-summary')?.textContent).toContain('展开查看附录')
    expect(details!.querySelectorAll('.md-details-body li')).toHaveLength(2)
    expect(details!.hasAttribute('open')).toBe(false)
  })

  it('fail-safe：未闭合容器内容展开（无壳、内容保留）', () => {
    const { container } = render(<Markdown content={'::: danger\n磁碟即将写满\n\n无闭合标记'} />)
    expect(container.querySelector('.md-callout')).toBeNull()
    expect(container.textContent).toContain('磁碟即将写满')
    expect(container.textContent).toContain('无闭合标记')
  })

  it('未知容器名与游离闭标记：保持原文，不误吞后续内容', () => {
    const { container } = render(<Markdown content={'::: whatever\n普通段落\n:::\n\n后续段落'} />)
    expect(container.querySelector('.md-cols, .md-callout, .md-details')).toBeNull()
    expect(container.textContent).toContain('::: whatever')
    expect(container.textContent).toContain('后续段落')
  })
})

// ---------- 代码块增强 ----------

describe('Markdown 代码块增强', () => {
  it('title + 行高亮：工具条显示文件名，命中行带 hl-line', async () => {
    const { container } = render(<Markdown content={'```ts title="app.ts" {1}\nconst a = 1\n```'} />)
    expect(await screen.findByText('app.ts')).toBeInTheDocument()
    expect(container.querySelector('.md-block-lang')?.textContent).toBe('ts')
    expect(container.querySelector('.md-shiki .hl-line')).not.toBeNull()
    expect(screen.getByTitle('复制')).toBeInTheDocument()
  })

  it('长代码折叠：> 24 行出现「展开全部」，点击后出现「收起」', async () => {
    const code = Array.from({ length: 25 }, (_, i) => `const line${i} = ${i}`).join('\n')
    const user = userEvent.setup()
    render(<Markdown content={'```ts\n' + code + '\n```'} />)
    expect(await screen.findByText('25 行')).toBeInTheDocument()
    const expand = screen.getByText(/展开全部/)
    await user.click(expand)
    expect(screen.getByText('收起')).toBeInTheDocument()
  })

  it('短代码不折叠', async () => {
    render(<Markdown content={'```ts\nconst a = 1\nconst b = 2\n```'} />)
    expect(await screen.findByText('复制')).toBeInTheDocument()
    expect(screen.queryByText(/展开全部/)).toBeNull()
  })
})

// ---------- mermaid ----------

describe('Markdown mermaid 图表块', () => {
  it('完成态：调用 renderMermaid 渲染 SVG，工具条含源码/全屏', async () => {
    const code = 'graph TD\n  A[需求] --> B[设计]'
    const { container } = render(<Markdown content={'```mermaid\n' + code + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-mermaid-canvas svg')).not.toBeNull())
    expect(vi.mocked(renderMermaid)).toHaveBeenCalledWith(code)
    expect(screen.getByText('mermaid')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByTitle('全屏查看'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('流式期间：仅纯文本源码，不触发渲染', () => {
    const { container } = render(<Markdown content={'```mermaid\ngraph TD\n  A --> B\n```'} streaming />)
    expect(container.querySelector('.md-mermaid')).toBeNull()
    expect(container.textContent).toContain('graph TD')
    expect(vi.mocked(renderMermaid)).not.toHaveBeenCalled()
  })

  it('渲染失败：错误卡 + 自动展开源码', async () => {
    vi.mocked(renderMermaid).mockRejectedValueOnce(new Error('Parse error on line 2'))
    const { container } = render(<Markdown content={'```mermaid\nbroken diagram\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-mermaid-error')).not.toBeNull())
    expect(container.querySelector('.md-mermaid-error')!.textContent).toContain('Parse error on line 2')
    expect(container.querySelector('.md-mermaid-source')).not.toBeNull()
  })

  it('源码开关：点击「源码」显示/收起源码', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={'```mermaid\ngraph LR\n  X --> Y\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-mermaid-canvas')).not.toBeNull())
    expect(container.querySelector('.md-mermaid-source')).toBeNull()
    await user.click(screen.getByTitle('查看源码'))
    expect(container.querySelector('.md-mermaid-source')).not.toBeNull()
    await user.click(screen.getByTitle('收起源码'))
    expect(container.querySelector('.md-mermaid-source')).toBeNull()
  })
})

// ---------- chart ----------

const CHART_JSON = JSON.stringify({
  type: 'bar',
  title: '各端预算',
  labels: ['Web', 'iOS'],
  series: [{ name: '预算', data: [12, 8] }],
})

describe('Markdown chart 图表块', () => {
  it('合法 JSON：解析后交给 echarts 运行时（懒加载 chunk）创建画布', async () => {
    const { container } = render(<Markdown content={'```chart\n' + CHART_JSON + '\n```'} />)
    await waitFor(() => expect(container.querySelector('.md-chart-canvas[data-state="ready"]')).not.toBeNull())
    expect(vi.mocked(createChart)).toHaveBeenCalledTimes(1)
    expect(screen.getByText('各端预算')).toBeInTheDocument()
    expect(container.querySelector('.md-block-lang')?.textContent).toBe('bar')
  })

  it('全屏：Overlay 内二次创建 + Esc 关闭', async () => {
    const user = userEvent.setup()
    render(<Markdown content={'```chart\n' + CHART_JSON + '\n```'} />)
    await waitFor(() => expect(vi.mocked(createChart)).toHaveBeenCalledTimes(1))
    await user.click(screen.getByTitle('全屏查看'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeInTheDocument()
    await waitFor(() => expect(vi.mocked(createChart)).toHaveBeenCalledTimes(2))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('非法 JSON：错误卡 + 源码回退，不加载运行时', () => {
    const { container } = render(<Markdown content={'```chart\n{ not json }\n```'} />)
    expect(container.querySelector('.md-chart-error')).not.toBeNull()
    expect(container.textContent).toContain('图表配置无效')
    expect(vi.mocked(createChart)).not.toHaveBeenCalled()
  })

  it('flowchart 之外的类型校验：未知类型给出可读错误', () => {
    const { container } = render(<Markdown content={'```chart\n{"type":"radar","data":[1]}\n```'} />)
    expect(container.querySelector('.md-chart-error')!.textContent).toContain('不支持的图表类型')
  })
})

// ---------- 图片灯箱 / 表格 ----------

describe('Markdown 图片灯箱与表格包裹', () => {
  it('图片：包一层放大入口，点击打开浮层，Esc 关闭', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={'![架构图](/ws/arch.png)'} />)
    const btn = container.querySelector('.md-img-btn')
    expect(btn).not.toBeNull()
    expect(btn!.querySelector('img.md-img')?.getAttribute('src')).toBe('/ws/arch.png')
    await user.click(btn!)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByRole('dialog').querySelector('img.md-img-zoom')).not.toBeNull()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('表格：外层包裹横向滚动容器', () => {
    const { container } = render(<Markdown content={'| 项 | 值 |\n| --- | --- |\n| 用例 | 42 |'} />)
    const wrap = container.querySelector('.md-table-wrap')
    expect(wrap).not.toBeNull()
    expect(wrap!.querySelector('table')).not.toBeNull()
  })
})

// ---------- 业务卡容器（M21）：kpi / timeline / mail / option ----------

const KPI_CONTENT = ['::: kpi 经营指标', '- 营收 | 120万 | +8% | 150万', '- 毛利 | 45% | -2% | 50%', ':::'].join('\n')

describe('Markdown KPI 卡组（::: kpi）', () => {
  it('紧凑列表（闭标记被懒续行并入）：条目拆为卡片，字段与 hover 原行齐全', () => {
    const { container } = render(<Markdown content={KPI_CONTENT} />)
    expect(container.querySelector('.md-kpi-title')?.textContent).toBe('经营指标')
    const items = container.querySelectorAll('.md-kpi-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('.md-kpi-name')?.textContent).toBe('营收')
    expect(items[0]!.querySelector('.md-kpi-value')?.textContent).toBe('120万')
    expect(items[0]!.getAttribute('title')).toBe('营收 | 120万 | +8% | 150万')
    expect(items[0]!.querySelector('.md-kpi-delta')?.className).toContain('is-up')
    expect(items[1]!.querySelector('.md-kpi-delta')?.className).toContain('is-down')
  })

  it('目标进度条：120/150 → 80%；无目标 / 无符号变化 → 不渲染进度条、中性色', () => {
    const { container } = render(<Markdown content={KPI_CONTENT} />)
    const bar = container.querySelector('.md-kpi-progress-bar') as HTMLElement
    expect(bar.style.width).toBe('80%')
    expect(container.querySelector('.md-kpi-progress')?.getAttribute('title')).toContain('目标 150万')

    const plain = render(<Markdown content={'::: kpi\n- 毛利率 | 45% | 持平\n:::'} />)
    expect(plain.container.querySelector('.md-kpi-progress')).toBeNull()
    const delta = plain.container.querySelector('.md-kpi-delta')!
    expect(delta.className).not.toContain('is-up')
    expect(delta.className).not.toContain('is-down')
  })

  it('点击数值复制：写入剪贴板并短暂显示勾选', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={KPI_CONTENT} />)
    await user.click(container.querySelector('.md-kpi-value')!)
    await waitFor(() => expect(container.querySelector('.md-kpi-value .lucide-check')).not.toBeNull())
    expect(await navigator.clipboard.readText()).toBe('120万')
  })

  it('fail-safe：未闭合 kpi 无卡片壳、内容展开保留', () => {
    const { container } = render(<Markdown content={'::: kpi 指标\n\n- 营收 | 120万\n\n后续段落'} />)
    expect(container.querySelector('.md-kpi')).toBeNull()
    expect(container.textContent).toContain('营收 | 120万')
    expect(container.textContent).toContain('后续段落')
  })

  it('非结构化列表：不含 | 的列表保持 markdown 列表', () => {
    const { container } = render(<Markdown content={'::: kpi 备注\n\n- 纯文本项\n\n:::'} />)
    expect(container.querySelector('.md-kpi')).not.toBeNull()
    expect(container.querySelectorAll('.md-kpi-item')).toHaveLength(0)
    expect(container.querySelector('.md-kpi li')?.textContent).toContain('纯文本项')
  })

  it('流式期间：轻结构容器直接渲染卡片（不降级纯文本）', () => {
    const { container } = render(<Markdown content={KPI_CONTENT} streaming />)
    expect(container.querySelectorAll('.md-kpi-item')).toHaveLength(2)
  })
})

describe('Markdown 时间轴（::: timeline）', () => {
  it('条目渲染：日期 chip / 事项 / 负责人 chip / 两段条目无负责人', () => {
    const content = [
      '::: timeline 内容日历',
      '- 2026-06-20 | 公众号推文 | 林悦',
      '- 2026-06-25 | 短视频发布',
      ':::',
    ].join('\n')
    const { container } = render(<Markdown content={content} />)
    expect(container.querySelector('.md-timeline-title')?.textContent).toBe('内容日历')
    const items = container.querySelectorAll('.md-timeline-item')
    expect(items).toHaveLength(2)
    expect(items[0]!.querySelector('.md-timeline-date')?.textContent).toBe('2026-06-20')
    expect(items[0]!.querySelector('.md-timeline-text')?.textContent).toBe('公众号推文')
    expect(items[0]!.querySelector('.md-timeline-owner')?.textContent).toBe('林悦')
    expect(items[0]!.getAttribute('title')).toBe('2026-06-20 | 公众号推文 | 林悦')
    expect(items[1]!.querySelector('.md-timeline-owner')).toBeNull()
  })

  it('今天高亮：命中当天日期 → is-today + 「今天」徽标（远期日期不高亮）', () => {
    const now = new Date()
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const content = ['::: timeline', `- ${today} | 今日例会 | 齐安`, '- 2099-01-01 | 远期计划', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const items = container.querySelectorAll('.md-timeline-item')
    expect(items[0]!.querySelector('.md-timeline-date')?.className).toContain('is-today')
    expect(items[0]!.querySelector('.md-timeline-today')?.textContent).toBe('今天')
    expect(items[1]!.querySelector('.md-timeline-date')?.className).not.toContain('is-today')
    expect(items[1]!.querySelector('.md-timeline-today')).toBeNull()
  })

  it('点负责人 chip → 派活草稿回填（只写草稿不直发）', () => {
    useUiStore.setState({ composerInsert: undefined })
    const content = ['::: timeline 内容日历', '- 2026-06-20 | 公众号推文 | 林悦', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    fireEvent.click(container.querySelector('.md-timeline-owner')!)
    expect(useUiStore.getState().composerInsert?.text).toBe('@林悦 ')
  })
})

const MAIL_CONTENT = [
  '::: mail 春季报价',
  '',
  '收件人: 张总 <zhang@acme.com>',
  '抄送: 李经理',
  '主题: 春季报价跟进',
  '',
  '张总您好，附件是最新报价，请查收。',
  ':::',
].join('\n')

describe('Markdown 邮件卡（::: mail）', () => {
  it('头部字段解析：主题 / 收件人（邮箱 autolink）/ 抄送；正文不含头部行', () => {
    const { container } = render(<Markdown content={MAIL_CONTENT} />)
    expect(container.querySelector('.md-mail-subject')?.textContent).toBe('春季报价跟进')
    const fields = container.querySelectorAll('.md-mail-field')
    expect(fields).toHaveLength(2)
    expect(fields[0]!.textContent).toContain('收件人')
    expect(fields[0]!.textContent).toContain('张总 zhang@acme.com')
    expect(fields[1]!.textContent).toContain('李经理')
    const body = container.querySelector('.md-mail-body')!
    expect(body.textContent).toContain('张总您好')
    expect(body.textContent).not.toContain('收件人')
  })

  it('复制正文：写入剪贴板并显示「已复制」（复用 CopyButton 状态复位）', async () => {
    const user = userEvent.setup()
    render(<Markdown content={MAIL_CONTENT} />)
    await user.click(screen.getByTitle('复制正文'))
    await waitFor(() => expect(screen.getByText('已复制')).toBeInTheDocument())
    expect(await navigator.clipboard.readText()).toContain('张总您好')
  })

  it('主题回退：无「主题:」头部行时用容器参数；头部行消费后正文保留', () => {
    const { container } = render(<Markdown content={'::: mail 报价跟进\n\n收件人: 张总\n\n张总您好。\n\n:::'} />)
    expect(container.querySelector('.md-mail-subject')?.textContent).toBe('报价跟进')
    expect(container.querySelector('.md-mail-field')?.textContent).toContain('张总')
    expect(container.querySelector('.md-mail-body')?.textContent).toContain('张总您好。')
  })

  it('无头部字段：仅正文 + 复制按钮（头部区块不出现）', () => {
    const { container } = render(<Markdown content={'::: mail\n\n直接正文段落。\n\n:::'} />)
    expect(container.querySelector('.md-mail-subject')).toBeNull()
    expect(container.querySelectorAll('.md-mail-field')).toHaveLength(0)
    expect(container.querySelector('.md-mail-body')?.textContent).toContain('直接正文段落。')
  })
})

describe('Markdown 方案卡（::: option）', () => {
  it('推荐方案：徽标「推荐」+ 绿色变体类 + 正文列表', () => {
    const content = ['::: option 推荐 方案A：自研', '- 成本低', '- 周期 2 周', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const card = container.querySelector('.md-option-recommend')
    expect(card).not.toBeNull()
    expect(card!.querySelector('.md-option-badge')?.textContent).toBe('推荐')
    expect(card!.querySelector('.md-option-title')?.textContent).toBe('方案A：自研')
    expect(card!.querySelectorAll('li')).toHaveLength(2)
  })

  it('备选 / 否决 / 待定：蓝 / 红 / 灰变体类', () => {
    const alt = render(<Markdown content={'::: option 备选 方案B\n外包定制\n:::'} />)
    expect(alt.container.querySelector('.md-option-alternate')).not.toBeNull()
    expect(alt.container.querySelector('.md-option-badge')?.textContent).toBe('备选')
    const reject = render(<Markdown content={'::: option 否决 方案C\n风险过高\n:::'} />)
    expect(reject.container.querySelector('.md-option-reject')).not.toBeNull()
    const pending = render(<Markdown content={'::: option 待定 方案D\n待评估\n:::'} />)
    expect(pending.container.querySelector('.md-option-pending')).not.toBeNull()
  })

  it('未知状态：降级为标题卡（无徽标、无变体类、标题为整段参数）', () => {
    const { container } = render(<Markdown content={'::: option 方案A 自研\n- 说明\n:::'} />)
    const card = container.querySelector('.md-option')!
    expect(card.className).toBe('md-option')
    expect(card.querySelector('.md-option-badge')).toBeNull()
    expect(card.querySelector('.md-option-title')?.textContent).toBe('方案A 自研')
    expect(card.querySelector('li')?.textContent).toBe('说明')
  })

  it('fail-safe：未闭合 option 无卡片壳、内容展开保留', () => {
    const { container } = render(<Markdown content={'::: option 推荐 方案X\n\n优点：成本可控\n\n后续段落'} />)
    expect(container.querySelector('.md-option')).toBeNull()
    expect(container.textContent).toContain('优点：成本可控')
    expect(container.textContent).toContain('后续段落')
  })

  it('M37「选它」：标题写入 Composer 草稿（拍板：，可编辑后发送）', () => {
    useUiStore.setState({ composerInsert: undefined })
    const { container } = render(<Markdown content={'::: option 推荐 方案A：自研\n- 成本低\n:::'} />)
    fireEvent.click(container.querySelector('.md-option-pick')!)
    expect(useUiStore.getState().composerInsert?.text).toBe('拍板：方案A：自研')
  })
})

// ---------- TurnCard ----------

describe('TurnCard 展示（MessageItem）', () => {
  it('组色主题条：按 agent.group 命中 group.theme[0]', () => {
    const m = agentMsg('m1', 'pm')
    useSessionStore.setState({ byId: new Map([[m.id, m]]), order: [m.id] })
    const { container } = render(<MessageItem messageId={m.id} />)
    const accent = container.querySelector('[data-turn-accent]')
    expect(accent).not.toBeNull()
    expect(accent!.getAttribute('data-turn-accent')).toBe('#3b82f6')
  })

  it('角色与波次徽章：turnIndex=1 → 「第 2 波」', () => {
    const m = agentMsg('m2', 'architect', { turnIndex: 1 })
    useSessionStore.setState({ byId: new Map([[m.id, m]]), order: [m.id] })
    render(<MessageItem messageId={m.id} />)
    expect(screen.getByText('架构师')).toBeInTheDocument()
    expect(screen.getByText('第 2 波')).toBeInTheDocument()
  })

  it('流式状态：顶部进度线出现，完成后移除', () => {
    const m = agentMsg('m3', 'pm', { status: 'streaming', content: '正在输出' })
    useSessionStore.setState({ byId: new Map([[m.id, m]]), order: [m.id] })
    const { container, rerender } = render(<MessageItem messageId={m.id} />)
    expect(container.querySelector('.turn-progress')).not.toBeNull()
    const done = { ...m, status: 'complete' as const }
    act(() => {
      useSessionStore.setState({ byId: new Map([[m.id, done]]), order: [m.id] })
    })
    rerender(<MessageItem messageId={m.id} />)
    expect(container.querySelector('.turn-progress')).toBeNull()
  })
})

// ---------- M37：交互式容器（checklist / choice） ----------

describe('Markdown 任务清单（::: checklist）', () => {
  const CONTENT = ['::: checklist 上线检查', '- [x] 备份数据库', '- [ ] 关闭写流量', '- [ ] 回滚演练', ':::'].join('\n')

  beforeEach(() => {
    useUiStore.setState({ composerInsert: undefined })
  })

  it('结构化条目：标题 / 计数 / 勾选态（GFM task item）', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    const card = container.querySelector('.md-checklist')!
    expect(card.querySelector('.md-checklist-head')?.textContent).toContain('上线检查')
    expect(card.querySelector('.md-checklist-count')?.textContent).toBe('1/3')
    const lines = card.querySelectorAll('.md-checkline')
    expect(lines).toHaveLength(3)
    expect(lines[0]!.className).toContain('is-done')
    expect(lines[1]!.className).not.toContain('is-done')
    expect(lines[0]!.querySelector('.md-check-label')?.textContent).toBe('备份数据库')
  })

  it('点选切换：样式与计数联动', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    fireEvent.click(container.querySelectorAll('.md-checkline')[1]!)
    expect(container.querySelector('.md-checklist-count')?.textContent).toBe('2/3')
    expect(container.querySelectorAll('.md-checkline')[1]!.className).toContain('is-done')
  })

  it('回填完成情况：任务清单 markdown 进 Composer 草稿（带当前勾选）', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    fireEvent.click(container.querySelectorAll('.md-checkline')[1]!)
    fireEvent.click(screen.getByRole('button', { name: /回填完成情况/ }))
    const text = useUiStore.getState().composerInsert?.text ?? ''
    expect(text).toContain('《上线检查》')
    expect(text).toContain('- [x] 备份数据库')
    expect(text).toContain('- [x] 关闭写流量')
    expect(text).toContain('- [ ] 回滚演练')
  })

  it('流式降级：行与回填按钮禁用', () => {
    const { container } = render(<Markdown content={CONTENT} streaming />)
    expect((container.querySelectorAll('.md-checkline')[0] as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: /回填完成情况/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('非标前缀回退：`- []` 写法按未勾选解析并剥离前缀', () => {
    const content = ['::: checklist 回退检查', '- [x] 标准已做', '- [] 非标未做', ':::'].join('\n')
    const { container } = render(<Markdown content={content} />)
    const lines = container.querySelectorAll('.md-checkline')
    expect(lines).toHaveLength(2)
    expect(lines[0]!.className).toContain('is-done')
    expect(lines[1]!.className).not.toContain('is-done')
    expect(lines[1]!.querySelector('.md-check-label')?.textContent).toBe('非标未做')
  })

  it('fail-safe：未闭合 checklist 无卡片壳、列表原文保留', () => {
    const { container } = render(<Markdown content={'::: checklist 未闭合\n\n- [ ] 项目\n\n后续段落'} />)
    expect(container.querySelector('.md-checklist')).toBeNull()
    expect(container.textContent).toContain('项目')
    expect(container.textContent).toContain('后续段落')
  })

  it('纯函数：data-items 容错解析 + 回填文本格式', () => {
    expect(parseChecklistItems('not-json')).toEqual([])
    expect(parseChecklistItems(JSON.stringify([{ label: 1 }, null, { label: 'ok', checked: true }]))).toEqual([
      { label: 'ok', checked: true },
    ])
    const items = parseChecklistItems(JSON.stringify([{ label: 'A' }, { label: 'B', checked: true }]))
    expect(buildChecklistBackfill('标题', items, [true, false])).toBe('完成情况回填 · 《标题》（1/2）\n- [x] A\n- [ ] B')
  })
})

describe('Markdown 单选项（::: choice）', () => {
  const CONTENT = ['::: choice 选型', '- 方案A：自研', '- 方案B：外包', ':::'].join('\n')

  beforeEach(() => {
    useUiStore.setState({ composerInsert: undefined })
  })

  it('选项渲染 + 点选 / 再点取消', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    const card = container.querySelector('.md-choice')!
    expect(card.querySelector('.md-choice-head')?.textContent).toContain('选型')
    expect(card.querySelectorAll('.md-choiceline')).toHaveLength(2)
    fireEvent.click(container.querySelectorAll('.md-choiceline')[1]!)
    expect(container.querySelectorAll('.md-choiceline')[1]!.className).toContain('is-picked')
    expect(container.querySelector('.md-choice-foot')?.textContent).toContain('已选：方案B：外包')
    fireEvent.click(container.querySelectorAll('.md-choiceline')[1]!)
    expect(container.querySelectorAll('.md-choiceline')[1]!.className).not.toContain('is-picked')
  })

  it('「选这个」：未选禁用；选定后「拍板：」进草稿', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    expect((screen.getByRole('button', { name: /选这个/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(container.querySelectorAll('.md-choiceline')[0]!)
    fireEvent.click(screen.getByRole('button', { name: /选这个/ }))
    expect(useUiStore.getState().composerInsert?.text).toBe('拍板：方案A：自研')
    expect(buildChoiceBackfill('X')).toBe('拍板：X')
  })

  it('fail-safe：未闭合 choice 无卡片壳、列表原文保留', () => {
    const { container } = render(<Markdown content={'::: choice 未闭合\n\n- 甲\n\n- 乙'} />)
    expect(container.querySelector('.md-choice')).toBeNull()
    expect(container.textContent).toContain('甲')
  })
})

// ---------- M34-3：终局裁决卡（::: verdict） ----------

describe('Markdown 终局裁决卡（::: verdict）', () => {
  const CONTENT = [
    '::: verdict 多方 多空对弈裁决',
    '- 置信度 | 中',
    '- 核心依据 | 估值与现金流证据等级占优；矩阵均衡 0.62 : 0.38 偏多方',
    '- 翻盘条件 | 放量跌破密集区支撑 → 裁决翻转空方',
    ':::',
  ].join('\n')

  it('结构化条目：胜负徽章 / 标题 / 项名与内容拆分', () => {
    const { container } = render(<Markdown content={CONTENT} />)
    const card = container.querySelector('.md-verdict')!
    expect(card.className).toContain('md-verdict-long')
    expect(card.querySelector('.md-verdict-badge')?.textContent).toBe('多方')
    expect(card.querySelector('.md-verdict-title')?.textContent).toBe('多空对弈裁决')
    const rows = card.querySelectorAll('.md-verdict-row')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.querySelector('.md-verdict-label')?.textContent).toBe('置信度')
    expect(rows[0]!.querySelector('.md-verdict-value')?.textContent).toBe('中')
    expect(rows[2]!.querySelector('.md-verdict-value')?.textContent).toContain('裁决翻转空方')
  })

  it('状态映射：空方 / 僵持 状态色与徽章', () => {
    const bear = render(<Markdown content={['::: verdict 空方 空方裁决', '- 置信度 | 低', ':::'].join('\n')} />)
    expect(bear.container.querySelector('.md-verdict')!.className).toContain('md-verdict-short')
    expect(bear.container.querySelector('.md-verdict-badge')?.textContent).toBe('空方')
    bear.unmount()
    const draw = render(<Markdown content={['::: verdict 僵持 僵持裁决', '- 置信度 | 低', ':::'].join('\n')} />)
    expect(draw.container.querySelector('.md-verdict')!.className).toContain('md-verdict-draw')
    expect(draw.container.querySelector('.md-verdict-badge')?.textContent).toBe('僵持')
  })

  it('自然语言状态前缀（M52-E）：「空方领先」→ short，标题保留原文', () => {
    const { container } = render(
      <Markdown content={['::: verdict 空方领先', '- 置信度 | 中（60%）', ':::'].join('\n')} />,
    )
    const card = container.querySelector('.md-verdict')!
    expect(card.className).toContain('md-verdict-short')
    expect(card.querySelector('.md-verdict-badge')?.textContent).toBe('空方')
    expect(card.querySelector('.md-verdict-title')?.textContent).toBe('空方领先')
  })

  it('未知首词降级：无状态色与徽章、标题取整串；条目无 | 时只作项名', () => {
    const { container } = render(
      <Markdown content={['::: verdict 未知词 某裁决', '- 项 | 值', '- 仅项名', ':::'].join('\n')} />,
    )
    const card = container.querySelector('.md-verdict')!
    expect(card.className).not.toContain('md-verdict-long')
    expect(card.querySelector('.md-verdict-badge')).toBeNull()
    expect(card.querySelector('.md-verdict-title')?.textContent).toBe('未知词 某裁决')
    const rows = card.querySelectorAll('.md-verdict-row')
    expect(rows).toHaveLength(2)
    expect(rows[1]!.querySelector('.md-verdict-value')?.textContent).toBe('')
  })

  it('复制裁决：结构化 markdown（标题 + 条目）写入剪贴板', async () => {
    const user = userEvent.setup()
    const { container } = render(<Markdown content={CONTENT} />)
    await user.click(container.querySelector('.md-verdict-actions .md-block-btn')!)
    await waitFor(async () => {
      expect(await navigator.clipboard.readText()).toContain('《多空对弈裁决》（多方）')
    })
    const text = await navigator.clipboard.readText()
    expect(text).toContain('- 置信度：中')
    expect(text).toContain('- 翻盘条件：放量跌破密集区支撑 → 裁决翻转空方')
  })

  it('fail-safe：未闭合 verdict 无卡片壳、列表原文保留', () => {
    const { container } = render(<Markdown content={'::: verdict 多方 未闭合\n\n- 项名 | 内容\n\n后续段落'} />)
    expect(container.querySelector('.md-verdict')).toBeNull()
    expect(container.textContent).toContain('后续段落')
  })

  it('纯函数：data-items 容错解析', () => {
    expect(parseVerdictItems('not-json')).toEqual([])
    expect(parseVerdictItems(JSON.stringify([{ label: 1 }, null, { label: 'ok', value: 'v' }, { label: 'bare' }]))).toEqual([
      { label: 'ok', value: 'v' },
      { label: 'bare', value: '' },
    ])
  })
})

// ---------- M42：会议容器（::: meeting / ::: minutes） ----------

describe('Markdown 会议容器（fail-safe 与名严格匹配）', () => {
  it('未闭合 minutes / meeting：无卡片壳、条目与后续段落原文保留', () => {
    const minutes = render(
      <Markdown content={['::: minutes 未闭合纪要', '', '- 待办 | @周正 跟进', '', '后续段落'].join('\n')} />,
    )
    expect(minutes.container.querySelector('.md-minutes')).toBeNull()
    expect(minutes.container.textContent).toContain('待办 | @周正 跟进')
    expect(minutes.container.textContent).toContain('后续段落')

    const meeting = render(
      <Markdown content={['::: meeting 未闭合例会', '- 议题一', '', '后续段落'].join('\n')} />,
    )
    expect(meeting.container.querySelector('.md-meeting')).toBeNull()
    expect(meeting.container.textContent).toContain('后续段落')
  })

  it('容器名严格匹配：minutes2 / meeting2 不误判为会议容器', () => {
    const { container } = render(
      <Markdown content={['::: minutes2 标题', '- 待办 | @周正 跟进', ':::', '::: meeting2 标题', '- 议题一', ':::'].join('\n')} />,
    )
    expect(container.querySelector('.md-minutes')).toBeNull()
    expect(container.querySelector('.md-meeting')).toBeNull()
    expect(container.textContent).toContain('minutes2')
  })
})
