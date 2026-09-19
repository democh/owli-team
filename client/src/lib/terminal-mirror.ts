/**
 * 终端输出镜像（M23+）：ANSI 清洗 + 行缓冲纯函数。
 *
 * 直播窗 SSH tab 的只读镜像数据源：terminal-store 在输出字节处旁路一份，
 * 经本模块清洗为可安全渲染的纯文本行（去 CSI/OSC 转义、处理 \r 覆盖、限行截断）。
 * 纯函数无副作用，行缓冲语义可独立单测。
 */

/** 单行最大保留字符数（超长日志行截断，防渲染卡顿） */
export const MIRROR_MAX_LINE_CHARS = 600
/** 镜像滚动缓冲行数上限 */
export const MIRROR_MAX_LINES = 200

/**
 * ANSI 转义序列清洗：
 * - CSI（颜色 / 光标 / 擦除）：`ESC [ 参数 中间 终止`；
 * - OSC（窗口标题 / 超链接）：`ESC ] ... BEL | ST`；
 * - 其余双字符转义（`ESC X`）与退格 / 响铃控制符。
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '') // eslint-disable-line no-control-regex -- ANSI CSI 必须匹配转义字符
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // eslint-disable-line no-control-regex -- OSC
    .replace(/\x1b[@-Z\\-_]/g, '') // eslint-disable-line no-control-regex -- 单字符转义
    .replace(/[\x07\x08]/g, '') // eslint-disable-line no-control-regex -- 响铃 / 退格
}

function clip(line: string): string {
  return line.length > MIRROR_MAX_LINE_CHARS ? `${line.slice(0, MIRROR_MAX_LINE_CHARS)}…` : line
}

/**
 * 追加一段终端输出 → 新行缓冲（返回新数组，长度 ≤ maxLines）。
 *
 * - `\r\n` 归一为 `\n`（跨平台行尾）；
 * - 孤立 `\r`（进度条 / 旋转光标重绘）仅保留覆盖后的末段；
 * - 不以 `\n` 结尾的片段续接到当前最后一行（半行输出不丢）。
 */
export function appendMirrorLines(lines: string[], chunk: string, maxLines: number = MIRROR_MAX_LINES): string[] {
  if (!chunk) return lines
  const text = stripAnsi(chunk).replace(/\r\n/g, '\n')
  const next = lines.length > 0 ? [...lines] : ['']
  const segments = text.split('\n')
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i] ?? ''
    const seg = raw.includes('\r') ? (raw.split('\r').pop() ?? '') : raw
    if (i === 0) {
      next[next.length - 1] = clip((next[next.length - 1] ?? '') + seg)
    } else {
      next.push(clip(seg))
    }
  }
  return next.length > maxLines ? next.slice(next.length - maxLines) : next
}
