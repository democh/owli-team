/**
 * E2E · M42 圆桌会议范式（§71，mock 模式）：
 * 会议声明卡（RT-1）→ 席位环（RT-2，roundtable 既有形态）→ 议题进度容器化（RT-3：
 * 容器更新驱动 heading 逐项推进、本地勾选兜底）→ 纪要卡三栏与待办派活（RT-4）→
 * 散会胶囊（RT-5）→ 交还用户（你的回合）。
 * 场景取「头脑风暴」（roundtable·pool）：facilitator 主持、MEETING_ROUNDS 与在场成员
 * 一一对应，串行 5 波（梅森 → 卢娜 → 维克多 → 索菲 → 梅森），与 server 链路测同构。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M42 · 圆桌例会：会议卡 → 议题推进 → 纪要派活 → 散会胶囊', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '头脑风暴', title: `E2E-M42-圆桌-${Date.now()}` })

  // 形态（RT-2）：roundtable 席位环 4 席就位（会议链路在既有形态内呈现）
  const ring = page.locator('.scene-seat-ring')
  await expect(ring).toBeVisible()
  for (const name of ['梅森', '卢娜', '维克多', '索菲']) {
    await expect(ring.getByText(name)).toBeVisible()
  }

  // 显式召唤主持人触发例会（触发词「例会」+ facilitator 在场 → MEETING_ROUNDS 链路）
  await sendMessage(page, '@梅森 开个例会：把本周的推广方案收敛一下。')

  // 全链收束（5 波串行：梅森 → 卢娜 → 维克多 → 索菲 → 梅森，尾条交还用户）
  // 注：场景工作区流式期间冻结（M52-A 节流口径），heading 逐项推进的中间态走组件单测；
  // E2E 只断言收束后的终局（容器更新优先：4/4 已决 + 议题环四步全盏）。
  await expectYourTurn(page)
  const heading = page.locator('[data-ag-heading]')
  await expect(heading).toHaveText('议题 4/4 · 已全部议决')
  await expect(page.locator('.scene-ag-step.scene-ag-done')).toHaveCount(4)

  // RT-1 容器显式态：收尾消息内主持人自己的回标行静态「已决」
  const tailCard = page.locator('.md-meeting').last()
  await expect(tailCard.locator('.md-meeting-row[data-state="done"]')).toHaveCount(1)
  await expect(tailCard.locator('.md-meeting-label')).toHaveText('圆桌纪要：收口与行动项')

  // RT-4：纪要卡三栏 + 待办派活锚点（owner 动态取在场非主持人：卢娜 / 维克多）
  const minutes = page.locator('.md-minutes')
  await expect(minutes).toBeVisible()
  await expect(minutes.locator('.md-minutes-title')).toHaveText('议题圆桌纪要')
  await expect(minutes.locator('.md-minutes-col')).toHaveCount(3)
  const todos = minutes.locator('.md-minutes-todo')
  await expect(todos).toHaveCount(2)
  await expect(todos.nth(0)).toHaveAttribute('data-owner', '卢娜')
  await expect(todos.nth(1)).toHaveAttribute('data-owner', '维克多')

  // 派活点击 → 回填 `@卢娜 ` 草稿（ADR 0064：只写草稿不直发）
  await todos.nth(0).click()
  await expect(composer(page)).toHaveValue('@卢娜 ')

  // RT-5：散会胶囊（收尾带 minutes 容器 + 运行收束 → 消息流尾条）
  await expect(page.locator('[data-adjourn-pill]')).toContainText('散会 · 会议已收尾')

  // RT-1 / RT-3 兜底：滚顶让会议声明卡进入虚拟渲染窗口（贴底剪枝会卸载顶部行）
  const log = page.locator('[role="log"]')
  const firstCard = page.locator('.md-meeting').first()
  await expect(async () => {
    await log.evaluate((el) => {
      el.scrollTop = 0
      el.dispatchEvent(new Event('scroll'))
    })
    await expect(firstCard).toBeVisible({ timeout: 1_000 })
  }).toPass({ timeout: 20_000 })
  await expect(firstCard.locator('.md-meeting-title')).toHaveText('议题圆桌')
  await expect(firstCard.locator('.md-meeting-count')).toHaveText('0/4 已决')
  await expect(firstCard.locator('.md-meeting-row')).toHaveCount(4)

  // 本地勾选兜底：待议行点选（容器无显式态）→ 本地已决并即时反映计数
  await firstCard.locator('.md-meeting-row').first().click()
  await expect(firstCard.locator('.md-meeting-count')).toHaveText('1/4 已决')
})
