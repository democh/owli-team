/**
 * 配置（M1）：env（默认值） + data/settings.json（运行期覆盖，UI 可改无需重启）。
 *
 * 原则：
 * - 每个字段独立校验，非法值「回退默认 + 记录告警」，绝不因一个坏变量导致启动失败；
 * - 装配完成后用 zod 做一次整体断言（内部一致性），失败即启动失败（配置错误必须早暴露）；
 * - `loadConfig()` 保持同步、可重复调用（测试里每次 makeEnv() 都会调用）。
 */
import dotenv from 'dotenv'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { DEFAULT_EGRESS_NO_PROXY } from './net/egress.js'

const here = path.dirname(fileURLToPath(import.meta.url))
/** 仓库根目录（dev: server/src/../.. ，build: server/dist/../..） */
export const ROOT_DIR = path.resolve(here, '../..')

// .env 加载：仓库根为规范位置（npm -w 运行脚本时 cwd 在工作区目录，须显式指定）；
// 已存在的环境变量优先（override 默认 false），cwd/.env 作为兼容回退
dotenv.config({ path: path.join(ROOT_DIR, '.env') })
dotenv.config()

/** 启动期配置告警（index.ts 打印） */
export const configWarnings: string[] = []

function warn(message: string): void {
  if (!configWarnings.includes(message)) configWarnings.push(message)
}

function envStr(key: string, def: string): string {
  const v = process.env[key]
  return v === undefined || v === '' ? def : v
}

function envNum(key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  const v = Number(raw)
  if (!Number.isFinite(v) || v < min || v > max) {
    warn(`${key}="${raw}" 非法（需 ${min}~${max}），已回退默认 ${def}`)
    return def
  }
  return v
}

function envBool(key: string, def: boolean): boolean {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  if (['true', '1', 'yes', 'on'].includes(raw.toLowerCase())) return true
  if (['false', '0', 'no', 'off'].includes(raw.toLowerCase())) return false
  warn(`${key}="${raw}" 非法（需 true/false），已回退默认 ${def}`)
  return def
}

