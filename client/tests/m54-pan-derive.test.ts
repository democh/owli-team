/**
 * M54-A：四盘派生单测（设计 §3.8 / §3.9）。
 *
 * fixture 一律取设计文档《pan-interactive-design.md》附录 A 实测样本**原文**，
 * 经与本卡 remark 结构化同构的 `card()` 助手拆成 fields / items 后喂入 derivePan。
 * 「旧 fixture」形状（简化旧卡 / 无条目 / 非实测精度）一律断言 null —— 即 §7.2 表格回退路径。
 */
import { describe, expect, it } from 'vitest'
import { tossGua } from '../src/components/chat/md-ext/pan/coin'
import { derivePan } from '../src/components/chat/md-ext/pan/derive'
import { guaNameOf } from '../src/components/chat/md-ext/pan/hex'
import type {
  BaziModel,
  GuaModel,
  NatalModel,
  PanKind,
  PanModel,
  PanRowData,
  ZiweiModel,
} from '../src/components/chat/md-ext/pan/model'

// ---------------------------------------------------------------------------
// fixture 助手：按 md-ext 结构化规则拆分卡原文（字段 `键：值`、条目 `- 键 | 值`）
// ---------------------------------------------------------------------------

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

function baziOf(m: PanModel | null): BaziModel {
  expect(m?.kind).toBe('bazi')
  return m as BaziModel
}

function ziweiOf(m: PanModel | null): ZiweiModel {
  expect(m?.kind).toBe('ziwei')
  return m as ZiweiModel
}

function natalOf(m: PanModel | null): NatalModel {
  expect(m?.kind).toBe('natal')
  return m as NatalModel
}

function guaOf(m: PanModel | null): GuaModel {
  expect(m?.kind).toBe('gua')
  return m as GuaModel
}

// ---------------------------------------------------------------------------
// 附录 A 实测样本（原文；来源 2026-09-19 createPanTools() 实测导出）
// ---------------------------------------------------------------------------

const A1_BAZI = card(`
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
藏干：午(丁己) 巳(丙庚戊) 丑(己癸辛) 未(己丁乙)
纳音：路旁土 ｜ 白蜡金 ｜ 涧下水 ｜ 天河水
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
空亡：年戌亥 月申酉 日申酉 时寅卯
地势：年临官 月帝旺 日墓 时冠带
胎元：壬申（剑锋金） ｜ 胎息：壬子（桑柘木）
命宫：辛巳（白蜡金） ｜ 身宫：己丑（霹雳火）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
- 大运 壬午 | 9-18 岁 ｜ 1998-2007
- 大运 癸未 | 19-28 岁 ｜ 2008-2017
- 大运 甲申 | 29-38 岁 ｜ 2018-2027 · 当前大运
- 大运 乙酉 | 39-48 岁 ｜ 2028-2037
- 大运 丙戌 | 49-58 岁 ｜ 2038-2047
- 大运 丁亥 | 59-68 岁 ｜ 2048-2057
- 大运 戊子 | 69-78 岁 ｜ 2058-2067
- 大运 己丑 | 79-88 岁 ｜ 2068-2077
- 流年 2018 戊戌 | 29 岁
- 流年 2019 己亥 | 30 岁
- 流年 2020 庚子 | 31 岁
- 流年 2021 辛丑 | 32 岁
- 流年 2022 壬寅 | 33 岁
- 流年 2023 癸卯 | 34 岁
- 流年 2024 甲辰 | 35 岁
- 流年 2025 乙巳 | 36 岁
- 流年 2026 丙午 | 37 岁 · 当前
- 流年 2027 丁未 | 38 岁
:::
`)

