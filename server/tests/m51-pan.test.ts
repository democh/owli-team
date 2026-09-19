/**
 * M51-E golden：命理排盘四件套计算层（bazi / ziwei / natal / gua）。
 *
 * 覆盖（design §6.4）：八字 / 紫微 / 星盘各 ≥3 例（公历基准、农历闰月、晚子时、真太阳时校正、
 * 赤道 / 高纬降级、缺参拒绝）；卦用固定种子复现（数字 / 摇卦 / 时间三法）+ 六十四卦表完整性与
 * 京房八宫世应标准盘。纯计算零 IO：不打网络、不触 DB。
 *
 * M53 增强覆盖：旬空 / 地势 / 胎元命宫身宫 / 生肖星座 / 大运流年当前标记（bazi）、四柱 /
 * 来因宫 / 生年四化 / 长生杂曜 / 当前大限（ziwei）、元素模式（natal）、卦气旬空 / 空亡爻 /
 * 错综卦（gua）；卡面契约见 m53-pan-card.test.ts。
 */
import { describe, expect, it } from 'vitest'
import { computeBazi } from '../src/pan/bazi.js'
import { computeGua, HEX_NAMES, HEXAGRAMS } from '../src/pan/gua.js'
import { computeNatal, norm360 } from '../src/pan/natal.js'
import { PanError } from '../src/pan/types.js'
import { computeZiwei, timeToIndex } from '../src/pan/ziwei.js'

const pillarNames = (r: ReturnType<typeof computeBazi>): string[] => [
  r.pillars.year.ganZhi,
  r.pillars.month.ganZhi,
  r.pillars.day.ganZhi,
  r.pillars.hour.ganZhi,
]

// ---------------------------------------------------------------------------
// 四柱八字（≥3 例）
// ---------------------------------------------------------------------------

