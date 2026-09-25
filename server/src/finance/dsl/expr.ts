/**
 * DSL 表达式解析器（M83 §4.3，核心资产）：自研 tokenizer + 递归下降 → AST。
 *
 * 纪律：禁止 eval / new Function；语法完全自持，错误带位置与错误码（供 lint 与工具回显）。
 * 语法：数字 / 字符串 / 布尔 / null 字面量、标识符、`inputs.*` 成员访问、函数调用、
 * 算术 + - * / %、比较 < <= > >= == !=、逻辑 and/or/not、三元 cond ? a : b、括号。
 */

export class DslExprError extends Error {
  readonly code: string
  readonly position: number
  constructor(code: string, message: string, position = 0) {
    super(message)
    this.name = 'DslExprError'
    this.code = code
    this.position = position
  }
}

export type ExprNode =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'ident'; name: string }
  | { kind: 'member'; object: string; property: string }
  | { kind: 'unary'; op: '-' | 'not'; operand: ExprNode }
  | { kind: 'binary'; op: BinaryOp; left: ExprNode; right: ExprNode }
  | { kind: 'ternary'; cond: ExprNode; then: ExprNode; else: ExprNode }
  | { kind: 'call'; name: string; args: ExprNode[] }

export type BinaryOp = '+' | '-' | '*' | '/' | '%' | '<' | '<=' | '>' | '>=' | '==' | '!=' | 'and' | 'or'

interface Token {
  type: 'num' | 'str' | 'ident' | 'punct'
  value: string
  pos: number
}

const PUNCT_2 = ['<=', '>=', '==', '!=']
const PUNCT_1 = ['+', '-', '*', '/', '%', '<', '>', '(', ')', ',', '.', '?', ':']

function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    // 数字
    if (ch >= '0' && ch <= '9') {
      let j = i
      while (j < source.length && /[0-9.]/.test(source[j])) j++
      const text = source.slice(i, j)
      if ((text.match(/\./g) ?? []).length > 1 || text.endsWith('.')) {
        throw new DslExprError('SYNTAX', `数字格式错误：${text}`, i)
      }
      tokens.push({ type: 'num', value: text, pos: i })
      i = j
      continue
    }
    // 标识符 / 关键字
    if (/[A-Za-z_]/.test(ch)) {
      let j = i
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j++
      tokens.push({ type: 'ident', value: source.slice(i, j), pos: i })
      i = j
      continue
    }
    // 字符串
    if (ch === "'" || ch === '"') {
      const quote = ch
      let j = i + 1
      let out = ''
      while (j < source.length && source[j] !== quote) {
        if (source[j] === '\\' && j + 1 < source.length) {
          out += source[j + 1]
          j += 2
        } else {
          out += source[j]
          j++
        }
      }
      if (j >= source.length) throw new DslExprError('SYNTAX', '字符串未闭合', i)
      tokens.push({ type: 'str', value: out, pos: i })
      i = j + 1
      continue
    }
    // 双字符运算符
    const two = source.slice(i, i + 2)
    if (PUNCT_2.includes(two)) {
      tokens.push({ type: 'punct', value: two, pos: i })
      i += 2
      continue
    }
    if (PUNCT_1.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, pos: i })
      i++
      continue
    }
    throw new DslExprError('SYNTAX', `无法识别的字符「${ch}」`, i)
  }
  tokens.push({ type: 'ident', value: '', pos: source.length }) // eof 哨兵
  return tokens
}

