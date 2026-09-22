/**
 * 调度器（§5 / §29）：把波内各成员提议的转交裁决为「实际入手」，并规划下一波。
 *
 * 两个纯函数 + 一个波规划器：
 * - planWave：从队首取本波成员（串行 = 1 位；显式触发 / 场景 parallel 时成波）；
 * - decideHandoff：单成员提议裁决（参与者过滤 / 自续抑制 / 重复剔除）；
 * - mergeWaveSchedule：波次合并（按波内顺序收集 accepted 并去重 → 下一波队列；
 *   交还用户仅当全员交还且无被指名接手 / 被抑制；fallback 每 Run 一次，按编制顺序补齐）。
 *
 * 循环检测基于「波次签名序列」（签名 = 波成员排序拼接，并行波带 +）：
 * - 单人连续 ≥3 波 / 两人交替 ≥4 波（rounds 场景放宽为 ≥6）→ 抑制并交还用户；
 *   交替按「尾部最长交替段」判定——窗口前沿的异类签名（如开场调度官）不再屏蔽后续交替；
 * - 多人周期轮转（三 / 四人 A→B→C→A→B→C 连续两轮）且轮转窗口零写动作 → 抑制并交还
 *   （有写产出的多人迭代协作不误伤；rounds 场景轮流发言即正常形态，不启用）；
 * - 内容级循环（M3/M16）：每波串联文本相邻 3-gram 重复率 > 0.85 连续 4 波 → 强制交还；
 * - 实质进展停滞（M61-D3）：连续两波无任何成功写动作（交付件 / 文件零产出）且文本相似 > 0.9
 *   → 提前抑制（比 4 波内容循环更早、更准：只判「空谈无产出」，有写动作不误伤）。
 */

/**
 * 循环检测：尾部序列形成「同一签名连续 ≥3」或「两人交替 ≥ altThreshold」即判定。
 * 交替段自队尾向前取（最长交替段），不受窗口前沿异类签名污染——
 * 例如 [lead, a, b, a, b] 立即命中，而非等 lead 滑出窗口后才命中。
 */
export function detectLoop(history: string[], window = 6, altThreshold = 4): boolean {
  const recent = history.slice(-window)
  if (recent.length < 3) return false
  // 同一签名连续 ≥3（尾部连续段）
  let sameRun = 1
  for (let i = recent.length - 2; i >= 0; i--) {
    if (recent[i] === recent[i + 1]) sameRun++
    else break
  }
  if (sameRun >= 3) return true
  // 两人交替：尾部最长交替段 ≥ 阈值
  if (recent[recent.length - 1] === recent[recent.length - 2]) return false
  let alt = 2
  for (let i = recent.length - 3; i >= 0; i--) {
    if (recent[i] !== recent[i + 2]) break
    alt++
  }
  return alt >= altThreshold
}

/**
 * 多人周期轮转检测：最近恰好两轮完整周期（p=3 需 6 个 / p=4 需 8 个，如 A,B,C,A,B,C）且相邻不重复，
 * 并要求该窗口内零写动作（waveWriteCounts 与窗口对齐；缺省 / 不足 → 不判定）。
 * 设计：三人以上轮转本身可能是正常迭代协作（轮流打磨同一交付件）——仅「零产出」佐证才判空转；
 * 两人交替不适用本函数（由 detectLoop 直接判定）。
 */
export function detectRotation(history: string[], waveWriteCounts?: number[], maxCycle = 4): boolean {
  for (let p = 3; p <= maxCycle; p++) {
    const need = p * 2
    if (history.length < need) continue
    const recent = history.slice(-need)
    if (new Set(recent).size !== p) continue
    let cyclic = true
    for (let i = 1; i < need; i++) {
      if (recent[i] === recent[i - 1]) {
        cyclic = false
        break
      }
    }
    if (!cyclic) continue
    for (let i = p; i < need; i++) {
      if (recent[i] !== recent[i - p]) {
        cyclic = false
        break
      }
    }
    if (!cyclic) continue
    const writes = waveWriteCounts?.slice(-need)
    if (writes && writes.length === need && writes.every((c) => c === 0)) return true
  }
  return false
}

