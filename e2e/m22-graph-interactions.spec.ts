/**
 * E2E · M22 图谱深化（§28.5）：交互手感 + 洞察 + 时间轴回放。
 * A：免接力态——悬停预览卡浮现/消失、点成员开档案（专长 chips）、
 *    追踪接力链胶囊、F 键导演镜头切换、Esc 收面板；游离环不误报。
 * B：完整接力后——全员参与无游离环、庆祝脉冲标记、接力边悬停出标签 →
 *    点击固定 → 再点收起；档案追踪链 N 位；时间轴回放入口 → 暂停 →
 *    定格 0 / 跳到尾 → 回到实时。
 * 选择器全部取自组件源码语义锚点（aria-label / title / role / 既有 e2e 类）。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('协作图谱 M22-A：悬停预览卡 · 档案追踪 · 键盘跟拍', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M22-手感-${Date.now()}` })

  // 图谱 tab：7 节点；无接力（<2 次）不误报游离环
  await page.getByRole('tab', { name: '图谱' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await expect(page.locator('.graph-isolated-ring')).toHaveCount(0)

  // A1 悬停预览卡：停留 ~280ms 浮现（状态徽章 + 无发言空态）
  const pmNode = page.locator('.react-flow__node', { hasText: '费利' })
  await pmNode.hover()
  const preview = page.locator('.graph-pop-in')
  await expect(preview).toBeVisible()
  await expect(preview.getByText('费利')).toBeVisible()
  await expect(preview.getByText('待命')).toBeVisible()
  await expect(preview.getByText('尚未发言')).toBeVisible()
  // 移开指针（dock 语义锚点）→ 预览立即消失
  await page.getByTitle('整理布局').hover()
  await expect(preview).toBeHidden()

  // A2/B3 点击成员开档案：专长 chips（真实编制 5 条 → 前 4 + 计数）
  await pmNode.click()
  const panel = page.getByRole('complementary', { name: '费利 档案' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('专长')).toBeVisible()
  await expect(panel.getByText('需求澄清')).toBeVisible()
  await expect(panel.getByText('+1')).toBeVisible()

  // B1 追踪接力链：无接力时链上仅自己 → 胶囊出现；停止追踪 → 胶囊收起
  // （面板按钮与胶囊 X 同名，胶囊按钮以 aria-label 唯一命中）
  await panel.getByRole('button', { name: /追踪接力链/ }).click()
  await expect(page.getByText(/追踪 \d+ 位/)).toBeVisible()
  await page.locator('button[aria-label="停止追踪"]').click()
  await expect(page.getByText(/追踪 \d+ 位/)).toBeHidden()

  // A3 键盘：F 切换导演镜头（title 语义锚点）
  await page.keyboard.press('f')
  await expect(page.getByTitle('导演镜头：跟随发言者（点击关闭）')).toBeVisible()
  await page.keyboard.press('f')
  await expect(page.getByTitle('导演镜头：跟随发言者（F）')).toBeVisible()

  // Esc 收起档案
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('协作图谱 M22-B：边固定 · 追踪链 · 时间轴回放', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M22-洞察-${Date.now()}` })
  await page.getByRole('tab', { name: '图谱' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)

  // 完整接力（费利开棒、链尾兜底）→ 接力实线去重编制后共 10 条
  await sendMessage(page, '请团队接力完成账单能力的交付，产出落工作区。')
  await expectYourTurn(page)
  await expect(page.locator('.react-flow__edge')).toHaveCount(10)
  // B2 全员参与 → 无游离环误报；A5 交还用户 → 庆祝脉冲标记常驻（nonce 渲染）
  await expect(page.locator('.graph-isolated-ring')).toHaveCount(0)
  await expect(page.locator('.graph-celebrate-flash')).toHaveCount(1)

  // A4 接力边 pm→architect（首棒）：悬停出标签 → 移开隐 → 点击固定 → 再点收起
  const relayEdge = page.locator('.react-flow__edge[data-id="pm->architect"]')
  const edgeLabel = page.locator('.react-flow__edge-textwrapper')
  await relayEdge.hover()
  await expect(edgeLabel).toHaveCount(1)
  await page.getByTitle('整理布局').hover()
  await expect(edgeLabel).toHaveCount(0)
  await relayEdge.click()
  await expect(edgeLabel).toHaveCount(1)
  await expect(page.locator('.react-flow__edge-text').first()).toContainText(/接手 \d+ 次/)
  await page.getByTitle('整理布局').hover()
  await expect(edgeLabel).toHaveCount(1) // 固定：移开指针仍显示
  await relayEdge.click()
  await page.getByTitle('整理布局').hover()
  await expect(edgeLabel).toHaveCount(0)

  // B1 档案 → 追踪接力链 → 胶囊（链路成员数）→ 停止追踪 → Esc 收面板
  await page.locator('.react-flow__node', { hasText: '费利' }).click()
  const panel = page.getByRole('complementary', { name: '费利 档案' })
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: /追踪接力链/ }).click()
  await expect(page.getByText(/追踪 \d+ 位/)).toBeVisible()
  await page.locator('button[aria-label="停止追踪"]').click()
  await expect(page.getByText(/追踪 \d+ 位/)).toBeHidden()
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // C 时间轴回放：进入 → 立即暂停 → Home 定格 0 → End 跳到尾 → 回到实时
  await page.getByTitle('时间轴回放：看接力怎么长出来').click()
  const bar = page.getByRole('group', { name: '时间轴回放' })
  await expect(bar).toBeVisible()
  await bar.getByRole('button', { name: '暂停回放' }).click()
  await expect(bar.getByRole('button', { name: '播放回放' })).toBeVisible()
  const slider = bar.getByRole('slider', { name: '回放进度' })
  const total = await slider.getAttribute('max')
  await slider.focus()
  await page.keyboard.press('Home')
  await expect(bar.getByText(`0/${total}`)).toBeVisible()
  await page.keyboard.press('End')
  await expect(bar.getByText(`${total}/${total}`)).toBeVisible()
  await bar.getByRole('button', { name: '回到实时' }).click()
  await expect(bar).toBeHidden()
  await expect(page.getByTitle('时间轴回放：看接力怎么长出来')).toBeVisible()
})
