/**
 * Markdown 渲染（§10.5 + M8 性能 + 扩展套件）：
 * - remark-gfm + 自写插件：@mention / ::: 容器（分栏·callout·details·process·kpi·timeline·mail·option·checklist·choice·verdict·pan·meeting·minutes·findings·claim·offer·debate·idea·phase·score·sources·decision·postmortem）/
 *   代码块 meta（title+行高亮）；
 * - 代码块 → CodeBlock（shiki + 工具条）；```mermaid → MermaidBlock；```chart → ChartBlock（懒加载）；
 *   ```kline → KlineBlock / ```game → GameBlock（M34 金融投研，同懒加载模式）；
 * - 图片灯箱（img → ZoomableImage）、表格横向滚动包裹（table → MdTable）；
 * - 完成态渲染结果按内容哈希 LRU 缓存（≤200），流式不缓存；
 * - 流式期间代码块/图表一律纯文本（StreamingContext），完成后再高亮/渲染；
 *   轻结构容器（callout/分栏/kpi/timeline/mail/option/verdict/pan/meeting/minutes/findings/claim/offer/debate/idea/phase/score/sources/decision/postmortem/process）流式期间直接渲染。
 */
import * as React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAgentStore } from '../../stores/agent-store'
import { renderCache } from '../../lib/md-cache'
import { MentionChip } from './MentionChip'
import { useMessageInfo } from './md-ext/message-context'
import { CalloutCard } from './md-ext/CalloutCard'
import { CardsCard } from './md-ext/CardsCard'
import { ChartBlock } from './md-ext/ChartBlock'
import { ChecklistCard } from './md-ext/ChecklistCard'
import { ChoiceCard } from './md-ext/ChoiceCard'
import { ClaimCard } from './md-ext/ClaimCard'
import { CodeBlock } from './md-ext/CodeBlock'
import { DebateCard } from './md-ext/DebateCard'
import { DecisionCard } from './md-ext/DecisionCard'
import { FindingsCard } from './md-ext/FindingsCard'
import { GameBlock } from './md-ext/GameBlock'
import { IdeaCard } from './md-ext/IdeaCard'
import { KlineBlock } from './md-ext/KlineBlock'
import { LayoutCard } from './md-ext/LayoutCard'
import { KpiGroup, KpiItem } from './md-ext/KpiGroup'
import { MailCard } from './md-ext/MailCard'
import { MeetingCard } from './md-ext/MeetingCard'
import { MermaidBlock } from './md-ext/MermaidBlock'
import { MinutesCard } from './md-ext/MinutesCard'
import { OfferCard } from './md-ext/OfferCard'
import { OptionCard } from './md-ext/OptionCard'
import { PanCard } from './md-ext/PanCard'
import { PhaseBar } from './md-ext/PhaseBar'
import { FiguresCard } from './md-ext/FiguresCard'
import { PipelineCard } from './md-ext/PipelineCard'
import { PostmortemCard } from './md-ext/PostmortemCard'
import { ProcessBlock } from './md-ext/ProcessBlock'
import { ProgressCard } from './md-ext/ProgressCard'
import { QaCard } from './md-ext/QaCard'
import { TracksCard } from './md-ext/TracksCard'
import { QuizCard } from './md-ext/QuizCard'
import { MoodCard } from './md-ext/MoodCard'
import { GoalsCard } from './md-ext/GoalsCard'
import { LedgerCard } from './md-ext/LedgerCard'
import { ItineraryCard } from './md-ext/ItineraryCard'
import { RenderCard } from './md-ext/RenderCard'
import { parseLinesAttr, remarkCodeMeta, remarkContainers } from './md-ext/remark-ext'
import { RulingCard } from './md-ext/RulingCard'
import { RollCard } from './md-ext/RollCard'
import { RiskBand } from './md-ext/RiskBand'
import { ScoreCard } from './md-ext/ScoreCard'
import { SimCard } from './md-ext/SimCard'
import { SourcesCard } from './md-ext/SourcesCard'
import { StreamingContext } from './md-ext/streaming'
import { StanceCard } from './md-ext/StanceCard'
import { StyleBoardCard } from './md-ext/StyleBoardCard'
import { SplitCard } from './md-ext/SplitCard'
import { Timeline, TimelineItem } from './md-ext/Timeline'
import { VerdictCard } from './md-ext/VerdictCard'
import { ZoomableImage } from './md-ext/ZoomableImage'

const USER_TOKENS = new Set(['用户', 'user', '你'])
/** M79：可展开为具体人的泛称 token（'你' 是第二人称称呼，保持原样不展开） */
const EXPANDABLE_USER_TOKENS = new Set(['用户', 'user'])

interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