/** 字符 3-gram 的 Dice 系数（中文按字符切分，无需分词）：1 = 完全相同 */
export function trigramDice(a: string, b: string): number {
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().slice(0, 2000)
  const na = norm(a)
  const nb = norm(b)
  if (na === nb) return 1
  if (na.length < 3 || nb.length < 3) return 0
  const grams = (s: string): Map<string, number> => {
    const map = new Map<string, number>()
    for (let i = 0; i + 3 <= s.length; i++) {
      const g = s.slice(i, i + 3)
      map.set(g, (map.get(g) ?? 0) + 1)
    }
    return map
  }
  const ga = grams(na)
  const gb = grams(nb)
  let intersection = 0
  for (const [g, count] of ga) intersection += Math.min(count, gb.get(g) ?? 0)
  let sumA = 0
  let sumB = 0
  for (const count of ga.values()) sumA += count
  for (const count of gb.values()) sumB += count
  return sumA + sumB === 0 ? 0 : (2 * intersection) / (sumA + sumB)
}

/** 内容级循环检测（M3）：最近 4 波串联文本相邻 3 对相似度均 > threshold → 判定为原地打转 */
export function detectContentLoop(contents: string[], threshold = 0.85): boolean {
  const recent = contents.filter((c) => c.trim().length > 0).slice(-4)
  if (recent.length < 4) return false
  for (let i = 1; i < recent.length; i++) {
    if (trigramDice(recent[i - 1], recent[i]) <= threshold) return false
  }
  return true
}

/**
 * M61-D3：实质进展停滞 —— 同一成员（波签名相同）连续两波「零写动作（无交付件 / 文件产出）」
 * 且文本高度相似（> threshold）→ 判定空谈停滞（比内容级循环 4 波门限更早）。有写动作即视为
 * 有实质进展，不误伤迭代型协作；多人轮转的重复由内容级循环（detectContentLoop，0.85 / 4 波）处理，
 * 本检测只收「同一成员重述」这一强信号。输入不足两波 / 签名不同 / 任一对比波文本为空 → false。
 */
export function detectStall(
  waveTexts: string[],
  waveWriteCounts: number[],
  waveSignatures: string[],
  threshold = 0.9,
): boolean {
  const n = Math.min(waveTexts.length, waveWriteCounts.length, waveSignatures.length)
  if (n < 2) return false
  const last = n - 1
  if (waveWriteCounts[last]! > 0 || waveWriteCounts[last - 1]! > 0) return false
  if (waveSignatures[last] !== waveSignatures[last - 1]) return false
  const a = waveTexts[last - 1]!.trim()
  const b = waveTexts[last]!.trim()
  if (a === '' || b === '') return false
  return trigramDice(a, b) > threshold
}

/** 波次签名：波成员排序拼接（并行波带 +；串行波 = 成员 id 本身） */
export function waveSignature(members: string[]): string {
  return [...members].sort().join('+')
}

// ---------- 波规划（planWave） ----------

export interface WaveGroupMeta {
  id: string
  /** 场景是否默认并行圆桌（_group.yaml parallel） */
  parallel: boolean
  /** 场景并行上限覆盖（_group.yaml parallelMax） */
  parallelMax?: number
}

export interface PlanWaveInput {
  /** 未出手队列（本波从队首取人） */
  queue: string[]
  groupOf: (agentId: string) => WaveGroupMeta | undefined
  /** 全局并行上限（PARALLEL_MAX；=1 关闭并行） */
  globalParallelMax: number
  /** 显式触发并行（用户 @≥2 / handoff 多目标）：不要求同场景，直接取队首 */
  forceParallel: boolean
}

export interface PlannedWave {
  members: string[]
  /** members.length > 1 即并行波 */
  parallel: boolean
}

/**
 * 波规划（§29 触发规则取并集；均不满足 = 串行单成员）：
 * 1. 显式触发（forceParallel）→ 取队首最多 N 位（可跨场景混搭）；
 * 2. 队首所属场景 parallel: true → 取队首连续同场景成员成波；
 * 3. 其余 → 单成员串行。
 */
