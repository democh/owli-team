/**
 * Markdown 容器扩展（自写 remark 插件，零新依赖；mdast 层工作）：
 * - `::: cols` / `::: col [标题]` 分栏（响应式网格，窄屏自动折叠为单列）；
 * - `::: tip|info|note|success|warning|danger [标题]` 提示块（callout）；
 * - `::: details 标题` 折叠块（原生 details/summary，无 JS 状态、缓存安全）；
 * - `::: kpi [标题]` 指标卡组（条目 `- 名称 | 值 | 变化 | 目标 | 口径` → data-* 结构化节点；口径列为 M66 新增可缺省列）；
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
 * - `::: ruling <正方|反方|多方|空方|僵持> [第 N 轮小结]` 轮次判定条（条目 `- 项名 | 内容` → data-items JSON；
 *   状态词口径同 verdict（parseVerdictArg）；过程件——与终局裁决卡分离渲染；M63）；
 * - `::: stance <立场方>` 立场卡（字段行 主张 / 核心关切 / 被忽视视角 → data-fields JSON；
 *   条目 `- 依据 | …` → data-items JSON；M66）；
 * - `::: split [标题]` 共识分歧板（条目 `- 共识|分歧|存疑 | …` → data-items JSON；M66）；
 * - `::: idea [N] 标题` 点子卡（字段行 `键：值` / 条目 `- 键 | 值` → data-fields / data-items；
 *   字段「状态：候选|入选|被毙」→ data-status；M38）；
 * - `::: phase 阶段名` 阶段分隔条（发散 / 探索 → 暖色；收敛 / 评审 / 收口 → 冷色；M38）；
 * - `::: score [标题]` 评分卡（条目 `- 名称 | 影响 8 | 信心 5 | 易度 7` → data-scores JSON；
 *   总分缺省 = 子项乘积（ICE 口径），按总分降序；M38）；
 * - `::: sources [标题]` 来源卡组（条目 `- 标题 | URL | 日期 | 要点 | 高|中|低` → data-sources JSON；
 *   链接支持裸 URL 或 markdown 链接；M38）；
 * - `::: decision [标题]` 决议卡（字段行 `背景：… / 决策：… / 后果：…` → data-fields JSON；M38）；
 * - M69：`::: roll [标题]` 骰卡（字段行 `骰式：… | 种子：…` / `明细：… | 修正：… | 总值：…` → data-fields JSON）；
 * - M69：`::: cards [牌阵名]` 牌阵卡（条目 `- 牌位 | 牌名 | 正逆位 | 关键词` → data-items JSON）；
 * - M69：`::: sim [回合]` 回合结算卡（条目 `- 决策 | … | 反馈 | … | 指标 | …` → data-items JSON）；
 * - `::: postmortem [标题]` 复盘卡（字段行 `分级：… / 时间线：… / 归因：…` → data-fields JSON；
 *   条目 `- 改进项 | 内容 | owner 期限` → data-items JSON；M39）；
 * - `::: pipeline [标题]` 客户管道看板（条目 `- 客户 | 阶段 | 金额 | 下一步` → data-pipeline JSON；
 *   阶段 ∈ {线索|意向|报价|成交}，未识别归「其他」列；M41）；
 * - `::: figures [标题]` 测算表卡（条目 `- 行名 | 值 | 说明` → data-figures JSON；
 *   合计/总计/小计/毛利/净额/净利/EBITDA/税后 命中 → 关键行；M41）；
 * - `::: risk <高|中|低> [标题]` 风险色带（首词命中才着色，未命中中性；M41）；
 * - `::: progress [标题]` 进度卡（条目 `- 章节 | 状态`，状态 ∈ {完成|进行中|待办} → data-progress JSON；M41）；
 * - `::: qa [标题]` 问答卡（条目 `- 问 | 答` → data-qa JSON；M41）；
 * - `::: tracks [标题]` 三轨打卡卡（条目 `- 轨道 | 计划` → data-rows JSON；本地按天打卡与 streak；M40）；
 * - `::: quiz [标题]` 每日一练卡（条目 `- A | 选项文本` → data-rows JSON；点选 + 提交回填；M40）；
 * - `::: mood [标题]` 情绪签到卡（1–5 档点选 + 提交回填；M40）；
 * - `::: goals [标题]` 目标进度环（条目 `- 目标 | 当前 | 目标值` → data-rows JSON；支持「万」后缀；M40）；
 * - `::: ledger [标题]` 记账流水（条目 `- 日期 | 项目 | 金额` → data-rows JSON；金额右对齐；M40）；
 * - `::: itinerary [标题]` 行程卡（条目 `- 日期 | 交通 | 住宿 | 安排` → data-rows JSON；按天分组 + 今天高亮；M40）；
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
import { CLAIM_META_RE, claimMetaOf } from '../../../lib/pk'

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

/** pan 盘面类型（十一类排盘门类；未命中的类型词保留在 data-kind，React 侧降级通用盘面板） */
export const PAN_KINDS = ['bazi', 'ziwei', 'natal', 'gua', 'transit', 'synastry', 'daliuren', 'qizheng', 'qimen', 'luopan', 'zeri'] as const
export type PanKind = (typeof PAN_KINDS)[number]

