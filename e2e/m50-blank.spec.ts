/**
 * E2E · M50 空场景（mock 模式，确定性剧本）：
 * 组队台「空场景」独立卡（单 Agent · 1 位成员）→ 预选 [general] 创建进入
 * → 空态资产（guide + 议程 chips，点击预填不直发——仅验可见）
 * → 无 @ 消息直达通用助手（零 PRS：反向断言无「平台 召集了 …」事件条）
 * → 独立完成产出（docs/交付件-财务.md）→ 全链收束交还用户（你的回合 + 交还事件）。
 */
import { expect, test } from '@playwright/test'
import { composer, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

test('M50 · 空场景：单助手直聊（零召集 / 独立完成 / 交还用户）', async ({ page }) => {
  await openApp(page)

  // 建会话：组队台「空场景」独立卡 → 预选 1 位（通用助手）
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('单 Agent · 1 位成员')).toBeVisible()
  await dialog.getByRole('button', { name: '组队来源：空场景' }).click()
  await expect(dialog.getByText('已选 1 位')).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M50-空场景-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入（1 位成员）' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()

  // 空态：blank 资产 guide + 议程 chips
  await expect(page.getByText('直接说出你的需求，由通用助手独立完成')).toBeVisible()
  await expect(page.getByText('推荐开场')).toBeVisible()
  await expect(page.getByRole('button', { name: '起草文档', exact: true })).toBeVisible()

  // 无 @ 消息 → 单助手直通：通用助手直接开工（「我来独立完成」）
  const log = page.locator('[role="log"]')
  await sendMessage(page, '整理一份财务数据快报：营收 120 万、成本 68 万、现金流为正。')
  await expect(log.getByText(/我来独立完成/)).toBeVisible({ timeout: 30_000 })

  // 收尾：交还用户（你的回合 + 交还事件条）；反向断言本 Run 无平台召集（零 PRS）
  await expectYourTurn(page)
  await expect(page.locator('[title*="交还给用户"]')).toBeVisible()
  await expect(log.getByText(/平台 召集了 .+ 加入协作/)).toHaveCount(0)

  // 成员：仅通用助手 1 位
  await page.getByRole('tab', { name: '成员' }).click()
  await expect(page.locator('[title="查看 通用助手 的档案"]')).toBeVisible()

  // 交付件：单助手 1 份产出（docs/交付件-财务.md）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 1 个文件/)).toBeVisible()
  await expect(page.locator('button[title="docs/交付件-财务.md"]')).toBeVisible()
})
