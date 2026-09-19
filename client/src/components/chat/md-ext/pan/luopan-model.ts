/**
 * M66-B：罗盘盘面派生（§10.2）——`::: pan luopan` 卡字段 / 条目 → LuopanModel（纯函数）。
 *
 * 口径：坐向 / 宅卦 / 八宫 / 运盘 / 流年一律取自卡内文本（工具输出），不重算、不预测；
 * 必需门（坐向行）失败 → null（调用方回退静态表格，零回归路径——与四件套同纪律）。
 */
import type { LuopanModel, LuopanPalace, PanRowData } from './model'

/** 全角 / 半角竖线分段（工具与 mock 输出均为全角 ｜；宽容半角） */
const SEG = /[｜|]/

export function deriveLuopan(fields: PanRowData[], items: PanRowData[]): LuopanModel | null {
  const get = (prefix: string): string => fields.find((r) => r.label.startsWith(prefix))?.value ?? ''
  const sitting = get('坐向')
  if (sitting === '') return null

  const sm = /坐\s*([^山\s向｜|]+)山?\s*向\s*([^山\s｜|]+)山?/.exec(sitting)
  const deg = /周天\s*([^｜|]+)/.exec(sitting)?.[1]?.trim() ?? ''

  const houseLine = get('宅卦')
  const hm = /([坎艮震巽离坤兑乾]宅)\s*[（(]([^）)]+)[）)]/.exec(houseLine)

  const yunLine = get('运盘')
  const yearLine = get('流年')
  const ym = /(\d{4})\s*(\S+?)入中/.exec(yearLine)
  const flyRaw = /飞布[：:]\s*(.+)$/.exec(yearLine)?.[1] ?? ''

  return {
    kind: 'luopan',
    sitting: sm?.[1] ? `${sm[1]}山` : '',
    facing: sm?.[2] ? `${sm[2]}山` : '',
    degrees: deg,
    house: hm?.[1] ?? houseLine.split(SEG)[0]?.trim() ?? '',
    group: hm?.[2]?.trim() ?? '',
    lucky: parsePalaces(get('吉方') || get('八宫游年（吉）')),
    cautious: parsePalaces(get('慎用') || get('八宫游年（慎用）')),
    yun: yunLine.split(SEG)[0]?.trim() ?? '',
    year: ym?.[1] ?? '',
    yearStar: ym?.[2] ?? '',
    fly: parseFly(flyRaw),
    quality: get('数据等级').trim(),
    notes: items,
  }
}

/** 「伏位 坎（北） ｜ 天医 震（东） …」→ 八宫条目（不匹配保留原文为 star） */
function parsePalaces(v: string): LuopanPalace[] {
  return v
    .split(SEG)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((seg) => {
      const m = /^(\S+)\s+(\S+?)[（(]([^）)]+)[）)]$/.exec(seg)
      return m ? { star: m[1]!, gua: m[2]!, dir: m[3]! } : { star: seg, gua: '', dir: '' }
    })
}

/** 「中1 乾2 兑3 …」→ 飞布序列（宫 → 星号；按洛书飞布序） */
function parseFly(v: string): { palace: string; star: number }[] {
  const out: { palace: string; star: number }[] = []
  for (const m of v.matchAll(/([中乾兑艮离坎坤震巽])\s*([1-9])/g)) {
    out.push({ palace: m[1]!, star: Number(m[2]) })
  }
  return out
}

/** 坐向度数拆分（「345.0° → 165.0°」→ [坐, 向]；缺省 undefined） */
export function splitDegrees(degrees: string): [number, number] | undefined {
  const m = /([\d.]+)°\s*→\s*([\d.]+)°/.exec(degrees)
  if (!m) return undefined
  const a = Number(m[1])
  const b = Number(m[2])
  return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : undefined
}

/** 星号名（一白 → 九紫；与工具口径一致） */
export const LUOPAN_STAR_NAME: Record<number, string> = {
  1: '一白', 2: '二黑', 3: '三碧', 4: '四绿', 5: '五黄', 6: '六白', 7: '七赤', 8: '八白', 9: '九紫',
}

/** 九星参考语（合规统一口径——与 SKILL / 工具一致，不写「大凶」） */
export const LUOPAN_STAR_NOTE: Record<string, string> = {
  生气: '旺气方（活动 / 主位常参考）',
  天医: '康养方（休息 / 静养常参考）',
  延年: '和睦方（起居 / 会客常参考）',
  伏位: '本宅本宫（参考起点）',
  绝命: '传统观点列为慎用方位（宜作辅助功能）',
  五鬼: '传统观点列为慎用方位（宜作辅助功能）',
  六煞: '传统观点列为慎用方位（宜作辅助功能）',
  祸害: '传统观点列为慎用方位（宜作辅助功能）',
}

/** 九宫格屏幕排布（正北在上：上排 西北/北/东北；罗盘盘面与叠图共用） */
export const LUOPAN_GRID9: { palace: string; dir: string; col: 0 | 1 | 2; row: 0 | 1 | 2 }[] = [
  { palace: '乾', dir: '西北', col: 0, row: 0 },
  { palace: '坎', dir: '北', col: 1, row: 0 },
  { palace: '艮', dir: '东北', col: 2, row: 0 },
  { palace: '兑', dir: '西', col: 0, row: 1 },
  { palace: '中', dir: '中', col: 1, row: 1 },
  { palace: '震', dir: '东', col: 2, row: 1 },
  { palace: '坤', dir: '西南', col: 0, row: 2 },
  { palace: '离', dir: '南', col: 1, row: 2 },
  { palace: '巽', dir: '东南', col: 2, row: 2 },
]