/** pan 类型中文徽标（React 侧 PanCard 同构映射） */
export const PAN_KIND_LABEL: Record<PanKind, string> = {
  bazi: '八字',
  ziwei: '紫微',
  natal: '星盘',
  gua: '卦',
  transit: '行运',
  synastry: '合盘',
  daliuren: '六壬',
  qizheng: '七政',
  qimen: '奇门',
  luopan: '罗盘',
  zeri: '择日',
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

// ---------- M38：研讨容器族（idea / phase / score / sources / decision） ----------

/** idea 状态词 → 语义键（未命中不进此表 → 无状态徽标） */
export const IDEA_STATUS_MAP: Record<string, 'candidate' | 'chosen' | 'rejected'> = {
  候选: 'candidate',
  入选: 'chosen',
  被毙: 'rejected',
}
export type IdeaStatus = 'candidate' | 'chosen' | 'rejected' | 'none'

export const IDEA_STATUS_LABEL: Record<Exclude<IdeaStatus, 'none'>, string> = {
  candidate: '候选',
  chosen: '入选',
  rejected: '被毙',
}

/** idea 参数解析：`[N] 标题`（编号可选） */
export function parseIdeaArg(arg: string): { no?: string; title: string } {
  const m = /^(\d+)\s*(.*)$/.exec(arg.trim())
  if (m?.[1]) return { no: m[1], title: (m[2] ?? '').trim() }
  return { title: arg.trim() }
}

/** idea 字段行（panRowsOf 同构）中取「状态」字段 → 语义键 */
export function ideaStatusOf(fields: readonly PanRow[]): IdeaStatus {
  for (const f of fields) {
    if (f.label !== '状态') continue
    return IDEA_STATUS_MAP[f.value.trim()] ?? 'none'
  }
  return 'none'
}

/** score 子项 / 合计（data-scores JSON 形状，React 侧 ScoreCard 同构解析） */
export interface ScorePart {
  label: string
  value: number
}

export interface ScoreEntry {
  name: string
  parts: ScorePart[]
  total: number
}

/** score 条目子项：`影响 8` / `信心 8 分` → { label, value } */
const SCORE_PART_RE = /^(.+?)\s*(\d+(?:\.\d+)?)\s*分?$/
/** 显式总分列（不再参与乘积） */
const SCORE_TOTAL_RE = /^(?:总分|合计)$/
/** 列表项前缀（面板侧 lines 为原始容器行，可能带 `- ` 标记；remark 侧已剥离，双重剥离无害） */
const LIST_MARKER_RE = /^[-*+]\s+/

/** 去掉列表前缀（`- 项` → `项`） */
function stripListMarker(line: string): string {
  return line.replace(LIST_MARKER_RE, '')
}

/**
 * score 条目行解析（remark 收尾与场景面板共用单一实现）：
 * `名称 | 影响 8 | 信心 5 | 易度 7`——总分缺省 = 全部子项乘积（ICE 口径，与资产 / 技能同源）；
 * 显式「总分 / 合计」列优先；无有效子项且无总分 → 该行忽略；结果按总分降序。
 */
export function parseScoreLines(lines: readonly string[]): ScoreEntry[] {
  const out: ScoreEntry[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const name = cells[0] ?? ''
    if (name === '') continue
    const parts: ScorePart[] = []
    let total: number | undefined
    for (const cell of cells.slice(1)) {
      const m = SCORE_PART_RE.exec(cell)
      if (!m) continue
      const label = (m[1] ?? '').trim()
      const value = Number(m[2])
      if (!Number.isFinite(value) || label === '') continue
      if (SCORE_TOTAL_RE.test(label)) {
        total = value
        continue
      }
      parts.push({ label, value })
    }
    if (parts.length === 0 && total === undefined) continue
    const sum = total ?? parts.reduce((acc, p) => acc * Math.max(p.value, 0), 1)
    out.push({ name, parts, total: Math.round(sum * 100) / 100 })
  }
  out.sort((a, b) => b.total - a.total)
  return out
}

/** sources 条目（data-sources JSON 形状，React 侧 SourcesCard 同构解析） */
export interface SourceItem {
  title: string
  url: string
  domain: string
  date: string
  note: string
  level: 'high' | 'mid' | 'low' | 'none'
}

const SOURCE_LEVELS: Record<string, SourceItem['level']> = {
  高: 'high',
  中: 'mid',
  低: 'low',
  高可信: 'high',
  中可信: 'mid',
  低可信: 'low',
}
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/
const BARE_URL_RE = /https?:\/\/[^\s|）)]+/
const SOURCE_DATE_RE = /^\d{4}(?:[-/年]\d{1,2}(?:[-/月]\d{1,2}日?)?)?$/

/** 域名提取（去 www；非 URL → 空串） */
export function domainOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/.exec(url.trim())
  return m ? m[1]!.replace(/^www\./, '') : ''
}

/**
 * sources 条目行解析（remark 收尾与场景面板共用单一实现）：
 * `标题 | URL | 日期 | 要点 | 可信度`——URL / 日期 / 可信度列均可缺省（容忍 markdown 链接形态）；
 * 标题为空的行忽略。
 */
export function parseSourceLines(lines: readonly string[]): SourceItem[] {
  const out: SourceItem[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    let title = cells[0] ?? ''
    if (title === '') continue
    let url = ''
    const rest = cells.slice(1).filter((c) => c !== '')
    const titleLink = MD_LINK_RE.exec(title)
    if (titleLink) {
      url = titleLink[2] ?? ''
      if ((titleLink[1] ?? '').trim() !== '') title = titleLink[1]!.trim()
    }
    let level: SourceItem['level'] = 'none'
    const last = rest[rest.length - 1]
    if (last !== undefined && SOURCE_LEVELS[last] !== undefined) {
      level = SOURCE_LEVELS[last]!
      rest.pop()
    }
    if (url === '' && rest.length > 0) {
      const cell = rest[0]!
      const link = MD_LINK_RE.exec(cell)
      const u = link?.[2] ?? BARE_URL_RE.exec(cell)?.[0]
      if (u) {
        url = u
        rest.shift()
      }
    }
    let date = ''
    if (rest.length > 0 && SOURCE_DATE_RE.test(rest[0]!)) date = rest.shift()!
    const note = rest.join(' | ')
    out.push({ title, url, domain: domainOf(url), date, note, level })
  }
  return out
}

