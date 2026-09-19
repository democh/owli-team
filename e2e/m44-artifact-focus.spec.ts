/**
 * E2E · M44 核心交付锚点（mock 模式）：
 * 单成员（仅 pm）产出需求文档 → 锚定条（AF-1：核心交付 + v1）→ 消息菜单「提意见」（AF-3 模板入草稿）
 * → 发送意见（含「修订走查」触发 → 同文件内容变化 → v2）→ 变更卡回应角标（AF-4）+ v2 徽章（AF-2）
 * → 锚定条未闭环归零 → 收尾签收（AF-5：已签收 v2 草稿）。
 * 锚点：data-focus-bar / data-focus-version / data-focus-open-count / data-change-response /
 * data-delivery-version / data-signoff 属性定位。
 */
import { expect, test } from '@playwright/test'
import { ALL_AGENTS, composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

const UNPICK = ALL_AGENTS.filter((id) => id !== 'pm')
const DOC = 'docs/需求文档-登录.md'

test('M44 · 核心交付锚点：提意见 → 修订闭环 → 签收', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M44-锚点-${Date.now()}`, unpick: UNPICK })
  const log = page.locator('[role="log"]')

  // 第一轮：产出交付件
  await sendMessage(page, '@费利 请输出登录需求文档（含验收标准），落为交付件。')
  await expectYourTurn(page)

  // AF-1：锚定条（核心交付 = 需求文档-登录.md，v1）
  const bar = page.locator('[data-focus-bar]')
  await expect(bar).toHaveAttribute('data-focus-bar', DOC)
  await expect(bar).toContainText('需求文档-登录.md')
  await expect(bar.locator('[data-focus-version]')).toHaveText('v1')

  // AF-3：成员消息菜单「提意见（对交付件）」→ 模板入草稿
  await log.getByRole('button', { name: '消息操作' }).last().click()
  await page.getByRole('menuitem', { name: '提意见（对交付件）' }).click()
  await expect(composer(page)).toHaveValue('@费利 对《需求文档-登录.md》的意见：')

  // 发送意见（含修订触发：mock 内容追加修订段 → 版本库产生 v2）
  await composer(page).fill('@费利 对《需求文档-登录.md》的意见：请补充回滚说明。修订走查')
  await page.getByRole('button', { name: '发送' }).click()
  await expectYourTurn(page)

  // AF-2 / AF-4：变更卡（v2 徽章 + 回应角标）；锚定条未闭环归零、版本升至 v2
  await expect(log.locator('[data-change-response]').first()).toBeVisible()
  await expect(log.locator('[data-delivery-version="2"]').first()).toBeVisible()
  await expect(bar).toHaveAttribute('data-focus-open-count', '0')
  await expect(bar.locator('[data-focus-version]')).toHaveText('v2')

  // AF-5：收尾签收（development）→ 签收回填草稿
  const signoff = page.locator('[data-signoff]')
  await expect(signoff).toHaveAttribute('data-signoff', DOC)
  await expect(signoff.locator('[data-signoff-version]')).toHaveText('v2')
  await signoff.locator('[data-signoff-btn]').click()
  await expect(signoff.locator('[data-signoff-btn]')).toHaveText('已签收 v2')
  await expect(composer(page)).toHaveValue('已签收《需求文档-登录.md》v2。')
})
