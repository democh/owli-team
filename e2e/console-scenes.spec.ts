/**
 * E2E · 批六 console 面板二批（mock 模式）：
 * 1) 销售客户：「管道走查」→ 客户管道段（阶段列 + 金额合计 + 未知归「其他」）；
 * 2) 电商经营：「店铺走查」→ 经营指标段（kpi）+ 大促节奏段（timeline）；
 * 3) 市场增长：内容脚本自带 timeline → 内容节奏段（owner 徽标）；
 * 4) 个人法务：「案件走查」→ 案件时间线段 + 主张与依据段（claim 条目与依据）；
 * 5) 融资资本：「融资走查」→ 融资进度段（与消息卡同组件）+ 投资人问答段。
 * 锚点：data-console-pipeline / data-pipe-stage / scene-pipe-total / data-console-kpis /
 * data-console-rhythm / scene-rhythm-owner / data-console-claims / scene-claimcell-* /
 * data-console-progress / data-console-qa。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('批六 · 销售客户：客户管道段（阶段列 + 金额合计）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-B6-管道-${Date.now()}`, scene: '销售客户' })

  await sendMessage(page, '@陆征 @安然 @夏禾 管道走查：把本周客户管道过一遍。')
  await expectYourTurn(page)

  const sec = page.locator('[data-console-pipeline]').first()
  await expect(sec).toBeVisible()
  await expect(sec.locator('[data-pipe-stage="意向"]')).toContainText('云启科技')
  await expect(sec.locator('[data-pipe-stage="意向"] .scene-pipe-total')).toHaveText('¥12.8万')
  await expect(sec.locator('[data-pipe-stage="other"]')).toContainText('未来实验室')
  await expect(sec.locator('[data-pipe-stage="成交"]')).toContainText('恒达物流')
})

test('批六 · 电商经营：经营指标 + 大促节奏', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-B6-电商-${Date.now()}`, scene: '电商经营' })

  await sendMessage(page, '@守铺 @探市 @炼词 @暖客 店铺走查：看经营指标与大促节奏。')
  await expectYourTurn(page)

  const kpis = page.locator('[data-console-kpis]').first()
  await expect(kpis).toBeVisible()
  await expect(kpis).toContainText('经营指标')
  await expect(kpis).toContainText('GMV')

  const rhythm = page.locator('[data-console-rhythm]').first()
  await expect(rhythm).toBeVisible()
  await expect(rhythm).toContainText('大促节奏')
  await expect(rhythm.locator('.scene-rhythm-row')).toHaveCount(3)
  await expect(rhythm.locator('.scene-rhythm-owner').first()).toHaveText('蓄水')
})

test('批六 · 市场增长：内容节奏（内容脚本 timeline）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-B6-市场-${Date.now()}`, scene: '市场增长' })

  await sendMessage(page, '@林悦 @高扬 排期：把内容节奏排一下。')
  await expectYourTurn(page)

  const rhythm = page.locator('[data-console-rhythm]').first()
  await expect(rhythm).toBeVisible()
  await expect(rhythm).toContainText('内容节奏')
  await expect(rhythm.locator('.scene-rhythm-row').first()).toContainText('案例拆解')
  await expect(rhythm.locator('.scene-rhythm-owner').first()).toHaveText('林悦')
})

test('批六 · 个人法务：案件时间线 + 主张与依据', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-B6-法务-${Date.now()}`, scene: '个人法务' })

  await sendMessage(page, '@持正 @审微 @守薪 案件走查：梳理时间线与主张。')
  await expectYourTurn(page)

  const rhythm = page.locator('[data-console-rhythm]').first()
  await expect(rhythm).toBeVisible()
  await expect(rhythm).toContainText('案件时间线')
  await expect(rhythm.locator('.scene-rhythm-owner').first()).toHaveText('节点')

  const claims = page.locator('[data-console-claims]').first()
  await expect(claims).toBeVisible()
  await expect(claims.locator('.scene-claimcell-title')).toHaveText('主张与依据')
  await expect(claims.locator('.scene-claimcell-item')).toHaveCount(2)
  await expect(claims.locator('.scene-claimcell-evidence').first()).toContainText('劳动合同法第四十条')
})

test('批六 · 融资资本：融资进度 + 投资人问答（与消息卡同组件）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-B6-融资-${Date.now()}`, scene: '融资资本' })

  await sendMessage(page, '@江源 @何洛 融资走查：更新里程碑与问答。')
  await expectYourTurn(page)

  const prog = page.locator('[data-console-progress]').first()
  await expect(prog).toBeVisible()
  await expect(prog).toContainText('1/4 完成')
  await expect(prog.locator('[data-progress-card]')).toBeAttached()

  const qa = page.locator('[data-console-qa]').first()
  await expect(qa).toBeVisible()
  await expect(qa.locator('[data-qa-card]')).toBeAttached()
  await expect(qa).toContainText('为什么是这个估值？')
})
