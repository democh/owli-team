/**
 * E2E · M26 资产控制台（mock 模式）：
 * 1) ActivityRail 进入 Skill 管理 → 新建 Skill → 编辑器保存（PUT /skills/:name）；
 * 2) Agent 管理新建向导（研发团队 + 基本信息）→ 编辑器「技能」页绑定该 Skill、
 *    「工具」页开启白名单并勾选 read_file → 保存；
 * 3) 建会话「配成员」选择器可见新角色（仅验证，不创建会话，避免引入成员引用）；
 * 4) 编辑改名 → 卡片徽章（工具 · 1 / 技能 · 1）更新；
 * 5) 软删除 Agent / Skill → 断言落盘回收站（data 下 trash/assets 时间戳目录）→ 列表移除；
 * 6) 资产校验徽章：通过（展开 → 重新校验）。
 *
 * 资产使用唯一前缀 e2e-<ts>：真实 agents/ 与 skills/ 目录是唯一事实源，
 * afterAll 仅清理含本次唯一前缀的目录与回收站条目，绝不触碰既有资产。
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { openApp } from './helpers'

/** 本次运行唯一前缀（符合 ID_RE：小写字母开头 + 数字/连字符，≤40 字符） */
const PREFIX = `e2e-${Date.now()}`
const SKILL_NAME = `${PREFIX}-skill`
const AGENT_ID = `${PREFIX}-agent`
const AGENT_NAME = `E2E 质检员 ${PREFIX}`
const AGENT_NAME_EDITED = `${AGENT_NAME}（改）`
const GROUP_ID = 'development' // 研发团队（真实资产目录）
const SKILL_DESC = 'E2E 控制台链路校验用技能（用例结束自动清理）'

const REPO_ROOT = process.cwd()
/** 数据目录 slug 跟随 PW_DATA_DIR（与 playwright.config 的 webServer env 同源；轮换目录时回收站同轨） */
const DATA_SLUG = process.env.PW_DATA_DIR || 'e2e-main'
/** 回收站候选根：当前 e2e 隔离目录优先；兼容复用本机开发服务器（DATA_DIR=data）的情形 */
const TRASH_ROOTS = [
  path.join(REPO_ROOT, 'data', DATA_SLUG, 'trash', 'assets'),
  path.join(REPO_ROOT, 'data', 'trash', 'assets'),
]

/** 回收站中本次前缀条目的绝对路径（自顶向下，命中前缀目录/文件即不再深入） */
function trashHits(): string[] {
  const hits: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 回收站目录不存在（本次运行尚未发生软删除）
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.name.includes(PREFIX)) hits.push(full)
      else if (entry.isDirectory()) walk(full)
    }
  }
  for (const root of TRASH_ROOTS) walk(root)
  return hits
}

/** 递归删除空目录（软删除移走内容后残留的 <时间戳>/agents/... 空壳；仅删空目录，非空自动跳过） */
function pruneEmptyDirs(dir: string): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name))
  }
  try {
    if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir)
  } catch {
    // 非空（其它条目）/ 权限：保持原样
  }
}

/** 仅清理含本次唯一前缀的条目（防误删护栏：路径 basename 必须含 PREFIX） */
test.afterAll(() => {
  for (const dir of [path.join(REPO_ROOT, 'agents', GROUP_ID, AGENT_ID), path.join(REPO_ROOT, 'skills', SKILL_NAME)]) {
    if (path.basename(dir).includes(PREFIX)) fs.rmSync(dir, { recursive: true, force: true })
  }
  for (const hit of trashHits()) {
    if (path.basename(hit).includes(PREFIX)) fs.rmSync(hit, { recursive: true, force: true })
  }
  for (const root of TRASH_ROOTS) pruneEmptyDirs(root)
})

