/**
 * 浏览器工具集（M22）：browser_open / navigate / snapshot / click / fill / press / scroll / wait /
 * screenshot / console / eval / close / request_human。
 *
 * 语义：
 * - 懒启动：browser_open 会自动启动（managed/local）或接入（remote）浏览器；其余工具要求已有会话；
 * - 操作可视化：每个动作落在右侧「浏览器」面板的实时帧流 + 步骤时间轴（含截图证据）；
 * - 人工接管：browser_request_human 请求用户接管（登录/验证码/敏感确认），用户接管期间 Agent 动作排队等待；
 * - browser_eval 为高权限动作（审批门拦截）。
 */
import { z } from 'zod'
import type { AgentTool, ToolResult, ToolRuntime } from './registry.js'
import type { BrowserSession } from '../browser/session.js'
import type { SnapshotElement } from '../browser/session.js'

interface SessionReady {
  ok: true
  session: BrowserSession
}

interface SessionError {
  ok: false
  summary: string
}

function requireBrowserService(ctx: ToolRuntime): string | undefined {
  if (!ctx.browser) return '浏览器工具未启用（服务端未装配浏览器运行时）'
  return undefined
}

/** 取当前会话的活跃浏览器（不存在则给出可操作提示） */
function activeSession(ctx: ToolRuntime): SessionReady | SessionError {
  const guard = requireBrowserService(ctx)
  if (guard) return { ok: false, summary: guard }
  const session = ctx.browser!.activeFor(ctx.sessionId)
  if (!session || session.isClosed()) {
    return {
      ok: false,
      summary: '当前会话没有打开的浏览器：请先调用 browser_open（会自动启动并打开目标页面）',
    }
  }
  // 归属标记（步骤落库时带 run/agent 维度）
  session.context = { runId: ctx.runId, agentId: ctx.agentId }
  return { ok: true, session }
}

/** 元素清单 → 对 LLM 紧凑友好的文本 */
function formatSnapshot(elements: SnapshotElement[], currentUrl?: string): string {
  if (elements.length === 0) {
    return `（页面无可交互元素）${currentUrl ? `\n当前地址：${currentUrl}` : ''}`
  }
  const lines = elements.map((el) => {
    const parts = [`[${el.index}] <${el.tag}>`]
    if (el.text) parts.push(`"${el.text}"`)
    if (el.href) parts.push(`→ ${el.href}`)
    if (el.name) parts.push(`name=${el.name}`)
    parts.push(`selector: ${el.selector}`)
    return parts.join(' ')
  })
  const head = currentUrl ? `当前地址：${currentUrl}\n` : ''
  return `${head}可交互元素（${elements.length} 个）：\n${lines.join('\n')}`
}

/** 宽松 URL 等价（忽略协议与尾斜杠）：避免复用会话时对同一地址重复导航 */
function sameUrl(current: string | undefined, target: string): boolean {
  if (!current) return false
  const norm = (url: string): string =>
    url
      .trim()
      .replace(/^https?:\/\//, '')
      .replace(/\/$/, '')
  return norm(current) === norm(target)
}

/** 控制台时间戳 → HH:MM:SS（本地） */
function timeOf(ts: number): string {
  return new Date(ts).toTimeString().slice(0, 8)
}

const browserOpenTool: AgentTool<{ url?: string; connection_id?: string; system?: boolean }> = {
  name: 'browser_open',
  description:
    '打开浏览器并（可选）导航到指定 URL。会自动启动本机 Chrome（专用配置目录，不干扰你的日常浏览器）或接入已配置的 CDP 连接。页面打开的新标签页会被自动接管（画面 / 控制台 / 操作目标始终跟随当前管理页），无需重复调用。system=true 时改用系统默认浏览器打开链接（不接入自动化，仅展示给用户）。打开后请先用 browser_snapshot 观察页面。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网址（http/https）' },
      connection_id: {
        type: 'string',
        description: '可选：使用某个已绑定的 chrome 类型连接（remote/managed/local 配置）',
      },
      system: { type: 'boolean', description: '是否改用系统默认浏览器打开（默认 false）' },
    },
  },
  schema: z.object({
    url: z.string().optional(),
    connection_id: z.string().optional(),
    system: z.boolean().default(false),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const guard = requireBrowserService(ctx)
    if (guard) return { ok: false, summary: guard }
    if (args.system) {
      if (!args.url) return { ok: false, summary: 'system=true 时必须提供 url' }
      try {
        await ctx.browser!.openExternal(args.url)
        return { ok: true, summary: `已在系统浏览器打开：${args.url}` }
      } catch (err) {
        return { ok: false, summary: (err as Error).message }
      }
    }
    try {
      const session = await ctx.browser!.ensureForSession(ctx.sessionId, {
        connectionId: args.connection_id,
        startUrl: args.url,
      })
      // 复用已有会话时 startUrl 被忽略：显式对齐目标地址（不一致才导航，避免无谓刷新）
      if (args.url && !sameUrl(session.currentUrl, args.url)) {
        await session.navigate(args.url)
      }
      const info = session.info()
      const where = await session.evaluate<string>('location.href').catch(() => undefined)
      return {
        ok: true,
        summary: `浏览器已就绪（${info.backend} 模式）：${where ?? args.url ?? 'about:blank'}`,
        detail: `浏览器会话 ${info.id}（${info.state}${info.external ? '，复用已运行实例' : ''}）。右侧「浏览器」面板可实时观看画面；需要人机配合（登录等）时用 browser_request_human。`,
      }
    } catch (err) {
      return { ok: false, summary: `打开浏览器失败：${(err as Error).message}` }
    }
  },
}