// ---------- M41：服务型容器族（pipeline / figures / risk / progress / qa） ----------

/** pipeline 阶段枚举（未知阶段归入「其他」列，fail-safe） */
export const PIPELINE_STAGES = ['线索', '意向', '报价', '成交'] as const
export type PipelineStage = (typeof PIPELINE_STAGES)[number] | 'other'

export interface PipelineCardData {
  name: string
  stage: PipelineStage
  /** 金额（可空串；展示层置灰） */
  amount: string
  /** 下一步动作（可空串） */
  next: string
}

/**
 * pipeline 条目行解析（remark 收尾与测试共用）：`- 客户 | 阶段 | 金额 | 下一步`
 * （阶段 / 金额 / 下一步列可缺省；客户名为空的行忽略）。
 */
export function parsePipelineItems(lines: readonly string[]): PipelineCardData[] {
  const out: PipelineCardData[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const name = cells[0] ?? ''
    if (name === '') continue
    const stageWord = cells[1] ?? ''
    const stage = (PIPELINE_STAGES as readonly string[]).includes(stageWord) ? (stageWord as PipelineStage) : 'other'
    out.push({ name, stage, amount: cells[2] ?? '', next: cells[3] ?? '' })
  }
  return out
}

/** figures 关键行判定（合计 / 总计 / 小计 / 毛利 / 净额 / 净利 / EBITDA / 税后） */
const FIGURE_KEY_RE = /(合计|总计|小计|毛利|净额|净利|EBITDA|税后)/

export interface FigureRow {
  label: string
  value: string
  note: string
  /** 关键行（加粗 + 淡底） */
  key: boolean
}

/** figures 条目行解析：`- 行名 | 值 | 说明`（说明可缺省；行名为空忽略） */
export function parseFigureRows(lines: readonly string[]): FigureRow[] {
  const out: FigureRow[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const label = cells[0] ?? ''
    if (label === '') continue
    out.push({ label, value: cells[1] ?? '', note: cells[2] ?? '', key: FIGURE_KEY_RE.test(label) })
  }
  return out
}

/** risk 等级词 → 语义键（未命中 → none，中性色带） */
export const RISK_LEVELS: Record<string, 'high' | 'mid' | 'low'> = { 高: 'high', 中: 'mid', 低: 'low' }
export type RiskLevel = 'high' | 'mid' | 'low' | 'none'

/** risk 参数解析：`高|中|低 [标题]`（首词命中才着色，否则整串为标题） */
export function parseRiskArg(arg: string): { level: RiskLevel; title: string } {
  const m = /^(\S+)\s*(.*)$/.exec(arg.trim())
  const head = m?.[1] ?? ''
  const level = RISK_LEVELS[head]
  if (level) return { level, title: (m?.[2] ?? '').trim() }
  return { level: 'none', title: arg.trim() }
}

/** progress 状态词 → 语义键（未识别 → todo） */
export const PROGRESS_STATES: Record<string, 'done' | 'doing' | 'todo'> = { 完成: 'done', 进行中: 'doing', 待办: 'todo' }

export interface ProgressItem {
  label: string
  state: 'done' | 'doing' | 'todo'
}

/** progress 条目行解析：`- 章节 | 状态`（状态未识别 / 缺省 → todo） */
export function parseProgressItems(lines: readonly string[]): ProgressItem[] {
  const out: ProgressItem[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const label = cells[0] ?? ''
    if (label === '') continue
    out.push({ label, state: PROGRESS_STATES[cells[1] ?? ''] ?? 'todo' })
  }
  return out
}

export interface QaPair {
  q: string
  a: string
}

/** qa 条目行解析：`- 问 | 答`（答可缺省；问为空忽略） */
export function parseQaPairs(lines: readonly string[]): QaPair[] {
  const out: QaPair[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const q = cells[0] ?? ''
    if (q === '') continue
    out.push({ q, a: cells.slice(1).join(' | ') })
  }
  return out
}

// ---------- M40：陪跑容器族（tracks / quiz / mood / goals / ledger / itinerary） ----------

export interface TrackRow {
  track: string
  plan: string
}

/** tracks 条目行解析：`- 轨道 | 计划摘要`（计划可缺省） */
export function parseTrackLines(lines: readonly string[]): TrackRow[] {
  const out: TrackRow[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const track = cells[0] ?? ''
    if (track === '') continue
    out.push({ track, plan: cells[1] ?? '' })
  }
  return out
}

export interface QuizOption {
  key: string
  text: string
}

/** quiz 条目行解析：`- A | 选项文本`（首列作为选项键；文本可缺省） */
export function parseQuizLines(lines: readonly string[]): QuizOption[] {
  const out: QuizOption[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const key = cells[0] ?? ''
    if (key === '') continue
    out.push({ key, text: cells.slice(1).join(' | ') })
  }
  return out
}

