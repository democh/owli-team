/**
 * E2E · M63-E/A 七政四余 × 八字 v2（batch F 收口；mock 模式）：
 * 1) 七政四余：完整可派生星命卡 → 十二宫圆盘（宫名 / 宫支 / 宫主）/ 政余表（11 行 · 近似角标 4）/
 *    逆行标（5）/ 庙旺行 → 点宫「迁移」信息条 → 请教迁移草稿 → 点星「紫炁」草稿（含近似等级）；
 * 2) 八字 v2：完整可派生深化卡 → 神煞 chips（尾段字段行回收验证）/ 柱间 chips（点选高亮两柱）/
 *    小运条 / 流年选中展开流月 → 神煞 / 柱间 两路请教草稿。
 *
 * 卡文本为 server 工具实测输出（qizheng_pan / bazi_pan liuYueOf=2026）；
 * 草稿一律入 Composer 不发送（本地确定性变换）。
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 七政四余盘卡（1990-05-12 14:30；命宫巳） */
const QIZHENG = [
  '::: pan qizheng 七政 命宫巳',
  '出生：公历 1990-05-12 14:30 ｜ Asia/Shanghai ｜ 31.23°N 121.47°E',
  '- 太阳 | 酉宫 21.2°（51.24°）',
  '- 太阴 | 寅宫 17.6°（257.62°）',
  '- 水星 | 酉宫 8.8°（38.79°） ｜ 逆行',
  '- 金星 | 戌宫 9.1°（9.10°）',
  '- 火星 | 亥宫 15.9°（345.90°）',
  '- 木星 | 未宫 8.9°（98.93°）',
  '- 土星 | 丑宫 25.3°（295.30°） ｜ 逆行',
  '- 罗睺 | 子宫 11.5°（311.51°） ｜ 近似：平交点 · 逆行',
  '- 计都 | 午宫 11.5°（131.51°） ｜ 近似：平交点 · 逆行',
  '- 月孛 | 卯宫 21.1°（231.07°） ｜ 近似：平远地点 · 逆行',
  '- 紫炁 | 申宫 20.7°（80.66°） ｜ 近似：古法线性 · 争议口径',
  '- 命宫 巳 | 宫主 水星',
  '- 财帛 辰 | 宫主 金星',
  '- 兄弟 卯 | 宫主 火星 ｜ 月孛',
  '- 田宅 寅 | 宫主 木星 ｜ 太阴',
  '- 男女 丑 | 宫主 土星 ｜ 土星',
  '- 奴仆 子 | 宫主 土星 ｜ 罗睺',
  '- 夫妻 亥 | 宫主 木星 ｜ 火星',
  '- 疾厄 戌 | 宫主 火星 ｜ 金星',
  '- 迁移 酉 | 宫主 金星 ｜ 太阳 水星',
  '- 官禄 申 | 宫主 水星 ｜ 紫炁',
  '- 福德 未 | 宫主 太阴 ｜ 木星',
  '- 相貌 午 | 宫主 太阳 ｜ 计都',
  '庙旺：太阳 庙戌 旺巳 ｜ 太阴 庙亥 旺酉 ｜ 木星 庙寅 旺未 ｜ 火星 庙卯 旺午 ｜ 土星 庙丑 旺寅 ｜ 金星 庙酉 旺申 ｜ 水星 庙申 旺巳',
  '口径：回归黄道十二宫·中气过宫·四余近似（罗计平交点 / 月孛平远地点 / 紫炁古法）；v1 不列二十八宿度',
  ':::',
].join('\n')

