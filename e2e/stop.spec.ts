/**
 * E2E · 主链路 3：停止（mock 模式）。
 * 运行中点「停止」→ Run 收束（stopped），无「你的回合」，
 * 已产出的流式消息标记「已停止」。
 */
import { expect, test } from '@playwright/test'
import { createSession, openApp, sendMessage, stopButton } from './helpers'

test('停止：运行中可中断，消息标记已停止且不再交还', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-停止-${Date.now()}` })
  await sendMessage(page, '请团队接力完成搜索能力的交付，产出落工作区。')

  // 等第一位成员已经在消息区产出（保证有可标记的流式消息）再中断：
  // v66 起 Composer 成员条全场景常驻，「费利」会先命中成员条——必须在 [role="log"] 消息区等消息本体
  const log = page.locator('[role="log"]')
  await expect(stopButton(page)).toBeVisible()
  await expect(log.getByText('费利').first()).toBeVisible()
  await stopButton(page).click()

  // 收束：停止按钮消失，发送按钮恢复；正在输出的消息标记「已停止」
  await expect(stopButton(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible()
  // 未正常收束：不应出现「你的回合」
  await expect(page.getByText('你的回合')).toHaveCount(0)
})

/**
 * M4 · 续写：停止态消息可从消息操作菜单「继续生成」（消息级续写入口）。
 * 续写为轻量 Run：以已产出正文为前缀接着写，完成后回到 complete，不触发调度 / 接力。
 */
test('续写：停止态消息菜单提供「继续生成」，续写 Run 收束不接力', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-续写-${Date.now()}` })
  await sendMessage(page, '请团队接力完成搜索能力的交付，产出落工作区。')

  const log = page.locator('[role="log"]')
  await expect(stopButton(page)).toBeVisible()
  // 等第一棒正文产出（保证停止态消息有可续写内容；空正文会被服务端守卫拒绝）
  await expect(log.getByText('组件我按').first()).toBeVisible()
  await stopButton(page).click()
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible()

  // 消息操作菜单：停止态提供「继续生成」入口（M4）
  const badge = page.getByText('已停止', { exact: true }).first()
  const stoppedRow = badge.locator('xpath=ancestor::div[contains(@class, "group")][1]')
  await stoppedRow.getByLabel('消息操作').click()
  await page.getByRole('menuitem', { name: '继续生成' }).click()

  // 续写 Run 起跑：消息脱离停止态，并再次完整收束（轻量 Run 不触发接力）
  await expect(page.getByText('已停止', { exact: true })).toHaveCount(0, { timeout: 30_000 })
  await expect(stopButton(page)).toHaveCount(0, { timeout: 30_000 })
})
