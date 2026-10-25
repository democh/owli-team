/**
 * E2E 共享助手（M10）：选择器一律取自组件源码的语义锚点
 * （placeholder / title / role），避免与样式类名耦合；
 * 数据隔离由 playwright.config.ts 的独立 DATA_DIR / WORKSPACE_DIR 保证。
 */
import { expect, type Locator, type Page } from '@playwright/test'

/** 与 client/src/components/chat/Composer.tsx 的 textarea placeholder 对齐（M33：支持拖拽或粘贴图片 / 文档） */
export const COMPOSER_PLACEHOLDER = '输入消息，@ 召唤成员 / 文件 / 技能，/ 使用命令，可直接拖拽或粘贴图片 / 文档…'

/** 成员中文名（与 server/src/llm/mock.ts DISPLAY_NAMES 对齐） */
export const AGENT_NAME: Record<string, string> = {
  // M69：电商经营 / 自媒体工作室 / 个人法务 / 学术论文 / 情感关系
  'category-scout': '探市',
  'listing-optimizer': '炼词',
  'store-operator': '守铺',
  'shop-support': '暖客',
  'account-strategist': '立帜',
  'script-writer': '先声',
  'growth-editor': '借风',
  monetizer: '点金',
  'rights-advisor': '持正',
  'labor-advisor': '守薪',
  'contract-checker': '审微',
  'lit-reviewer': '索隐',
  methodologist: '定矩',
  'paper-editor': '琢稿',
  'submit-advisor': '叩门',
  'rel-coach': '知言',
  'date-coach': '初见',
  mediator: '居间',
  // M69：跑团工坊 / 塔罗研习 / 模拟法庭 / 商业沙盘 / 哲学茶室
  'gm-host': '开卷',
  'scenario-writer': '构幕',
  'npc-player': '入戏',
  'rule-keeper': '执规',
  'tarot-reader': '观照',
  'symbol-narrator': '释象',
  'tarot-historian': '考源',
  'plaintiff-counsel': '申言',
  'defense-counsel': '析辩',
  'presiding-judge': '端衡',
  'socratic-host': '叩问',
  'thought-experimenter': '设境',
  'ethics-moderator': '议善',
  // M69：既有场景补强
  'visa-advisor': '通境',
  'local-curator': '寻巷',
  'insurance-planner': '保宁',
  'big-ticket-advisor': '慎衡',
  'valuation-modeler': '衡价',
  'metric-governor': '正尺',
  'chaos-officer': '试雷',
  'habit-coach': '立习',
  'license-keeper': '执证',
  pm: '费利',
  architect: '艾达',
  designer: '艾瑞',
  frontend: '里奥',
  backend: '马克斯',
  qa: '诺娃',
  devops: '奥托',
  // M18：头脑风暴 / 深度研究
  facilitator: '梅森',
  ideator: '卢娜',
  challenger: '维克多',
  refiner: '索菲',
  lead: '雷蒙',
  scout: '切斯特',
  analyst: '安娜',
  verifier: '薇拉',
  // M21：OPC 业务场景（与 server/src/llm/mock.ts DISPLAY_NAMES 对齐）
  chief: '柏川',
  strategist: '顾远',
  pricing: '赛琳',
  growth: '高扬',
  content: '林悦',
  seo: '韩枫',
  brand: '云舒',
  sales: '陆征',
  success: '安然',
  support: '夏禾',
  finance: '周正',
  tax: '郑清',
  legal: '卢明',
  ops: '齐安',
  assistant: '沐晨',
  recruiter: '罗宾',
  supply: '何舟',
  fundraiser: '江源',
  ir: '何洛',
  'dd-analyst': '卫衡',
  // M-new：心理支持
  'emotion-companion': '听澜',
  'mindfulness-guide': '安屿',
  'psycho-educator': '知澄',
  // v14：全域扩展（生活 6 场景 + 职能角色）
  fitness: '马骁',
  nutrition: '陶然',
  wellness: '程眠',
  tutor: '裴知',
  language: '洛语',
  reading: '舒卷',
  travel: '牧野',
  wealth: '钱程',
  chef: '唐味',
  home: '温居',
  pet: '柯萌',
  parenting: '苗雨',
  coach: '于清',
  'life-admin': '常乐',
  security: '沈盾',
  'tech-writer': '简文',
  'ai-engineer': '凌智',
  'data-engineer': '宋渠',
  'ux-researcher': '闻舒',
  'ux-writer': '白墨',
  insight: '甄明',
  ads: '冯准',
  pr: '颜声',
  social: '苏晴',
  video: '娄映',
  influencer: '米娅',
  localizer: '梁语',
  bd: '秦拓',
  hr: '许澄',
  trainer: '段言',
  compliance: '钟律',
  ip: '乔衡',
  // v15：商业智能场景
  bi: '沈析',
  // M34：投研场景
  'invest-lead': '祝衡',
  'analyst-fa': '秦砚',
  'analyst-ta': '雷动',
  quant: '方程',
  'analyst-news': '闻笛',
  // v16：SRE 场景（站点可靠性）
  sre: '江屿',
  // M50：空场景（通用助手）
  general: '通用助手',
  // M51-A：谈判桌
  negotiator: '谭成',
  counterpart: '祁弈',
  tactician: '苏纵',
  // M51-B：议题圆桌
  moderator: '齐观',
  stakeholder: '方衡',
  'policy-advisor': '允中',
  // M51-C：游戏工坊 / 创作工作室 / 职业发展
  'game-designer': '游心',
  'balance-designer': '千衡',
  'narrative-designer': '织境',
  playtester: '百试',
  storyline: '曲径',
  author: '文藻',
  editor: '锦言',
  publisher: '书远',
  'career-advisor': '程途',
  'resume-coach': '履新',
  'interview-coach': '问达',
  'comp-advisor': '薪言',
  // M51-D：置业安家 / 家庭照护
  'home-finder': '择邻',
  'mortgage-advisor': '家树',
  'reno-designer': '筑居',
  'care-planner': '顾宁',
  'care-escort': '陪安',
  'elder-advisor': '颐和',
  // M51-E：传统数术 / 星象占星
  bazi: '观复',
  ziwei: '星垣',
  liuyao: '灼见',
  daliuren: '溯机',
  meihua: '心易',
  qizheng: '步天',
  qimen: '奇正',
  natal: '司辰',
  transit: '星移',
  synastry: '合璧',
  horary: '问星',
  // M65-A：家装设计工作室
  'interior-designer': '成竹',
  'space-planner': '规方',
  visualizer: '塑光',
  // M66-A：堪舆阳宅
  'plan-surveyor': '察隅',
  'yangzhai-master': '司南',
  // M84：多空对决场
  judge: '顾鉴',
  'bull-lead': '向阳',
  'bear-lead': '知寒',
  'bull-quant': '陆准',
  'bear-quant': '程实',
}

