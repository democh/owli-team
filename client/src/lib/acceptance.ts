/**
 * M39（§97，ADR 0151）：验收判定派生（DEV-3 验收单数据源）——从本 Run 的 qa 消息文本
 * 派生「判定徽章 + 未决项」：
 * - 判定词优先级：未通过 > 有条件通过 > 通过（取首个命中；无命中 → undefined，不渲染判定）；
 * - 未决项：qa 消息中 `- 未决：…` / `- 待验证：…` / `- 遗留：…` 条目（去重保序，至多 5 条）；
 * - 口径为启发式派生（qa 输出约定：「验收判定：X（N 项未决）。」+ 未决条目）——
 *   缺失即降级为「仅列交付件」（不猜测、不编造）。
 */
import type { ChatMessage } from '@multi-agent/shared'

export type QaVerdict = '未通过' | '有条件通过' | '通过'

export interface AcceptanceInfo {
  verdict: QaVerdict
  /** 未决项条目（最多 5 条） */
  unresolved: string[]
}

/** 判定词优先级（先匹配者胜） */
const VERDICT_ORDER: QaVerdict[] = ['未通过', '有条件通过', '通过']
/** 未决条目行：`- 未决：事项` / `* 待验证：事项` / `- 遗留: 事项` */
const UNRESOLVED_RE = /^[-*]\s*(?:未决|待验证|待决|遗留)\s*[：:]\s*(.+)$/
const MAX_UNRESOLVED = 5

/**
 * 从本 Run 的 qa 消息派生验收信息（无 qa 消息 / 无判定词 → undefined）。
 * @param qaAgentId qa 角色 id（默认 'qa'；跨场景复用时可覆盖）
 */
export function acceptanceOf(
  messages: readonly ChatMessage[],
  runId: string | undefined,
  qaAgentId = 'qa',
): AcceptanceInfo | undefined {
  if (!runId) return undefined
  let verdict: QaVerdict | undefined
  const unresolved: string[] = []
  for (const m of messages) {
    if (m.role !== 'agent' || m.agentId !== qaAgentId || m.runId !== runId) continue
    const lines = m.content.split('\n')
    for (const raw of lines) {
      const line = raw.trim()
      if (verdict === undefined) {
        for (const v of VERDICT_ORDER) {
          if (line.includes(v)) {
            verdict = v
            break
          }
        }
      }
      const hit = UNRESOLVED_RE.exec(line)
      if (hit?.[1]) {
        const text = hit[1].trim()
        if (text !== '' && !unresolved.includes(text) && unresolved.length < MAX_UNRESOLVED) unresolved.push(text)
      }
    }
  }
  if (verdict === undefined) return undefined
  return { verdict, unresolved }
}
