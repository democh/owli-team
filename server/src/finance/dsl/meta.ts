/**
 * DSL 元数据（M83 §4.3）：变量 / 函数 / 枚举 / 落图 kind / 护栏 的结构化描述 + JSON Schema。
 * 供工具说明、`GET /api/finance/strategy/meta`（未来编辑器联想）共用——同一份元数据，
 * 编辑器与运行时口径永远一致。
 */
import { zodToJsonSchema } from 'zod-to-json-schema'
import { DRAWING_KINDS } from '@multi-agent/shared'
import { DSL_FUNCTIONS, DSL_SERIES_NAMES } from './runtime.js'
import { DSL_LIMITS, dslSpecSchema } from './spec.js'
import { DSL_BUILTINS } from './builtin.js'

export interface DslMeta {
  version: 1
  /** 策略 YAML 的 JSON Schema（编辑器校验 / 联想） */
  schema: Record<string, unknown>
  variables: Array<{ name: string; doc: string }>
  inputs_note: string
  functions: Array<{ name: string; signature: string; returns: 'num' | 'bool'; doc: string }>
  enums: Record<string, string[]>
  drawing_kinds: string[]
  limits: typeof DSL_LIMITS
  builtins: Array<{ key: string; name: string; description: string }>
}

/** 序列变量中文说明 */
const SERIES_DOCS: Record<string, string> = {
  open: '开盘价序列',
  high: '最高价序列',
  low: '最低价序列',
  close: '收盘价序列',
  volume: '成交量序列（手）',
  turnover: '成交额序列（元；源缺省为空）',
}

/** 函数参数签名渲染（num → series，const → 常量，bool → 条件） */
function signatureOf(name: string, args: Array<'num' | 'const' | 'bool'>): string {
  const labels = { num: 'series', const: 'const', bool: 'cond' } as const
  return `${name}(${args.map((a) => labels[a]).join(', ')})`
}

/** 构建 DSL 元数据（纯函数；每次调用返回新对象） */
export function buildDslMeta(): DslMeta {
  return {
    version: 1,
    schema: zodToJsonSchema(dslSpecSchema, { $refStrategy: 'none' }) as Record<string, unknown>,
    variables: DSL_SERIES_NAMES.map((name) => ({ name, doc: SERIES_DOCS[name] ?? '' })),
    inputs_note: 'inputs 段声明自定义参数（number / string / bool），表达式经 inputs.<名> 引用；执行时可用 inputs 覆盖（仅限已声明键）',
    functions: DSL_FUNCTIONS.map((f) => ({
      name: f.name,
      signature: signatureOf(f.name, f.args),
      returns: f.returns,
      doc: f.doc,
    })),
    enums: {
      direction: ['long', 'short', 'neutral'],
      horizon: ['intraday', 'short', 'swing', 'long'],
    },
    drawing_kinds: [...DRAWING_KINDS],
    limits: DSL_LIMITS,
    builtins: DSL_BUILTINS.map((b) => ({ key: b.key, name: b.name, description: b.description })),
  }
}
