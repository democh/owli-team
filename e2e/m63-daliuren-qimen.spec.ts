/**
 * E2E · M63-C/D 大六壬 × 奇门遁甲（batch F 收口；mock 模式）：
 * 1) 大六壬：完整可派生课卡 → 天地盘三层圆盘（12+12+12）/ 四课板书（4 列，右起）/ 三传卡列（3）/ 
 *    点宫信息条 → 天将层开关 → 三传「请教初传」草稿（含遁干与天将）→ 四课「请教」草稿；
 * 2) 奇门遁甲：完整可派生局卡 → 九宫格（洛书序：巽离坤 / 震中兑 / 艮坎乾）/ 值符值使角标 /
 *    旬空虚线格（2）→ 点宫详情（天盘 / 地盘 / 旬空）→ 「请教坎1宫」草稿。
 *
 * 卡文本为 server 工具实测输出（daliuren_pan / qimen_pan）；
 * 草稿一律入 Composer 不发送（本地确定性变换）。
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 大六壬课卡（2026-11-05 14:30 癸未日己未时；涉害课） */
const DALIUREN = [
  '::: pan daliuren 大六壬 涉害课',
  '起课：丙午年 戊戌月 癸未日 己未时 ｜ 昼占',
  '月将：太冲 卯 ｜ 中气 霜降（2026-10-23 17:37）',
  '天地盘：子→申 丑→酉 寅→戌 卯→亥 辰→子 巳→丑 午→寅 未→卯 申→辰 酉→巳 戌→午 亥→未',
  '- 一课 | 上 酉（下 癸）',
  '- 二课 | 上 巳（下 酉）',
  '- 三课 | 上 卯（下 未）',
  '- 四课 | 上 亥（下 卯）',
  '- 初传 | 卯 ｜ 遁干 己 ｜ 天将 贵人',
  '- 中传 | 亥 ｜ 遁干 乙 ｜ 天将 勾陈',
  '- 末传 | 未 ｜ 遁干 癸 ｜ 天将 太常',
  '课体：涉害课（涉害相等，复等取支上神）',
  '贵人：昼贵 卯（临地盘 未 · 逆布）',
  '天将：子 六合 ｜ 丑 朱雀 ｜ 寅 螣蛇 ｜ 卯 贵人 ｜ 辰 天后 ｜ 巳 太阴 ｜ 午 玄武 ｜ 未 太常 ｜ 申 白虎 ｜ 酉 天空 ｜ 戌 青龙 ｜ 亥 勾陈',
  '口径：时家·中气换将·贵人顺逆法·涉害归地比较',
  ':::',
].join('\n')

/** 奇门局卡（2026-11-05 14:30 阴五局） */
const QIMEN = [
  '::: pan qimen 奇门 阴五局',
  '定局：阴遁五局 ｜ 节气 霜降 ｜ 上元 ｜ 符头 己卯（符头后于节气 9 日（拆补））',
  '值符：天英 ｜ 值使：景门 ｜ 旬首：甲寅（癸）',
  '旬空：子 丑（时旬）',
  '- 巽4 | 值符 天英 景门 ｜ 天盘 癸 ｜ 地盘 己',
  '- 离9 | 九天 天芮（禽随） 死门 ｜ 天盘 辛 ｜ 地盘 癸',
  '- 坤2 | 九地 天柱 惊门 ｜ 天盘 丙 ｜ 地盘 辛',
  '- 震3 | 螣蛇 天辅 杜门 ｜ 天盘 己 ｜ 地盘 庚',
  '- 中5 | —— 天禽（寄坤） ｜ 天盘 —— ｜ 地盘 戊',
  '- 兑7 | 玄武 天心 开门 ｜ 天盘 乙 ｜ 地盘 丙',
  '- 艮8 | 太阴 天冲 伤门 ｜ 天盘 庚 ｜ 地盘 丁 ｜ 空',
  '- 坎1 | 六合 天任 生门 ｜ 天盘 丁 ｜ 地盘 壬 ｜ 空',
  '- 乾6 | 白虎 天蓬 休门 ｜ 天盘 壬 ｜ 地盘 乙',
  '口径：时家转盘·拆补法（符头候简化）·中宫寄坤',
  ':::',
].join('\n')

/** 钉顶助手（与 m54 / m63-transit-synastry 同法：role=log 滚动容器） */
async function pinTop(page: Page): Promise<void> {
  await page.locator('[role="log"]').evaluate((el) => {
    el.scrollTop = 0
  })
}

