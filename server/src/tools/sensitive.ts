/**
 * 敏感文件策略（M5）：默认拒绝读写凭据与密钥类文件，防「模型/恶意指令顺手读取 .env 全文」。
 * ALLOW_SENSITIVE=true 时放行（仍建议搭配 M7 审批）。
 */
import path from 'node:path'

/** 相对路径（POSIX 分隔）匹配；与计划口径一致：.env* / .ssh/** / *.pem / .git/config / id_rsa* */
export const SENSITIVE_PATTERNS: Array<{ label: string; test: (rel: string) => boolean }> = [
  { label: '.env*', test: (rel) => /(^|\/)\.env(\.[^/]+)?$/.test(rel) },
  { label: '.ssh/**', test: (rel) => /(^|\/)\.ssh\//.test(rel) || rel.endsWith('/.ssh') },
  { label: '*.pem', test: (rel) => /\.pem$/.test(rel) },
  { label: '.git/config', test: (rel) => /(^|\/)\.git\/config$/.test(rel) },
  { label: 'id_rsa* 等私钥', test: (rel) => /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(rel) },
  { label: '.p12/.pfx/.key', test: (rel) => /\.(p12|pfx|key)$/.test(rel) },
]

/** 归一化为 POSIX 相对路径（防御性：只用于模式匹配，不用于文件系统访问） */
export function normalizeRel(relOrPath: string): string {
  return relOrPath.split(path.sep).join('/').replace(/^\.\//, '')
}

export function matchedSensitivePattern(relPath: string): string | undefined {
  const rel = normalizeRel(relPath)
  const hit = SENSITIVE_PATTERNS.find((p) => p.test(rel))
  return hit?.label
}

/**
 * 敏感访问守卫：返回拒因字符串（调用方作为工具错误摘要），放行返回 undefined。
 * 读写统一拒绝（读泄漏密钥、写污染仓库都不可接受）。
 */
export function sensitiveRejection(
  relPath: string,
  allowSensitive: boolean,
  action: '读取' | '写入' | '修改' | '检索',
): string | undefined {
  if (allowSensitive) return undefined
  const pattern = matchedSensitivePattern(relPath)
  if (!pattern) return undefined
  return `敏感文件已受保护：${action}「${relPath}」被拒绝（命中规则 ${pattern}）。如需访问，请由用户在 .env 中设置 ALLOW_SENSITIVE=true（建议同时保留审批）。`
}

/** 过滤敏感路径列表（list_dir / glob / grep 输出用；allowSensitive 时原样返回） */
export function filterSensitive<T>(items: T[], relOf: (item: T) => string, allowSensitive: boolean): T[] {
  if (allowSensitive) return items
  return items.filter((item) => !matchedSensitivePattern(relOf(item)))
}
