/**
 * E2E · 主链路 5：交付件 Diff（mock 模式）。
 * 单 backend 会话产出接口文档 → 交付件深度工作台 → 预览 → Diff 视图
 * 展示 v0（空文件）→ v1 的全新增 diff（+N / -0，非「内容一致」）。
 */
import { expect, test } from '@playwright/test'
import { ALL_AGENTS, createSession, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

const UNPICK = ALL_AGENTS.filter((id) => id !== 'backend')
const DOC_PATH = 'docs/接口设计-登录.md'

test('交付件 Diff：单成员产出接口文档，v0→v1 全新增可见', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-Diff-${Date.now()}`, unpick: UNPICK })
  await sendMessage(page, '请输出登录接口设计文档（端点、错误码、幂等与安全），落为交付件。')
  await expectYourTurn(page)

  // 交付件：仅 1 个文件
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 1 个文件/)).toBeVisible()
  const fileItem = page.locator(`button[title="${DOC_PATH}"]`)
  await expect(fileItem).toBeVisible()
  await fileItem.click()

  // 预览：Markdown 渲染文档标题
  await expect(page.getByRole('heading', { name: '登录接口设计' })).toBeVisible()

  // Diff：切到 Diff 模式 → v0 → v1 全新增
  await page.getByRole('button', { name: 'Diff' }).click()
  // 统计出现 = diff 渲染完成（新增 > 0、删除 0）
  await expect(page.getByText(/^\+\d+$/).first()).toBeVisible()
  await expect(page.getByText('生成 diff…')).toHaveCount(0)
  await expect(page.getByText('两个版本内容一致')).toHaveCount(0)
  await expect(page.getByText('-0', { exact: true })).toBeVisible()
  // 版本选择：from=v0（空文件基线），to=v1
  await expect(page.locator('select').first()).toHaveValue('0')
  await expect(page.locator('select').nth(1)).toHaveValue('1')
  // 行级渲染：接口端点行以新增行展示
  await expect(page.getByText('POST /api/v1/init（发起）').first()).toBeVisible()
})
