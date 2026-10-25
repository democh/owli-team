/**
 * 会话开场草稿存储（键 `ma:draft:<sessionId>`，建会话对话框与 Composer 共用）。
 * localStorage 不可用（隐私模式 / 配额耗尽）时退化为内存副本，避免「创建成功但草稿丢失」。
 */
const memory = new Map<string, string>()
/** 仅在 localStorage 实际不可用时才回退内存；键被外部清除时不能复活旧草稿。 */
let storageBroken = false

export function draftKeyOf(sessionId?: string): string | undefined {
  return sessionId ? `ma:draft:${sessionId}` : undefined
}

export function readDraft(key?: string): string {
  if (!key) return ''
  if (!storageBroken) {
    try {
      return localStorage.getItem(key) ?? ''
    } catch {
      storageBroken = true
    }
  }
  // 隐私模式 / 存储被禁用：读内存副本
  return memory.get(key) ?? ''
}

export function writeDraft(key: string | undefined, value: string): void {
  if (!key) return
  if (value) memory.set(key, value)
  else memory.delete(key)
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    // 内存副本已写入，不阻断输入与创建；后续读取固定走内存，避免两处不一致
    storageBroken = true
  }
}
