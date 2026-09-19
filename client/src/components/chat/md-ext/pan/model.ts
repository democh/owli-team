/**
 * M54-A：可玩盘面派生接口（设计 §3.9）——四盘模型类型与 PanModel 联合。
 *
 * 供 derive.ts / 四盘组件 / 单测共用；纯类型，零运行时依赖（不得 import React / DOM）。
 */

export type PanKind = 'bazi' | 'ziwei' | 'natal' | 'gua'

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

export type PanModel = BaziModel | ZiweiModel | NatalModel | GuaModel
