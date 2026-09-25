/**
 * E2E · M85 画布 K 线节点渲染（防回归线）：
 * 「K 线块 → 送上画布 → 节点」全链——此前空白事故（klinecharts 内根 height:100%
 * 在 flex auto 拉伸链上解析失败→尺寸固化 24px→主图面高度 0）就发生在这条无覆盖的路径上。
 * 断言：① 节点就绪 ② 画布容器「确定高度链」成立（clientHeight ≥ 120）
 * ③ 像素级非空（任一 canvas 存在非白非透明绘制像素——高度塌陷时必为空白）。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectRunSettled, openApp, sendMessage, switchMainTab } from './helpers'

test('M85 · 画布 K 线节点：送上画布链路渲染（尺寸链 + 像素非空）', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M85-节点-${Date.now()}`
  await createSession(page, { scene: '投资研究', title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')
  await sendMessage(page, '@雷动 K线走查：输出一条带分析结论的 K 线块。')
  await expectRunSettled(page)
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  const block = log.locator('.md-klineblock')
  await block.locator('.md-kline-canvas[data-state="ready"]').waitFor({ timeout: 30_000 })
  await block.locator('button[title^="送上画布"]').click()
  await switchMainTab(page, '画布')

  const node = page.locator('.react-flow__node').last()
  await expect(node).toBeVisible({ timeout: 15_000 })
  await expect(node.locator('.md-kline-canvas[data-state="ready"]')).toBeVisible({ timeout: 30_000 })
  await page.waitForTimeout(800)

  // ① 确定高度链：画布容器必须有可用高度（旧 bug：内根固化 24px 时容器被 min-height 撑着但图面为 0）
  const h = await node.locator('.md-kline-canvas').evaluate((el) => (el as HTMLElement).clientHeight)
  expect(h).toBeGreaterThanOrEqual(120)

  // ①b 无空行回归：工具条容器与画布之间不得出现被 grid 行错配吃掉的空白（曾现 ~130px 空条）
  const gap = await node.evaluate((root) => {
    const bars = root.querySelector('.md-kline-bars')
    const canvas = root.querySelector('.md-kline-canvas')
    if (!bars || !canvas) return -1
    return Math.round(canvas.getBoundingClientRect().top - bars.getBoundingClientRect().bottom)
  })
  expect(gap).toBeGreaterThanOrEqual(-2)
  expect(gap).toBeLessThanOrEqual(8)

  // ② 像素级非空：任一 canvas 存在非白非透明绘制像素（空白图必失败）
  const painted = await node.evaluate((root) => {
    const list = Array.from(root.querySelectorAll('canvas')) as HTMLCanvasElement[]
    for (const c of list) {
      if (c.width === 0 || c.height === 0) continue
      const ctx = c.getContext('2d')
      if (!ctx) continue
      const data = ctx.getImageData(0, 0, c.width, c.height).data
      let hits = 0
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]!
        if (a > 10 && !(data[i]! > 245 && data[i + 1]! > 245 && data[i + 2]! > 245)) {
          hits++
          if (hits > 50) return true
        }
      }
    }
    return false
  })
  expect(painted).toBe(true)
})
