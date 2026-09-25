/**
 * E2E · M84 多空对决场（mock 模式）：
 * - arena 席位（左多右空 + 中央裁决共 5 席）；
 * - 「对决走查」固定剧本：双方 claim → 轮次判定 ruling → 终局 verdict（僵持）+ kpi 对决结算；
 * - 面板承接：裁决流 [data-verdict-flow] + 交锋看板 [data-insight="claims"]。
 */
import { expect, test } from '@playwright/test'
import { createSession, disableSerial, expectRunSettled, openApp, sendMessage } from './helpers'

test('M84 · 多空对决场：席位 / 主张 / 轮次判定 / 终局裁决与结算', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M84-对决-${Date.now()}`
  await createSession(page, { scene: '多空对决场', title })
  await disableSerial(page, title)

  // 席位分栏（arena）：左多（向阳 / 陆准）右空（知寒 / 程实）+ 中央裁决（顾鉴）
  const arena = page.locator('.scene-arena')
  await expect(arena).toBeVisible()
  const left = page.locator('.scene-arena-left')
  const right = page.locator('.scene-arena-right')
  await expect(left).toContainText('向阳')
  await expect(left).toContainText('陆准')
  await expect(right).toContainText('知寒')
  await expect(right).toContainText('程实')

  const log = page.locator('[role="log"]')
  await sendMessage(page, '@顾鉴 @向阳 @知寒 @陆准 @程实 对决走查：只辩一轮。')
  await expectRunSettled(page)

  // 对决读数（M85：按用户要求从会话头行移入竞技行行首）与裁决席签同行：比分 / 轮次 / 顾鉴
  const headScore = page.locator('[data-scene-score]')
  await expect(headScore).toContainText('向阳')
  await expect(headScore).toContainText('知寒')
  await expect(page.locator('.scene-arena-preside')).toContainText('顾鉴')

  // （回合轴已按产品决策移除——轮次推进由下方裁决流 / 战绩读数断言覆盖）

  // 滚到顶部再断言（消息由新到旧渲染）
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })

  // 双方主张（claim 容器）
  await expect.poll(async () => log.locator('.md-claim').count()).toBeGreaterThanOrEqual(2)

  // 轮次判定（ruling：亮点 / 未决点）
  const ruling = log.locator('.md-ruling').first()
  await expect(ruling).toBeVisible()
  await expect(ruling).toContainText('未决点')

  // 终局裁决（verdict：僵持 + 四要素 + 免责）
  const verdict = log.locator('.md-verdict').first()
  await expect(verdict).toBeVisible()
  await expect(verdict).toContainText('僵持')
  await expect(verdict).toContainText('翻盘条件')
  await expect(verdict).toContainText('不构成投资建议')

  // 对决结算（kpi 五列：主张 / 显著证据 / 胜轮 / 回应率，口径列注明来源）
  const kpiRows = log.locator('.md-kpi-item')
  await expect.poll(async () => kpiRows.count()).toBeGreaterThanOrEqual(4)
  await expect(log.locator('.md-kpi-scope').first()).toContainText('计数')

  // 面板承接：裁决流（僵持 → data-status=draw 入流）+ 交锋看板
  const flow = page.locator('[data-verdict-flow]')
  await expect(flow).toBeVisible()
  const chip = flow.locator('[data-status="draw"]').first()
  await expect(chip).toBeVisible()
  await expect(chip).toContainText('多空对决终局')
  await expect(page.locator('[data-insight="claims"]')).toBeVisible()
})
