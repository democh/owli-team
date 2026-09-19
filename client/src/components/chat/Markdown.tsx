/**
 * Markdown 渲染（§10.5 + M8 性能 + 扩展套件）：
 * - remark-gfm + 自写插件：@mention / ::: 容器（分栏·callout·details·kpi·timeline·mail·option·checklist·choice·verdict·pan·meeting·minutes·findings·claim·offer·debate）/
 *   代码块 meta（title+行高亮）；
 * - 代码块 → CodeBlock（shiki + 工具条）；```mermaid → MermaidBlock；```chart → ChartBlock（懒加载）；
 *   ```kline → KlineBlock / ```game → GameBlock（M34 金融投研，同懒加载模式）；
 * - 图片灯箱（img → ZoomableImage）、表格横向滚动包裹（table → MdTable）；
 * - 完成态渲染结果按内容哈希 LRU 缓存（≤200），流式不缓存；
 * - 流式期间代码块/图表一律纯文本（StreamingContext），完成后再高亮/渲染；
 *   轻结构容器（callout/分栏/kpi/timeline/mail/option/verdict/pan/meeting/minutes/findings/claim/offer/debate）流式期间直接渲染。
 */
import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentStore } from '../../stores/agent-store'
import { renderCache } from '../../lib/md-cache'
import { MentionChip } from './MentionChip'
import { CalloutCard } from './md-ext/CalloutCard'
import { ChartBlock } from './md-ext/ChartBlock'
import { ChecklistCard } from './md-ext/ChecklistCard'
import { ChoiceCard } from './md-ext/ChoiceCard'
import { ClaimCard } from './md-ext/ClaimCard'
import { CodeBlock } from './md-ext/CodeBlock'
import { DebateCard } from './md-ext/DebateCard'
import { FindingsCard } from './md-ext/FindingsCard'
import { GameBlock } from './md-ext/GameBlock'
import { KlineBlock } from './md-ext/KlineBlock'
import { KpiGroup, KpiItem } from './md-ext/KpiGroup'
import { MailCard } from './md-ext/MailCard'
import { MeetingCard } from './md-ext/MeetingCard'
import { MermaidBlock } from './md-ext/MermaidBlock'
import { MinutesCard } from './md-ext/MinutesCard'
import { OfferCard } from './md-ext/OfferCard'
import { OptionCard } from './md-ext/OptionCard'
import { PanCard } from './md-ext/PanCard'
import { parseLinesAttr, remarkCodeMeta, remarkContainers } from './md-ext/remark-ext'
import { StreamingContext } from './md-ext/streaming'
import { Timeline, TimelineItem } from './md-ext/Timeline'
import { VerdictCard } from './md-ext/VerdictCard'
import { ZoomableImage } from './md-ext/ZoomableImage'

const USER_TOKENS = new Set(['用户', 'user', '你'])

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

function splitText(value: string, names: Set<string>): MdNode[] {
  const nodes: MdNode[] = []
  const re = /@([\p{L}\p{N}_]+)/gu
  let last = 0
  let matched = false
  let m: RegExpExecArray | null
  while ((m = re.exec(value)) !== null) {
    const token = m[1]
    if (!names.has(token) && !USER_TOKENS.has(token)) continue
    matched = true
    if (m.index > last) nodes.push({ type: 'text', value: value.slice(last, m.index) })
    nodes.push({
      type: 'text',
      value: `@${token}`,
      data: {
        hName: 'span',
        hProperties: { 'data-mention': token },
        hChildren: [{ type: 'text', value: `@${token}` }],
      },
    })
    last = m.index + m[0].length
  }
  if (!matched) return []
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) })
  return nodes
}

/** 最小 remark 插件：文本节点中的已知 @token → <span data-mention> */
function remarkMentions(options: { names: string[] }): (tree: unknown) => void {
  const names = new Set(options.names)
  const walk = (node: MdNode): void => {
    if (!node.children) return
    const out: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('@')) {
        const parts = splitText(child.value, names)
        if (parts.length > 0) {
          out.push(...parts)
          continue
        }
      }
      walk(child)
      out.push(child)
    }
    node.children = out
  }
  return (tree: unknown) => walk(tree as MdNode)
}

interface MentionSpanProps {
  node?: unknown
  'data-mention'?: string
  className?: string
  children?: React.ReactNode
}

