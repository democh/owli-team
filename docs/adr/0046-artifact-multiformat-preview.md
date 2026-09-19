# ADR 0046：交付件多格式预览——9 类 kind、服务端零依赖 Office 解析与沙箱直出

- 状态：Accepted
- 引入：M24
- 相关：[design.md §22 / §38](../design.md)、ADR 34（Markdown 渲染扩展）、ADR 44（数据库工作台与 SSH 交互终端）

## 背景

- 交付件浏览（§22）此前只覆盖 markdown / code / image / data / other 五类；真实工作区里高频产出的 HTML 报告、CSV 报表、Office 文档（docx / xlsx / pptx）、mermaid 流程图与 echarts 配置（`*.chart.json`）点开只能看纯文本或下载。
- 硬约束一（§12.2）：client 构建产物 ≤ 50 文件、主包 gzip ≤ 150KB；M13 起前端零新增依赖，mammoth（docx）/ SheetJS（xlsx）这类重型解析库无法进入前端产物。
- 硬约束二（安全）：交付件由 Agent 产出，属不可信输入；HTML 直出与 Office 解析都必须按不可信内容处理（沙箱 / 转义 / 护栏）。
- 能力现状：服务端零依赖可用（`node:zlib` inflateRaw）；Markdown 渲染扩展（ADR 34）已提供 mermaid / echarts 组件与懒加载通道，可直接复用。

## 决策

1. **kind 扩到 9 类**：`markdown / code / html / chart / data / image / office / pdf / other`，由服务端 `classifyKind` 单点决定（约定优先：`*.chart.json` → chart 先于 `.json` → code；`.mmd/.mermaid` → chart；`.csv/.tsv` → data；旧 Office 格式 `.doc/.xls/.ppt` 归 office，由前端引导下载）。
2. **HTML / PDF 走原文流直出**：content 端点新增 `raw=1`（按扩展名推断 Content-Type + inline 直出，不再 JSON 包裹），前端 HTML 用 `sandbox` iframe 渲染（**不给** `allow-same-origin`），PDF 用浏览器内置预览。
3. **Office 在服务端零依赖解析**：自写 ZIP 读取（`server/src/util/zip.ts`：中央目录定位 + 按需解出 + zip64/未知压缩/解压体积护栏）+ 三类解析（`server/src/util/office-preview.ts`）：docx → 语义化 HTML（标题 / 段落 / 列表 / 表格 / 粗斜体，图片占位）、xlsx → 工作表二维数组（共享字符串 / 内联字符串 / 布尔 / 日期序列号）、pptx → 幻灯片大纲（标题 + 正文行）。8MB 上限 + 段落 / 行列 / 页数护栏，超限 `truncated: true`。
4. **预览复用既有渲染层**：markdown 与代码块走既有组件（§30 扩展 + shiki 白名单，白名单外回退纯文本，仍可复制）；chart 复用 md-ext 的 MermaidBlock / ChartBlock；表格用自写 RFC4180 子集解析 + DataTable。
5. **三态视图工具条**：预览 / 源码 / Diff——文本类（markdown / code / html / chart / data）可复制内容、可引用；二进制类复制路径；Office 与二进制不出现源码 / Diff 入口。
6. **直出类预览与内容加载态解耦**：html / image / office / pdf 的预览分支不受内联内容加载状态影响（避免 iframe「闪现 → 卸载 → 重挂」），仅依赖内容的 kind 才显示加载 / 错误态。
7. **包体纪律**：shiki 词法内核四件套（core / oniguruma 引擎 / 主题 / 内联 wasm）合并为单一 `shiki-core` 懒 chunk（首次高亮同波加载，语义与字节不变，-3 产物文件）；语言 chunk 保持按需独立。

## 理由

- 服务端解析使前端产物零增长（本次前端仅 +2.2KB gzip），解析逻辑可单测（自建 zip fixture 12 例）并可复用于导出 / 检索；
- 沙箱 iframe + 无 `allow-same-origin` 是 HTML 直出的最小权限形态：脚本可运行但拿不到宿主 origin；
- `raw=1` 复用既有 content 端点而非新增「原始文件」端点：路径安全、大小上限、会话校验全部沿用，不扩第二套安全面；
- chart 复用 md-ext 组件而非新写渲染器：mermaid / echarts 的懒加载、主题、错误兜底（§30）已经过测试与 e2e 验证；
- 9 类 kind 单点分类让「渲染器选择」成为服务端事实，前端只分派，避免两侧规则漂移。

## 被否决的方案

- **前端引入 mammoth / SheetJS 解析 Office**：单库即 500KB+，直接击穿产物门槛，与「前端零新增依赖」纪律冲突；
- **Office 走外部转换服务 / LibreOffice 二进制**：本环境无该能力，且把不可信文件外发有合规风险；
- **HTML 用 `iframe srcdoc` 内联注入**：需整段加载后再注入（大文件更慢），且 srcdoc 处于宿主同源上下文，后续改动易误加 `allow-same-origin`；raw 流 + sandbox 边界更清晰；
- **xlsx 由服务端直接出 HTML 表格**：丢失表格交互（排序 / 列宽 / 复制）与前后端一致样式，HTML 体积数倍于二维数组；
- **docx 全量还原（页眉页脚 / 样式表 / 图片）**：解析复杂度与产物体积失控；预览定位是「看得清」，精排文档引导下载查看；
- **为图表 / 表格新写渲染器**：与 §30 既有组件重复，且要重做懒加载与兜底。

## 适用与失效条件

- 适用：交付件新格式一律先归类到 9 类 kind，再按「服务端结构化解析 → 前端渲染」路径接入；服务端解析必须带体积 / 数量护栏并输出 `truncated` 标记；HTML 类直出必须保持沙箱（无 `allow-same-origin`）。
- 失效条件：前端产物门槛（≤ 50 文件 / 主包 gzip ≤ 150KB，§12.2）放宽、或引入受控的文档转换通道（独立解析服务）时，可重新评估重型解析库直连前端；主包 gzip 现存超标（M22 / M23 存量）按独立事项处理，不阻塞本 ADR。
