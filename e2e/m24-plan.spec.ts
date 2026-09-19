/**
 * E2E · M24 协作范式与计划生命周期（mock 模式）：
 * 1) 规划范式：Composer 选「规划」→ 首棒提交 write_plan 挂起（待批准计划卡 + 任务 Tab 徽章）
 *    → 聊天卡「批准并执行」→ 派发执行波按步骤负责人推进（update_plan_step 完成）
 *    → 任务面板 2/2 与「已完成」→ 收口交还用户 → 交付件落盘；
 * 2) 驳回修订路径：驳回带反馈 → 作者依据反馈现场重提 v2（重新挂起待批准）→ 批准执行并收口。
 * 默认执行路径零差异由既有 21 条主链路回归覆盖（本文件仅驱动显式 opt-in 范式）。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

test('规划范式：提交挂起 → 批准并执行 → 步骤完成收口 → 交付件落盘', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M24-规划-${Date.now()}` })

  // 消息级范式：选「规划」仅对下一条消息生效；Composer 明示「仅生效一次」
  await page.getByRole('button', { name: '规划', exact: true }).click()
  await expect(page.getByText('本条以「规划」发送，仅生效一次')).toBeVisible()
  await sendMessage(page, '请规划登录模块的落地方案。')

  // Run 挂起：聊天内计划卡（作者费利提交，待批准；批准前无任何自动执行）
  // 注：工具调用摘要里也含计划 JSON，故标题断言用 exact 精确文本节点
  await expect(page.getByText('提交了协作计划', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('登录协作计划', { exact: true })).toBeVisible()
  await expect(page.getByText('待批准', { exact: true })).toBeVisible()

  // 右栏两级导航（M49）：一级「运行」组（徽标 = 待批准计划数）→ 二级「任务」页签（计划板形态）
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /任务/ }).click()
  await expect(page.getByTitle('1 份计划待批准').first()).toBeVisible()
  await expect(page.getByText('计划 1', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '批准执行' })).toBeVisible()

  // 批准并执行：派发执行波（步骤负责人按序推进）→ 全步完成 → 作者收口交还
  await page.getByRole('button', { name: '批准并执行' }).click()
  await expectYourTurn(page)

  // 计划板终态：进度 2/2 + 「已完成」徽章（步骤行同步完成）
  await expect(page.getByText('2/2', { exact: true })).toBeVisible()
  await expect(page.getByText('已完成').first()).toBeVisible()

  // 步骤产出交付件落盘（首步负责人=架构师，主题=登录）
  await openWorkspace(page, '交付件')
  await expect(page.locator('button[title*="架构设计-登录.md"]')).toBeVisible()
})

test('评审范式（M43 · PK-3）：规划带评审 → 批准执行 → 判定卡 + 三步骤收口', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M43-评审-${Date.now()}` })

  // 规划范式 + 点名「评审」：writePlanCall 追加 review 步骤（优先 qa，排除执行者与规划者）
  await page.getByRole('button', { name: '规划', exact: true }).click()
  await sendMessage(page, '请规划登录模块的落地方案，并安排评审。')

  await expect(page.getByText('提交了协作计划', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('登录协作计划', { exact: true })).toBeVisible()
  await expect(page.getByText('待批准', { exact: true })).toBeVisible()

  // 批准并执行：产出 → 评审（mode=review）→ 汇总 三步波推进 → 收口交还
  await page.getByRole('button', { name: '批准并执行' }).click()
  await expectYourTurn(page)

  // PK-3 判定卡：评审回合命中 ReviewRecord → data-verdict=pass + 目标引用 + 头部判定徽章
  // M52-D 口径：视口贴底跟随 → 会话中部的评审回合滚出虚拟渲染窗口被剪枝（不在 DOM）；
  // 分档滚扫（顶 → 下）直到判定卡挂载后再断言
  const log = page.locator('[role="log"]')
  const card = page.locator('.review-verdict-card').first()
  await expect(async () => {
    for (const top of [0, 240, 480, 720, 960, 1200, 1440, 1680, 1920]) {
      await log.evaluate((el, t) => {
        el.scrollTop = t
        el.dispatchEvent(new Event('scroll'))
      }, top)
      await page.waitForTimeout(200)
      if (await card.isVisible().catch(() => false)) return
    }
    throw new Error('评审判定卡未进入虚拟渲染窗口')
  }).toPass({ timeout: 30_000 })
  await expect(card).toHaveAttribute('data-verdict', 'pass')
  await expect(card.locator('.rvc-target')).toContainText('计划')
  await expect(card.getByText('评审通过')).toBeVisible()

  // 计划板终态：三步全完成（含评审步骤）
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /任务/ }).click()
  await expect(page.getByText('3/3', { exact: true })).toBeVisible()
  await expect(page.getByText('已完成').first()).toBeVisible()
})

test('驳回修订路径：驳回带反馈 → 作者重提 v2 → 批准并收口', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M24-驳回-${Date.now()}` })

  await page.getByRole('button', { name: '规划', exact: true }).click()
  await sendMessage(page, '请规划支付模块的落地方案。')

  // 计划挂起待批准
  await expect(page.getByText('提交了协作计划', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('支付协作计划', { exact: true })).toBeVisible()

  // 驳回并回灌反馈（作者在同回合内现场修订）
  await page.getByRole('button', { name: '驳回', exact: true }).click()
  await page.getByPlaceholder(/驳回反馈/).fill('请补充验收标准与风险对策，再重新提交。')
  await page.getByRole('button', { name: '确认驳回', exact: true }).click()

  // 修订 v2：版本递增 + 标题带修订标记，重新挂起等待批准（同一计划 id，旧态不残留）
  await expect(page.getByText('支付协作计划（已按反馈修订）', { exact: true })).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('v2', { exact: true })).toBeVisible()
  await expect(page.getByText('待批准', { exact: true })).toBeVisible()

  // 批准 v2 → 执行波推进 → 收口交还
  await page.getByRole('button', { name: '批准并执行' }).click()
  await expectYourTurn(page)

  // 任务面板终态确认（一级「运行」组 → 二级「任务」）
  await page.getByRole('tab', { name: '运行' }).click()
  await page.getByRole('tab', { name: /任务/ }).click()
  await expect(page.getByText('2/2', { exact: true })).toBeVisible()
  await expect(page.getByText('已完成').first()).toBeVisible()
})
