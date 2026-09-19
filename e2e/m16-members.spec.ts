/**
 * E2E · M16 主链路 1：运行中邀请成员（mock 模式）。
 * 接力运行中从「成员」视图邀请卢娜 → system 事件条落流、成员卡即时出现、
 * 新成员在后续回合接棒发言，最终正常交还用户。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('运行中邀请：成员事件条落流，新成员接力发言', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M16-邀请-${Date.now()}` })
  const log = page.locator('[role="log"]')

  // M52-D：邀请链路需在末波选人前落库（mock 整轮 7 波约 2.6–3.6s 收束；晚于末波则无回合，
  // 与 m16-serial 同族竞态）。把一切可提前的动作移出窗口：成员视图不依赖运行态，先切好；
  // 发送后直接走邀请三步（实测负载下「等停止按钮」护栏可耗 ~1.9s，反而把邀请挤出窗口；
  // 「卢娜在后续回合发言」断言本就是邀请达时效性的强校验）
  await page.getByRole('tab', { name: '成员' }).click()

  await sendMessage(page, '请团队接力完成搜索能力的交付，产出落工作区。')

  // 运行中：成员视图底部「邀请成员」→ 选中卢娜 → 邀请 1 位
  await page.getByRole('button', { name: '邀请成员' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('邀请成员')).toBeVisible()
  await dialog.getByRole('button', { name: /卢娜/ }).click()
  await dialog.getByRole('button', { name: /邀请 1 位/ }).click()
  await expect(dialog).toBeHidden()

  // 落库 system 事件条（inviter = 首位成员费利）+ 成员卡即时出现
  await expect(log.getByText('费利 邀请了 卢娜 加入协作')).toBeVisible()
  await expect(page.locator('[title="查看 卢娜 的档案"]')).toBeVisible()

  // 新成员在后续回合接棒（devops→designer→backend→卢娜 兜底接力）并交还用户
  await expect(log.getByText('一号点子')).toBeVisible({ timeout: 60_000 })
  await expectYourTurn(page)
})
