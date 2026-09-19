/**
 * 文档体检（交付规格闭环）：Markdown 交付件结构化统计。
 *
 * 单一实现、三端共用：server `write_file` 落盘回灌 / eval 断言（min_chars / min_sections /
 * min_sources）/ client 交付件预览徽章——「写时体检」与「验时断言」口径一致。
 */

export interface DocMetrics {
  /** 非空白字符数（去除所有空白后计数） */
  chars: number
  /** 二级章节数（行首 `## `） */
  sections: number
  /** Markdown 表格数（分隔行 `|---|` 近似计数） */
  tables: number
  /** 来源标记数：URL + 「来源：」标注 + 编号引用（[S1] / [S-01] / [12] / 裸 S01·S-01）合计 */
  sources: number
  /** 占位残留数（「待填」/ TODO / FIXME；真实模型探针实测补入：交付前应清理） */
  placeholders: number
}

/** 结构化统计（纯函数；容错——任意文本均可测） */
export function measureDoc(content: string): DocMetrics {
  // 编号引用两式合计：方括号 [S1]/[S-01]/[12]（含连字符变体）+ 裸编号 S01·S-01
  // （裸式排除方括号内与词内误伤（如 GPT-S4）；连字符格式来自真实模型探针实测）
  const refs =
    (content.match(/\[(?:S-?\d{1,3}|\d{1,3})\]/g) ?? []).length +
    (content.match(/(?<![\w\[-])S-?\d{1,3}\b/g) ?? []).length
  return {
    chars: content.replace(/\s+/g, '').length,
    sections: (content.match(/^##\s/gm) ?? []).length,
    tables: (content.match(/^\|[\s:|-]+\|$/gm) ?? []).length,
    sources:
      (content.match(/https?:\/\/[^\s)\]【】]+/g) ?? []).length +
      (content.match(/来源[：:]/g) ?? []).length +
      refs,
    placeholders: (content.match(/待填|TODO|FIXME/g) ?? []).length,
  }
}
