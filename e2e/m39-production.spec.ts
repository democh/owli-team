/**
 * E2E · M39 生产型渲染包（mock 模式）：
 * 1) 研发流水线：悬浮阶段条换阶段名（qa 波 = 测试 · 阶段 6/7，DEV-1）→ 收尾验收单
 *    （qa 判定徽章 + 未决项，DEV-3）；
 * 2) 营销网格：同波 3 条并行 → 2 列网格（data-wave-grid，MK-1）；
 * 3) SRE 复盘：::: postmortem 复盘卡（分级 / 时间线 / 归因 + 改进项归属，SR-3）。
 * 锚点：data-wave-strip / data-wave-grid / data-qa-verdict / data-qa-unresolved /
 * data-postmortem-card 属性定位（类名/结构不稳定）。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('M39 · 研发流水线：阶段条换阶段名 + 收尾验收单', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M39-研发-${Date.now()}` })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@诺娃 验收走查：给出本轮验收判定与未决项。')
  await expectYourTurn(page)

  // DEV-3 收尾验收单：qa 判定徽章 + 未决项（来自本轮 qa 发言派生）
  await expect(page.locator('[data-qa-verdict="通过"]')).toBeVisible()
  const unresolved = page.locator('[data-qa-unresolved]')
  await expect(unresolved).toBeVisible()
  await expect(unresolved).toContainText('灰度观察 24h 后再推全量')
  await expect(unresolved).toContainText('旧接口下线排期待确认')

  // DEV-1 悬浮阶段条换显示：首个可见行（qa 波）→ 测试 · 阶段 6/7
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  await log.evaluate((el) => {
    el.dispatchEvent(new Event('scroll'))
  })
  const strip = page.locator('[data-wave-strip]')
  await expect(strip).toBeVisible()
  await expect(strip).toHaveAttribute('data-wave-stage', '测试')
  await expect(strip).toContainText('阶段 6/7')
})

test('M39 · 营销网格：同波 3 条并行 → 2 列网格', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M39-营销-${Date.now()}`
  await createSession(page, { title, scene: '市场增长' })
  await disableSerial(page, title)
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@高扬 @林悦 @韩枫 并行拆解：本轮增长目标与内容实验。')
  await expectYourTurn(page)

  // MK-1：同波 2–4 条 → 2 列网格
  const grid = log.locator('[data-wave-grid]')
  await expect(grid).toHaveCount(1)
  await expect(grid.locator('.grid-cols-2')).toBeVisible()
  await expect(grid).toContainText('高扬')
  await expect(grid).toContainText('林悦')
})

test('M39 · SRE 复盘：postmortem 复盘卡渲染', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M39-复盘-${Date.now()}`, scene: '站点可靠性' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@江屿 复盘走查：给出这次登录超时的复盘。')
  await expectYourTurn(page)

  const card = log.locator('[data-postmortem-card]')
  await expect(card).toBeVisible()
  await expect(card).toContainText('故障复盘：登录超时')
  await expect(card).toContainText('分级')
  await expect(card).toContainText('时间线')
  await expect(card).toContainText('连接池配置未随扩容同步')
  const actions = card.locator('[data-postmortem-actions]')
  await expect(actions).toContainText('连接池参数纳入变更检查单')
  await expect(actions).toContainText('马克斯 · 9-30')
})