const A2_ZIWEI = card(`
::: pan ziwei 紫微 土五局 ｜ 命宫 丙戌
命造：乾造 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年四月十八 ｜ 未时（13:00~15:00）
四柱：庚午 辛巳 丁丑 丁未 ｜ 生肖 马 ｜ 星座 金牛座
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
命身宫：命宫 丙戌 ｜ 身宫 福德 戊子
来因宫：迁移 庚辰
生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 杂 八座 天厨 天月 蜚廉 ｜ 长生 病 ｜ 大限 45-54
- 仆役 己卯 | 武曲(利)权 七杀(旺) ｜ 文昌(利) ｜ 杂 天喜 咸池 天贵 天德 天伤 ｜ 长生 死 ｜ 大限 55-64
- 迁移 庚辰 | 太阳(旺)禄 ｜ 地空 ｜ 杂 天姚 凤阁 天才 寡宿 年解 ｜ 长生 墓 ｜ 大限 65-74
- 疾厄 辛巳 | （空宫） ｜ 杂 破碎 天使 ｜ 长生 绝 ｜ 大限 75-84
- 财帛 壬午 | 天机(庙) ｜ 地劫 ｜ 杂 天寿 天福 截路 ｜ 长生 胎 ｜ 大限 85-94
- 子女 癸未 | 紫微(庙) 破军(旺) ｜ 左辅 右弼 天钺 陀罗(庙) ｜ 杂 恩光 天空 空亡 ｜ 长生 养 ｜ 大限 95-104
- 夫妻 甲申 | （空宫） ｜ 禄存 天马 火星(陷) ｜ 杂 孤辰 阴煞 ｜ 长生 长生 ｜ 大限 105-114
- 兄弟 乙酉 | 天府(旺) ｜ 擎羊(陷) ｜ 杂 红鸾 封诰 ｜ 长生 沐浴 ｜ 大限 115-124
- 命宫 丙戌 | 太阴(旺)科 ｜ 铃星(庙) ｜ 杂 解神 龙池 华盖 旬空 ｜ 长生 冠带 ｜ 大限 5-14
- 父母 丁亥 | 廉贞(陷) 贪狼(陷) ｜ 文曲(旺) ｜ 杂 天巫 天官 月德 ｜ 长生 临官 ｜ 大限 15-24
- 福德 戊子 身宫 | 巨门(旺) ｜ 杂 三台 天刑 天哭 天虚 ｜ 长生 帝旺 ｜ 大限 25-34
- 田宅 己丑 | 天相(庙) ｜ 天魁 ｜ 杂 台辅 ｜ 长生 衰 ｜ 大限 35-44 · 当前
:::
`)

const A3_NATAL = card(`
::: pan natal 本命盘 1990-05-12 14:30
出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ UTC 1990-05-12 05:30
宫制：Placidus ｜ 四轴：ASC 处女 16.0° ｜ MC 双子 15.0° ｜ DSC 双鱼 16.0° ｜ IC 射手 15.0°
元素：火2 土5 风0 水3 ｜ 模式：基本5 固定3 变动2
- 太阳 | 金牛 21.2°（51.24°）｜ 9 宫
- 月亮 | 射手 17.6°（257.62°）｜ 4 宫
- 水星 | 金牛 8.8°（38.79°）｜ 8 宫 ｜ 逆行
- 金星 | 白羊 9.1°（9.10°）｜ 7 宫
- 火星 | 双鱼 15.9°（345.90°）｜ 6 宫
- 木星 | 巨蟹 8.9°（98.93°）｜ 10 宫
- 土星 | 摩羯 25.3°（295.30°）｜ 5 宫 ｜ 逆行
- 天王星 | 摩羯 9.3°（279.26°）｜ 4 宫 ｜ 逆行
- 海王星 | 摩羯 14.4°（284.40°）｜ 4 宫 ｜ 逆行
- 冥王星 | 天蝎 16.3°（226.26°）｜ 3 宫 ｜ 逆行
- 宫头 1 | 处女 16.0°
- 宫头 2 | 天秤 12.7°
- 宫头 3 | 天蝎 12.9°
- 宫头 4 | 射手 15.0°
- 宫头 5 | 摩羯 17.1°
- 宫头 6 | 水瓶 17.7°
- 宫头 7 | 双鱼 16.0°
- 宫头 8 | 白羊 12.7°
- 宫头 9 | 金牛 12.9°
- 宫头 10 | 双子 15.0°
- 宫头 11 | 巨蟹 17.1°
- 宫头 12 | 狮子 17.7°
- 太阳-土星 | 拱相 4.1°
- 太阳-冥王星 | 对分 5.0°
- 月亮-火星 | 刑相 1.7°
- 水星-木星 | 六合 0.1°
- 水星-天王星 | 拱相 0.5°
- 水星-海王星 | 拱相 5.6°
- 水星-冥王星 | 对分 7.5°
- 金星-木星 | 刑相 0.2°
- 金星-天王星 | 刑相 0.2°
- 金星-海王星 | 刑相 5.3°
- 火星-海王星 | 六合 1.5°
- 火星-冥王星 | 拱相 0.4°
- 木星-天王星 | 对分 0.3°
- 木星-海王星 | 对分 5.5°
- 天王星-海王星 | 合相 5.1°
- 海王星-冥王星 | 六合 1.9°
:::
`)

