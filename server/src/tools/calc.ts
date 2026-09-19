/**
 * calc 工具（M21.2）：精确计算 —— 四则 / 乘方 / 括号 + 业务函数表（毛利 / CAGR / NPV / IRR / 盈亏平衡等）。
 * 零依赖自实现：tokenizer + Pratt parser 即时求值；不做任何动态代码执行（纯解释器）。
 * 错误信息中文化；detail 附求值过程（函数级轨迹）。
 */
import { z } from 'zod'
import type { ToolRuntime, ToolResult } from './registry.js'

type NumOrArr = number | number[]

interface Token {
  kind: 'num' | 'ident' | 'op' | 'lparen' | 'rparen' | 'lbracket' | 'rbracket' | 'comma'
  text: string
  pos: number
  num?: number
}

const OP_CHARS = new Set(['+', '-', '*', '/', '^'])

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (/[0-9.]/.test(ch)) {
      const m = /^(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i))
      if (!m) throw new Error(`表达式语法错误：第 ${i + 1} 个字符附近无法识别数字`)
      tokens.push({ kind: 'num', text: m[0], pos: i, num: Number(m[0]) })
      i += m[0].length
      continue
    }
    if (/[A-Za-z_]/.test(ch)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))
      const text = m ? m[0] : ch
      tokens.push({ kind: 'ident', text, pos: i })
      i += text.length
      continue
    }
    if (OP_CHARS.has(ch)) {
      tokens.push({ kind: 'op', text: ch, pos: i })
      i++
      continue
    }
    const simple: Record<string, Token['kind']> = {
      '(': 'lparen',
      ')': 'rparen',
      '[': 'lbracket',
      ']': 'rbracket',
      ',': 'comma',
    }
    const kind = simple[ch]
    if (kind) {
      tokens.push({ kind, text: ch, pos: i })
      i++
      continue
    }
    throw new Error(`表达式语法错误：第 ${i + 1} 个字符附近有不允许的字符「${ch}」`)
  }
  return tokens
}

/** 数值展示：整数原样；小数最多 10 位并去尾零（消除浮点噪声） */
function fmt(n: number): string {
  if (Number.isInteger(n)) return String(n)
  const fixed = n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '')
  return fixed === '' || fixed === '-' ? '0' : fixed
}

function assertNumber(v: NumOrArr, where: string): number {
  if (typeof v !== 'number') throw new Error(`${where}：数组只能作为函数参数（如 sum([1,2,3])）`)
  return v
}

/** 固定参数个数 + 全数字校验 */
function fixed(args: NumOrArr[], count: number, name: string): number[] {
  if (args.length !== count) {
    throw new Error(`${name} 需要 ${count} 个数字参数，实际收到 ${args.length} 个`)
  }
  return args.map((a) => assertNumber(a, `${name} 的参数`))
}

/** 展平为数字序列（sum/min/max/avg/npv/irr 用：支持 sum(1,2,3) 或 sum([1,2,3])） */
function flatten(args: NumOrArr[], name: string): number[] {
  const out: number[] = []
  for (const a of args) {
    if (typeof a === 'number') out.push(a)
    else out.push(...a)
  }
  if (out.length === 0) throw new Error(`${name} 需要至少 1 个数字`)
  return out
}

/** NPV = Σ flows[t] ÷ (1+rate)^t（flows[0] 为 t=0，通常为负的初始投入） */
function npvValue(rate: number, flows: number[]): number {
  return flows.reduce((acc, cf, t) => acc + cf / Math.pow(1 + rate, t), 0)
}

function solveIrr(flows: number[]): number {
  if (flows.length < 2) throw new Error('irr 需要至少 2 期现金流')
  if (!flows.some((f) => f > 0) || !flows.some((f) => f < 0)) {
    throw new Error('irr 无法求解：现金流需同时包含正值与负值')
  }
  const f = (r: number): number => npvValue(r, flows)
  let lo = -0.9999
  let hi = 10
  let flo = f(lo)
  const fhi = f(hi)
  if (!Number.isFinite(flo) || !Number.isFinite(fhi)) throw new Error('irr 无法求解：数值溢出')
  if (flo * fhi > 0) throw new Error('irr 无法求解：合理利率区间内未找到零点（可检查现金流符号分布）')
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    const fm = f(mid)
    if (fm === 0 || hi - lo < 1e-9) return mid
    if (flo * fm < 0) {
      hi = mid
    } else {
      lo = mid
      flo = fm
    }
  }
  return (lo + hi) / 2
}