async function waitCard(page: Page, sel: string): Promise<void> {
  await expect
    .poll(
      async () => {
        await pinTop(page)
        return page.locator(sel).count()
      },
      { timeout: 30_000, intervals: [200, 500, 1000] },
    )
    .toBeGreaterThan(0)
}

async function setupCard(page: Page, cardText: string, sel: string): Promise<Locator> {
  await openApp(page)
  await createSession(page, { title: `E2E-M63F-${Date.now()}` })
  await sendMessage(page, cardText)
  await expectYourTurn(page)
  await waitCard(page, sel)
  const card = page.locator(sel).first()
  await expect(card).toBeVisible()
  return card
}

test('M63-C · 大六壬：天地盘 / 四课 / 三传 / 天将层 / 请教草稿', async ({ page }) => {
  const card = await setupCard(page, DALIUREN, '.pn-daliuren')

  // 结构：三层圆盘（地盘 / 天盘 / 天将各 12）+ 四课 4 列 + 三传 3 卡
  await expect(card.locator('.pn-dl-di')).toHaveCount(12)
  await expect(card.locator('.pn-dl-tian')).toHaveCount(12)
  await expect(card.locator('.pn-dl-jiang')).toHaveCount(12)
  await expect(card.locator('.pn-ke-col')).toHaveCount(4)
  await expect(card.locator('.pn-chuan-card')).toHaveCount(3)
  // 课体（尾段字段行回收）/ 月将（前段字段行）在卡面文本
  await expect(card).toContainText('涉害课')
  await expect(card).toContainText('昼贵 卯')

  // 点未宫（pan 序第 8 个）→ 信息条（地盘 未 上临 天盘 卯 · 天将 贵人）
  await card.locator('.pn-dl-cell').nth(7).click()
  await expect(card.locator('.pn-dl-selinfo')).toContainText('地盘 未 上临 天盘 卯')
  await expect(card.locator('.pn-dl-selinfo')).toContainText('贵人')

  // 天将层开关：关 → 天将字消失；开 → 复原
  await card.getByRole('button', { name: '天将层' }).click()
  await expect(card.locator('.pn-dl-jiang')).toHaveCount(0)
  await card.getByRole('button', { name: '天将层' }).click()
  await expect(card.locator('.pn-dl-jiang')).toHaveCount(12)

  // 三传：点「初传」→ 中选 → 请教初传草稿（含遁干与天将）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.getByRole('button', { name: /初传/ }).first().click()
  await expect(card.locator('.pn-chuan-card.is-on')).toHaveCount(1)
  await card.getByRole('button', { name: /请教初传/ }).click()
  await expect(composer).toHaveValue(/请解读初传（卯·遁干 己·天将 贵人）/)
})

test('M63-D · 奇门：九宫格 / 值符值使角标 / 旬空 / 宫详情草稿', async ({ page }) => {
  const card = await setupCard(page, QIMEN, '.pn-qimen')

  // 结构：九宫格（洛书布局：首格巽4 · 末格乾6）+ 空亡 2 格 + 定局条
  const cells = card.locator('.pn-qm-cell')
  await expect(cells).toHaveCount(9)
  await expect(cells.first()).toHaveAttribute('data-gong', '4')
  await expect(cells.last()).toHaveAttribute('data-gong', '6')
  await expect(card.locator('.pn-qm-cell.is-kong')).toHaveCount(2)
  await expect(card.locator('.pn-qm-ding')).toContainText('阴遁五局')
  // 值符（巽4）与值使（景门在巽4）角标同格
  await expect(cells.first().locator('.pn-qm-tag')).toHaveCount(2)

  // 点坎1宫（旬空）→ 宫详情（天盘 / 地盘 / 旬空）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.locator('[data-gong="1"]').click()
  const detail = card.locator('.pn-qm-detail')
  await expect(detail).toContainText('坎1宫')
  await expect(detail).toContainText('天盘 丁')
  await expect(detail).toContainText('地盘 壬')
  await expect(detail).toContainText('旬空')
  // 请教坎1宫 → 草稿（含神星门与旬空标注）
  await card.getByRole('button', { name: /请教坎1宫/ }).click()
  await expect(composer).toHaveValue(/请解读坎1宫（六合·天任·生门/)
  await expect(composer).toHaveValue(/天盘 丁 \/ 地盘 壬·旬空/)
})