const A4_GUA_NUMBER = card(`
::: pan gua 天雷无妄 → 天火同人
起卦：数字起卦（梅花） ｜ 2026-01-01 ｜ 数字 17、28
所问：测试占问
卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三
本卦：天雷无妄 ｜ 巽宫木 ｜ 世4应1
卦体：上卦 乾（天·金） ｜ 下卦 震（雷·木）
互卦：风山渐（上巽下艮） ｜ 变卦：天火同人（上乾下离）
错卦：地风升（六爻全变） ｜ 综卦：山天大畜（六爻颠倒）
动爻：六三（第 3 爻）
体用：体乾（金） ｜ 用震（木） ｜ 体克用 · 我制于彼，事可成但需主动
- 上九 | 玄武 妻财 壬戌 土
- 九五 | 白虎 官鬼 壬申 金 空亡
- 九四（世） | 腾蛇 子孙 壬午 火
- 六三 动 | 勾陈 妻财 庚辰 土 → 己亥 水 父母
- 六二 | 朱雀 兄弟 庚寅 木
- 初九（应） | 青龙 父母 庚子 水
:::
`)

const A5_GUA_COIN = card(`
::: pan gua 水雷屯 → 山雷颐
起卦：摇卦（三枚铜钱） ｜ 2026-01-01 ｜ 种子 12345
卦气：乙巳年 戊子月 乙亥日 丙子时 ｜ 日旬空 申酉 ｜ 二〇二五年冬月十三
本卦：水雷屯 ｜ 坎宫水 ｜ 世2应5
卦体：上卦 坎（水·水） ｜ 下卦 震（雷·木）
互卦：山地剥（上艮下坤） ｜ 变卦：山雷颐（上艮下震）
错卦：火风鼎（六爻全变） ｜ 综卦：山水蒙（六爻颠倒）
动爻：九五（第 5 爻）、上六（第 6 爻）
六爻数：初7 二8 三8 四8 五9 上6
- 上六 动 | 玄武 兄弟 戊子 水 → 丙寅 木 子孙
- 九五（应） 动 | 白虎 官鬼 戊戌 土 → 丙子 水 兄弟
- 六四 | 腾蛇 父母 戊申 金 空亡
- 六三 | 勾陈 官鬼 庚辰 土
- 六二（世） | 朱雀 子孙 庚寅 木
- 初九 | 青龙 兄弟 庚子 水
:::
`)

// ---------------------------------------------------------------------------
// 八字
// ---------------------------------------------------------------------------

