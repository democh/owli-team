/**
 * Markdown 容器扩展（自写 remark 插件，零新依赖；mdast 层工作）：
 * - `::: cols` / `::: col [标题]` 分栏（响应式网格，窄屏自动折叠为单列）；
 * - `::: tip|info|note|success|warning|danger [标题]` 提示块（callout）；
 * - `::: details 标题` 折叠块（原生 details/summary，无 JS 状态、缓存安全）；
 * - `::: kpi [标题]` 指标卡组（条目 `- 名称 | 值 | 变化 | 目标` → data-* 结构化节点）；
 * - `::: timeline [标题]` 时间轴（条目 `- 日期 | 事项 | 负责人` → data-* 结构化节点）；
 * - `::: mail [主题]` 邮件卡（正文前的 `收件人:/抄送:/主题:` 头部行 → data-* 字段）；
 * - `::: option [推荐|备选|否决|待定] 标题` 方案卡（首词命中状态才着色，否则降级标题卡）；
 * - `::: checklist [标题]` 任务清单（列表 → data-items JSON，checked 取 mdast / `[x]` 前缀回退）；
 * - `::: choice [标题]` 单选项（列表 → data-options JSON）；交互由 React 侧容器承载（ADR 0064）；
 * - `::: verdict <多方|空方|僵持|自然语言前缀> [标题]` 终局裁决卡（条目 `- 项名 | 内容` → data-items JSON；
 *   状态词容错「空方领先」→ short，口径共用 lib/verdict；M52-E）；
 * - `::: pan <bazi|ziwei|natal|gua> [标题]` 盘面卡（字段行 `键：值` → data-fields JSON；
 *   条目 `- 键 | 值` → data-items JSON）；
 * - `::: meeting [标题]` 会议声明卡（条目 `- [x] / - [>] / - 项` → data-items JSON，
 *   状态 已决 / 进行中 / 待议）；`::: minutes [标题]` 纪要卡（条目 `- 键 | 值` → data-items JSON，
 *   键 ∈ {决议 / 待办 / 风险}；M42）；
 * - `::: findings [标题]` 缺陷-修补配对卡（条目 `- 缺陷 N | 描述 | 修补方向` → data-items JSON；M43）；
 * - `::: claim [主张]` 主张卡（`细节：…` 字段行 → data-detail；条目 `- 论据 | 证据` → data-reasons JSON；M43）；
 * - `::: offer [标题]` 报价卡（字段行 `键：值` → data-fields JSON；条目 `- 键 | 值` → data-items JSON；M43）；
 * - `::: debate [题面]` 对决声明卡（条目 `- 键 | 值` → data-items JSON；M43）；
 * - `:::code` 之外的行内 `{2,5-7}` 行号标记由 remarkCodeMeta 解析到 data-lines。
 *
 * 解析规则（安全边界）：
 * - 仅处理「整段 children 皆为 text 且出现 ::: 标记行」的段落（代码块内不可能命中）；
 * - 开标记 `^:::(?!:) name [参数]$`、闭标记 `^::: *$`；栈式组装，支持嵌套；
 * - 未知容器名 / 多余闭标记 → 保持原文；未闭合容器 → 内容展开回父级（fail-safe）；
 * - 懒续行：`- 项` 后的 `:::` 会被 CommonMark 并入列表末项文本 → 块级子节点入栈前剥离收口；
 * - 容器节点用自定义类型 + data.hName/hProperties，由 mdast-util-to-hast 的
 *   unknown handler 生成 div/details/summary，React 侧按属性分支渲染。
 */
import { parseVerdictArg } from '../../../lib/verdict'

/** 与 Markdown.tsx 相同的宽松节点形状（避免跨模块类型循环） */
interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: {
    hName?: string
    hProperties?: Record<string, unknown>
    hChildren?: MdNode[]
  }
}

