/**
 * 协议按 scope 裁剪（P0 优化）：全局协议段落用 <segment scope="..."> 标记能力域，
 * 装配时按角色 front-matter 的 tools 白名单过滤——无该能力的角色不注入对应段落
 * （塔罗师不再读 git 纪律），降低 token 成本与指令稀释。
 *
 * 设计要点：
 * - 协议文件保持完整单一事实源（check:agents / m35 等校验仍面向全文）；
 *   裁剪只发生在装配层，是纯函数、可单测；
 * - 未声明 tools 的角色（三态中的 undefined = 全部工具可达）不过滤，行为零差异；
 * - 无 segment 标记的旧协议原文返回（向后兼容）；未知 scope 保守保留（fail-safe）；
 * - 段内裁剪留下空壳的父标签（如 <tool_policy>）不做删除——保留结构骨架利于模型定位。
 */

/** scope → 命中该 scope 的工具名判定（任一命中即保留该段） */
const SCOPE_TOOLS: Record<string, (tools: string[]) => boolean> = {
  git: (tools) => tools.some((t) => t.startsWith('git_')),
  web: (tools) => tools.includes('web_search') || tools.includes('web_fetch'),
  business: (tools) =>
    tools.some((t) => ['calc', 'date_calc', 'csv_analyze', 'template_fill'].includes(t)),
  schedule: (tools) =>
    tools.some((t) => ['schedule_task', 'list_schedules', 'manage_schedule'].includes(t)),
}

const SEGMENT_RE = /<segment\s+scope="([^"]+)"\s*>([\s\S]*?)<\/segment>/g

/**
 * 按角色工具集过滤协议中的 scope 段。
 * @param protocol 协议全文（可含 <segment scope="..."> 块）
 * @param tools 角色 front-matter tools；undefined / 空数组 = 未声明（全部保留）
 */
export function filterProtocolByScopes(protocol: string, tools: string[] | undefined): string {
  if (!protocol.includes('<segment')) return protocol
  if (!tools || tools.length === 0) return protocol
  return protocol.replace(SEGMENT_RE, (whole, scopeAttr: string, _body: string) => {
    const scopes = scopeAttr
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    // 段声明的任一 scope 被该角色命中 → 保留；全部未命中 → 整段剔除
    const keep = scopes.some((scope) => {
      const matcher = SCOPE_TOOLS[scope]
      return matcher ? matcher(tools) : true // 未知 scope 保守保留
    })
    return keep ? whole.replace(/<\/?segment[^>]*>/g, '') : ''
  }).replace(/\n{3,}/g, '\n\n')
}

/** 计量辅助：裁剪前后 token 对比（供报告 / 测试断言用） */
export function scopeFilterReport(
  protocol: string,
  tools: string[] | undefined,
): { kept: boolean; before: number; after: number } {
  const filtered = filterProtocolByScopes(protocol, tools)
  return { kept: filtered !== protocol, before: protocol.length, after: filtered.length }
}
