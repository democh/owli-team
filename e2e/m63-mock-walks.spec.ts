/**
 * E2E · M63 走查触发块全链路（收官走查；mock 模式）：
 * 八组深走查触发词经真实角色回复路径（@召唤 → 平台派单 → mock 块回复 → 消息渲染）——
 * 覆盖此前只经「用户贴卡」验证的渲染链的另一半（回复内卡）：
 * 1) 传统数术 · 批一：八字深走查（神煞/柱间 v2 卡）/ 流年走查（流年层卡）/ 六壬走查（课卡）；
 * 2) 传统数术 · 批二：卦深走查（伏神月日卡）/ 奇门走查（阴五局卡）/ 七政走查（十二宫卡）；
 * 3) 星象占星：行运走查（扫描卡）/ 合盘走查（A×B 卡）；
 * 4) 行运泳道：组队台跨场景加星移（真跨场景路径）→ 八字+紫微+行运三盘入面板 →
 *    合参出第三泳道（时点◆节点）→ 节点详情（参考时点声明）；
 * 5) 中西对照（§7 F-t1）：组队台跨场景加司辰 → 四柱+本命星盘并排（仅并置）+ 出生参数一致性提示。
 *
 * 断言只取「块卡格式与渲染对接」的关键结构（完整交互面已由 m63-* 四条贴卡 spec 覆盖）。
 */
import { expect, test, type Page } from '@playwright/test'
import { AGENT_NAME, COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/**
 * 长链走查预算：三盘召唤 × 串行发言的 mock 回复路径在长套件负载下可显著慢于单跑；
 * 用例内等待上限为 120_000（expectYourTurn），必须高于全局 90_000 的测试预算才具语义
 * （否则任何波动都会以「测试超时」呈现，掩盖真实断言结果）。
 */
test.describe.configure({ timeout: 150_000 })

/** 钉顶助手（role=log 滚动容器；与 m63 其余 spec 同法） */
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
      { timeout: 60_000, intervals: [300, 600, 1200] },
    )
    .toBeGreaterThan(0)
}

test('M63 走查 · 传统数术批一：八字 v2 / 流年层 / 六壬课卡（回复路径）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M63W-${Date.now()}`, scene: '传统数术' })
  await sendMessage(page, '@观复 请排盘看结构（八字深走查）。@星垣 看流年（流年走查）。@溯机 起一课（六壬走查）。')
  await expectYourTurn(page, 120_000)

  // 八字 v2 卡（神煞 / 柱间 / 小运）
  await waitCard(page, '.pn-bazi')
  const bazi = page.locator('.pn-bazi').first()
  await expect.poll(() => bazi.locator('.pn-ss-chip').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(5)
  await expect.poll(() => bazi.locator('.pn-rel-chip').count()).toBeGreaterThanOrEqual(3)
  await expect(bazi.locator('.pn-xiaoyun')).toBeVisible()

  // 流年层卡（流年开关可点开 → 12 宫角标）
  await waitCard(page, '.pn-ziwei')
  const ziwei = page.locator('.pn-ziwei').first()
  await ziwei.locator('.pn-sui-btn').click()
  await expect(ziwei.locator('.pn-palace-sui')).toHaveCount(12)

  // 六壬课卡（天地盘三层 / 四课 / 三传）
  await waitCard(page, '.pn-daliuren')
  const dl = page.locator('.pn-daliuren').first()
  await expect(dl.locator('.pn-dl-di')).toHaveCount(12)
  await expect(dl.locator('.pn-ke-col')).toHaveCount(4)
  await expect(dl.locator('.pn-chuan-card')).toHaveCount(3)
})

test('M63 走查 · 传统数术批二：卦 / 奇门 / 七政（回复路径）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M63W-${Date.now()}`, scene: '传统数术' })
  await sendMessage(page, '@灼见 起一卦（卦深走查）。@奇正 起一局（奇门走查）。@步天 排七政盘（七政走查）。')
  await expectYourTurn(page, 120_000)

  // 六爻卡（爻列 6）
  await waitCard(page, '.pn-gua')
  await expect(page.locator('.pn-gua').first().locator('.pn-yao')).toHaveCount(6)

  // 奇门卡（九宫格洛书序）
  await waitCard(page, '.pn-qimen')
  const qm = page.locator('.pn-qimen').first()
  await expect(qm.locator('.pn-qm-cell')).toHaveCount(9)
  await expect(qm.locator('.pn-qm-cell').first()).toHaveAttribute('data-gong', '4')

  // 七政卡（十二宫 / 政余表）
  await waitCard(page, '.pn-qizheng')
  const qz = page.locator('.pn-qizheng').first()
  await expect(qz.locator('.pn-qz-cell')).toHaveCount(12)
  await expect(qz.locator('.pn-qz-bchip')).toHaveCount(11)
})