export const CALLOUT_KINDS = ['tip', 'info', 'note', 'success', 'warning', 'danger'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

/** option 状态中文词 → 语义键（未知词不进入此表 → 降级为标题卡） */
export const OPTION_STATUS_MAP: Record<string, string> = {
  推荐: 'recommend',
  备选: 'alternate',
  否决: 'reject',
  待定: 'pending',
}
export type OptionStatus = 'recommend' | 'alternate' | 'reject' | 'pending'

/** checklist 条目（data-items JSON 形状，React 侧 ChecklistCard 同构解析） */
export interface ChecklistItem {
  label: string
  checked: boolean
}

/** choice 选项（data-options JSON 形状，React 侧 ChoiceCard 同构解析） */
export interface ChoiceOption {
  label: string
}

/** verdict 条目（data-items JSON 形状，React 侧 VerdictCard 同构解析） */
export interface VerdictItem {
  label: string
  value: string
}

/** pan 盘面类型（四类排盘门类；未命中的类型词保留在 data-kind，React 侧降级通用盘面板） */
export const PAN_KINDS = ['bazi', 'ziwei', 'natal', 'gua'] as const
export type PanKind = (typeof PAN_KINDS)[number]

/** pan 类型中文徽标（React 侧 PanCard 同构映射） */
export const PAN_KIND_LABEL: Record<PanKind, string> = {
  bazi: '八字',
  ziwei: '紫微',
  natal: '星盘',
  gua: '卦',
}

/** pan 字段 / 条目（data-fields / data-items JSON 形状，React 侧 PanCard 同构解析） */
export interface PanRow {
  label: string
  value: string
}

/** 会议条目状态（data-items JSON 形状，React 侧 MeetingCard / lib/meeting 同构解析） */
export type MeetingItemState = 'todo' | 'doing' | 'done'

/** meeting 条目（M42） */
export interface MeetingItemData {
  label: string
  state: MeetingItemState
}

/** minutes 条目（M42；键 ∈ {决议 / 待办 / 风险}，未识别键归入决议栏） */
export interface MinutesRowData {
  key: string
  value: string
}

/** findings 条目（M43；data-items JSON 形状，React 侧 FindingsCard / lib/pk 同构解析） */
export interface FindingItemData {
  id: number
  text: string
  fix: string
}

/** claim 论据（M43；data-reasons JSON 形状，React 侧 ClaimCard / lib/pk 同构解析） */
export interface ClaimReasonItem {
  text: string
  evidence?: string
}

export const OPTION_STATUS_LABEL: Record<OptionStatus, string> = {
  recommend: '推荐',
  alternate: '备选',
  reject: '否决',
  pending: '待定',
}

const OPEN_RE = /^:::(?!:)\s*([a-zA-Z][\w-]*)\s*(.*)$/
const CLOSE_RE = /^:::\s*$/
const MAX_DEPTH = 8

function box(
  type: string,
  hName: string,
  hProperties: Record<string, unknown>,
  children: MdNode[],
): MdNode {
  return { type, data: { hName, hProperties }, children }
}

function paragraph(value: string): MdNode {
  return { type: 'paragraph', children: [{ type: 'text', value }] }
}

interface Builder {
  type: string
  hName: string
  hProperties: Record<string, unknown>
  children: MdNode[]
}

function makeBuilder(name: string, arg: string): Builder | undefined {
  const base = { children: [] as MdNode[] }
  if (name === 'cols') {
    const m = /^(\d+)?\s*(.*)$/.exec(arg)
    const count = m?.[1] ? Math.min(Math.max(Number(m[1]), 1), 4) : undefined
    const title = (m?.[2] ?? '').trim()
    return {
      type: 'mdCols',
      hName: 'div',
      hProperties: {
        className: ['md-cols'],
        ...(count ? { 'data-cols': String(count) } : {}),
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'col') {
    const title = arg.trim()
    return {
      type: 'mdCol',
      hName: 'div',
      hProperties: { className: ['md-col'], ...(title ? { 'data-title': title } : {}) },
      ...base,
    }
  }
  if (name === 'details') {
    const title = arg.trim() || '详情'
    const summary = box('mdSummary', 'summary', { className: ['md-details-summary'] }, [
      { type: 'text', value: title },
    ])
    return {
      type: 'mdDetails',
      hName: 'details',
      hProperties: { className: ['md-details'] },
      children: [summary],
    }
  }
  if ((CALLOUT_KINDS as readonly string[]).includes(name)) {
    const title = arg.trim()
    return {
      type: 'mdCallout',
      hName: 'div',
      hProperties: {
        className: ['md-callout', `md-callout-${name}`],
        'data-callout': name,
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'kpi') {
    const title = arg.trim()
    return {
      type: 'mdKpi',
      hName: 'div',
      hProperties: {
        className: ['md-kpi'],
        'data-kpi': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'timeline') {
    const title = arg.trim()
    return {
      type: 'mdTimeline',
      hName: 'div',
      hProperties: {
        className: ['md-timeline'],
        'data-timeline': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'mail') {
    const title = arg.trim()
    return {
      type: 'mdMail',
      hName: 'div',
      hProperties: {
        className: ['md-mail'],
        'data-mail': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'option') {
    const m = /^(\S+)\s*(.*)$/.exec(arg.trim())
    const head = m?.[1] ?? ''
    const status = OPTION_STATUS_MAP[head]
    const title = status ? (m?.[2] ?? '').trim() : arg.trim()
    return {
      type: 'mdOption',
      hName: 'div',
      hProperties: {
        className: ['md-option', ...(status ? [`md-option-${status}`] : [])],
        'data-option': '',
        'data-status': status ?? 'none',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'checklist') {
    const title = arg.trim()
    return {
      type: 'mdChecklist',
      hName: 'div',
      hProperties: {
        className: ['md-checklist'],
        'data-checklist': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'choice') {
    const title = arg.trim()
    return {
      type: 'mdChoice',
      hName: 'div',
      hProperties: {
        className: ['md-choice'],
        'data-choice': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'verdict') {
    // M52-E：状态词精确 / 自然语言前缀解析（「空方领先」→ short），口径共用 lib/verdict
    const { status, title } = parseVerdictArg(arg)
    return {
      type: 'mdVerdict',
      hName: 'div',
      hProperties: {
        className: ['md-verdict', ...(status !== 'none' ? [`md-verdict-${status}`] : [])],
        'data-verdict': '',
        'data-status': status,
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'meeting') {
    const title = arg.trim()
    return {
      type: 'mdMeeting',
      hName: 'div',
      hProperties: {
        className: ['md-meeting'],
        'data-meeting': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'minutes') {
    const title = arg.trim()
    return {
      type: 'mdMinutes',
      hName: 'div',
      hProperties: {
        className: ['md-minutes'],
        'data-minutes': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'findings') {
    const title = arg.trim()
    return {
      type: 'mdFindings',
      hName: 'div',
      hProperties: {
        className: ['md-findings'],
        'data-findings': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'claim') {
    const title = arg.trim()
    return {
      type: 'mdClaim',
      hName: 'div',
      hProperties: {
        className: ['md-claim'],
        'data-claim': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'offer') {
    const title = arg.trim()
    return {
      type: 'mdOffer',
      hName: 'div',
      hProperties: {
        className: ['md-offer'],
        'data-offer': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'debate') {
    const title = arg.trim()
    return {
      type: 'mdDebate',
      hName: 'div',
      hProperties: {
        className: ['md-debate'],
        'data-debate': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'pan') {
    const m = /^([a-zA-Z][\w-]*)\s*(.*)$/.exec(arg.trim())
    const head = (m?.[1] ?? '').toLowerCase()
    const title = (m?.[2] ?? arg).trim()
    return {
      type: 'mdPan',
      hName: 'div',
      hProperties: {
        className: ['md-pan', ...(head ? [`md-pan-${head}`] : [])],
        'data-pan': '',
        'data-kind': head || 'generic',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  return undefined
}

/** details 收尾：把 summary 之后的内容包进 body（便于内边距/滚动） */
function finalize(b: Builder): MdNode {
  if (b.type === 'mdDetails') {
    const [summary, ...content] = b.children
    return box('mdDetails', 'details', b.hProperties, [
      summary!,
      box('mdDetailsBody', 'div', { className: ['md-details-body'] }, content),
    ])
  }
  if (b.type === 'mdKpi') {
    const children = convertLists(b.children, 'mdKpiItems', 'md-kpi-items', kpiItemNode)
    return box('mdKpi', 'div', b.hProperties, children)
  }
  if (b.type === 'mdTimeline') {
    const children = convertLists(b.children, 'mdTimelineItems', 'md-timeline-items', timelineItemNode)
    return box('mdTimeline', 'div', b.hProperties, children)
  }
  if (b.type === 'mdMail') return finalizeMail(b)
  if (b.type === 'mdChecklist') return finalizeChecklist(b)
  if (b.type === 'mdChoice') return finalizeChoice(b)
  if (b.type === 'mdVerdict') return finalizeVerdict(b)
  if (b.type === 'mdPan' || b.type === 'mdOffer' || b.type === 'mdDebate') return finalizeFieldsAndItems(b)
  if (b.type === 'mdMeeting') return finalizeMeeting(b)
  if (b.type === 'mdMinutes') return finalizeMinutes(b)
  if (b.type === 'mdFindings') return finalizeFindings(b)
  if (b.type === 'mdClaim') return finalizeClaim(b)
  return box(b.type, b.hName, b.hProperties, b.children)
}

/** 节点树扁平文本（kpi/timeline 条目按 | 拆数据用；不含块级换行） */
function flatText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'code') return node.value ?? ''
  return (node.children ?? []).map(flatText).join('')
}

/** 节点树纯文本（段落/列表项按块换行，供邮件正文复制） */
function plainText(node: MdNode): string {
  if (node.type === 'text' || node.type === 'code') return node.value ?? ''
  const inner = (node.children ?? []).map(plainText).join('')
  if (node.type === 'paragraph' || node.type === 'heading') return `${inner}\n`
  if (node.type === 'listItem') return `- ${inner}`
  return inner
}

/**
 * kpi/timeline 列表 → data-* 结构化条目（仅转换「至少一项含 | 的列表」，其余保持 markdown）。
 * 条目节点不带子节点，展示完全由 React 组件按属性渲染。
 */
function convertLists(
  children: MdNode[],
  type: string,
  className: string,
  makeItem: (raw: string) => MdNode,
): MdNode[] {
  return children.map((c) => {
    if (c.type !== 'list') return c
    const items = (c.children ?? []).filter((it) => it.type === 'listItem')
    if (items.length === 0 || !items.some((it) => flatText(it).includes('|'))) return c
    const nodes = items.map((it) => makeItem(flatText(it).trim()))
    return box(type, 'div', { className: [className] }, nodes)
  })
}

function kpiItemNode(raw: string): MdNode {
  const [name = '', value = '', delta = '', target = ''] = raw.split('|').map((s) => s.trim())
  return box('mdKpiItem', 'div', {
    className: ['md-kpi-item'],
    'data-kpi-item': '',
    'data-name': name,
    'data-value': value,
    'data-delta': delta,
    'data-target': target,
    'data-raw': raw,
  }, [])
}

function timelineItemNode(raw: string): MdNode {
  const [date = '', text = '', owner = ''] = raw.split('|').map((s) => s.trim())
  return box('mdTimelineItem', 'div', {
    className: ['md-timeline-item'],
    'data-timeline-item': '',
    'data-date': date,
    'data-text': text,
    'data-owner': owner,
    'data-raw': raw,
  }, [])
}

const MAIL_FIELD_RE = /^(收件人|抄送|主题)\s*[:：]\s*(.*)$/

/** 头部候选：纯文本或含链接的段落（`收件人: 张总 <a@b.com>` 的邮箱会被解析为 link 节点） */
function isHeaderCandidate(node: MdNode): boolean {
  return node.type === 'paragraph' && (node.children ?? []).every((c) => c.type === 'text' || c.type === 'link')
}

/** mail 收尾：正文前的「收件人:/抄送:/主题:」头部行 → data-* 字段（消费掉头部行） */
function finalizeMail(b: Builder): MdNode {
  const fields: { to?: string; cc?: string; subject?: string } = {}
  const rest: MdNode[] = []
  let scanning = true
  for (const child of b.children) {
    if (scanning && isHeaderCandidate(child)) {
      const lines = flatText(child).split('\n')
      let i = 0
      while (i < lines.length) {
        const m = MAIL_FIELD_RE.exec(lines[i]!.trim())
        if (!m) break
        if (m[1] === '收件人') fields.to = m[2]!.trim()
        else if (m[1] === '抄送') fields.cc = m[2]!.trim()
        else fields.subject = m[2]!.trim()
        i++
      }
      if (i === 0) {
        scanning = false
        rest.push(child)
      } else {
        const remaining = lines.slice(i).join('\n').trim()
        if (remaining) {
          scanning = false
          rest.push(paragraph(remaining))
        }
        // 头部行占满整段 → 继续向后扫描（头部可能跨多段）
      }
      continue
    }
    scanning = false
    rest.push(child)
  }
  const argTitle = typeof b.hProperties['data-title'] === 'string' ? b.hProperties['data-title'] : ''
  const subject = fields.subject || argTitle
  const body = rest.map(plainText).join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return box('mdMail', 'div', {
    ...b.hProperties,
    ...(fields.to ? { 'data-to': fields.to } : {}),
    ...(fields.cc ? { 'data-cc': fields.cc } : {}),
    ...(subject ? { 'data-subject': subject } : {}),
    ...(body ? { 'data-body': body } : {}),
  }, rest)
}

/** 取首个「含条目的列表」并从其余内容中分离（列表被消费为 data-*；非列表内容照常渲染） */
function takeList(children: MdNode[]): { items: MdNode[]; rest: MdNode[] } | undefined {
  const idx = children.findIndex((c) => c.type === 'list' && (c.children ?? []).some((it) => it.type === 'listItem'))
  if (idx < 0) return undefined
  const list = children[idx]!
  return {
    items: (list.children ?? []).filter((it) => it.type === 'listItem'),
    rest: [...children.slice(0, idx), ...children.slice(idx + 1)],
  }
}

/** 任务项前缀回退（GFM 已剥离时 mdast checked 生效；`- [] 项` 等非标写法走文本匹配） */
const CHECK_PREFIX_RE = /^\[([xX ]?)\]\s*/

function checkItem(it: MdNode): ChecklistItem {
  let label = flatText(it).trim()
  const declared = (it as { checked?: boolean | null }).checked
  let checked = declared === true
  const m = CHECK_PREFIX_RE.exec(label)
  if (m) {
    if (declared == null) checked = m[1] === 'x' || m[1] === 'X'
    label = label.slice(m[0].length).trim()
  }
  return { label, checked }
}

/** checklist 收尾：消费列表 → data-items / data-count / data-raw（解析失败时 React 侧用 raw 兜底） */
function finalizeChecklist(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data = taken.items.map(checkItem)
    children = taken.rest
    props['data-items'] = JSON.stringify(data)
    props['data-count'] = String(data.length)
    props['data-raw'] = data.map((it) => `- [${it.checked ? 'x' : ' '}] ${it.label}`).join('\n')
  }
  return box('mdChecklist', 'div', props, children)
}

/** choice 收尾：消费列表 → data-options / data-count / data-raw */
function finalizeChoice(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data: ChoiceOption[] = taken.items.map((it) => ({ label: flatText(it).trim() }))
    children = taken.rest
    props['data-options'] = JSON.stringify(data)
    props['data-count'] = String(data.length)
    props['data-raw'] = data.map((o) => `- ${o.label}`).join('\n')
  }
  return box('mdChoice', 'div', props, children)
}

/** verdict 收尾：消费列表 → data-items（`- 项名 | 内容`，首个 | 前为项名）/ data-count / data-raw */
function finalizeVerdict(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data: VerdictItem[] = taken.items.map((it) => {
      const raw = flatText(it).trim()
      const idx = raw.indexOf('|')
      return idx < 0
        ? { label: raw, value: '' }
        : { label: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() }
    })
    children = taken.rest
    props['data-items'] = JSON.stringify(data)
    props['data-count'] = String(data.length)
    props['data-raw'] = data.map((it) => (it.value ? `- ${it.label} | ${it.value}` : `- ${it.label}`)).join('\n')
  }
  return box('mdVerdict', 'div', props, children)
}

/** 字段行（`键：值`）：键以字母 / 数字 / 汉字开头、1–16 字符、不含冒号 / 竖线（⚠ 等符号行不入字段）；值取首个冒号后余文 */
const PAN_FIELD_RE = /^([\p{L}\p{N}][^：:|]{0,15})[：:]\s*(.+)$/u

/**
 * 字段 + 条目收尾（pan / offer 共用）：列表 → data-items（`- 键 | 值` 首个 | 前为键）；
 * 纯文本段落中的 `键：值` 行 → data-fields；未命中行保留原段落；
 * data-raw 恒等重建（字段先、条目后，供复制与解析失败兜底）。
 */
function finalizeFieldsAndItems(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  const fields: PanRow[] = []
  const items: PanRow[] = []
  const taken = takeList(b.children)
  if (taken) {
    for (const it of taken.items) {
      const raw = flatText(it).trim()
      const idx = raw.indexOf('|')
      items.push(
        idx < 0
          ? { label: raw, value: '' }
          : { label: raw.slice(0, idx).trim(), value: raw.slice(idx + 1).trim() },
      )
    }
  }
  const keep: MdNode[] = []
  for (const child of taken ? taken.rest : b.children) {
    if (!isPureText(child)) {
      keep.push(child)
      continue
    }
    const kept: string[] = []
    for (const line of paragraphText(child).split('\n')) {
      const m = PAN_FIELD_RE.exec(line.trim())
      if (m) fields.push({ label: m[1]!.trim(), value: m[2]! })
      else kept.push(line)
    }
    const text = kept.join('\n').trim()
    if (text) keep.push(paragraph(text))
  }
  if (fields.length > 0) props['data-fields'] = JSON.stringify(fields)
  if (items.length > 0) {
    props['data-items'] = JSON.stringify(items)
    props['data-count'] = String(items.length)
  }
  const raw = [
    ...fields.map((f) => `${f.label}：${f.value}`),
    ...items.map((it) => (it.value ? `- ${it.label} | ${it.value}` : `- ${it.label}`)),
  ].join('\n')
  if (raw) props['data-raw'] = raw
  return box(b.type, 'div', props, keep)
}

// ---------- M42：meeting（会议声明卡）/ minutes（纪要卡） ----------

/** 会议条目状态标记：`[x]` 已决 / `[>]` 进行中 / 空 待议（GFM 已剥离时 mdast checked 生效） */
const MEETING_MARK_RE = /^\[([xX> ]?)\]\s*/

function meetingItemOf(it: MdNode): MeetingItemData {
  const declared = (it as { checked?: boolean | null }).checked
  let label = flatText(it).trim()
  let state: MeetingItemState = declared === true ? 'done' : 'todo'
  const m = MEETING_MARK_RE.exec(label)
  if (m) {
    if (declared == null) {
      const mark = (m[1] ?? '').toLowerCase()
      state = mark === 'x' ? 'done' : mark === '>' ? 'doing' : 'todo'
    }
    label = label.slice(m[0].length).trim()
  }
  return { label, state }
}

/** meeting 收尾：消费列表 → data-items（`- [x] / - [>] / - 项`）/ data-count / data-raw；空列表保持原文 */
function finalizeMeeting(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data = taken.items.map(meetingItemOf).filter((it) => it.label !== '')
    if (data.length > 0) {
      children = taken.rest
      props['data-items'] = JSON.stringify(data)
      props['data-count'] = String(data.length)
      props['data-raw'] = data
        .map((it) => `- [${it.state === 'done' ? 'x' : it.state === 'doing' ? '>' : ' '}] ${it.label}`)
        .join('\n')
    }
  }
  return box('mdMeeting', 'div', props, children)
}

/** minutes 收尾：消费列表 → data-items（`- 键 | 值`，首个 | 前为键）/ data-count / data-raw；空列表保持原文 */
function finalizeMinutes(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data: MinutesRowData[] = []
    for (const it of taken.items) {
      const raw = flatText(it).trim()
      if (raw === '') continue
      const idx = raw.indexOf('|')
      const key = idx < 0 ? '' : raw.slice(0, idx).trim()
      const value = idx < 0 ? raw : raw.slice(idx + 1).trim()
      if (value !== '') data.push({ key, value })
    }
    if (data.length > 0) {
      children = taken.rest
      props['data-items'] = JSON.stringify(data)
      props['data-count'] = String(data.length)
      props['data-raw'] = data.map((r) => (r.key ? `- ${r.key} | ${r.value}` : `- ${r.value}`)).join('\n')
    }
  }
  return box('mdMinutes', 'div', props, children)
}

// ---------- M43：findings（缺陷-修补配对卡）/ claim（主张卡） ----------

/** findings 条目行：`- 缺陷 N | 描述 | 修补方向`（描述 / 修补缺省时修补留空） */
const FINDING_ITEM_RE = /^(?:缺陷|问题)\s*(\d+)\s*[|｜]\s*(.*)$/

function findingItemOf(it: MdNode): FindingItemData | undefined {
  const raw = flatText(it).trim()
  const m = FINDING_ITEM_RE.exec(raw)
  if (!m) return undefined
  const id = Number(m[1])
  const rest = (m[2] ?? '').trim()
  if (!Number.isInteger(id) || rest === '') return undefined
  const idx = rest.search(/[|｜]/)
  const text = idx < 0 ? rest : rest.slice(0, idx).trim()
  const fix = idx < 0 ? '' : rest.slice(idx + 1).trim()
  if (text === '') return undefined
  return { id, text, fix }
}

/** findings 收尾：消费列表 → data-items（`- 缺陷 N | 描述 | 修补方向`）/ data-count / data-raw；空列表保持原文 */
function finalizeFindings(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data: FindingItemData[] = []
    for (const it of taken.items) {
      const f = findingItemOf(it)
      if (f) data.push(f)
    }
    if (data.length > 0) {
      children = taken.rest
      props['data-items'] = JSON.stringify(data)
      props['data-count'] = String(data.length)
      props['data-raw'] = data
        .map((f) => `- 缺陷 ${f.id} | ${f.text}${f.fix ? ` | ${f.fix}` : ''}`)
        .join('\n')
    }
  }
  return box('mdFindings', 'div', props, children)
}

/** claim 细节行：`细节：…` / `说明：…`（取首条；未命中行保留原文） */
const CLAIM_DETAIL_RE = /^(?:细节|说明|detail)\s*[：:]\s*(.+)$/i

/**
 * claim 收尾：列表 → data-reasons（`- 论据 | 证据`，证据缺省省略）/ data-count / data-raw；
 * 纯文本段落中的 `细节：…` 行 → data-detail（消费首条）。
 */
function finalizeClaim(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const reasons: ClaimReasonItem[] = []
    for (const it of taken.items) {
      const raw = flatText(it).trim()
      if (raw === '') continue
      const idx = raw.search(/[|｜]/)
      if (idx < 0) {
        reasons.push({ text: raw })
      } else {
        const text = raw.slice(0, idx).trim()
        const evidence = raw.slice(idx + 1).trim()
        if (text !== '') reasons.push(evidence === '' ? { text } : { text, evidence })
      }
    }
    if (reasons.length > 0) {
      children = taken.rest
      props['data-reasons'] = JSON.stringify(reasons)
      props['data-count'] = String(reasons.length)
      props['data-raw'] = reasons.map((r) => (r.evidence ? `- ${r.text} | ${r.evidence}` : `- ${r.text}`)).join('\n')
    }
  }
  const keep: MdNode[] = []
  for (const child of children) {
    if (!isPureText(child) || props['data-detail'] !== undefined) {
      keep.push(child)
      continue
    }
    const kept: string[] = []
    for (const line of paragraphText(child).split('\n')) {
      const m = props['data-detail'] === undefined ? CLAIM_DETAIL_RE.exec(line.trim()) : null
      if (m && m[1]!.trim() !== '') {
        props['data-detail'] = m[1]!.trim()
        continue
      }
      kept.push(line)
    }
    const text = kept.join('\n').trim()
    if (text) keep.push(paragraph(text))
  }
  return box('mdClaim', 'div', props, keep)
}

function isPureText(node: MdNode): boolean {
  return node.type === 'paragraph' && (node.children ?? []).every((c) => c.type === 'text')
}

/** 沿末子节点链下探定位「最后一个段落」（懒续行闭标记只会并入块末尾） */
function lastParagraph(node: MdNode): MdNode | undefined {
  if (node.type === 'paragraph') return node
  const kids = node.children ?? []
  for (let i = kids.length - 1; i >= 0; i--) {
    const found = lastParagraph(kids[i]!)
    if (found) return found
  }
  return undefined
}

/**
 * 懒续行闭标记剥离：`- 项` 后紧跟的 `:::` 会被 CommonMark 并入列表末项文本，
 * 块级子节点进入开放容器前，从末段落尾部剥离至多 max 个 `:::` 行并返回数量。
 */
function stripTrailingCloses(node: MdNode, max: number): number {
  const kids = lastParagraph(node)?.children ?? []
  const last = kids[kids.length - 1]
  if (!last || last.type !== 'text' || !last.value) return 0
  const lines = last.value.split('\n')
  let count = 0
  while (count < max && lines.length > 1 && /^:::\s*$/.test(lines[lines.length - 1]!)) {
    lines.pop()
    count++
  }
  if (count > 0) last.value = lines.join('\n')
  return count
}

function paragraphText(node: MdNode): string {
  return (node.children ?? []).map((c) => c.value ?? '').join('')
}

/**
 * 自写 remark 插件：兄弟节点级容器解析（hName/hProperties 交给 to-hast）。
 * - 标记段落：整段皆为文本且含 ::: 行 → 逐行驱动栈式状态机；
 * - 块级内容（列表/表格/代码/引用…）：栈非空时收进当前容器，否则原样保留；
 * - 无任何容器标记时不做任何重建（节点身份不变）。
 */
export function remarkContainers(): (tree: unknown) => void {
  const walk = (parent: MdNode): void => {
    if (!parent.children) return
    const out: MdNode[] = []
    const stack: Builder[] = []
    let sawMarker = false
    let buffer: string[] = []

    const target = (): MdNode[] => (stack.length > 0 ? stack[stack.length - 1]!.children : out)
    const flush = (): void => {
      if (buffer.length === 0) return
      const text = buffer.join('\n').trim()
      buffer = []
      if (text) target().push(paragraph(text))
    }
    const close = (): void => {
      const done = stack[stack.length - 1]
      if (!done) return
      flush() // 先把缓冲内容落进当前容器，再收口
      stack.pop()
      sawMarker = true
      const t = stack.length > 0 ? stack[stack.length - 1]!.children : out
      t.push(finalize(done))
    }
    const open = (line: string): boolean => {
      const m = OPEN_RE.exec(line.trim())
      if (!m) return false
      const builder = makeBuilder(m[1]!.toLowerCase(), m[2] ?? '')
      if (!builder || stack.length >= MAX_DEPTH) return false
      flush()
      stack.push(builder)
      sawMarker = true
      return true
    }
    /** 未闭合容器的降级展开：拆掉壳、保住内容 */
    const expand = (done: Builder): MdNode[] => {
      if (done.type === 'mdDetails') return done.children.slice(1)
      if (done.type === 'mdCols') {
        return done.children.flatMap((c) => (c.type === 'mdCol' ? (c.children ?? []) : [c]))
      }
      return done.children
    }

    for (const child of parent.children) {
      if (isPureText(child)) {
        const text = paragraphText(child)
        if (text.includes(':::')) {
          for (const line of text.split('\n')) {
            if (CLOSE_RE.test(line.trim()) && stack.length > 0) {
              close()
              continue
            }
            if (open(line)) continue
            buffer.push(line) // 未知容器名 / 游离闭标记 / 普通文本 → 原文暂存
          }
          continue
        }
      }
      // 块级内容：栈非空收进当前容器（先落缓冲，保序），否则原样保留
      if (stack.length > 0) {
        flush()
        // 懒续行：`- 项` 后的 `:::` 被并入列表末项文本 → 剥离后再按数量收口
        const closes = stripTrailingCloses(child, stack.length)
        target().push(child)
        for (let i = 0; i < closes; i++) close()
      } else {
        flush()
        out.push(child)
      }
      walk(child)
    }
    // 收尾：未闭合容器内容展开回父级（丢掉壳，保住内容）
    while (stack.length > 0) {
      flush()
      const done = stack.pop()!
      const t = stack.length > 0 ? stack[stack.length - 1]!.children : out
      t.push(...expand(done))
    }
    flush()
    if (sawMarker) parent.children = out
  }
  return (tree: unknown) => walk(tree as MdNode)
}

// ---------- 代码块元信息：```lang title="x" {2,5-7} ----------

export interface CodeMeta {
  title?: string
  lines?: number[]
}

/** 解析 meta 字符串：title="..." | title='...' | title=word + {行号,范围} */
export function parseCodeMeta(meta: string | undefined): CodeMeta {
  if (!meta) return {}
  const out: CodeMeta = {}
  const title = /title=(?:"([^"]+)"|'([^']+)'|([^\s{]+))/.exec(meta)
  if (title) out.title = title[1] ?? title[2] ?? title[3]
  const spec = /\{([^}]*)\}/.exec(meta)
  if (spec) {
    const lines: number[] = []
    for (const part of spec[1]!.split(',')) {
      const t = part.trim()
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(t)
      if (range) {
        const lo = Math.max(1, Math.min(Number(range[1]), Number(range[2])))
        const hi = Math.max(Number(range[1]), Number(range[2]))
        for (let i = lo; i <= hi && lines.length < 200; i++) lines.push(i)
      } else if (/^\d+$/.test(t)) {
        lines.push(Number(t))
      }
    }
    if (lines.length > 0) out.lines = [...new Set(lines)].sort((a, b) => a - b)
  }
  return out
}

/** data-lines 属性（"2,5,6"）→ number[] */
export function parseLinesAttr(attr: unknown): number[] | undefined {
  if (typeof attr !== 'string' || !attr) return undefined
  const lines = attr
    .split(',')
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0)
  return lines.length > 0 ? lines : undefined
}

/** 自写 remark 插件：fenced code 的 meta → data-title / data-lines（挂到 <code> 元素） */
export function remarkCodeMeta(): (tree: unknown) => void {
  const walk = (node: MdNode): void => {
    if (!node.children) return
    for (const child of node.children) {
      if (child.type === 'code') {
        const meta = parseCodeMeta((child as { meta?: string }).meta)
        const props: Record<string, unknown> = { ...(child.data?.hProperties ?? {}) }
        if (meta.title) props['data-title'] = meta.title
        if (meta.lines) props['data-lines'] = meta.lines.join(',')
        if (Object.keys(props).length > 0) {
          child.data = { ...(child.data ?? {}), hProperties: props }
        }
      }
      walk(child)
    }
  }
  return (tree: unknown) => walk(tree as MdNode)
}
