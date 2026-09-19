/**
 * M53 契约：专业排盘卡（`::: pan` 容器）结构不变量与丰富度基线。
 *
 * 与客户端 remark-ext 解析规则同源（pan builder 卡头 / PAN_FIELD_RE 字段行 / takeList
 * 单一列表 / 条目 `键 | 值`）：四张卡在聊天渲染与 chartboard 盘面板两条路径必须完全可解析。
 * 丰富度基线：八字（≥11 字段 + 8 大运 + 10 流年）、紫微（≥6 字段 + 12 宫）、
 * 星盘（3 字段 + 10 行星 + 12 宫头 + 16 相位）、卦（≥8 字段 + 6 爻）。
 */
import { describe, expect, it } from 'vitest'
import { createPanTools } from '../src/tools/pan.js'

/** 与 client remark-ext pan builder 同源 */
const PAN_HEAD_RE = /^([a-zA-Z][\w-]*)\s*(.*)$/
/** 与 client remark-ext PAN_FIELD_RE 同源（键 1-16 字符、首字符字母 / 数字 / 汉字、不含冒号竖线） */
const PAN_FIELD_RE = /^([\p{L}\p{N}][^：:|]{0,15})[：:]\s*(.+)$/u

interface PanCard {
  kind: string
  title: string
  fields: string[]
  items: string[]
}

/** 从 detail 提取全部 `::: pan` 容器（行级状态机） */
function extractCards(detail: string): string[][] {
  const cards: string[][] = []
  let cur: string[] | null = null
  for (const line of detail.split('\n')) {
    if (cur === null) {
      if (line.startsWith('::: pan ')) cur = [line]
      continue
    }
    if (line.trim() === ':::') {
      cards.push(cur)
      cur = null
    } else {
      cur.push(line)
    }
  }
  return cards
}

/** 执行排盘工具并解析唯一盘面卡（顺带校验全部结构不变量） */
async function panCard(toolName: string, args: Record<string, unknown>): Promise<PanCard> {
  const tool = createPanTools().find((t) => t.name === toolName)
  expect(tool, `${toolName} 未注册`).toBeTruthy()
  const res = await tool!.execute(args as never, {} as never)
  expect(res.ok, `${toolName} 执行失败：${res.summary}`).toBe(true)
  const cards = extractCards(res.detail ?? '')
  expect(cards, `${toolName} 应恰好产出一张盘面卡`).toHaveLength(1)
  const lines = cards[0]!
  // 卡头 `::: pan <kind> [标题]`：kind 为四类之一、标题非空（盘面板 tab 依赖）
  const m = PAN_HEAD_RE.exec(lines[0]!.slice('::: pan'.length).trim())
  expect(m, '卡头须为 `::: pan <kind> [标题]`').toBeTruthy()
  const kind = m![1]!.toLowerCase()
  const title = (m![2] ?? '').trim()
  expect(['bazi', 'ziwei', 'natal', 'gua']).toContain(kind)
  expect(title.length, '卡标题非空（盘面板 tab 显示用）').toBeGreaterThan(0)
  const body = lines.slice(1)
  const items = body.filter((l) => l.startsWith('- '))
  const fields = body.filter((l) => !l.startsWith('- '))
  // 单一列表：条目行在卡体内连续（finalizePan 只消费第一个 list）
  const itemIdxs = body.map((l, i) => (l.startsWith('- ') ? i : -1)).filter((i) => i >= 0)
  expect(itemIdxs.length).toBe(items.length)
  for (let i = 1; i < itemIdxs.length; i++) expect(itemIdxs[i]).toBe(itemIdxs[i - 1]! + 1)
  // 字段行全部命中契约（键合法 + 值非空）
  for (const f of fields) expect(f, `字段行不合契约：${f}`).toMatch(PAN_FIELD_RE)
  // 条目行 `- 键 | 值`（首个半角 | 前为键；键与值均非空）
  for (const it of items) expect(it, `条目行不合契约：${it}`).toMatch(/^- .+ \| .+$/)
  return { kind, title, fields, items }
}

/** 字段键列表（取首个冒号前文本） */
const fieldKeys = (card: PanCard): string[] => card.fields.map((f) => f.split(/[：:]/)[0]!.trim())

