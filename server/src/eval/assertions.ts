/**
 * 评测断言执行器（M9）：eval 任务的断言 JSON → 结构化判定结果。
 *
 * 断言类型：
 * - artifact_exists    交付件存在（workspace 相对路径）
 * - artifact_contains  交付件内容包含指定文本
 * - min_chars          交付件非空白字符数 ≥ 阈值（报告规模下限；去空白后计数）
 * - min_sections       交付件二级章节（## ）数 ≥ 阈值（报告结构完整性）
 * - min_sources        交付件来源标记数 ≥ 阈值（URL / 「来源：」/ 编号引用（含 S-01 与裸编号）合计）
 * - run_end_reason     Run 結束原因（run_events run:end.payload.reason）
 * - turns_lte          完成回合数 ≤ 阈值（run_events turn:end 计数）
 * - handoff_targets    接力目标全部出现在 Agent 消息 mentions 并集中
 * - agent_spoke        指定成员在本 Run 产出过 Agent 消息（M46：调度官发言）
 * - invited_members    本 Run routing:dispatched 轨迹的召集名单覆盖断言值（M48：平台自动组队）
 * - no_invite          本 Run routing:dispatched 轨迹不含召集条目（M50：单助手直通——无平台召集 / handoff 增援）
 * - no_loop            未触发循环抑制（schedule.loopSuppressed 全为 false）
 * - no_stall           未触发停滞抑制（schedule.stallSuppressed 全为 false，M61 D3 回归守卫）
 * - scheduling         调度聚合下限（M61：routes / handoffAccepted / waves / parallelWaves 下限，stall / 写冲突上限）
 * - token_budget_ok    最近一次上下文估算在预算内
 * - memory_recall      语义召回（L1.5）注入条目数（memory:recall 轨迹事件）
 * - judge              真实模型按 rubric 打分（mock 模式跳过）
 *
 * 断言器纯函数化（文件系统读 + 传入数据），运行器与单测共用。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ChatMessage, TraceEntry } from '@multi-agent/shared'
import { measureDoc } from '@multi-agent/shared'

export type Assertion =
  | { type: 'artifact_exists'; path: string }
  | { type: 'artifact_contains'; path: string; text: string }
  | { type: 'min_chars'; path: string; value: number }
  | { type: 'min_sections'; path: string; value: number }
  | { type: 'min_sources'; path: string; value: number }
  | { type: 'run_end_reason'; value: string }
  | { type: 'turns_lte'; value: number }
  | { type: 'handoff_targets'; values: string[] }
  | { type: 'agent_spoke'; values: string[] }
  | { type: 'invited_members'; values: string[] }
  | { type: 'no_invite' }
  | { type: 'no_loop' }
  | { type: 'no_stall' }
  | {
      type: 'scheduling'
      routesMin?: number
      handoffAcceptedMin?: number
      wavesMin?: number
      parallelWavesMin?: number
      stallSuppressedMax?: number
      writeConflictsMax?: number
    }
  | { type: 'token_budget_ok' }
  | { type: 'memory_recall'; minItems: number }
  | { type: 'judge'; rubric: string; minScore: number }

export interface AssertionContext {
  /** 会话工作区根（隔离沙箱绝对路径） */
  rootDir: string
  /** 本 Run 轨迹（时间序） */
  events: TraceEntry[]
  /** 会话全部消息（seq 序） */
  messages: ChatMessage[]
  /** 上下文快照（token 预算判定） */
  context: { estimatedTokens: number; budgetTokens: number }
  /** judge 执行器（mock 模式缺省 → 断言标记 skipped） */
  judge?: (rubric: string, transcript: string) => Promise<{ score: number; reasons?: string }>
}

export interface AssertionResult {
  type: string
  ok: boolean
  skipped?: boolean
  detail: string
}

