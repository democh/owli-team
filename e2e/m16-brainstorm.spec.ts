/**
 * E2E · M16 主链路 3：头脑风暴场景全链路（并行圆桌波次）。
 * 场景卡片创建（4 人推荐编制）→ @ 全员触发并行首波（场景 parallelMax=4 覆盖全局）
 * → 波内 4 人并行输出 + 并行协作组渲染 → 全波交还用户。
 * M46-2：串行执行默认开启 → 本 spec 验证圆桌并行特性，先显式关闭串行。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('头脑风暴：@ 4 人触达并行圆桌，全员同波输出', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M16-风暴-${Date.now()}`
  await createSession(page, { title, scene: '头脑风暴' })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@梅森 @卢娜 @维克多 @索菲 开一轮圆桌：怎么提升新用户留存？')

  // 并行协作组：成员顺序 + 全部完成
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('梅森、卢娜、维克多、索菲')).toBeVisible()
  await expect(log.getByText('4/4 完成')).toBeVisible()

  // 四人各自剧本 + 默认灵魂风格（facilitator:energetic / ideator:wild 生效）
  await expect(log.getByText('本轮代号「烟花」')).toBeVisible()
  await expect(log.getByText('议题卡立好了')).toBeVisible()
  await expect(log.getByText('兄弟们，脑洞发射')).toBeVisible()
  await expect(log.getByText('一号点子')).toBeVisible()
  await expect(log.getByText('先复述最强版本')).toBeVisible()
  await expect(log.getByText('打分表出来了')).toBeVisible()

  // 全波互认为已发言 → 全员交还用户，单波收束
  await expectYourTurn(page)
})

test('M38 · 研讨容器：阶段条 / 点子卡 / 评分卡渲染 + 汇聚板沉淀与回填', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M38-点子-${Date.now()}`
  await createSession(page, { title, scene: '头脑风暴' })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@梅森 @卢娜 @维克多 @索菲 走查候选点子：点子走查，把点子与打分过一遍。')

  // 阶段分隔条（facilitator）/ 点子卡 ×2（ideator）/ 评分卡（refiner）
  const phase = log.locator('[data-phase-bar]').first()
  await expect(phase).toBeVisible()
  await expect(phase).toContainText('发散期')
  const ideas = log.locator('[data-idea-card]')
  await expect(ideas).toHaveCount(2)
  await expect(ideas.first()).toContainText('免登录体验')
  await expect(ideas.first()).toContainText('候选')
  const score = log.locator('[data-score-card]').first()
  await expect(score).toBeVisible()
  await expect(score).toContainText('280')

  await expectYourTurn(page)

  // 汇聚板（roundtable 右区）：点子池与评分矩阵同组件沉淀
  const aside = page.locator('.scene-rt-aside')
  await expect(aside.locator('[data-idea-card]')).toHaveCount(2)
  await expect(aside.locator('[data-score-card]')).toHaveCount(1)

  // 点亮（本地计数）与「深入」回填（只写草稿不直发）
  await ideas.first().locator('.md-idea-light').click()
  await expect(ideas.first().locator('.md-idea-light')).toContainText('已点亮')
  await ideas.first().locator('.md-idea-dig').click()
  await expect(composer(page)).toHaveValue(/请深入展开点子「免登录体验」/)
})
