/**
 * E2E · M27 MCP 接入与管理（mock 模式，不依赖真实 LLM）：
 * 1) MCP 管理：新建 stdio 服务器（指向 server/tests/fixtures/echo-mcp.mjs 夹具）→ 测试连接 ok → 工具注入；
 * 2) 绑定当前会话（最小权限）；工具清单展开：授权矩阵命中——M50 起通用助手（blank/general）以 mcp__* 通配恒命中，
 *    「N 个工具零可达」警示对新增服务器不再出现（用例按新语义反向断言 + 矩阵命中徽章；§59.5 遗留说明兑现）；
 * 3) Agent 管理：新建角色 → 工具页 MCP 服务器组整组勾选（写 mcp__<slug>__* 通配）→ 保存；
 * 4) 回 MCP 管理：授权矩阵命中（零可达警示保持不出现、新建角色命中徽章出现）；
 * 5) 禁用（工具注销）→ 删除（断连 + 解绑级联）；清理新建角色（软删除 + 回收站兜底）。
 *
 * 资产使用唯一前缀 e2e-mcp-<ts>：afterAll 仅清理含本次前缀的目录与回收站条目，绝不触碰既有资产。
 * 管理台写入的 MCP 服务器在成功路径由用例内删除；失败残留因前缀唯一不影响后续运行。
 */
import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { createSession, openApp } from './helpers'

const PREFIX = `e2e-mcp-${Date.now()}`
const SLUG = PREFIX // 服务器 slug（^[a-z][a-z0-9-]{0,39}$）
const AGENT_ID = `${PREFIX}-agent`
const AGENT_NAME = `E2E MCP 角色 ${PREFIX}`
const GROUP_ID = 'development' // 研发团队（真实资产目录）

const REPO_ROOT = process.cwd()
/** stdio 启动参数：夹具绝对路径（服务器 cwd 缺省为应用根目录，绝对路径两种情形均可达） */
const FIXTURE_PATH = path.join(REPO_ROOT, 'server', 'tests', 'fixtures', 'echo-mcp.mjs')

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

/** 递归删除空目录（软删除移走内容后残留的空壳；仅删空目录，非空自动跳过） */
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
  const dir = path.join(REPO_ROOT, 'agents', GROUP_ID, AGENT_ID)
  if (path.basename(dir).includes(PREFIX)) fs.rmSync(dir, { recursive: true, force: true })
  for (const hit of trashHits()) {
    if (path.basename(hit).includes(PREFIX)) fs.rmSync(hit, { recursive: true, force: true })
  }
  for (const root of TRASH_ROOTS) pruneEmptyDirs(root)
})

