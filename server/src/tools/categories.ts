/**
 * M28：工具展示分类（M26 工具中心 / M28 发现区块共用；服务端内置）。
 * db_ / browser_ / ssh_ 前缀与 git_ 前缀优先；MCP 工具按前缀归入 'MCP'。
 */
import { isMcpToolName } from '../mcp/naming.js'

/** 工具分类映射（服务端内置） */
export const TOOL_CATEGORIES: Record<string, string> = {
  list_dir: '文件检索',
  read_file: '文件检索',
  write_file: '文件检索',
  edit_file: '文件检索',
  apply_patch: '文件检索',
  search_text: '文件检索',
  glob: '文件检索',
  grep: '文件检索',
  web_fetch: '联网',
  web_search: '联网',
  calc: '业务',
  date_calc: '业务',
  csv_analyze: '业务',
  template_fill: '业务',
  run_command: '执行',
  remember: '记忆协作',
  handoff: '记忆协作',
  write_todos: '记忆协作',
  load_skill: '记忆协作',
  tool_search: '记忆协作',
  request_approval: '记忆协作',
  write_plan: '范式',
  update_plan_step: '范式',
  submit_review: '范式',
  // M31：画布创作（无限画布读写 / 媒体生成）
  canvas_read: '画布创作',
  canvas_write: '画布创作',
  media_generate: '画布创作',
  media_video: '画布创作',
  // M35：定时任务（会话内调度：创建 / 查看 / 管理）
  schedule_task: '自动化',
  list_schedules: '自动化',
  manage_schedule: '自动化',
  // M34：金融投研（数据 / 量化 12 工具；FINANCE_ENABLED=true 时注册）
  fin_env: '金融数据',
  fin_search: '金融数据',
  fin_quote: '金融数据',
  fin_kline: '金融数据',
  fin_indicator: '金融数据',
  fin_fund: '金融数据',
  fin_fundamental: '金融数据',
  fin_news: '金融数据',
  fin_screen: '金融数据',
  fin_backtest: '金融数据',
  fin_game: '金融数据',
  fin_watch: '金融数据',
  // M51-E：命理排盘（四柱 / 紫微 / 星盘 / 卦；tier=deferred，经 tool_search 激活）
  // M63-B：行运 / 合盘；C：大六壬；D：奇门遁甲；E：七政四余（同组；唯一口径）
  bazi_pan: '命理占星',
  ziwei_pan: '命理占星',
  natal_pan: '命理占星',
  gua_pan: '命理占星',
  transit_pan: '命理占星',
  synastry_pan: '命理占星',
  daliuren_pan: '命理占星',
  qimen_pan: '命理占星',
  qizheng_pan: '命理占星',
  // M69：场景玩法（trpg 掷骰 / tarot 抽牌；tier=deferred，经 tool_search 激活）
  dice_roll: '场景玩法',
  tarot_draw: '场景玩法',
  // M66-A：罗盘排盘（fengshui 堪舆阳宅；tier=deferred，经 tool_search 激活）
  luopan_pan: '命理占星',
  // M66 续完善：择日排盘（fengshui 堪舆阳宅；tier=deferred，经 tool_search 激活）
  zeri_pan: '命理占星',
}

export function toolCategory(name: string): string {
  if (isMcpToolName(name)) return 'MCP'
  if (name.startsWith('git_')) return 'Git'
  if (name.startsWith('db_') || name.startsWith('browser_') || name.startsWith('ssh_')) return '连接自动化'
  return TOOL_CATEGORIES[name] ?? '其它'
}