describe('M51-E golden：四柱八字', () => {
  it('① 公历基准：1990-05-12 14:30 男 → 庚午 辛巳 丁丑 丁未', () => {
    const r = computeBazi({ birth: '1990-05-12 14:30', calendar: 'solar', gender: 'male', trueSolarTime: false })
    expect(pillarNames(r)).toEqual(['庚午', '辛巳', '丁丑', '丁未'])
    expect(r.dayMaster).toBe('丁')
    // 十神（年→时）：庚=丁之正财 / 辛=偏财 / 日主 / 时干丁=比肩
    expect(r.pillars.year.shiShenGan).toBe('正财')
    expect(r.pillars.month.shiShenGan).toBe('偏财')
    expect(r.pillars.day.shiShenGan).toBe('日主')
    expect(r.pillars.hour.shiShenGan).toBe('比肩')
    // 五行统计：8 字全量（fire4 = 午巳丁丁；metal2 = 庚辛；earth2 = 丑未）
    expect(r.wuxing).toEqual({ wood: 0, fire: 4, earth: 2, metal: 2, water: 0 })
    // 藏干与纳音抽样
    expect(r.pillars.day.hideGan.map((h) => h.gan)).toEqual(['己', '癸', '辛'])
    expect(r.pillars.year.naYin).toBe('路旁土')
    // 起运 8 年 2 月 20 日（1998-08-01 交运）；大运自首步壬午起
    expect(r.startLuck).toMatchObject({ years: 8, months: 2, days: 20, date: '1998-08-01' })
    expect(r.daYun[0]).toMatchObject({ ganZhi: '壬午', startAge: 9, endAge: 18, startYear: 1998, endYear: 2007, isCurrent: false })
    expect(r.daYun[1]?.ganZhi).toBe('癸未')
    expect(r.liuNian).toHaveLength(10)
    // M53：旬空 / 地势 / 胎元·胎息·命宫·身宫（含纳音）/ 生肖星座 / 大运顺逆
    expect([r.pillars.year.xunKong, r.pillars.month.xunKong, r.pillars.day.xunKong, r.pillars.hour.xunKong]).toEqual(['戌亥', '申酉', '申酉', '寅卯'])
    expect([r.pillars.year.diShi, r.pillars.month.diShi, r.pillars.day.diShi, r.pillars.hour.diShi]).toEqual(['临官', '帝旺', '墓', '冠带'])
    expect(r.taiYuan).toEqual({ ganZhi: '壬申', naYin: '剑锋金' })
    expect(r.taiXi).toEqual({ ganZhi: '壬子', naYin: '桑柘木' })
    expect(r.mingGong).toEqual({ ganZhi: '辛巳', naYin: '白蜡金' })
    expect(r.shenGong).toEqual({ ganZhi: '己丑', naYin: '霹雳火' })
    expect(r.shengXiao).toBe('马')
    expect(r.xingZuo).toBe('金牛')
    expect(r.forward).toBe(true)
    // 当前大运 / 流年按当前公历年落入（各恰一条，与当前年自洽）
    const nowYear = new Date().getFullYear()
    const curDaYun = r.daYun.find((d) => d.isCurrent)
    expect(curDaYun).toBeTruthy()
    expect(curDaYun!.startYear).toBeLessThanOrEqual(nowYear)
    expect(curDaYun!.endYear).toBeGreaterThanOrEqual(nowYear)
    expect(r.daYun.filter((d) => d.isCurrent)).toHaveLength(1)
    const curLiuNian = r.liuNian.filter((l) => l.isCurrent)
    expect(curLiuNian).toHaveLength(1)
    expect(curLiuNian[0]!.year).toBe(nowYear)
    expect(r.liuNian.every((l) => l.xunKong.length === 2)).toBe(true)
  })

  it('② 农历闰月：2020 闰四月十五 12:00 女 → 庚子 壬午 庚辰 壬午', () => {
    const r = computeBazi({
      birth: '2020-04-15 12:00',
      calendar: 'lunar',
      isLeapMonth: true,
      gender: 'female',
      trueSolarTime: false,
    })
    expect(r.solar).toBe('2020-06-06 12:00:00')
    expect(r.lunar).toBe('二〇二〇年闰四月十五')
    expect(pillarNames(r)).toEqual(['庚子', '壬午', '庚辰', '壬午'])
    expect(r.startLuck.date).toBe('2020-10-06')
    // 闰月号未显式标记时不应命中闰月（同名月十五对应普通四月廿三）
    const normal = computeBazi({
      birth: '2020-04-15 12:00',
      calendar: 'lunar',
      gender: 'female',
      trueSolarTime: false,
    })
    expect(normal.lunar).toBe('二〇二〇年四月十五')
    expect(pillarNames(normal)).not.toEqual(pillarNames(r))
  })

  it('③ 晚子时：2000-01-01 23:30 → 日柱戊午 + 时柱甲子（库默认口径：时柱按次日子时起）', () => {
    const r = computeBazi({ birth: '2000-01-01 23:30', calendar: 'solar', gender: 'male', trueSolarTime: false })
    expect(pillarNames(r)).toEqual(['己卯', '丙子', '戊午', '甲子'])
    expect(r.dayMaster).toBe('戊')
  })

  it('④ 真太阳时：经度 116.4 + Asia/Shanghai → 校正 -11 分钟（14:30 → 14:19，时辰不变）', () => {
    const r = computeBazi({
      birth: '1990-05-12 14:30',
      calendar: 'solar',
      gender: 'male',
      longitude: 116.4,
      timezone: 'Asia/Shanghai',
    })
    expect(r.input.corrected).toBe('1990-05-12 14:19')
    expect(r.input.correction).toBe(-11)
    expect(r.warnings.some((w) => w.includes('真太阳时校正 -11 分钟'))).toBe(true)
    // 校正后仍在未时（13:00-15:00）→ 四柱与基准一致
    expect(pillarNames(r)).toEqual(['庚午', '辛巳', '丁丑', '丁未'])
  })

  it('⑤ 无经度 / 时区：真太阳时跳过并告警（结果按标准时间排盘）', () => {
    const r = computeBazi({ birth: '1990-05-12 14:30', calendar: 'solar', gender: 'male' })
    expect(r.warnings.some((w) => w.includes('真太阳时校正跳过'))).toBe(true)
    expect(r.input.corrected).toBe('1990-05-12 14:30')
    expect(r.input.correction).toBeNull()
  })

  it('⑥ 非法输入 → PanError（结构化错误 + 建议）', () => {
    expect(() => computeBazi({ birth: 'abc', calendar: 'solar', gender: 'male' })).toThrow(PanError)
    try {
      computeBazi({ birth: 'abc', calendar: 'solar', gender: 'male' })
    } catch (err) {
      expect(err).toBeInstanceOf(PanError)
      expect((err as PanError).hint).toContain('YYYY-MM-DD')
    }
    // 闰月号错误：非闰月年却声明闰月
    expect(() =>
      computeBazi({ birth: '2021-04-15 12:00', calendar: 'lunar', isLeapMonth: true, gender: 'male' }),
    ).toThrow(PanError)
  })
})

