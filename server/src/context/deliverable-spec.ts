/**
 * 交付规格解析（报告专业化 M-交付规格闭环）：从用户消息识别档位声明，注入回合指令。
 *
 * 语义：会话级粘性——取最近一条含规格声明的用户消息，其声明生效至被新声明覆盖；
 * 未声明时不注入（按角色交付契约默认档执行）。关键词表保持收敛，避免「深入」
 * 等宽词误伤日常表述。
 */

export type DeliverableTier = 'brief' | 'deep'

/** 速览档关键词（同一消息命中 brief 即按 brief 判定，防膨胀优先） */
const BRIEF_WORDS = ['速览', '简报', '快评', '简要报告', '一页纸', '要点简报']
/** 深度档关键词（显式长报告意图；「深度档」为协议标准术语，真实模型探针实测补入） */
const DEEP_WORDS = [
  '深度档',
  '深度报告',
  '详细报告',
  '详尽报告',
  '完整报告',
  '深度研究',
  '深度调研',
  '全面报告',
  '尽量详细',
  '越详细越好',
]

/** 解析档位声明：userTexts 按时间序（旧 → 新），取最近一条命中消息的档位（无声明 → undefined） */
export function parseDeliverableSpec(userTexts: string[]): DeliverableTier | undefined {
  for (let i = userTexts.length - 1; i >= 0; i--) {
    const text = userTexts[i]
    if (!text) continue
    if (BRIEF_WORDS.some((w) => text.includes(w))) return 'brief'
    if (DEEP_WORDS.some((w) => text.includes(w))) return 'deep'
  }
  return undefined
}

/** 回合指令注入行（execute 范式；未声明返回空串） */
export function buildSpecInstructionLine(tier: DeliverableTier | undefined): string {
  if (tier === 'brief') {
    return '- 本任务交付规格：速览档——报告类交付件 ≤800 字，结论、依据、下一步齐全，仍须可独立成立（详见 <deliverable_spec>）。'
  }
  if (tier === 'deep') {
    return '- 本任务交付规格：深度档——报告类交付件 ≥4000 字，先落骨架再逐节填充（write_file 骨架 + edit_file 或 write_file mode=append 追加），禁止单次成文；结论挂来源编号、附反面证据与数据口径（详见 <deliverable_spec>）。'
  }
  return ''
}
