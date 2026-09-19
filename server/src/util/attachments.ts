/**
 * M33：附件工具 —— 上传通道共用的文件名安全化 + 消息附件的文本兜底。
 */
import path from 'node:path'
import type { ChatMessage } from '@multi-agent/shared'

/**
 * 文件名安全化：仅保留中英文 / 单词字符与 `.-`，去前导点防隐藏文件；**保留扩展名**（总长 ≤120）。
 * 截断只作用于主名（stem）：>120 字符的长名不会再把扩展名截掉（否则类型识别 / 预览 / 下载全部失效）。
 */
export function safeFileName(raw: string): string {
  const base = path.basename(raw).replace(/[^\w.\-\u4e00-\u9fa5]/g, '_')
  const ext = path.extname(base)
  const stem = base.slice(0, base.length - ext.length).replace(/^\.+/, '')
  return `${(stem || 'file').slice(0, Math.max(1, 120 - ext.length))}${ext}`
}

/**
 * 纯附件消息（无正文）的文本兜底：「（仅附件：a.png、b.pdf）」。
 * 摘要 / 记忆沉淀 / 脑图等二手消费场景不复用装配器的 [附件] 块，避免纯附件消息被误标为
 * 「无文本，仅工具调用」而丢失信息；无附件返回 undefined（调用方回退原兜底文案）。
 */
export function attachmentOnlyNote(message: ChatMessage): string | undefined {
  const list = message.attachments ?? []
  if (list.length === 0) return undefined
  return `（仅附件：${list.map((a) => a.name).join('、')}）`
}
