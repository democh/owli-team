/**
 * DSL 运行时（M83 §4.3）：向量化求值器 + 函数白名单 + null 语义。
 *
 * 模型：每个 AST 节点求值为「常量或等长序列」的带类型值（num / bool / str）；
 * 运算逐点广播，null 传播（比较与逻辑遇 null 判 false）；序列函数复用 indicator.ts 口径
 * （与 fin_indicator 数值一致）；`ref(x, n)` 仅允许 n ≥ 0 —— 负偏移报 FUTURE_REF（反未来函数）。
 */
import { ema, sma, wilderSmooth } from '../indicator.js'
import type { KlineBar } from '../types.js'
import { DslExprError, type ExprNode } from './expr.js'

export type NumVec = Array<number | null>
export type NumV = { c: true; v: number | null } | { c: false; a: NumVec }
export type BoolV = { c: true; v: boolean } | { c: false; a: boolean[] }
export type Val = { t: 'num'; n: NumV } | { t: 'bool'; b: BoolV } | { t: 'str'; s: string }

/** 序列变量名（K 线原生字段） */
export const DSL_SERIES_NAMES = ['open', 'high', 'low', 'close', 'volume', 'turnover'] as const
export type DslSeriesName = (typeof DSL_SERIES_NAMES)[number]

/** 函数签名定义（lint 静态检查与运行时共用，单一事实源） */
export interface DslFunctionDef {
  name: string
  args: Array<'num' | 'const' | 'bool'>
  returns: 'num' | 'bool'
  doc: string
}

export const DSL_FUNCTIONS: DslFunctionDef[] = [
  { name: 'ma', args: ['num', 'const'], returns: 'num', doc: '简单移动平均：ma(close, 20)' },
  { name: 'ema', args: ['num', 'const'], returns: 'num', doc: '指数移动平均：ema(close, 12)' },
  { name: 'hhv', args: ['num', 'const'], returns: 'num', doc: 'N 根最高值：hhv(high, 60)' },
  { name: 'llv', args: ['num', 'const'], returns: 'num', doc: 'N 根最低值：llv(low, 60)' },
  { name: 'ref', args: ['num', 'const'], returns: 'num', doc: '前 N 根取值（仅回看，n ≥ 0）：ref(close, 1)' },
  { name: 'cross_up', args: ['num', 'num'], returns: 'bool', doc: 'a 上穿 b：cross_up(ma(close,5), ma(close,20))' },
  { name: 'cross_down', args: ['num', 'num'], returns: 'bool', doc: 'a 下穿 b（对称）' },
  { name: 'atr', args: ['const'], returns: 'num', doc: 'ATR（Wilder，默认周期如 atr(14)）' },
  { name: 'rsi', args: ['const'], returns: 'num', doc: 'RSI（Wilder）：rsi(14)' },
  { name: 'dif', args: ['const', 'const'], returns: 'num', doc: 'MACD DIF：dif(12, 26)' },
  { name: 'dea', args: ['const', 'const', 'const'], returns: 'num', doc: 'MACD DEA：dea(12, 26, 9)' },
  { name: 'hist', args: ['const', 'const', 'const'], returns: 'num', doc: 'MACD 柱：(DIF−DEA)×2' },
  { name: 'bb_up', args: ['const', 'const'], returns: 'num', doc: '布林上轨：bb_up(20, 2)' },
  { name: 'bb_mid', args: ['const'], returns: 'num', doc: '布林中轨：bb_mid(20)' },
  { name: 'bb_low', args: ['const', 'const'], returns: 'num', doc: '布林下轨：bb_low(20, 2)' },
  { name: 'vol_ma', args: ['const'], returns: 'num', doc: '成交量均线：vol_ma(5)' },
  { name: 'abs', args: ['num'], returns: 'num', doc: '绝对值（逐点）' },
  { name: 'max', args: ['num', 'num'], returns: 'num', doc: '逐点较大值' },
  { name: 'min', args: ['num', 'num'], returns: 'num', doc: '逐点较小值' },
  { name: 'if', args: ['bool', 'num', 'num'], returns: 'num', doc: '条件选择（逐点）：if(close > open, close, open)' },
]