// ---------------------------------------------------------------------------
// 紫微斗数（≥3 例）
// ---------------------------------------------------------------------------

describe('M51-E golden：紫微斗数', () => {
  it('① 1990-05-12 14:30 男 → 土五局 / 命主禄存 / 命宫丙戌太阴(旺)科', () => {
    const r = computeZiwei({ birth: '1990-05-12 14:30', calendar: 'solar', gender: 'male', trueSolarTime: false })
    expect(r.fiveElementsClass).toBe('土五局')
    expect(r.soul).toBe('禄存')
    expect(r.body).toBe('火星')
    expect(r.timeLabel).toBe('未时')
    expect(r.palaces).toHaveLength(12)
    const soul = r.palaces.find((p) => p.isSoulPalace)
    expect(soul).toBeTruthy()
    expect(soul!.heavenlyStem + soul!.earthlyBranch).toBe('丙戌')
    expect(soul?.majorStars[0]).toMatchObject({ name: '太阴', brightness: '旺', mutagen: '科' })
    expect(soul?.decadalRange).toEqual([5, 14])
    // M53：四柱 / 生肖星座 / 命身宫与来因宫 / 生年四化 / 长生杂曜 / 当前大限
    expect(r.chineseDate).toBe('庚午 辛巳 丁丑 丁未')
    expect(r.zodiac).toBe('马')
    expect(r.sign).toBe('金牛座')
    expect(r.soulPalace).toEqual({ name: '命宫', ganZhi: '丙戌' })
    expect(r.bodyPalace).toEqual({ name: '福德', ganZhi: '戊子' })
    expect(r.laiYinPalace).toEqual({ name: '迁移', ganZhi: '庚辰' })
    expect(r.mutagenStars).toEqual([
      { mutagen: '禄', stars: ['太阳'] },
      { mutagen: '权', stars: ['武曲'] },
      { mutagen: '科', stars: ['太阴'] },
      { mutagen: '忌', stars: ['天同'] },
    ])
    const guanLu = r.palaces.find((p) => p.name === '官禄')!
    expect(guanLu.changSheng).toBe('病')
    expect(guanLu.adjectiveStars).toEqual(['八座', '天厨', '天月', '蜚廉'])
    // 当前大限唯一且与当前虚岁（公历年差 + 1）自洽
    const nominalAge = new Date().getFullYear() - 1990 + 1
    const decadal = r.palaces.filter((p) => p.isCurrentDecadal)
    expect(decadal).toHaveLength(1)
    expect(decadal[0]!.decadalRange[0]).toBeLessThanOrEqual(nominalAge)
    expect(decadal[0]!.decadalRange[1]).toBeGreaterThanOrEqual(nominalAge)
  })

  it('② 1995-08-20 08:00 女 → 金四局 / 命主廉贞 / 命宫庚辰（天机利禄 · 天梁庙权）', () => {
    const r = computeZiwei({ birth: '1995-08-20 08:00', calendar: 'solar', gender: 'female', trueSolarTime: false })
    expect(r.fiveElementsClass).toBe('金四局')
    expect(r.soul).toBe('廉贞')
    expect(r.body).toBe('天机')
    expect(r.timeLabel).toBe('辰时')
    const soul = r.palaces.find((p) => p.isSoulPalace)
    expect(soul).toBeTruthy()
    expect(soul!.heavenlyStem + soul!.earthlyBranch).toBe('庚辰')
    expect(soul?.majorStars.map((s) => `${s.name}${s.brightness}${s.mutagen ?? ''}`)).toEqual(['天机利禄', '天梁庙权'])
    expect(soul?.decadalRange).toEqual([4, 13])
  })

  it('③ 时辰映射：时间 → iztro 时辰序号（含早晚子时边界）', () => {
    expect(timeToIndex(0, 30)).toBe(0) // 早子时
    expect(timeToIndex(1, 0)).toBe(1) // 丑时
    expect(timeToIndex(14, 30)).toBe(7) // 未时
    expect(timeToIndex(22, 59)).toBe(11) // 亥时
    expect(timeToIndex(23, 0)).toBe(12) // 晚子时
    expect(timeToIndex(23, 30)).toBe(12)
  })

  it('④ 排盘失败 → PanError（含建议）', () => {
    expect(() => computeZiwei({ birth: 'bad', calendar: 'solar', gender: 'male' })).toThrow(PanError)
  })
})

// ---------------------------------------------------------------------------
// 西方星盘（≥3 例）
// ---------------------------------------------------------------------------

