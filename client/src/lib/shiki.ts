/**
 * Shiki 单例（M8）：highlighter 只创建一次，语言按「白名单」动态加载（M13 瘦身）。
 * 调用方只在「完成态」内容上触发（流式期间用纯文本，避免重复高亮与抖动）。
 * 仅浅色主题（github-light，M11 起移除深色）。
 *
 * M13 瘦身：从 `shiki` 全量入口（bundledLanguages → 每个语言一个构建 chunk，共 276 个产物文件）
 * 切换到 fine-grained bundle（shiki/core + oniguruma engine + 主题/语言子路径 import），
 * 构建产物仅含白名单语言；白名单外的语言直接回退 text（仍可复制，只是无着色）。
 * 新增常用语言：在下方 LANG_LOADERS 增加一行 `id: () => import('shiki/langs/<id>.mjs')` 即可。
 */
import type { HighlighterCore, LanguageInput, ShikiTransformer } from 'shiki/core'

/** 生效的 shiki 主题（同时作为高亮缓存 key 的前缀） */
export const SHIKI_THEME = 'github-light'

/** 首屏预载（首次高亮无需等待语言 chunk） */
const PRELOAD_LANGS = ['typescript', 'tsx', 'javascript', 'json', 'bash', 'markdown', 'python'] as const

/** 白名单：shiki 规范 id → 懒加载器（每个语言独立 chunk，仅在首次用到时拉取） */
const LANG_LOADERS: Record<string, () => Promise<LanguageInput>> = {
  // 预载组
  typescript: () => import('shiki/langs/typescript.mjs').then((m) => m.default),
  tsx: () => import('shiki/langs/tsx.mjs').then((m) => m.default),
  javascript: () => import('shiki/langs/javascript.mjs').then((m) => m.default),
  json: () => import('shiki/langs/json.mjs').then((m) => m.default),
  bash: () => import('shiki/langs/bash.mjs').then((m) => m.default),
  markdown: () => import('shiki/langs/markdown.mjs').then((m) => m.default),
  python: () => import('shiki/langs/python.mjs').then((m) => m.default),
  // 前端
  jsx: () => import('shiki/langs/jsx.mjs').then((m) => m.default),
  html: () => import('shiki/langs/html.mjs').then((m) => m.default),
  css: () => import('shiki/langs/css.mjs').then((m) => m.default),
  scss: () => import('shiki/langs/scss.mjs').then((m) => m.default),
  vue: () => import('shiki/langs/vue.mjs').then((m) => m.default),
  svelte: () => import('shiki/langs/svelte.mjs').then((m) => m.default),
  // 配置 / 文本
  yaml: () => import('shiki/langs/yaml.mjs').then((m) => m.default),
  toml: () => import('shiki/langs/toml.mjs').then((m) => m.default),
  ini: () => import('shiki/langs/ini.mjs').then((m) => m.default),
  diff: () => import('shiki/langs/diff.mjs').then((m) => m.default),
  sql: () => import('shiki/langs/sql.mjs').then((m) => m.default),
  xml: () => import('shiki/langs/xml.mjs').then((m) => m.default),
  graphql: () => import('shiki/langs/graphql.mjs').then((m) => m.default),
  makefile: () => import('shiki/langs/makefile.mjs').then((m) => m.default),
  // 后端 / 系统
  go: () => import('shiki/langs/go.mjs').then((m) => m.default),
  rust: () => import('shiki/langs/rust.mjs').then((m) => m.default),
  java: () => import('shiki/langs/java.mjs').then((m) => m.default),
  c: () => import('shiki/langs/c.mjs').then((m) => m.default),
  cpp: () => import('shiki/langs/cpp.mjs').then((m) => m.default),
  csharp: () => import('shiki/langs/csharp.mjs').then((m) => m.default),
  php: () => import('shiki/langs/php.mjs').then((m) => m.default),
  ruby: () => import('shiki/langs/ruby.mjs').then((m) => m.default),
  kotlin: () => import('shiki/langs/kotlin.mjs').then((m) => m.default),
  swift: () => import('shiki/langs/swift.mjs').then((m) => m.default),
  lua: () => import('shiki/langs/lua.mjs').then((m) => m.default),
  dart: () => import('shiki/langs/dart.mjs').then((m) => m.default),
  dockerfile: () => import('shiki/langs/dockerfile.mjs').then((m) => m.default),
  powershell: () => import('shiki/langs/powershell.mjs').then((m) => m.default),
}

/** 代码块常见标注 → 白名单 id（别名归一） */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  sh: 'bash',
  zsh: 'bash',
  shell: 'bash',
  console: 'bash',
  shellsession: 'bash',
  'shell-session': 'bash',
  md: 'markdown',
  yml: 'yaml',
  jsonc: 'json',
  json5: 'json',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  'c++': 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  h: 'c',
  'c#': 'csharp',
  cs: 'csharp',
  kt: 'kotlin',
  kts: 'kotlin',
  docker: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  ps: 'powershell',
  ps1: 'powershell',
  gql: 'graphql',
  svg: 'xml',
  xhtml: 'html',
}

function resolveLang(raw: string): string | undefined {
  const normalized = raw.trim().toLowerCase()
  const id = LANG_ALIASES[normalized] ?? normalized
  return id in LANG_LOADERS ? id : undefined
}

let highlighterPromise: Promise<HighlighterCore> | undefined

function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createOnigurumaEngine }, theme] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/oniguruma'),
        import('shiki/themes/github-light.mjs').then((m) => m.default),
      ])
      const langs = await Promise.all(PRELOAD_LANGS.map((id) => LANG_LOADERS[id]!()))
      return createHighlighterCore({
        themes: [theme],
        langs,
        // wasm 以 base64 内联在独立 chunk 中，仅首次高亮时加载（engine 会 unwrap module.default）
        engine: createOnigurumaEngine(() => import('shiki/wasm').then((m) => m.default)),
      })
    })()
    // 失败时清空缓存，下次调用重试（避免缓存 rejected promise）
    highlighterPromise.catch(() => {
      highlighterPromise = undefined
    })
  }
  return highlighterPromise
}

/** 行高亮 transformer（```lang {2,5-7}）：命中行加 .hl-line 类（CSS 控制底色） */
function lineHighlighter(lines: Set<number>): ShikiTransformer {
  return {
    line(node, line) {
      if (lines.has(line)) this.addClassToHast(node, 'hl-line')
    },
  }
}

export interface HighlightOptions {
  /** 高亮行号（1 基） */
  lines?: number[]
}

/** 代码高亮 → HTML 字符串；白名单语言懒加载，白名单外/加载失败回退 text */
export async function highlightCode(code: string, lang: string, options?: HighlightOptions): Promise<string> {
  const highlighter = await getHighlighter()
  const id = resolveLang(lang)
  const transformers =
    options?.lines && options.lines.length > 0 ? [lineHighlighter(new Set(options.lines))] : undefined
  if (id) {
    try {
      if (!highlighter.getLoadedLanguages().includes(id)) {
        await highlighter.loadLanguage(await LANG_LOADERS[id]!())
      }
      return highlighter.codeToHtml(code, { lang: id, theme: SHIKI_THEME, transformers })
    } catch {
      // 回退 text（语法加载异常不阻断渲染）
    }
  }
  return highlighter.codeToHtml(code, { lang: 'text', theme: SHIKI_THEME, transformers })
}
