/**
 * 交付件展示工具（M24）：
 * - 扩展名 → shiki 语言白名单映射（与 lib/shiki.ts 的 resolveLang 协作，白名单外回退 text）；
 * - 文本类判定（决定「源码 / Diff / 复制内容」等工具条能力）；
 * - Office 可预览格式判定（docx/xlsx/pptx 服务端解析；旧格式引导下载）。
 */
import type { ArtifactKind } from '@multi-agent/shared'

export function extOf(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function baseName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

/** 扩展名 → shiki 语言 id / 别名（最终由 lib/shiki.ts 归一与白名单裁剪） */
const FILE_LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonl: 'json',
  jsonc: 'json',
  md: 'markdown',
  markdown: 'markdown',
  py: 'python',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  css: 'css',
  scss: 'scss',
  less: 'css',
  html: 'html',
  htm: 'html',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  conf: 'ini',
  cfg: 'ini',
  properties: 'ini',
  sql: 'sql',
  go: 'go',
  rs: 'rust',
  java: 'java',
  vue: 'vue',
  svelte: 'svelte',
  xml: 'xml',
  xsl: 'xml',
  xslt: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  lua: 'lua',
  dart: 'dart',
  ps1: 'powershell',
  graphql: 'graphql',
  gql: 'graphql',
  mmd: 'text',
  mermaid: 'text',
  csv: 'text',
  tsv: 'text',
}

/** 交付件文件 → shiki 语言（未知扩展回退 text） */
export function langForFile(filePath: string): string {
  const base = baseName(filePath).toLowerCase()
  if (base === 'dockerfile') return 'dockerfile'
  if (base === 'makefile') return 'makefile'
  return FILE_LANG[extOf(filePath)] ?? 'text'
}

/** 文本类交付件（可内联读取 → 源码 / Diff / 复制内容 / 引用可用） */
export function isTextKind(kind: ArtifactKind): boolean {
  return kind === 'markdown' || kind === 'code' || kind === 'html' || kind === 'chart' || kind === 'data'
}

/** 服务端可解析预览的 Office 格式 */
export function isPreviewableOffice(filePath: string): boolean {
  const ext = extOf(filePath)
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx'
}

/** *.chart.json 约定（echarts 配置） */
export function isChartJson(filePath: string): boolean {
  return baseName(filePath).toLowerCase().endsWith('.chart.json')
}

/** 交付件原文 URL（raw=1 供 iframe 原生解析：HTML / PDF） */
export function artifactContentUrl(sessionId: string, path: string, opts?: { download?: boolean; raw?: boolean }): string {
  const params = new URLSearchParams({ path })
  if (opts?.download) params.set('download', '1')
  if (opts?.raw) params.set('raw', '1')
  return `/api/sessions/${sessionId}/artifacts/content?${params.toString()}`
}

/** Office 预览 URL */
export function artifactPreviewUrl(sessionId: string, path: string): string {
  return `/api/sessions/${sessionId}/artifacts/preview?path=${encodeURIComponent(path)}`
}