const FUNCTION_MAP: Map<string, DslFunctionDef> = new Map(DSL_FUNCTIONS.map((f) => [f.name, f]))

/** 求值上下文（series 全量预计算一次） */
export interface SeriesContext {
  n: number
  timestamps: number[]
  series: Record<DslSeriesName, NumVec>
  inputs: Record<string, number | string | boolean>
}

/** 构建上下文（bars → 序列字典；全量一次映射） */
export function buildSeriesContext(bars: KlineBar[], inputs: Record<string, number | string | boolean>): SeriesContext {
  return {
    n: bars.length,
    timestamps: bars.map((b) => b.timestamp),
    series: {
      open: bars.map((b) => b.open),
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      close: bars.map((b) => b.close),
      volume: bars.map((b) => b.volume),
      turnover: bars.map((b) => (b.turnover === undefined ? null : b.turnover)),
    },
    inputs,
  }
}

// ---------------------------------------------------------------- 广播工具

export function numArr(v: NumV, n: number): NumVec {
  return v.c ? new Array(n).fill(v.v) : v.a
}

export function boolArr(v: BoolV, n: number): boolean[] {
  return v.c ? new Array(n).fill(v.v) : v.a
}

/** 序列值取第 i 项（常量直接返回值） */
export function valueAt(v: NumV, i: number): number | null {
  return v.c ? v.v : v.a[i] ?? null
}

export function boolAt(v: BoolV, i: number): boolean {
  return v.c ? v.v : v.a[i] ?? false
}

// ---------------------------------------------------------------- 求值

function err(code: string, message: string): DslExprError {
  return new DslExprError(code, message)
}

function asNum(v: Val, where: string): NumV {
  if (v.t !== 'num') throw err('TYPE', `${where}：需要数值（实际为${v.t === 'bool' ? '布尔' : '字符串'}）`)
  return v.n
}

function asBool(v: Val, where: string): BoolV {
  if (v.t !== 'bool') throw err('TYPE', `${where}：需要布尔条件`)
  return v.b
}

function constNumOf(v: NumV, where: string): number {
  if (!v.c || v.v === null || !Number.isFinite(v.v)) {
    throw err('ARG_NOT_CONST', `${where}：参数需为常量数字（可写数字或 inputs 参数）`)
  }
  return v.v
}

function applyNum(op: string, x: number | null, y: number | null): number | null {
  if (x === null || y === null) return null
  switch (op) {
    case '+':
      return x + y
    case '-':
      return x - y
    case '*':
      return x * y
    case '/':
      return y === 0 ? null : x / y
    case '%':
      return y === 0 ? null : x % y
    default:
      throw err('SYNTAX', `未知算术运算符「${op}」`)
  }
}

function compareNum(op: string, x: number | null, y: number | null): boolean {
  if (x === null || y === null) return false // null 语义：比较判 false
  switch (op) {
    case '<':
      return x < y
    case '<=':
      return x <= y
    case '>':
      return x > y
    case '>=':
      return x >= y
    case '==':
      return x === y
    case '!=':
      return x !== y
    default:
      throw err('SYNTAX', `未知比较运算符「${op}」`)
  }
}

