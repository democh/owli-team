/**
 * M41（FI-2，ADR 委托见批次落位）：口径校验徽章派生——消息内成功执行的 calc 工具调用 →
 * 徽章数据（表达式 hover 展示）。「何时必须用 calc」由协议层约束（业务纪律四条），
 * 本派生只解决「用了就亮徽章」的呈现问题（不新增工具面）。
 */
import type { ToolCallRecord } from '@multi-agent/shared'

/** 首个成功 calc 调用的表达式（无 calc / 表达式缺失 → undefined，不渲染徽章） */
export function calcExpressionOf(calls: readonly ToolCallRecord[] | undefined): string | undefined {
  for (const call of calls ?? []) {
    if (call.name !== 'calc' || call.status !== 'ok') continue
    const expr = call.args.expression
    if (typeof expr === 'string' && expr.trim() !== '') return expr.trim()
  }
  return undefined
}