/** 八字 v2 卡（同人；liuYueOf=2026 含 12 流月；神煞 7 / 柱间 4 / 小运 10） */
const BAZI_V2 = [
  '::: pan bazi 四柱 庚午 辛巳 庚子 癸未',
  '命造：坤造 ｜ 生肖 马 ｜ 公历 1990-05-12 14:30 ｜ 农历 一九九〇年五月十二',
  '真太阳时：校正 +10 分钟 → 1990-05-12 14:39',
  '四柱：庚午 辛巳 庚子 癸未',
  '十神：比肩 劫财 日主 伤官',
  '藏干：午(丁己) 巳(丙庚戊) 子(癸) 未(己丁乙)',
  '纳音：路旁土 ｜ 白蜡金 ｜ 壁上土 ｜ 杨柳木',
  '五行：木0 火2 土1 金3 水2 ｜ 日主 庚（阳金）',
  '空亡：年戌亥 月申酉 日辰巳 时申酉',
  '地势：年沐浴 月长生 日死 时冠带',
  '胎元：壬申（剑锋金） ｜ 胎息：乙丑（海中金）',
  '命宫：辛巳（白蜡金） ｜ 身宫：己丑（霹雳火）',
  '神煞：天乙贵人（日干→时） ｜ 天德贵人（月支→月） ｜ 月德贵人（月支→年日） ｜ 将星（年支→年） ｜ 将星（日支→日） ｜ 劫煞（日支→月） ｜ 亡神（年支→月）',
  '柱间：地支 午子冲（年日）·午未合（年时）·子未害（日时）·巳午未三会火方（月年时）',
  '运岁：大运戊寅 · 寅巳害（月）·戊癸合（时） ｜ 流年丙午 · 丙辛合（月）·午子冲（日）·午未合（时）',
  '小运：壬子（31岁） ｜ 辛亥（32岁） ｜ 庚戌（33岁） ｜ 己酉（34岁） ｜ 戊申（35岁） ｜ 丁未（36岁） ｜ 丙午（37岁） ｜ 乙巳（38岁） ｜ 甲辰（39岁） ｜ 癸卯（40岁）',
  '流月：2026 丙午',
  '起运：9 年 10 月 0 日 ｜ 2000-04-04 交运 ｜ 大运逆行',
  '- 大运 庚辰 | 11-20 岁 ｜ 2000-2009',
  '- 大运 己卯 | 21-30 岁 ｜ 2010-2019',
  '- 大运 戊寅 | 31-40 岁 ｜ 2020-2029 · 当前大运',
  '- 大运 丁丑 | 41-50 岁 ｜ 2030-2039',
  '- 流年 2025 乙巳 | 36 岁',
  '- 流年 2026 丙午 | 37 岁 · 当前',
  '- 流年 2027 丁未 | 38 岁',
  '- 流月 庚寅 | 正月',
  '- 流月 辛卯 | 二月',
  '- 流月 壬辰 | 三月',
  '- 流月 癸巳 | 四月',
  '- 流月 甲午 | 五月',
  '- 流月 乙未 | 六月',
  '- 流月 丙申 | 七月',
  '- 流月 丁酉 | 八月',
  '- 流月 戊戌 | 九月',
  '- 流月 己亥 | 十月',
  '- 流月 庚子 | 冬月',
  '- 流月 辛丑 | 腊月',
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

test('M63-E · 七政四余：十二宫圆盘 / 政余表 / 庙旺 / 请教草稿', async ({ page }) => {
  const card = await setupCard(page, QIZHENG, '.pn-qizheng')

  // 结构：12 宫 + 政余表 11（近似角标 4 · 逆行 5）+ 庙旺行（尾段字段行回收）
  await expect(card.locator('.pn-qz-cell')).toHaveCount(12)
  await expect(card.locator('.pn-qz-bchip')).toHaveCount(11)
  await expect(card.locator('.pn-qz-bchip.is-approx')).toHaveCount(4)
  await expect(card.locator('.pn-qz-bretro')).toHaveCount(5)
  await expect(card.locator('.pn-qz-miao')).toContainText('太阳 庙戌')

  // 点「迁移」（酉宫）→ 信息条（宫主 · 落星）
  await card.locator('.pn-qz-cell').filter({ hasText: '迁移' }).click()
  await expect(card.locator('.pn-qz-selinfo')).toContainText('迁移 酉宫（金牛）')
  await expect(card.locator('.pn-qz-selinfo')).toContainText('落 太阳 水星')

  // 请教迁移 → 草稿（宫支 / 星座 / 宫主 / 落星）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.getByRole('button', { name: /请教迁移/ }).click()
  await expect(composer).toHaveValue(/迁移宫（酉宫·金牛·宫主 金星·落 太阳、水星）/)

  // 点「紫炁」→ 请教草稿（近似等级如实呈现）
  await composer.fill('')
  await card.locator('.pn-qz-bchip').filter({ hasText: '紫炁' }).click()
  await card.getByRole('button', { name: /请教紫炁/ }).click()
  await expect(composer).toHaveValue(/紫炁（申宫 20.7°/)
  await expect(composer).toHaveValue(/近似：古法线性 · 争议口径/)
})

test('M63-A · 八字 v2：神煞 / 柱间高亮两柱 / 小运 / 流月 / 请教草稿', async ({ page }) => {
  const card = await setupCard(page, BAZI_V2, '.pn-bazi')

  // 神煞 chips（7 命中：天乙 / 天德 / 月德 / 将星×2 / 劫煞 / 亡神）+ 柱间 + 小运 + 流月
  await expect.poll(() => card.locator('.pn-ss-chip').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
  await expect.poll(() => card.locator('.pn-rel-chip').count()).toBeGreaterThanOrEqual(3)
  await expect.poll(() => card.locator('.pn-xy-chip').count()).toBeGreaterThanOrEqual(5)

  // 点神煞「天乙贵人」→ 请教草稿（含起发与命中柱）
  const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
  await composer.fill('')
  await card.locator('.pn-ss-chip').filter({ hasText: '天乙贵人' }).first().click()
  await expect(composer).toHaveValue(/神煞「天乙贵人」/)

  // 点柱间「午未合」→ 高亮两柱（is-rel）+ 请教关系草稿
  await composer.fill('')
  await card.locator('.pn-rel-chip').filter({ hasText: '午未合' }).click()
  await expect.poll(() => card.locator('.pn-pillar.is-rel').count()).toBe(2)
  await card.getByRole('button', { name: /请教关系 午未合/ }).click()
  await expect(composer).toHaveValue(/午未合/)

  // 选中流年「2026 丙午」→ 展开 12 流月
  await card.getByRole('button', { name: /2026 丙午/ }).click()
  await expect(card.locator('.pn-ly')).toContainText('流月（2026 丙午 · 12 条）')
  await expect(card.locator('.pn-lychip')).toHaveCount(12)
})