describe('derivePan · 八字（§3.8 / A.1）', () => {
  it('实测样本全字段：四柱 / 五行 / 日主 / 起运 / 大运 / 流年', () => {
    const m = baziOf(derive(A1_BAZI))
    expect(m.pillars.map((p) => `${p.gan}${p.zhi}`)).toEqual(['庚午', '辛巳', '丁丑', '丁未'])
    expect(m.pillars.map((p) => p.name)).toEqual(['年', '月', '日', '时'])
    expect(m.pillars.map((p) => p.shiShen)).toEqual(['正财', '偏财', '日主', '比肩'])
    expect(m.wuxing).toEqual({ 木: 0, 火: 4, 土: 2, 金: 2, 水: 0 })
    expect(m.dayMaster).toEqual({ gan: '丁', yinYang: '阴火' })
    expect(m.jiaoYun).toEqual({ date: '1998-08-01', direction: '顺行' })
    expect(m.daYun).toHaveLength(8)
    expect(m.daYun[0]).toEqual({ ganZhi: '壬午', ages: [9, 18], years: [1998, 2007], current: false })
    expect(m.daYun[2]).toEqual({ ganZhi: '甲申', ages: [29, 38], years: [2018, 2027], current: true })
    expect(m.liuNian).toHaveLength(10)
    expect(m.liuNian[8]).toEqual({ year: 2026, ganZhi: '丙午', age: 37, current: true })
    expect(m.liuNian[9]).toEqual({ year: 2027, ganZhi: '丁未', age: 38, current: false })
  })

  it('旧形状（大运 / 流年 为字段、无条目）→ null（回表路径）', () => {
    const fx = card(`
::: pan bazi 四柱 庚午 辛巳 丁丑 丁未
命造：乾造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30
四柱：庚午 辛巳 丁丑 丁未
十神：正财 偏财 日主 比肩
五行：木0 火4 土2 金2 水0 ｜ 日主 丁（阴火）
起运：8 年 2 月 20 日 ｜ 1998-08-01 交运 ｜ 大运顺行
大运：壬午 9-18 岁 ｜ 1998-2007
流年：丙午 37 岁
:::
`)
    expect(derive(fx)).toBeNull()
  })

  it('大运 label 命中而 value 损坏 → 整个派生 null（宁回表）', () => {
    const fx = { ...A1_BAZI, items: A1_BAZI.items.map((it) => (it.label === '大运 癸未' ? { ...it, value: '19—28 岁' } : it)) }
    expect(derive(fx)).toBeNull()
  })

  it('四柱有效词 ≠ 4 → null（`（男）` 尾词忽略、坏词被滤除）', () => {
    const ok = { ...A1_BAZI, fields: A1_BAZI.fields.map((f) => (f.label === '四柱' ? { ...f, value: '庚午 辛巳 丁丑 丁未（男）' } : f)) }
    expect(derive(ok)?.kind).toBe('bazi')
    const bad = { ...A1_BAZI, fields: A1_BAZI.fields.map((f) => (f.label === '四柱' ? { ...f, value: '庚午 辛巳 丁丑 X未' } : f)) }
    expect(derive(bad)).toBeNull()
  })

  it('五行缺键 → null；十神缺失仍可派生（可选项）', () => {
    const bad = { ...A1_BAZI, fields: A1_BAZI.fields.map((f) => (f.label === '五行' ? { ...f, value: '木0 火4 土2 金2 ｜ 日主 丁（阴火）' } : f)) }
    expect(derive(bad)).toBeNull()
    const noShiShen = { ...A1_BAZI, fields: A1_BAZI.fields.filter((f) => f.label !== '十神') }
    const m = baziOf(derive(noShiShen))
    expect(m.pillars.every((p) => p.shiShen === undefined)).toBe(true)
  })

  it('kind 与内容不符（bazi 内容按 natal 解析）→ null', () => {
    expect(derivePan('natal', A1_BAZI.title, A1_BAZI.fields, A1_BAZI.items)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 紫微
// ---------------------------------------------------------------------------

describe('derivePan · 紫微（§3.8 / A.2）', () => {
  it('实测样本：12 宫按地支序排列，格位不按条目序', () => {
    const m = ziweiOf(derive(A2_ZIWEI))
    expect(m.palaces).toHaveLength(12)
    // 条目序自寅宫起；派生必须按 zhiIndex 排序（子 0 → 亥 11）
    expect(m.palaces.map((p) => p.zhiIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect(m.palaces[0]!.name).toBe('福德') // 子位
  })

  it('宫明细：主星（亮度 / 四化）、辅星、杂曜、长生、大限', () => {
    const m = ziweiOf(derive(A2_ZIWEI))
    const ming = m.palaces.find((p) => p.name === '命宫')!
    expect(ming.gan).toBe('丙')
    expect(ming.zhi).toBe('戌')
    expect(ming.stars).toEqual([{ name: '太阴', brightness: '旺', mutagen: '科' }])
    expect(ming.assist).toBe('铃星(庙)')
    expect(ming.misc).toBe('杂 解神 龙池 华盖 旬空')
    expect(ming.changSheng).toBe('冠带')
    expect(ming.daXian).toEqual({ range: [5, 14], current: false })
    expect(ming.shenGong).toBe(false)

    const guan = m.palaces.find((p) => p.name === '官禄')!
    expect(guan.stars).toEqual([
      { name: '天同', brightness: '利', mutagen: '忌' },
      { name: '天梁', brightness: '庙' },
    ])
  })

  it('空宫 → stars 为空且其后仍有辅星段；身宫 / 当前大限标记', () => {
    const m = ziweiOf(derive(A2_ZIWEI))
    const ji = m.palaces.find((p) => p.name === '疾厄')!
    expect(ji.stars).toEqual([])
    expect(ji.assist).toBe('')
    const fu = m.palaces.find((p) => p.name === '夫妻')!
    expect(fu.stars).toEqual([])
    expect(fu.assist).toBe('禄存 天马 火星(陷)')
    expect(m.palaces.find((p) => p.name === '福德')!.shenGong).toBe(true)
    const tian = m.palaces.find((p) => p.name === '田宅')!
    expect(tian.daXian).toEqual({ range: [35, 44], current: true })
    expect(tian.raw).toContain('大限 35-44 · 当前')
  })

  it('中宫：五行局 / 命主 / 身主 / 来因宫 / 生年四化', () => {
    const m = ziweiOf(derive(A2_ZIWEI))
    expect(m.center.wuXingJu).toBe('土五局')
    expect(m.center.mingZhu).toBe('禄存')
    expect(m.center.shenZhu).toBe('火星')
    expect(m.center.laiYin).toBe('迁移 庚辰')
    expect(m.center.siHua).toEqual([
      { mutagen: '禄', star: '太阳' },
      { mutagen: '权', star: '武曲' },
      { mutagen: '科', star: '太阴' },
      { mutagen: '忌', star: '天同' },
    ])
  })

  it('旧形状（宫条目 < 12）→ null', () => {
    const fx = card(`
::: pan ziwei 紫微命盘
命造：乾造 ｜ 公历 1990-05-12 14:30
五行局：土五局 ｜ 命主 禄存 ｜ 身主 火星
来因宫：迁移 庚辰
生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同
- 命宫 丙戌 | 太阴(旺)科 ｜ 杂 解神 龙池 ｜ 长生 冠带 ｜ 大限 5-14
- 官禄 戊寅 | 天同(利)忌 天梁(庙) ｜ 杂 八座 ｜ 长生 病 ｜ 大限 45-54
:::
`)
    expect(derive(fx)).toBeNull()
  })

  it('地支重复 / label 不命中 / 缺大限段 → null', () => {
    const dup = { ...A2_ZIWEI, items: A2_ZIWEI.items.map((it) => (it.label === '兄弟 乙酉' ? { ...it, label: '兄弟 乙戌' } : it)) }
    expect(derive(dup)).toBeNull()
    const badLabel = { ...A2_ZIWEI, items: A2_ZIWEI.items.map((it) => (it.label === '田宅 己丑' ? { ...it, label: '田宅己丑' } : it)) }
    expect(derive(badLabel)).toBeNull()
    const noDaXian = { ...A2_ZIWEI, items: A2_ZIWEI.items.map((it) => (it.label === '田宅 己丑' ? { ...it, value: it.value.replace(' ｜ 大限 35-44 · 当前', '') } : it)) }
    expect(derive(noDaXian)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 星盘
// ---------------------------------------------------------------------------

describe('derivePan · 星盘（§3.8 / A.3）', () => {
  it('实测样本：10 行星 / 12 宫头 / 16 相位 / ASC', () => {
    const m = natalOf(derive(A3_NATAL))
    expect(m.planets).toHaveLength(10)
    expect(m.planets[0]).toEqual({ name: '太阳', sign: '金牛', deg: 21.2, lon: 51.24, house: 9, retro: false })
    expect(m.planets.find((p) => p.name === '水星')).toEqual({ name: '水星', sign: '金牛', deg: 8.8, lon: 38.79, house: 8, retro: true })
    expect(m.planets.find((p) => p.name === '冥王星')!.lon).toBeCloseTo(226.26, 5)
    expect(m.cusps).toHaveLength(12)
    expect(m.cusps![0]).toBeCloseTo(166.0, 5) // 处女 16.0° → 5×30 + 16
    expect(m.cusps![5]).toBeCloseTo(317.7, 5) // 水瓶 17.7° → 10×30 + 17.7
    expect(m.asc).toBeCloseTo(166.0, 5)
    expect(m.aspects).toHaveLength(16)
    expect(m.aspects.find((a) => a.a === '太阳' && a.b === '土星')).toEqual({ a: '太阳', b: '土星', type: '拱相', orb: 4.1 })
  })

  it('宫头缺失 → cusps null（精简轮），行星与相位不受影响', () => {
    const fx = { ...A3_NATAL, items: A3_NATAL.items.filter((it) => !it.label.startsWith('宫头 ')) }
    const m = natalOf(derive(fx))
    expect(m.cusps).toBeNull()
    expect(m.planets).toHaveLength(10)
    expect(m.aspects).toHaveLength(16)
  })

  it('无行星（仅宫头）→ null；行星行损坏 → null', () => {
    const noPlanet = { ...A3_NATAL, items: A3_NATAL.items.filter((it) => it.label.startsWith('宫头 ')) }
    expect(derive(noPlanet)).toBeNull()
    const badPlanet = {
      ...A3_NATAL,
      items: A3_NATAL.items.map((it) => (it.label === '太阳' ? { ...it, value: '金牛 21.2° ｜ 9 宫' } : it)),
    }
    expect(derive(badPlanet)).toBeNull()
  })

  it('旧形状（无括号黄经 / 度分符号）→ null', () => {
    const fx = card(`
::: pan natal 本命盘 1990-05-12 14:30
出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai
宫制：Placidus ｜ ASC 处女 16°34′ ｜ MC 双子 15°00′
元素：火2 土5 风0 水3
- 太阳 | 狮子 12°40′ ｜ 5 宫
- 月亮 | 天蝎 03°22′ ｜ 5 宫 ｜ 逆行
- 上升 | 天秤 08°10′
:::
`)
    expect(derive(fx)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 卦
// ---------------------------------------------------------------------------

describe('derivePan · 卦（§3.8 / A.4 / A.5）', () => {
  it('数字起卦实测：爻题 / 世应 / 动爻变爻 / 空亡 / 卦名', () => {
    const m = guaOf(derive(A4_GUA_NUMBER))
    expect(m.yao).toHaveLength(6)
    expect(m.yao[0]).toMatchObject({ pos: 1, yin: false, shiYing: '应', dong: false, kong: false, liuShen: '青龙', liuQin: '父母', ganZhi: '庚子', wuXing: '水' })
    expect(m.yao[3]).toMatchObject({ pos: 4, yin: false, shiYing: '世', dong: false, liuQin: '子孙' })
    expect(m.yao[4]).toMatchObject({ pos: 5, kong: true })
    expect(m.yao[4]!.shiYing).toBeUndefined()
    expect(m.yao[2]).toMatchObject({ pos: 3, dong: true, bian: { ganZhi: '己亥', wuXing: '水', liuQin: '父母' } })
    expect(m.ben).toBe('天雷无妄')
    expect(m.bianName).toBe('天火同人')
    expect(m.digits).toBeUndefined()
  })

  it('摇卦实测：六爻数 / 多动爻 / 世应', () => {
    const m = guaOf(derive(A5_GUA_COIN))
    expect(m.digits).toEqual([7, 8, 8, 8, 9, 6])
    expect(m.yao.map((y) => y.pos)).toEqual([1, 2, 3, 4, 5, 6])
    expect(m.yao[1]).toMatchObject({ pos: 2, shiYing: '世' })
    expect(m.yao[4]).toMatchObject({ pos: 5, shiYing: '应', dong: true, kong: false, bian: { ganZhi: '丙子', wuXing: '水', liuQin: '兄弟' } })
    expect(m.yao[5]).toMatchObject({ pos: 6, dong: true, bian: { ganZhi: '丙寅', wuXing: '木', liuQin: '子孙' } })
    expect(m.yao[3]).toMatchObject({ pos: 4, kong: true, dong: false })
    expect(m.ben).toBe('水雷屯')
    expect(m.bianName).toBe('山雷颐')
  })

  it('爻条目 ≠ 6 / pos 重复 → null（旧 fixture 回归路径）', () => {
    const five = { ...A4_GUA_NUMBER, items: A4_GUA_NUMBER.items.filter((it) => !it.label.startsWith('上九')) }
    expect(derive(five)).toBeNull()
    const dup = { ...A4_GUA_NUMBER, items: A4_GUA_NUMBER.items.map((it) => (it.label === '六二' ? { ...it, label: '初九' } : it)) }
    expect(derive(dup)).toBeNull()
  })

  it('变卦名缺失 → 回退「互卦」字段', () => {
    const fx = { ...A4_GUA_NUMBER, title: '天雷无妄' }
    const m = guaOf(derive(fx))
    expect(m.ben).toBe('天雷无妄')
    expect(m.bianName).toBe('天火同人')
  })
})

// ---------------------------------------------------------------------------
// 摇卦复现（§3.6）
// ---------------------------------------------------------------------------

describe('coin · 摇卦复现', () => {
  it('已验向量：seed 12345 → 初7 二8 三8 四8 五9 上6（与工具实测逐位一致）', () => {
    const t = tossGua(12345)
    expect(t.digits).toEqual([7, 8, 8, 8, 9, 6])
    expect(t.bits).toBe('100010')
    expect(t.bianBits).toBe('100001')
    expect(t.dongYao).toEqual([5, 6])
    expect(guaNameOf(t.bits)).toBe('水雷屯')
    expect(guaNameOf(t.bianBits)).toBe('山雷颐')
  })

  it('同种子两次调用逐位一致（确定性）', () => {
    const a = tossGua(42)
    const b = tossGua(42)
    expect(a.digits).toEqual(b.digits)
    expect(a.bits).toBe(b.bits)
  })

  it('每爻三枚铜钱（2/3）与和值自洽；和值恒 ∈ 6..9', () => {
    for (const seed of [1, 2, 12345, 987654321]) {
      const t = tossGua(seed)
      expect(t.yao).toHaveLength(6)
      t.yao.forEach((y, i) => {
        expect(y.coins).toHaveLength(3)
        expect(y.coins.every((c) => c === 2 || c === 3)).toBe(true)
        expect(y.sum).toBe(y.coins.reduce((s, c) => s + c, 0))
        expect(y.sum).toBe(t.digits[i])
        expect(y.dong).toBe(y.sum === 6 || y.sum === 9)
        expect(y.yin).toBe(y.sum === 6 || y.sum === 8)
      })
    }
  })
})

// ---------------------------------------------------------------------------
// 六十四卦名
// ---------------------------------------------------------------------------

describe('hex · 六十四卦名', () => {
  it('经典卦名抽查（bits 初→上）', () => {
    expect(guaNameOf('111111')).toBe('乾为天')
    expect(guaNameOf('000000')).toBe('坤为地')
    expect(guaNameOf('100010')).toBe('水雷屯')
    expect(guaNameOf('010001')).toBe('山水蒙')
    expect(guaNameOf('100111')).toBe('天雷无妄')
    expect(guaNameOf('101111')).toBe('天火同人')
    expect(guaNameOf('100001')).toBe('山雷颐')
    expect(guaNameOf('011000')).toBe('地风升')
  })

  it('64 卦全覆盖且无空名', () => {
    for (let i = 0; i < 64; i++) {
      const bits = i.toString(2).padStart(6, '0')
      expect(guaNameOf(bits)).not.toBe('')
    }
  })
})
