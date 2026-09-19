/**
 * E2E · M40 陪跑渲染包（mock 模式）：
 * 1) 健康生活：打卡走查 → 三轨打卡卡（周网格点格 + streak 徽标）；
 * 2) 学习成长：出题走查 → 每日一练（点选 + 提交回填）；
 * 3) 出行旅行：行程走查 → 行程卡（按天分组 + 今天高亮）；
 * 4) 财富管理：理财走查 → 目标进度环（40% / 53%）+ 记账流水（负数色标）；
 * 5) 个人管理：签到走查 → 情绪签到（档位 + 提交回填）。
 * 锚点：data-tracks-card / data-track / data-day-dot / data-streak / data-quiz-card /
 * data-quiz-option / data-quiz-submit / data-itinerary-card / data-itinerary-day /
 * data-goals-card / data-goal-pct / data-ledger-card / data-ledger-negative /
 * data-mood-card / data-mood-level / data-mood-submit。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M40 · 健康生活：三轨打卡（点格 + streak）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M40-打卡-${Date.now()}`, scene: '健康生活' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@马骁 @陶然 @程眠 打卡走查：把这周的三轨计划过一遍。')
  await expectYourTurn(page)

  const card = log.locator('[data-tracks-card]').first()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-track]')).toHaveCount(3)
  await expect(card.locator('[data-track="训练"]')).toContainText('跑步 3 公里')

  // 点今日格（周网格中的 .is-today）→ 点亮 + streak 徽标（连续 1 天）
  const todayDot = card.locator('[data-track="训练"] [data-day-dot].is-today')
  await todayDot.click()
  await expect(todayDot).toHaveAttribute('aria-pressed', 'true')
  await todayDot.scrollIntoViewIfNeeded()
  await expect(card.locator('[data-track="训练"] [data-streak="1"]')).toBeVisible()
  await expect(card.locator('[data-track="训练"]')).toContainText('连续 1 天')
})

test('M40 · 学习成长：每日一练（点选 + 提交回填）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M40-出题-${Date.now()}`, scene: '学习成长' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@裴知 @洛语 @舒卷 出题走查：出一道每日一练。')
  await expectYourTurn(page)

  const card = log.locator('[data-quiz-card]').first()
  await expect(card).toBeVisible()
  await expect(card).toContainText('每日一练：动词时态')
  await expect(card.locator('[data-quiz-option]')).toHaveCount(4)

  await card.locator('[data-quiz-option="A"]').click()
  await expect(card.locator('[data-quiz-option="A"]')).toHaveClass(/is-picked/)
  await card.locator('[data-quiz-submit]').click()
  await expect(composer(page)).toHaveValue('我的答案：A。请批改并讲解。')
})

test('M40 · 出行旅行：行程卡（按天分组 + 今天高亮）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M40-行程-${Date.now()}`, scene: '出行旅行' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@牧野 行程走查：给一份三日行程。')
  await expectYourTurn(page)

  const card = log.locator('[data-itinerary-card]').first()
  await expect(card).toBeVisible()
  await expect(card.locator('[data-itinerary-day]')).toHaveCount(3)
  // 今天高亮组（mock 日期为动态相对值：昨天 / 今天 / 明天）
  const todayGroup = card.locator('.md-itinerary-day.is-today')
  await expect(todayGroup).toHaveCount(1)
  await expect(todayGroup).toContainText('今天')
  await expect(todayGroup).toContainText('龙井茶园')
})

test('M40 · 财富管理：目标进度环 + 记账流水', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M40-理财-${Date.now()}`, scene: '财富管理' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@钱程 理财走查：看一下目标进度与本月流水。')
  await expectYourTurn(page)

  const goals = log.locator('[data-goals-card]').first()
  await expect(goals).toBeVisible()
  await expect(goals.locator('[data-goal-pct="40"]')).toBeVisible() // 应急金 2.4/6
  await expect(goals.locator('[data-goal-pct="53"]')).toBeVisible() // 旅行基金 8000/1.5万

  const ledger = log.locator('[data-ledger-card]').first()
  await expect(ledger).toBeVisible()
  await expect(ledger.locator('tbody tr')).toHaveCount(3)
  await expect(ledger.locator('[data-ledger-negative="true"]')).toHaveCount(2) // 房租 / 餐饮
})

test('M40 · 个人管理：情绪签到（档位 + 提交回填）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M40-签到-${Date.now()}`, scene: '个人管理' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@于清 @常乐 签到走查：今天做个情绪签到。')
  await expectYourTurn(page)

  const card = log.locator('[data-mood-card]').first()
  await expect(card).toBeVisible()
  await card.locator('[data-mood-level="4"]').click()
  await expect(card.locator('[data-mood-level="4"]')).toHaveClass(/is-picked/)
  await card.locator('[data-mood-submit]').click()
  await expect(composer(page)).toHaveValue('今日状态：4/5（不错）。请据此调整今日建议。')
})
