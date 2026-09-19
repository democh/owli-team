/**
 * M63-A：盘面深化派生单测（神煞 / 柱间 / 运岁 / 小运 / 流月 / 流年层 / 伏神·月日·回头）。
 *
 * fixture 取真实工具输出（与 mock.ts PAN_DEEP_BLOCKS / GUA_DEEP_BLOCKS / SUI_DEEP_BLOCKS 同源）；
 * 旧卡（无新字段）→ 新字段全 undefined（必需门冻结、零回归）。
 */
import { describe, expect, it } from 'vitest'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import type { BaziModel, GuaModel, PanKind, PanModel, PanRowData, ZiweiModel } from '../src/components/chat/md-ext/pan/model'

interface CardFixture {
  kind: PanKind
  title: string
  fields: PanRowData[]
  items: PanRowData[]
}

function card(text: string): CardFixture {
  const lines = text.trim().split('\n')
  const head = /^::: pan (\w+)(?: (.*))?$/.exec(lines[0]!)
  const fields: PanRowData[] = []
  const items: PanRowData[] = []
  for (const line of lines.slice(1)) {
    if (line.startsWith(':::') || line.trim() === '') continue
    if (line.startsWith('- ')) {
      const body = line.slice(2)
      const i = body.indexOf('|')
      items.push(i < 0 ? { label: body.trim(), value: '' } : { label: body.slice(0, i).trim(), value: body.slice(i + 1).trim() })
    } else {
      const i = line.indexOf('：')
      fields.push({ label: line.slice(0, i).trim(), value: line.slice(i + 1).trim() })
    }
  }
  return { kind: head![1] as PanKind, title: (head![2] ?? '').trim(), fields, items }
}

function derive(fx: CardFixture): PanModel | null {
  return derivePan(fx.kind, fx.title, fx.fields, fx.items)
}

// ---------------------------------------------------------------------------
// fixture：工具实测深度卡（与 mock 深走查同源）
// ---------------------------------------------------------------------------

const BAZI_DEEP = card(`
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
神煞：禄神（日干→年） ｜ 羊刃（日干→时） ｜ 桃花（日支→年） ｜ 华盖（日支→日）
柱间：地支 午丑害（年日）·午未合（年时）·丑未冲（日时）·巳午未三会火方（月年时）
运岁：大运甲申 · 甲庚冲（年）·申巳合（月） ｜ 流年丙午 · 丙辛合（月）
小运：丙子（29岁） ｜ 丁丑（30岁） ｜ 戊寅（31岁）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 壬午 | 9-18 岁 ｜ 1998-2007
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 流年 2026 丙午 | 37 岁 · 当前
:::
`)

const BAZI_DEEP_LIUYUE = card(`
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 流年 2026 丙午 | 37 岁 · 当前
流月：2026 丙午
- 流月 庚寅 | 正月
- 流月 辛卯 | 二月
- 流月 壬辰 | 三月
:::
`)

const ZIWEI_SUI = card(`
::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌
命造：乾造 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八 ｜ 未时（13:00~15:00）
四柱：庚午 辛巳 丁丑 丁未 ｜ 生肖 马 ｜ 星座 金牛座
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
命身宫：命宫 丙戌 ｜ 身宫 福德 戊子
生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同
流年：2026 丙午 ｜ 流年命宫 财帛 ｜ 流年四化 禄 天同 ｜ 权 天机 ｜ 科 文昌 ｜ 忌 廉贞
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 长生 病 ｜ 大限 45-54
- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 长生 死 ｜ 大限 55-64
- 迁移 庚辰 | 太阳(旺)禄 ｜ 长生 墓 ｜ 大限 65-74
- 疾厄 辛巳 | （空宫） ｜ 长生 绝 ｜ 大限 75-84
- 财帛 壬午 | 天机(庙) ｜ 长生 胎 ｜ 大限 85-94
- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 长生 养 ｜ 大限 95-104
- 夫妻 甲申 | （空宫） ｜ 长生 长生 ｜ 大限 105-114
- 兄弟 乙酉 | 天府(旺) ｜ 长生 沐浴 ｜ 大限 115-124
- 命宫 丙戌 | 太阴(旺)科 ｜ 长生 冠带 ｜ 大限 5-14
- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 长生 临官 ｜ 大限 15-24
- 福德 戊子 身宫 | 巨门(旺) ｜ 长生 帝旺 ｜ 大限 25-34
- 田宅 己丑 | 天相(庙) ｜ 长生 衰 ｜ 大限 35-44 · 当前
:::
`)

