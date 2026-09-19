/**
 * E2E · M38 研讨容器（研究域）：::: sources 来源卡（域名 chip + 可信度徽章）与 ::: claim 论断卡渲染、
 * 来源墙在 roundtable 汇聚板沉淀、点「引用」回填草稿（ADR 0144 / 0145）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('M38 · 来源卡与论断卡：渲染 + 来源墙沉淀 + 引用回填', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M38-来源-${Date.now()}`
  await createSession(page, { title, scene: '深度研究' })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@雷蒙 @切斯特 @安娜 @薇拉 走查来源：来源走查，核对来源与结论。')

  // 来源卡（scout）：域名 chip + 可信度徽章；论断卡（verifier）
  const sources = log.locator('[data-sources-card]').first()
  await expect(sources).toBeVisible()
  await expect(sources).toContainText('example.org')
  await expect(sources).toContainText('高可信')
  const claim = log.locator('.md-claim').first()
  await expect(claim).toBeVisible()
  await expect(claim).toContainText('核查结论')

  await expectYourTurn(page)

  // 来源墙（roundtable 右区）沉淀 + 「引用」回填草稿（只写草稿不直发）
  const aside = page.locator('.scene-rt-aside')
  await expect(aside.locator('[data-sources-card]')).toHaveCount(1)
  await sources.locator('.md-source-quote').first().click()
  await expect(composer(page)).toHaveValue(/引用来源《行业年度报告（公开版）》/)
})
