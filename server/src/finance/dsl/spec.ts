/**
 * DSL 规范校验与 lint（M83 §4.3）：YAML 解析 → zod 结构校验 → 语义检查（免取数、免网络）。
 *
 * 语义检查清单（设计稿 §4.3）：未知变量 / 未知函数 / 参数个数与静态类型 / inputs 引用未声明 /
 * ref 负偏移（FUTURE_REF）/ 表达式超长或过深 / 调用数超限 / 落图 kind 必需字段 / 建议项 warning。
 */
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { DRAWING_KINDS } from '@multi-agent/shared'
import {
  DslExprError,
  collectCalls,
  collectIdents,
  collectMembers,
  collectNegativeRefs,
  exprDepth,
  parseExpr,
  type ExprNode,
} from './expr.js'
import { DSL_FUNCTIONS, DSL_SERIES_NAMES, isConstExpr } from './runtime.js'
import type { DslDrawingRule, DslFinding, DslParseResult, DslSignalRule, DslSpec } from './types.js'

/** 护栏常量（meta 与工具说明共用） */
export const DSL_LIMITS = {
  sourceBytes: 20 * 1024,
  exprChars: 400,
  depth: 24,
  calls: 64,
  inputs: 20,
} as const

/** 允许的 timeframe 标签（1d/1w/1m + 分钟级） */
const TIMEFRAMES = ['1d', '1w', '1m', '60m', '30m', '15m', '5m'] as const

const exprString = z.string().min(1).max(DSL_LIMITS.exprChars)
const anchorSchema = z.union([z.number().int(), z.string().min(1).max(20)])

const emitSchema = z
  .object({
    direction: z.enum(['long', 'short', 'neutral']),
    confidence: z.number().min(0).max(1).optional(),
    horizon: z.string().max(20).optional(),
    rationale_hint: z.string().max(120).optional(),
    entry: exprString.optional(),
    stop_loss: exprString.optional(),
    take_profit: z.array(exprString).max(6).optional(),
  })
  .strict()

const signalSchema = z.object({ when: exprString, emit: emitSchema }).strict()

const drawingSchema = z
  .object({
    kind: z.enum(DRAWING_KINDS),
    at: exprString.optional(),
    x: anchorSchema.optional(),
    from: anchorSchema.optional(),
    to: anchorSchema.optional(),
    top: exprString.optional(),
    bottom: exprString.optional(),
    entry: exprString.optional(),
    stop_loss: exprString.optional(),
    take_profit: z.array(exprString).max(6).optional(),
    points: z.array(z.object({ x: anchorSchema, y: exprString }).strict()).min(2).max(10).optional(),
    label: z.string().max(60).optional(),
    color: z.string().max(20).optional(),
    dash: z.boolean().optional(),
  })
  .strict()

/** 策略 YAML 的 zod schema（供 parse 与 meta 的 JSON Schema 派生共用） */
export const dslSpecSchema = z
  .object({
    dsl: z.literal(1).optional(),
    name: z.string().min(1).max(60),
    description: z.string().max(300).optional(),
    theory: z.string().max(4000).optional(),
    timeframes: z.array(z.string().max(10)).max(6).optional(),
    inputs: z
      .record(z.union([z.number(), z.string().max(200), z.boolean()]))
      .refine((m) => Object.keys(m).length <= DSL_LIMITS.inputs, { message: `inputs 参数最多 ${DSL_LIMITS.inputs} 个` })
      .optional(),
    signals: z.array(signalSchema).min(1).max(10),
    drawings: z.array(drawingSchema).max(30).optional(),
    llm: z
      .object({ system_hint: z.string().max(2000).optional(), fields: z.array(z.string().max(40)).max(20).optional() })
      .strict()
      .optional(),
  })
  .strict()

type RawSpec = z.infer<typeof dslSpecSchema>

/** 落图 kind 必需字段（语义检查） */
const DRAWING_REQUIRED: Record<string, Array<keyof DslDrawingRule>> = {
  hline: ['at'],
  vline: ['x'],
  textLabel: ['at'],
  zone: ['from', 'to', 'top', 'bottom'],
  rect: ['from', 'to', 'top', 'bottom'],
  segment: ['points'],
  trendline: ['points'],
  ray: ['points'],
  fibonacci: ['points'],
  polyline: ['points'],
  position: ['entry'],
}

