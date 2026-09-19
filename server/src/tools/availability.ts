/**
 * M47：运行期工具可用性（环境门控）——「注册」不等于「当前环境可用」。
 *
 * 背景：工具注册表是能力目录（控制台 / 白名单校验 / MCP 可达性共用），但三类工具
 * 在特定环境下调用必然失败：
 * 1. 开关关闭：web_search（WEB_SEARCH_ENABLED）、run_command（ALLOW_RUN_COMMAND）；
 * 2. 白名单为空：web_fetch（WEB_FETCH_ALLOWED_DOMAINS）；
 * 3. 会话模式不支持：git_*（仅 repo / worktree 项目工作区是仓库）。
 * 模型若在工具清单里看到它们就会调用 → 红卡 + 失败率污染 + 浪费子轮。
 *
 * 纪律：本模块是「未启用」提示语的单一事实来源 —— 引擎按它过滤 schema 与可发现范围；
 * 工具执行守卫（web_fetch / web_search / run_command 首行）复用同一文案防漂移。
 */
import type { AppConfig } from '../config.js'

/** git 工具组（仅在「真实仓库」会话模式可见；执行期另有 ensureRepo 守卫） */
export const GIT_TOOL_NAMES = [
  'git_status',
  'git_diff',
  'git_log',
  'git_branch',
  'git_commit',
  'git_restore',
] as const

const GIT_TOOL_SET = new Set<string>(GIT_TOOL_NAMES)

export function isGitToolName(name: string): boolean {
  return GIT_TOOL_SET.has(name)
}

/** 未启用提示（工具执行守卫与引擎过滤共用；文案含开启方式与重启要求） */
export const WEB_SEARCH_DISABLED_SUMMARY =
  'web_search 未启用（需在 .env 配置 WEB_SEARCH_ENABLED=true 后重启；可选 BAIDU_SEARCH_API_KEY 走官方 API）'
export const WEB_FETCH_DISABLED_SUMMARY =
  'web_fetch 未启用（需在 .env 配置 WEB_FETCH_ALLOWED_DOMAINS=域名[,域名] 后重启）'
export const RUN_COMMAND_DISABLED_SUMMARY = 'run_command 已被禁用（需在 .env 设置 ALLOW_RUN_COMMAND=true）'

/**
 * 环境门控：返回未启用原因（undefined = 可用）。
 * git 组不在此判定（依赖会话模式，由引擎按 sessionId 单独过滤）。
 */
export function toolUnavailableReason(name: string, cfg: AppConfig): string | undefined {
  if (name === 'web_search' && !cfg.webSearch.enabled) return WEB_SEARCH_DISABLED_SUMMARY
  if (name === 'web_fetch' && cfg.webFetchAllowedDomains.length === 0) return WEB_FETCH_DISABLED_SUMMARY
  if (name === 'run_command' && !cfg.allowRunCommand) return RUN_COMMAND_DISABLED_SUMMARY
  return undefined
}