const browserNavigateTool: AgentTool<{ url?: string; direction?: 'back' | 'forward' }> = {
  name: 'browser_navigate',
  description:
    '在已打开的浏览器中导航：打开 URL（同页跳转），或前进/后退（direction=back|forward）。浏览器未开时用 browser_open 一步到位（可带 URL）；本工具用于打开后的再次导航与前进后退。',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: '目标网址（http/https）' },
      direction: { type: 'string', enum: ['back', 'forward'], description: '历史前进 / 后退' },
    },
  },
  schema: z.object({
    url: z.string().optional(),
    direction: z.enum(['back', 'forward']).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      if (args.direction === 'back') {
        await ready.session.back()
        return { ok: true, summary: `已后退：${ready.session.currentUrl ?? ''}` }
      }
      if (args.direction === 'forward') {
        await ready.session.forward()
        return { ok: true, summary: `已前进：${ready.session.currentUrl ?? ''}` }
      }
      if (!args.url) return { ok: false, summary: '需要提供 url 或 direction' }
      const result = await ready.session.navigate(args.url)
      return {
        ok: true,
        summary: `已打开 ${result.url}${result.title ? `（${result.title}）` : ''}`,
      }
    } catch (err) {
      return { ok: false, summary: `导航失败：${(err as Error).message}` }
    }
  },
}

const browserSnapshotTool: AgentTool<{ include_text?: boolean }> = {
  name: 'browser_snapshot',
  readOnly: true,
  description:
    '获取当前页面的可交互元素清单（按钮 / 链接 / 输入框等，含 CSS selector）与当前地址。操作页面前先 snapshot，用清单里的 selector 定位元素，比猜测更可靠。include_text=true 时附带页面正文文本（读取长文 / 列表内容用）。',
  parameters: {
    type: 'object',
    properties: {
      include_text: { type: 'boolean', description: '是否附带页面正文文本（默认 false）' },
    },
  },
  schema: z.object({ include_text: z.boolean().default(false) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      const elements = await ready.session.snapshot()
      let detail = formatSnapshot(elements, ready.session.currentUrl)
      if (args.include_text) {
        const text = await ready.session
          .evaluate<string>('document.body ? document.body.innerText : ""')
          .catch(() => '')
        const body = String(text ?? '')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
        if (body)
          detail += `\n\n页面文本${body.length > 3_000 ? '（已截断）' : ''}：\n${body.slice(0, 3_000)}`
      }
      return {
        ok: true,
        summary: `页面元素 ${elements.length} 个（${ready.session.currentUrl ?? '未知地址'}）`,
        detail,
      }
    } catch (err) {
      return { ok: false, summary: `读取页面失败：${(err as Error).message}` }
    }
  },
}

const browserClickTool: AgentTool<{ selector?: string; x?: number; y?: number }> = {
  name: 'browser_click',
  description:
    '点击页面元素：优先用 selector（来自 browser_snapshot）；也可用视口坐标 x/y（canvas / 特殊控件）。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector（与 x/y 二选一）' },
      x: { type: 'number', description: '视口 X 坐标' },
      y: { type: 'number', description: '视口 Y 坐标' },
    },
  },
  schema: z.object({
    selector: z.string().min(1).optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      if (args.selector) {
        await ready.session.clickBySelector(args.selector)
        return { ok: true, summary: `已点击 ${args.selector}` }
      }
      if (args.x !== undefined && args.y !== undefined) {
        await ready.session.clickAt(args.x, args.y)
        return { ok: true, summary: `已点击坐标 (${args.x}, ${args.y})` }
      }
      return { ok: false, summary: '需要 selector 或 x/y 坐标' }
    } catch (err) {
      return { ok: false, summary: `点击失败：${(err as Error).message}` }
    }
  },
}