const GUA_DEEP = card(`
::: pan gua 水火既济 → 水雷屯
起卦：数字起卦（梅花） ｜ 2026-01-01 ｜ 数字 6、3
卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三
本卦：水火既济 ｜ 坎宫水 ｜ 世3应6
互卦：火水未济（上离下坎） ｜ 变卦：水雷屯（上坎下震）
动爻：九三（第 3 爻）
- 上六（应） | 玄武 兄弟 戊子 水 ｜ 月日 旺
- 九五 | 白虎 官鬼 戊戌 土 ｜ 月日 囚
- 六四 | 腾蛇 父母 戊申 金 空亡 ｜ 月日 休
- 九三（世） 动 | 勾陈 兄弟 己亥 水 → 庚辰 土 官鬼 · 回头克 ｜ 伏神 妻财 戊午 火 ｜ 月日 旺
- 六二 | 朱雀 官鬼 己丑 土 ｜ 月日 囚
- 初九 | 青龙 子孙 己卯 木 ｜ 月日 相
:::
`)

// ---------------------------------------------------------------------------
// 八字
// ---------------------------------------------------------------------------

describe('M63-A derive：八字深卡（神煞 / 柱间 / 运岁 / 小运 / 流月）', () => {
  const m = derive(BAZI_DEEP) as BaziModel

  it('① 神煞 / 柱间 / 运岁 / 小运解析（四柱与既有字段不受影响）', () => {
    expect(m.kind).toBe('bazi')
    expect(m.pillars[0]!.gan).toBe('庚')
    expect(m.shenSha).toEqual([
      { name: '禄神', basis: '日干', pillars: ['年'] },
      { name: '羊刃', basis: '日干', pillars: ['时'] },
      { name: '桃花', basis: '日支', pillars: ['年'] },
      { name: '华盖', basis: '日支', pillars: ['日'] },
    ])
    expect(m.columnar).toEqual([
      { scope: '地支', label: '午丑害', pair: '年日' },
      { scope: '地支', label: '午未合', pair: '年时' },
      { scope: '地支', label: '丑未冲', pair: '日时' },
      { scope: '地支', label: '巳午未三会火方', pair: '月年时' },
    ])
    expect(m.yunSui).toContain('大运甲申')
    expect(m.xiaoYun).toHaveLength(3)
    expect(m.xiaoYun![0]).toEqual({ ganZhi: '丙子', age: 29 })
  })

  it('② 流月：liuYueOf 回显 + 条目录入', () => {
    const m2 = derive(BAZI_DEEP_LIUYUE) as BaziModel
    expect(m2.liuYueOf).toEqual({ year: 2026, ganZhi: '丙午' })
    expect(m2.liuYue).toEqual([
      { ganZhi: '庚寅', month: '正月' },
      { ganZhi: '辛卯', month: '二月' },
      { ganZhi: '壬辰', month: '三月' },
    ])
  })

  it('③ 旧卡（无新字段）→ 新字段全 undefined（零回归）', () => {
    const old = derive(
      card(`
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
四柱：庚午 辛巳 丁丑 丁未
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 流年 2026 丙午 | 37 岁 · 当前
:::
`),
    ) as BaziModel
    expect(old.kind).toBe('bazi')
    expect(old.shenSha).toBeUndefined()
    expect(old.columnar).toBeUndefined()
    expect(old.yunSui).toBeUndefined()
    expect(old.xiaoYun).toBeUndefined()
    expect(old.liuYue).toBeUndefined()
    expect(old.liuYueOf).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 紫微
// ---------------------------------------------------------------------------

describe('M63-A derive：紫微流年层', () => {
  const m = derive(ZIWEI_SUI) as ZiweiModel

  it('① 流年解析（干支 / 流年命宫 / 四化）+ palaceOf 逆布 12 项', () => {
    expect(m.kind).toBe('ziwei')
    const h = m.center.horoscope!
    expect(h.year).toBe(2026)
    expect(h.ganZhi).toBe('丙午')
    expect(h.soulPalace).toBe('财帛')
    expect(h.siHua).toEqual([
      { mutagen: '禄', star: '天同' },
      { mutagen: '权', star: '天机' },
      { mutagen: '科', star: '文昌' },
      { mutagen: '忌', star: '廉贞' },
    ])
    // 流年命宫落在本命财帛（午）→ 命宫=午、兄弟=巳、夫妻=辰、父母=未（与 iztro palaceNames 逐字吻合）
    expect(Object.keys(h.palaceOf)).toHaveLength(12)
    expect(h.palaceOf['午']).toBe('命宫')
    expect(h.palaceOf['巳']).toBe('兄弟')
    expect(h.palaceOf['辰']).toBe('夫妻')
    expect(h.palaceOf['未']).toBe('父母')
    expect(h.palaceOf['丑']).toBe('疾厄')
  })

  it('② 旧卡（无流年字段）→ horoscope undefined', () => {
    const old = derive(
      card(`
::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 长生 病 ｜ 大限 45-54
- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 长生 死 ｜ 大限 55-64
- 迁移 庚辰 | 太阳(旺)禄 ｜ 长生 墓 ｜ 大限 65-74
- 疾厄 辛巳 | （空宫） ｜ 长生 绝 ｜ 大限 75-84
- 财帛 壬午 | 天机(庙) ｜ 长生 胎 ｜ 大限 85-94
- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 长生 养 ｜ 大限 95-104
- 夫妻 甲申 | （空宫） ｜ 长生 长生 ｜ 大限 105-114
- 兄弟 乙酉 | 天府(旺) ｜ 长生 沐浴 ｜ 大限 115-124
- 命宫 丙戌 | 太阴(旺)科 ｜ 长生 冠带 ｜ 大限 5-14
- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 长生 临官 ｜ 大限 15-24
- 福德 戊子 身宫 | 巨门(旺) ｜ 长生 帝旺 ｜ 大限 25-34
- 田宅 己丑 | 天相(庙) ｜ 长生 衰 ｜ 大限 35-44 · 当前
:::
`),
    ) as ZiweiModel
    expect(old.kind).toBe('ziwei')
    expect(old.center.horoscope).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 卦
// ---------------------------------------------------------------------------

describe('M63-A derive：卦深卡（伏神 / 月日 / 回头生克）', () => {
  const m = derive(GUA_DEEP) as GuaModel

  it('① 爻行尾注解析：伏神 / 月日 / 回头克', () => {
    expect(m.kind).toBe('gua')
    expect(m.ben).toBe('水火既济')
    expect(m.bianName).toBe('水雷屯')
    const p3 = m.yao.find((y) => y.pos === 3)!
    expect(p3.dong).toBe(true)
    expect(p3.fuShen).toEqual({ liuQin: '妻财', ganZhi: '戊午', wuXing: '火' })
    expect(p3.dayRel).toEqual(['旺'])
    expect(p3.bianHint).toBe('回头克')
    expect(p3.bian).toEqual({ ganZhi: '庚辰', wuXing: '土', liuQin: '官鬼' })
    // 其他爻月日关系
    expect(m.yao.find((y) => y.pos === 1)!.dayRel).toEqual(['相'])
    expect(m.yao.find((y) => y.pos === 2)!.dayRel).toEqual(['囚'])
    expect(m.yao.find((y) => y.pos === 6)!.dayRel).toEqual(['旺'])
  })

  it('② 旧卡（无尾注）→ fuShen / dayRel / bianHint 全 undefined（零回归）', () => {
    const old = derive(
      card(`
::: pan gua 天雷无妄 → 天火同人
本卦：天雷无妄 ｜ 巽宫木 ｜ 世4应1
- 上九 | 玄武 妻财 壬戌 土
- 九五 | 白虎 官鬼 壬申 金 空亡
- 九四（世） | 腾蛇 子孙 壬午 火
- 六三 动 | 勾陈 妻财 庚辰 土 → 己亥 水 父母
- 六二 | 朱雀 兄弟 庚寅 木
- 初九（应） | 青龙 父母 庚子 水
:::
`),
    ) as GuaModel
    expect(old.kind).toBe('gua')
    expect(old.yao.every((y) => y.fuShen === undefined && y.dayRel === undefined && y.bianHint === undefined)).toBe(true)
    expect(old.yao.find((y) => y.pos === 3)!.bian).toEqual({ ganZhi: '己亥', wuXing: '水', liuQin: '父母' })
  })
})
