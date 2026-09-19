# ADR 0034：Markdown 渲染扩展——mermaid / chart / 容器语法与包体纪律

- 状态：Accepted
- 引入：M19
- 相关：[design.md §30](../design.md)、ADR 9（delta 渲染）、ADR 25（前端性能架构）

## 背景

会话消息与交付件统一走 Markdown 渲染管线（react-markdown + remark-gfm + shiki 白名单高亮）。协作产出对表达力的需求超出基础 Markdown：流程图 / 时序图（mermaid 是模型输出的生态事实标准）、数据图表、方案对比分栏、提示卡（callout）、折叠附录、代码块文件名与行定位。硬约束：`npm run build` 产物 ≤ 50 文件、主包 gzip ≤ 150KB（§12.2）；流式纪律（流式期间代码块 / 图表一律纯文本，完成态才高亮与渲染）。

## 决策

**全部在纯前端渲染层扩展，零后端改动（消息内容本就是纯文本）**：

- **容器语法自写 remark 插件**（`md-ext/remark-ext.ts`）：`::: cols/col`（分栏）、`::: tip|info|note|success|warning|danger`（callout 六变体）、`::: details`（原生 details/summary）；采用**兄弟节点级栈式解析**（在父级 children 循环中维护 out/stack/buffer），列表 / 表格 / 代码块等块级内容跨空行正确归属容器；fail-safe——未闭合容器展开保内容、未知容器名保持原文、游离闭标记不误吞；
- **mermaid 用 dist 单文件 bundle + 经典脚本注入**（`lib/mermaid.ts`）：`import('…/mermaid.min.js?url')` 拿资源 URL，运行时注入 `<script>` 懒加载（5.3MB，仅首次出现 mermaid 块时加载，占 1 个产物文件）；`globalThis.mermaid` 单例 initialize（对齐蓝色主题变量、securityLevel strict）；渲染成功进 mermaidCache（同源码复用 SVG），失败向上抛（组件呈现错误卡 + 源码回退）；
- **chart 用 echarts 按需子路径 + 懒 chunk**（`lib/chart.ts` + `lib/chart-spec.ts`）：JSON schema（bar / line / area / pie / scatter，支持 labels 简写与 [x,y] 点对）由零依赖纯函数 `parseChartSpec` 在主包解析并给出可读中文错误；echarts 运行时经静态命名导入（`echarts/core` + 4 图表 + 5 组件 + CanvasRenderer）随 `import()` 懒 chunk 精确 tree-shake（全量 1MB+ → 566KB，gzip 194KB）；
- **代码块增强**：```` ```ts title="app.ts" {2,5-7} ```` meta 由 `remarkCodeMeta` 写入 hProperties；shiki line transformer 输出 `.hl-line`；工具条含文件名 / 语言 / 行数 / 复制（clipboard + execCommand 回退）；> 24 行折叠；
- **图片灯箱与表格包裹**：img 映射 ZoomableImage（Overlay 用 createPortal 脱离消息卡层叠上下文、Esc 关闭、body 滚动锁）；table 包 `.md-table-wrap` 横向滚动；
- **流式纪律延续**：StreamingContext 贯穿（MessageItem → Markdown → PreBlock），流式期间 mermaid / chart / 代码块纯文本，完成态才触发懒加载渲染；
- **TurnCard 展示优化**：组色主题条（`group.theme` 双色渐变，`data-turn-accent` 供测试）、角色与波次徽章（turnIndex ≥ 0 显示「第 N 波」）、流式进度线（turn-sweep 动画，reduced-motion / 安静模式自动关闭）、hover / focus-within 显现消息操作（窄屏常显）；
- **md-vendor 拆分**：react-markdown 及 remark-gfm 传递依赖（mdast/hast/micromark/unified 等 30+ 稳定包）拆独立 vendor chunk（vite.config.ts manualChunks 规则）。

## 理由

- 单文件 bundle 是「文件数门槛 × mermaid 12 chunk 架构」冲突下的可行解：ESM 入口把 diagram / 布局引擎（elk / cytoscape / dagre）/ katex 拆成 60+ 懒 chunk，直接击穿产物门槛；单文件后 mermaid 相关产物归 1 个文件，5.3MB 懒加载交换比合理（仅文档含 mermaid 时触发）；
- 必须以经典脚本注入而非 `import()`：esbuild IIFE 产物依赖全局作用域 var（末尾 `globalThis.__esbuild_esm_mermaid_nm[...]`），模块作用域执行会抛 `Cannot read properties of undefined (reading 'mermaid')`（实测验证）；
- 容器解析放在 mdast 层而非渲染层字符串切分：children 天然经过完整管线（容器内的列表 / 表格 / 代码块照常渲染），与 remark 生态一致；
- echarts 静态命名导入（而非 `import * as echarts`）让 Rollup 精确 tree-shake，只保留用到的图表与组件；
- 拆分后主包 gzip 157 → 110KB、产物 48 文件，兑现既有包体门槛。

## 被否决的方案

- **mermaid ESM 入口懒加载**：60+ 产物文件击穿「≤ 50 文件」门槛；
- **mermaid 单文件 bundle 走 `import()`**：模块作用域破坏 esbuild IIFE 的全局挂载（实测报错）；
- **KaTeX 数学公式**：60+ 字体文件爆文件数门槛，放弃；
- **remark-directive 等第三方容器插件**：需要额外 adapter 且未知节点映射不稳定，自写解析器约 290 行可控；
- **渲染层字符串切分容器标记**：无法正确处理嵌套与块级内容归属；
- **echarts 全量 import**：1MB+ 主包或懒 chunk 体积翻倍，tree-shake 失效。

## 影响

- `client/package.json` 新增 `mermaid` ^12、`echarts` ^6（均为懒加载，不进首屏）；
- 新增 `md-ext/` 组件目录（PreBlock 路由 + 8 个组件）、`lib/mermaid.ts` / `lib/chart.ts` / `lib/chart-spec.ts`、`index.css` 扩展样式（+505 行）；
- `vite.config.ts` 新增 md-vendor 拆分规则；
- 产物：48 文件（≤ 50）、主包 gzip 109.7KB（≤ 150KB）；mermaid 单文件 5.3MB / echarts 566KB 均为按需懒加载；
- 测试：client 149 例 / 21 套件（新增 `markdown-ext.test.tsx` 25 例）；E2E 16 条（新增 `markdown-ext.spec.ts` 2 条：真实浏览器下 mermaid / echarts 懒加载渲染与 TurnCard 徽章）。