/** 表达式求值（抛 DslExprError；纯函数，无副作用） */
export function evalExpr(node: ExprNode, ctx: SeriesContext): Val {
  switch (node.kind) {
    case 'num':
      return { t: 'num', n: { c: true, v: node.value } }
    case 'bool':
      return { t: 'bool', b: { c: true, v: node.value } }
    case 'null':
      return { t: 'num', n: { c: true, v: null } }
    case 'str':
      return { t: 'str', s: node.value }
    case 'ident': {
      if ((DSL_SERIES_NAMES as readonly string[]).includes(node.name)) {
        return { t: 'num', n: { c: false, a: ctx.series[node.name as DslSeriesName] } }
      }
      throw err('UNKNOWN_VAR', `未知变量「${node.name}」（可用：${DSL_SERIES_NAMES.join(' / ')}；自定义参数请用 inputs.<名>）`)
    }
    case 'member': {
      if (node.object !== 'inputs') {
        throw err('UNKNOWN_VAR', `不支持「${node.object}.${node.property}」（仅 inputs.<参数名> 可用）`)
      }
      if (!(node.property in ctx.inputs)) {
        throw err('UNKNOWN_VAR', `inputs 未声明参数「${node.property}」（请在 inputs 段声明）`)
      }
      const v = ctx.inputs[node.property]
      if (typeof v === 'boolean') return { t: 'bool', b: { c: true, v } }
      if (typeof v === 'string') return { t: 'str', s: v }
      return { t: 'num', n: { c: true, v } }
    }
    case 'unary': {
      const operand = evalExpr(node.operand, ctx)
      if (node.op === '-') {
        const n = asNum(operand, '一元负号')
        if (n.c) return { t: 'num', n: { c: true, v: n.v === null ? null : -n.v } }
        return { t: 'num', n: { c: false, a: n.a.map((x) => (x === null ? null : -x)) } }
      }
      const b = asBool(operand, 'not')
      return b.c ? { t: 'bool', b: { c: true, v: !b.v } } : { t: 'bool', b: { c: false, a: b.a.map((x) => !x) } }
    }
    case 'binary': {
      const op = node.op
      const left = evalExpr(node.left, ctx)
      // 逻辑短路（常量侧）
      if (op === 'and' || op === 'or') {
        const l = asBool(left, `「${op}」左侧`)
        if (l.c) {
          if (op === 'and' && !l.v) return { t: 'bool', b: { c: true, v: false } }
          if (op === 'or' && l.v) return { t: 'bool', b: { c: true, v: true } }
        }
        const r = asBool(evalExpr(node.right, ctx), `「${op}」右侧`)
        if (l.c && r.c) return { t: 'bool', b: { c: true, v: op === 'and' ? l.v && r.v : l.v || r.v } }
        const A = boolArr(l, ctx.n)
        const B = boolArr(r, ctx.n)
        return { t: 'bool', b: { c: false, a: A.map((x, i) => (op === 'and' ? x && B[i] : x || B[i])) } }
      }
      const right = evalExpr(node.right, ctx)
      // 字符串仅支持 == / !=
      if (left.t === 'str' || right.t === 'str') {
        if (op !== '==' && op !== '!=') throw err('TYPE', `字符串仅支持 == / != 比较`)
        if (left.t !== 'str' || right.t !== 'str') throw err('TYPE', '字符串只能与字符串比较')
        return { t: 'bool', b: { c: true, v: op === '==' ? left.s === right.s : left.s !== right.s } }
      }
      const a = asNum(left, `「${op}」左侧`)
      const b = asNum(right, `「${op}」右侧`)
      const isCompare = ['<', '<=', '>', '>=', '==', '!='].includes(op)
      if (a.c && b.c) {
        return isCompare
          ? { t: 'bool', b: { c: true, v: compareNum(op, a.v, b.v) } }
          : { t: 'num', n: { c: true, v: applyNum(op, a.v, b.v) } }
      }
      const A = numArr(a, ctx.n)
      const B = numArr(b, ctx.n)
      if (isCompare) return { t: 'bool', b: { c: false, a: A.map((x, i) => compareNum(op, x, B[i])) } }
      return { t: 'num', n: { c: false, a: A.map((x, i) => applyNum(op, x, B[i])) } }
    }
    case 'ternary': {
      const cond = asBool(evalExpr(node.cond, ctx), '三元条件')
      const thenV = evalExpr(node.then, ctx)
      const elseV = evalExpr(node.else, ctx)
      if (thenV.t !== elseV.t) throw err('TYPE', '三元表达式两侧类型需一致（数值 / 布尔）')
      if (thenV.t === 'str' || elseV.t === 'str') throw err('TYPE', '三元表达式不支持字符串')
      if (thenV.t === 'num' && elseV.t === 'num') {
        if (cond.c && thenV.n.c && elseV.n.c) {
          return { t: 'num', n: { c: true, v: cond.v ? thenV.n.v : elseV.n.v } }
        }
        const C = boolArr(cond, ctx.n)
        const T = numArr(thenV.n, ctx.n)
        const F = numArr(elseV.n, ctx.n)
        return { t: 'num', n: { c: false, a: C.map((x, i) => (x ? T[i] : F[i])) } }
      }
      const bThen = thenV as { t: 'bool'; b: BoolV }
      const bElse = elseV as { t: 'bool'; b: BoolV }
      if (cond.c && bThen.b.c && bElse.b.c) {
        return { t: 'bool', b: { c: true, v: cond.v ? bThen.b.v : bElse.b.v } }
      }
      const C = boolArr(cond, ctx.n)
      const T = boolArr(bThen.b, ctx.n)
      const F = boolArr(bElse.b, ctx.n)
      return { t: 'bool', b: { c: false, a: C.map((x, i) => (x ? T[i] : F[i])) } }
    }
    case 'call':
      return evalCall(node, ctx)
  }
}