/** 解析 + 校验 + 语义检查（结构化结论；不抛异常） */
export function parseDsl(source: string): DslParseResult {
  const findings: DslFinding[] = []
  if (Buffer.byteLength(source, 'utf8') > DSL_LIMITS.sourceBytes) {
    return { ok: false, findings: [{ level: 'error', code: 'TOO_LARGE', message: `DSL 源超过 ${DSL_LIMITS.sourceBytes / 1024}KB 上限` }] }
  }
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    return { ok: false, findings: [{ level: 'error', code: 'YAML_PARSE', message: `YAML 解析失败：${(err as Error).message}` }] }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, findings: [{ level: 'error', code: 'YAML_SHAPE', message: '策略顶层必须是 YAML 对象（name / signals 等）' }] }
  }
  if (typeof (raw as { dsl?: unknown }).dsl === 'number' && (raw as { dsl: number }).dsl !== 1) {
    return {
      ok: false,
      findings: [{ level: 'error', code: 'VERSION', message: `暂不支持 dsl: ${(raw as { dsl: number }).dsl}（当前支持 dsl: 1）` }],
    }
  }
  const parsed = dslSpecSchema.safeParse(raw)
  if (!parsed.success) {
    for (const issue of parsed.error.issues.slice(0, 12)) {
      findings.push({
        level: 'error',
        code: 'SCHEMA',
        message: issue.message,
        ...(issue.path.length > 0 ? { path: issue.path.join('.') } : {}),
      })
    }
    return { ok: false, findings }
  }
  const spec = normalize(parsed.data)
  lintSpec(spec, findings)
  const errors = findings.filter((f) => f.level === 'error')
  if (errors.length > 0) return { ok: false, findings }
  return { ok: true, spec, findings }
}

/** 归一化（缺省值填充） */
function normalize(raw: RawSpec): DslSpec {
  return {
    dsl: 1,
    name: raw.name,
    description: raw.description ?? '',
    timeframes: raw.timeframes ?? [],
    inputs: raw.inputs ?? {},
    signals: raw.signals as DslSignalRule[],
    drawings: (raw.drawings ?? []) as DslDrawingRule[],
    llm: { system_hint: raw.llm?.system_hint ?? '', fields: raw.llm?.fields ?? [] },
  }
}

