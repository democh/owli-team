/**
 * E2E · M63-A 紫微流年层（batch F 收口；mock 模式）：
 * 完整可派生流年卡（horoscopeYear=2026）→ 流年开关（朱砂令牌）→
 * 12 宫流年宫名角标 + 流年命宫单宫标记（疾厄）+ 流年四化徽标（流禄/流权/流科/流忌）+
 * 中心行「流年命宫 疾厄」→ 再点开关复原（零残留）。
 *
 * 卡文本为 server 工具实测输出（ziwei_pan horoscopeYear=2026）；
 * 面板内一切变化为本地显隐（不触发送）。
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 紫微流年卡（1990-05-12 14:30；土五局；流年 2026 丙午 · 流年命宫 疾厄） */
const ZIWEI_YEARLY = [
  '::: pan ziwei 紫微 土五局 ｜ 命宫 丁亥',
  '命造：坤造 ｜ 公历 1990-05-12 14:30（真太阳时校正后 1990-05-12 14:39） ｜ 农历 一九九〇年五月十二 ｜ 未时（13:00~15:00）',
  '四柱：庚午 壬午 庚子 癸未 ｜ 生肖 马 ｜ 星座 双子座',
  '五行局：土五局 ｜ 命主 巨门 ｜ 身主 火星',
  '命身宫：命宫 丁亥 ｜ 身宫 福德 己丑',
  '来因宫：仆役 庚辰',
  '生年四化：禄 太阳 ｜ 权 武曲 ｜ 科 太阴 ｜ 忌 天同',
  '流年：2026 丙午 ｜ 流年命宫 疾厄 ｜ 流年四化 禄 天同 ｜ 权 天机 ｜ 科 文昌 ｜ 忌 廉贞',
  '- 田宅 戊寅 | （空宫） ｜ 杂 天厨 蜚廉 ｜ 长生 病 ｜ 大限 95-104',
  '- 官禄 己卯 | 天府(得) ｜ 文昌(利) ｜ 杂 天喜 咸池 天德 ｜ 长生 衰 ｜ 大限 85-94',
  '- 仆役 庚辰 | 太阴(陷)科 ｜ 地空 ｜ 杂 凤阁 寡宿 天伤 年解 ｜ 长生 帝旺 ｜ 大限 75-84',
  '- 迁移 辛巳 | 廉贞(陷) 贪狼(陷) ｜ 杂 天姚 天才 天巫 破碎 ｜ 长生 临官 ｜ 大限 65-74',
  '- 疾厄 壬午 | 巨门(旺) ｜ 右弼 地劫 ｜ 杂 天福 截路 阴煞 天使 ｜ 长生 冠带 ｜ 大限 55-64',
  '- 财帛 癸未 | 天相(得) ｜ 天钺 陀罗(庙) ｜ 杂 三台 八座 天寿 天月 天空 空亡 ｜ 长生 沐浴 ｜ 大限 45-54',
  '- 子女 甲申 | 天同(旺)忌 天梁(陷) ｜ 左辅 禄存 天马 火星(陷) ｜ 杂 孤辰 ｜ 长生 长生 ｜ 大限 35-44 · 当前',
  '- 夫妻 乙酉 | 武曲(利)权 七杀(旺) ｜ 擎羊(陷) ｜ 杂 红鸾 天贵 封诰 ｜ 长生 养 ｜ 大限 25-34',
  '- 兄弟 丙戌 | 太阳(不)禄 ｜ 铃星(庙) ｜ 杂 龙池 华盖 旬空 ｜ 长生 胎 ｜ 大限 15-24',
  '- 命宫 丁亥 | （空宫） ｜ 文曲(旺) ｜ 杂 天官 月德 ｜ 长生 绝 ｜ 大限 5-14',
  '- 父母 戊子 | 天机(庙) ｜ 杂 解神 天哭 天虚 ｜ 长生 墓 ｜ 大限 115-124',
  '- 福德 己丑 身宫 | 紫微(庙) 破军(旺) ｜ 天魁 ｜ 杂 恩光 台辅 天刑 ｜ 长生 死 ｜ 大限 105-114',
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

test('M63-A · 紫微流年层：开关 / 流年命宫 / 流四化徽标 / 复原', async ({ page }) => {
  const card = await setupCard(page, ZIWEI_YEARLY, '.pn-ziwei')

  // 初始（关）：无流年残留；流年字段行在卡头（流年 2026 丙午）
  await expect(card.locator('.pn-palace')).toHaveCount(12)
  await expect(card.locator('.pn-palace-sui')).toHaveCount(0)
  await expect(card.locator('.pn-sui-mu')).toHaveCount(0)
  await expect(card).toContainText('流年 2026 丙午')

  // 开流年 → 12 宫角标 + 流年命宫唯一（疾厄）+ 四化徽标
  await card.locator('.pn-sui-btn').click()
  await expect(card.locator('.pn-palace-sui')).toHaveCount(12)
  const suiSoul = card.locator('.pn-palace.is-sui')
  await expect(suiSoul).toHaveCount(1)
  await expect(suiSoul).toContainText('疾厄')
  await expect(card.locator('.pn-center-sui-line')).toContainText('流年命宫 疾厄')
  await expect.poll(() => card.locator('.pn-sui-mu').count()).toBeGreaterThanOrEqual(1)

  // 关流年 → 零残留
  await card.locator('.pn-sui-btn').click()
  await expect(card.locator('.pn-palace-sui')).toHaveCount(0)
  await expect(card.locator('.pn-sui-mu')).toHaveCount(0)
  await expect(card.locator('.pn-palace.is-sui')).toHaveCount(0)
})
