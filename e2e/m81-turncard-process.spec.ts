/**
 * E2E · M81 TurnCard 过程区（mock 模式）：
 * 1) 过程走查 → `::: process` 完成态默认收起为一行摘要，点击展开可见过程文本；
 * 2) 顶层上提 —— 过程块位于消息正文之前（过程区顺序：思考 → 工具 → 过程 → 正文）。
 * 顺序纪律（m54 教训）：先等收束再定位；overscan=8 下短回合全部渲染，无需滚动定位。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M81 · 过程走查：::: process 完成态默认收起 + 点击展开', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '心理支持', title: `E2E-M81-过程-${Date.now()}` })

  await sendMessage(page, '@听澜 过程走查：最近一直在加班，心里发紧。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)

  const block = page.locator('.md-process').first()
  await expect(block).toBeVisible()
  await expect(block.locator('.md-process-summary')).toContainText('过程记录')
  // 完成态：折叠体不渲染（默认收起）
  await expect(block.locator('.md-process-body')).toHaveCount(0)
  // 点击展开 → 过程文本可见
  await block.locator('.md-process-summary').click()
  await expect(block.locator('.md-process-body')).toBeVisible()
  await expect(block.locator('.md-process-body')).toContainText('线索只来自用户说过的话')
})

test('M81 · 上提：过程块位于正文之前（过程区顺序）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '心理支持', title: `E2E-M81-上提-${Date.now()}` })

  await sendMessage(page, '@听澜 过程走查：想先说说最近的状态。')
  await expect(composer(page)).toHaveValue('')
  await expectYourTurn(page)

  const scope = page.locator('.md-body:has(.md-process)').first()
  await expect(scope).toBeVisible()
  const order = await scope.evaluate((el) => {
    const kids = Array.from(el.children)
    const proc = kids.findIndex((n) => n.classList.contains('md-process'))
    const p = kids.findIndex((n) => n.tagName === 'P')
    return { firstIsProcess: proc === 0, procBeforeP: proc >= 0 && p > proc }
  })
  expect(order.firstIsProcess).toBe(true)
  expect(order.procBeforeP).toBe(true)
})