const angDist = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

describe('M51-E golden：西方星盘', () => {
  it('① 上海 1990-05-12 14:30 → Placidus / ASC 165.96 / 太阳金牛 21.2°', () => {
    const r = computeNatal({ birth: '1990-05-12 14:30', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 121.47 })
    expect(r.houseSystem).toBe('placidus')
    expect(r.warnings).toEqual([])
    expect(r.angles.asc).toBeCloseTo(165.955, 1)
    expect(r.angles.mc).toBeCloseTo(74.984, 1)
    expect(r.angles.dsc).toBeCloseTo(norm360(r.angles.asc + 180), 6)
    // 行星抽样：太阳金牛 / 月亮射手 / 水星逆行
    const sun = r.planets.find((p) => p.name === '太阳')!
    expect(sun.sign).toBe('金牛')
    expect(sun.degInSign).toBeCloseTo(21.24, 1)
    const moon = r.planets.find((p) => p.name === '月亮')!
    expect(moon.sign).toBe('射手')
    const mercury = r.planets.find((p) => p.name === '水星')!
    expect(mercury.retrograde).toBe(true)
    expect(sun.house).toBe(9)
    // 相位矩阵（该盘 16 条；抽样验证越界过滤：太阳-土星拱 4.1°）
    expect(r.aspects).toHaveLength(16)
    const aspect = r.aspects.find((a) => [a.p1, a.p2].sort().join('-') === ['太阳', '土星'].sort().join('-'))
    expect(aspect?.type).toBe('拱相')
    expect(aspect?.orb).toBeCloseTo(4.1, 1)
    // M53：元素 / 模式分布（十大行星按落座计数）
    expect(r.elements).toEqual({ fire: 2, earth: 5, air: 0, water: 3 })
    expect(r.modes).toEqual({ cardinal: 5, fixed: 3, mutable: 2 })
  })

  it('② 赤道（0°,0° UTC）：Placidus 结构自检（宫头递增 + 对宫 180° + 赤经均匀）', () => {
    const r = computeNatal({ birth: '2000-06-15 12:00', timezone: 'UTC', latitude: 0, longitude: 0 })
    expect(r.houseSystem).toBe('placidus')
    expect(r.angles.asc).toBeCloseTo(173.545, 1)
    const c = r.cusps
    // 宫头递增（每段 0-180°）
    for (let i = 0; i < 12; i++) {
      const span = norm360(c[(i + 1) % 12]! - c[i]!)
      expect(span).toBeGreaterThan(0)
      expect(span).toBeLessThan(180)
    }
    // 对宫恰为 180°
    for (let i = 0; i < 6; i++) expect(angDist(c[i + 6]!, c[i]!)).toBeCloseTo(180, 6)
    // 赤道退化：赤经空间每 30°（黄经空间因黄赤交角非均匀）
    const DEG = Math.PI / 180
    const eps = 23.4393
    const lonToRa = (lon: number): number => norm360((Math.atan2(Math.sin(lon * DEG) * Math.cos(eps * DEG), Math.cos(lon * DEG)) * 180) / Math.PI)
    const ras = c.map(lonToRa)
    for (let i = 0; i < 12; i++) {
      expect(norm360(ras[(i + 1) % 12]! - ras[i]!)).toBeCloseTo(30, 2)
    }
  })

  it('③ 高纬 70°N → 降级等宫制 + 告警；显式 equal 亦生效', () => {
    const r = computeNatal({ birth: '2000-06-15 12:00', timezone: 'Europe/Oslo', latitude: 70, longitude: 10.75 })
    expect(r.houseSystem).toBe('equal')
    expect(r.warnings.some((w) => w.includes('降级等宫制'))).toBe(true)
    // 等宫制：宫头每 30°
    for (let i = 0; i < 12; i++) {
      expect(norm360(r.cusps[i]! - r.cusps[0]!)).toBeCloseTo(i * 30, 6)
    }
    const eq = computeNatal({
      birth: '1990-05-12 14:30',
      timezone: 'Asia/Shanghai',
      latitude: 31.23,
      longitude: 121.47,
      houseSystem: 'equal',
    })
    expect(eq.houseSystem).toBe('equal')
  })

  it('④ 缺时区 / 经纬度越界 → PanError（不做缺省猜测）', () => {
    expect(() =>
      computeNatal({ birth: '1990-05-12 14:30', timezone: '', latitude: 31.23, longitude: 121.47 }),
    ).toThrow(PanError)
    expect(() =>
      computeNatal({ birth: '1990-05-12 14:30', timezone: 'Asia/Shanghai', latitude: 100, longitude: 121.47 }),
    ).toThrow(PanError)
    expect(() =>
      computeNatal({ birth: '1990-05-12 14:30', timezone: 'Asia/Shanghai', latitude: 31.23, longitude: 200 }),
    ).toThrow(PanError)
  })
})

