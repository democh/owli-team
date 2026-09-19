/**
 * E2E · M46-2 串行执行（会话级开关，默认开启）：
 * 1) 默认串行：@ 两人不并行（无并行协作组）→ 逐位出场两回合 → 全链交还用户；
 *    任务面板「串行执行」芯片显示已开；
 * 2) 关闭串行：任务面板点按芯片（PATCH serial: false）→ 再 @ 两人触发并行协作组。
 * 与 m16-parallel（显式关闭串行）互补：默认路径走本 spec，并行特性走 m16-parallel。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('默认串行：@ 两人逐位出场，无并行协作组', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M46-串行-${Date.now()}` })
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@费利 @艾达 先对一下这次支付改造的口径。')

  // M52-D：运行中视口贴底跟随，早期回合行滚出虚拟渲染窗口即被剪枝（不在 DOM，toBeVisible 落空）；
  // 先等收束（消息全量在手），再滚顶让前两回合进入渲染窗口后断言（与 m16-parallel / 关闭串行 同口径）
  await expectYourTurn(page)
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })

  // 首位（费利）独立出场：无并行协作组
  await expect(log.getByText('按「目标 → 用户故事 → 验收标准」拆一轮')).toBeVisible()
  await expect(log.getByText('并行协作')).toHaveCount(0)

  // 次位（艾达）后续出场：仍无并行协作组
  await expect(log.getByText('接口契约')).toBeVisible()
  await expect(log.getByText('并行协作')).toHaveCount(0)

  // 全链收束已在滚顶前确认（expectYourTurn）；此处不再重复断言「你的回合」（滚顶后收束行可能在渲染窗口外）

  // 任务面板（右栏一级「运行」组 → 二级「任务」）：串行执行芯片默认开启
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /任务/ }).click()
  await expect(page.getByRole('button', { name: /串行执行已开/ })).toBeVisible()
})

test('关闭串行：任务面板点按芯片 → @ 两人并行成波', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M46-切并行-${Date.now()}` })

  // 任务面板 → 串行执行芯片（默认开启）→ 点按关闭（一级「运行」组 → 二级「任务」）
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /任务/ }).click()
  const chip = page.getByRole('button', { name: /串行执行已开/ })
  await expect(chip).toBeVisible()
  await chip.click()
  await expect(page.getByText('已关闭「串行执行」')).toBeVisible()
  // 芯片文案回落（不再显示「已开」）
  await expect(page.getByRole('button', { name: /串行执行已开/ })).toHaveCount(0)

  // 发送 @ 两人 → 并行协作组（与 m16-parallel 同断言口径）
  const log = page.locator('[role="log"]')
  await sendMessage(page, '@费利 @艾达 先对一下这次支付改造的口径。')

  // M52-D：运行中视口贴底跟随，第 0 波并行组滚出虚拟渲染窗口即被剪枝（不在 DOM，toBeVisible 落空）；
  // 先等收束（消息全量在手），再滚顶让并行组进入渲染窗口后断言（与 m16-parallel 同口径）
  await expectYourTurn(page)
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('费利、艾达')).toBeVisible()
  await expect(log.getByText('2/2 完成')).toBeVisible()
})