function evalCall(node: Extract<ExprNode, { kind: 'call' }>, ctx: SeriesContext): Val {
  const def = FUNCTION_MAP.get(node.name)
  if (!def) {
    throw err('UNKNOWN_FUNC', `未知函数「${node.name}」（可选：${DSL_FUNCTIONS.map((f) => f.name).join(' / ')}）`)
  }
  if (node.args.length !== def.args.length) {
    throw err('ARGC', `「${node.name}」需要 ${def.args.length} 个参数（收到 ${node.args.length} 个）`)
  }
  const vals = node.args.map((arg, i) => {
    const v = evalExpr(arg, ctx)
    const kind = def.args[i]
    if (kind === 'bool') return asBool(v, `「${node.name}」第 ${i + 1} 个参数`)
    const n = asNum(v, `「${node.name}」第 ${i + 1} 个参数`)
    if (kind === 'const') constNumOf(n, `「${node.name}」第 ${i + 1} 个参数`)
    return n
  }) as Array<NumV | BoolV>

  const ai = (i: number): NumVec => numArr(vals[i] as NumV, ctx.n)
  const ci = (i: number): number => constNumOf(vals[i] as NumV, `「${node.name}」第 ${i + 1} 个参数`)

  switch (node.name) {
    case 'ma':
      return num(sma(ai(0).map((v) => v ?? 0), Math.round(ci(1))))
    case 'ema':
      return num(ema(ai(0).map((v) => v ?? 0), Math.round(ci(1))))
    case 'hhv':
    case 'llv': {
      const x = ai(0)
      const n = Math.round(ci(1))
      const out: NumVec = new Array(ctx.n).fill(null)
      for (let i = n - 1; i < ctx.n; i++) {
        let best = node.name === 'hhv' ? -Infinity : Infinity
        let ok = true
        for (let j = i - n + 1; j <= i; j++) {
          const v = x[j]
          if (v === null) {
            ok = false
            break
          }
          best = node.name === 'hhv' ? Math.max(best, v) : Math.min(best, v)
        }
        out[i] = ok ? best : null
      }
      return num(out)
    }
    case 'ref': {
      const x = ai(0)
      const n = Math.round(ci(1))
      if (n < 0) {
        throw new DslExprError('FUTURE_REF', `ref(${n})：仅允许回看（n ≥ 0），禁止未来函数`)
      }
      const out: NumVec = new Array(ctx.n).fill(null)
      for (let i = n; i < ctx.n; i++) out[i] = x[i - n]
      return num(out)
    }
    case 'cross_up':
    case 'cross_down': {
      const A = ai(0)
      const B = ai(1)
      const out: boolean[] = new Array(ctx.n).fill(false)
      for (let i = 1; i < ctx.n; i++) {
        const a0 = A[i - 1]
        const b0 = B[i - 1]
        const a1 = A[i]
        const b1 = B[i]
        if (a0 === null || b0 === null || a1 === null || b1 === null) continue
        out[i] =
          node.name === 'cross_up' ? (a0 <= b0 && a1 > b1) : a0 >= b0 && a1 < b1
      }
      return { t: 'bool', b: { c: false, a: out } }
    }
    case 'atr': {
      const n = Math.round(ci(0))
      const tr: NumVec = new Array(ctx.n).fill(null)
      for (let i = 0; i < ctx.n; i++) {
        const h = ctx.series.high[i] ?? 0
        const l = ctx.series.low[i] ?? 0
        const prev = i > 0 ? ctx.series.close[i - 1] : null
        tr[i] = prev === null ? h - l : Math.max(h - l, Math.abs(h - prev), Math.abs(l - prev))
      }
      return num(wilderSmooth(tr.map((v) => v ?? 0), n))
    }
    case 'rsi': {
      const n = Math.round(ci(0))
      const c = ctx.series.close.map((v) => v ?? 0)
      const gains = [0]
      const losses = [0]
      for (let i = 1; i < c.length; i++) {
        const diff = c[i] - c[i - 1]
        gains.push(Math.max(diff, 0))
        losses.push(Math.max(-diff, 0))
      }
      const avgGain = wilderSmooth(gains, n)
      const avgLoss = wilderSmooth(losses, n)
      const out: NumVec = new Array(ctx.n).fill(null)
      for (let i = 0; i < ctx.n; i++) {
        const g = avgGain[i]
        const l = avgLoss[i]
        out[i] = g === null || l === null ? null : l === 0 ? 100 : 100 - 100 / (1 + g / l)
      }
      return num(out)
    }
    case 'dif':
    case 'dea':
    case 'hist': {
      const fast = Math.round(ci(0))
      const slow = Math.round(ci(1))
      const c = ctx.series.close.map((v) => v ?? 0)
      const emaFast = ema(c, fast)
      const emaSlow = ema(c, slow)
      const dif = emaFast.map((v, i) => v - emaSlow[i])
      if (node.name === 'dif') return num(dif)
      const sig = Math.round(ci(2))
      const dea = ema(dif, sig)
      if (node.name === 'dea') return num(dea)
      return num(dif.map((v, i) => (v - dea[i]) * 2))
    }
    case 'bb_up':
    case 'bb_low':
    case 'bb_mid': {
      const n = Math.round(ci(0))
      const c = ctx.series.close.map((v) => v ?? 0)
      const mid = sma(c, n)
      if (node.name === 'bb_mid') return num(mid)
      const mult = ci(1)
      const out: NumVec = new Array(ctx.n).fill(null)
      for (let i = 0; i < ctx.n; i++) {
        const mv = mid[i]
        if (mv === null) continue
        let sum = 0
        for (let j = i - n + 1; j <= i; j++) sum += (c[j] - mv) ** 2
        const sd = Math.sqrt(sum / n)
        out[i] = node.name === 'bb_up' ? mv + mult * sd : mv - mult * sd
      }
      return num(out)
    }
    case 'vol_ma':
      return num(sma(ctx.series.volume.map((v) => v ?? 0), Math.round(ci(0))))
    case 'abs': {
      const x = ai(0)
      return num(x.map((v) => (v === null ? null : Math.abs(v))))
    }
    case 'max':
    case 'min': {
      const A = ai(0)
      const B = ai(1)
      return num(A.map((x, i) => (x === null || B[i] === null ? null : node.name === 'max' ? Math.max(x, B[i]!) : Math.min(x, B[i]!))))
    }
    case 'if': {
      const cond = boolArr(vals[0] as BoolV, ctx.n)
      const T = ai(1)
      const F = ai(2)
      return num(cond.map((x, i) => (x ? T[i] : F[i])))
    }
    default:
      throw err('UNKNOWN_FUNC', `函数「${node.name}」未实现`)
  }
}

function num(a: NumVec): Val {
  return { t: 'num', n: { c: false, a } }
}

/** 静态可判定的常量表达式（供 lint 的 const 参数检查） */
export function isConstExpr(node: ExprNode): boolean {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
    case 'null':
    case 'member':
      return true
    case 'unary':
      return isConstExpr(node.operand)
    case 'binary':
      return isConstExpr(node.left) && isConstExpr(node.right)
    case 'ternary':
      return isConstExpr(node.cond) && isConstExpr(node.then) && isConstExpr(node.else)
    case 'call':
    case 'ident':
      return false
  }
}