/** 展示用标签（报告 Markdown） */
export function assertionLabel(assertion: Assertion): string {
  switch (assertion.type) {
    case 'artifact_exists':
      return `交付件存在 ${assertion.path}`
    case 'artifact_contains':
      return `交付件含文本「${assertion.text}」`
    case 'min_chars':
      return `交付件非空白字符 ≥ ${assertion.value}（${assertion.path}）`
    case 'min_sections':
      return `交付件二级章节 ≥ ${assertion.value}（${assertion.path}）`
    case 'min_sources':
      return `交付件来源标记 ≥ ${assertion.value}（${assertion.path}）`
    case 'run_end_reason':
      return `结束原因 = ${assertion.value}`
    case 'turns_lte':
      return `回合数 ≤ ${assertion.value}`
    case 'handoff_targets':
      return `接力目标含 ${assertion.values.join('、')}`
    case 'agent_spoke':
      return `发言成员含 ${assertion.values.join('、')}`
    case 'invited_members':
      return `召集名单含 ${assertion.values.join('、')}`
    case 'no_invite':
      return '无自动召集'
    case 'no_loop':
      return '无循环抑制'
    case 'no_stall':
      return '无停滞抑制'
    case 'scheduling': {
      const parts: string[] = []
      if (assertion.routesMin !== undefined) parts.push(`路由 ≥${assertion.routesMin}`)
      if (assertion.handoffAcceptedMin !== undefined) parts.push(`接单回执 ≥${assertion.handoffAcceptedMin}`)
      if (assertion.wavesMin !== undefined) parts.push(`波次 ≥${assertion.wavesMin}`)
      if (assertion.parallelWavesMin !== undefined) parts.push(`并行波 ≥${assertion.parallelWavesMin}`)
      if (assertion.stallSuppressedMax !== undefined) parts.push(`停滞抑制 ≤${assertion.stallSuppressedMax}`)
      if (assertion.writeConflictsMax !== undefined) parts.push(`写冲突 ≤${assertion.writeConflictsMax}`)
      return `调度指标（${parts.join('、')}）`
    }
    case 'token_budget_ok':
      return '上下文在预算内'
    case 'memory_recall':
      return `语义召回注入 ≥ ${assertion.minItems} 条`
    case 'judge':
      return `judge ≥ ${assertion.minScore}（${assertion.rubric.slice(0, 40)}…）`
  }
}

/** 调度聚合口径（与 RunEventStore.schedulingStats 同口径的纯函数版；供断言与单测复用） */
export function schedulingCounts(events: TraceEntry[]): {
  routes: number
  routeFallbacks: number
  waves: number
  parallelWaves: number
  loopSuppressed: number
  stallSuppressed: number
  writeConflicts: number
  handoffAccepted: number
} {
  let routes = 0
  let routeFallbacks = 0
  let waves = 0
  let parallelWaves = 0
  let loopSuppressed = 0
  let stallSuppressed = 0
  let writeConflicts = 0
  let handoffAccepted = 0
  for (const e of events) {
    if (e.type === 'routing:dispatched') {
      if (e.payload.fallback === true) routeFallbacks += 1
      else routes += 1
    } else if (e.type === 'wave:start') {
      waves += 1
      if (e.payload.parallel === true) parallelWaves += 1
    } else if (e.type === 'schedule') {
      if (e.payload.loopSuppressed === true) loopSuppressed += 1
      if (e.payload.stallSuppressed === true) stallSuppressed += 1
    } else if (e.type === 'wave:write-conflict') {
      writeConflicts += 1
    } else if (e.type === 'handoff:accepted') {
      handoffAccepted += 1
    }
  }
  return {
    routes,
    routeFallbacks,
    waves,
    parallelWaves,
    loopSuppressed,
    stallSuppressed,
    writeConflicts,
    handoffAccepted,
  }
}

