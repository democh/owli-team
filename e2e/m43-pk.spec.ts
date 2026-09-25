/**
 * E2E · M43 多方 PK 范式（§72，mock 模式）：
 * 谈判桌：@谭成 @祁弈 首轮出价 / 还价 → 报价卡（价格键高亮）+ 中轴报价流面板
 * （相邻出价差 ↓30 万，is-down 色标）；M63：报价折线（双方点位）+ 三桩基准线 + 让步刻度。
 * 注：辩论场场景已下线（M-new 精简），谈判桌测试保留；场景工作区流式期间冻结（M52-A 口径），收束后断言。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectRunSettled, openApp, sendMessage } from './helpers'

test('M43 · 谈判桌：报价卡与报价流（让步差值色标）', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M43-谈判-${Date.now()}`
  await createSession(page, { scene: '谈判桌', title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@谭成 @祁弈 就这单采购谈一轮：先各自出价，再逐轮让步看能否成交。')
  await expectRunSettled(page)

  // 中轴报价流面板：首轮出价 98 万 → 对手还价 68 万（↓30 万，is-down 色标）
  const panel = page.locator('[data-insight="offers"]')
  await expect(panel).toBeVisible()
  const items = panel.locator('.scene-offer-item')
  await expect(items.nth(0)).toContainText('98 万')
  await expect(items.nth(1)).toContainText('68 万')
  await expect(panel.locator('.scene-offer-delta.is-down').first()).toContainText('↓30 万')

  // 报价卡（消息内）：标题 / 价格类键高亮（报价行为唯一 is-price 行）
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  const offer = log.locator('.md-offer').first()
  await expect(offer).toBeVisible()
  await expect(offer.locator('.md-offer-kind')).toHaveText('报价')
  await expect(offer.locator('.md-offer-title')).toHaveText(/首轮出价|对手还价/)
  await expect(offer.locator('.md-offer-row.is-price')).toHaveCount(1)

  // M63（G1/G2）：报价走查 → 报价折线（双方点位）+ 三桩基准线 + 让步刻度
  await sendMessage(page, '@谭成 @祁弈 报价走查：出价带齐三桩字段与让步理由。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectRunSettled(page)
  const chart = panel.locator('[data-offer-chart]')
  await expect(chart).toBeVisible()
  // 点数随对话轮次浮动（串行谈判可能多轮交换）——断言下限而非定值
  await expect.poll(async () => chart.locator('.scene-oc-point').count()).toBeGreaterThanOrEqual(4)
  await expect.poll(async () => chart.locator('.scene-oc-base').count()).toBeGreaterThanOrEqual(2)
  await expect(chart.locator('.scene-oc-corridor')).toBeVisible()
  await expect(panel.locator('.scene-conc-item').first()).toBeVisible()
})
