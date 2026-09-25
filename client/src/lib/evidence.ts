/**
 * M63（PK · 博弈 · 分析三域批一，设计 §4.3 / §7-U1）：证据等级徽标共用件——
 * 词表注册表 + 语义键 + 中文标签（ClaimTree 论据行 / 来源卡 / 立场依据共用）。
 *
 * 口径（设计 §4.3；M84 增「统计级」）：多命中取最高优先级（统计 > 官方 > 学术 > 权威媒体 > 待核实）；
 * 未命中 → undefined（渲染层保持中性，不增噪）。
 * 「统计级」：证据行含统计口径要素（p= / p< / p值 / CI[ / n= / Bonferroni）时升级——与 quant-evidence 技能的证据行格式对齐。
 * 单一事实源：解析（本文件）与渲染（parts / md-ext）分离，禁止组件内重复词表。
 */
export type EvidenceGrade = 'statistical' | 'official' | 'academic' | 'media' | 'unverified'

/** 词表注册表（优先级从高到低；条目词为包含匹配） */
export const EVIDENCE_GRADES: ReadonlyArray<readonly [grade: EvidenceGrade, words: readonly string[]]> = [
  ['statistical', ['p=', 'p<', 'p>', 'p值', 'CI[', 'n=', 'Bonferroni']],
  ['official', ['官方', '政府', '监管', '统计局', '央行', '交易所', '白皮书']],
  ['academic', ['学术', '论文', '期刊', '文献', '学者']],
  ['media', ['权威媒体', '主流媒体', '通讯社', '媒体', '报道']],
  ['unverified', ['待核实', '未核实', '存疑', '传闻', '网传']],
]

/** 语义键 → 中文标签（徽标展示用） */
export const EVIDENCE_LABEL: Record<EvidenceGrade, string> = {
  statistical: '统计',
  official: '官方',
  academic: '学术',
  media: '媒体',
  unverified: '待核实',
}

/** 证据文本 → 等级（多命中取最高优先级；空串 / 未命中 → undefined） */
export function gradeOf(text: string): EvidenceGrade | undefined {
  const t = text.trim()
  if (t === '') return undefined
  for (const [grade, words] of EVIDENCE_GRADES) {
    if (words.some((w) => t.includes(w))) return grade
  }
  return undefined
}
