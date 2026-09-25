/**
 * E2E · M83 K 线分析块（mock 模式）：
 * 「K 线走查」→ 内联 kline 块（bars + analysis + drawings + render，零取数）在真实浏览器渲染：
 * 画布就绪（klinecharts 真实初始化）/ 指标工具条 / 主副图切换 / 阶段色带开关 /
 * 分析面板（阶段徽章 + 关键位 + 口径声明）/ 已有分析不显示「智能分析」。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectRunSettled, openApp, sendMessage } from './helpers'

test('M83 · K 线分析块：工具条 / 阶段色带 / 分析面板渲染', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M83-K线-${Date.now()}`
  await createSession(page, { scene: '投资研究', title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')
  await sendMessage(page, '@雷动 K线走查：输出一条带分析结论的 K 线块。')
  await expectRunSettled(page)

  // 滚到顶部再断言（消息由新到旧渲染）
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })

  const block = log.locator('.md-klineblock')
  await expect(block).toBeVisible()
  // 内联数据零取数：画布真实就绪 + 已有分析 meta
  await expect(block.locator('.md-kline-canvas[data-state="ready"]')).toBeVisible({ timeout: 30_000 })
  await expect(block.locator('.md-block-meta', { hasText: '已分析' })).toBeVisible()

  // 指标工具条：主图（宽容器 chips / 窄容器 select）+ 副图 chips + 阶段开关
  const toolbar = block.locator('.md-kline-toolbar')
  await expect(toolbar).toBeVisible()
  const selects = toolbar.locator('select.md-kline-select')
  if ((await selects.count()) > 0) {
    // compact（窄容器）：主/副图均为 select——切换后取值跟随（零网络）
    const mainSelect = selects.nth(0)
    const subSelect = selects.nth(1)
    await expect(mainSelect).toHaveValue('MA')
    await mainSelect.selectOption('BOLL')
    await expect(mainSelect).toHaveValue('BOLL')
    await subSelect.selectOption('MACD')
    await expect(subSelect).toHaveValue('MACD')
  } else {
    // 宽容器：chips——副图切换 MACD 高亮
    const macd = toolbar.getByRole('button', { name: 'MACD' })
    await expect(macd).toBeVisible()
    await macd.click()
    await expect(macd).toHaveClass(/is-active/)
    // 主图切换：布林高亮（均线束取消）
    const boll = toolbar.getByRole('button', { name: '布林' })
    await boll.click()
    await expect(boll).toHaveClass(/is-active/)
    await expect(toolbar.getByRole('button', { name: '均线束' })).not.toHaveClass(/is-active/)
  }

  // 阶段色带开关：showPhases=true 默认开 → 关 → 开
  const phaseChip = toolbar.getByRole('button', { name: '阶段' })
  await expect(phaseChip).toHaveClass(/is-active/)
  await phaseChip.click()
  await expect(phaseChip).not.toHaveClass(/is-active/)
  await phaseChip.click()
  await expect(phaseChip).toHaveClass(/is-active/)

  // 分析面板：阶段徽章 / 关键位 / 口径声明
  const panel = block.locator('.md-kline-analysis')
  await expect(panel).toBeVisible()
  await expect(panel).toContainText('吸筹')
  await expect(panel).toContainText('支撑')
  await expect(panel).toContainText('104.5')
  await expect(panel).toContainText('规则化统计口径')

  // 已有分析：不显示「智能分析」按钮
  await expect(block.getByTitle(/智能分析/)).toHaveCount(0)
})