/** 语义检查（追加 findings；static，不触网） */
function lintSpec(spec: DslSpec, findings: DslFinding[]): void {
  const declaredInputs = new Set(Object.keys(spec.inputs))
  let totalCalls = 0

  const checkExpr = (expr: string, path: string): void => {
    if (expr.length > DSL_LIMITS.exprChars) {
      findings.push({ level: 'error', code: 'EXPR_TOO_LONG', message: `表达式超过 ${DSL_LIMITS.exprChars} 字符`, path })
      return
    }
    let ast: ExprNode
    try {
      ast = parseExpr(expr)
    } catch (err) {
      const e = err as DslExprError
      findings.push({
        level: 'error',
        code: e.code === 'SYNTAX' ? 'EXPR_SYNTAX' : e.code,
        message: `表达式错误：${e.message}`,
        path,
      })
      return
    }
    if (exprDepth(ast) > DSL_LIMITS.depth) {
      findings.push({ level: 'error', code: 'EXPR_TOO_DEEP', message: `表达式嵌套超过 ${DSL_LIMITS.depth} 层`, path })
    }
    const calls = collectCalls(ast)
    totalCalls += calls.length
    const fnMap = new Map(DSL_FUNCTIONS.map((f) => [f.name, f]))
    for (const name of calls) {
      if (!fnMap.has(name)) {
        findings.push({
          level: 'error',
          code: 'UNKNOWN_FUNC',
          message: `未知函数「${name}」（可用：${DSL_FUNCTIONS.map((f) => f.name).join(' / ')}）`,
          path,
        })
      }
    }
    // 参数个数与 const 静态检查
    walkCalls(ast, (name, args) => {
      const def = fnMap.get(name)
      if (!def) return
      if (args.length !== def.args.length) {
        findings.push({ level: 'error', code: 'ARGC', message: `「${name}」需要 ${def.args.length} 个参数（收到 ${args.length} 个）`, path })
        return
      }
      def.args.forEach((kind, i) => {
        if (kind === 'const' && !isConstExpr(args[i])) {
          findings.push({
            level: 'error',
            code: 'ARG_NOT_CONST',
            message: `「${name}」第 ${i + 1} 个参数需为常量（数字或 inputs 参数）`,
            path,
          })
        }
      })
    })
    for (const ident of collectIdents(ast)) {
      if (!(DSL_SERIES_NAMES as readonly string[]).includes(ident)) {
        const hint = declaredInputs.has(ident) ? `（inputs 参数请写作 inputs.${ident}）` : ''
        findings.push({
          level: 'error',
          code: 'UNKNOWN_VAR',
          message: `未知变量「${ident}」${hint}（可用序列：${DSL_SERIES_NAMES.join(' / ')}）`,
          path,
        })
      }
    }
    for (const member of collectMembers(ast)) {
      if (member.object !== 'inputs') {
        findings.push({ level: 'error', code: 'UNKNOWN_VAR', message: `不支持「${member.object}.${member.property}」`, path })
        continue
      }
      if (!declaredInputs.has(member.property)) {
        findings.push({
          level: 'error',
          code: 'INPUT_UNDECLARED',
          message: `inputs 未声明参数「${member.property}」（请在 inputs 段声明）`,
          path,
        })
      }
    }
    const negatives = collectNegativeRefs(ast)
    if (negatives.length > 0) {
      findings.push({
        level: 'error',
        code: 'FUTURE_REF',
        message: `ref(${negatives[0]})：仅允许回看（n ≥ 0），禁止未来函数`,
        path,
      })
    }
  }

  spec.signals.forEach((rule, i) => {
    checkExpr(rule.when, `signals[${i}].when`)
    const emit = rule.emit
    if (emit.entry) checkExpr(emit.entry, `signals[${i}].emit.entry`)
    if (emit.stop_loss) checkExpr(emit.stop_loss, `signals[${i}].emit.stop_loss`)
    ;(emit.take_profit ?? []).forEach((t, j) => checkExpr(t, `signals[${i}].emit.take_profit[${j}]`))
    if (!emit.take_profit || emit.take_profit.length === 0) {
      findings.push({ level: 'warning', code: 'TAKE_PROFIT_EMPTY', message: '建议给出 take_profit（目标位表达式）', path: `signals[${i}].emit` })
    }
    if (!emit.stop_loss) {
      findings.push({ level: 'warning', code: 'STOP_LOSS_MISSING', message: '建议给出 stop_loss（止损位表达式）', path: `signals[${i}].emit` })
    }
    if (emit.direction === 'neutral') {
      findings.push({ level: 'warning', code: 'NEUTRAL_SIGNAL', message: 'neutral 信号不参与回测执行（仅作观察）', path: `signals[${i}].emit` })
    }
  })

  spec.drawings.forEach((d, i) => {
    const required = DRAWING_REQUIRED[d.kind] ?? []
    for (const field of required) {
      if (d[field] === undefined) {
        findings.push({ level: 'error', code: 'DRAWING_FIELD', message: `落图「${d.kind}」缺少字段「${String(field)}」`, path: `drawings[${i}]` })
      }
    }
    const exprs: Array<[string | undefined, string]> = [
      [d.at, 'at'],
      [d.top, 'top'],
      [d.bottom, 'bottom'],
      [d.entry, 'entry'],
      [d.stop_loss, 'stop_loss'],
    ]
    for (const [expr, field] of exprs) {
      if (expr) checkExpr(expr, `drawings[${i}].${field}`)
    }
    ;(d.take_profit ?? []).forEach((t, j) => checkExpr(t, `drawings[${i}].take_profit[${j}]`))
    ;(d.points ?? []).forEach((p, j) => checkExpr(p.y, `drawings[${i}].points[${j}].y`))
  })

  if (totalCalls > DSL_LIMITS.calls) {
    findings.push({ level: 'error', code: 'TOO_MANY_CALLS', message: `序列函数调用 ${totalCalls} 次，超过上限 ${DSL_LIMITS.calls}` })
  }
  for (const tf of spec.timeframes) {
    if (!(TIMEFRAMES as readonly string[]).includes(tf)) {
      findings.push({ level: 'warning', code: 'TIMEFRAME_UNKNOWN', message: `timeframes 未知标签「${tf}」（常用：${TIMEFRAMES.join(' / ')}）` })
    }
  }
}

/** 遍历全部 call 节点（名字 + 实参节点） */
function walkCalls(node: ExprNode, visit: (name: string, args: ExprNode[]) => void): void {
  switch (node.kind) {
    case 'call':
      visit(node.name, node.args)
      for (const a of node.args) walkCalls(a, visit)
      break
    case 'unary':
      walkCalls(node.operand, visit)
      break
    case 'binary':
      walkCalls(node.left, visit)
      walkCalls(node.right, visit)
      break
    case 'ternary':
      walkCalls(node.cond, visit)
      walkCalls(node.then, visit)
      walkCalls(node.else, visit)
      break
    default:
      break
  }
}
