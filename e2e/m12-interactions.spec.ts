/**
 * E2E · M12 微交互：快捷键帮助 / 接力进度链 / 迷你档案浮层 / 回到底部浮标。
 * 复用主链路的完整接力（mock），在收束后验证静态与滚动交互。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M12 微交互：帮助面板 / 进度链 / 迷你档案 / 回底浮标', async ({ page }) => {
  await openApp(page)

  // 1) ? 打开快捷键帮助，Esc 关闭
  await page.keyboard.press('?')
  await expect(page.getByText('键盘快捷键')).toBeVisible()
  await expect(page.getByText('指派语义')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByText('键盘快捷键')).toBeHidden()

  // 2) 完整接力收束（mock 剧本）
  await createSession(page, { title: `E2E-M12-${Date.now()}` })
  await sendMessage(
    page,
    '请团队接力完成登录能力的完整交付：需求梳理 → 架构设计 → 交互设计 → 前端实现说明 → 接口设计 → 测试计划 → 部署说明。每个角色请把产出落到工作区交付件里。',
  )
  await expectYourTurn(page)

  // 3) 接力进度链：顶部链存在，链尾「你」已交还点亮
  await page.getByRole('tab', { name: '接力' }).click()
  await expect(page.locator('[aria-label="接力进度链"]').first()).toBeVisible()
  await expect(page.getByTitle('已交还给你，等待你的输入')).toBeVisible()

  // 4) 迷你档案：单击成员卡弹出，最近出手 / 常用交接 / 能力 可见
  await page.getByRole('tab', { name: '成员' }).click()
  await page.getByTitle(/查看 .* 的档案/).first().click()
  const dossier = page.getByRole('dialog')
  await expect(dossier.getByText('最近出手')).toBeVisible()
  await expect(dossier.getByText(/常用交接/)).toBeVisible()
  await expect(dossier.getByText('能力')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dossier).toBeHidden()

  // 5) 回到底部浮标：滚到顶部浮现，点击回底后消失
  const log = page.locator('[role="log"]')
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  const jump = page.getByTitle('跳到最新消息')
  await expect(jump).toBeVisible()
  await jump.click()
  await expect(jump).toBeHidden()
})
