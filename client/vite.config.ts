import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/** M14：markdown 渲染生态（react-markdown + remark-gfm 传递依赖）——版本稳定、体积大，拆独立 vendor 让主包 gzip 回到 ≤ 150KB（design.md §12.2） */
const MD_VENDOR_RE =
  /node_modules\/(react-markdown|remark-[^/]+|rehype-[^/]+|mdast-util-[^/]+|hast-util-[^/]+|micromark[^/]*|unified|unist-util-[^/]+|vfile[^/]*|devlop|bail|trough|zwitch|ccount|character-[^/]+|decode-named-character-reference|parse-entities|stringify-entities|property-information|space-separated-tokens|comma-separated-tokens|html-url-attributes|html-void-elements|trim-lines|is-plain-obj|longest-streak|markdown-table|style-to-object|estree-util-is-identifier-name)\//

/** M24：shiki 词法内核四件套（core / oniguruma 引擎 / 主题 / 内联 wasm）在首次高亮时同波懒加载，
 * 合并为单 chunk：字节数与加载时机不变，仅少 3 个产物文件（design.md §12.2 ≤ 50）。
 * 注意不匹配 @shikijs/langs（语言按需 chunk）——并入会把 35 个语法拉进静态图。 */
const SHIKI_CORE_RE =
  /node_modules\/(?:shiki\/dist\/(?:core\.mjs|wasm\.mjs|themes\/)|@shikijs\/(?:core|engine-oniguruma|vscode-textmate|types|themes)\/)/

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
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // M13：稳定依赖拆独立 vendor chunk（版本不变时命中浏览器缓存，主包只装业务代码）
        manualChunks(id: string): string | undefined {
          if (!id.includes('node_modules')) return undefined
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react-vendor'
          if (id.includes('node_modules/@radix-ui/')) return 'radix-vendor'
          if (MD_VENDOR_RE.test(id)) return 'md-vendor'
          if (SHIKI_CORE_RE.test(id)) return 'shiki-core'
          return undefined
        },
      },
    },
  },
})
