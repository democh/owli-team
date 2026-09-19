/**
 * E2E · 面板显隐控制：左钮（单折角箭头）= 主区左缘垂直中部悬浮把手（默认不展示、悬停淡入）；
 * 右钮（面板图标）右对齐于主区头部最右端 / ⌘B · ⌘⇧B / 命令面板 / 刷新持久化。
 *
 * 显隐收敛于主区（不再内嵌在会话 / 团队面板头部）：展开态 = 「隐藏 X 栏」，
 * 点击后原位切换为「显示 X 栏」（常驻双态）；键盘 ⌘B（右）/ ⌘⇧B（左）/ 命令面板同源。
 * 收起 = 该栏分栏卸载（主区独占剩余空间、三栏比例原位记忆），展开 = 原位恢复；
 * 状态存 localStorage（ma:rightPanelOpen / ma:leftPanelOpen），刷新保持。
 * 窄屏为团队 / 会话抽屉（底部成员条 / 顶栏入口），不在本 spec 覆盖（见 m14-responsive）。
 */
import { expect, test } from '@playwright/test'
import { openApp } from './helpers'

/** 右栏一级页签（团队 / 运行 / 实况）——右栏挂载即存在，收起即卸载 */
function teamTab(page: import('@playwright/test').Page) {
  return page.getByRole('tab', { name: '团队', exact: true })
}

test('右栏显隐：中区头部钮 / 刷新持久化 / ⌘B 与命令面板同源', async ({ page }) => {
  await openApp(page)

  // 1) 初始展开：右钮在主区头部最右端（右对齐、紧邻右栏；不在顶栏 / 右栏页签行）
  await expect(teamTab(page)).toBeVisible()
  const teamPanel = page.locator('[data-panel-id="team"]')
  const mainPanel = page.locator('[data-panel-id="main"]')
  const widthBefore = (await teamPanel.boundingBox())?.width ?? 0
  expect(widthBefore).toBeGreaterThan(100)
  const rightBtn = mainPanel.getByTitle('隐藏右栏（⌘B）')
  await expect(rightBtn).toBeVisible()
  // 右对齐：钮右缘距主区右缘 ≈ header 内边距（px-2 = 8px；容差 16px 内即「最右端」）
  const mainBox = await mainPanel.boundingBox()
  const rightBtnBox = await rightBtn.boundingBox()
  const rightGap = (mainBox?.x ?? 0) + (mainBox?.width ?? 0) - ((rightBtnBox?.x ?? 0) + (rightBtnBox?.width ?? 0))
  expect(rightGap).toBeLessThan(16)
  expect(rightGap).toBeGreaterThanOrEqual(0)
  await expect(teamPanel.getByTitle('隐藏右栏（⌘B）')).toHaveCount(0)
  await expect(page.locator('header').getByTitle('隐藏右栏（⌘B）')).toHaveCount(0)
  await expect(page.locator('header').getByTitle('命令面板（⌘K）')).toHaveCount(0)

  // 2) 收起：右栏卸载，钮原位切换为「显示右栏（⌘B）」（常驻入口）
  await mainPanel.getByTitle('隐藏右栏（⌘B）').click()
  await expect(teamTab(page)).toBeHidden()
  await expect(mainPanel.getByTitle('显示右栏（⌘B）')).toBeVisible()

  // 3) 刷新持久化：收起状态保持（localStorage ma:rightPanelOpen=0），钮仍为「显示右栏」
  await page.reload()
  await expect(page.getByText('多 Agent 研发团队').first()).toBeVisible()
  await expect(teamTab(page)).toBeHidden()
  await expect(mainPanel.getByTitle('显示右栏（⌘B）')).toBeVisible()

  // 4) 点击中区钮展开：右栏回到收起前的分栏宽度（原位恢复）
  await mainPanel.getByTitle('显示右栏（⌘B）').click()
  await expect(teamTab(page)).toBeVisible()
  const widthAfter = (await teamPanel.boundingBox())?.width ?? 0
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(4)

  // 5) ⌘B / Ctrl+B：收起 + 再展开（快捷键与中区钮同源）
  await page.keyboard.press('ControlOrMeta+b')
  await expect(teamTab(page)).toBeHidden()
  await page.keyboard.press('ControlOrMeta+b')
  await expect(teamTab(page)).toBeVisible()

  // 6) 命令面板入口同源：⌘K 打开面板 → 「右栏：显示 / 隐藏」收起
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: '右栏：显示 / 隐藏' }).click()
  await expect(teamTab(page)).toBeHidden()
})

