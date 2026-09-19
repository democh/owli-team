/**
 * E2E · M14 窄屏响应式（390×844）：折叠布局走查。
 *
 * 窄屏（≤900px）下左栏会话列表与右栏团队面板折叠为 Radix 抽屉，
 * 新建会话对话框成为抽屉内的嵌套 Dialog —— 用 dialog 的 aria 名区分；
 * 底部成员条提供一键 @ 入口。覆盖桌面主链路之外的窄屏盲区。
 */
import { expect, test, type Page } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

test.use({ viewport: { width: 390, height: 844 } })

/** 窄屏专用：从会话抽屉内发起新建（嵌套 Dialog），并等待抽屉随创建自动收起 */
async function createSessionNarrow(page: Page, title: string): Promise<void> {
  await page.getByTitle('会话列表').click()
  const drawer = page.getByRole('dialog', { name: '会话列表' })
  await expect(drawer).toBeVisible()
  await drawer.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await expect(dialog).toBeVisible()
  // M50 组队台窄屏三页签：选场景来源后自动切「编制」页（研发团队 = 7 人推荐编制预选；M48 起不再含调度官）
  await dialog.getByRole('button', { name: '组队来源：研发团队' }).click()
  await expect(dialog.getByRole('tab', { name: '编制' })).toHaveAttribute('aria-selected', 'true')
  await expect(dialog.getByText('已选 7 位')).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(title)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
}

test('M14 窄屏：会话抽屉新建 + 底部成员快捷条 + 团队抽屉', async ({ page }) => {
  await openApp(page)

  // 1) 窄屏壳：会话抽屉开关与底部成员条（团队开关）可见；左栏不常驻
  await expect(page.getByTitle('会话列表')).toBeVisible()
  await expect(page.getByTitle('打开团队面板')).toBeVisible()
  await expect(page.getByPlaceholder('搜索全部会话消息…')).toBeHidden()

  // 2) 抽屉内新建会话（嵌套 Dialog），创建后抽屉自动收起
  await createSessionNarrow(page, `E2E-M14-窄屏-${Date.now()}`)
  await expect(page.getByPlaceholder('搜索全部会话消息…')).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 3) 底部成员条：点成员 chip → @ 插入输入框（与 ContextBar 的召唤 chip 区分）
  await page.getByTitle('@费利（插入到输入框）').click()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toHaveValue('@费利 ')

  // 4) 团队抽屉：打开 → 接力视图可见 → Esc 关闭
  await page.getByTitle('打开团队面板').click()
  const teamDrawer = page.getByRole('dialog', { name: '团队面板' })
  await expect(teamDrawer).toBeVisible()
  await teamDrawer.getByRole('tab', { name: '接力' }).click()
  await expect(teamDrawer.getByText('在对话里 @ 一位成员，见证一场接力')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(teamDrawer).toBeHidden()
})

test('M14 窄屏：对话主链路在折叠布局下可用（接力 → 收束 → 交付件）', async ({ page }) => {
  await openApp(page)

  await createSessionNarrow(page, `E2E-M14-窄屏链路-${Date.now()}`)
  await sendMessage(
    page,
    '请团队接力完成登录能力的完整交付：需求梳理 → 架构设计 → 交互设计 → 前端实现说明 → 接口设计 → 测试计划 → 部署说明。每个角色请把产出落到工作区交付件里。',
  )
  await expectYourTurn(page)

  // 收束后消息流正常渲染（窄屏虚拟滚动可用）
  // M52-D：长会话下虚拟列表正确剪枝顶部行——断言首条用户消息前先滚回顶部（M37 同口径）
  const log = page.locator('[role="log"]')
  await log.evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(log).toContainText('请团队接力完成登录能力的完整交付')

  // 交付件深度工作台在窄屏可用（M49：命令面板入口；窄屏按钮隐藏 → Ctrl+K）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 7 个文件/)).toBeVisible()
})
