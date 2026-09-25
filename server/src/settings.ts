/**
 * 运行期设置（M1 地基，M8 设置面板 / API 消费）：`data/settings.json` 覆盖 env。
 *
 * 规则：
 * - env 是默认值，settings.json 是覆盖层；只有白名单字段可被覆盖（白名单即安全边界）；
 * - 读取时逐字段校验，非法字段丢弃 + 记录告警（一个坏字段不应阻断启动）；
 * - 写入为「读-合并-校验-原子替换」，避免并发/中断产生半截文件；
 * - 覆盖后就地更新 AppConfig（所有持有 cfg 引用的模块下一回合即生效，无需重启）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { assertConfig, configWarnings, type AppConfig } from './config.js'

export const RuntimeSettingsSchema = z.object({
  llmModel: z.string().min(1),
  summaryModel: z.string(),
  judgeModel: z.string(),
  temperature: z.number().min(0).max(2),
  /** 统一温度：开启后忽略角色级配置，全部角色使用上述温度（热切换；角色资产保持差异化不受影响） */
  temperatureOverride: z.boolean(),
  maxTurnsPerRun: z.number().int().min(1).max(100),
  contextBudgetTokens: z.number().int().min(1_000).max(2_000_000),
  keepRecentTurns: z.number().int().min(1).max(50),
  toolResultMaxTokens: z.number().int().min(100).max(100_000),
  toolDetailKeep: z.number().int().min(0).max(50),
  toolTimeoutMs: z.number().int().min(1_000).max(600_000),
  handoffMode: z.enum(['auto', 'tool', 'text']),
  approvalMode: z.enum(['off', 'risky', 'all']),
  approvalTimeoutMs: z.number().int().min(5_000).max(3_600_000),
  allowRunCommand: z.boolean(),
  allowSensitive: z.boolean(),
  notifyPollMs: z.number().int().min(500).max(60_000),
  // M25：向量记忆（嵌入连接热切换 + 召回参数 + 沉淀模式）
  embeddingConnectionId: z.string(),
  memoryRecallEnabled: z.boolean(),
  memoryRecallTopK: z.number().int().min(1).max(50),
  memoryRecallMinScore: z.number().min(0).max(1),
  memoryRecallBudgetTokens: z.number().int().min(100).max(4_000),
  memoryDigestMode: z.enum(['off', 'session', 'all']),
  // M34：金融投研（总开关可在设置面板切换；刷新间隔 / 节流间隔 / 桥超时可选调）
  // 注：启用开关与工具注册在启动时判定（改后需重启）；其余三项由网关 getter 热读，保存即生效
  financeEnabled: z.boolean(),
  financeQuoteRefreshMs: z.number().int().min(2_000).max(600_000),
  financeMinIntervalMs: z.number().int().min(0).max(60_000),
  financePyTimeoutMs: z.number().int().min(1_000).max(600_000),
  // M82：联网出口（热更新；凭据不在本层——代理目标与账号在连接中心 kind='proxy'，本层只存引用与策略）
  egressMode: z.enum(['direct', 'proxy']),
  egressConnectionId: z.string().max(100),
  egressChannels: z.array(z.enum(['search', 'finance', 'browser', 'mcp', 'llm'])).max(5),
  egressNoProxy: z.array(z.string().max(200)).max(200),
  egressFallback: z.enum(['direct', 'fail']),
  egressProbeUrl: z.string().max(500),
})

export type RuntimeSettings = z.infer<typeof RuntimeSettingsSchema>
export type SettingsPatch = Partial<RuntimeSettings>

/** 允许通过设置文件 / API 覆盖的字段（顺序即前端表单推荐顺序） */
export const SETTINGS_FIELDS = Object.keys(RuntimeSettingsSchema.shape) as Array<keyof RuntimeSettings>

function warn(message: string): void {
  if (!configWarnings.includes(message)) configWarnings.push(message)
}

function parseSettings(raw: unknown): { settings: SettingsPatch; warnings: string[] } {
  const warnings: string[] = []
  const settings: SettingsPatch = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { settings, warnings: ['settings.json 顶层必须是对象，已忽略全部覆盖'] }
  }
  const record = raw as Record<string, unknown>
  for (const key of SETTINGS_FIELDS) {
    const value = record[key]
    if (value === undefined) continue
    const parsed = RuntimeSettingsSchema.shape[key].safeParse(value)
    if (parsed.success) {
      ;(settings as Record<string, unknown>)[key] = parsed.data
    } else {
      warnings.push(`settings.json 的 ${key} 非法（${parsed.error.issues[0]?.message ?? '格式错误'}），已忽略`)
    }
  }
  return { settings, warnings }
}

/** 读取覆盖层（文件不存在 / 损坏 → 返回空覆盖，绝不抛错阻断启动） */
export function readSettingsFile(file: string): SettingsPatch {
  if (!fs.existsSync(file)) return {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    const { settings, warnings } = parseSettings(raw)
    for (const message of warnings) warn(message)
    return settings
  } catch (err) {
    warn(`settings.json 解析失败（${(err as Error).message}），本次按 env 默认值运行`)
    return {}
  }
}

/** 写入覆盖层：合并现有内容 → 全量校验 → 原子替换（失败不落盘） */
export function writeSettingsFile(file: string, patch: SettingsPatch): SettingsPatch {
  const merged = { ...readSettingsFile(file), ...patch }
  const { settings, warnings } = parseSettings(merged)
  if (warnings.length > 0) throw new Error(`设置校验失败：${warnings.join('；')}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  return settings
}

/** 把覆盖层叠加到 env 配置（就地更新；启动与 PUT /api/settings 共用同一条路径） */
export function applySettingsToConfig(cfg: AppConfig, settings: SettingsPatch): void {
  const next: AppConfig = { ...cfg, ...settings }
  assertConfig(next)
  Object.assign(cfg, next)
}