test('左栏显隐：左缘中部悬浮把手（悬停淡入）/ 刷新持久化 / ⌘⇧B 与命令面板同源', async ({ page }) => {
  await openApp(page)

  // 1) 初始展开：左钮为主区左缘垂直中部的悬浮把手（默认不展示，悬停左缘热区淡入；不在顶栏 / 会话头部）
  const sessionsPanel = page.locator('[data-panel-id="sessions"]')
  const mainPanel = page.locator('[data-panel-id="main"]')
  await expect(sessionsPanel).toBeVisible()
  const widthBefore = (await sessionsPanel.boundingBox())?.width ?? 0
  expect(widthBefore).toBeGreaterThan(100)
  const leftHandle = mainPanel.getByTitle('隐藏左栏（⌘⇧B）')
  await expect(leftHandle).toHaveCount(1)
  // 非悬浮不展示：初始透明（opacity:0；悬停热区淡入）
  await expect(leftHandle).toHaveCSS('opacity', '0')
  await leftHandle.hover()
  await expect(leftHandle).toHaveCSS('opacity', '1')
  // 位置：贴主区左缘（水平）、垂直居中于主区
  const mainBox = await mainPanel.boundingBox()
  const handleBox = await leftHandle.boundingBox()
  expect((handleBox?.x ?? 0) - (mainBox?.x ?? 0)).toBeLessThan(16)
  const midGap = Math.abs(
    ((handleBox?.y ?? 0) + (handleBox?.height ?? 0) / 2) - ((mainBox?.y ?? 0) + (mainBox?.height ?? 0) / 2),
  )
  expect(midGap).toBeLessThan(24)
  // 移开鼠标后淡出（非悬浮不展示）
  await page.mouse.move(640, 40)
  await expect(leftHandle).toHaveCSS('opacity', '0')
  await expect(sessionsPanel.getByTitle('隐藏左栏（⌘⇧B）')).toHaveCount(0)
  await expect(page.locator('header').getByTitle('隐藏左栏（⌘⇧B）')).toHaveCount(0)

  // 2) 收起：会话列表卸载，钮原位切换为「显示左栏（⌘⇧B）」（常驻入口）
  await mainPanel.getByTitle('隐藏左栏（⌘⇧B）').click()
  await expect(page.locator('[data-panel-id="sessions"]')).toHaveCount(0)
  await expect(mainPanel.getByTitle('显示左栏（⌘⇧B）')).toBeVisible()

  // 3) 刷新持久化：收起状态保持（localStorage ma:leftPanelOpen=0），钮仍在
  await page.reload()
  await expect(page.getByText('多 Agent 研发团队').first()).toBeVisible()
  await expect(page.locator('[data-panel-id="sessions"]')).toHaveCount(0)
  await expect(mainPanel.getByTitle('显示左栏（⌘⇧B）')).toBeVisible()

  // 4) 点击中区钮展开：会话栏回到收起前的分栏宽度（原位恢复）
  await mainPanel.getByTitle('显示左栏（⌘⇧B）').click()
  await expect(page.locator('[data-panel-id="sessions"]')).toBeVisible()
  const widthAfter = (await page.locator('[data-panel-id="sessions"]').boundingBox())?.width ?? 0
  expect(Math.abs(widthAfter - widthBefore)).toBeLessThan(4)

  // 5) ⌘⇧B / Ctrl+Shift+B：收起 + 再展开（快捷键与中区钮同源）
  await page.keyboard.press('ControlOrMeta+Shift+b')
  await expect(page.locator('[data-panel-id="sessions"]')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+Shift+b')
  await expect(page.locator('[data-panel-id="sessions"]')).toBeVisible()

  // 6) 命令面板入口同源：⌘K 打开面板 → 「左栏：显示 / 隐藏」收起
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: '左栏：显示 / 隐藏' }).click()
  await expect(page.locator('[data-panel-id="sessions"]')).toHaveCount(0)
})

test('左右双收：主区独占 + 双钮常驻，逐一展开后左右栏均原位恢复', async ({ page }) => {
  await openApp(page)
  const sessionsPanel = page.locator('[data-panel-id="sessions"]')
  const teamPanel = page.locator('[data-panel-id="team"]')
  const mainPanel = page.locator('[data-panel-id="main"]')
  await expect(sessionsPanel).toBeVisible()
  await expect(teamPanel).toBeVisible()
  const sBefore = (await sessionsPanel.boundingBox())?.width ?? 0
  const tBefore = (await teamPanel.boundingBox())?.width ?? 0

  // 先收右栏（⌘B）再收左栏（⌘⇧B）→ 两栏卸载、双钮常驻（左钮在左缘中部悬浮把手、右钮在头部最右端）
  await page.keyboard.press('ControlOrMeta+b')
  await page.keyboard.press('ControlOrMeta+Shift+b')
  await expect(sessionsPanel).toHaveCount(0)
  await expect(teamPanel).toHaveCount(0)
  await expect(mainPanel.getByTitle('显示左栏（⌘⇧B）')).toBeVisible()
  await expect(mainPanel.getByTitle('显示右栏（⌘B）')).toBeVisible()

  // 逐一展开（先左后右）→ 各栏回到双收前宽度（记账不串位）
  await mainPanel.getByTitle('显示左栏（⌘⇧B）').click()
  await mainPanel.getByTitle('显示右栏（⌘B）').click()
  await expect(teamPanel).toBeVisible()
  const sAfter = (await sessionsPanel.boundingBox())?.width ?? 0
  const tAfter = (await teamPanel.boundingBox())?.width ?? 0
  expect(Math.abs(sAfter - sBefore)).toBeLessThan(4)
  expect(Math.abs(tAfter - tBefore)).toBeLessThan(4)
})
