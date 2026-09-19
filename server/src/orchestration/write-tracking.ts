/**
 * 写目标跟踪（M61 调度增强）：
 * - 从写类工具调用参数提取目标路径（write_file / edit_file / apply_patch）；
 * - apply_patch 无 path 参数：从补丁头（`--- a/x` / `+++ b/x`）逐条提取，两侧去重；
 * - 仅供波级「实质进展检测（D3）」与「并行写冲突防护（D5）」使用——不参与工具执行，
 *   提取失败一律静默返回空集（跟踪失败绝不打断主流程）。
 */

/** 参与跟踪的写类工具（文件系统三件套；画布 / 媒体等非工作区文件面不在跟踪范围） */
export const WRITE_TOOLS: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'apply_patch'])

/** 归一化路径：去 ./ 前缀与首尾空白 */
function norm(raw: string): string {
  return raw.trim().replace(/^\.\//, '')
}

/** 从 unified diff 文本提取涉及的文件路径（`---` / `+++` 头；/dev/null 剔除；a/ b/ 前缀剥离） */
export function patchPaths(patch: string): string[] {
  const out: string[] = []
  for (const line of patch.split('\n')) {
    const m = /^(?:---|\+\+\+)\s+(\S+)/.exec(line)
    if (!m) continue
    let raw = m[1]!
    if (raw === '/dev/null') continue
    raw = raw.replace(/^[ab]\//, '')
    const p = norm(raw)
    if (p !== '' && !out.includes(p)) out.push(p)
  }
  return out
}

/** 写类工具调用 → 目标路径集合（非写工具 / 参数缺失 / patch 无法解析 → 空数组） */
export function extractWritePaths(toolName: string, args: Record<string, unknown>): string[] {
  if (!WRITE_TOOLS.has(toolName)) return []
  if (toolName === 'apply_patch') {
    const patch = typeof args.patch === 'string' ? args.patch : ''
    return patch === '' ? [] : patchPaths(patch)
  }
  const p = typeof args.path === 'string' ? norm(args.path) : ''
  return p === '' ? [] : [p]
}

/** 波内写跟踪缓冲（成员 → 目标路径集合；count = 成功写动作数） */
export interface WaveWriteBuffer {
  count: number
  byAgent: Map<string, Set<string>>
}

export function newWaveWriteBuffer(): WaveWriteBuffer {
  return { count: 0, byAgent: new Map() }
}

/** 记录一次成功的写动作（原地更新缓冲；同成员同路径去重，count 按动作计） */
export function recordWrite(buffer: WaveWriteBuffer, agentId: string, paths: string[]): void {
  if (paths.length === 0) return
  buffer.count += 1
  let set = buffer.byAgent.get(agentId)
  if (!set) {
    set = new Set<string>()
    buffer.byAgent.set(agentId, set)
  }
  for (const p of paths) set.add(p)
}

/** 波内两两路径重叠检测（仅 ≥2 个成员有写动作时产出；按成员序输出稳定） */
export function detectWriteConflicts(
  byAgent: Map<string, Set<string>>,
): Array<{ a: string; b: string; paths: string[] }> {
  const entries = [...byAgent.entries()].filter(([, set]) => set.size > 0)
  const pairs: Array<{ a: string; b: string; paths: string[] }> = []
  for (let i = 0; i < entries.length; i++) {
    const [a, setA] = entries[i]!
    for (let j = i + 1; j < entries.length; j++) {
      const [b, setB] = entries[j]!
      const overlap = [...setA].filter((p) => setB.has(p))
      if (overlap.length > 0) pairs.push({ a, b, paths: overlap })
    }
  }
  return pairs
}
