/**
 * E2E · M63-B 行运 × 合盘（batch F 收口；mock 模式）：
 * 1) 行运盘主路径：完整可派生行运卡 → 星座环 / 10 行运行星（5 逆行标）/
 *    34 条 cross 相位清单（点相位 → 请教草稿）/ 扫描 ribbon（4 命中节点 → 时点详情 → 关注时点草稿）；
 * 2) 合盘主路径：完整可派生合盘卡 → 10×10 交角矩阵（命中格）/ 轴相位单列 /
 *    元素行 / 点格中选 → 请教相位草稿 / 组合盘（中点）开与关。
 *
 * 卡文本为 server 工具实测输出（transit_pan / synastry_pan 全量参数）；
 * 草稿一律入 Composer 不发送（本地确定性变换）。
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 行运卡（2026-11-05 14:30；扫描 11-01~11-10 命中 4） */
const TRANSIT = [
  '::: pan transit 行运 2026-11-05',
  '本命：1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E ｜ Placidus',
  '行运：2026-11-05 14:30（当地钟表时间）｜ UTC 2026-11-05 06:30',
  '扫描：2026-11-01 ~ 2026-11-10',
  '- 行运太阳 | 天蝎 12.9°（222.85°）｜ 2 宫',
  '- 行运月亮 | 处女 25.6°（175.56°）｜ 1 宫',
  '- 行运水星 | 天蝎 11.3°（221.31°）｜ 2 宫 ｜ 逆行',
  '- 行运金星 | 天秤 24.4°（204.42°）｜ 2 宫 ｜ 逆行',
  '- 行运火星 | 狮子 20.7°（140.74°）｜ 12 宫',
  '- 行运木星 | 狮子 24.8°（144.82°）｜ 12 宫',
  '- 行运土星 | 白羊 9.0°（9.03°）｜ 7 宫 ｜ 逆行',
  '- 行运天王星 | 双子 4.5°（64.52°）｜ 9 宫 ｜ 逆行',
  '- 行运海王星 | 白羊 2.0°（2.00°）｜ 7 宫 ｜ 逆行',
  '- 行运冥王星 | 水瓶 3.2°（303.16°）｜ 5 宫',
  '- 行运土星-本命金星 | 合相 0.1°',
  '- 行运土星-本命木星 | 刑相 0.1°',
  '- 行运月亮-本命土星 | 拱相 0.3°',
  '- 行运火星-本命太阳 | 刑相 0.5°',
  '- 行运太阳-本命ASC | 六合 3.1°',
  '- 行运太阳-本命DSC | 拱相 3.1°',
  '- 行运木星-本命太阳 | 刑相 3.6°',
  '- 行运水星-本命冥王星 | 合相 5.0°',
  '- 行运土星-本命MC | 六合 6.0°',
  '- 行运土星-本命IC | 拱相 6.0°',
  '- 行运土星-本命天王星 | 刑相 | 精确 2026-11-01 18:00 ｜ 影响窗 ±14 天',
  '- 行运水星-本命ASC | 六合 | 精确 2026-11-01 22:52 ｜ 影响窗 ±14 天',
  '- 行运土星-本命金星 | 合相 | 精确 2026-11-04 12:00 ｜ 影响窗 ±14 天',
  '- 行运太阳-本命ASC | 六合 | 精确 2026-11-08 16:30 ｜ 影响窗 ±14 天',
  '口径：cross-aspects orb ≤ 6°·主相位；扫描为参考时点非事件断言',
  ':::',
].join('\n')

/** 合盘卡（A × B；交叉截断前 40 条） */
const SYNASTRY = [
  '::: pan synastry 合盘 A×B',
  'A：1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E',
  'B：1992-08-20 09:15 ｜ Asia/Shanghai ｜ 39.9°N 116.4°E',
  '知情：本盘仅基于双方出生数据的关系模式参考',
  '元素：A 火2 土5 风0 水3 ｜ B 火2 土5 风2 水1 ｜ 互补 水',
  '口径：cross-aspects orb ≤ 8°·主相位·对称去重',
  '注：cross 共 101 条，已按 orb 截断展示前 40 条',
  '- A太阳 | 金牛 21.2°（51.24°）',
  '- A月亮 | 射手 17.6°（257.62°）',
  '- A水星 | 金牛 8.8°（38.79°）',
  '- A金星 | 白羊 9.1°（9.10°）',
  '- A火星 | 双鱼 15.9°（345.90°）',
  '- A木星 | 巨蟹 8.9°（98.93°）',
  '- A土星 | 摩羯 25.3°（295.30°）',
  '- A天王星 | 摩羯 9.3°（279.26°）',
  '- A海王星 | 摩羯 14.4°（284.40°）',
  '- A冥王星 | 天蝎 16.3°（226.26°）',
  '- B太阳 | 狮子 27.3°（147.27°）',
  '- B月亮 | 金牛 11.0°（41.02°）',
  '- B水星 | 狮子 8.9°（128.86°）',
  '- B金星 | 处女 15.7°（165.72°）',
  '- B火星 | 双子 16.0°（75.98°）',
  '- B木星 | 处女 19.0°（168.97°）',
  '- B土星 | 水瓶 14.2°（314.20°）',
  '- B天王星 | 摩羯 14.5°（284.50°）',
  '- B海王星 | 摩羯 16.6°（286.57°）',
  '- B冥王星 | 天蝎 20.3°（230.26°）',
  '- 组合太阳 | 巨蟹 9.3°（99.26°）',
  '- 组合月亮 | 水瓶 29.3°（329.32°）',
  '- 组合水星 | 双子 23.8°（83.83°）',
  '- 组合金星 | 双子 27.4°（87.41°）',
  '- 组合火星 | 金牛 0.9°（30.94°）',
  '- 组合木星 | 狮子 14.0°（133.95°）',
  '- 组合土星 | 水瓶 4.7°（304.75°）',
  '- 组合天王星 | 摩羯 11.9°（281.88°）',
  '- 组合海王星 | 摩羯 15.5°（285.48°）',
  '- 组合冥王星 | 天蝎 18.3°（228.26°）',
  '- B火星-AASC | 刑相 0.0°',
  '- B金星-AASC | 合相 0.2°',
  '- A水星-B水星 | 刑相 0.1°',
  '- A火星-B火星 | 刑相 0.1°',
  '- A海王星-B天王星 | 合相 0.1°',
  '- A火星-B金星 | 对分 0.2°',
  '- A金星-B水星 | 拱相 0.2°',
  '- A冥王星-B海王星 | 六合 0.3°',
  '- A太阳-B冥王星 | 对分 1.0°',
  '- A月亮-B木星 | 刑相 1.4°',
  '- B土星-AMC | 拱相 0.8°',
  ':::',
].join('\n')

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