export function planWave(input: PlanWaveInput): PlannedWave {
  const { queue, groupOf, globalParallelMax } = input
  if (queue.length === 0) return { members: [], parallel: false }
  const capOf = (sceneMax?: number): number => {
    if (globalParallelMax <= 1) return 1 // PARALLEL_MAX=1：关闭并行
    return Math.max(1, sceneMax ?? globalParallelMax)
  }
  if (input.forceParallel) {
    const members = queue.slice(0, capOf(groupOf(queue[0])?.parallelMax))
    return { members, parallel: members.length > 1 }
  }
  const group = groupOf(queue[0])
  if (group?.parallel) {
    const cap = capOf(group.parallelMax)
    const members: string[] = []
    for (const id of queue) {
      if (groupOf(id)?.id !== group.id) break
      members.push(id)
      if (members.length >= cap) break
    }
    return { members, parallel: members.length > 1 }
  }
  return { members: [queue[0]], parallel: false }
}

// ---------- 单成员提议裁决（decideHandoff） ----------

export interface DecideHandoffInput {
  /** 解析出的候选成员（已剔除 'user' token，可能含不在场者） */
  mentions: string[]
  /** 行首 @用户 / handoff user（交还信号） */
  handedToUser: boolean
  participants: string[]
  /** 刚发言者（自续抑制） */
  currentAgentId: string
}

export interface HandoffDecision {
  /** 守卫过滤后实际接手的成员（turn:end.mentions 的真实来源，§6.4） */
  accepted: string[]
  /** 解析出的交还信号（行首 @用户 / handoff user）；与成员接手的优先取舍在合并层裁决（ADR 0094） */
  handedToUser: boolean
  dropped: Array<{ id: string; reason: 'not-in-room' | 'self-continuous' | 'duplicate' }>
}

export function decideHandoff(input: DecideHandoffInput): HandoffDecision {
  const { mentions, handedToUser, participants, currentAgentId } = input
  const seen = new Set<string>()
  const accepted: string[] = []
  const dropped: HandoffDecision['dropped'] = []
  for (const id of mentions) {
    if (!participants.includes(id)) {
      dropped.push({ id, reason: 'not-in-room' })
      continue
    }
    if (id === currentAgentId) {
      dropped.push({ id, reason: 'self-continuous' })
      continue
    }
    if (seen.has(id)) {
      dropped.push({ id, reason: 'duplicate' })
      continue
    }
    seen.add(id)
    accepted.push(id)
  }
  return { accepted, handedToUser, dropped }
}

// ---------- 波次合并（mergeWaveSchedule，fan-in） ----------

export interface MergeWaveInput {
  /** 波内各成员的裁决（按出手顺序） */
  decisions: Array<HandoffDecision & { agentId: string }>
  participants: string[]
  /** 本波开始前的剩余队列（波内成员已出队） */
  queue: string[]
  /** 已完成波次的签名序列（含本波签名） */
  signatures: string[]
  /** 每波串联文本（含本波；内容级循环检测输入） */
  waveTexts: string[]
  /** M61-D3：每波成功写动作计数（含本波；实质进展停滞检测输入；缺省 = 不检测） */
  waveWriteCounts?: number[]
  /** 本 Run 已发言成员（含本波） */
  spoken: string[]
  fallbackUsed: boolean
  /** 场景 rounds：交替阈值放宽 4 → 6 */
  rounds: boolean
}

export interface MergeWaveResult {
  /** 每成员实际接手（turn:end.mentions 数据源；交还用户 = ['user']） */
  acceptedByAgent: Array<{ agentId: string; accepted: string[] }>
  /** 下一波队列 */
  queue: string[]
  handedToUser: boolean
  fallbackUsed: boolean
  loopSuppressed: boolean
  /** M61-D3：停滞抑制（零写动作 + 文本高度相似；与 loopSuppressed 同走抑制路径，分开审计） */
  stallSuppressed: boolean
  /** 任一成员给出多目标 → 下一波并行（fan-out 意图） */
  forceNextParallel: boolean
  dropped: Array<{ id: string; reason: string; by: string }>
}