/** 研发团队全体成员 id（场景「研发团队」推荐编制 = 默认预选） */
export const ALL_AGENTS = ['pm', 'architect', 'designer', 'frontend', 'backend', 'qa', 'devops']

/**
 * 打开应用并等待前端挂载（顶栏品牌可见）。
 * 首测冷启动兜底：webServer 首启与 client 构建产物写入存在毫秒级竞态窗口
 * （首个请求可能命中「index.html 尚未落盘」的 ENOENT 响应），重载一次恢复。
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/')
  const brand = page.getByText('Owli Team').first()
  try {
    await expect(brand).toBeVisible({ timeout: 8_000 })
  } catch {
    await page.reload()
    await expect(brand).toBeVisible()
  }
}

/**
 * 新建会话并进入（M50 组队台：点来源行 = 编制整体预选，可点池卡微调）。
 * @param opts.title 会话标题（建议带唯一后缀，避免共享数据目录下重名）
 * @param opts.scene 场景名（默认「研发团队」；可选「头脑风暴」「深度研究」等）
 * @param opts.unpick 要取消勾选的成员 id（默认按来源推荐编制预选）
 */
export async function createSession(
  page: Page,
  opts: { title?: string; scene?: string; unpick?: string[] } = {},
): Promise<void> {
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  // 组队台来源行（aria-label「组队来源：X」与角色池分组 Tab 同名时仍唯一；
  // M66 修订：新增「最近组队」同名行后需 first() 取首行，防 strict-mode 冲突）
  await dialog.getByRole('button', { name: `组队来源：${opts.scene ?? '研发团队'}` }).first().click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  if (opts.title) await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(opts.title)
  for (const id of opts.unpick ?? []) {
    await dialog.getByRole('button', { name: new RegExp(AGENT_NAME[id] ?? id) }).click()
  }
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()
}

/**
 * M21：按「快速组队」预设新建会话并进入（开场指令自动预填为 Composer 草稿）。
 * @param presetName 预设名（如「周经营例会」；左栏快速组队分组）
 * @param opts.title 会话标题（建议带唯一后缀，避免共享数据目录下重名）
 */
export async function createSessionByPreset(
  page: Page,
  presetName: string,
  opts: { title?: string } = {},
): Promise<void> {
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  // 预设行 → 编制按预设预选（可微调）
  await dialog.getByRole('button', { name: `组队来源：${presetName}` }).click()
  await expect(dialog.getByText(`快速组队 · ${presetName}`)).toBeVisible()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await expect(dialog.getByText('开场指令将预填为草稿（点击预览）')).toBeVisible()
  if (opts.title) await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(opts.title)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()
}

