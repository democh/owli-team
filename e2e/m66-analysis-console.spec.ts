/**
 * E2E · M66 分析域（mock 模式）：
 * 1) 商业智能（dock·console）：指标走查 → 指标区（kpi 五列含口径徽章）+ 取数链（SQL ×N 徽章）；
 * 2) 站点可靠性（dock·console）：事故走查 → 事故时间轴（P0/P1/P2 分级 + 筛选 chips）+ SLO 区
 *    （kpi 复用指标卡）；通用「活动时间轴」让位不重复；
 * 3) 议题圆桌（roundtable·pool）：立场走查 → 立场泳道（两立场方）+ 共识分歧板（三列）沉淀。
 * 注：场景工作区流式期间冻结（M52-A 口径），收束后断言；发送后确认草稿清空（防共享环境点击丢失）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('M66 · 商业智能：指标走查 → 指标卡（口径徽章）+ 取数链', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M66-BI-${Date.now()}`
  await createSession(page, { scene: '商业智能', title })
  await disableSerial(page, title)

  await sendMessage(page, '@沈析 指标走查：给出指标卡与取数链。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)

  const kpis = page.locator('[data-console-kpis]')
  await expect(kpis).toBeVisible()
  await expect(kpis.locator('.scene-kpi-cell')).toHaveCount(2)
  await expect(kpis.locator('.md-kpi-scope').first()).toContainText('口径')
  const sqls = page.locator('[data-console-sql]')
  await expect(sqls).toBeVisible()
  await expect(sqls.locator('.scene-sql-run').first()).toContainText('SQL ×1')
})

test('M66 · 站点可靠性：事故走查 → 分级时间轴（筛选）+ SLO 区', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M66-SRE-${Date.now()}`
  await createSession(page, { scene: '站点可靠性', title })
  await disableSerial(page, title)

  await sendMessage(page, '@江屿 事故走查：输出分级时间轴与 SLO。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)

  const incidents = page.locator('[data-console-incidents]')
  await expect(incidents).toBeVisible()
  await expect(incidents.locator('.scene-incident-row')).toHaveCount(4)
  await expect(incidents.locator('.scene-incident-row[data-level="p0"]')).toHaveCount(2)
  await expect(incidents.locator('.scene-incident-badge.is-p0').first()).toHaveText('P0')
  // 筛选：P0 → 仅 2 条
  await incidents.locator('.scene-incident-chip').nth(1).click()
  await expect(incidents.locator('.scene-incident-row')).toHaveCount(2)
  // SLO 区（kpi 复用指标卡；通用时间轴让位）
  await expect(page.locator('[data-console-slo]')).toContainText('SLO / 错误预算')
  await expect(page.getByText('活动时间轴')).toHaveCount(0)
})

test('M66 · 议题圆桌：立场走查 → 立场泳道 + 共识分歧板', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M66-圆桌-${Date.now()}`
  await createSession(page, { scene: '议题圆桌', title })
  await disableSerial(page, title)

  await sendMessage(page, '@方衡 @齐观 立场走查：出立场卡与共识分歧板。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)

  const lanes = page.locator('[data-pool-stance]')
  await expect(lanes).toBeVisible()
  await expect(lanes.locator('.scene-stance-lane')).toHaveCount(2)
  await expect(lanes.locator('.md-stance[data-stance-card]')).toHaveCount(2)
  const board = page.locator('[data-pool-split]')
  await expect(board).toBeVisible()
  await expect(board.locator('.md-split-col')).toHaveCount(3)
})