test('M63 走查 · 星象占星：行运 / 合盘（回复路径）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M63W-${Date.now()}`, scene: '星象占星' })
  await sendMessage(page, '@星移 看行运重点（行运走查）。@合璧 做合盘（合盘走查）。')
  await expectYourTurn(page, 120_000)

  // 行运卡（行运十星 / 相位清单）
  await waitCard(page, '.pn-transit')
  const tr = page.locator('.pn-transit').first()
  await expect(tr.locator('.pn-tw-pchip')).toHaveCount(10)
  await expect.poll(() => tr.locator('.pn-tw-achip').count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(3)

  // 合盘卡（10×10 矩阵）
  await waitCard(page, '.pn-synastry')
  await expect(page.locator('.pn-synastry').first().locator('.pn-sy-cell')).toHaveCount(100)
})

test('M63-F 行运泳道 · 组队台跨场景加星移 → 三盘入面板 → 合参第三泳道（时点节点/详情）', async ({ page }) => {
  await openApp(page)
  // 组队台手写（跨场景真实路径）：传统数术来源 + 池卡加「星移」（角色池全量可选）
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  await dialog.getByRole('button', { name: '组队来源：传统数术' }).first().click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M63W-泳道-${Date.now()}`)
  for (const id of ['liuyao', 'meihua', 'qizheng', 'daliuren', 'qimen']) {
    await dialog.getByRole('button', { name: new RegExp(AGENT_NAME[id] ?? id) }).click()
  }
  await dialog.getByPlaceholder('搜索角色 / 能力…').fill('星移')
  await dialog.getByRole('button', { name: /星移/ }).click()
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 三盘（均角色产出）：八字 + 流年 + 行运
  await sendMessage(page, '@观复 请排盘（八字深走查）。@星垣 看流年（流年走查）。@星移 看行运（行运走查）。')
  await expectYourTurn(page, 120_000)
  await waitCard(page, '.pn-bazi')
  await waitCard(page, '.pn-ziwei')
  await waitCard(page, '.pn-transit')

  // 面板：三卡 tabs → 合参 → 第三泳道（行运 · 时点）+ 4 节点（mock 块 4 命中）
  const panel = page.locator('.scene-dock-aside')
  await expect(panel.getByText('盘面面板')).toBeVisible()
  await expect(panel.locator('.scene-pb-tab')).toHaveCount(3)
  const almToggle = panel.locator('.pn-alm-toggle')
  await expect(almToggle).toBeVisible()
  await almToggle.click()
  await expect(panel.locator('.pn-alm-lane')).toHaveCount(3)
  await expect(panel.locator('.pn-alm-lane-cap').nth(2)).toHaveText('行运 · 时点')
  await expect(panel.locator('.pn-alm-node')).toHaveCount(4)

  // 点首个节点 → 详情行（精确时点 + 参考时点声明）；再点取消
  await panel.locator('.pn-alm-node').first().click()
  await expect(panel.locator('.pn-alm-detail')).toContainText('精确 2026-01-06 16:52')
  await expect(panel.locator('.pn-alm-detail')).toContainText('参考时点，非事件断言')
  await panel.locator('.pn-alm-node').first().click()
  await expect(panel.locator('.pn-alm-hint')).toContainText('行运 ◆')
})

test('M63 续完善 · 中西对照：组队台跨场景加司辰 → 并排双盘 + 参数一致性提示', async ({ page }) => {
  await openApp(page)
  // 组队台：传统数术来源（仅留观复）+ 池卡加「司辰」（本命星盘）
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  await dialog.getByRole('button', { name: '组队来源：传统数术' }).first().click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M63X-对照-${Date.now()}`)
  for (const id of ['ziwei', 'liuyao', 'meihua', 'qizheng', 'daliuren', 'qimen']) {
    await dialog.getByRole('button', { name: new RegExp(AGENT_NAME[id] ?? id) }).click()
  }
  await dialog.getByPlaceholder('搜索角色 / 能力…').fill('司辰')
  await dialog.getByRole('button', { name: /司辰/ }).click()
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 双盘（均角色产出）：四柱（盘面走查块）+ 本命星盘（M63 续完善新增 natal 块）
  await sendMessage(page, '@观复 请排盘（盘面走查）。@司辰 排本命星盘（盘面走查）。')
  await expectYourTurn(page, 120_000)
  await waitCard(page, '.pn-bazi')
  await waitCard(page, '.pn-natal')

  // 面板 → 中西对照 toggle → 并排双盘 + 一致提示 + 口径注
  const panel = page.locator('.scene-dock-aside')
  await expect(panel.getByText('盘面面板')).toBeVisible()
  const crossBtn = panel.getByRole('button', { name: '中西对照' })
  await expect(crossBtn).toBeVisible()
  await crossBtn.click()
  await expect(panel.locator('.scene-pb-cross')).toBeVisible()
  await expect(panel.locator('.scene-pb-cross-grid .md-pan')).toHaveCount(2)
  await expect(panel.locator('.scene-pb-cross-note').first()).toContainText('出生参数一致')
  await expect(panel.locator('.scene-pb-cross-note.is-quiet')).toContainText('仅并置呈现')

  // 收起 → 零残留
  await panel.getByRole('button', { name: '收起对照' }).click()
  await expect(panel.locator('.scene-pb-cross')).toHaveCount(0)
})
