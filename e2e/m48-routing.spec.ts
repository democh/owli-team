/**
 * E2E · M48 平台路由（mock 模式，确定性剧本）：
 * 1) 零选择开场：自由组合（0 人）→「空编制创建 · 交给平台组队」提交（participantIds: []）
 *    → 空编制空态引导 → 无 @ 消息 → 平台路由（PRS）召集 费利/艾达/诺娃 并派发首棒（任务便条）
 *    → 成员面板增长（0 → 3）→ 被召集成员接力开工 → 全链收束交还用户 → 交付件 3 份；
 * 2) 组队台预选：场景仅预选推荐编制（7 位研发链，不再含调度官），提交后成员齐备。
 */
import { expect, test } from '@playwright/test'
import { composer, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

test('M48 · 零选择开场：空编制创建，平台自动组队并派发首棒', async ({ page }) => {
  await openApp(page)

  // 建会话：自由组合 → 0 人 →「空编制创建 · 交给平台组队」
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '自由组合' }).click()
  await expect(dialog.getByText('已选 0 位')).toBeVisible()
  await expect(dialog.getByText(/未选成员：首条消息将由平台自动组队并派发任务/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M48-空编制-${Date.now()}`)
  await dialog.getByRole('button', { name: '空编制创建 · 交给平台组队' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()

  // 空编制空态：引导直接描述需求（平台接管组队与派发）
  await expect(page.getByText('直接描述你的需求，平台将自动组队并派发任务')).toBeVisible()
  await expect(page.getByText(/零成员创建：平台会识别你的需求/)).toBeVisible()

  // 无 @ 消息 → 平台路由：召集 pm/architect/qa（费利/艾达/诺娃）并派发首棒给费利
  const log = page.locator('[role="log"]')
  await sendMessage(page, '帮我做一个登录功能，请组织团队完成从需求到测试的完整交付。')
  await expect(log.getByText(/平台 召集了 费利、艾达、诺娃 加入协作/)).toBeVisible({ timeout: 30_000 })

  // 成员面板增长（0 → 3）与端到端接力：被召集的 pm 开工 → qa 收尾交还用户
  await expect(page.locator('[title="查看 费利 的档案"]')).toBeVisible()
  await expect(page.locator('[title="查看 艾达 的档案"]')).toBeVisible()
  await expect(page.locator('[title="查看 诺娃 的档案"]')).toBeVisible()
  await expect(log.getByText(/我先把.*拆一轮/)).toBeVisible({ timeout: 60_000 })
  await expectYourTurn(page)

  // 交付件深度工作台：三位接力成员各 1 份（默认串行下前序产出对后序可见）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 3 个文件/)).toBeVisible()
  for (const path of ['docs/需求文档-登录.md', 'docs/架构设计-登录.md', 'docs/测试计划-登录.md']) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})

test('M48 · 组队台：场景仅预选推荐编制（7 位研发链，无调度官角色）', async ({ page }) => {
  await openApp(page)
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '组队来源：研发团队' }).click()

  // 默认预选 = 7 位研发链（M48：不再前置调度官；有成员时不显示空编制提示）
  await expect(dialog.getByText('已选 7 位')).toBeVisible()
  await expect(dialog.getByText(/未选成员：首条消息将由平台自动组队/)).toHaveCount(0)
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M48-预选-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()

  // 成员视图：7 位研发链齐备
  await page.getByRole('tab', { name: '成员' }).click()
  await expect(page.locator('[title="查看 费利 的档案"]')).toBeVisible()
  await expect(page.locator('[title="查看 奥托 的档案"]')).toBeVisible()
})