function MentionSpan({ node: _node, ...props }: MentionSpanProps): React.JSX.Element {
  const token = props['data-mention']
  if (!token) return <span {...props} />
  return <MentionChip token={token} />
}

interface LinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  node?: unknown
}

function ExternalLink({ node: _node, ...props }: LinkProps): React.JSX.Element {
  return <a target="_blank" rel="noreferrer" {...props} />
}

// ---------- fenced code 路由：mermaid / chart / 普通代码块 ----------

interface PreProps {
  node?: unknown
  children?: React.ReactNode
}

interface CodeChildProps {
  className?: string
  children?: React.ReactNode
  'data-title'?: string
  'data-lines'?: string
}

function nodeText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(nodeText).join('')
  return ''
}

function PreBlock({ node: _node, children }: PreProps): React.JSX.Element {
  const child = React.Children.toArray(children)[0]
  if (React.isValidElement(child)) {
    const props = child.props as CodeChildProps
    const match = /language-([\w-]+)/.exec(props.className ?? '')
    const lang = (match?.[1] ?? 'text').toLowerCase()
    const raw = nodeText(props.children).replace(/\n$/, '')
    const title = props['data-title']
    const lines = parseLinesAttr(props['data-lines'])
    if (lang === 'mermaid') return <MermaidBlock code={raw} title={title} />
    if (lang === 'chart' || lang === 'echarts') return <ChartBlock code={raw} title={title} />
    if (lang === 'kline') return <KlineBlock code={raw} title={title} />
    if (lang === 'game') return <GameBlock code={raw} title={title} />
    if (match || raw.includes('\n')) return <CodeBlock code={raw} lang={lang} title={title} lines={lines} />
  }
  return <pre>{children}</pre>
}

// ---------- 容器（callout/分栏/details/kpi/timeline/mail/option 经 unknown handler 产出 div/details） ----------

interface MdDivProps extends React.HTMLAttributes<HTMLDivElement> {
  node?: unknown
  'data-callout'?: string
  'data-title'?: string
  'data-kpi'?: string
  'data-kpi-item'?: string
  'data-name'?: string
  'data-value'?: string
  'data-delta'?: string
  'data-target'?: string
  'data-raw'?: string
  'data-timeline'?: string
  'data-timeline-item'?: string
  'data-date'?: string
  'data-text'?: string
  'data-owner'?: string
  'data-mail'?: string
  'data-to'?: string
  'data-cc'?: string
  'data-subject'?: string
  'data-body'?: string
  'data-option'?: string
  'data-status'?: string
  'data-checklist'?: string
  'data-choice'?: string
  'data-verdict'?: string
  'data-pan'?: string
  'data-meeting'?: string
  'data-minutes'?: string
  'data-findings'?: string
  'data-claim'?: string
  'data-detail'?: string
  'data-reasons'?: string
  'data-offer'?: string
  'data-debate'?: string
  'data-kind'?: string
  'data-fields'?: string
  'data-items'?: string
  'data-options'?: string
  'data-count'?: string
}

function attr(value: string | undefined): string {
  return value ?? ''
}