test('M26 · 资产控制台：新建 Skill / Agent → 建会话可见 → 编辑 → 软删除 → 校验通过', async ({ page }) => {
  await openApp(page)

  // ---------- 1) Skill 管理：新建技能 → 编辑器保存 ----------
  await page.getByRole('button', { name: 'Skill 管理' }).click()
  await expect(page.getByText(/^\d+ 个技能$/)).toBeVisible()
  await page.getByRole('button', { name: '新建 Skill' }).click()
  const createSkillDialog = page.getByRole('dialog', { name: '新建 Skill' })
  await createSkillDialog.getByLabel('技能名').fill(SKILL_NAME)
  await createSkillDialog.getByLabel('技能说明').fill(SKILL_DESC)
  await createSkillDialog.getByRole('button', { name: '创建并编辑' }).click()

  // 创建成功 → 直接进入编辑器抽屉；保存一次覆盖 PUT /skills/:name
  const skillDrawer = page.getByRole('dialog', { name: `编辑技能 ${SKILL_NAME}` })
  await skillDrawer.getByLabel('技能描述').fill(`${SKILL_DESC} · v2`)
  await skillDrawer.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(`技能「${SKILL_NAME}」已保存`)).toBeVisible()
  await expect(skillDrawer).toBeHidden()

  // ---------- 2) Agent 管理：新建向导（研发团队 + 基本信息） ----------
  await page.getByRole('button', { name: 'Agent 管理' }).click()
  await expect(page.getByText(/^\d+ 个角色 · \d+ 个场景$/)).toBeVisible()
  await page.getByRole('button', { name: '新建 Agent' }).click()
  const wizard = page.getByRole('dialog', { name: /新建 Agent/ })
  await wizard.getByRole('radio', { name: /研发团队/ }).click()
  await wizard.getByRole('button', { name: '下一步' }).click()
  await wizard.getByLabel('角色 id').fill(AGENT_ID)
  await wizard.getByLabel('角色名').fill(AGENT_NAME)
  await wizard.getByLabel('角色徽标').fill('质量评审')
  await wizard.getByRole('button', { name: '创建' }).click()

  // 创建成功 → 自动打开编辑器
  await expect(page.getByText(`角色「${AGENT_NAME}」已创建`)).toBeVisible()
  const editor = page.getByRole('dialog', { name: `编辑角色 ${AGENT_ID}` })
  await expect(editor.getByRole('tab', { name: '技能' })).toBeVisible()

  // 技能页：三态选「指定技能清单」→ 勾选本次新建技能
  await editor.getByRole('tab', { name: '技能' }).click()
  await editor.getByRole('radio', { name: /指定技能清单/ }).click()
  const skillOption = editor.locator('button[aria-pressed]').filter({ hasText: SKILL_NAME })
  await expect(skillOption).toBeVisible()
  await skillOption.click()
  await expect(skillOption).toHaveAttribute('aria-pressed', 'true')

  // 工具页：开启白名单 → 勾选 read_file（File 检索 · 只读）
  await editor.getByRole('tab', { name: '工具' }).click()
  await editor.getByRole('switch', { name: '限制工具白名单' }).click()
  const toolOption = editor.locator('button[aria-pressed]').filter({ hasText: 'read_file' })
  await expect(toolOption).toBeVisible()
  await toolOption.click()
  await expect(toolOption).toHaveAttribute('aria-pressed', 'true')

  // 保存（tools/skills 落盘 → 服务端热更新 + notify:assets-changed）
  await editor.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(`角色「${AGENT_NAME}」已保存（下一回合生效）`)).toBeVisible()
  await expect(editor).toBeHidden()

  // ---------- 3) 建会话「组队台」：新角色出现在角色池（仅验证，不创建） ----------
  await page.getByRole('button', { name: '工作台' }).click()
  await page.getByTitle('新建会话').click()
  const sessionDialog = page.getByRole('dialog')
  await sessionDialog.getByRole('button', { name: '组队来源：研发团队' }).click()
  await expect(sessionDialog.getByText('已选 7 位')).toBeVisible()
  await expect(sessionDialog.getByText(AGENT_NAME)).toBeVisible()
  await sessionDialog.getByRole('button', { name: '关闭' }).click()
  await expect(sessionDialog).toBeHidden()

  // ---------- 4) 编辑：改角色名 → 卡片与徽章更新 ----------
  await page.getByRole('button', { name: 'Agent 管理' }).click()
  await page.getByLabel('搜索角色').fill(AGENT_ID)
  const card = page.locator('article', { hasText: AGENT_ID })
  await expect(card).toHaveCount(1)
  await card.getByTitle('编辑').click()
  const editor2 = page.getByRole('dialog', { name: `编辑角色 ${AGENT_ID}` })
  await editor2.getByLabel('角色名').fill(AGENT_NAME_EDITED)
  await editor2.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(`角色「${AGENT_NAME_EDITED}」已保存（下一回合生效）`)).toBeVisible()
  await expect(editor2).toBeHidden()
  await expect(card.getByText(AGENT_NAME_EDITED)).toBeVisible()
  await expect(card.getByText('工具 · 1')).toBeVisible()
  await expect(card.getByText('技能 · 1')).toBeVisible()

  // ---------- 5) 软删除 Agent：列表移除 + 回收站落盘 ----------
  await card.getByTitle('删除（软删除到回收站）').click()
  const deleteDialog = page.getByRole('dialog', { name: `删除角色「${AGENT_NAME_EDITED}」` })
  await deleteDialog.getByRole('button', { name: '移入回收站' }).click()
  await expect(page.getByText(`「${AGENT_NAME_EDITED}」已移入回收站`)).toBeVisible()
  await expect(page.locator('article', { hasText: AGENT_ID })).toHaveCount(0)
  await expect
    .poll(() => trashHits().some((p) => p.endsWith(AGENT_ID)), {
      message: '回收站应包含本次删除的角色目录',
    })
    .toBe(true)

  // ---------- 6) 删除 Skill（Agent 已删，无引用直删）→ 回收站落盘 ----------
  await page.getByRole('button', { name: 'Skill 管理' }).click()
  await page.getByLabel('搜索技能').fill(SKILL_NAME)
  await expect(page.getByTitle('删除（软删除到回收站）')).toHaveCount(1)
  await page.getByTitle('删除（软删除到回收站）').click()
  const delSkillDialog = page.getByRole('dialog', { name: `删除技能「${SKILL_NAME}」` })
  await delSkillDialog.getByRole('button', { name: '移入回收站' }).click()
  await expect(page.getByText(`技能「${SKILL_NAME}」已移入回收站`)).toBeVisible()
  await expect
    .poll(() => trashHits().some((p) => p.endsWith(SKILL_NAME)), {
      message: '回收站应包含本次删除的技能目录',
    })
    .toBe(true)

  // ---------- 7) 资产校验：全部通过 ----------
  const banner = page.getByRole('button', { name: '资产校验通过' })
  await expect(banner).toBeVisible()
  await banner.click()
  await page.getByRole('button', { name: '重新校验' }).click()
  await expect(page.getByText('全部资产通过校验（front-matter / 引用 / 目录结构）')).toBeVisible()
})
