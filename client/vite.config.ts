import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** M14：markdown 渲染生态（react-markdown + remark-gfm 传递依赖）——版本稳定、体积大，拆独立 vendor 让主包 gzip 回到 ≤ 150KB（design.md §12.2） */
const MD_VENDOR_RE =
  /node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|mdast-util-[^/]+|hast-util-[^/]+|micromark[^/]*|unified|unist-util-[^/]+|vfile[^/]*|devlop|bail|trough|zwitch|ccount|character-[^/]+|decode-named-character-reference|parse-entities|stringify-entities|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|html-void-elements|trim-lines|is-plain-obj|longest-streak|markdown-table|style-to-object|estree-util-is-identifier-name)\//

/** M24：shiki 词法内核四件套（core / oniguruma 引擎 / 主题 / 内联 wasm）在首次高亮时同波懒加载。
 * 注意：不要用 manualChunks 指定 three / shiki 分组——它们会被并入 entry 的静态依赖图，
 * 导致 index.html 在首屏 modulepreload 整块 three-stack（~840KB）与 shiki-core（~780KB），
 * 反而击穿「不进首屏」约束。交给 Rollup 按动态 import 自然分包即可。 */

/** M65-B0：three 栈（three + R3F + drei 及传递件）仅经 `studio-lazy.tsx` 动态导入，
 * 由 Rollup 自动拆分为 StudioCanvas 的懒加载依赖，不做手动分包。 */

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    // 预算门禁：单 chunk 超过 900KB 视为拆分缺失（CI 另有 scripts/check-bundle.mjs 校验首屏体积）
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        // M13：稳定依赖拆独立 vendor chunk（版本不变时命中浏览器缓存，主包只装业务代码）
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
          if (id.includes('node_modules/@radix-ui/')) return 'radix-vendor'
          if (MD_VENDOR_RE.test(id)) return 'md-vendor'
          return undefined
        },
      },
    },
  },
})
