/**
 * E2E · M41 服务型渲染包（mock 模式）：
 * 1) 销售客户：管道走查 → 客户管道看板（四列 + 其他列）→ 点卡回填「跟进 <客户>：」；
 * 2) 财务法务：财务走查 → 测算表卡（关键行）+ 风险色带（高）+ 口径校验徽章（脚本化 calc）；
 * 3) 融资资本：融资走查 → 进度卡（总进度 25%）+ 问答卡（折叠对展开）。
 * 锚点：data-pipeline-card / data-pipeline-col / data-figures-card / data-figure-key /
 * data-risk-band / data-calc-badge / data-progress-card / data-progress-pct / data-qa-card。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M41 · 销售客户：客户管道看板（四列 + 其他列 + 点卡回填）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M41-管道-${Date.now()}`, scene: '销售客户' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@陆征 @安然 @夏禾 管道走查：把本周客户管道与下一动作过一遍。')
  await expectYourTurn(page)

  const board = log.locator('[data-pipeline-card]').first()
  await expect(board).toBeVisible()
  await expect(board.locator('[data-pipeline-col="意向"]')).toContainText('云启科技')
  await expect(board.locator('[data-pipeline-col="报价"]')).toContainText('蓝湾传媒')
  await expect(board.locator('[data-pipeline-col="线索"]')).toContainText('星禾教育')
  await expect(board.locator('[data-pipeline-col="成交"]')).toContainText('恒达物流')
  // 未知阶段（试点）→ 其他列
  await expect(board.locator('[data-pipeline-col="other"]')).toContainText('未来实验室')

  // 点卡 → 跟进草稿（只写草稿不直发）
  await board.locator('[data-pipeline-col="意向"] .md-pipeline-card').first().click()
  await expect(composer(page)).toHaveValue('跟进 云启科技：')
})

test('M41 · 财务法务：测算表 + 风险色带 + 口径校验徽章', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M41-财务-${Date.now()}`, scene: '财务法务' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@周正 @郑清 @卢明 财务走查：给出测算表、风险提示与口径校验。')
  await expectYourTurn(page)

  // FI-1 测算表卡：关键行（费用合计 / 净利额）
  const figures = log.locator('[data-figures-card]').first()
  await expect(figures).toBeVisible()
  await expect(figures).toContainText('营业收入')
  await expect(figures.locator('[data-figure-key="true"]')).toHaveCount(2)
  await expect(figures.locator('[data-figure-key="true"]').first()).toContainText('费用合计')

  // FI-3 风险色带（高）
  const risk = log.locator('[data-risk-band="high"]').first()
  await expect(risk).toBeVisible()
  await expect(risk).toContainText('高风险')
  await expect(risk).toContainText('三流一致性')

  // FI-2 口径校验徽章（脚本化 calc → 已核算 + 表达式 hover）
  const badge = log.locator('[data-calc-badge]').first()
  await expect(badge).toBeVisible()
  await expect(badge).toContainText('已核算')
  await expect(badge).toHaveAttribute('title', '已核算：302000 / 520000 * 100')
})

test('M41 · 融资资本：进度卡 + 问答卡', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M41-融资-${Date.now()}`, scene: '融资资本' })
  const log = page.getByRole('log', { name: '消息流' })

  await sendMessage(page, '@江源 @何洛 融资走查：更新里程碑并准备投资人问答。')
  await expectYourTurn(page)

  // FU-1 进度卡：1/4 完成 → 25%
  const progress = log.locator('[data-progress-card]').first()
  await expect(progress).toBeVisible()
  await expect(progress).toContainText('1/4 完成')
  await expect(progress.locator('[data-progress-pct="25"]')).toBeAttached()
  await expect(progress.locator('[data-progress-state="done"]')).toHaveCount(1)

  // FU-2 问答卡：折叠对展开
  const qa = log.locator('[data-qa-card]').first()
  await expect(qa).toBeVisible()
  const firstRow = qa.locator('details[data-qa-row]').first()
  await expect(firstRow.locator('summary')).toContainText('为什么是这个估值？')
  await firstRow.locator('summary').click()
  await expect(firstRow).toContainText('对标近 6 个月同类交易')
})
