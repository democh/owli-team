/**
 * E2E · M16 主链路 2：换灵魂后发言风格变化（mock 风格断言）。
 * 仅保留诺娃（qa）→ 首轮默认「铁面」风格 → 成员卡切换「亲和」→
 * system 事件条 + 「会话覆盖」标记 → 再 @ 一轮输出柔和风格。
 */
import { expect, test } from '@playwright/test'
import { ALL_AGENTS, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('换灵魂：默认铁面 → 切亲和，输出风格随之变化', async ({ page }) => {
  await openApp(page)
  await createSession(page, {
    title: `E2E-M16-灵魂-${Date.now()}`,
    unpick: ALL_AGENTS.filter((id) => id !== 'qa'),
  })
  const log = page.locator('[role="log"]')

  // 首轮：qa 默认灵魂 strict（铁面）→ 风格前缀「缺陷计数先行」
  await sendMessage(page, '请审视这次登录交付的质量清单，给个明确结论。')
  await expect(log.getByText('缺陷计数先行')).toBeVisible()
  await expectYourTurn(page)

  // 成员卡：灵魂徽标「铁面」→ 切换「亲和」
  const card = page.locator('[title="查看 诺娃 的档案"]')
  await card.getByRole('button', { name: /铁面/ }).click()
  await card.getByRole('button', { name: /^亲和/ }).click()

  // system 事件条 + 会话覆盖标记
  await expect(log.getByText('诺娃 换上了『亲和』灵魂')).toBeVisible()
  await expect(card.getByText('会话覆盖')).toBeVisible()

  // 再 @ 一轮：输出切换为 friendly 风格
  await sendMessage(page, '@诺娃 复检一遍给出最终结论。')
  await expect(log.getByText('整体很顺！')).toBeVisible()
  await expectYourTurn(page)
})