// ---------------------------------------------------------------------------
// 六爻 / 梅花起卦（固定种子复现）
// ---------------------------------------------------------------------------

describe('M51-E golden：六爻 / 梅花起卦', () => {
  it('① 数字起卦 [17,28]：天雷无妄 → 天火同人（九三动）+ 互卦风山渐 + 体克用', () => {
    const r = computeGua({ method: 'number', numbers: [17, 28], date: '2026-01-01' })
    expect(r.ben.name).toBe('天雷无妄')
    // 无妄居巽宫四世（巽为风 → 小畜 → 家人 → 益 → 无妄）
    expect(r.ben.palace).toBe('巽')
    expect(r.bian.name).toBe('天火同人')
    expect(r.hu.name).toBe('风山渐')
    expect(r.dongYao).toEqual([3])
    // 无妄三爻为阴（初九 / 六二 / 六三 / 九四 / 九五 / 上九）
    expect(r.dongYaoLabel).toEqual(['六三'])
    // 动爻在下卦 → 上卦（乾金）为体、下卦（震木）为用 → 体克用
    expect(r.tiYong).toMatchObject({ ti: '乾', yong: '震', relation: '体克用' })
    // M53：卦气（起卦四柱 / 日辰旬空 / 农历）/ 错综卦 / 卦体五行 / 空亡爻 / 变爻五行六亲
    expect(r.dayInfo.pillars).toEqual({ year: '乙巳', month: '戊子', day: '乙亥', hour: '丙子' })
    expect(r.dayInfo.xunKong).toBe('申酉')
    expect(r.dayInfo.lunar).toContain('冬月十三')
    expect(r.cuo.name).toBe('地风升')
    expect(r.zong.name).toBe('山天大畜')
    expect([r.ben.upperElement, r.ben.lowerElement]).toEqual(['金', '木'])
    // 旬空申酉 → 仅第 5 爻（壬申）落空
    expect(r.lines.map((l) => l.kongWang)).toEqual([false, false, false, false, true, false])
    // 六三动 → 变爻己亥（水 · 父母）
    expect(r.lines[2]).toMatchObject({ dong: true, ganZhi: '庚辰', bianGanZhi: '己亥', bianWuxing: '水', bianLiuQin: '父母' })
  })

  it('② 摇卦固定种子复现：seed 12345 → 水雷屯（788896 / 九五、上六动）→ 山雷颐', () => {
    const a = computeGua({ method: 'coin', seed: 12345, date: '2026-01-01' })
    const b = computeGua({ method: 'coin', seed: 12345, date: '2026-01-01' })
    expect(a.yaoDigits).toEqual([7, 8, 8, 8, 9, 6])
    expect(a.ben.name).toBe('水雷屯')
    expect(a.bian.name).toBe('山雷颐')
    expect(a.hu.name).toBe('山地剥')
    expect(a.dongYao).toEqual([5, 6])
    expect(a.dongYaoLabel).toEqual(['九五', '上六'])
    // 同种子逐位一致（含六神 / 六亲 / 变爻纳甲）
    expect(JSON.stringify(a.lines)).toBe(JSON.stringify(b.lines))
    // M53：卦气旬空（申酉）→ 四爻戊申落空
    expect(a.dayInfo.xunKong).toBe('申酉')
    expect(a.lines.filter((l) => l.kongWang)).toHaveLength(1)
    expect(a.lines[3]?.kongWang).toBe(true)
    // 不同种子 → 不同结果
    const c = computeGua({ method: 'coin', seed: 999, date: '2026-01-01' })
    expect(JSON.stringify(c.yaoDigits) === JSON.stringify(a.yaoDigits) && c.ben.name === a.ben.name).toBe(false)
  })

  it('③ 时间起卦 2024-06-15 14:30：甲辰年五月初十未时 → 震为雷 → 地雷复（九四）+ 互卦水山蹇', () => {
    const r = computeGua({ method: 'time', date: '2024-06-15 14:30' })
    expect(r.ben.name).toBe('震为雷')
    expect(r.bian.name).toBe('地雷复')
    expect(r.hu.name).toBe('水山蹇')
    expect(r.dongYao).toEqual([4])
    expect(r.dongYaoLabel).toEqual(['九四'])
    expect(r.warnings.some((w) => w.includes('甲辰年五月初十日'))).toBe(true)
    // 单动爻在下卦 → 上卦为体、下卦为用（体用俱震，比和）
    expect(r.tiYong).toMatchObject({ ti: '震', yong: '震', relation: '体用比和' })
    // M53：卦气四柱 / 农历（寅卯旬空 → 六二庚寅落空）
    expect(r.dayInfo.pillars.year).toBe('甲辰')
    expect(r.dayInfo.xunKong).toBe('寅卯')
    expect(r.dayInfo.lunar).toContain('五月初十')
    expect(r.lines[1]?.kongWang).toBe(true)
  })

  it('④ 乾为天完整盘（数字 [1,1] 动九二）：纳甲 / 六亲 / 六神 / 世应 / 变卦', () => {
    const r = computeGua({ method: 'number', numbers: [1, 1], date: '2026-01-01' })
    expect(r.ben.name).toBe('乾为天')
    expect([r.ben.shi, r.ben.ying]).toEqual([6, 3])
    expect(r.bian.name).toBe('天火同人')
    // 初→上：纳甲干支
    expect(r.lines.map((l) => l.ganZhi)).toEqual(['甲子', '甲寅', '甲辰', '壬午', '壬申', '壬戌'])
    // 乾宫属金 → 六亲：子孙 / 妻财 / 父母 / 官鬼 / 兄弟 / 父母
    expect(r.lines.map((l) => l.liuQin)).toEqual(['子孙', '妻财', '父母', '官鬼', '兄弟', '父母'])
    // 六神自初爻起（该日干起青龙）
    expect(r.lines.map((l) => l.liuShen)).toEqual(['青龙', '朱雀', '勾陈', '腾蛇', '白虎', '玄武'])
    // 世应标记与动爻变卦
    expect(r.lines.map((l) => l.shiYing)).toEqual(['', '', '应', '', '', '世'])
    expect(r.lines[1]?.dong).toBe(true)
    expect(r.lines[1]?.bianGanZhi).toBe('己丑')
    expect(r.lines[1]?.bianLiuQin).toBe('父母')
  })

  it('⑤ 六十四卦表：64 项全覆盖 + 京房八宫世应标准盘', () => {
    expect(Object.keys(HEXAGRAMS)).toHaveLength(64)
    expect(Object.keys(HEX_NAMES)).toHaveLength(64)
    for (const bits of Object.keys(HEXAGRAMS)) expect(HEX_NAMES[bits]).toBeTruthy()
    // 标准盘抽查：归魂（世 3 应 6）/ 游魂（世 4 应 1）/ 本宫（世 6 应 3）/ 三世（世 3 应 6）
    const cases: Array<[string, string, number, number]> = [
      ['111101', '火天大有', 3, 6],
      ['010000', '地水师', 3, 6],
      ['000101', '火地晋', 4, 1],
      ['001100', '雷山小过', 4, 1],
      ['010010', '坎为水', 6, 3],
      ['101010', '水火既济', 3, 6],
    ]
    for (const [bits, name, shi, ying] of cases) {
      expect(HEXAGRAMS[bits]).toMatchObject({ name, shi, ying })
    }
  })

  it('⑥ 水火既济标准盘：宫 / 世应 / 纳甲 / 六亲（含互卦火水未济）', () => {
    const r = computeGua({ method: 'number', numbers: [6, 3], date: '2026-01-01' })
    expect(r.ben.name).toBe('水火既济')
    expect(r.ben.palace + r.ben.palaceElement).toBe('坎水')
    expect([r.ben.shi, r.ben.ying]).toEqual([3, 6])
    expect(r.lines.map((l) => l.ganZhi)).toEqual(['己卯', '己丑', '己亥', '戊申', '戊戌', '戊子'])
    expect(r.lines.map((l) => l.liuQin)).toEqual(['子孙', '官鬼', '兄弟', '父母', '官鬼', '兄弟'])
    expect(r.hu.name).toBe('火水未济')
  })

  it('⑦ 缺参 / 未知方式 → PanError（含建议）', () => {
    expect(() => computeGua({ method: 'time' })).toThrow(PanError)
    expect(() => computeGua({ method: 'number' })).toThrow(PanError)
    expect(() => computeGua({ method: 'bad' as never })).toThrow(PanError)
  })
})
