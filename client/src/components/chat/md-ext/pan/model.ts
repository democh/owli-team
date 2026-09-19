/**
 * M54-A：可玩盘面派生接口（设计 §3.9）——四盘模型类型与 PanModel 联合。
 *
 * 供 derive.ts / 四盘组件 / 单测共用；纯类型，零运行时依赖（不得 import React / DOM）。
 */

export type PanKind = 'bazi' | 'ziwei' | 'natal' | 'gua' | 'transit' | 'synastry' | 'daliuren' | 'qizheng' | 'qimen' | 'luopan' | 'zeri'

/** 行数据（= PanCard.parsePanRows 输出；结构等价、独立声明以保持 pan/ 零反向依赖） */
export interface PanRowData {
  label: string
  value: string
}

// ---- 八字 ----

export interface BaziPillar {
  name: '年' | '月' | '日' | '时'
  gan: string
  zhi: string
  shiShen?: string
}

export interface BaziLuck {
  ganZhi: string
  ages: [number, number]
  years: [number, number]
  current: boolean
}

export interface BaziYear {
  year: number
  ganZhi: string
  age: number
  current: boolean
}

/** 神煞项（M63-A）：`名（起法→命中柱）` */
export interface BaziShenSha {
  name: string
  basis: string
  pillars: string[]
}

/** 柱间关系项（M63-A）：四柱两两 / 三合三会 */
export interface BaziColumnar {
  scope: '天干' | '地支'
  label: string
  pair: string
}

/** 流月（M63-A；卡内条目：`- 流月 甲寅 | 正月`） */
export interface BaziLiuYue {
  ganZhi: string
  month: string
}

export interface BaziModel {
  kind: 'bazi'
  /** 恒 4（年月日时） */
  pillars: [BaziPillar, BaziPillar, BaziPillar, BaziPillar]
  wuxing: Record<'木' | '火' | '土' | '金' | '水', number>
  dayMaster?: { gan: string; yinYang: string }
  jiaoYun?: { date: string; direction: '顺行' | '逆行' }
  /** ≥1（必需门） */
  daYun: BaziLuck[]
  /** 0..N（当前大运内，实测 10 条） */
  liuNian: BaziYear[]
  /** 神煞（可选；M63-A 追加字段） */
  shenSha?: BaziShenSha[]
  /** 柱间关系（可选；四柱两两 + 三合三会；M63-A 追加字段） */
  columnar?: BaziColumnar[]
  /** 运岁作用原文（已格式化；M63-A 追加字段） */
  yunSui?: string
  /** 小运（当前大运内，可选；M63-A 追加字段） */
  xiaoYun?: Array<{ ganZhi: string; age: number }>
  /** 流月条目（liuYueOf 参数触发，可选；M63-A） */
  liuYue?: BaziLiuYue[]
  /** 流月对应流年回显（`流月：2026 丙午`；有流月时必有） */
  liuYueOf?: { year: number; ganZhi: string }
  /** 藏干 / 纳音 / 空亡 / 地势 / 胎元 / 命宫 等原样 */
  detail: PanRowData[]
}

// ---- 紫微 ----

export interface ZiweiStar {
  name: string
  brightness?: string
  mutagen?: '禄' | '权' | '科' | '忌'
}

export interface ZiweiPalace {
  name: string
  gan: string
  zhi: string
  /** 地支序：子 0 … 亥 11（格位一律按此定位，禁止按条目序摆放） */
  zhiIndex: number
  /** 空宫 → [] */
  stars: ZiweiStar[]
  /** 辅星段原文（星名 + 亮度可选，不逐星解析） */
  assist: string
  /** 杂曜段原文（含 `杂 ` 前缀） */
  misc: string
  changSheng?: string
  daXian?: { range: [number, number]; current: boolean }
  shenGong: boolean
  /** 该宫条目 value 原文（详情 / 表格对照用） */
  raw: string
}

export interface ZiweiModel {
  kind: 'ziwei'
  /** 恒 12，按 zhiIndex 升序（子 → 亥） */
  palaces: ZiweiPalace[]
  center: {
    wuXingJu?: string
    mingZhu?: string
    shenZhu?: string
    /** 来因宫原文（如「迁移 庚辰」） */
    laiYin?: string
    siHua: Array<{ mutagen: '禄' | '权' | '科' | '忌'; star: string }>
    /** 流年层（M63-A 追加字段；`流年：2026 丙午 ｜ 流年命宫 … ｜ 流年四化 …`） */
    horoscope?: {
      year: number
      ganZhi: string
      /** 流年命宫落在的本命宫名 */
      soulPalace: string
      /** 流年四化（禄 / 权 / 科 / 忌 → 星名） */
      siHua: Array<{ mutagen: '禄' | '权' | '科' | '忌'; star: string }>
      /** 地支 → 流年宫名（前端由流年命宫逆布派生，恒 12 项；M63-A） */
      palaceOf: Record<string, string>
    }
  }
  /** 命造 / 四柱 原样 */
  detail: PanRowData[]
}

