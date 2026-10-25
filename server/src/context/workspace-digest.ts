/**
 * 工作区摘要（M87）：把交付件索引压缩为 2–3 行可行动信息注入系统提示。
 *
 * 与旧的「最多 40 个文件 + 超 20 行折叠为目录计数」不同：
 * - 始终保留最近产出的**文件名**（折叠目录计数会让模型失去锚点，反而触发 list_dir 全量盘点）；
 * - 单独给出「本轮新增/变更」——接手方最需要的是增量，而不是历史全量；
 * - 硬上限 recent 4 条 / 本轮 5 条，路径过长截断，保证 L3 预算稳定。
 */
export interface DigestEntry {
  path: string
  size: number
  version?: number
  /** 交付者展示名（索引只有 id，由装配侧解析） */
  author?: string
}

/** 单条展示上限（文件名过长时中间截断，保留目录语义） */
const PATH_MAX = 64

function sizeText(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function clipPath(value: string): string {
  if (value.length <= PATH_MAX) return value
  const slash = value.lastIndexOf('/')
  const name = slash >= 0 ? value.slice(slash + 1) : value
  return `…/${name.length > 40 ? `${name.slice(0, 37)}…` : name}`
}

function entryText(entry: DigestEntry): string {
  const meta = [sizeText(entry.size)]
  if (entry.author) meta.push(entry.author)
  if (typeof entry.version === 'number' && entry.version > 1) meta.push(`v${entry.version}`)
  return `${clipPath(entry.path)}（${meta.join(' · ')}）`
}

/** 工作区摘要（无交付件 → 空串，不注入区块） */
export function buildWorkspaceDigest(input: {
  total: number
  recent: DigestEntry[]
  currentRun: DigestEntry[]
}): string {
  if (input.total <= 0) return ''
  const lines: string[] = []
  const recent = input.recent.slice(0, 4)
  if (recent.length > 0) {
    lines.push(`- 已有 ${input.total} 个交付件；最近：${recent.map(entryText).join('、')}。`)
  }
  if (input.currentRun.length > 0) {
    const current = input.currentRun.slice(0, 5).map((entry) => {
      const version = typeof entry.version === 'number' && entry.version > 1 ? `v${entry.version}` : '已更新'
      return `${clipPath(entry.path)}（${version}）`
    })
    lines.push(`- 本轮新增/变更：${current.join('、')}${input.currentRun.length > 5 ? ' 等' : ''}。`)
  }
  lines.push('- 读单个文件用 read_file；需要完整目录树时再用 list_dir。')
  return lines.join('\n')
}