function envList(key: string, def: string[] = []): string[] {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return def
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function envEnum<T extends string>(key: string, allowed: readonly T[], def: T): T {
  const raw = process.env[key]
  if (raw === undefined || raw === '') return def
  if ((allowed as readonly string[]).includes(raw)) return raw as T
  warn(`${key}="${raw}" 非法（需 ${allowed.join('|')}），已回退默认 ${def}`)
  return def
}

function resolveDir(key: string, def: string): string {
  return path.resolve(ROOT_DIR, envStr(key, def))
}

/** M82：出口通道列表解析（未知通道丢弃 + 告警；空 = 内置默认 search/finance/browser） */
function readEgressChannels(raw: string[]): Array<'search' | 'finance' | 'browser' | 'mcp' | 'llm'> {
  const known = ['search', 'finance', 'browser', 'mcp', 'llm'] as const
  type Channel = (typeof known)[number]
  if (raw.length === 0) return ['search', 'finance', 'browser']
  const out: Channel[] = []
  for (const item of raw) {
    const id = item.trim().toLowerCase()
    if ((known as readonly string[]).includes(id)) {
      const channel = id as Channel
      if (!out.includes(channel)) out.push(channel)
    } else {
      warn(`EGRESS_CHANNELS 含未知通道「${item}」，已忽略（可选 ${known.join('/')}）`)
    }
  }
  return out.length > 0 ? out : ['search', 'finance', 'browser']
}

/** 模型单价（每 1K token，美元）；用于成本估算（估算量级，可用 LLM_PRICING_JSON 覆盖） */
const DEFAULT_PRICING: Record<string, { prompt: number; completion: number }> = {
  'deepseek-flash': { prompt: 0.00028, completion: 0.0011 },
  'deepseek-v4-pro': { prompt: 0.00055, completion: 0.00219 },
  'deepseek-chat': { prompt: 0.00027, completion: 0.0011 },
  'deepseek-reasoner': { prompt: 0.00055, completion: 0.00219 },
  'gpt-4o-mini': { prompt: 0.00015, completion: 0.0006 },
  'gpt-4o': { prompt: 0.0025, completion: 0.01 },
}

function readPricing(): Record<string, { prompt: number; completion: number }> {
  const raw = process.env.LLM_PRICING_JSON
  if (!raw) return DEFAULT_PRICING
  try {
    const parsed = z.record(z.object({ prompt: z.number(), completion: z.number() })).parse(JSON.parse(raw))
    return { ...DEFAULT_PRICING, ...parsed }
  } catch (err) {
    warn(`LLM_PRICING_JSON 解析失败（${(err as Error).message}），使用内置单价表`)
    return DEFAULT_PRICING
  }
}

export interface AppConfig {
  rootDir: string
  port: number
  bindAll: boolean
  authToken: string
  allowedOrigins: string[]

  llmBaseUrl: string
  llmApiKey: string
  llmModel: string
  /** E2E/离线演示：显式启用脚本化 Mock Provider（LLM_MOCK=true；生产勿开） */
  llmMock: boolean
  /** Mock 分片延时（ms）：E2E 可调大让流式/插话/停止可观察 */
  llmMockDelayMs: number
  /** 思考模式（DeepSeek V4）：默认关闭；开启后流式产出 reasoning 并持久化展示 */
  llmThinking: boolean
  /** 思考强度（仅思考模式生效）：low / high / max */
  llmReasoningEffort: 'low' | 'high' | 'max'
  /** 结构化输出的请求形态（M2 摘要等）：json_object 兼容性最好，json_schema 语义最强，off 不透传 */
  llmJsonMode: 'json_object' | 'json_schema' | 'off'
  /** 单次输出上限（max_tokens；0 = 不下发，用服务商默认）——防长文被默认低上限静默截断 */
  llmMaxOutputTokens: number
  summaryModel: string
  judgeModel: string
  llmMaxConcurrency: number
  llmMaxRetries: number
  llmRetryBaseDelayMs: number
  firstTokenTimeoutMs: number
  streamIdleTimeoutMs: number
  temperature: number
  /** 统一温度（设置面板热切换）：开启后忽略角色 AGENT.md 的 temperature，全部角色使用全局温度 */
  temperatureOverride: boolean
  llmPricing: Record<string, { prompt: number; completion: number }>

  maxTurnsPerRun: number
  /** 并行波次单波成员上限（=1 关闭并行，默认 3；M16） */
  parallelMax: number
  turnTimeoutMs: number
  contextBudgetTokens: number
  keepRecentTurns: number
  toolResultMaxTokens: number
  toolDetailKeep: number
  handoffMode: 'auto' | 'tool' | 'text'

  /** Agent 资产包目录（agents/<场景>/<agent>/，M15 起唯一规范位置） */
  agentsDir: string
  /** 旧版平铺角色目录（兼容回退，一个版本周期后移除） */
  promptsDir: string
  skillsDir: string
  dataDir: string
  workspaceDir: string
  worktreeDir: string
  logDir: string
  dbFile: string
  settingsFile: string

  maxToolSteps: number
  toolTimeoutMs: number
  allowRunCommand: boolean
  allowedCommands: string[]
  allowedRoots: string[]
  allowSensitive: boolean
  /** web_search 配置（无启用开关，始终可用；apiKey 非空 = 官方 API 模式，否则免 Key 多引擎降级链） */
  webSearch: { apiKey: string; apiUrl: string; htmlUrl: string; engines: string[] }
  /** 联网工具浏览器 UA 覆盖（空 = 内置 Chrome 桌面版） */
  httpUserAgent: string
  /** 追加 UA 池（HTTP_UA_POOL，每行一个 UA；与内置池合并） */
  httpUaPoolExtra: string[]
  /** 联网工具同域名最小请求间隔（毫秒，反爬限速；0 = 不限速） */
  httpMinIntervalMs: number
  /** 联网工具单次请求超时（毫秒） */
  httpTimeoutMs: number
  artifactMaxBytes: number

  // ---------- M82：联网出口（出网代理 / 隧道） ----------

  /** 全局出口形态：direct=直连（默认，零回归）/ proxy=经出口代理（连接中心 kind='proxy' 或 EGRESS_PROXY_URL） */
  egressMode: 'direct' | 'proxy'
  /** 出口连接 id（连接中心 kind='proxy'；空 = 用 EGRESS_PROXY_URL 后备） */
  egressConnectionId: string
  /** env 后备出口 URL（http(s)://user:pass@host:port / socks5://…；仅 env，不入 settings——含凭据） */
  egressProxyUrl: string
  /** 跟随全局出口的通道（未列出的通道恒直连；默认 search/finance/browser） */
  egressChannels: Array<'search' | 'finance' | 'browser' | 'mcp' | 'llm'>
  /** 直连旁路（host 后缀 / IP / IPv4 CIDR；回环恒直连与配置无关） */
  egressNoProxy: string[]
  /** 出口失败回退策略：direct=回退直连并标注（可用性优先）/ fail=严格失败（合规优先，绝不泄漏真实 IP） */
  egressFallback: 'direct' | 'fail'
  /** 出口探测地址（回显出口 IP；空 = 不可探测） */
  egressProbeUrl: string

  approvalMode: 'off' | 'risky' | 'all'
  approvalTimeoutMs: number
  approvalTools: string[]
  /** M24：计划审批等待超时（毫秒；0 = 无限等待——计划不流失，用户可稍后于任务面板批准） */
  planReviewTimeoutMs: number
  /** 消息接口限流（每 IP 每分钟上限，M7） */
  messageRateLimit: number

  mcpServers: string[]

  // ---------- M28：工具按需发现（渐进披露） ----------

  /** off=全量加载（M27 及之前行为）/ on=强制启用 / auto=按阈值自适应（默认） */
  toolSearchMode: 'auto' | 'on' | 'off'
  /** auto 阈值一：可延迟工具数 ≥ 该值即启用检索 */
  toolSearchMin: number
  /** auto 阈值二：可延迟工具 schema 估算 token ≥ 上下文预算的该百分比（%）即启用 */
  toolSearchTokenPct: number
  /** 单次检索最多激活工具数（1-10） */
  toolSearchLimit: number
  /** M28：MCP JSON 配置文件（相对仓库根；存在即作为文件权威源同步到 DB，source='json'） */
  mcpConfigFile: string
  /** M28：MCP JSON 配置 mtime 轮询间隔（ms；0 = 关闭轮询，仅启动同步 + 手动同步） */
  mcpConfigPollMs: number

  wsHeartbeatMs: number
  wsReplayBuffer: number
  /** M79-A：单连接待写队列上限（背压：超限发 resync 后断开；0 = 不限） */
  wsSendQueueMax: number
  /** M79-A：每用户并发 WS 连接上限（超限踢最旧；0 = 不限） */
  wsMaxConnsPerUser: number
  /** M79-A：收件箱保留期（天；仅清理已读项，未读恒保留；0 = 不清理） */
  inboxRetentionDays: number
  /** M79-A：在线状态聚合窗口（ms） */
  presenceAggregateMs: number
  /** M79-L：通知总线（memory = 单进程现状 / db = 多实例共享总线，默认零变化） */
  notifyBus: 'memory' | 'db'
  /** M79-L：总线轮询间隔（ms；db 模式跨实例投递延迟上限） */
  notifyBusPollMs: number
  /** M79-L：总线行保留期（分钟；0 = 不清理） */
  notifyBusRetentionMinutes: number
  /** M79-L：实例标识（presence 计数行 / 总线 origin；缺省 = 主机名:pid） */
  instanceId: string
  /** M79-A：好友请求日限额（每人） */
  friendRequestDailyLimit: number
  runDetachOnDisconnect: boolean
  asyncRunMax: number
  notifyPollMs: number

  logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent'

  // ---------- M22：连接中心 ----------

  /** 凭据加密密钥文件（0600 自动生成；env CONNECTION_SECRET_KEY 优先） */
  connectionSecretFile: string

  /** 数据库查询默认行数上限（连接可覆盖） */
  dbQueryMaxRows: number
  /** 数据库查询默认超时（ms；连接可覆盖） */
  dbQueryTimeoutMs: number
  /** schema 快照最大表数 */
  dbSchemaMaxTables: number
  /** 空闲数据库句柄回收阈值（ms） */
  dbPoolIdleMs: number

  // ---------- M22：浏览器（CDP） ----------

  /** 默认浏览器接入模式：managed=自启 headless / local=本机 Chrome（专用持久 profile）/ remote=远程 CDP */
  browserDefaultBackend: 'managed' | 'local' | 'remote'
  /** 显式指定浏览器可执行文件路径（空 = 自动发现） */
  browserExecutable: string
  /** 启动形态：true=无头（默认，不弹窗口）；false=打开窗口（可见，可人工观察） */
  browserHeadless: boolean
  /** CDP 保活周期（ms）：静默期发协议 ping，两周期无入站判定半开并触发自动重连 */
  browserKeepaliveMs: number
  /** 是否允许自动发现本机浏览器与调试端点 */
  browserAutoDiscover: boolean
  browserViewportWidth: number
  browserViewportHeight: number
  /** 帧流每客户端上限帧率 */
  browserFrameMaxFps: number
  /** 帧流 JPEG 品质（0-100） */
  browserFrameQuality: number
  /** 每步动作自动截图（时间轴证据） */
  browserStepShots: boolean
  browserScreenshotDir: string
  /** watch/takeover 流 token 有效期（ms） */
  browserStreamTokenTtlMs: number
  /** M62：单用户活跃浏览器实例上限（0 = 不限；多用户模式生效，先回收再拒绝） */
  browserMaxPerUser: number
  /** M62：全局活跃浏览器实例上限（0 = 不限） */
  browserMaxTotal: number
  /** M62：空闲自动关闭阈值（ms；0 = 不回收；人工接管 / 有订阅者的实例永不回收） */
  browserIdleCloseMs: number
  /** M62：空闲回收扫描周期（ms） */
  browserReclaimIntervalMs: number

  // ---------- M25：向量记忆 ----------

  /** 嵌入连接（连接中心 id，settings 白名单热切换；空 = env 后备 / 休眠） */
  embeddingConnectionId: string
  /** env 后备：OpenAI 兼容 /embeddings（EMBEDDING_BASE_URL / EMBEDDING_API_KEY / EMBEDDING_MODEL） */
  embeddingBaseUrl: string
  embeddingApiKey: string
  embeddingModel: string
  /** 向量维度（0 = 首次调用自动探测） */
  embeddingDim: number
  embeddingBatchSize: number
  embeddingTimeoutMs: number
  /** 语义召回（L1.5）：开关 / topK / 最低分 / 注入预算 / 超时（超时静默降级） */
  memoryRecallEnabled: boolean
  memoryRecallTopK: number
  memoryRecallMinScore: number
  memoryRecallBudgetTokens: number
  memoryRecallTimeoutMs: number
  /** 沉淀模式：off=关闭（默认）/ session=会话收尾 / all=每次 Run 收尾 */
  memoryDigestMode: 'off' | 'session' | 'all'

  // ---------- M34：金融投研 ----------

  /** 总开关（默认 false：离线/演示环境零影响；开启后入口与 fin_* 工具才可用） */
  financeEnabled: boolean
  /** Python 解释器路径（空 = 自动探测 python3 / python / py -3） */
  financePython: string
  /** Python 桥单任务超时（ms） */
  financePyTimeoutMs: number
  /** pip 镜像源（空 = 官方源；一键安装用） */
  financePipIndexUrl: string
  /** 金融源同域最小间隔（ms；0 = 复用 HTTP_MIN_INTERVAL_MS） */
  financeMinIntervalMs: number
  /** 行情快照刷新间隔（交易时段内；ms；行情面板撤除后暂无前端消费方，配置面保留） */
  financeQuoteRefreshMs: number
  /** 快照落盘目录（会话工作区内相对路径） */
  financeKlineSnapshotDir: string
  /** 博弈 ABM 路径数上限（计算护栏） */
  financeGameMaxPaths: number
  /** 博弈模拟默认随机种子（相同种子可复现） */
  financeGameSeed: number

  // ---------- M35：定时任务 ----------

  /** 总开关（默认 true：纯本地零网络；关闭后 tick 不启动、工具与接口不可用） */
  scheduleEnabled: boolean
  /** 调度 tick 轮询间隔（ms；下限 5000） */
  scheduleTickMs: number
  /** 默认时区（IANA 名；空 = 服务器时区，任务可单独覆盖） */
  scheduleTimezone: string
  /** 单会话任务数上限（防额度滥用） */
  scheduleMaxPerSession: number
  /** 最小触发间隔（ms；高频护栏，默认 5 分钟） */
  scheduleMinGapMs: number
  /** 停机补跑窗口（ms；超出窗口的错过触发按 skipped-missed 跳过而非引爆） */
  scheduleCatchupMs: number
  /** 连续失败自动暂停阈值（次数） */
  scheduleFailLimit: number

  // ---------- M57：多用户（P1 账号与隔离） ----------

  /** 登录会话滑动过期（天；每次访问续期） */
  sessionTtlDays: number
  /** 登录会话绝对过期（天；不可续期上限） */
  sessionAbsoluteTtlDays: number
  /** 登录失败锁定阈值（次） */
  loginLockoutThreshold: number
  /** 登录失败锁定时长（ms） */
  loginLockoutMs: number
  /** 登录接口 IP 限流（次/分钟） */
  loginRateLimit: number
  /** 每用户活跃 + 排队 Run 上限（防单户挤占全局并发；0 = 不限制） */
  runMaxPerUser: number
  /** 公网 HTTPS（nginx 网关终止 TLS）时置 true：sid cookie 加 Secure */
  authCookieSecure: boolean
  /** 反向代理信任（nginx 单跳填 1 或 true；限流 / 审计取 X-Forwarded-For 真实 IP） */
  trustProxy: string
}

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'silent'] as const

