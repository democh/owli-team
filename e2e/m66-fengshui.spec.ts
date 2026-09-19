/**
 * E2E · M66-B 堪舆阳宅盘面（mock 模式）：
 * 1) 「堪舆走查」→ yangzhai-master 触发块 → ::: pan luopan 卡 → LuopanBoard（三环罗盘：二十四山 / 八卦 / 九宫）；
 * 2) 默认八宅盘（坎宫 = 伏位）→ 流年飞星 tab（中宫一白）；
 * 3) 宫位点击 → 详情条（合规参考语：传统观点列为慎用方位）；
 * 4) 户型叠图 tab：无附件空态引导（上传前提说明）。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/** 1×1 PNG（附件上传用；与 m33-attachments 同源） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/**
 * 回到最新：打开工作台 / 视口变化后消息区可能不再自动贴底（M12 上滑不打断语义）——
 * 虚拟列表只挂载视口内元素，需主动点「N 条新消息 / 回到最新」浮标才能看见底部新卡（ADR 0167 定式）。
 */
async function jumpToLatest(page: Page): Promise<void> {
  const pill = page.getByRole('button', { name: /条新消息|回到最新/ }).first()
  if (await pill.isVisible().catch(() => false)) {
    await pill.click().catch(() => {})
    await page.waitForTimeout(200)
  }
}

test('M66 · 堪舆阳宅盘面全链（盘卡 → 双盘 → 宫位详情 → 叠图空态）', async ({ page }) => {
  test.setTimeout(300_000)
  const title = `E2E-M66-风水-${Date.now()}`
  await openApp(page)
  await createSession(page, { scene: '堪舆阳宅', title })

  // 1) 堪舆走查（@司南 直接触发 → mock 触发块产出::: pan luopan 卡）
  await sendMessage(page, '@司南 堪舆走查：房子坐北朝南（手机指南针测的）请排盘')
  await expect(async () => {
    await jumpToLatest(page)
    expect(await page.locator('[data-luopan]').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 90_000, intervals: [2_000] })

  const board = page.locator('[data-luopan]').first()
  await expect(board.getByText('壬山 向 丙山')).toBeVisible()
  await expect(board.getByText(/坎宅（东四宅）/)).toBeVisible()

  // 2) 默认八宅盘：坎宫 = 伏位（游年星）
  await expect(board.locator('[data-lp-cell="坎"]')).toContainText('伏位')

  // 宫位点击 → 详情条（八宅态：合规参考语）
  await board.locator('[data-lp-cell="坤"]').click()
  await expect(board.locator('[data-lp-detail]')).toContainText('传统观点列为慎用方位')

  // 流年飞星 tab → 中宫 = 一白
  await board.locator('[data-lp-tab="feixing"]').click()
  await expect(board.locator('[data-lp-cell="中"]')).toContainText('一白')

  // 4) 户型叠图 tab → 无附件空态引导
  await board.locator('[data-lp-tab="overlay"]').click()
  await expect(board.locator('[data-lp-overlay]')).toContainText('上传户型图后可用')

  await expectYourTurn(page)
})

/**
 * M66 续完善全链：
 * 1) 「择日走查」→ yangzhai-master 触发块 → ::: pan zeri 卡 → ZeriBoard（推荐高亮 / 破日合规表述）；
 * 2) 附件上传（户型图）→ 「堪舆走查」→ 盘卡叠图 tab：底图 + 网格 + 旋转对齐（滑条 → 复位）。
 */
test('M66 续完善 · 择日盘与叠图旋转对齐（择日卡 → 附件 → 叠图 → 对齐旋转）', async ({ page }) => {
  test.setTimeout(300_000)
  const title = `E2E-M66z-续完善-${Date.now()}`
  await openApp(page)
  await createSession(page, { scene: '堪舆阳宅', title })

  // 1) 择日走查 → 择日卡
  await sendMessage(page, '@司南 择日走查：下个月搬家，帮我挑几天')
  await expect(async () => {
    await jumpToLatest(page)
    expect(await page.locator('[data-zeri]').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  const zeri = page.locator('[data-zeri]').first()
  await expect(zeri.locator('[data-zr-rec]')).toContainText('2026-09-22')
  await expect(zeri.locator('[data-zr-day="2026-09-26"]')).toContainText('传统列为诸事慎用日')

  // 2) 附件上传（1×1 PNG 作为户型图）→ 堪舆走查 → 叠图 tab
  const input = page.locator('input[type="file"]')
  await input.setInputFiles([{ name: '户型图.png', mimeType: 'image/png', buffer: PNG_1X1 }])
  const send = page.getByRole('button', { name: '发送' })
  await expect(send).toBeEnabled()
  await sendMessage(page, '@司南 堪舆走查：坐北朝南请排盘（附图）')
  await expect(async () => {
    await jumpToLatest(page)
    expect(await page.locator('[data-luopan]').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 90_000, intervals: [2_000] })

  const board = page.locator('[data-luopan]').first()
  await board.locator('[data-lp-tab="overlay"]').click()
  await expect(board.locator('[data-lp-overlay] img')).toBeVisible()

  // 3) 旋转对齐：滑条 90° → 网格旋转；复位归零
  await board.locator('[data-lp-ov-rot]').fill('90')
  await expect(board.locator('[data-lp-ov-rotg]')).toHaveAttribute('transform', 'rotate(90 50 50)')
  await board.locator('[data-lp-ov-reset]').click()
  await expect(board.locator('[data-lp-ov-rotg]')).toHaveAttribute('data-lp-ov-rotg', '0')

  // 4) v3 自动找正：指北模式点击东向 → 旋转角 ~90°；复位
  await board.locator('[data-lp-ov-point]').click()
  await expect(board.locator('.pn-lp-ov-hint')).toBeVisible()
  const stage = board.locator('[data-lp-ov-stage]')
  const sbox = (await stage.boundingBox())!
  await stage.click({ position: { x: sbox.width * 0.9, y: sbox.height * 0.5 } })
  const rotValue = async (): Promise<number> =>
    Number((await board.locator('[data-lp-ov-rotg]').getAttribute('data-lp-ov-rotg')) ?? '0')
  await expect.poll(rotValue, { timeout: 5_000 }).toBeGreaterThan(80)
  expect(await rotValue()).toBeLessThan(100)
  await board.locator('[data-lp-ov-reset]').click()
  await expect(board.locator('[data-lp-ov-rotg]')).toHaveAttribute('data-lp-ov-rotg', '0')

  await expectYourTurn(page)
})
