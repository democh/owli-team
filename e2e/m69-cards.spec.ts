/**
 * E2E · M69 场景玩法容器（mock 模式）：
 * 1) 跑团工坊（roundtable·pool，单成员编制）：骰子走查 → 骰卡（骰面 / 总值 / 种子徽章）+ 再掷回填；
 * 2) 塔罗研习（dock·chartboard，单成员编制）：牌阵走查 → 牌阵卡（正逆位行）+ 牌阵台（chartboard cards 区，无摇卦入口）。
 * 注：场景工作区流式期间冻结（M52-A 口径），收束后断言；发送后确认草稿清空（防共享环境点击丢失）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectYourTurn, openApp, sendMessage } from './helpers'

test('M69 · 跑团工坊：骰子走查 → 骰卡 + 再掷回填', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M69-TRPG-${Date.now()}`
  await createSession(page, { scene: '跑团工坊', title, unpick: ['scenario-writer', 'npc-player', 'rule-keeper'] })
  await disableSerial(page, title)

  await sendMessage(page, '@开卷 骰子走查：做一次攀爬判定。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)

  const card = page.locator('.md-roll[data-roll-card]').first()
  await expect(card).toBeVisible()
  await expect(card.locator('.md-roll-die')).toHaveCount(1)
  await expect(card.locator('.md-roll-total-v')).toHaveText('18')
  await expect(card.locator('.md-roll-seed')).toContainText('482910')
  // 交互：再掷一次 → 草稿回填（只写草稿不直发）；复现本次 → 含种子
  await card.locator('.md-roll-again').click()
  await expect(composer(page)).toHaveValue(/重掷/)
  await card.locator('.md-roll-replay').click()
  await expect(composer(page)).toHaveValue(/482910/)
  await composer(page).fill('') // 清理草稿（防残留影响后续）
})

test('M69 · 塔罗研习：牌阵走查 → 牌阵卡 + 牌阵台', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M69-塔罗-${Date.now()}`
  await createSession(page, { scene: '塔罗研习', title, unpick: ['symbol-narrator', 'tarot-historian'] })
  await disableSerial(page, title)

  await sendMessage(page, '@观照 牌阵走查：看看最近的处境。')
  await expect(composer(page)).toHaveValue('')
  await expectYourTurn(page)

  const card = page.locator('.md-cards[data-cards-card]').first()
  await expect(card).toBeVisible()
  await expect(card.locator('.md-card-row')).toHaveCount(3)
  await expect(card.locator('.md-card-row-rev').first()).toContainText('死神')
  // 牌阵台（chartboard cards 区）：CardsBoard 布局渲染 + 点牌高亮；tarot 场景无摇卦入口
  await expect(page.getByText('盘面面板')).toBeVisible()
  const board = page.locator('.scene-cards-stack .scene-cards-board').first()
  await expect(board).toBeVisible()
  await expect(board).toHaveAttribute('data-cards-board', 'is-3')
  await board.locator('.scene-card-tile').first().click()
  await expect(board.locator('.scene-card-tile.is-active')).toHaveCount(1)
  await expect(board.locator('.scene-cards-keys')).toContainText('死神')
  await expect(page.locator('.pn-toss-enter')).toHaveCount(0)
  // 交互：重抽一组 → 草稿回填
  await card.locator('.md-cards-redraw').click()
  await expect(composer(page)).toHaveValue(/重抽/)
  await composer(page).fill('')
})