const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  bindAll: z.boolean(),
  llmMaxConcurrency: z.number().int().min(1).max(64),
  llmMaxRetries: z.number().int().min(0).max(10),
  firstTokenTimeoutMs: z.number().int().min(1_000),
  streamIdleTimeoutMs: z.number().int().min(1_000),
  turnTimeoutMs: z.number().int().min(1_000),
  contextBudgetTokens: z.number().int().min(1_000),
  keepRecentTurns: z.number().int().min(1),
  toolResultMaxTokens: z.number().int().min(100),
  toolDetailKeep: z.number().int().min(0),
  maxToolSteps: z.number().int().min(1),
  maxTurnsPerRun: z.number().int().min(1),
  parallelMax: z.number().int().min(1).max(8),
  asyncRunMax: z.number().int().min(1),
  artifactMaxBytes: z.number().int().min(1_024),
  temperature: z.number().min(0).max(2),
  temperatureOverride: z.boolean(),
  llmThinking: z.boolean(),
  llmMock: z.boolean(),
  llmMockDelayMs: z.number().int().min(0),
  llmReasoningEffort: z.enum(['low', 'high', 'max']),
  llmMaxOutputTokens: z.number().int().min(0).max(65_536),
  embeddingDim: z.number().int().min(0).max(8_192),
  embeddingBatchSize: z.number().int().min(1).max(128),
  embeddingTimeoutMs: z.number().int().min(1_000),
  memoryRecallTopK: z.number().int().min(1).max(50),
  memoryRecallMinScore: z.number().min(0).max(1),
  memoryRecallBudgetTokens: z.number().int().min(100),
  memoryRecallTimeoutMs: z.number().int().min(50),
  memoryDigestMode: z.enum(['off', 'session', 'all']),
  toolSearchMin: z.number().int().min(1).max(1_000),
  toolSearchTokenPct: z.number().min(1).max(100),
  toolSearchLimit: z.number().int().min(1).max(10),
  toolSearchMode: z.enum(['auto', 'on', 'off']),
  mcpConfigPollMs: z.number().int().min(0).max(3_600_000),
  financePyTimeoutMs: z.number().int().min(1_000).max(600_000),
  financeMinIntervalMs: z.number().int().min(0).max(60_000),
  egressChannels: z.array(z.enum(['search', 'finance', 'browser', 'mcp', 'llm'])).max(5),
  egressNoProxy: z.array(z.string().max(200)).max(200),
  egressFallback: z.enum(['direct', 'fail']),
  egressProbeUrl: z.string().max(500),
  egressMode: z.enum(['direct', 'proxy']),
  egressConnectionId: z.string().max(100),
  egressProxyUrl: z.string().max(2_000),
  financeQuoteRefreshMs: z.number().int().min(2_000).max(600_000),
  financeGameMaxPaths: z.number().int().min(1).max(10_000),
  financeGameSeed: z.number().int().min(0),
  scheduleTickMs: z.number().int().min(5_000).max(600_000),
  scheduleMaxPerSession: z.number().int().min(1).max(200),
  scheduleMinGapMs: z.number().int().min(60_000),
  scheduleCatchupMs: z.number().int().min(0),
  scheduleFailLimit: z.number().int().min(1).max(10),
  sessionTtlDays: z.number().int().min(1).max(365),
  sessionAbsoluteTtlDays: z.number().int().min(1).max(730),
  loginLockoutThreshold: z.number().int().min(1).max(100),
  loginLockoutMs: z.number().int().min(10_000).max(86_400_000),
  loginRateLimit: z.number().int().min(1).max(1_000),
  runMaxPerUser: z.number().int().min(0).max(64),
  wsSendQueueMax: z.number().int().min(0).max(65_536),
  wsMaxConnsPerUser: z.number().int().min(0).max(256),
  inboxRetentionDays: z.number().int().min(0).max(3_650),
  presenceAggregateMs: z.number().int().min(100).max(60_000),
  notifyBus: z.enum(['memory', 'db']),
  notifyBusPollMs: z.number().int().min(50).max(30_000),
  notifyBusRetentionMinutes: z.number().int().min(0).max(10_080),
  instanceId: z.string().min(1).max(120),
  friendRequestDailyLimit: z.number().int().min(1).max(1_000),
})