// ---- 星盘 ----

export interface NatalPlanet {
  name: string
  sign: string
  /** 星座内度数（展示精度） */
  deg: number
  /** 黄经（0-360，计算用） */
  lon: number
  house?: number
  retro: boolean
}

export interface NatalAspect {
  a: string
  b: string
  type: '合相' | '六合' | '刑相' | '拱相' | '对分'
  orb: number
}

export interface NatalModel {
  kind: 'natal'
  /** ≥1（必需门） */
  planets: NatalPlanet[]
  /** 12 宫头黄经；null = 精简轮（宫头缺失 / 不足 12） */
  cusps: number[] | null
  /** ASC 黄经（缺 → 未提供，渲染按 0° 白羊置左） */
  asc?: number
  aspects: NatalAspect[]
  /** 出生 / 宫制 / 元素 原样 */
  detail: PanRowData[]
}

// ---- 卦 ----

export interface GuaYao {
  pos: 1 | 2 | 3 | 4 | 5 | 6
  yin: boolean
  shiYing?: '世' | '应'
  dong: boolean
  kong: boolean
  liuShen: string
  liuQin: string
  ganZhi: string
  wuXing: string
  /** 动爻变卦后（label 带 ` 动` 时必有） */
  bian?: { ganZhi: string; wuXing: string; liuQin: string }
  /** 伏神（M63-A 追加；`｜ 伏神 官鬼 辛酉 金`） */
  fuShen?: { liuQin: string; ganZhi: string; wuXing: string }
  /** 月建 / 日辰关系标签（M63-A 追加；月破 / 日破 / 暗动 + 旺衰档） */
  dayRel?: string[]
  /** 回头生克标注（M63-A 追加：回头生 / 回头克 / 回头泄） */
  bianHint?: string
}

export interface GuaModel {
  kind: 'gua'
  /** 本卦名（「本卦」字段第 1 段） */
  ben: string
  /** 变卦名（标题 `→` 右侧；缺失时回退「互卦」字段） */
  bianName?: string
  /** 恒 6，索引 0 = 初爻（渲染时反向） */
  yao: GuaYao[]
  /** 六爻数 6/7/8/9（coin 卡专有） */
  digits?: number[]
  /** 起卦 / 卦气 / 互卦 / 错卦 / 体用 等原样 */
  detail: PanRowData[]
}

// ---- 罗盘（M66-B） ----

/** 八宫条目（星名 + 卦 + 方位；工具输出口径） */
export interface LuopanPalace {
  star: string
  gua: string
  dir: string
}

/** 罗盘盘面模型（`::: pan luopan`）——字段一律取自卡内文本（工具输出），不重算、不预测 */
export interface LuopanModel {
  kind: 'luopan'
  /** 坐（如「壬山」；缺省空串） */
  sitting: string
  /** 向（如「丙山」） */
  facing: string
  /** 周天度数原文（如「345.0° → 165.0°」） */
  degrees: string
  /** 宅卦（如「坎宅」） */
  house: string
  /** 东西四宅（如「东四宅」） */
  group: string
  /** 八宫吉方（伏位 / 生气 / 天医 / 延年） */
  lucky: LuopanPalace[]
  /** 八宫慎用方（绝命 / 五鬼 / 六煞 / 祸害） */
  cautious: LuopanPalace[]
  /** 运盘行（如「九运（2024–2043）中宫 九」） */
  yun: string
  year: string
  yearStar: string
  /** 流年飞布（宫 → 星号；洛书序） */
  fly: { palace: string; star: number }[]
  /** 数据等级（A/B/C） */
  quality: string
  /** 口径 / 精度声明（条目） */
  notes: PanRowData[]
}

// ---- 择日（M66 续完善） ----

/** 择日卡单日条目（`- 2026-09-22（己亥 · 满 · 周二）| 5 | 冲蛇 煞西 | 宜…`） */
export interface ZeriCardDay {
  date: string
  /** 日柱（如「己亥」） */
  ganzhi: string
  /** 建除十二神 */
  jianchu: string
  weekday: string
  /** 1–5（传统宜忌参考） */
  score: number
  /** 冲煞原文（如「冲蛇 煞西」） */
  chongSha: string
  /** 宜忌简注 */
  note: string
}

/** 择日卡模型（`::: pan zeri`）——口径取自卡内文本（工具输出），不重算 */
export interface ZeriModel {
  kind: 'zeri'
  purpose: string
  from: string
  to: string
  /** 口径行（如「建除十二神（节气月建）｜ 评分 1–5」） */
  caliber: string
  days: ZeriCardDay[]
  /** 推荐日期集合（高亮） */
  recommended: string[]
  /** 声明条目 */
  notes: PanRowData[]
}

export type PanModel =
  | BaziModel
  | ZiweiModel
  | NatalModel
  | GuaModel
  | TransitModel
  | SynastryModel
  | DaliurenModel
  | QizhengModel
  | QimenModel
  | LuopanModel
  | ZeriModel