describe('M53 契约：专业排盘卡（::: pan 容器）', () => {
  it('八字卡：命造 / 四柱 / 十神 / 藏干 / 纳音 / 五行 / 空亡 / 地势 / 胎元 / 命宫 / 起运 + 大运 8 步 / 流年 10 条', async () => {
    const card = await panCard('bazi_pan', {
      birth: '1990-05-12 14:30',
      calendar: 'solar',
      gender: 'male',
      trueSolarTime: false,
    })
    expect(card.kind).toBe('bazi')
    expect(card.title).toBe('四柱 庚午 辛巳 丁丑 丁未')
    const keys = fieldKeys(card)
    for (const k of ['命造', '四柱', '十神', '藏干', '纳音', '五行', '空亡', '地势', '胎元', '命宫', '起运']) {
      expect(keys, `八字卡缺字段「${k}」`).toContain(k)
    }
    expect(card.items.filter((l) => l.startsWith('- 大运 '))).toHaveLength(8)
    expect(card.items.filter((l) => l.startsWith('- 流年 '))).toHaveLength(10)
    // 当前大运 / 当前流年标记（各恰一条）
    expect(card.items.filter((l) => l.includes('· 当前大运'))).toHaveLength(1)
    expect(card.items.filter((l) => l.includes('· 当前'))).toHaveLength(2)
  })

  it('紫微卡：四柱 / 五行局 / 命身宫 / 来因宫 / 生年四化 + 12 宫（长生 / 大限 / 当前大限）', async () => {
    const card = await panCard('ziwei_pan', {
      birth: '1990-05-12 14:30',
      calendar: 'solar',
      gender: 'male',
      trueSolarTime: false,
    })
    expect(card.kind).toBe('ziwei')
    expect(card.title).toContain('紫微 土五局')
    const keys = fieldKeys(card)
    for (const k of ['命造', '四柱', '五行局', '命身宫', '来因宫', '生年四化']) {
      expect(keys, `紫微卡缺字段「${k}」`).toContain(k)
    }
    expect(card.items).toHaveLength(12)
    for (const it of card.items) {
      expect(it).toContain('长生 ')
      expect(it).toContain('大限 ')
    }
    expect(card.items.filter((l) => l.includes('· 当前'))).toHaveLength(1)
    // 命宫条目含主星四化（太阴旺化科）
    const ming = card.items.find((l) => l.startsWith('- 命宫 '))
    expect(ming).toContain('太阴(旺)科')
  })

  it('星盘卡：出生 / 宫制 / 元素模式 + 行星 10 / 宫头 12 / 相位 16 条目', async () => {
    const card = await panCard('natal_pan', {
      birth: '1990-05-12 14:30',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
    })
    expect(card.kind).toBe('natal')
    const keys = fieldKeys(card)
    for (const k of ['出生', '宫制', '元素']) expect(keys, `星盘卡缺字段「${k}」`).toContain(k)
    expect(card.items).toHaveLength(38)
    expect(card.items.filter((l) => l.startsWith('- 宫头 '))).toHaveLength(12)
    const planets = ['太阳', '月亮', '水星', '金星', '火星', '木星', '土星', '天王星', '海王星', '冥王星']
    for (const p of planets) expect(card.items.filter((l) => l.startsWith(`- ${p} |`))).toHaveLength(1)
    // 行星条目含落宫与逆行标记
    expect(card.items).toContain('- 水星 | 金牛 8.8°（38.79°）｜ 8 宫 ｜ 逆行')
  })

  it('卦卡：起卦 / 卦气 / 本卦 / 卦体 / 互卦 / 错卦 / 动爻 / 体用 + 六爻（空亡与变爻标记）', async () => {
    const card = await panCard('gua_pan', {
      method: 'number',
      numbers: [17, 28],
      date: '2026-01-01',
      question: '测试占问',
    })
    expect(card.kind).toBe('gua')
    expect(card.title).toBe('天雷无妄 → 天火同人')
    const keys = fieldKeys(card)
    for (const k of ['起卦', '所问', '卦气', '本卦', '卦体', '互卦', '错卦', '动爻', '体用']) {
      expect(keys, `卦卡缺字段「${k}」`).toContain(k)
    }
    expect(card.items).toHaveLength(6)
    expect(card.items[0]).toContain('上九')
    expect(card.items[5]).toContain('初九')
    // 空亡爻（九五壬申）与动爻变卦（六三 → 己亥 水 父母）
    expect(card.items.some((l) => l.includes('空亡'))).toBe(true)
    expect(card.items.some((l) => l.includes('→'))).toBe(true)
    // 摇卦卡附六爻数（6/7/8/9）
    const coin = await panCard('gua_pan', { method: 'coin', seed: 12345, date: '2026-01-01' })
    expect(fieldKeys(coin)).toContain('六爻数')
  })
})
