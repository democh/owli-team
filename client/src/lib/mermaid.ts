/**
 * Mermaid 懒加载渲染（独立 chunk，仅首次出现 ```mermaid 时加载）：
 * - 采用 dist/mermaid.min.js 全量单文件 bundle：mermaid 12 的 ESM 入口会把 diagram/布局引擎/
 *   katex 拆成 60+ 懒 chunk，直接击穿「构建产物 ≤ 50 文件」门槛（design.md §12.2）；
 * - 必须以 <script> 经典脚本注入（而非 import()）：esbuild IIFE 依赖全局作用域的 var 声明
 *   （末尾 globalThis.__esbuild_esm_mermaid_nm[...]），模块作用域执行会报
 *   "Cannot read properties of undefined (reading 'mermaid')"；
 * - 单例 initialize（浅色主题变量对齐 app 蓝色主题；securityLevel strict）；
 * - renderMermaid(code) → SVG 字符串，同源码命中 mermaidCache（虚拟列表重挂载/重复内容免重渲染）；
 * - 失败向上抛（调用方展示错误卡 + 源码回退），并清空失败缓存以便重试。
 */
import mermaidBundleUrl from 'mermaid/dist/mermaid.min.js?url'
import { FONT_SANS } from './fonts'
import { mermaidCache } from './md-cache'

type MermaidApi = typeof import('mermaid').default

/** 单文件 bundle 无 ESM 导出，经典脚本执行后 API 挂在 globalThis.mermaid */
type MermaidGlobal = typeof globalThis & { mermaid?: MermaidApi }

const MERMAID_CACHE_MAX = 100

let mermaidPromise: Promise<MermaidApi> | undefined
let seq = 0

/** 注入经典脚本（失败时移除标签，允许重试） */
function loadMermaidScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      script.remove()
      reject(new Error('mermaid bundle 加载失败'))
    }
    document.head.appendChild(script)
  })
}

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = loadMermaidScript(mermaidBundleUrl).then(() => {
      const mermaid = (globalThis as MermaidGlobal).mermaid
      if (!mermaid) throw new Error('mermaid bundle 未挂载到 globalThis')
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          fontFamily: FONT_SANS,
          fontSize: '13px',
          primaryColor: '#dbeafe',
          primaryBorderColor: '#93c5fd',
          primaryTextColor: '#1e293b',
          secondaryColor: '#e0f2fe',
          tertiaryColor: '#f8fafc',
          lineColor: '#64748b',
          textColor: '#334155',
        },
        flowchart: { useMaxWidth: true, htmlLabels: false, curve: 'basis' },
        sequence: { useMaxWidth: true },
        gantt: { useMaxWidth: true },
      })
      return mermaid
    })
    // 加载失败不缓存 rejected promise，下次重试
    mermaidPromise.catch(() => {
      mermaidPromise = undefined
    })
  }
  return mermaidPromise
}

/** 渲染 mermaid 源码 → SVG 字符串（同源码复用缓存） */
export async function renderMermaid(code: string): Promise<string> {
  const cached = mermaidCache.get(code)
  if (cached !== undefined) return cached
  const mermaid = await getMermaid()
  const id = `md-mermaid-${++seq}`
  const { svg } = await mermaid.render(id, code)
  mermaidCache.set(code, svg)
  if (mermaidCache.size > MERMAID_CACHE_MAX) {
    const first = mermaidCache.keys().next().value
    if (first !== undefined) mermaidCache.delete(first)
  }
  return svg
}
