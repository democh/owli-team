/**
 * E2E · M37 场景化对话基座（mock 模式）：
 * 1) 场景资产与波次导航：新会话空态 → 资产 guide + 议程 chips（点击预填草稿、不直发）
 *    → 全链收束（尾条 @用户 → 你的回合 + 收尾交付清单）→ 上滑离开底部 → 波次分隔行进入
 *    视口 + 悬浮阶段条（M39：研发场景换显示为「需求 · 阶段 1/7」）→ 点击跳波起点；
 * 2) 结构化容器闭环：发送含触发词消息 → checklist 卡（流式禁用 → 完成态点选联动计数）
 *    → 「回填完成情况」写入 Composer 草稿（ADR 0064）→ 用户确认发送 → 回填消息落流。
 * 锚点：虚拟列表下用 data-wave-sep / data-wave-strip 属性定位（类名/结构不稳定）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M37 · 场景基座：议程 chips 预填 → 波次分隔行 → 悬浮阶段条', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M37-基座-${Date.now()}` })

  // M37-1：空态资产（guide + 议程 chips）——点击预填为草稿，不直发
  await expect(page.getByText('推荐开场')).toBeVisible()
  // exact 收紧：成员档案卡的可访问名也含「需求澄清」关键词
  const chip = page.getByRole('button', { name: '需求澄清', exact: true })
  await expect(chip).toHaveAttribute('title', '帮我澄清这个需求，产出可验收的需求说明：')
  await chip.click()
  await expect(composer(page)).toHaveValue('帮我澄清这个需求，产出可验收的需求说明：')
  await page.getByRole('button', { name: '发送' }).click()

  // 全链收束（7 位成员各一轮 → 尾条 @用户 → 你的回合 + M37-6 收尾交付清单）
  await expectYourTurn(page)
  const manifest = page.locator('[data-delivery-manifest]')
  await expect(manifest).toBeVisible()
  await expect(manifest.getByText('本轮交付')).toBeVisible()
  await expect(manifest.locator('[data-delivery-row]').first()).toBeVisible()

  // M37-2/3：上滑离开底部 → 波次分隔行进入视口 + 悬浮阶段条挂载（首个可见行起向前扫描 = 第 1 波）
  // M39（DEV-1）：研发场景阶段换显示——药丸为「需求 · 阶段 1/7」（data-wave-stage 锚点）
  const log = page.getByRole('log', { name: '消息流' })
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  await log.evaluate((el) => {
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(page.locator('[data-wave-sep]').first()).toBeVisible()
  const strip = page.locator('[data-wave-strip]')
  await expect(strip).toBeVisible()
  await expect(strip).toHaveAttribute('data-wave-stage', '需求')
  await expect(strip).toContainText('阶段 1/7')

  // 点击跳波起点：滚动定位后仍处于「离开底部」态（悬浮条由 vp 派生保留）
  await strip.click()
  await expect(strip).toContainText('需求')
})

test('M37 · 结构化容器：checklist 点选 → 回填完成情况进草稿 → 确认发送', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M37-清单-${Date.now()}` })

  // mock 固定剧本：消息含触发词 → 每轮文本尾部追加 checklist 块（::: checklist 上线检查）
  await sendMessage(page, '给我一份上线结构化清单。')
  await expectYourTurn(page)

  // 链尾成员的卡片（贴底渲染）：标题 / 初始计数 / GFM 勾选态
  const card = page.locator('.md-checklist').last()
  await expect(card).toBeVisible()
  await expect(card.locator('.md-checklist-head')).toContainText('上线检查')
  await expect(card.locator('.md-checklist-count')).toHaveText('1/3')

  // 流式结束后行可点：点第二条 → 计数联动 2/3
  const line = card.locator('.md-checkline').nth(1)
  await expect(line).toBeEnabled()
  await line.click()
  await expect(card.locator('.md-checklist-count')).toHaveText('2/3')

  // 回填完成情况 → Composer 草稿（带当前勾选序列，可编辑后发送）
  await card.getByRole('button', { name: '回填完成情况' }).click()
  await expect(composer(page)).toHaveValue(
    /完成情况回填 · 《上线检查》（2\/3）\n- \[x\] 数据已备份\n- \[x\] 灰度流量已开启\n- \[ \] 回滚脚本已演练/,
  )

  // 用户确认发送 → 回填消息落流（新 run 不触发追加块，正常收束）
  await page.getByRole('button', { name: '发送' }).click()
  await expect(page.getByText('完成情况回填 · 《上线检查》（2/3）').last()).toBeVisible()
  await expectYourTurn(page)
})
