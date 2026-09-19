/**
 * E2E · M16 主链路 5：@ 两人并行——双消息并发流式与并行组渲染。
 * @费利 @艾达 触发首波 2 人并行（fan-out）→ 并行协作组 + 双份流式输出 →
 * 后续串行波浪消化剩余成员，最终交还用户。
 * M46-2：串行执行默认开启（波次逐位出场）→ 本 spec 验证并行特性，先显式关闭串行。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('@ 两人并行：同波双流式与并行组渲染', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M16-并行-${Date.now()}`
  await createSession(page, { title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@费利 @艾达 先对一下这次支付改造的口径。')

  // 波次收敛：后续串行波浪消化剩余成员后交还用户
  // M52-D：运行中视口贴底跟随，第 0 波并行组滚出虚拟渲染窗口即被剪枝（不在 DOM，toBeVisible 落空）；
  // 先等收束（消息全量在手），再滚顶让并行组进入渲染窗口后断言（与 M14/M37 同口径）
  await expectYourTurn(page)
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })

  // 并行组：2 人同波、完成后进度 2/2
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('费利、艾达')).toBeVisible()
  await expect(log.getByText('2/2 完成')).toBeVisible()

  // 双份剧本输出（pm / architect 各自台词）
  await expect(log.getByText('按「目标 → 用户故事 → 验收标准」拆一轮')).toBeVisible()
  await expect(log.getByText('接口契约')).toBeVisible()
})