// ---- 行运（M63-B） ----

export interface TransitPlanet {
  name: string
  sign: string
  /** 星座内度数（展示精度） */
  deg: number
  /** 黄经（0-360，计算用） */
  lon: number
  /** 落本命第几宫（可选） */
  house?: number
  retro: boolean
}

export interface TransitAspect {
  transitPlanet: string
  natalPoint: string
  type: string
  orb: number
}

export interface TransitScanHit {
  transitPlanet: string
  natalPoint: string
  type: string
  /** 精确时点（'YYYY-MM-DD HH:mm'） */
  exact: string
  windowDays: number
}

export interface TransitModel {
  kind: 'transit'
  /** ≥1（必需门） */
  planets: TransitPlanet[]
  /** M63 续完善（v2 双环）：本命十星（卡内「本命X | …」行；旧卡无 → undefined → 单环零回归） */
  natalPlanets?: Array<{ name: string; lon: number }>
  aspects: TransitAspect[]
  /** 扫描（无扫描参数 → null） */
  scan: { from: string; to: string; hits: TransitScanHit[] } | null
  /** 本命 / 行运参数原样 */
  detail: PanRowData[]
}

// ---- 合盘（M63-B） ----

export interface SynastryPlanet {
  /** A / B 侧（组合盘为 C） */
  side: 'A' | 'B' | 'C'
  name: string
  sign: string
  deg: number
  lon: number
}

export interface SynastryAspect {
  /** 带侧前缀（如 A金星 / BASC） */
  a: string
  b: string
  type: string
  orb: number
}

export interface SynastryModel {
  kind: 'synastry'
  /** A / B 各 ≥1（必需门） */
  a: SynastryPlanet[]
  b: SynastryPlanet[]
  /** 组合盘中点（mode=composite 时；缺省 []） */
  composite: SynastryPlanet[]
  aspects: SynastryAspect[]
  /** 元素行原文（如「A 火2 土5 风0 水3 ｜ B … ｜ 互补 风」） */
  elementText?: string
  /** 双方出生 / 知情声明 原样 */
  detail: PanRowData[]
}

// ---- 大六壬（M63-C） ----

export interface DaliurenKeRow {
  idx: 1 | 2 | 3 | 4
  label: string
  upper: string
  lower: string
}

export interface DaliurenChuanRow {
  name: string
  zhi: string
  /** 遁干（旬空 → undefined） */
  dunGan?: string
  jiang: string
  kong: boolean
}

export interface DaliurenModel {
  kind: 'daliuren'
  /** 恒 4（必需门） */
  ke: DaliurenKeRow[]
  /** 恒 3（必需门） */
  chuan: DaliurenChuanRow[]
  /** 天地盘：地盘支 → 天盘神（恒 12；必需门） */
  pan: Array<{ di: string; tian: string }>
  /** 天将：天盘神 → 天将（12 项；缺省 {}） */
  jiangOf: Record<string, string>
  /** 课体名（如「涉害课」） */
  keti?: string
  /** 课体说明（括注原文） */
  ketiNote?: string
  /** 月将原文段（如「太冲 卯」） */
  jiangText?: string
  /** 起课 / 贵人 / 口径 原样 */
  detail: PanRowData[]
}

// ---- 七政四余（M63-E） ----

export interface QizhengBodyRow {
  name: string
  /** 落宫支（如「酉」） */
  gong: string
  /** 宫内度数 */
  deg: number
  /** 黄经 */
  lon: number
  retro: boolean
  /** 近似标注（四余） */
  note?: string
}

export interface QizhengPalaceRow {
  name: string
  gong: string
  sign: string
  lord: string
  bodies: string[]
}

export interface QizhengModel {
  kind: 'qizheng'
  /** 七政 7 + 四余 4 = 11（必需门：≥7） */
  bodies: QizhengBodyRow[]
  /** 恒 12（必需门） */
  palaces: QizhengPalaceRow[]
  /** 庙旺行原文 */
  miaoWangText?: string
  detail: PanRowData[]
}

// ---- 奇门遁甲（M63-D） ----

export interface QimenGongRow {
  /** 宫数 1-9 */
  num: number
  /** 宫名（坎 / 坤 / … / 中） */
  name: string
  shen: string
  star: string
  men: string
  tianGan: string
  diGan: string
  kong: boolean
}

export interface QimenModel {
  kind: 'qimen'
  /** 恒 9（必需门：宫数覆盖 1-9） */
  gongs: QimenGongRow[]
  /** 定局行原文（如「阳遁三局 ｜ 立冬 ｜ 上元 ｜ 符头 甲辰（…）」） */
  dingText?: string
  /** 值符值使行原文 */
  zhiFuText?: string
  /** 旬空行原文 */
  kongText?: string
  /** M63 续完善：置闰口径对照行（仅两口径不同时卡内输出） */
  duiZhaoText?: string
  detail: PanRowData[]
}
