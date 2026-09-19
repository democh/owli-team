/**
 * Python 桥环境净化（M34 §3.2 安全约定）：
 * - 仅白名单透传系统变量（PATH 等必需项），**不透传 API Key / 密钥类变量**；
 * - 强制 UTF-8 IO（PYTHONIOENCODING，避免中文 JSON 输出乱码）；
 * - 固定北京时间（TZ），与 A 股数据口径一致。
 */

/** 透传白名单（解释器启动与编码所需的最小集合） */
const PASSTHROUGH = [
  'PATH',
  'HOME',
  'LANG',
  'TMPDIR',
  'SystemRoot',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
] as const

/** 构造净化后的子进程环境（extra 用于测试/调试注入，生产调用不传） */
export function sanitizedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of PASSTHROUGH) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUNBUFFERED = '1'
  env.TZ = 'Asia/Shanghai'
  for (const [key, value] of Object.entries(extra)) env[key] = value
  return env
}