const browserFillTool: AgentTool<{ selector: string; value: string; submit?: boolean }> = {
  name: 'browser_fill',
  description:
    '在输入框中填写文本（先清空再输入）。selector 取自 browser_snapshot 清单，不要猜 CSS 路径；submit=true 时填完后按回车（适合搜索框 / 简单表单，复杂表单改用 browser_click 点提交）。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '输入框 CSS selector' },
      value: { type: 'string', description: '要填写的文本' },
      submit: { type: 'boolean', description: '填写后按回车（默认 false）' },
    },
    required: ['selector', 'value'],
  },
  schema: z.object({ selector: z.string().min(1), value: z.string(), submit: z.boolean().default(false) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      await ready.session.fill(args.selector, args.value, { submit: args.submit })
      return { ok: true, summary: `已填写 ${args.selector}${args.submit ? ' 并提交' : ''}` }
    } catch (err) {
      return { ok: false, summary: `填写失败：${(err as Error).message}` }
    }
  },
}

const browserPressTool: AgentTool<{ key: string }> = {
  name: 'browser_press',
  description:
    '按下一个按键（Enter / Tab / Escape / ArrowDown / PageDown / Backspace 等，或单个字符）。适合处理键盘快捷键与对话框。',
  parameters: {
    type: 'object',
    properties: { key: { type: 'string', description: '按键名' } },
    required: ['key'],
  },
  schema: z.object({ key: z.string().min(1).max(20) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      await ready.session.press(args.key)
      return { ok: true, summary: `已按 ${args.key}` }
    } catch (err) {
      return { ok: false, summary: `按键失败：${(err as Error).message}` }
    }
  },
}

const browserScrollTool: AgentTool<{ delta_y: number; delta_x?: number }> = {
  name: 'browser_scroll',
  description:
    '滚动页面（目标内容在视口外 / 需要继续阅读时用）。delta_y 为正向下（典型值 600），负向上。滚动后重新 browser_snapshot 再定位元素，不要盲点坐标。',
  parameters: {
    type: 'object',
    properties: {
      delta_y: { type: 'number', description: '纵向滚动像素' },
      delta_x: { type: 'number', description: '横向滚动像素（默认 0）' },
    },
    required: ['delta_y'],
  },
  schema: z.object({ delta_y: z.number(), delta_x: z.number().default(0) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      await ready.session.scroll(args.delta_x ?? 0, args.delta_y)
      return { ok: true, summary: `已滚动 ${args.delta_y}px` }
    } catch (err) {
      return { ok: false, summary: `滚动失败：${(err as Error).message}` }
    }
  },
}

const browserWaitTool: AgentTool<{ selector?: string; ms?: number; timeout_ms?: number }> = {
  name: 'browser_wait',
  description: '等待：等待元素出现（selector）或固定毫秒（ms）。动态页面在操作前等待元素更稳定。',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: '等待出现的 CSS selector' },
      ms: { type: 'number', description: '固定等待毫秒数' },
      timeout_ms: { type: 'number', description: 'selector 等待上限（默认 10000ms）' },
    },
  },
  schema: z.object({
    selector: z.string().min(1).optional(),
    ms: z.number().int().min(1).max(30_000).optional(),
    timeout_ms: z.number().int().min(100).max(30_000).optional(),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    if (!args.selector && !args.ms) return { ok: false, summary: '需要 selector 或 ms' }
    try {
      await ready.session.waitFor({ selector: args.selector, ms: args.ms, timeoutMs: args.timeout_ms })
      return { ok: true, summary: args.selector ? `元素已出现：${args.selector}` : `已等待 ${args.ms}ms` }
    } catch (err) {
      return { ok: false, summary: `等待失败：${(err as Error).message}` }
    }
  },
}

const browserScreenshotTool: AgentTool<{ label?: string }> = {
  name: 'browser_screenshot',
  description: '对当前页面截图并保存到会话数据目录（返回文件路径）。用于留证据 / 汇报截图。',
  parameters: {
    type: 'object',
    properties: { label: { type: 'string', description: '截图标签（文件名前缀，可选）' } },
  },
  schema: z.object({ label: z.string().max(40).optional() }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      const file = await ready.session.screenshot(args.label ?? 'manual')
      return {
        ok: true,
        summary: `已截图：${file}`,
        detail: `截图已保存到 ${file}，可在浏览器面板时间轴中查看。`,
      }
    } catch (err) {
      return { ok: false, summary: `截图失败：${(err as Error).message}` }
    }
  },
}

