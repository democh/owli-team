/**
 * E2E · M78 塔罗抽牌台（mock 模式）：
 * 1) 亲手抽牌全流程（静心 → 洗牌 → 切牌 → 选牌 → 揭示 → 成阵）→ 请解读草稿回填（不自动发送）；
 *    真实动效路径（洗牌 700ms / 翻牌 600ms），断言带明确等待；
 * 2) 图鉴 / 手记入口可达（同宿主族弹窗；手记空态）。
 * 注：抽牌台为面板空态即有入口（无需先发消息）；类名锚点 `.tc-*`（独立命名空间）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, openApp } from './helpers'

test('M78 · 塔罗抽牌台：亲手抽牌全流程 → 请解草稿回填', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M78-塔罗-${Date.now()}`
  await createSession(page, { scene: '塔罗研习', title, unpick: ['symbol-narrator', 'tarot-historian'] })
  await disableSerial(page, title)

  // 面板空态入口（三按钮：亲手抽牌 / 图鉴 / 手记）
  const entries = page.locator('.tc-enter-row')
  await expect(entries).toBeVisible()
  await entries.getByRole('button', { name: '亲手抽牌' }).click()

  const ritual = page.getByRole('dialog', { name: '抽牌台' })
  await expect(ritual).toBeVisible()

  // 静心：默认三张阵 + 填所问 → 开始洗牌
  await expect(ritual.locator('.tc-spread-card.is-on')).toContainText('三张牌阵')
  await ritual.getByPlaceholder('例：最近这段时间该把注意力放在哪里').fill('最近要不要换工作')
  await ritual.getByRole('button', { name: '开始洗牌' }).click()

  // 洗牌（真实动画）→ 切牌
  await ritual.getByRole('button', { name: '洗牌', exact: true }).click()
  const toCut = ritual.getByRole('button', { name: '切牌', exact: true })
  await expect(toCut).toBeVisible({ timeout: 5_000 })
  await toCut.click()

  // 切牌：第 2 堆放最上（cut = 1）
  await ritual.getByRole('button', { name: '第 2 堆放最上' }).click()

  // 选牌：格位 3 / 17 / 42（picks 顺序 = 牌位顺序）
  const cells = ritual.locator('.tc-cell')
  await expect(cells).toHaveCount(78)
  await cells.nth(3).click()
  await cells.nth(17).click()
  await cells.nth(42).click()
  await expect(ritual.locator('.tc-slot.is-filled')).toHaveCount(3)

  // 揭示：全部翻开（成阵）
  await ritual.getByRole('button', { name: '揭示牌面' }).click()
  await ritual.getByRole('button', { name: '全部翻开' }).click()

  // 成阵：复现参数 + 构成事实 + 请解读
  const params = ritual.locator('.tc-info-params')
  await expect(params).toContainText('切牌 1')
  await expect(params).toContainText('选牌 [3, 17, 42]')
  await expect(params).toContainText(/种子 \d+/)
  await expect(ritual.locator('.tc-info-comp')).toContainText('大阿卡纳')
  await ritual.getByRole('button', { name: '请观照解读' }).click()
  await expect(ritual).toBeHidden()

  // 草稿回填（只写草稿不直发）：含复现三元组与逐位核对条款
  const draft = composer(page)
  await expect(draft).toHaveValue(/tarot_draw（spread=three，seed=\d+，cut=1，picks=\[3,17,42\]）/)
  await expect(draft).toHaveValue(/逐位核对后按四步解读/)
  await draft.fill('')
})

test('M78 · 图鉴与手记入口可达（同宿主族）', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M78-塔罗副-${Date.now()}`
  await createSession(page, { scene: '塔罗研习', title, unpick: ['symbol-narrator', 'tarot-historian'] })
  await disableSerial(page, title)

  const entries = page.locator('.tc-enter-row')
  await expect(entries).toBeVisible()

  // 图鉴：大阿卡纳 22 → 权杖 14 → 关闭
  await entries.getByRole('button', { name: '图鉴' }).click()
  const codex = page.getByRole('dialog', { name: '塔罗图鉴' })
  await expect(codex).toBeVisible()
  await expect(codex.locator('.tc-codex-cell')).toHaveCount(22)
  await codex.getByRole('tab', { name: '权杖' }).click()
  await expect(codex.locator('.tc-codex-cell')).toHaveCount(14)
  await codex.getByRole('button', { name: '关闭图鉴' }).click()
  await expect(codex).toBeHidden()

  // 手记：空态（新会话无记录）
  await entries.getByRole('button', { name: '手记' }).click()
  const journal = page.getByRole('dialog', { name: '抽牌手记' })
  await expect(journal).toBeVisible()
  await expect(journal.locator('.tc-empty')).toContainText('还没有记录')
  await journal.getByRole('button', { name: '关闭手记' }).click()
  await expect(journal).toBeHidden()
})
