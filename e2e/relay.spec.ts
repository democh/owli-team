/**
 * E2E · 主链路 1：完整接力（mock 模式）。
 * 全员 7 人依次交棒，各产出 1 份交付件，最终交还用户；断言与 eval
 * full-relay-login 任务同构（7 文件 + 交棒胶囊 + 正常收束）。
 */
import { expect, test } from '@playwright/test'
import { createSession, expectYourTurn, handoffChips, openApp, openWorkspace, sendMessage } from './helpers'

test('完整接力：团队依次交棒产出 7 份交付件后交还用户', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-接力-${Date.now()}` })
  await sendMessage(
    page,
    '请团队接力完成登录能力的完整交付：需求梳理 → 架构设计 → 交互设计 → 前端实现说明 → 接口设计 → 测试计划 → 部署说明。每个角色请把产出落到工作区交付件里。',
  )

  // Run 正常收束：最后一位成员 @用户 →「你的回合」胶囊
  await expectYourTurn(page)

  // 消息流中的交接胶囊（最近渲染的「X 交棒给 Y」）
  await expect(handoffChips(page).last()).toBeVisible()

  // 交付件深度工作台：7 位成员各产出 1 份（eval 基线同构断言）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 7 个文件/)).toBeVisible()
  for (const path of ['docs/需求文档-登录.md', 'docs/接口设计-登录.md', 'deploy/部署说明-登录.md']) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})