/** Composer 文本域 */
export function composer(page: Page): Locator {
  return page.getByPlaceholder(COMPOSER_PLACEHOLDER)
}

/**
 * M46-2：关闭会话「串行执行」（会话级开关默认开启：波次逐位出场）。
 * 并行特性 spec（@≥2 / 场景圆桌）专用——按唯一标题反查刚创建的会话并 PATCH serial: false。
 * @param title 与 createSession / createSessionByPreset 传入的标题完全一致
 */
export async function disableSerial(page: Page, title: string): Promise<void> {
  const list = await page.request.get('/api/sessions')
  const body = (await list.json()) as { sessions: Array<{ id: string; title?: string }> }
  const found = body.sessions.find((s) => s.title === title)
  if (!found) throw new Error(`disableSerial：未找到会话「${title}」`)
  const res = await page.request.patch(`/api/sessions/${found.id}`, { data: { serial: false } })
  if (!res.ok()) throw new Error(`disableSerial 失败：HTTP ${res.status()} ${await res.text()}`)
}

/** 发送（空闲时按钮为「发送」） */
export async function sendMessage(page: Page, text: string): Promise<void> {
  await composer(page).fill(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/** 停止按钮（仅运行中可见） */
export function stopButton(page: Page): Locator {
  return page.getByRole('button', { name: '停止' })
}

/** 等待团队交还控制权（「你的回合」胶囊 = Run 正常收束；并行波次下可能多条 ） */
export async function expectYourTurn(page: Page, timeout = 90_000): Promise<void> {
  await expect(page.getByText('你的回合').first()).toBeVisible({ timeout })
}

/**
 * 等待本轮 run「启动 → 收束」双段完成（M79-K 先例；M79-AG 固化为 helper）。
 * 注意：**不可用「你的回合」作收束信号**——历史胶囊会立即命中（旧 DOM 秒过，
 * 会导致在上一轮仍在途时发起下一次发送：M43 实测第 3 次 fill 被前一轮 submit 的
 * setValue('') 清空 → 发送按钮永久 disabled → click 卡死）。
 * 第一段严格等待「停止」出现（run 未启动 = 发送失败会在此显式暴露，而非误判收束）。
 */
export async function expectRunSettled(page: Page, timeout = 90_000): Promise<void> {
  await expect(stopButton(page)).toBeVisible({ timeout: 15_000 }) // ① run 启动（运行中停止按钮可见）
  await expect(stopButton(page)).toHaveCount(0, { timeout }) // ② 收束（停止消失）
}

/**
 * 抗布局抖动点击（M79-AG）：短超时常规 click → DOM click 兜底。
 * 长套件下元素可能因持续 re-render 而稳定性检查饿死（m31-canvas-ux 菜单项实测）；
 * DOM click 对 disabled 元素不派发（语义安全），点击效果由后续断言校验。
 */
export async function robustClick(locator: Locator, timeout = 5_000): Promise<void> {
  try {
    await locator.click({ timeout })
  } catch {
    await locator.evaluate((el) => (el as HTMLElement).click())
  }
}

/** 审批 pending 卡（由「模型请求审批」标题上溯最近的 rounded-xl 卡片根） */
export function approvalCard(page: Page): Locator {
  return page.locator("xpath=//span[text()='模型请求审批']/ancestor::div[contains(@class,'rounded-xl')][1]")
}

/** 「X 交棒给 Y」交接胶囊（title 属性定位） */
export function handoffChips(page: Page): Locator {
  return page.locator('div[title*="交棒给"]')
}

/** 切换主区 Tab（对话 / 画布；M49 起顶栏常态仅这两个，深度工作台见 openWorkspace） */
export async function switchMainTab(page: Page, name: '对话' | '画布'): Promise<void> {
  await page.getByRole('tab', { name: new RegExp(name) }).click()
}

/**
 * M49（ADR 0100）：展开深度工作台（交付件 / 数据库工作台 / SSH 终端）。
 * 常态顶栏无这些页签 → 命令面板「展开 · X」；窄屏（< 640px）面板按钮隐藏 → Ctrl+K 快捷键。
 */
export async function openWorkspace(page: Page, name: '交付件' | '数据库工作台' | 'SSH 终端'): Promise<void> {
  const trigger = page.getByTitle('命令面板（⌘K）')
  if (await trigger.isVisible().catch(() => false)) await trigger.click()
  else await page.keyboard.press('Control+k')
  await page.getByRole('option', { name: new RegExp(`展开 · ${name}`) }).click()
}

/** M66：从深度工作台返回对话视图（交付件 / 数据库 / SSH 视图的「← 返回对话」）——后续发消息前必经 */
export async function backToChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: '返回对话' }).click()
}