/** 内部一致性断言：启动（loadConfig）与运行期覆盖（settings）共用同一条校验路径 */
export function assertConfig(cfg: AppConfig): void {
  const checked = ConfigSchema.safeParse(cfg)
  if (!checked.success) {
    const issue = checked.error.issues[0]
    throw new Error(`配置校验失败：${issue.path.join('.')} ${issue.message}`)
  }
  if (cfg.bindAll && !cfg.authToken) {
    throw new Error('BIND_ALL=true 时必须配置 AUTH_TOKEN（否则局域网内任何人可读写你的工作区）')
  }
}

export function loadConfig(): AppConfig {
  const dataDir = resolveDir('DATA_DIR', 'data')
  const cfg: AppConfig = {
    rootDir: ROOT_DIR,
    port: envNum('PORT', 8787, 1, 65_535),
    bindAll: envBool('BIND_ALL', false),
    authToken: envStr('AUTH_TOKEN', ''),
    allowedOrigins: envList('ALLOWED_ORIGINS'),

    llmBaseUrl: envStr('LLM_BASE_URL', 'https://api.deepseek.com/v1'),
    llmApiKey: envStr('LLM_API_KEY', ''),
    llmModel: envStr('LLM_MODEL', 'deepseek-flash'),
    llmMock: envBool('LLM_MOCK', false),
    llmMockDelayMs: envNum('LLM_MOCK_DELAY_MS', 8, 0, 60_000),
    llmThinking: envBool('LLM_THINKING', false),
    llmReasoningEffort: envEnum('LLM_REASONING_EFFORT', ['low', 'high', 'max'] as const, 'high'),
    llmJsonMode: envEnum('LLM_JSON_MODE', ['json_object', 'json_schema', 'off'] as const, 'json_object'),
    llmMaxOutputTokens: envNum('LLM_MAX_OUTPUT_TOKENS', 8_192, 0, 65_536),
    summaryModel: envStr('SUMMARY_MODEL', ''),
    judgeModel: envStr('JUDGE_MODEL', ''),
    llmMaxConcurrency: envNum('LLM_MAX_CONCURRENCY', 3, 1, 64),
    llmMaxRetries: envNum('LLM_MAX_RETRIES', 3, 0, 10),
    llmRetryBaseDelayMs: envNum('LLM_RETRY_BASE_DELAY_MS', 500, 0, 60_000),
    firstTokenTimeoutMs: envNum('FIRST_TOKEN_TIMEOUT_MS', 30_000, 1_000),
    streamIdleTimeoutMs: envNum('STREAM_IDLE_TIMEOUT_MS', 60_000, 1_000),
    temperature: envNum('LLM_TEMPERATURE', 0.6, 0, 2),
    temperatureOverride: envBool('LLM_TEMPERATURE_OVERRIDE', false),
    llmPricing: readPricing(),

    maxTurnsPerRun: envNum('MAX_TURNS_PER_RUN', 10, 1),
    parallelMax: envNum('PARALLEL_MAX', 3, 1, 8),
    turnTimeoutMs: envNum('TURN_TIMEOUT_MS', 120_000, 1_000),
    contextBudgetTokens: envNum('CONTEXT_BUDGET_TOKENS', 60_000, 1_000),
    keepRecentTurns: envNum('KEEP_RECENT_TURNS', 6, 1),
    toolResultMaxTokens: envNum('TOOL_RESULT_MAX_TOKENS', 4_000, 100),
    toolDetailKeep: envNum('TOOL_DETAIL_KEEP', 6, 0),
    handoffMode: envEnum('HANDOFF_MODE', ['auto', 'tool', 'text'] as const, 'auto'),

    agentsDir: resolveDir('AGENTS_DIR', 'agents'),
    promptsDir: resolveDir('PROMPTS_DIR', 'prompts'),
    skillsDir: resolveDir('SKILLS_DIR', 'skills'),
    dataDir,
    workspaceDir: resolveDir('WORKSPACE_DIR', 'workspace'),
    worktreeDir: resolveDir('WORKTREE_DIR', path.join(envStr('DATA_DIR', 'data'), 'worktrees')),
    logDir: resolveDir('LOG_DIR', path.join(envStr('DATA_DIR', 'data'), 'logs')),
    dbFile: path.resolve(ROOT_DIR, envStr('DB_FILE', path.join(envStr('DATA_DIR', 'data'), 'app.db'))),
    settingsFile: resolveDir('SETTINGS_FILE', path.join(envStr('DATA_DIR', 'data'), 'settings.json')),

    maxToolSteps: envNum('MAX_TOOL_STEPS', 8, 1),
    toolTimeoutMs: envNum('TOOL_TIMEOUT_MS', 20_000, 1_000),
    allowRunCommand: envBool('ALLOW_RUN_COMMAND', false),
    allowedCommands: envList('ALLOWED_COMMANDS'),
    allowedRoots: envList('ALLOWED_ROOTS').map((p) => path.resolve(p)),
    allowSensitive: envBool('ALLOW_SENSITIVE', false),
    webSearch: {
      apiKey: envStr('BAIDU_SEARCH_API_KEY', ''),
      apiUrl: envStr('BAIDU_SEARCH_API_URL', 'https://qianfan.baidubce.com/v2/ai_search/web_search'),
      // 结果页抓取入口（免 Key 模式；不暴露环境变量，测试可注入本地地址）
      htmlUrl: 'https://www.baidu.com/s',
      // 免 Key 引擎降级链（逗号分隔；留空 = 内置默认 baidu,bing,sogou,so360）
      engines: envList('WEB_SEARCH_ENGINES'),
    },
    httpUserAgent: envStr('HTTP_USER_AGENT', ''),
    httpUaPoolExtra: envStr('HTTP_UA_POOL', '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    httpMinIntervalMs: envNum('HTTP_MIN_INTERVAL_MS', 1_200, 0, 60_000),
    httpTimeoutMs: envNum('HTTP_TIMEOUT_MS', 15_000, 1_000, 120_000),
    artifactMaxBytes: envNum('ARTIFACT_MAX_BYTES', 512 * 1024, 1_024),

    // M82：联网出口（默认 direct；未配置时全链路行为与历史一致）
    egressMode: envEnum('EGRESS_MODE', ['direct', 'proxy'] as const, 'direct'),
    egressConnectionId: envStr('EGRESS_CONNECTION_ID', ''),
    egressProxyUrl: envStr('EGRESS_PROXY_URL', ''),
    egressChannels: readEgressChannels(envList('EGRESS_CHANNELS')),
    egressNoProxy: envList('EGRESS_NO_PROXY', [...DEFAULT_EGRESS_NO_PROXY]),
    egressFallback: envEnum('EGRESS_FALLBACK', ['direct', 'fail'] as const, 'direct'),
    egressProbeUrl: envStr('EGRESS_PROBE_URL', 'https://myip.ipip.net'),

    approvalMode: envEnum('APPROVAL_MODE', ['off', 'risky', 'all'] as const, 'risky'),
    approvalTimeoutMs: envNum('APPROVAL_TIMEOUT_MS', 600_000, 1_000),
    approvalTools: envList('APPROVAL_TOOLS'),
    // M24：规划范式计划挂起等待时长（PLAN_REVIEW_TIMEOUT_MS；0 = 无限等待）
    planReviewTimeoutMs: envNum('PLAN_REVIEW_TIMEOUT_MS', 0, 0),
    messageRateLimit: envNum('MESSAGE_RATE_LIMIT', 30, 1),

    mcpServers: envList('MCP_SERVERS'),

    toolSearchMode: envEnum('TOOL_SEARCH_MODE', ['auto', 'on', 'off'] as const, 'auto'),
    toolSearchMin: envNum('TOOL_SEARCH_MIN', 10, 1, 1_000),
    toolSearchTokenPct: envNum('TOOL_SEARCH_TOKEN_PCT', 10, 1, 100),
    toolSearchLimit: envNum('TOOL_SEARCH_LIMIT', 5, 1, 10),
    mcpConfigFile: path.resolve(ROOT_DIR, envStr('MCP_CONFIG_FILE', 'mcp.json')),
    mcpConfigPollMs: envNum('MCP_CONFIG_POLL_MS', 5_000, 0, 3_600_000),

    wsHeartbeatMs: envNum('WS_HEARTBEAT_MS', 30_000, 1_000),
    wsReplayBuffer: envNum('WS_REPLAY_BUFFER', 200, 1),
    // M79-A：实时通道稳定化（背压 / 连接上限 / 收件箱保留期 / presence 聚合 / 好友请求日限额）
    wsSendQueueMax: envNum('WS_SEND_QUEUE_MAX', 256, 0, 65_536),
    wsMaxConnsPerUser: envNum('WS_MAX_CONNS_PER_USER', 8, 0, 256),
    inboxRetentionDays: envNum('INBOX_RETENTION_DAYS', 30, 0, 3_650),
    presenceAggregateMs: envNum('PRESENCE_AGGREGATE_MS', 500, 100, 60_000),
    // M79-L：多实例演进（默认 memory = 现状；db = 共享通知总线 + 跨实例 presence）
    notifyBus: process.env.NOTIFY_BUS === 'db' ? 'db' : 'memory',
    notifyBusPollMs: envNum('NOTIFY_BUS_POLL_MS', 400, 50, 30_000),
    notifyBusRetentionMinutes: envNum('NOTIFY_BUS_RETENTION_MINUTES', 10, 0, 10_080),
    instanceId: (process.env.INSTANCE_ID ?? '').trim() || `${os.hostname()}:${process.pid}`,
    friendRequestDailyLimit: envNum('FRIEND_REQUEST_DAILY_LIMIT', 20, 1, 1_000),
    runDetachOnDisconnect: envBool('RUN_DETACH_ON_DISCONNECT', true),
    asyncRunMax: envNum('ASYNC_RUN_MAX', 3, 1),
    notifyPollMs: envNum('NOTIFY_POLL_MS', 5_000, 500),

    logLevel: envEnum('LOG_LEVEL', LOG_LEVELS, process.env.NODE_ENV === 'test' ? 'silent' : 'info'),

    connectionSecretFile: resolveDir('CONNECTION_SECRET_FILE', path.join(envStr('DATA_DIR', 'data'), '.connection-key')),
    dbQueryMaxRows: envNum('DB_QUERY_MAX_ROWS', 200, 1, 10_000),
    dbQueryTimeoutMs: envNum('DB_QUERY_TIMEOUT_MS', 15_000, 1_000, 120_000),
    dbSchemaMaxTables: envNum('DB_SCHEMA_MAX_TABLES', 100, 1, 1_000),
    dbPoolIdleMs: envNum('DB_POOL_IDLE_MS', 300_000, 10_000, 3_600_000),

    browserDefaultBackend: envEnum('BROWSER_BACKEND', ['managed', 'local', 'remote'] as const, 'local'),
    browserExecutable: envStr('BROWSER_EXECUTABLE', ''),
    browserHeadless: envBool('BROWSER_HEADLESS', true),
    browserKeepaliveMs: envNum('BROWSER_KEEPALIVE_MS', 15_000, 5_000, 300_000),
    browserAutoDiscover: envBool('BROWSER_AUTO_DISCOVER', true),
    browserViewportWidth: envNum('BROWSER_VIEWPORT_WIDTH', 1280, 320, 3_840),
    browserViewportHeight: envNum('BROWSER_VIEWPORT_HEIGHT', 800, 240, 2_160),
    browserFrameMaxFps: envNum('BROWSER_FRAME_MAX_FPS', 12, 1, 30),
    browserFrameQuality: envNum('BROWSER_FRAME_QUALITY', 70, 20, 100),
    browserStepShots: envBool('BROWSER_STEP_SHOTS', true),
    browserScreenshotDir: resolveDir('BROWSER_SCREENSHOT_DIR', path.join(envStr('DATA_DIR', 'data'), 'screenshots')),
    browserStreamTokenTtlMs: envNum('BROWSER_STREAM_TOKEN_TTL_MS', 300_000, 30_000, 3_600_000),
    browserMaxPerUser: envNum('BROWSER_MAX_PER_USER', 3, 0, 100),
    browserMaxTotal: envNum('BROWSER_MAX_TOTAL', 8, 0, 100),
    browserIdleCloseMs: envNum('BROWSER_IDLE_CLOSE_MS', 1_800_000, 0, 86_400_000),
    browserReclaimIntervalMs: envNum('BROWSER_RECLAIM_INTERVAL_MS', 60_000, 5_000, 600_000),

    embeddingConnectionId: envStr('EMBEDDING_CONNECTION_ID', ''),
    embeddingBaseUrl: envStr('EMBEDDING_BASE_URL', ''),
    embeddingApiKey: envStr('EMBEDDING_API_KEY', ''),
    embeddingModel: envStr('EMBEDDING_MODEL', ''),
    embeddingDim: envNum('EMBEDDING_DIM', 0, 0, 8_192),
    embeddingBatchSize: envNum('EMBEDDING_BATCH_SIZE', 16, 1, 128),
    embeddingTimeoutMs: envNum('EMBEDDING_TIMEOUT_MS', 15_000, 1_000, 120_000),
    memoryRecallEnabled: envBool('MEMORY_RECALL_ENABLED', true),
    memoryRecallTopK: envNum('MEMORY_RECALL_TOPK', 8, 1, 50),
    memoryRecallMinScore: envNum('MEMORY_RECALL_MIN_SCORE', 0.25, 0, 1),
    memoryRecallBudgetTokens: envNum('MEMORY_RECALL_BUDGET_TOKENS', 600, 100, 4_000),
    memoryRecallTimeoutMs: envNum('MEMORY_RECALL_TIMEOUT_MS', 300, 50, 5_000),
    memoryDigestMode: envEnum('MEMORY_DIGEST_MODE', ['off', 'session', 'all'] as const, 'off'),

    // M34：金融投研（默认关闭；FINANCE_ENABLED=true 后入口与工具才可见）
    financeEnabled: envBool('FINANCE_ENABLED', false),
    financePython: envStr('FINANCE_PYTHON', ''),
    financePyTimeoutMs: envNum('FINANCE_PY_TIMEOUT_MS', 30_000, 1_000, 600_000),
    financePipIndexUrl: envStr('FINANCE_PIP_INDEX_URL', ''),
    financeMinIntervalMs: envNum('FINANCE_MIN_INTERVAL_MS', 0, 0, 60_000),
    financeQuoteRefreshMs: envNum('FINANCE_QUOTE_REFRESH_MS', 10_000, 2_000, 600_000),
    financeKlineSnapshotDir: envStr('FINANCE_KLINE_SNAPSHOT_DIR', 'charts'),
    financeGameMaxPaths: envNum('FINANCE_GAME_MAX_PATHS', 2_000, 1, 10_000),
    financeGameSeed: envNum('FINANCE_GAME_SEED', 20260918, 0),

    // M35：定时任务（默认开启：纯本地零网络；SCHEDULE_ENABLED=false 时 tick 不启动）
    scheduleEnabled: envBool('SCHEDULE_ENABLED', true),
    scheduleTickMs: envNum('SCHEDULE_TICK_MS', 30_000, 5_000, 600_000),
    scheduleTimezone: envStr('SCHEDULE_TZ', ''),
    scheduleMaxPerSession: envNum('SCHEDULE_MAX_PER_SESSION', 20, 1, 200),
    scheduleMinGapMs: envNum('SCHEDULE_MIN_GAP_MS', 5 * 60_000, 60_000),
    scheduleCatchupMs: envNum('SCHEDULE_CATCHUP_MS', 10 * 60_000, 0),
    scheduleFailLimit: envNum('SCHEDULE_FAIL_LIMIT', 3, 1, 10),

    // M57：多用户（滑动 30 天 / 绝对 90 天；锁定 5 次 / 15 分钟；单户并发 2）
    sessionTtlDays: envNum('SESSION_TTL_DAYS', 30, 1, 365),
    sessionAbsoluteTtlDays: envNum('SESSION_ABSOLUTE_TTL_DAYS', 90, 1, 730),
    loginLockoutThreshold: envNum('LOGIN_LOCKOUT_THRESHOLD', 5, 1, 100),
    loginLockoutMs: envNum('LOGIN_LOCKOUT_MS', 15 * 60_000, 10_000, 86_400_000),
    loginRateLimit: envNum('LOGIN_RATE_LIMIT', 10, 1, 1_000),
    runMaxPerUser: envNum('RUN_MAX_PER_USER', 2, 0, 64),
    authCookieSecure: envBool('AUTH_COOKIE_SECURE', false),
    trustProxy: envStr('TRUST_PROXY', ''),
  }

  // M15：旧 PROMPTS_DIR 仍被尊重（作为回退），但提示迁移
  if (process.env.PROMPTS_DIR) {
    warn('PROMPTS_DIR 为旧版配置（角色资产已迁移到 agents/），加载器优先使用 AGENTS_DIR；迁移完成后可移除')
  }

  // 整体断言：内部一致性 + 暴露模式的安全前置条件（M7：BIND_ALL 必须带 token）
  assertConfig(cfg)
  return cfg
}

/** 摘要/裁判模型：未显式配置时复用主模型 */
export function resolveSummaryModel(cfg: AppConfig): string {
  return cfg.summaryModel || cfg.llmModel
}

export function resolveJudgeModel(cfg: AppConfig): string {
  return cfg.judgeModel || cfg.summaryModel || cfg.llmModel
}

/** 成本估算（美元）：单价按每 1K token */
export function estimateCost(
  cfg: AppConfig,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const price = cfg.llmPricing[model] ?? cfg.llmPricing[cfg.llmModel] ?? { prompt: 0, completion: 0 }
  const cost = (promptTokens / 1000) * price.prompt + (completionTokens / 1000) * price.completion
  return Math.round(cost * 1e6) / 1e6
}

/** 读取 .env 示例中未声明的目录（供运维诊断） */
export function describeConfig(cfg: AppConfig): string[] {
  return [
    `LLM: ${cfg.llmModel} @ ${cfg.llmBaseUrl}${cfg.llmMock ? '（LLM_MOCK=true：脚本化 Mock，仅 E2E/离线演示）' : ''}`,
    `上下文预算: ${cfg.contextBudgetTokens} tokens（保留最近 ${cfg.keepRecentTurns} 回合原文）`,
    `角色资产: ${cfg.agentsDir}（并行上限 ${cfg.parallelMax}）`,
    `并发/重试: 并发 ${cfg.llmMaxConcurrency}，重试 ${cfg.llmMaxRetries} 次`,
    `审批模式: ${cfg.approvalMode}${cfg.approvalTools.length ? `（强制审批：${cfg.approvalTools.join('、')}）` : ''}`,
    `数据目录: ${cfg.dataDir}（DB: ${cfg.dbFile}）`,
    `连接中心: 密钥文件 ${cfg.connectionSecretFile}；数据库查询上限 ${cfg.dbQueryMaxRows} 行 / ${cfg.dbQueryTimeoutMs}ms`,
    `联网出口: ${
      cfg.egressMode === 'proxy'
        ? `代理（绑定 ${cfg.egressConnectionId || (cfg.egressProxyUrl ? 'EGRESS_PROXY_URL 后备' : '未配置！')}；通道 ${cfg.egressChannels.join('/') || '无'}；旁路 ${cfg.egressNoProxy.length} 条；回退 ${cfg.egressFallback}）`
        : '直连'
    }`,
    `浏览器: 默认 ${cfg.browserDefaultBackend}${cfg.browserExecutable ? `（可执行 ${cfg.browserExecutable}）` : '（自动发现）'}；默认${cfg.browserHeadless ? '无头' : '打开窗口'}；帧率 ${cfg.browserFrameMaxFps}fps；实例上限 单用户 ${cfg.browserMaxPerUser || '不限'} / 全局 ${cfg.browserMaxTotal || '不限'}；空闲回收 ${cfg.browserIdleCloseMs > 0 ? `${Math.round(cfg.browserIdleCloseMs / 60_000)} 分钟` : '关闭'}`,
    `向量记忆: 召回${cfg.memoryRecallEnabled ? `开启（topK=${cfg.memoryRecallTopK}，阈值 ${cfg.memoryRecallMinScore}，预算 ${cfg.memoryRecallBudgetTokens}t）` : '关闭'}；沉淀 ${cfg.memoryDigestMode}；嵌入 ${
      cfg.embeddingConnectionId
        ? `连接 ${cfg.embeddingConnectionId}`
        : cfg.embeddingModel
          ? `env(${cfg.embeddingModel})`
          : '未配置（休眠）'
    }`,
    `工作区: ${cfg.workspaceDir}${cfg.worktreeDir ? ` / worktrees: ${cfg.worktreeDir}` : ''}`,
    `监听: ${cfg.bindAll ? '0.0.0.0（已启用 AUTH_TOKEN 校验）' : '127.0.0.1'}`,
    `run_command: ${cfg.allowRunCommand ? '开启' : '关闭'}${cfg.allowedRoots.length ? ` / 允许挂载根: ${cfg.allowedRoots.join('、')}` : ''}`,
    `工具按需发现: ${cfg.toolSearchMode}${
      cfg.toolSearchMode === 'auto'
        ? `（阈值：可延迟工具 ≥${cfg.toolSearchMin} 个或 schema ≥${cfg.toolSearchTokenPct}% 预算时启用）`
        : ''
    }；单次最多激活 ${cfg.toolSearchLimit} 个`,
    `MCP JSON 配置: ${cfg.mcpConfigFile}${cfg.mcpConfigPollMs > 0 ? `（每 ${cfg.mcpConfigPollMs / 1000}s 轮询）` : '（轮询关闭）'}`,
    `定时任务: ${cfg.scheduleEnabled ? `开启（tick ${cfg.scheduleTickMs / 1000}s，时区 ${cfg.scheduleTimezone || '服务器默认'}，单会话上限 ${cfg.scheduleMaxPerSession}，最小间隔 ${cfg.scheduleMinGapMs / 60_000} 分钟）` : '关闭'}`,
  ]
}

export function ensureDirSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
}