test('M27 · MCP：新建服务器 → 连接 → 绑定 → 通配授权翻绿 → 禁用/删除级联', async ({ page }) => {
  await openApp(page)
  // 绑定需要当前会话：先建会话（默认研发团队编制，不引入新角色）
  await createSession(page, { title: `E2E MCP 会话 ${PREFIX}` })

  // ---------- 1) MCP 管理：新建 stdio 服务器（指向夹具） ----------
  await page.getByRole('button', { name: 'MCP 管理' }).click()
  await expect(page.getByRole('button', { name: '新建服务器' })).toBeVisible()
  await page.getByRole('button', { name: '新建服务器' }).click()
  const editor = page.getByRole('dialog', { name: '新建 MCP 服务器' })
  await editor.getByLabel('服务器名').fill(SLUG)
  await editor.getByLabel('展示名').fill(`E2E 回声 ${PREFIX}`)
  await editor.getByLabel('启动命令').fill('node')
  await editor.getByLabel('命令参数').fill(FIXTURE_PATH)
  await editor.getByRole('button', { name: '创建' }).click()
  await expect(page.getByText(`服务器「${SLUG}」已创建，点「测试」建立连接并注入工具`)).toBeVisible()
  await expect(editor).toBeHidden()

  const card = page.locator('article', { hasText: SLUG })
  await expect(card).toHaveCount(1)
  await expect(card.getByTitle('未连接', { exact: true })).toBeVisible()

  // ---------- 2) 测试连接：真连 fixture 子进程 → 工具注入（6 个） ----------
  await card.getByRole('button', { name: '测试' }).click()
  await expect(page.getByText(new RegExp(`「${SLUG}」连接成功`))).toBeVisible()
  await expect(card.getByTitle(/^已连接/)).toBeVisible()
  await expect(card.getByText('工具 · 6')).toBeVisible()
  // M50 起通用助手以 mcp__* 通配恒命中 → 新服务器工具均可达，零可达警示不出现
  await expect(card.getByText(/\d+ 个工具零可达/)).toBeHidden()

  // 工具清单展开：注册名注入 + 授权矩阵命中（通用助手通配徽章，非「零角色可达」）
  await card.getByRole('button', { name: '工具清单' }).click()
  await expect(card.getByText(`mcp__${SLUG}__echo`)).toBeVisible()
  await expect(card.getByText(`mcp__${SLUG}__write_note`)).toBeVisible()
  await expect(card.getByText('零角色可达')).toHaveCount(0)
  await expect(card.locator('span[title^="general"]').first()).toBeVisible()

  // ---------- 3) 绑定当前会话（最小权限） ----------
  await card.getByRole('button', { name: '绑定' }).click()
  await expect(page.getByText(`已绑定「${SLUG}」到当前会话`)).toBeVisible()
  await expect(card.getByRole('button', { name: '解绑', exact: true })).toBeVisible()

  // ---------- 4) Agent 管理：新建角色 → 工具页整组勾选 MCP 服务器（通配） ----------
  await page.getByRole('button', { name: 'Agent 管理' }).click()
  await page.getByRole('button', { name: '新建 Agent' }).click()
  const wizard = page.getByRole('dialog', { name: /新建 Agent/ })
  await wizard.getByRole('radio', { name: /研发团队/ }).click()
  await wizard.getByRole('button', { name: '下一步' }).click()
  await wizard.getByLabel('角色 id').fill(AGENT_ID)
  await wizard.getByLabel('角色名').fill(AGENT_NAME)
  await wizard.getByLabel('角色徽标').fill('MCP 联调')
  await wizard.getByRole('button', { name: '创建' }).click()
  await expect(page.getByText(`角色「${AGENT_NAME}」已创建`)).toBeVisible()
  const agentEditor = page.getByRole('dialog', { name: `编辑角色 ${AGENT_ID}` })
  await agentEditor.getByRole('tab', { name: '工具' }).click()
  await agentEditor.getByRole('switch', { name: '限制工具白名单' }).click()
  const mcpGroup = agentEditor.locator('button[aria-pressed]').filter({ hasText: `mcp__${SLUG}__*` })
  await expect(mcpGroup).toBeVisible()
  await mcpGroup.click()
  await expect(mcpGroup).toHaveAttribute('aria-pressed', 'true')
  await agentEditor.getByRole('button', { name: '保存' }).click()
  await expect(page.getByText(`角色「${AGENT_NAME}」已保存（下一回合生效）`)).toBeVisible()
  await expect(agentEditor).toBeHidden()

  // ---------- 5) 回 MCP 管理：授权矩阵命中（零可达警示保持不出现 + 新建角色徽章出现） ----------
  await page.getByRole('button', { name: 'MCP 管理' }).click()
  const card2 = page.locator('article', { hasText: SLUG })
  await expect(card2).toHaveCount(1)
  await expect(card2.getByText(/个工具零可达/)).toBeHidden()
  await card2.getByRole('button', { name: '工具清单' }).click()
  await expect(card2.locator(`span[title^="${AGENT_ID}"]`).first()).toBeVisible()

  // ---------- 6) 禁用：工具注销（快照清空） ----------
  await card2.getByRole('switch', { name: `启用 ${SLUG}` }).click()
  await expect(page.getByText(`「${SLUG}」已禁用（工具已注销）`)).toBeVisible()
  await expect(card2.getByText('工具 · 0')).toBeVisible()

  // ---------- 7) 删除：断连 + 注销工具 + 解绑全部会话（含 window.confirm 确认） ----------
  page.once('dialog', (dialog) => void dialog.accept())
  await card2.getByTitle('删除服务器（断开连接 + 注销工具 + 解绑全部会话）').click()
  await expect(page.getByText('服务器已删除')).toBeVisible()
  await expect(page.locator('article', { hasText: SLUG })).toHaveCount(0)

  // ---------- 8) 清理：新建角色软删除（afterAll 回收站兜底） ----------
  await page.getByRole('button', { name: 'Agent 管理' }).click()
  await page.getByLabel('搜索角色').fill(AGENT_ID)
  const agentCard = page.locator('article', { hasText: AGENT_ID })
  await expect(agentCard).toHaveCount(1)
  await agentCard.getByTitle('删除（软删除到回收站）').click()
  const deleteDialog = page.getByRole('dialog', { name: `删除角色「${AGENT_NAME}」` })
  await deleteDialog.getByRole('button', { name: '移入回收站' }).click()
  await expect(page.getByText(`「${AGENT_NAME}」已移入回收站`)).toBeVisible()
  await expect(page.locator('article', { hasText: AGENT_ID })).toHaveCount(0)
})