interface FnSpec {
  usage: string
  run: (args: NumOrArr[]) => { value: number; trace: string }
}

const FUNCTIONS: Record<string, FnSpec> = {
  round: {
    usage: 'round(x, n=0)：四舍五入到 n 位小数',
    run: (args) => {
      if (args.length < 1 || args.length > 2) throw new Error('round 需要 1-2 个参数：round(x, n=0)')
      const x = assertNumber(args[0], 'round 的参数')
      const n = args.length === 2 ? assertNumber(args[1], 'round 的参数') : 0
      const value = Math.round(x * Math.pow(10, n)) / Math.pow(10, n)
      return { value, trace: `round(${fmt(x)}, ${fmt(n)}) = ${fmt(value)}` }
    },
  },
  min: {
    usage: 'min(数字… 或 数组)：最小值',
    run: (args) => {
      const list = flatten(args, 'min')
      const value = Math.min(...list)
      return { value, trace: `min(${list.map(fmt).join(', ')}) = ${fmt(value)}` }
    },
  },
  max: {
    usage: 'max(数字… 或 数组)：最大值',
    run: (args) => {
      const list = flatten(args, 'max')
      const value = Math.max(...list)
      return { value, trace: `max(${list.map(fmt).join(', ')}) = ${fmt(value)}` }
    },
  },
  sum: {
    usage: 'sum(数字… 或 数组)：求和',
    run: (args) => {
      const list = flatten(args, 'sum')
      const value = list.reduce((a, b) => a + b, 0)
      return { value, trace: `sum(${list.map(fmt).join(', ')}) = ${fmt(value)}` }
    },
  },
  avg: {
    usage: 'avg(数字… 或 数组)：平均值',
    run: (args) => {
      const list = flatten(args, 'avg')
      const value = list.reduce((a, b) => a + b, 0) / list.length
      return { value, trace: `avg(${list.map(fmt).join(', ')}) = ${fmt(value)}` }
    },
  },
  pct_change: {
    usage: 'pct_change(上期, 本期) = (本期 − 上期) ÷ 上期',
    run: (args) => {
      const [prev, curr] = fixed(args, 2, 'pct_change')
      if (prev === 0) throw new Error('pct_change：上期值不能为零')
      const value = (curr - prev) / prev
      return { value, trace: `pct_change(${fmt(prev)}, ${fmt(curr)}) = (${fmt(curr)} − ${fmt(prev)}) ÷ ${fmt(prev)} = ${fmt(value)}` }
    },
  },
  gross_margin: {
    usage: 'gross_margin(收入, 成本) = (收入 − 成本) ÷ 收入',
    run: (args) => {
      const [revenue, cost] = fixed(args, 2, 'gross_margin')
      if (revenue === 0) throw new Error('gross_margin：收入不能为零')
      const value = (revenue - cost) / revenue
      return { value, trace: `gross_margin(${fmt(revenue)}, ${fmt(cost)}) = (${fmt(revenue)} − ${fmt(cost)}) ÷ ${fmt(revenue)} = ${fmt(value)}` }
    },
  },
  markup: {
    usage: 'markup(成本, 售价) = (售价 − 成本) ÷ 成本（加价率）',
    run: (args) => {
      const [cost, price] = fixed(args, 2, 'markup')
      if (cost === 0) throw new Error('markup：成本不能为零')
      const value = (price - cost) / cost
      return { value, trace: `markup(${fmt(cost)}, ${fmt(price)}) = (${fmt(price)} − ${fmt(cost)}) ÷ ${fmt(cost)} = ${fmt(value)}` }
    },
  },
  discount: {
    usage: 'discount(原价, 折扣率) = 原价 × (1 − 折扣率)',
    run: (args) => {
      const [price, rate] = fixed(args, 2, 'discount')
      const value = price * (1 - rate)
      return { value, trace: `discount(${fmt(price)}, ${fmt(rate)}) = ${fmt(price)} × (1 − ${fmt(rate)}) = ${fmt(value)}` }
    },
  },
  cagr: {
    usage: 'cagr(期初, 期末, 年数) = (期末 ÷ 期初)^(1÷年数) − 1',
    run: (args) => {
      const [begin, end, years] = fixed(args, 3, 'cagr')
      if (begin <= 0) throw new Error('cagr：期初值必须大于 0')
      if (end < 0) throw new Error('cagr：期末值不能为负')
      if (years <= 0) throw new Error('cagr：年数必须大于 0')
      const value = Math.pow(end / begin, 1 / years) - 1
      return { value, trace: `cagr(${fmt(begin)}, ${fmt(end)}, ${fmt(years)}) = (${fmt(end)} ÷ ${fmt(begin)})^(1÷${fmt(years)}) − 1 = ${fmt(value)}` }
    },
  },
  compound: {
    usage: 'compound(本金, 期利率, 期数) = 本金 × (1 + 期利率)^期数',
    run: (args) => {
      const [principal, rate, periods] = fixed(args, 3, 'compound')
      const value = principal * Math.pow(1 + rate, periods)
      return { value, trace: `compound(${fmt(principal)}, ${fmt(rate)}, ${fmt(periods)}) = ${fmt(principal)} × (1 + ${fmt(rate)})^${fmt(periods)} = ${fmt(value)}` }
    },
  },
  loan_payment: {
    usage: 'loan_payment(本金, 年利率, 月数)：等额本息月供',
    run: (args) => {
      const [principal, annualRate, months] = fixed(args, 3, 'loan_payment')
      if (months <= 0) throw new Error('loan_payment：月数必须大于 0')
      const r = annualRate / 12
      const value = Math.abs(r) < 1e-12 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1)
      return { value, trace: `loan_payment(${fmt(principal)}, ${fmt(annualRate)}, ${fmt(months)}) = 月供 ${fmt(value)}（月利率 ${fmt(r)}）` }
    },
  },
  npv: {
    usage: 'npv(折现率, [现金流…])：净现值（第 1 个数为 t=0 初始投入）',
    run: (args) => {
      if (args.length < 2) throw new Error('npv 需要 2 个参数：npv(折现率, [现金流…])')
      const rate = assertNumber(args[0], 'npv 的折现率')
      const flows = flatten(args.slice(1), 'npv 的现金流')
      if (rate <= -1) throw new Error('npv：折现率必须大于 -1')
      const value = npvValue(rate, flows)
      const terms = flows.slice(0, 4).map((cf, t) => `${fmt(cf)}÷${fmt(1 + rate)}^${t}`)
      const dots = flows.length > 4 ? ' + …' : ''
      return { value, trace: `npv(${fmt(rate)}, [${flows.map(fmt).join(', ')}]) = ${terms.join(' + ')}${dots} = ${fmt(value)}` }
    },
  },
  irr: {
    usage: 'irr([现金流…])：内部收益率（现金流需同时含正负值）',
    run: (args) => {
      const flows = flatten(args, 'irr')
      const value = solveIrr(flows)
      return { value, trace: `irr([${flows.map(fmt).join(', ')}]) = ${fmt(value)}（令 NPV = 0 的折现率）` }
    },
  },
  roi: {
    usage: 'roi(收益, 投入) = (收益 − 投入) ÷ 投入',
    run: (args) => {
      const [gain, cost] = fixed(args, 2, 'roi')
      if (cost === 0) throw new Error('roi：投入不能为零')
      const value = (gain - cost) / cost
      return { value, trace: `roi(${fmt(gain)}, ${fmt(cost)}) = (${fmt(gain)} − ${fmt(cost)}) ÷ ${fmt(cost)} = ${fmt(value)}` }
    },
  },
  roas: {
    usage: 'roas(广告收入, 广告花费) = 收入 ÷ 花费',
    run: (args) => {
      const [revenue, spend] = fixed(args, 2, 'roas')
      if (spend === 0) throw new Error('roas：广告花费不能为零')
      const value = revenue / spend
      return { value, trace: `roas(${fmt(revenue)}, ${fmt(spend)}) = ${fmt(revenue)} ÷ ${fmt(spend)} = ${fmt(value)}` }
    },
  },
  cac: {
    usage: 'cac(总花费, 新增客户数) = 花费 ÷ 客户数',
    run: (args) => {
      const [spend, customers] = fixed(args, 2, 'cac')
      if (customers === 0) throw new Error('cac：客户数不能为零')
      const value = spend / customers
      return { value, trace: `cac(${fmt(spend)}, ${fmt(customers)}) = ${fmt(spend)} ÷ ${fmt(customers)} = ${fmt(value)}` }
    },
  },
  ltv: {
    usage: 'ltv(客单均价, 毛利率, 复购次数) = 客单价 × 毛利率 × 次数',
    run: (args) => {
      const [arpu, margin, times] = fixed(args, 3, 'ltv')
      const value = arpu * margin * times
      return { value, trace: `ltv(${fmt(arpu)}, ${fmt(margin)}, ${fmt(times)}) = ${fmt(arpu)} × ${fmt(margin)} × ${fmt(times)} = ${fmt(value)}` }
    },
  },
  breakeven: {
    usage: 'breakeven(固定成本, 单价, 单位变动成本) = 固定成本 ÷ (单价 − 单位变动成本)',
    run: (args) => {
      const [fixedCost, price, variable] = fixed(args, 3, 'breakeven')
      if (price <= variable) throw new Error('breakeven：单价必须大于单位变动成本，否则永远无法回本')
      const value = fixedCost / (price - variable)
      return { value, trace: `breakeven(${fmt(fixedCost)}, ${fmt(price)}, ${fmt(variable)}) = ${fmt(fixedCost)} ÷ (${fmt(price)} − ${fmt(variable)}) = ${fmt(value)}` }
    },
  },
  net_after_tax: {
    usage: 'net_after_tax(金额, 税率) = 金额 × (1 − 税率)',
    run: (args) => {
      const [amount, rate] = fixed(args, 2, 'net_after_tax')
      const value = amount * (1 - rate)
      return { value, trace: `net_after_tax(${fmt(amount)}, ${fmt(rate)}) = ${fmt(amount)} × (1 − ${fmt(rate)}) = ${fmt(value)}` }
    },
  },
}

