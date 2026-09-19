/**
 * M66-A：罗盘排盘工具（luopan_pan）——单件套，见 docs/design-studio-design.md §10.1。
 *
 * - 纯计算只读（无 IO / 无网络 / 无副作用）；tier=deferred，经 tool_search（「罗盘 / 风水 / 堪舆 / 阳宅 / 坐向 / 飞星」）激活；
 * - 输出含可直接整卡复制的「::: pan luopan <标题>」盘面卡模板（M66-B 落第五盘卡渲染；在此之前走
 *   PanCard 未知 kind 通用降级——fail-safe）；
 * - 失败语义（§10.1）：PanError 结构化错误 + 建议，禁止模型心算兜底冒充工具结果。
 */
import { z } from 'zod'
import type { AgentTool, ToolResult } from './registry.js'
import { PanError } from '../pan/types.js'
import { computeLuopan, starName, type LuopanResult } from '../pan/luopan.js'

/** 统一失败语义：PanError（含建议）与未预期错误分列（口径同排盘四件套） */
function panError(err: unknown): ToolResult {
  if (err instanceof PanError) {
    return {
      ok: false,
      summary: `罗盘排盘失败：${err.message}`,
      detail: `罗盘排盘失败：${err.message}\n建议：${err.hint}`,
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return {
    ok: false,
    summary: `罗盘排盘失败（未预期错误）：${msg}`,
    detail: `罗盘排盘失败（未预期错误）：${msg}\n建议：请核对输入后重试；如仍失败请反馈该案例（附完整输入）`,
  }
}

const deg1 = (x: number): string => `${x.toFixed(1)}°`

/** 面板/文本共用的九宫行（流年飞星，按洛书飞布序） */
function flyLine(r: LuopanResult): string {
  return r.feixing.yearPan
    .map((p) => `${p.palace}${p.star}`)
    .join(' ')
}

/** 工具输出全文（文本段 + 盘面卡模板；导出供测试与 mock 复用） */
export function luopanText(r: LuopanResult): string {
  const L: string[] = []
  L.push(`罗盘排盘（${r.label}；数据等级 ${r.quality}；${r.feixing.year} 流年）`)
  L.push(
    `朝向：坐 ${r.sitting.name}山（${deg1(r.sitting.range[0])}–${deg1(r.sitting.range[1])}）` +
      ` 向 ${r.facing.name}山（${deg1(r.facing.range[0])}–${deg1(r.facing.range[1])}）` +
      ` ｜ 周天 ${deg1(r.orientation.sittingDeg)} → ${deg1(r.orientation.facingDeg)}`,
  )
  L.push(`宅卦：${r.bazhai.houseName}（${r.bazhai.group}）｜ 口径：八宅·坐山派`)
  L.push(`兼向：${r.pitch.note}`)
  const lucky = r.bazhai.palaces.filter((p) => p.luck === '吉')
  const cautious = r.bazhai.palaces.filter((p) => p.luck === '凶')
  L.push(`八宫游年（吉）：${lucky.map((p) => `${p.star} ${p.gua}（${p.dir}）`).join(' ｜ ')}`)
  L.push(`八宫游年（慎用）：${cautious.map((p) => `${p.star} ${p.gua}（${p.dir}）`).join(' ｜ ')}`)
  L.push(`运盘：${r.feixing.yun}运（${r.feixing.yunRange[0]}–${r.feixing.yunRange[1]}）｜ 中宫 ${starName(r.feixing.yunCenter)}`)
  L.push(`流年：${r.feixing.year} ${r.feixing.yearName}入中 ｜ 飞布：${flyLine(r)}`)
  for (const n of r.notes) L.push(`声明：${n}`)
  L.push('')
  L.push('盘面卡（复制到回复渲染，整卡原样保留、勿增删字段）：')
  L.push(`::: pan luopan ${r.label}`)
  L.push(`坐向：坐 ${r.sitting.name}山 向 ${r.facing.name}山 ｜ 周天 ${deg1(r.orientation.sittingDeg)} → ${deg1(r.orientation.facingDeg)}`)
  L.push(`宅卦：${r.bazhai.houseName}（${r.bazhai.group}）｜ 八宅·坐山派`)
  L.push(`兼向：${r.pitch.kind}${r.pitch.offset !== null ? `（偏离 ${r.pitch.offset.toFixed(1)}°）` : ''}`)
  L.push(`吉方：${lucky.map((p) => `${p.star} ${p.gua}（${p.dir}）`).join(' ｜ ')}`)
  L.push(`慎用：${cautious.map((p) => `${p.star} ${p.gua}（${p.dir}）`).join(' ｜ ')}`)
  L.push(`运盘：${r.feixing.yun}运（${r.feixing.yunRange[0]}–${r.feixing.yunRange[1]}）中宫 ${starName(r.feixing.yunCenter)}`)
  L.push(`流年：${r.feixing.year} ${r.feixing.yearName}入中 ｜ 飞布：${flyLine(r)}`)
  L.push(`数据等级：${r.quality}`)
  L.push('- 口径声明 | 八宅·坐山派；玄空·下卦（兼向替卦不做）')
  L.push(`- 精度声明 | ${r.notes[0]!.replace(/^数据等级：/, '')}`)
  L.push(':::')
  return L.join('\n')
}

const luopanArgs = z.object({
  facing: z.string().min(1).max(40),
  quality: z.enum(['A', 'B', 'C']).optional(),
  year: z.number().int().optional(),
  declination: z.number().optional(),
  label: z.string().max(40).optional(),
})

const luopanPanTool: AgentTool = {
  name: 'luopan_pan',
  tier: 'deferred',
  readOnly: true,
  description:
    '罗盘排盘（唯一口径；二十四山 / 八宅游年 / 玄空流年必须出自本工具，禁止心算兜底）：输入朝向（度数如「172」或方位词如「坐北朝南」）与数据等级（A 现场罗盘 / B 手机指南针 / C 口头描述，缺省 C），可带 year 流年（缺省当年）与 declination 磁偏角（仅 A 级可用）；输出坐向定盘（二十四山）、八宅八宫九星（坐山派）与运盘 / 流年飞星（下卦口径），附精度与口径声明与可直接整卡复制的「::: pan luopan」盘面卡模板。凡是「罗盘 / 风水 / 堪舆 / 阳宅 / 坐向 / 飞星」都先用本工具；结果定位为传统堪舆文化研习参考（不承诺吉凶必应）。',
  parameters: {
    type: 'object',
    properties: {
      facing: { type: 'string', description: '朝向：度数（「172」/「172.5」）或方位词（「坐北朝南」「朝东南」）' },
      quality: { type: 'string', enum: ['A', 'B', 'C'], description: '数据等级（A 现场罗盘 / B 指南针 / C 口头，缺省 C）' },
      year: { type: 'number', description: '流年（缺省当年；1900–2100）' },
      declination: { type: 'number', description: '磁偏角（度；仅 A 级可用）' },
      label: { type: 'string', description: '盘面标题（如「自宅 · 三室两厅」）' },
    },
    required: ['facing'],
  },
  schema: luopanArgs,
  async execute(args: z.infer<typeof luopanArgs>): Promise<ToolResult> {
    try {
      const r = computeLuopan(args)
      return {
        ok: true,
        summary: `排盘完成：坐 ${r.sitting.name}山 向 ${r.facing.name}山（${r.bazhai.houseName} · ${r.bazhai.group}；${r.feixing.year} ${r.feixing.yearName}入中；数据等级 ${r.quality}）`,
        detail: luopanText(r),
      }
    } catch (err) {
      return panError(err)
    }
  },
}

/** M66-A：罗盘排盘工具组（luopan_pan）——纯计算只读，tier=deferred 经 tool_search 激活 */
export function createLuopanTools(): AgentTool[] {
  return [luopanPanTool]
}
