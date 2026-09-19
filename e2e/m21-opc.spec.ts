/**
 * E2E · M21 OPC 业务链路（mock 模式）：
 * 1) 快速组队「周经营例会」：preset 卡片建会 → 开场指令预填草稿 → @ 多人触发并行汇报波
 *    → 财务 KPI 卡 + 幕僚长 option 收敛卡 → 交还用户 → 4 份交付件；
 * 2) 「内容营销战役」：目标拆解 → 内容日历 timeline 卡（含「今天」高亮）→ 4 份交付件。
 * 与 eval opc-weekly-review / content-campaign 任务同构（确定性链路断言）。
 * M46-2：串行执行默认开启 → 「并行汇报波」用例先显式关闭串行。
 */
import { expect, test } from '@playwright/test'
import { composer, createSessionByPreset, disableSerial, expectYourTurn, openApp, openWorkspace } from './helpers'

test('M21 · 周经营例会：preset 建会 → 草稿预填 → 并行汇报 → KPI / option 卡与交付件', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M21-例会-${Date.now()}`
  await createSessionByPreset(page, '周经营例会', { title })
  await disableSerial(page, title)

  // 开场指令已预填为 Composer 草稿（可直接编辑后发送）
  await expect(composer(page)).toHaveValue(/主持本周经营例会/)
  await page.getByRole('button', { name: '发送' }).click()

  const log = page.locator('[role="log"]')
  // 首波：@ 多人 → 财务 / 增长 / 销售并行汇报（并行协作组）
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('财务口径先对齐')).toBeVisible()
  await expect(log.getByText('增长方案先给北极星与护栏')).toBeVisible()
  await expect(log.getByText('销售这边本周主攻')).toBeVisible()

  // finance 剧本：KPI 卡（毛利率 / 盈亏平衡点）
  const kpi = page.locator('.md-kpi').first()
  await expect(kpi.locator('.md-kpi-title')).toHaveText('财务测算（月度）')
  await expect(kpi.getByText('毛利率')).toBeVisible()
  await expect(kpi.getByText('盈亏平衡点')).toBeVisible()

  // 收敛波：幕僚长 option 推荐卡
  await expect(page.locator('.md-option-badge').filter({ hasText: '推荐' }).first()).toBeVisible()
  await expect(page.locator('.md-option-title').filter({ hasText: '本周经营优先级' })).toBeVisible()

  // Run 正常收束（全波交还 → 你的回合）
  await expectYourTurn(page)

  // 交付件：4 位成员各 1 份（eval 同构断言）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 4 个文件/)).toBeVisible()
  for (const path of [
    'docs/经营简报-增长.md',
    'docs/财务测算-增长.md',
    'docs/增长方案-增长.md',
    'docs/销售话术-增长.md',
  ]) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})

test('M21 · 内容营销战役：preset 建会 → 内容日历 timeline 卡（今天高亮）→ 交付件', async ({ page }) => {
  await openApp(page)
  await createSessionByPreset(page, '内容营销战役', { title: `E2E-M21-战役-${Date.now()}` })

  await expect(composer(page)).toHaveValue(/发起一轮内容营销战役/)
  await page.getByRole('button', { name: '发送' }).click()

  const log = page.locator('[role="log"]')
  await expect(log.getByText('内容日历排好了')).toBeVisible()
  await expect(log.getByText('关键词分四组')).toBeVisible()

  // content 剧本：timeline 卡（动态日期 → 「今天」高亮）
  await expect(page.locator('.md-timeline-title').filter({ hasText: '内容日历（两周排期）' })).toBeVisible()
  await expect(page.locator('.md-timeline-today').first()).toBeVisible()
  await expect(page.locator('.md-timeline-date.is-today').first()).toBeVisible()

  await expectYourTurn(page)

  // 交付件：4 位成员各 1 份
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 4 个文件/)).toBeVisible()
  for (const path of [
    'docs/增长方案-内容.md',
    'docs/内容日历-内容.md',
    'docs/搜索投放-内容.md',
    'docs/品牌规范-内容.md',
  ]) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})
