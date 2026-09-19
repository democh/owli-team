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

  // 等第一位成员已经产出（保证有可标记的流式消息）再中断
  await expect(stopButton(page)).toBeVisible()
  await expect(page.getByText('费利').first()).toBeVisible()
  await stopButton(page).click()

  // 收束：停止按钮消失，发送按钮恢复；正在输出的消息标记「已停止」
  await expect(stopButton(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible()
  await expect(page.getByText('已停止', { exact: true }).first()).toBeVisible()
  // 未正常收束：不应出现「你的回合」
  await expect(page.getByText('你的回合')).toHaveCount(0)
})