/** 数值解析：去 ¥ / 千分位；支持「万」后缀（`1.2万` → 12000）；非法 → undefined */
export function numberWithSuffix(raw: string): number | undefined {
  const s = raw.trim().replace(/[¥￥,\s]/g, '')
  const wan = /^(-?\d+(?:\.\d+)?)万$/.exec(s)
  if (wan) {
    const n = Number(wan[1])
    return Number.isFinite(n) ? n * 10000 : undefined
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(s)) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

export interface GoalRow {
  name: string
  current: string
  target: string
  /** 数值解析结果（缺任一 → undefined，展示层不走环） */
  currentNum?: number
  targetNum?: number
}

/** goals 条目行解析：`- 目标 | 当前 | 目标值` */
export function parseGoalLines(lines: readonly string[]): GoalRow[] {
  const out: GoalRow[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const name = cells[0] ?? ''
    if (name === '') continue
    const current = cells[1] ?? ''
    const target = cells[2] ?? ''
    const currentNum = current === '' ? undefined : numberWithSuffix(current)
    const targetNum = target === '' ? undefined : numberWithSuffix(target)
    out.push({
      name,
      current,
      target,
      ...(currentNum !== undefined ? { currentNum } : {}),
      ...(targetNum !== undefined ? { targetNum } : {}),
    })
  }
  return out
}

export interface LedgerRow {
  date: string
  item: string
  amount: string
  /** 金额数值（用于负数着色；非法 → undefined 不猜） */
  amountNum?: number
}

/** ledger 条目行解析：`- 日期 | 项目 | 金额` */
export function parseLedgerLines(lines: readonly string[]): LedgerRow[] {
  const out: LedgerRow[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const date = cells[0] ?? ''
    if (date === '') continue
    const item = cells[1] ?? ''
    const amount = cells[2] ?? ''
    const amountNum = amount === '' ? undefined : numberWithSuffix(amount)
    out.push({ date, item, amount, ...(amountNum !== undefined ? { amountNum } : {}) })
  }
  return out
}

export interface ItineraryRow {
  date: string
  transport: string
  stay: string
  plan: string
}

/** itinerary 条目行解析：`- 日期 | 交通 | 住宿 | 安排`（列可缺省） */
export function parseItineraryLines(lines: readonly string[]): ItineraryRow[] {
  const out: ItineraryRow[] = []
  for (const raw of lines) {
    const line = stripListMarker(raw.trim()).trim()
    if (line === '') continue
    const cells = line.split(/[|｜]/).map((s) => s.trim())
    const date = cells[0] ?? ''
    if (date === '') continue
    out.push({ date, transport: cells[1] ?? '', stay: cells[2] ?? '', plan: cells[3] ?? '' })
  }
  return out
}

/**
 * claim 条目行解析（单一解析：finalizeClaim 与 panel 路径共用——ADR 0144 红线）：
 * `- 主张 | 依据`；无 `|` → 纯文本项；空主张跳过；空依据只留文本；
 * 列表标记双重剥离无害（remark 路径已由 flatText 剥离；panel 路径传原始行）；
 * 细节 / 元信息行（细节：/说明：/视角：等）非条目——跳过（与卡上消费口径一致）。
 */
export function parseClaimLines(lines: readonly string[]): ClaimReasonItem[] {
  const out: ClaimReasonItem[] = []
  for (const raw0 of lines) {
    const raw = stripListMarker(raw0.trim()).trim()
    if (raw === '') continue
    if (CLAIM_DETAIL_RE.test(raw) || CLAIM_META_RE.test(raw)) continue
    const idx = raw.search(/[|｜]/)
    if (idx < 0) {
      out.push({ text: raw })
    } else {
      const text = raw.slice(0, idx).trim()
      const evidence = raw.slice(idx + 1).trim()
      if (text !== '') out.push(evidence === '' ? { text } : { text, evidence })
    }
  }
  return out
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
  if (name === 'ruling') {
    // M63：轮次判定（过程件）——状态词词表复用 verdict（parseVerdictArg 单一实现）；
    // data-head 保留原始胜方词（正方 / 多方…，渲染徽标按场景语汇原文展示）
    const { status, title } = parseVerdictArg(arg)
    const head = /^(\S+)/.exec(arg.trim())?.[1] ?? ''
    return {
      type: 'mdRuling',
      hName: 'div',
      hProperties: {
        className: ['md-ruling', ...(status !== 'none' ? [`md-ruling-${status}`] : [])],
        'data-ruling': '',
        'data-status': status,
        ...(status !== 'none' && head !== '' ? { 'data-head': head } : {}),
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'stance') {
    // M66（N4）：立场卡（society）——字段行 主张 / 核心关切 / 被忽视视角 + 条目 `- 依据 | …`
    const title = arg.trim()
    return {
      type: 'mdStance',
      hName: 'div',
      hProperties: {
        className: ['md-stance'],
        'data-stance-card': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'split') {
    // M66（N4）：共识分歧板（society）——条目 `- 共识 | …` / `- 分歧 | …` / `- 存疑 | …`
    const title = arg.trim()
    return {
      type: 'mdSplit',
      hName: 'div',
      hProperties: {
        className: ['md-split'],
        'data-split': '',
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
  if (name === 'idea') {
    const { no, title } = parseIdeaArg(arg)
    return {
      type: 'mdIdea',
      hName: 'div',
      hProperties: {
        className: ['md-idea'],
        'data-idea': '',
        ...(no ? { 'data-no': no } : {}),
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'phase') {
    const title = arg.trim()
    const tone = /发散|探索|diverge/i.test(title) ? 'warm' : /收敛|评审|收口|converge/i.test(title) ? 'cool' : ''
    return {
      type: 'mdPhase',
      hName: 'div',
      hProperties: {
        className: ['md-phase', ...(tone ? [`md-phase-${tone}`] : [])],
        'data-phase': '',
        ...(tone ? { 'data-tone': tone } : {}),
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'score') {
    const title = arg.trim()
    return {
      type: 'mdScore',
      hName: 'div',
      hProperties: {
        className: ['md-score'],
        'data-score': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'sources') {
    const title = arg.trim()
    return {
      type: 'mdSources',
      hName: 'div',
      hProperties: {
        className: ['md-sources'],
        'data-sources': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'decision') {
    const title = arg.trim()
    return {
      type: 'mdDecision',
      hName: 'div',
      hProperties: {
        className: ['md-decision'],
        'data-decision': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'postmortem') {
    const title = arg.trim()
    return {
      type: 'mdPostmortem',
      hName: 'div',
      hProperties: {
        className: ['md-postmortem'],
        'data-postmortem': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'pipeline') {
    const title = arg.trim()
    return {
      type: 'mdPipeline',
      hName: 'div',
      hProperties: {
        className: ['md-pipeline'],
        'data-pipeline': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'figures') {
    const title = arg.trim()
    return {
      type: 'mdFigures',
      hName: 'div',
      hProperties: {
        className: ['md-figures'],
        'data-figures': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'risk') {
    const { level, title } = parseRiskArg(arg)
    return {
      type: 'mdRisk',
      hName: 'div',
      hProperties: {
        className: ['md-risk', ...(level !== 'none' ? [`md-risk-${level}`] : [])],
        'data-risk': level,
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'progress') {
    const title = arg.trim()
    return {
      type: 'mdProgress',
      hName: 'div',
      hProperties: {
        className: ['md-progress'],
        'data-progress': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'qa') {
    const title = arg.trim()
    return {
      type: 'mdQa',
      hName: 'div',
      hProperties: {
        className: ['md-qa'],
        'data-qa': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'tracks') {
    const title = arg.trim()
    return {
      type: 'mdTracks',
      hName: 'div',
      hProperties: {
        className: ['md-tracks'],
        'data-tracks': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'quiz') {
    const title = arg.trim()
    return {
      type: 'mdQuiz',
      hName: 'div',
      hProperties: {
        className: ['md-quiz'],
        'data-quiz': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'mood') {
    const title = arg.trim()
    return {
      type: 'mdMood',
      hName: 'div',
      hProperties: {
        className: ['md-mood'],
        'data-mood': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'goals') {
    const title = arg.trim()
    return {
      type: 'mdGoals',
      hName: 'div',
      hProperties: {
        className: ['md-goals'],
        'data-goals': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'ledger') {
    const title = arg.trim()
    return {
      type: 'mdLedger',
      hName: 'div',
      hProperties: {
        className: ['md-ledger'],
        'data-ledger': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'itinerary') {
    const title = arg.trim()
    return {
      type: 'mdItinerary',
      hName: 'div',
      hProperties: {
        className: ['md-itinerary'],
        'data-itinerary': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'roll') {
    const title = arg.trim()
    return {
      type: 'mdRoll',
      hName: 'div',
      hProperties: {
        className: ['md-roll'],
        'data-roll': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'cards') {
    const title = arg.trim()
    return {
      type: 'mdCards',
      hName: 'div',
      hProperties: {
        className: ['md-cards'],
        'data-cards': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'sim') {
    const title = arg.trim()
    return {
      type: 'mdSim',
      hName: 'div',
      hProperties: {
        className: ['md-sim'],
        'data-sim': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'layout') {
    const title = arg.trim()
    return {
      type: 'mdLayout',
      hName: 'div',
      hProperties: {
        className: ['md-layout'],
        'data-layout': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'styleboard') {
    const title = arg.trim()
    return {
      type: 'mdStyleboard',
      hName: 'div',
      hProperties: {
        className: ['md-styleboard'],
        'data-styleboard': '',
        ...(title ? { 'data-title': title } : {}),
      },
      ...base,
    }
  }
  if (name === 'render') {
    const title = arg.trim()
    return {
      type: 'mdRender',
      hName: 'div',
      hProperties: {
        className: ['md-render'],
        'data-render': '',
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
  if (b.type === 'mdVerdict' || b.type === 'mdRuling' || b.type === 'mdSplit') return finalizeItemRows(b)
  if (b.type === 'mdPan' || b.type === 'mdOffer' || b.type === 'mdDebate') return finalizeFieldsAndItems(b)
  if (b.type === 'mdMeeting') return finalizeMeeting(b)
  if (b.type === 'mdMinutes') return finalizeMinutes(b)
  if (b.type === 'mdFindings') return finalizeFindings(b)
  if (b.type === 'mdClaim') return finalizeClaim(b)
  if (b.type === 'mdIdea') return finalizeIdea(b)
  if (b.type === 'mdDecision' || b.type === 'mdStance') return finalizeFieldsAndItems(b)
  if (b.type === 'mdPostmortem') return finalizeFieldsAndItems(b)
  if (b.type === 'mdPipeline') return finalizePipeline(b)
  if (b.type === 'mdFigures') return finalizeFigures(b)
  if (b.type === 'mdProgress') return finalizeProgress(b)
  if (b.type === 'mdQa') return finalizeQa(b)
  if (b.type === 'mdTracks') return finalizeRowSet(b, parseTrackLines, (r) => `- ${r.track}${r.plan ? ` | ${r.plan}` : ''}`)
  if (b.type === 'mdQuiz') return finalizeRowSet(b, parseQuizLines, (r) => `- ${r.key}${r.text ? ` | ${r.text}` : ''}`)
  if (b.type === 'mdGoals')
    return finalizeRowSet(b, parseGoalLines, (r) => `- ${r.name}${r.current ? ` | ${r.current}` : ''}${r.target ? ` | ${r.target}` : ''}`)
  if (b.type === 'mdLedger')
    return finalizeRowSet(b, parseLedgerLines, (r) => `- ${r.date}${r.item ? ` | ${r.item}` : ''}${r.amount ? ` | ${r.amount}` : ''}`)
  if (b.type === 'mdItinerary')
    return finalizeRowSet(
      b,
      parseItineraryLines,
      (r) => `- ${r.date}${r.transport ? ` | ${r.transport}` : ''}${r.stay ? ` | ${r.stay}` : ''}${r.plan ? ` | ${r.plan}` : ''}`,
    )
  if (b.type === 'mdRoll') return finalizeFieldsAndItems(b)
  if (b.type === 'mdCards') return finalizeFieldsAndItems(b)
  if (b.type === 'mdSim') return finalizeFieldsAndItems(b)
  if (b.type === 'mdLayout') return finalizeLayout(b)
  if (b.type === 'mdStyleboard') return finalizeStyleboard(b)
  if (b.type === 'mdRender') return finalizeItemRows(b)
  if (b.type === 'mdScore') return finalizeScore(b)
  if (b.type === 'mdSources') return finalizeSources(b)
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
  const row = kpiRowOf(raw)
  return box('mdKpiItem', 'div', {
    className: ['md-kpi-item'],
    'data-kpi-item': '',
    'data-name': row.name,
    'data-value': row.value,
    'data-delta': row.delta,
    'data-target': row.target,
    ...(row.scope !== '' ? { 'data-scope': row.scope } : {}),
    'data-raw': raw,
  }, [])
}

function timelineItemNode(raw: string): MdNode {
  const row = timelineRowOf(raw)
  return box('mdTimelineItem', 'div', {
    className: ['md-timeline-item'],
    'data-timeline-item': '',
    'data-date': row.date,
    'data-text': row.text,
    'data-owner': row.owner,
    'data-raw': raw,
  }, [])
}

/** kpi 条目（data-* 形状；面板经 kpiRowOf 单一解析复用） */
export interface KpiRow {
  name: string
  value: string
  delta: string
  target: string
  /** M66（N2）：口径列（第 5 列；缺省空串） */
  scope: string
}

/**
 * kpi 条目行解析（remark 收尾与场景面板共用单一实现）：
 * `名称 | 值 | 变化 | 目标 | 口径`——后两列均可缺省（兼容四列历史写法）。
 */
export function kpiRowOf(raw: string): KpiRow {
  const line = stripListMarker(raw.trim()).trim()
  const [name = '', value = '', delta = '', target = '', scope = ''] = line.split('|').map((s) => s.trim())
  return { name, value, delta, target, scope }
}

/** timeline 条目（data-* 形状；面板经 timelineRowOf 单一解析复用） */
export interface TimelineRow {
  date: string
  text: string
  /** 第三列（通用场景为负责人；sre 场景语义为等级——由场景层自行解释，M66 N3） */
  owner: string
}

/** timeline 条目行解析（remark 收尾与场景面板共用单一实现）：`日期 | 事项 | 负责人` */
export function timelineRowOf(raw: string): TimelineRow {
  const line = stripListMarker(raw.trim()).trim()
  const [date = '', text = '', owner = ''] = line.split('|').map((s) => s.trim())
  return { date, text, owner }
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

/**
 * 键值条目收尾（verdict / ruling / split 共用；M66 合并去重）：
 * 消费列表 → data-items（`- 项名 | 内容`，首个 | 前为项名）/ data-count / data-raw。
 */
function finalizeItemRows(b: Builder): MdNode {
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
  return box(b.type, 'div', props, children)
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
  // lazy continuation 救援（M63-F 实测）：列表末条后紧邻的非列表段落行（如「口径：…」）
  // 会被 mdast 并入末条 item（CommonMark lazy continuation）——拆回独立段落渲染，
  // 避免末条 value 带尾段致 derive 锚尾不匹配而丢条目（条目值按「单行」冻结契约）。
  const rescued: string[] = []
  if (taken) {
    for (const it of taken.items) {
      let raw = flatText(it)
      const nl = raw.indexOf('\n')
      if (nl >= 0) {
        rescued.push(...raw.slice(nl + 1).split('\n'))
        raw = raw.slice(0, nl)
      }
      const t = raw.trim()
      const idx = t.indexOf('|')
      items.push(
        idx < 0
          ? { label: t, value: '' }
          : { label: t.slice(0, idx).trim(), value: t.slice(idx + 1).trim() },
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
  const rescuedText = (() => {
    const rest: string[] = []
    for (const line of rescued) {
      // 尾段中的字段行（如六壬「天将：/ 课体：/ 口径：」）回收进 fields（卡头字段区）
      const m = PAN_FIELD_RE.exec(line.trim())
      if (m) fields.push({ label: m[1]!.trim(), value: m[2]! })
      else rest.push(line)
    }
    return rest.join('\n').trim()
  })()
  if (rescuedText) keep.push(paragraph(rescuedText))
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

// ---------- M65-C：设计容器族（layout / styleboard / render） ----------

/** layout 房间条目（data-items JSON 形状：`- 房间 | 面积 | 要点`；M65-C） */
export interface LayoutRowData {
  room: string
  area: string
  note: string
}

/** layout 方案源行（`方案源：design/x.scene.json`；宽松提取——非法行保留原文） */
const LAYOUT_SOURCE_RE = /方案源[：:]\s*(\S+\.scene\.json)/

/** layout 收尾：条目→data-items（三段）/「方案源：」行→data-source / data-raw 重建（供复制与解析失败兜底） */
function finalizeLayout(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  const items: LayoutRowData[] = []
  const taken = takeList(b.children)
  if (taken) {
    for (const it of taken.items) {
      const raw = flatText(it).trim()
      if (raw === '') continue
      const seg = raw.split('|').map((s) => s.trim())
      items.push({ room: seg[0] ?? '', area: seg[1] ?? '', note: seg.slice(2).join(' | ') })
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
      const m = LAYOUT_SOURCE_RE.exec(line.trim())
      if (m) props['data-source'] = m[1]
      else kept.push(line)
    }
    const text = kept.join('\n').trim()
    if (text) keep.push(paragraph(text))
  }
  // 兼容无空行写法：标记行可能被 CommonMark 懒续行并入列表末项——从条目字段中剥离
  for (const it of items) {
    const m = LAYOUT_SOURCE_RE.exec(it.note)
    if (m) {
      props['data-source'] = m[1]
      it.note = it.note.slice(0, m.index).trim()
    }
  }
  if (items.length > 0) {
    props['data-items'] = JSON.stringify(items)
    props['data-count'] = String(items.length)
  }
  const raw = [
    ...items.map((it) => `- ${it.room} | ${it.area}${it.note ? ` | ${it.note}` : ''}`),
    ...(typeof props['data-source'] === 'string' ? [`方案源：${props['data-source']}`] : []),
  ].join('\n')
  if (raw) props['data-raw'] = raw
  return box('mdLayout', 'div', props, keep)
}

/** styleboard 色卡条目（`- 名称 | #hex | 用途`） */
export interface SwatchData {
  name: string
  hex: string
  usage: string
}

/** 色值宽松校验（#rgb / #rrggbb；非法保留原文，渲染层降级文本行） */
const HEX_RE = /^#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?$/
export function isHexColor(v: string): boolean {
  return HEX_RE.test(v)
}

/** 质感行（`质感：哑光木纹 · 低饱和 · 留白`） */
const STYLEBOARD_TEXTURE_RE = /^质感[：:]\s*(.+)$/

/** styleboard 收尾：条目→data-items（名称/色值/用途）/「质感：」行→data-texture / data-raw 重建 */
function finalizeStyleboard(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  const items: SwatchData[] = []
  const taken = takeList(b.children)
  if (taken) {
    for (const it of taken.items) {
      const raw = flatText(it).trim()
      if (raw === '') continue
      const seg = raw.split('|').map((s) => s.trim())
      items.push({ name: seg[0] ?? '', hex: seg[1] ?? '', usage: seg.slice(2).join(' | ') })
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
      const m = STYLEBOARD_TEXTURE_RE.exec(line.trim())
      if (m) props['data-texture'] = m[1]!.trim()
      else kept.push(line)
    }
    const text = kept.join('\n').trim()
    if (text) keep.push(paragraph(text))
  }
  // 兼容无空行写法：标记行可能被 CommonMark 懒续行并入列表末项——从条目字段中剥离
  for (const it of items) {
    for (const key of ['usage', 'hex'] as const) {
      const m = STYLEBOARD_TEXTURE_RE.exec(it[key])
      if (m) {
        props['data-texture'] = m[1]!.trim()
        it[key] = it[key].slice(0, m.index).trim()
        break
      }
    }
  }
  if (items.length > 0) {
    props['data-items'] = JSON.stringify(items)
    props['data-count'] = String(items.length)
  }
  const raw = [
    ...items.map((it) => `- ${it.name} | ${it.hex}${it.usage ? ` | ${it.usage}` : ''}`),
    ...(typeof props['data-texture'] === 'string' ? [`质感：${props['data-texture']}`] : []),
  ].join('\n')
  if (raw) props['data-raw'] = raw
  return box('mdStyleboard', 'div', props, keep)
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
    const reasons = parseClaimLines(taken.items.map((it) => flatText(it)))
    if (reasons.length > 0) {
      children = taken.rest
      props['data-reasons'] = JSON.stringify(reasons)
      props['data-count'] = String(reasons.length)
      props['data-raw'] = reasons.map((r) => (r.evidence ? `- ${r.text} | ${r.evidence}` : `- ${r.text}`)).join('\n')
    }
  }
  const keep: MdNode[] = []
  const scanned: string[] = []
  for (const child of children) {
    if (!isPureText(child)) {
      keep.push(child)
      continue
    }
    const kept: string[] = []
    for (const line of paragraphText(child).split('\n')) {
      const trimmed = line.trim()
      scanned.push(trimmed)
      const dm = props['data-detail'] === undefined ? CLAIM_DETAIL_RE.exec(trimmed) : null
      if (dm && dm[1]!.trim() !== '') {
        props['data-detail'] = dm[1]!.trim()
        continue
      }
      // M63：扩展字段行（视角 / 倾向 / 置信度）消费不渲染（claimMetaOf 统一提取）
      if (CLAIM_META_RE.test(trimmed)) continue
      kept.push(line)
    }
    const text = kept.join('\n').trim()
    if (text) keep.push(paragraph(text))
  }
  const meta = claimMetaOf(scanned)
  if (meta.perspective !== undefined) props['data-perspective'] = meta.perspective
  if (meta.stance !== undefined) props['data-stance'] = meta.stance
  if (meta.confidence !== undefined) props['data-confidence'] = meta.confidence
  return box('mdClaim', 'div', props, keep)
}

// ---------- M38：idea / score / sources（收敛容器族收尾） ----------

/** 节点树扁平文本（保留链接 url：`[文本](url)`；sources 条目解析用） */
function flatWithLinks(node: MdNode): string {
  if (node.type === 'link') {
    const url = (node as { url?: string }).url ?? ''
    const text = (node.children ?? []).map(flatWithLinks).join('')
    return url ? `[${text}](${url})` : text
  }
  if (node.type === 'text' || node.type === 'code') return node.value ?? ''
  return (node.children ?? []).map(flatWithLinks).join('')
}

/** idea 收尾：字段 / 条目结构化（同 pan 口径）+ 「状态」字段 → data-status */
function finalizeIdea(b: Builder): MdNode {
  const node = finalizeFieldsAndItems(b)
  const props = (node.data?.hProperties ?? {}) as Record<string, unknown>
  const fieldsJson = typeof props['data-fields'] === 'string' ? props['data-fields'] : ''
  let status: IdeaStatus = 'none'
  if (fieldsJson !== '') {
    try {
      status = ideaStatusOf(JSON.parse(fieldsJson) as PanRow[])
    } catch {
      status = 'none'
    }
  }
  if (status !== 'none') props['data-status'] = status
  return node
}

/** score 收尾：消费列表 → data-scores（parseScoreLines 单一实现）/ data-count / data-raw */
function finalizeScore(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const entries = parseScoreLines(taken.items.map((it) => flatText(it).trim()))
    if (entries.length > 0) {
      children = taken.rest
      props['data-scores'] = JSON.stringify(entries)
      props['data-count'] = String(entries.length)
      props['data-raw'] = entries
        .map((e) => `- ${[e.name, ...e.parts.map((p) => `${p.label} ${p.value}`), `总分 ${e.total}`].join(' | ')}`)
        .join('\n')
    }
  }
  return box('mdScore', 'div', props, children)
}

/** 来源等级语义键 → 中文词（data-raw 重建用） */
const SOURCE_LEVEL_TEXT: Record<Exclude<SourceItem['level'], 'none'>, string> = {
  high: '高',
  mid: '中',
  low: '低',
}

/** sources 收尾：消费列表 → data-sources（parseSourceLines 单一实现）/ data-count / data-raw */
function finalizeSources(b: Builder): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const items = parseSourceLines(taken.items.map((it) => flatWithLinks(it).trim()))
    if (items.length > 0) {
      children = taken.rest
      props['data-sources'] = JSON.stringify(items)
      props['data-count'] = String(items.length)
      props['data-raw'] = items
        .map((s) =>
          `- ${[s.title, s.url, s.date, s.note, s.level === 'none' ? '' : SOURCE_LEVEL_TEXT[s.level]].filter((v) => v !== '').join(' | ')}`,
        )
        .join('\n')
    }
  }
  return box('mdSources', 'div', props, children)
}

// ---------- M41：pipeline / figures / progress / qa 收尾 ----------

/** 通用「列表 → JSON 行集」收尾（count + raw 重建共用；empty → 保持原文） */
function finalizeRowSet<T>(
  b: Builder,
  parse: (lines: string[]) => T[],
  rawOf: (row: T) => string,
): MdNode {
  const props: Record<string, unknown> = { ...b.hProperties }
  let children = b.children
  const taken = takeList(b.children)
  if (taken) {
    const data = parse(taken.items.map((it) => flatText(it).trim()))
    if (data.length > 0) {
      children = taken.rest
      props['data-rows'] = JSON.stringify(data)
      props['data-count'] = String(data.length)
      props['data-raw'] = data.map(rawOf).join('\n')
    }
  }
  return box(b.type, 'div', props, children)
}

/** pipeline 收尾：列表 → data-rows（含阶段归一）+ count + raw */
function finalizePipeline(b: Builder): MdNode {
  return finalizeRowSet(
    b,
    parsePipelineItems,
    (r) =>
      `- ${r.name} | ${r.stage === 'other' ? '' : r.stage}${r.amount ? ` | ${r.amount}` : ''}${r.next ? ` | ${r.next}` : ''}`,
  )
}

/** figures 收尾：列表 → data-rows + count + raw */
function finalizeFigures(b: Builder): MdNode {
  return finalizeRowSet(
    b,
    parseFigureRows,
    (r) => `- ${r.label} | ${r.value}${r.note ? ` | ${r.note}` : ''}`,
  )
}

/** progress 收尾：列表 → data-rows + count + raw */
function finalizeProgress(b: Builder): MdNode {
  const stateWord: Record<'done' | 'doing' | 'todo', string> = { done: '完成', doing: '进行中', todo: '待办' }
  return finalizeRowSet(b, parseProgressItems, (r) => `- ${r.label} | ${stateWord[r.state]}`)
}

/** qa 收尾：列表 → data-rows + count + raw */
function finalizeQa(b: Builder): MdNode {
  return finalizeRowSet(b, parseQaPairs, (r) => `- ${r.q}${r.a ? ` | ${r.a}` : ''}`)
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
