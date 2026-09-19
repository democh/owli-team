import fs from 'node:fs'
import path from 'node:path'

export class PathEscapeError extends Error {
  constructor() {
    super('路径越界：仅允许操作当前会话工作区内的文件')
    this.name = 'PathEscapeError'
  }
}

/**
 * 将相对路径解析到 root 之内，拒绝目录逃逸与符号链接逃逸（§21.3 沙箱）。
 */
export function resolveInRoot(root: string, relative: string): string {
  const rootReal = fs.realpathSync(path.resolve(root))
  const target = path.resolve(rootReal, relative)

  const inside = (p: string) => p === rootReal || p.startsWith(rootReal + path.sep)
  if (!inside(target)) throw new PathEscapeError()

  // 检查已存在的最近祖先的真实路径（防软链逃逸）
  let probe = target
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  const probeReal = fs.realpathSync(probe)
  if (!inside(probeReal)) throw new PathEscapeError()

  return target
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}

/**
 * 原子写（M5）：临时文件 → 检查中断 → 同目录 rename。
 * 工具被超时/取消中断时不遗留半成品文件（临时文件同目录，rename 原子）。
 */
export function writeFileAtomic(fullPath: string, content: string, signal?: AbortSignal): void {
  const dir = path.dirname(fullPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(fullPath)}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`)
  fs.writeFileSync(tmp, content, 'utf8')
  try {
    if (signal?.aborted) {
      const err = new Error('操作已被中断，未写入任何更改')
      err.name = 'AbortError'
      throw err
    }
    fs.renameSync(tmp, fullPath)
  } catch (err) {
    fs.rmSync(tmp, { force: true })
    throw err
  }
}
