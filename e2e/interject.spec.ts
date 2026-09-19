/**
 * E2E · 主链路 2：插话（mock 模式）。
 * 运行中再发送 = 插话：按钮切换为「插话」，不新建 Run，
 * 团队在回合边界消费（消息出现在流中，最终正常收束）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage, stopButton } from './helpers'

test('插话：运行中发送不新建 Run，团队在回合边界消费', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-插话-${Date.now()}` })
  await sendMessage(page, '请团队接力完成支付能力的交付，产出落工作区。')

  // 运行中：停止按钮出现，发送按钮切换为「插话」
  await expect(stopButton(page)).toBeVisible()
  const insert = page.getByRole('button', { name: '插话' })
  await expect(insert).toBeVisible()

  await composer(page).fill('补充要求：回调必须带签名校验，幂等键放 header。')
  await insert.click()

  // 插话消息立即出现在消息流（服务端返回后本地 upsert，不开启新 Run）
  // 审核 M-7：限定在消息流容器（[role=log]）内断言 —— 避免与侧栏会话摘要 / Composer 文本形成 strict violation
  await expect(
    page.locator('[role="log"]').getByText('补充要求：回调必须带签名校验，幂等键放 header。'),
  ).toBeVisible()

  // 插话不打断链路：团队继续接力直至交还用户
  await expectYourTurn(page)
})