/** 消息流转录（judge / 报告用）：发送者 + 正文（截断） */
export function renderTranscript(messages: ChatMessage[], maxChars = 12_000): string {
  const lines = messages
    .filter((m) => m.role !== 'system' && m.content.trim())
    .map((m) => {
      const who = m.role === 'user' ? '用户' : `Agent(${m.agentId ?? '?'})`
      return `[${who}] ${m.content.trim().slice(0, 800)}`
    })
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（截断）` : text
}

export async function runAssertion(assertion: Assertion, ctx: AssertionContext): Promise<AssertionResult> {
  switch (assertion.type) {
    case 'artifact_exists': {
      const full = path.join(ctx.rootDir, assertion.path)
      const ok = fs.existsSync(full) && fs.statSync(full).isFile()
      return {
        type: assertion.type,
        ok,
        detail: ok ? `${assertion.path} 已产出` : `${assertion.path} 不存在`,
      }
    }

    case 'artifact_contains': {
      const full = path.join(ctx.rootDir, assertion.path)
      if (!fs.existsSync(full)) {
        return { type: assertion.type, ok: false, detail: `${assertion.path} 不存在` }
      }
      const content = fs.readFileSync(full, 'utf8')
      const ok = content.includes(assertion.text)
      return {
        type: assertion.type,
        ok,
        detail: ok
          ? `${assertion.path} 含「${assertion.text}」`
          : `${assertion.path} 未找到「${assertion.text}」`,
      }
    }

    case 'min_chars': {
      const full = path.join(ctx.rootDir, assertion.path)
      if (!fs.existsSync(full)) {
        return { type: assertion.type, ok: false, detail: `${assertion.path} 不存在` }
      }
      const { chars } = measureDoc(fs.readFileSync(full, 'utf8'))
      const ok = chars >= assertion.value
      return {
        type: assertion.type,
        ok,
        detail: `非空白字符 ${chars} ${ok ? '≥' : '<'} ${assertion.value}`,
      }
    }

    case 'min_sections': {
      const full = path.join(ctx.rootDir, assertion.path)
      if (!fs.existsSync(full)) {
        return { type: assertion.type, ok: false, detail: `${assertion.path} 不存在` }
      }
      const { sections } = measureDoc(fs.readFileSync(full, 'utf8'))
      const ok = sections >= assertion.value
      return {
        type: assertion.type,
        ok,
        detail: `二级章节 ${sections} ${ok ? '≥' : '<'} ${assertion.value}`,
      }
    }

    case 'min_sources': {
      const full = path.join(ctx.rootDir, assertion.path)
      if (!fs.existsSync(full)) {
        return { type: assertion.type, ok: false, detail: `${assertion.path} 不存在` }
      }
      const { sources } = measureDoc(fs.readFileSync(full, 'utf8'))
      const ok = sources >= assertion.value
      return {
        type: assertion.type,
        ok,
        detail: `来源标记 ${sources} ${ok ? '≥' : '<'} ${assertion.value}（URL / 「来源：」/ 编号引用合计）`,
      }
    }

    case 'run_end_reason': {
      const end = [...ctx.events].reverse().find((e) => e.type === 'run:end')
      const reason = String(end?.payload.reason ?? '')
      const ok = reason === assertion.value
      return {
        type: assertion.type,
        ok,
        detail: ok ? `结束原因 ${reason}` : `结束原因 ${reason || '（缺失）'} ≠ ${assertion.value}`,
      }
    }

    case 'turns_lte': {
      const turns = ctx.events.filter((e) => e.type === 'turn:end').length
      const ok = turns <= assertion.value
      return { type: assertion.type, ok, detail: `回合数 ${turns} ${ok ? '≤' : '>'} ${assertion.value}` }
    }

    case 'handoff_targets': {
      const seen = new Set<string>()
      for (const m of ctx.messages) {
        if (m.role !== 'agent') continue
        for (const id of m.mentions) seen.add(id)
      }
      const missing = assertion.values.filter((v) => !seen.has(v))
      const ok = missing.length === 0
      return {
        type: assertion.type,
        ok,
        detail: ok ? `接力目标齐备（${assertion.values.join('、')}）` : `缺少接力目标：${missing.join('、')}`,
      }
    }

    case 'agent_spoke': {
      const spoke = new Set(
        ctx.messages.filter((m) => m.role === 'agent' && m.agentId).map((m) => m.agentId!),
      )
      const missing = assertion.values.filter((v) => !spoke.has(v))
      const ok = missing.length === 0
      return {
        type: assertion.type,
        ok,
        detail: ok ? `发言成员齐备（${assertion.values.join('、')}）` : `缺少发言成员：${missing.join('、')}`,
      }
    }

    case 'invited_members': {
      const invited = new Set<string>()
      for (const e of ctx.events) {
        if (e.type !== 'routing:dispatched') continue
        for (const id of (e.payload.members as unknown[] | undefined) ?? []) invited.add(String(id))
      }
      const missing = assertion.values.filter((v) => !invited.has(v))
      const ok = missing.length === 0
      return {
        type: assertion.type,
        ok,
        detail: ok ? `召集名单齐备（${assertion.values.join('、')}）` : `缺少召集成员：${missing.join('、')}`,
      }
    }

    case 'no_invite': {
      const invites = ctx.events.filter(
        (e) =>
          e.type === 'routing:dispatched' && ((e.payload.members as unknown[] | undefined) ?? []).length > 0,
      )
      const ok = invites.length === 0
      return {
        type: assertion.type,
        ok,
        detail: ok
          ? '无自动召集（未见 members 非空的 routing:dispatched）'
          : `发生自动召集 ${invites.length} 次：${invites.map((e) => ((e.payload.members as unknown[] | undefined) ?? []).join('/')).join('、')}`,
      }
    }

    case 'no_loop': {
      const suppressed = ctx.events.filter((e) => e.type === 'schedule' && e.payload.loopSuppressed === true)
      const ok = suppressed.length === 0
      return { type: assertion.type, ok, detail: ok ? '无循环抑制' : `触发循环抑制 ${suppressed.length} 次` }
    }

    case 'token_budget_ok': {
      const { estimatedTokens, budgetTokens } = ctx.context
      const ok = budgetTokens > 0 && estimatedTokens <= budgetTokens
      return {
        type: assertion.type,
        ok,
        detail: `估算 ${estimatedTokens} tokens / 预算 ${budgetTokens}`,
      }
    }

    case 'memory_recall': {
      const recalls = ctx.events.filter((e) => e.type === 'memory:recall')
      const maxCount = recalls.reduce((n, e) => Math.max(n, Number(e.payload.count ?? 0)), 0)
      const ok = recalls.length > 0 && maxCount >= assertion.minItems
      return {
        type: assertion.type,
        ok,
        detail:
          recalls.length === 0
            ? '本 Run 未观测到 memory:recall 事件（L1.5 未注入）'
            : ok
              ? `召回事件 ${recalls.length} 次（单回合最多注入 ${maxCount} 条）`
              : `单回合最多注入 ${maxCount} 条 < ${assertion.minItems}`,
      }
    }

    case 'no_stall': {
      const stalls = ctx.events.filter((e) => e.type === 'schedule' && e.payload.stallSuppressed === true)
      const ok = stalls.length === 0
      return { type: assertion.type, ok, detail: ok ? '无停滞抑制' : `触发停滞抑制 ${stalls.length} 次` }
    }

    case 'scheduling': {
      const c = schedulingCounts(ctx.events)
      const checks: string[] = []
      const ok =
        (assertion.routesMin === undefined || c.routes >= assertion.routesMin) &&
        (assertion.handoffAcceptedMin === undefined || c.handoffAccepted >= assertion.handoffAcceptedMin) &&
        (assertion.wavesMin === undefined || c.waves >= assertion.wavesMin) &&
        (assertion.parallelWavesMin === undefined || c.parallelWaves >= assertion.parallelWavesMin) &&
        (assertion.stallSuppressedMax === undefined || c.stallSuppressed <= assertion.stallSuppressedMax) &&
        (assertion.writeConflictsMax === undefined || c.writeConflicts <= assertion.writeConflictsMax)
      if (assertion.routesMin !== undefined) checks.push(`routes(${c.routes})≥${assertion.routesMin}`)
      if (assertion.handoffAcceptedMin !== undefined)
        checks.push(`handoffAccepted(${c.handoffAccepted})≥${assertion.handoffAcceptedMin}`)
      if (assertion.wavesMin !== undefined) checks.push(`waves(${c.waves})≥${assertion.wavesMin}`)
      if (assertion.parallelWavesMin !== undefined)
        checks.push(`parallelWaves(${c.parallelWaves})≥${assertion.parallelWavesMin}`)
      if (assertion.stallSuppressedMax !== undefined)
        checks.push(`stallSuppressed(${c.stallSuppressed})≤${assertion.stallSuppressedMax}`)
      if (assertion.writeConflictsMax !== undefined)
        checks.push(`writeConflicts(${c.writeConflicts})≤${assertion.writeConflictsMax}`)
      return { type: assertion.type, ok, detail: checks.join('，') }
    }

    case 'judge': {
      if (!ctx.judge) {
        return {
          type: assertion.type,
          ok: true,
          skipped: true,
          detail: 'mock 模式：judge 断言跳过（--judge 启用真实模型）',
        }
      }
      const result = await ctx.judge(assertion.rubric, renderTranscript(ctx.messages))
      const ok = result.score >= assertion.minScore
      return {
        type: assertion.type,
        ok,
        detail: `得分 ${result.score}（阈值 ${assertion.minScore}）${result.reasons ? ` · ${result.reasons.slice(0, 160)}` : ''}`,
      }
    }
  }
}

/** 批量执行（供运行器与单测复用） */
export async function runAssertions(
  assertions: Assertion[],
  ctx: AssertionContext,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = []
  for (const assertion of assertions) {
    results.push(await runAssertion(assertion, ctx))
  }
  return results
}

/** 解析任务断言 JSON（未知类型 → 抛错，fail-fast 避免静默漏测） */
export function parseAssertions(raw: unknown): Assertion[] {
  if (!Array.isArray(raw)) throw new Error('assertions 必须是数组')
  return raw.map((item, i) => {
    const a = item as Record<string, unknown>
    const type = String(a?.type ?? '')
    switch (type) {
      case 'artifact_exists':
        return { type, path: String(a.path) }
      case 'artifact_contains':
        return { type, path: String(a.path), text: String(a.text) }
      case 'min_chars':
      case 'min_sections':
      case 'min_sources':
        return { type, path: String(a.path), value: Number(a.value) }
      case 'run_end_reason':
        return { type, value: String(a.value) }
      case 'turns_lte':
        return { type, value: Number(a.value) }
      case 'handoff_targets':
        return { type, values: (a.values as unknown[]).map(String) }
      case 'agent_spoke':
        return { type, values: (a.values as unknown[]).map(String) }
      case 'invited_members':
        return { type, values: (a.values as unknown[]).map(String) }
      case 'no_loop':
      case 'no_stall':
      case 'no_invite':
      case 'token_budget_ok':
        return { type }
      case 'scheduling': {
        const num = (v: unknown): number | undefined => (v === undefined ? undefined : Number(v))
        return {
          type,
          routesMin: num(a.routesMin),
          handoffAcceptedMin: num(a.handoffAcceptedMin),
          wavesMin: num(a.wavesMin),
          parallelWavesMin: num(a.parallelWavesMin),
          stallSuppressedMax: num(a.stallSuppressedMax),
          writeConflictsMax: num(a.writeConflictsMax),
        }
      }
      case 'memory_recall':
        return { type, minItems: a.minItems === undefined ? 1 : Number(a.minItems) }
      case 'judge':
        return { type, rubric: String(a.rubric), minScore: Number(a.minScore) }
      default:
        throw new Error(`assertions[${i}] 未知断言类型：${type || '(空)'}`)
    }
  })
}
