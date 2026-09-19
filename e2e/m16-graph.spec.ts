/**
 * E2E · M16 主链路 4：协作图谱视图——接力后边与状态实时更新。
 * 图谱 tab（懒加载 React Flow）→ 初始 7 节点 + 6 条编制虚线 →
 * 完整接力后接力实线去重编制共 10 条 + 「待你指示」→ 全屏点击固定高亮出场接力计数 →
 * 第二轮 @ 单人时节点「发言中」高亮。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('协作图谱：接力边与实时状态随运行更新', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M16-图谱-${Date.now()}` })

  // 1) 图谱 tab：7 节点 + 图例；尚无接力 → 仅 6 条编制虚线
  await page.getByRole('tab', { name: '图谱' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  for (const label of ['实际接力', '最近一棒', '回退接力', '编制预期', '发言中', '排队中']) {
    await expect(page.getByText(label).first()).toBeVisible()
  }
  await expect(page.locator('.react-flow__edge')).toHaveCount(6)

  // 2) 完整接力（无 @ → 费利开棒、链尾兜底）→ 接力边去重编制后共 10 条；最近一棒边琥珀高亮
  await sendMessage(page, '请团队接力完成账单能力的交付，产出落工作区。')
  await expectYourTurn(page)
  await expect(page.locator('.react-flow__edge')).toHaveCount(10)
  await expect(page.getByText('待你指示')).toBeVisible()
  expect(await page.locator('.graph-edge-recent').count()).toBeGreaterThanOrEqual(1)

  // 3) 全屏 + 重新适配后：悬停成员不弹边标签（稳定化），点击费利才固定高亮并显示「接手 N 次」
  await page.getByTitle('全屏查看').click()
  await page.locator('.react-flow__controls-fitview').click()
  const pmNode = page.locator('.react-flow__node', { hasText: '费利' })
  await pmNode.hover()
  await expect(page.locator('.react-flow__edge-textwrapper')).toHaveCount(0)
  await pmNode.click()
  await expect(page.locator('.react-flow__edge-textwrapper').first()).toBeVisible()
  await expect(page.locator('.react-flow__edge-text').first()).toContainText(/接手 1 次/)
  await page.keyboard.press('Escape')

  // 4) 第二轮 @ 诺娃：节点「发言中」实时高亮
  await sendMessage(page, '@诺娃 再看一眼测试计划。')
  await expect(page.locator('.graph-speaking')).toBeVisible({ timeout: 30_000 })
})