export const CALC_FUNCTION_NAMES = Object.keys(FUNCTIONS)

class Evaluator {
  private pos = 0
  private readonly trace: string[] = []

  constructor(
    private readonly tokens: Token[],
    private readonly src: string,
  ) {}

  getTrace(): string[] {
    return this.trace
  }

  evaluate(): number {
    const value = this.parseExpr(0)
    const rest = this.tokens[this.pos]
    if (rest) {
      throw new Error(`表达式语法错误：第 ${rest.pos + 1} 个字符附近有多余内容「${rest.text}」`)
    }
    const num = assertNumber(value, '表达式结果')
    if (!Number.isFinite(num)) throw new Error('计算结果无效（可能除零或数值溢出）')
    return num
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos]
  }

  private parseExpr(minBp: number): NumOrArr {
    let left = this.parseUnary()
    for (;;) {
      const t = this.peek()
      if (!t || t.kind !== 'op') break
      const op = t.text as '+' | '-' | '*' | '/' | '^'
      const bp = op === '+' || op === '-' ? 1 : op === '*' || op === '/' ? 2 : 3
      if (bp < minBp) break
      this.pos++
      const right = this.parseExpr(op === '^' ? bp : bp + 1)
      left = this.applyBinary(op, left, right)
    }
    return left
  }

  private parseUnary(): NumOrArr {
    const t = this.peek()
    if (!t) throw new Error('表达式意外结束：缺少运算量')
    if (t.kind === 'op' && (t.text === '-' || t.text === '+')) {
      this.pos++
      const v = assertNumber(this.parseUnary(), '一元运算')
      return t.text === '-' ? -v : v
    }
    return this.parsePrimary()
  }

  private parsePrimary(): NumOrArr {
    const t = this.peek()
    if (!t) throw new Error('表达式意外结束：缺少运算量')
    if (t.kind === 'num') {
      this.pos++
      return t.num ?? 0
    }
    if (t.kind === 'lparen') {
      this.pos++
      const v = this.parseExpr(0)
      this.expect('rparen', '「)」')
      return v
    }
    if (t.kind === 'lbracket') {
      this.pos++
      const items: number[] = []
      if (this.peek()?.kind !== 'rbracket') {
        for (;;) {
          items.push(assertNumber(this.parseExpr(0), '数组元素'))
          const sep = this.peek()
          if (sep?.kind === 'comma') {
            this.pos++
            continue
          }
          break
        }
      }
      this.expect('rbracket', '「]」')
      return items
    }
    if (t.kind === 'ident') {
      const name = t.text.toLowerCase()
      this.pos++
      if (this.peek()?.kind !== 'lparen') {
        throw new Error(`未知标识符「${t.text}」：函数需带括号调用，如 round(3.14159, 2)`)
      }
      this.pos++
      const args: NumOrArr[] = []
      if (this.peek()?.kind !== 'rparen') {
        for (;;) {
          args.push(this.parseExpr(0))
          const sep = this.peek()
          if (sep?.kind === 'comma') {
            this.pos++
            continue
          }
          break
        }
      }
      this.expect('rparen', '「)」')
      const spec = FUNCTIONS[name]
      if (!spec) {
        throw new Error(`未知函数「${t.text}」；可用函数：${CALC_FUNCTION_NAMES.join(' / ')}`)
      }
      let result: { value: number; trace: string }
      try {
        result = spec.run(args)
      } catch (err) {
        // 附函数签名（usage）：参数个数 / 顺序写错时，模型可按签名一步纠正，工具卡同样自说明
        throw new Error(`函数 ${name} 出错：${(err as Error).message}（用法：${spec.usage}）`)
      }
      if (!Number.isFinite(result.value)) throw new Error(`函数 ${name} 结果无效（可能除零或溢出）`)
      this.trace.push(result.trace)
      return result.value
    }
    throw new Error(`表达式语法错误：第 ${t.pos + 1} 个字符附近有意外内容「${t.text}」`)
  }

  private expect(kind: Token['kind'], label: string): void {
    const t = this.peek()
    if (!t || t.kind !== kind) {
      throw new Error(`表达式语法错误：第 ${(t?.pos ?? this.src.length) + 1} 个字符附近缺少 ${label}`)
    }
    this.pos++
  }

  private applyBinary(op: '+' | '-' | '*' | '/' | '^', left: NumOrArr, right: NumOrArr): number {
    const a = assertNumber(left, `运算符 ${op}`)
    const b = assertNumber(right, `运算符 ${op}`)
    let v: number
    switch (op) {
      case '+':
        v = a + b
        break
      case '-':
        v = a - b
        break
      case '*':
        v = a * b
        break
      case '/':
        if (b === 0) throw new Error('除数为零')
        v = a / b
        break
      default:
        v = Math.pow(a, b)
        break
    }
    if (!Number.isFinite(v)) throw new Error(`运算「${op}」结果无效（溢出或数学域错误）`)
    return v
  }
}