class Parser {
  private pos = 0
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos]
  }

  private next(): Token {
    return this.tokens[this.pos++]
  }

  private expect(value: string): Token {
    const t = this.next()
    if (t.type !== 'punct' || t.value !== value) {
      throw new DslExprError('SYNTAX', `期望「${value}」，实际为「${t.value || '(表达式结束)'}」`, t.pos)
    }
    return t
  }

  parse(): ExprNode {
    const node = this.ternary()
    const t = this.peek()
    if (t.value !== '') throw new DslExprError('SYNTAX', `表达式末尾存在多余内容「${t.value}」`, t.pos)
    return node
  }

  private ternary(): ExprNode {
    const cond = this.or()
    if (this.peek().type === 'punct' && this.peek().value === '?') {
      this.next()
      const then = this.ternary()
      this.expect(':')
      const otherwise = this.ternary()
      return { kind: 'ternary', cond, then, else: otherwise }
    }
    return cond
  }

  private or(): ExprNode {
    let left = this.and()
    for (;;) {
      const t = this.peek()
      if (t.type === 'ident' && t.value === 'or') {
        this.next()
        left = { kind: 'binary', op: 'or', left, right: this.and() }
      } else break
    }
    return left
  }

  private and(): ExprNode {
    let left = this.comparison()
    for (;;) {
      const t = this.peek()
      if (t.type === 'ident' && t.value === 'and') {
        this.next()
        left = { kind: 'binary', op: 'and', left, right: this.comparison() }
      } else break
    }
    return left
  }

  private comparison(): ExprNode {
    let left = this.additive()
    for (;;) {
      const t = this.peek()
      if (t.type === 'punct' && ['<', '<=', '>', '>=', '==', '!='].includes(t.value)) {
        this.next()
        left = { kind: 'binary', op: t.value as BinaryOp, left, right: this.additive() }
      } else break
    }
    return left
  }

  private additive(): ExprNode {
    let left = this.multiplicative()
    for (;;) {
      const t = this.peek()
      if (t.type === 'punct' && (t.value === '+' || t.value === '-')) {
        this.next()
        left = { kind: 'binary', op: t.value, left, right: this.multiplicative() }
      } else break
    }
    return left
  }

  private multiplicative(): ExprNode {
    let left = this.unary()
    for (;;) {
      const t = this.peek()
      if (t.type === 'punct' && (t.value === '*' || t.value === '/' || t.value === '%')) {
        this.next()
        left = { kind: 'binary', op: t.value, left, right: this.unary() }
      } else break
    }
    return left
  }

  private unary(): ExprNode {
    const t = this.peek()
    if (t.type === 'punct' && t.value === '-') {
      this.next()
      return { kind: 'unary', op: '-', operand: this.unary() }
    }
    if (t.type === 'ident' && t.value === 'not') {
      this.next()
      return { kind: 'unary', op: 'not', operand: this.unary() }
    }
    return this.primary()
  }

  private primary(): ExprNode {
    const t = this.next()
    if (t.type === 'num') return { kind: 'num', value: Number(t.value) }
    if (t.type === 'str') return { kind: 'str', value: t.value }
    if (t.type === 'ident') {
      if (t.value === '') throw new DslExprError('SYNTAX', '表达式意外结束', t.pos)
      if (t.value === 'true') return { kind: 'bool', value: true }
      if (t.value === 'false') return { kind: 'bool', value: false }
      if (t.value === 'null') return { kind: 'null' }
      // 函数调用
      if (this.peek().type === 'punct' && this.peek().value === '(') {
        this.next()
        const args: ExprNode[] = []
        if (!(this.peek().type === 'punct' && this.peek().value === ')')) {
          for (;;) {
            args.push(this.ternary())
            const sep = this.peek()
            if (sep.type === 'punct' && sep.value === ',') {
              this.next()
              continue
            }
            break
          }
        }
        this.expect(')')
        return { kind: 'call', name: t.value, args }
      }
      // 成员访问 inputs.*
      if (this.peek().type === 'punct' && this.peek().value === '.') {
        this.next()
        const prop = this.next()
        if (prop.type !== 'ident' || prop.value === '') {
          throw new DslExprError('SYNTAX', '「.」后应为属性名', prop.pos)
        }
        return { kind: 'member', object: t.value, property: prop.value }
      }
      return { kind: 'ident', name: t.value }
    }
    if (t.type === 'punct' && t.value === '(') {
      const inner = this.ternary()
      this.expect(')')
      return inner
    }
    throw new DslExprError('SYNTAX', `无法解析「${t.value || '(表达式结束)'}」`, t.pos)
  }
}

/** 解析表达式（语法错误抛 DslExprError） */
export function parseExpr(source: string): ExprNode {
  const trimmed = source.trim()
  if (trimmed === '') throw new DslExprError('SYNTAX', '表达式为空')
  return new Parser(tokenize(trimmed)).parse()
}

/** AST 最大深度（lint 护栏：≤24） */
export function exprDepth(node: ExprNode): number {
  switch (node.kind) {
    case 'num':
    case 'str':
    case 'bool':
    case 'null':
    case 'ident':
    case 'member':
      return 1
    case 'unary':
      return 1 + exprDepth(node.operand)
    case 'binary':
      return 1 + Math.max(exprDepth(node.left), exprDepth(node.right))
    case 'ternary':
      return 1 + Math.max(exprDepth(node.cond), exprDepth(node.then), exprDepth(node.else))
    case 'call':
      return 1 + (node.args.length === 0 ? 0 : Math.max(...node.args.map(exprDepth)))
  }
}

/** 收集全部函数调用名 */
export function collectCalls(node: ExprNode): string[] {
  const out: string[] = []
  walk(node, (n) => {
    if (n.kind === 'call') out.push(n.name)
  })
  return out
}

/** 收集顶层标识符（变量 / 系列名；不含 inputs 成员与函数名） */
export function collectIdents(node: ExprNode): string[] {
  const out: string[] = []
  walk(node, (n) => {
    if (n.kind === 'ident') out.push(n.name)
  })
  return out
}

/** 收集 inputs.* 成员访问 */
export function collectMembers(node: ExprNode): Array<{ object: string; property: string }> {
  const out: Array<{ object: string; property: string }> = []
  walk(node, (n) => {
    if (n.kind === 'member') out.push({ object: n.object, property: n.property })
  })
  return out
}

/** 收集 ref 调用的字面量负偏移（lint 快速拦截；运行时仍全量校验） */
export function collectNegativeRefs(node: ExprNode): number[] {
  const out: number[] = []
  walk(node, (n) => {
    if (n.kind === 'call' && n.name === 'ref' && n.args.length === 2) {
      const arg = n.args[1]
      if (arg.kind === 'num' && arg.value < 0) out.push(arg.value)
      if (arg.kind === 'unary' && arg.op === '-' && arg.operand.kind === 'num') out.push(-arg.operand.value)
    }
  })
  return out
}

function walk(node: ExprNode, visit: (n: ExprNode) => void): void {
  visit(node)
  switch (node.kind) {
    case 'unary':
      walk(node.operand, visit)
      break
    case 'binary':
      walk(node.left, visit)
      walk(node.right, visit)
      break
    case 'ternary':
      walk(node.cond, visit)
      walk(node.then, visit)
      walk(node.else, visit)
      break
    case 'call':
      for (const a of node.args) walk(a, visit)
      break
    default:
      break
  }
}