function MdDiv({ node: _node, children, 'data-callout': callout, 'data-title': title, ...rest }: MdDivProps): React.JSX.Element {
  if (callout) return <CalloutCard kind={callout} title={title}>{children}</CalloutCard>
  if (rest['data-kpi'] !== undefined) return <KpiGroup title={title}>{children}</KpiGroup>
  if (rest['data-kpi-item'] !== undefined) {
    return (
      <KpiItem
        name={attr(rest['data-name'])}
        value={attr(rest['data-value'])}
        delta={attr(rest['data-delta'])}
        target={attr(rest['data-target'])}
        raw={attr(rest['data-raw'])}
      />
    )
  }
  if (rest['data-timeline'] !== undefined) return <Timeline title={title}>{children}</Timeline>
  if (rest['data-timeline-item'] !== undefined) {
    return (
      <TimelineItem
        date={attr(rest['data-date'])}
        text={attr(rest['data-text'])}
        owner={attr(rest['data-owner'])}
        raw={attr(rest['data-raw'])}
      />
    )
  }
  if (rest['data-mail'] !== undefined) {
    return (
      <MailCard to={rest['data-to']} cc={rest['data-cc']} subject={rest['data-subject']} body={rest['data-body']}>
        {children}
      </MailCard>
    )
  }
  if (rest['data-option'] !== undefined) return <OptionCard status={rest['data-status']} title={title}>{children}</OptionCard>
  if (rest['data-checklist'] !== undefined) {
    return (
      <ChecklistCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </ChecklistCard>
    )
  }
  if (rest['data-choice'] !== undefined) {
    return (
      <ChoiceCard title={title} options={rest['data-options']} raw={rest['data-raw']}>
        {children}
      </ChoiceCard>
    )
  }
  if (rest['data-verdict'] !== undefined) {
    return (
      <VerdictCard status={rest['data-status']} title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </VerdictCard>
    )
  }
  if (rest['data-pan'] !== undefined) {
    return (
      <PanCard
        kind={rest['data-kind']}
        title={title}
        fields={rest['data-fields']}
        items={rest['data-items']}
        raw={rest['data-raw']}
      >
        {children}
      </PanCard>
    )
  }
  if (rest['data-meeting'] !== undefined) {
    return (
      <MeetingCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </MeetingCard>
    )
  }
  if (rest['data-minutes'] !== undefined) {
    return (
      <MinutesCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </MinutesCard>
    )
  }
  if (rest['data-findings'] !== undefined) {
    return (
      <FindingsCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </FindingsCard>
    )
  }
  if (rest['data-claim'] !== undefined) {
    return (
      <ClaimCard title={title} detail={rest['data-detail']} reasons={rest['data-reasons']} raw={rest['data-raw']}>
        {children}
      </ClaimCard>
    )
  }
  if (rest['data-offer'] !== undefined) {
    return (
      <OfferCard title={title} fields={rest['data-fields']} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </OfferCard>
    )
  }
  if (rest['data-debate'] !== undefined) {
    return (
      <DebateCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </DebateCard>
    )
  }
  return (
    <div {...rest} {...(title ? { 'data-title': title } : {})}>
      {children}
    </div>
  )
}

// ---------- 表格横向滚动包裹 / 图片灯箱 ----------

function MdTable({ node: _node, ...rest }: React.TableHTMLAttributes<HTMLTableElement> & { node?: unknown }): React.JSX.Element {
  return (
    <div className="md-table-wrap">
      <table {...rest} />
    </div>
  )
}

// ---------- 完成态渲染缓存（LRU 200） ----------

const RENDER_CACHE_MAX = 200
const MD_CACHE_MAX_CHARS = 20_000

function cacheGet(key: string): React.ReactNode | undefined {
  const hit = renderCache.get(key)
  if (hit !== undefined) {
    renderCache.delete(key)
    renderCache.set(key, hit)
  }
  return hit
}

function cacheSet(key: string, node: React.ReactNode): void {
  renderCache.set(key, node)
  if (renderCache.size > RENDER_CACHE_MAX) {
    const first = renderCache.keys().next().value
    if (first !== undefined) renderCache.delete(first)
  }
}

const COMPONENTS = {
  span: MentionSpan,
  a: ExternalLink,
  pre: PreBlock,
  div: MdDiv,
  img: ZoomableImage,
  table: MdTable,
}

export interface MarkdownProps {
  content: string
  className?: string
  /** 流式渲染：跳过缓存 + 代码块纯文本（完成后再高亮） */
  streaming?: boolean
}

export function Markdown({ content, className, streaming }: MarkdownProps): React.JSX.Element {
  const agents = useAgentStore((s) => s.agents)
  const names = React.useMemo(() => agents.flatMap((a) => [a.id, a.name]), [agents])
  const cacheable = !streaming && content.length <= MD_CACHE_MAX_CHARS
  const cacheKey = cacheable ? `${names.join(',')}\u0000${content}` : ''

  if (cacheable) {
    const cached = cacheGet(cacheKey)
    if (cached !== undefined) {
      return <div className={`md-body ${className ?? ''}`}>{cached}</div>
    }
  }

  const rendered = (
    <StreamingContext.Provider value={streaming === true}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkContainers, remarkCodeMeta, [remarkMentions, { names }]]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </StreamingContext.Provider>
  )
  if (cacheable) cacheSet(cacheKey, rendered)

  return <div className={`md-body ${className ?? ''}`}>{rendered}</div>
}
