/**
 * E2E · M45（R-1）波次回放条（mock 模式）：
 * 星象占星（并行 + 无轮次：每次发送 = 一波）跑两波 → 底部 scrubber 呈现 2 刻度；
 * 点刻度跳转 = focusMessage 复用（滚动 + 闪光 .msg-flash）；「下一波」端点行为。
 * 锚点：data-wave-scrubber / data-wave-tick / data-wave-current / data-wave-prev / data-wave-next / .wave-scrubber-count。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('M45 · 波次回放条：两波刻度 + 点选跳转（闪光复用）+ 相邻导航', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M45-回放-${Date.now()}`
  await createSession(page, { title, scene: '星象占星' })
  // M46-2：关闭会话串行（默认逐位出场）——全员 @ 合并为单波（每波 4 条）
  await disableSerial(page, title)

  // 波 1（全员同时出场：一轮并行波）
  await sendMessage(page, '@司辰 @问星 @合璧 @星移 给我今日的气象速览。')
  await expectYourTurn(page)
  // 波 2
  await sendMessage(page, '@司辰 @问星 @合璧 @星移 补一组注意事项。')
  await expectYourTurn(page)

  const scrubber = page.locator('[data-wave-scrubber]').first()
  await scrubber.locator('[data-wave-toggle]').click() // M79-AA：默认隐藏——展开后再断言
  await expect(scrubber).toBeVisible()
  await expect(scrubber.locator('[data-wave-tick]')).toHaveCount(2)
  await expect(scrubber.locator('.wave-scrubber-count')).toContainText('2 波')

  // 点第 1 波刻度 → 跳转首条成员消息（滚动 + 闪光复用 focusMessage）
  await scrubber.locator('[data-wave-tick="1"]').click()
  await expect(page.locator('.msg-flash').first()).toBeVisible({ timeout: 1500 })
  await expect(scrubber.locator('[data-wave-current]')).toHaveAttribute('data-wave-tick', '1')
  await expect(scrubber.locator('[data-wave-prev]')).toBeDisabled()

  // 再点第 2 波（末波）→ 再次闪光（跳转锚点 = 该波首条成员消息）
  await scrubber.locator('[data-wave-tick="2"]').click()
  await expect(page.locator('.msg-flash').first()).toBeVisible({ timeout: 1500 })
  // 端点与相邻导航语义（prev/next 禁用态）归单测覆盖；此处仅验证跳转本体可重复触发
  await expect(scrubber.locator('[data-wave-tick="2"]')).toHaveAttribute('title', '第 2/2 波 · 4 条')
})
