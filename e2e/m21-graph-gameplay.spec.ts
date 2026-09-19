/**
 * E2E · M21 图谱游戏化（协作图谱 2.0）：
 * 拖动节点自由摆放 → 整理布局平滑归位 → 圆桌布局（中心图腾）→
 * 点击成员滑出档案面板（战绩 / 工作产出 / 操作行）→ @ 召唤写入输入框 → Esc 收面板 → 切回接力链。
 * 画布底噪：无 MiniMap、无 React Flow 水印。
 * 与 m16-graph 互补：m16 覆盖「接力边 / 状态实时性 / 悬停稳定化」，m21 覆盖「游戏化交互层」。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, openApp } from './helpers'

test('图谱游戏化：拖动 · 整理 · 圆桌 · 档案面板 · 召唤', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M21-图谱-${Date.now()}` })

  // 1) 进入图谱：接力链布局 7 节点 + dock 操作（整理 / 圆桌 / 导演镜头）+ HUD 战况
  await page.getByRole('tab', { name: '图谱' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await expect(page.getByTitle('整理布局')).toBeVisible()
  await expect(page.getByTitle('圆桌布局')).toBeVisible()
  await expect(page.getByTitle('导演镜头：跟随发言者')).toBeVisible()
  await expect(page.getByText('成员 7').first()).toBeVisible()

  // 1.5) 画布底噪：MiniMap 与 React Flow 水印已移除
  await expect(page.locator('.react-flow__minimap')).toHaveCount(0)
  await expect(page.locator('.react-flow__attribution')).toHaveCount(0)

  // 稳定视口（无手动偏移时「整理布局」= fitView）
  await page.getByTitle('整理布局').click()
  await page.waitForTimeout(700)

  // 2) 拖动「费利」：节点随指针移动（屏幕位移 > 30px）
  const pm = page.locator('.react-flow__node', { hasText: '费利' })
  const before = (await pm.boundingBox())!
  const cx = before.x + before.width / 2
  const cy = before.y + before.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + 60, cy + 30, { steps: 6 })
  await page.mouse.move(cx + 200, cy + 140, { steps: 12 })
  await page.mouse.up()
  const dragged = (await pm.boundingBox())!
  expect(Math.hypot(dragged.x - before.x, dragged.y - before.y)).toBeGreaterThan(30)

  // 3) 整理布局：清除手动偏移，平滑回弹到自动布局
  await page.getByTitle('整理布局').click()
  await page.waitForTimeout(900)
  const tidied = (await pm.boundingBox())!
  expect(Math.hypot(tidied.x - dragged.x, tidied.y - dragged.y)).toBeGreaterThan(30)

  // 4) 圆桌布局：8 节点（7 成员 + 中心图腾），图腾显示场景与在场人数
  await page.getByTitle('圆桌布局').click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  const core = page.locator('.react-flow__node-core')
  await expect(core).toHaveCount(1)
  await expect(core).toContainText('研发团队')
  await expect(core).toContainText('7 位成员')

  // 5) 点击「费利」：档案面板滑出（战绩三格 + 操作行）
  await page.locator('.react-flow__node', { hasText: '费利' }).click()
  const dossier = page.getByRole('complementary', { name: '费利 档案' })
  await expect(dossier).toBeVisible()
  for (const label of ['接手', '交出', '发言']) {
    await expect(dossier.getByText(label, { exact: true })).toBeVisible()
  }
  // 工作产出区（无交付件 → 空态）
  await expect(dossier.getByText('工作产出')).toBeVisible()
  await expect(dossier.getByText('暂无产出')).toBeVisible()
  await expect(dossier.getByTitle('聚焦该成员（相机居中）')).toBeVisible()
  await expect(dossier.getByTitle('拍一拍')).toBeVisible()

  // 6) @ 召唤：向输入框写入「@费利 」
  await dossier.getByTitle('@ 召唤').click()
  await expect(composer(page)).toHaveValue(/@费利/)

  // 7) Esc 收起档案面板 → 切回接力链：中心图腾退场
  await page.keyboard.press('Escape')
  await expect(dossier).toBeHidden()
  await page.getByTitle('接力链布局').click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await expect(page.locator('.react-flow__node-core')).toHaveCount(0)
})