export type CalcOutcome = { ok: true; value: number; trace: string[] } | { ok: false; error: string }

/** 纯函数求值入口（可单测）：tokenize → Pratt parse → 即时求值 + 函数级轨迹 */
export function evaluateExpression(expression: string): CalcOutcome {
  try {
    const src = expression.trim()
    if (src.length === 0) return { ok: false, error: '表达式为空' }
    const tokens = tokenize(src)
    if (tokens.length === 0) return { ok: false, error: '表达式为空' }
    const evaluator = new Evaluator(tokens, src)
    const value = evaluator.evaluate()
    return { ok: true, value, trace: evaluator.getTrace() }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export const calcTool = {
  name: 'calc',
  readOnly: true,
  description:
    '精确计算表达式（四则 / 乘方 / 括号 + 业务函数）。金额、比例、利率、测算一律用它，禁止心算。函数：round / min / max / sum / avg / pct_change / gross_margin / markup / discount / cagr / compound / loan_payment / npv / irr / roi / roas / cac / ltv / breakeven / net_after_tax。',
  parameters: {
    type: 'object',
    properties: {
      expression: {
        type: 'string',
        description:
          '计算表达式，如 "(1200-800)/1200"、"gross_margin(1200, 800)"、"npv(0.1, [-10000, 3000, 4000, 5000])"',
      },
    },
    required: ['expression'],
  },
  schema: z.object({ expression: z.string().min(1).max(2000) }),
  async execute(args: { expression: string }, _ctx: ToolRuntime): Promise<ToolResult> {
    const outcome = evaluateExpression(args.expression)
    if (!outcome.ok) {
      return { ok: false, summary: `计算失败：${outcome.error}` }
    }
    const lines = [`表达式：${args.expression}`, `结果：${fmt(outcome.value)}`]
    if (outcome.trace.length > 0) {
      lines.push('求值过程：')
      for (const t of outcome.trace) lines.push(`  ${t}`)
    }
    return { ok: true, summary: `= ${fmt(outcome.value)}`, detail: lines.join('\n') }
  },
}