/** 钉顶助手：盘卡在消息流（role=log）中渲染（与 m54-pan-interactive 同法） */
async function pinTop(page: Page): Promise<void> {
  await page.locator('[role="log"]').evaluate((el) => {
    el.scrollTop = 0
  })
}

async function setupCard(page: Page, cardText: string, sel: string): Promise<Locator> {
  await openApp(page)
  await createSession(page, { title: `E2E-M63F-${Date.now()}` })
  await sendMessage(page, cardText)
  await expectYourTurn(page)
  // 先等收束再钉顶轮询（与 m54 同序：先收束避免胶囊被虚拟列表回收）
  await waitCard(page, sel)
  const card = page.locator(sel).first()
  await expect(card).toBeVisible()
  return card
}

test('M63-B · 行运盘：星环十星 / 相位清单 / 扫描 ribbon / 请教草稿', async ({ page }) => {
  const card = await setupCard(page, TRANSIT, '.pn-transit')

  // 结构：10 行运行星（含 5 逆行标）+ 相位清单 + 扫描 ribbon 4 节点
  await expect(card.locator('.pn-tw-pchip')).toHaveCount(10)
  await expect(card.locator('.pn-tw-pretro')).toHaveCount(5)
  await expect(card.locator('.pn-tw-achip')).toHaveCount(10)
  await expect(card.locator('.pn-tw-ribbon')).toBeVisible()
  await expect(card.locator('.pn-tw-node')).toHaveCount(4)
  await expect(card.locator('.pn-tw-node').first()).toHaveAttribute('title', /11-01/)
  // 扫描为参考区间（非事件断言）——ribbon 头即口径提示
  await expect(card).toContainText('参考区间')

  // 点第一条相位（土星-金星 合相 0.1°）→ 请教草稿入 Composer
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.locator('.pn-tw-achip').first().click()
  await card.getByRole('button', { name: /请教相位 土星-金星/ }).click()
  await expect(composer).toHaveValue(/行运土星-本命金星/)
  await expect(composer).toHaveValue(/合相/)

  // 点扫描节点（土星-金星 精确 2026-11-04 12:00）→ 时点详情 + 关注时点草稿
  await card.locator('.pn-tw-node').nth(2).click()
  await expect(card.locator('.pn-tw-hit')).toContainText('精确 2026-11-04 12:00')
  await composer.fill('')
  await card.getByRole('button', { name: /关注时点 2026-11-04 12:00/ }).click()
  await expect(composer).toHaveValue(/精确时点 2026-11-04 12:00/)
  await expect(composer).toHaveValue(/±14 天/)
})

test('M63-B · 合盘：10×10 矩阵 / 点格草稿 / 组合盘开关', async ({ page }) => {
  const card = await setupCard(page, SYNASTRY, '.pn-synastry')

  // 结构：100 格矩阵 + 命中格 + 轴相位单列 + 元素行 + 知情脚注
  await expect(card.locator('.pn-sy-cell')).toHaveCount(100)
  await expect.poll(() => card.locator('.pn-sy-cell.has-asp').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
  await expect(card.locator('.pn-sy-axes')).toContainText('B火星-AASC')
  await expect(card.locator('.pn-sy-elem')).toContainText('互补 水')
  await expect(card).toContainText('仅基于双方出生数据的关系模式参考')

  // 点第一个命中格 → 中选 + 请教相位草稿
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.locator('.pn-sy-cell.has-asp').first().click()
  await expect(card.locator('.pn-sy-cell.is-on')).toHaveCount(1)
  await card.locator('.pn-ask-btn').first().click()
  await expect(composer).toHaveValue(/请解读/)

  // 组合盘（中点）开 → 组合行星行出现；再点关
  await card.getByRole('button', { name: '组合盘（中点）' }).click()
  await expect(card.locator('.pn-sy-composite')).toBeVisible()
  await expect.poll(() => card.locator('.pn-sy-compitem').count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(10)
  await card.getByRole('button', { name: '组合盘（中点）' }).click()
  await expect(card.locator('.pn-sy-composite')).toHaveCount(0)
})
