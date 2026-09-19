/**
 * E2E · 主链路 4：刷新重附着（mock 模式）。
 * 运行中刷新页面 → 重新进入会话 → 运行流重附着（停止按钮回归）、
 * 消息恢复，且运行在服务端继续直至交还用户。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage, stopButton } from './helpers'

test('刷新重附着：执行中刷新页面，会话恢复且运行继续', async ({ page }) => {
  await openApp(page)
  const title = `E2E-重附着-${Date.now()}`
  await createSession(page, { title })
  await sendMessage(page, '请团队接力完成消息能力的交付，产出落工作区。')

  // 等运行确实启动且已有产出（消息区范围——v66 起 Composer 成员条常驻，page 级「费利」会提前命中成员条），再刷新
  const log = page.locator('[role="log"]')
  await expect(stopButton(page)).toBeVisible()
  await expect(log.getByText('费利').first()).toBeVisible()

  await page.reload()

  // 重新进入原会话（列表项点击）
  await page.getByText(title).first().click()

  // 重附着成功：运行仍在进行（停止按钮回归）；既有消息恢复
  // exact：避免与消息导航条（MessageRail）的用户条目「你：…」双匹配（strict mode）
  await expect(stopButton(page)).toBeVisible()
  // M52-D：重进后视口贴底跟随运行，首条用户消息可能已被虚拟列表剪枝（不在 DOM，toBeVisible 落空）；
  // 循环「滚顶 + 短断言」直至首条消息进入渲染窗口（重试覆盖消息加载 / 贴底补正 竞态，与 M14/M37 同口径）
  const first = page.getByText('请团队接力完成消息能力的交付，产出落工作区。', { exact: true })
  await expect(async () => {
    await log.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(first).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  // 回到尾部恢复贴底跟随，继续观察运行收束
  await log.evaluate((el) => {
    el.scrollTop = el.scrollHeight
    el.dispatchEvent(new Event('scroll'))
  })

  // 服务端未中断：运行继续直至团队交还用户
  await expectYourTurn(page)
})