const browserConsoleTool: AgentTool<{ level?: 'all' | 'warning' | 'error'; limit?: number }> = {
  name: 'browser_console',
  readOnly: true,
  description:
    '读取页面控制台日志（console 输出 / 未捕获异常 / 资源加载错误），用于排查页面报错、验证前端脚本行为。level：all（默认）/ warning（警告及以上）/ error（仅错误与异常）；limit 默认 50 条。',
  parameters: {
    type: 'object',
    properties: {
      level: { type: 'string', enum: ['all', 'warning', 'error'], description: '过滤级别（默认 all）' },
      limit: { type: 'number', description: '返回条数上限（默认 50，最大 200）' },
    },
  },
  schema: z.object({
    level: z.enum(['all', 'warning', 'error']).default('all'),
    limit: z.number().int().min(1).max(200).default(50),
  }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    const { entries, total } = ready.session.consoleLog(args.level, args.limit)
    if (entries.length === 0) {
      return {
        ok: true,
        summary: '控制台无日志',
        detail: '（当前没有采集到控制台输出；主帧导航后日志会清空，请在页面加载与交互后再读取）',
      }
    }
    const lines = entries.map((entry) => `[${timeOf(entry.ts)}] [${entry.level}] ${entry.text}`)
    return {
      ok: true,
      summary: `控制台 ${entries.length} 条（共 ${total} 条）`,
      detail: `控制台日志（${args.level}，最近 ${entries.length} / 共 ${total} 条）：\n${lines.join('\n')}`,
    }
  },
}

const browserEvalTool: AgentTool<{ expression: string }> = {
  name: 'browser_eval',
  description:
    '在当前页面执行任意 JavaScript 表达式并返回结果（高权限：可读写页面数据与 DOM）。仅在 snapshot/click/fill 无法完成时使用；执行前请确认表达式安全（不修改关键数据、不发起不可逆操作）。',
  parameters: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'JS 表达式（支持 await / 返回可序列化值）' } },
    required: ['expression'],
  },
  schema: z.object({ expression: z.string().min(1).max(10_000) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      const value = await ready.session.evaluate(args.expression)
      const text =
        typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value ?? 'null'))
      return {
        ok: true,
        summary: `JS 执行完成（返回 ${typeof value}）`,
        detail: text.length > 4_000 ? `${text.slice(0, 4_000)}\n…（结果已截断）` : text,
      }
    } catch (err) {
      return { ok: false, summary: `JS 执行失败：${(err as Error).message}` }
    }
  },
}

const browserCloseTool: AgentTool<Record<string, never>> = {
  name: 'browser_close',
  description: '关闭当前浏览器会话（释放资源）。任务完成后调用；用户手动关闭的浏览器无法再操作。',
  parameters: { type: 'object', properties: {} },
  schema: z.object({}),
  async execute(_args, ctx): Promise<ToolResult> {
    const guard = requireBrowserService(ctx)
    if (guard) return { ok: false, summary: guard }
    const session = ctx.browser!.activeFor(ctx.sessionId)
    if (!session) return { ok: true, summary: '当前没有打开的浏览器会话' }
    const closed = await ctx.browser!.close(session.id, ctx.agentId)
    return closed ? { ok: true, summary: '浏览器会话已关闭' } : { ok: false, summary: '关闭失败：会话不存在' }
  },
}

const browserRequestHumanTool: AgentTool<{ reason: string }> = {
  name: 'browser_request_human',
  description:
    '请求用户人工接管浏览器（登录 / 验证码 / 支付确认 / 需要用户决策的页面）。调用后用户会在浏览器面板收到提示并接管操作；你应说明需要用户做什么，然后在下一回合继续。',
  parameters: {
    type: 'object',
    properties: { reason: { type: 'string', description: '需要人工完成的具体事项' } },
    required: ['reason'],
  },
  schema: z.object({ reason: z.string().min(1).max(300) }),
  async execute(args, ctx): Promise<ToolResult> {
    const ready = activeSession(ctx)
    if (!ready.ok) return { ok: false, summary: ready.summary }
    try {
      await ready.session.requestHuman(args.reason)
      return {
        ok: true,
        summary: `已请求人工接管：${args.reason}`,
        detail: '用户将在浏览器面板中看到请求并接管。请等待用户完成操作后（下一回合）再继续。',
      }
    } catch (err) {
      return { ok: false, summary: `请求失败：${(err as Error).message}` }
    }
  },
}

export function createBrowserTools(): Array<AgentTool<never>> {
  // M28：浏览器工具组默认延迟（不在常驻清单；经 tool_search 激活后本 Run 内可用）
  return [
    browserOpenTool,
    browserNavigateTool,
    browserSnapshotTool,
    browserClickTool,
    browserFillTool,
    browserPressTool,
    browserScrollTool,
    browserWaitTool,
    browserScreenshotTool,
    browserConsoleTool,
    browserEvalTool,
    browserCloseTool,
    browserRequestHumanTool,
  ].map((tool) => ({ ...tool, tier: 'deferred' as const })) as unknown as Array<AgentTool<never>>
}