export function mergeWaveSchedule(input: MergeWaveInput): MergeWaveResult {
  const { decisions, participants, signatures, waveTexts, spoken, rounds } = input
  // 波内按顺序收集 accepted 并去重 → 下一波队列
  // 先收集再判交还：同一条消息可以「先派发成员、再 @用户 报备」（如调度官派发后告知用户稍后汇总），
  // 此时派发必须优先——`@用户` 只是报备，绝不吞掉同条消息的成员接手（M46-2 历史缺陷：单成员波被误判全员交还，派发被静默丢弃）
  const acceptedAll: string[] = []
  for (const d of decisions) {
    for (const id of d.accepted) {
      if (!acceptedAll.includes(id)) acceptedAll.push(id)
    }
  }
  // 每成员实际接手（turn:end.mentions 数据源）：有明确接手成员时以成员为准，仅纯 @用户 才标注 ['user']
  const acceptedByAgent = decisions.map((d) => ({
    agentId: d.agentId,
    accepted: d.accepted.length > 0 ? [...d.accepted] : d.handedToUser ? ['user'] : [],
  }))
  /** 波级交还（全员交还 / 循环抑制 / 兜底无候选）：全员统一标注 ['user']（turn:end 与图谱口径） */
  const handedByAgent = decisions.map((d) => ({ agentId: d.agentId, accepted: ['user'] }))
  const dropped = decisions.flatMap((d) => d.dropped.map((x) => ({ ...x, by: d.agentId })))

  // 全员交还「且本波无任何成员接手」→ 收尾交还用户（部分交还视为不交还：Run 继续消费成员接手）
  const allHanded =
    decisions.length > 0 && decisions.every((d) => d.handedToUser) && acceptedAll.length === 0
  if (allHanded) {
    return {
      acceptedByAgent: handedByAgent,
      queue: [],
      handedToUser: true,
      fallbackUsed: input.fallbackUsed,
      loopSuppressed: false,
      stallSuppressed: false,
      forceNextParallel: false,
      dropped,
    }
  }

  const queue = [...input.queue]
  for (const id of acceptedAll) {
    if (!queue.includes(id)) queue.push(id)
  }

  let handedToUser = false
  let loopSuppressed = false
  let stallSuppressed = false
  // 循环检测：签名序列 + 拟新增接手将形成 A/B 交替或反复 → 抑制并交还
  if (acceptedAll.length > 0) {
    const loopHistory = [...signatures, ...acceptedAll]
    if (detectLoop(loopHistory, 6, rounds ? 6 : 4)) {
      loopSuppressed = true
      handedToUser = true
    } else if (!rounds && detectRotation(loopHistory, input.waveWriteCounts)) {
      // 多人周期轮转：需「轮转窗口零写动作」佐证（有产出的迭代协作不抑制；rounds 场景轮流发言为正常形态）
      loopSuppressed = true
      handedToUser = true
    }
  }
  // 内容级循环：每波串联文本相邻比较（避免同波正常相似被误判）
  if (!handedToUser && detectContentLoop(waveTexts)) {
    loopSuppressed = true
    handedToUser = true
  }
  // M61-D3：实质进展停滞（同签名两波零写动作 + 文本高度相似）——比内容级循环更早的提前抑制
  if (
    !handedToUser &&
    input.waveWriteCounts &&
    detectStall(waveTexts, input.waveWriteCounts, signatures)
  ) {
    stallSuppressed = true
    handedToUser = true
  }

  let fallbackUsed = input.fallbackUsed
  if (!handedToUser && queue.length === 0) {
    // 收尾兜底：全员沉默/弹尽且无接手 → 按编制顺序（participants）找一位未发言者（整 Run 仅一次）
    if (!fallbackUsed) {
      const next = participants.find((id) => !spoken.includes(id))
      if (next) {
        queue.push(next)
        fallbackUsed = true
      } else {
        handedToUser = true
      }
    } else {
      handedToUser = true
    }
  }

  if (handedToUser) {
    return {
      acceptedByAgent: handedByAgent,
      queue: [],
      handedToUser: true,
      fallbackUsed,
      loopSuppressed,
      stallSuppressed,
      forceNextParallel: false,
      dropped,
    }
  }
  // handoff 多目标（≥2 位成员）→ 下一波并行
  const forceNextParallel = decisions.some((d) => d.accepted.length >= 2)
  return {
    acceptedByAgent,
    queue,
    handedToUser: false,
    fallbackUsed,
    loopSuppressed,
    stallSuppressed,
    forceNextParallel,
    dropped,
  }
}
