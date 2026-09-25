/**
 * E2E · M12 微交互：快捷键帮助 / 接力进度链 / 迷你档案浮层 / 回到底部浮标。
 * 复用主链路的完整接力（mock），在收束后验证静态与滚动交互。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M12 微交互：帮助面板 / 进度链 / 迷你档案 / 回底浮标', async ({ page }) => {
  await openApp(page)

  // 1) ? 打开快捷键帮助（分组 Tab：默认「通用」；「指派语义」随「输入框」页签），Esc 关闭
  await page.keyboard.press('?')
  const help = page.getByRole('dialog')
  await expect(help.getByText('键盘快捷键')).toBeVisible()
  await expect(help.getByRole('tab', { name: '通用' })).toBeVisible()
  await expect(help.getByText('命令面板')).toBeVisible()
  await help.getByRole('tab', { name: '输入框' }).click()
  await expect(help.getByText('指派语义')).toBeVisible()
  await help.getByRole('tab', { name: '画布' }).click()
  await expect(help.getByText('手型工具 / 选择工具')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help.getByText('键盘快捷键')).toBeHidden()

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
  await page
    .getByTitle(/查看 .* 的档案/)
    .first()
    .click()
  const dossier = page.getByRole('dialog')
  await expect(dossier.getByText('最近出手')).toBeVisible()
  await expect(dossier.getByText(/常用交接/)).toBeVisible()
  await expect(dossier.getByText('能力')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dossier).toBeHidden()

  // 5) 回到底部浮标（M85 重设计：仅有未读新消息时浮现——纯图标 + 未读角标；无未读不常显）
  const log = page.locator('[role="log"]')
  const jump = page.getByRole('button', { name: /回到最新/ })
  // 5a) 无新消息：滚到顶部不出现浮标（上滑浏览历史保持界面安静）
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(jump).toHaveCount(0)
  // 5b) 上滑期间新消息抵达（滚动不被打断）→ 浮标浮现 → 点击回底后消失
  // 注：视口在顶部时虚拟列表不挂载底部胶囊，不能用「你的回合」等待——浮标出现本身即信号
  await sendMessage(page, '@雷动 一句话回执即可。')
  await expect(jump).toBeVisible({ timeout: 30_000 })
  await jump.click()
  await expect(jump).toHaveCount(0)
})
