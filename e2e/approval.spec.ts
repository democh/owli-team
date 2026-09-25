/**
 * E2E · 主链路 6：审批拒绝/批准（APPROVAL_MODE=all，独立服务器）。
 * 单 backend 会话首回合产出 write_todos + write_file 两个工具调用：
 * 拒绝 write_todos → 团队收到反馈继续；批准 write_file → 完成并交还用户。
 */
import { expect, test } from '@playwright/test'
import { AGENT_NAME, ALL_AGENTS, approvalCard, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

const UNPICK = ALL_AGENTS.filter((id) => id !== 'backend')

test('审批：拒绝 write_todos、批准 write_file 后团队继续并交还用户', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-审批-${Date.now()}`, unpick: UNPICK })
  await sendMessage(page, '请输出登录接口设计文档（端点、错误码、幂等与安全），落为交付件。')

  // 卡 1：write_todos 审批 → 拒绝（action 文案由引擎生成：X请求执行 <tool>）
  const card1 = approvalCard(page)
  await expect(card1).toBeVisible()
  await expect(card1.getByText(`${AGENT_NAME.backend}请求执行 write_todos`)).toBeVisible()
  await card1.getByRole('button', { name: '拒绝' }).click()

  // 卡 2：write_file 审批 → 批准（等待新卡出现，action 不同）
  const card2 = approvalCard(page)
  await expect(card2.getByText(`${AGENT_NAME.backend}请求执行 write_file`)).toBeVisible()
  await card2.getByRole('button', { name: '批准' }).click()

  // 已决条不再常驻（2026-09-25 产品决策）：决议后无结论行常驻，团队继续执行

  // 团队继续执行并交还用户（拒绝不导致整轮失败）
  await expectYourTurn(page)
})