function splitText(value: string, names: Set<string>, userLabel: string): MdNode[] {
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
    // M79：@用户 / @user 泛称 → 本条消息有人类定向目标时就地展开为具体人名（无数据回退原 token）
    const label = userLabel && EXPANDABLE_USER_TOKENS.has(token) ? userLabel : token
    nodes.push({
      type: 'text',
      value: `@${token}`,
      data: {
        hName: 'span',
        hProperties: {
          'data-mention': token,
          ...(label !== token ? { 'data-mention-label': label } : {}),
        },
        hChildren: [{ type: 'text', value: `@${label}` }],
      },
    })
    last = m.index + m[0].length
  }
  if (!matched) return []
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) })
  return nodes
}

/** 最小 remark 插件：文本节点中的已知 @token → <span data-mention> */
function remarkMentions(options: { names: string[]; userLabel?: string }): (tree: unknown) => void {
  const names = new Set(options.names)
  const userLabel = options.userLabel ?? ''
  const walk = (node: MdNode): void => {
    if (!node.children) return
    const out: MdNode[] = []
    for (const child of node.children) {
      if (child.type === 'text' && child.value?.includes('@')) {
        const parts = splitText(child.value, names, userLabel)
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
  'data-mention-label'?: string
  className?: string
  children?: React.ReactNode
}

function MentionSpan({ node: _node, ...props }: MentionSpanProps): React.JSX.Element {
  const token = props['data-mention']
  if (!token) return <span {...props} />
  return <MentionChip token={token} label={props['data-mention-label']} />
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
  'data-ruling'?: string
  'data-head'?: string
  'data-stance-card'?: string
  'data-split'?: string
  'data-scope'?: string
  'data-pan'?: string
  'data-meeting'?: string
  'data-minutes'?: string
  'data-findings'?: string
  'data-claim'?: string
  'data-detail'?: string
  'data-reasons'?: string
  'data-perspective'?: string
  'data-stance'?: string
  'data-confidence'?: string
  'data-offer'?: string
  'data-debate'?: string
  'data-idea'?: string
  'data-no'?: string
  'data-phase'?: string
  'data-tone'?: string
  'data-score'?: string
  'data-scores'?: string
  'data-sources'?: string
  'data-decision'?: string
  'data-roll'?: string
  'data-cards'?: string
  'data-sim'?: string
  'data-postmortem'?: string
  // M81：过程叙述块（::: process）
  'data-process'?: string
  'data-chars'?: string
  'data-pipeline'?: string
  'data-figures'?: string
  'data-risk'?: string
  'data-progress'?: string
  'data-qa'?: string
  'data-tracks'?: string
  'data-quiz'?: string
  'data-mood'?: string
  'data-goals'?: string
  'data-ledger'?: string
  'data-itinerary'?: string
  'data-rows'?: string
  'data-kind'?: string
  'data-fields'?: string
  'data-items'?: string
  'data-options'?: string
  'data-count'?: string
  // M65-C：设计容器族
  'data-layout'?: string
  'data-styleboard'?: string
  'data-render'?: string
  'data-source'?: string
  'data-texture'?: string
}

function attr(value: string | undefined): string {
  return value ?? ''
}

function MdDiv({ node: _node, children, 'data-callout': callout, 'data-title': title, ...rest }: MdDivProps): React.JSX.Element {
  // M81：过程叙述块（顶层已上提至消息头部；摘要行 + 折叠交互由 ProcessBlock 承载）
  if (rest['data-process'] !== undefined) {
    const n = Number(rest['data-chars'])
    return (
      <ProcessBlock title={title} chars={Number.isFinite(n) && n > 0 ? n : undefined}>
        {children}
      </ProcessBlock>
    )
  }
  if (callout) return <CalloutCard kind={callout} title={title}>{children}</CalloutCard>
  if (rest['data-kpi'] !== undefined) return <KpiGroup title={title}>{children}</KpiGroup>
  if (rest['data-kpi-item'] !== undefined) {
    return (
      <KpiItem
        name={attr(rest['data-name'])}
        value={attr(rest['data-value'])}
        delta={attr(rest['data-delta'])}
        target={attr(rest['data-target'])}
        scope={rest['data-scope']}
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
  if (rest['data-ruling'] !== undefined) {
    return (
      <RulingCard
        status={rest['data-status']}
        head={rest['data-head']}
        title={title}
        items={rest['data-items']}
        raw={rest['data-raw']}
      >
        {children}
      </RulingCard>
    )
  }
  if (rest['data-stance-card'] !== undefined) {
    return (
      <StanceCard
        title={title}
        fields={rest['data-fields']}
        items={rest['data-items']}
        raw={rest['data-raw']}
      >
        {children}
      </StanceCard>
    )
  }
  if (rest['data-split'] !== undefined) {
    return (
      <SplitCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </SplitCard>
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
  if (rest['data-layout'] !== undefined) {
    return (
      <LayoutCard title={title} items={rest['data-items']} source={rest['data-source']}>
        {children}
      </LayoutCard>
    )
  }
  if (rest['data-styleboard'] !== undefined) {
    return (
      <StyleBoardCard title={title} items={rest['data-items']} texture={rest['data-texture']}>
        {children}
      </StyleBoardCard>
    )
  }
  if (rest['data-render'] !== undefined) {
    return (
      <RenderCard title={title} items={rest['data-items']}>
        {children}
      </RenderCard>
    )
  }
  if (rest['data-claim'] !== undefined) {
    return (
      <ClaimCard
        title={title}
        detail={rest['data-detail']}
        reasons={rest['data-reasons']}
        perspective={rest['data-perspective']}
        stance={rest['data-stance']}
        confidence={rest['data-confidence']}
        raw={rest['data-raw']}
      >
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
  if (rest['data-idea'] !== undefined) {
    return (
      <IdeaCard no={rest['data-no']} title={title} fields={rest['data-fields']} status={rest['data-status']} raw={rest['data-raw']}>
        {children}
      </IdeaCard>
    )
  }
  if (rest['data-phase'] !== undefined) {
    return (
      <PhaseBar title={title} tone={rest['data-tone']}>
        {children}
      </PhaseBar>
    )
  }
  if (rest['data-score'] !== undefined) {
    return (
      <ScoreCard title={title} scores={rest['data-scores']} raw={rest['data-raw']}>
        {children}
      </ScoreCard>
    )
  }
  if (rest['data-sources'] !== undefined) {
    return (
      <SourcesCard title={title} sources={rest['data-sources']} raw={rest['data-raw']}>
        {children}
      </SourcesCard>
    )
  }
  if (rest['data-decision'] !== undefined) {
    return (
      <DecisionCard title={title} fields={rest['data-fields']} raw={rest['data-raw']}>
        {children}
      </DecisionCard>
    )
  }
  if (rest['data-roll'] !== undefined) {
    return (
      <RollCard title={title} fields={rest['data-fields']} raw={rest['data-raw']}>
        {children}
      </RollCard>
    )
  }
  if (rest['data-cards'] !== undefined) {
    return (
      <CardsCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </CardsCard>
    )
  }
  if (rest['data-sim'] !== undefined) {
    return (
      <SimCard title={title} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </SimCard>
    )
  }
  if (rest['data-postmortem'] !== undefined) {
    return (
      <PostmortemCard title={title} fields={rest['data-fields']} items={rest['data-items']} raw={rest['data-raw']}>
        {children}
      </PostmortemCard>
    )
  }
  if (rest['data-pipeline'] !== undefined) {
    return (
      <PipelineCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </PipelineCard>
    )
  }
  if (rest['data-figures'] !== undefined) {
    return (
      <FiguresCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </FiguresCard>
    )
  }
  if (rest['data-risk'] !== undefined) {
    return (
      <RiskBand title={title} level={rest['data-risk']}>
        {children}
      </RiskBand>
    )
  }
  if (rest['data-progress'] !== undefined) {
    return (
      <ProgressCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </ProgressCard>
    )
  }
  if (rest['data-qa'] !== undefined) {
    return (
      <QaCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </QaCard>
    )
  }
  if (rest['data-tracks'] !== undefined) {
    return (
      <TracksCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </TracksCard>
    )
  }
  if (rest['data-quiz'] !== undefined) {
    return (
      <QuizCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </QuizCard>
    )
  }
  if (rest['data-mood'] !== undefined) {
    return <MoodCard title={title}>{children}</MoodCard>
  }
  if (rest['data-goals'] !== undefined) {
    return (
      <GoalsCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </GoalsCard>
    )
  }
  if (rest['data-ledger'] !== undefined) {
    return (
      <LedgerCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </LedgerCard>
    )
  }
  if (rest['data-itinerary'] !== undefined) {
    return (
      <ItineraryCard title={title} rows={rest['data-rows']} raw={rest['data-raw']}>
        {children}
      </ItineraryCard>
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
  const info = useMessageInfo()
  const names = React.useMemo(() => agents.flatMap((a) => [a.id, a.name]), [agents])
  // M79：@用户 泛称展开源（本条消息人类定向目标展示名；无上下文 = 按原 token 渲染）
  const userLabel = (info?.humanLabels ?? []).join('、')
  const cacheable = !streaming && content.length <= MD_CACHE_MAX_CHARS
  const cacheKey = cacheable ? `${names.join(',')}\u0000${userLabel}\u0000${content}` : ''

  if (cacheable) {
    const cached = cacheGet(cacheKey)
    if (cached !== undefined) {
      return <div className={`md-body ${className ?? ''}`}>{cached}</div>
    }
  }

  const rendered = (
    <StreamingContext.Provider value={streaming === true}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkContainers, remarkCodeMeta, [remarkMentions, { names, userLabel }]]}
        components={COMPONENTS}
      >
        {content}
      </ReactMarkdown>
    </StreamingContext.Provider>
  )
  if (cacheable) cacheSet(cacheKey, rendered)

  return <div className={`md-body ${className ?? ''}`}>{rendered}</div>
}
