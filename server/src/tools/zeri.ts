/**
 * M66 续完善：择日排盘工具（zeri_pan）——见 docs/design-studio-design.md §10 续完善。
 *
 * - 纯计算只读（无 IO / 无网络 / 无副作用）；tier=deferred，经 tool_search
 *   （「择日 / 日课 / 吉日 / 黄道 / 建除 / 看日子」）激活；
 * - 输出含可直接整卡复制的「::: pan zeri <标题>」择日卡模板（client ZeriBoard 渲染）；
 * - 失败语义（同排盘口径）：PanError 结构化错误 + 建议，禁止模型心算兜底冒充工具结果。
 */
import { z } from 'zod'
import type { AgentTool, ToolResult } from './registry.js'
import { PanError } from '../pan/types.js'
import { ZERI_PURPOSES, computeZeri, type ZeriResult } from '../pan/zeri.js'

const starOf = (score: number): string => '★'.repeat(score) + '☆'.repeat(5 - score)

/** 工具输出全文（文本段 + 择日卡模板；导出供测试与 mock 复用） */
export function zeriText(r: ZeriResult): string {
  const L: string[] = []
  L.push(`择日排盘（${r.purpose}；${r.from} 至 ${r.to}，共 ${r.days.length} 天）`)
  L.push('日期表（日柱 · 建除 · 评分 · 冲煞 · 宜忌）：')
  for (const d of r.days) {
    L.push(`  ${d.date}（${d.ganzhi} · ${d.jianchu} · ${d.weekday}）${starOf(d.score)} ${d.chong} 煞${d.sha} ｜ ${d.note}`)
  }
  L.push(
    r.recommended.length > 0
      ? `推荐：${r.recommended.map((d) => `${d.date}（${d.jianchu}）`).join(' · ')}`
      : '推荐：区间内传统参考评分普遍一般——建议放宽日期范围或核对专业历书',
  )
  for (const n of r.notes) L.push(`声明：${n}`)
  L.push('')
  L.push('择日卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan zeri ${r.purpose} · ${r.from.slice(5)} 至 ${r.to.slice(5)}`)
  L.push(`事项：${r.purpose} ｜ 区间：${r.from} 至 ${r.to}`)
  L.push('口径：建除十二神（节气月建）｜ 评分 1–5（传统宜忌参考）')
  for (const d of r.days) {
    L.push(`- ${d.date}（${d.ganzhi} · ${d.jianchu} · ${d.weekday}）| ${d.score} | ${d.chong} 煞${d.sha} | ${d.note}`)
  }
  if (r.recommended.length > 0) {
    L.push(`推荐：${r.recommended.map((d) => `${d.date}（${d.jianchu}）`).join(' · ')}`)
  }
  L.push('- 声明 | 评分仅反映传统宜忌参考（不以吉凶为必然判断）；以实际安排为先')
  L.push('- 声明 | 节气为近似公式——边界日请以专业历书复核')
  L.push(':::')
  return L.join('\n')
}

const zeriArgs = z.object({
  purpose: z.enum(ZERI_PURPOSES),
  from: z.string().min(8).max(10),
  to: z.string().min(8).max(10),
})

const zeriPanTool: AgentTool = {
  name: 'zeri_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    `择日排盘（唯一口径；建除 / 冲煞必须出自本工具，禁止心算兜底）：输入事项（${ZERI_PURPOSES.join(' / ')}）与起止日期（YYYY-MM-DD，区间 ≤ 31 天）；输出逐日表（日柱 / 建除十二神 / 1–5 评分 / 冲生肖 / 煞方 / 宜忌简注）与推荐日（评分前 3），附合规声明与可直接整卡复制的「::: pan zeri」择日卡模板。凡是「择日 / 日课 / 吉日 / 黄道吉日 / 看日子 / 建除」都先用本工具；结果定位为传统择日文化研习参考（不承诺吉凶必应）。`,
  parameters: {
    type: 'object',
    properties: {
      purpose: { type: 'string', enum: [...ZERI_PURPOSES], description: '事项门类' },
      from: { type: 'string', description: '起始日 YYYY-MM-DD' },
      to: { type: 'string', description: '结束日 YYYY-MM-DD（含；区间 ≤ 31 天）' },
    },
    required: ['purpose', 'from', 'to'],
  },
  schema: zeriArgs,
  async execute(args: z.infer<typeof zeriArgs>): Promise<ToolResult> {
    try {
      const r = computeZeri(args)
      const top = r.recommended[0]
      return {
        ok: true,
        summary: `择日完成：${r.purpose}（${r.from} 至 ${r.to}）${
          top ? `——首选 ${top.date}（${top.jianchu}日，${top.score}/5）` : '——区间内传统参考评分普遍一般'
        }`,
        detail: zeriText(r),
      }
    } catch (err) {
      if (err instanceof PanError) {
        return {
          ok: false,
          summary: `择日排盘失败：${err.message}`,
          detail: `择日排盘失败：${err.message}\n建议：${err.hint}`,
        }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return {
        ok: false,
        summary: `择日排盘失败（未预期错误）：${msg}`,
        detail: `择日排盘失败（未预期错误）：${msg}\n建议：请核对输入后重试；如仍失败请反馈该案例（附完整输入）`,
      }
    }
  },
}

/** M66 续完善：择日排盘工具组（zeri_pan）——纯计算只读，tier=deferred 经 tool_search 激活 */
export function createZeriTools(): AgentTool[] {
  return [zeriPanTool]
}
