/**
 * 全局字体栈单一源（跨平台中文优化，微软雅黑风格就近择优）：
 * - sans：英文 / 数字走系统原生字体（macOS SF、Windows Segoe UI、Linux Roboto），
 *   中文按平台依次命中 —— macOS PingFang SC（苹方）→ Windows Microsoft YaHei（微软雅黑）
 *   → HarmonyOS Sans SC / MiSans（当前流行的免费商用字体，Linux 与华为设备兜底增强）
 *   → Noto Sans CJK SC / 思源黑体 / 文泉驿微米黑（Linux 标准），尾部挂 emoji 回退；
 * - mono：代码 / 终端等宽（SF Mono / Menlo / Consolas → Linux Liberation Mono / DejaVu）；
 * - 本文件为 TS 侧权威源，镜像面必须同步：index.css（:root --font-sans / --font-mono）、
 *   tailwind.config.ts（font-sans / font-mono）、lib/mermaid.ts、lib/chart.ts、lib/terminal-runtime.ts。
 */
export const FONT_SANS =
  'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", ' +
  '"Hiragino Sans GB", "Microsoft YaHei", "HarmonyOS Sans SC", "MiSans", "Noto Sans CJK SC", ' +
  '"Source Han Sans SC", "Noto Sans SC", "WenQuanYi Micro Hei", "Helvetica Neue", Helvetica, Arial, ' +
  'sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"'

export const FONT_MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Cascadia Mono", "JetBrains Mono", ' +
  '"Liberation Mono", "Noto Sans Mono", "DejaVu Sans Mono", monospace'
