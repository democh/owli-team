/**
 * E2E · M77 同角多魂 / 成员分身：同一角色的不同灵魂作为多个实例同台。
 * 覆盖：组队台「参与性格」多选入编 → @点名分身（风格断言）→ 分身自动接力 →
 * 成员卡换装（经典实例覆盖 + 事件条）→ 显式全伞（逐一点名，两实例依次出场）；
 * 以及会话内「追加分身」（邀请对话框）与同魂冲突拒绝。
 * （裸名 @ = 主实例的精确断言在 server 单测（waves 数 / 灵魂序列）；e2e 的本场景因 mock
 *  动态接力链会把未发言成员带入，无法区分裸名与全伞的队列差异，故此处直接验证显式全伞。）
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('同角多魂：参与性格多选建编 → 点名分身 → 换装 → 显式全伞两实例出场', async ({ page }) => {
  await openApp(page)

  // 1) 建会话：头脑风暴场景 → 仅留卢娜 → 「参与性格」勾选禅意（= 狂野 + 禅意 双分身）→ 追加费利收尾
  const title = `E2E-M77-多魂-${Date.now()}`
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '组队来源：头脑风暴' }).first().click()
  for (const name of ['梅森', '维克多', '索菲']) {
    await dialog.getByRole('button', { name: new RegExp(name) }).click()
  }
  await dialog.getByRole('button', { name: '狂野', exact: true }).click()
  // 参与性格菜单走 Portal（挂 body，不在 dialog 作用域内）
  const soulMenu = page.getByText('参与性格（可多选）').locator('..')
  await soulMenu.getByRole('button', { name: /^禅意/ }).click()
  await expect(dialog.getByText('×2 分身同台')).toBeVisible()
  await dialog.getByRole('button', { name: /费利/ }).click()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(title)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(composer(page)).toBeVisible()

  // 2) @点名分身：仅禅意出场（mock 风格前缀「（吸气）」）；接力链随后把狂野带入（「兄弟们」）
  const log = page.locator('[role="log"]')
  await sendMessage(page, '@卢娜·禅意 先来一个点子。')
  await expect(log.getByText('（吸气）').first()).toBeVisible()
  // 编制序 = 狂野 → 禅意 → 费利：禅意起跑后经费利方到狂野（第 3 棒）；mock 波次含工具调用时更慢，放宽等待窗口（并发会话下默认 20s 易假失败）
  await expect(log.getByText('兄弟们，脑洞发射').first()).toBeVisible({ timeout: 45_000 })
  await expectYourTurn(page)

  // 3) 换装：经典实例（卢娜·狂野）点击灵魂徽标 → 考据派 → system 事件条（实例标签）
  const wildCard = page.locator('[title="查看 卢娜·狂野 的档案"]')
  await wildCard.getByRole('button', { name: '狂野', exact: true }).click()
  // 灵魂菜单走 Portal（挂 body，不在卡片 / dialog 作用域内）
  await page.getByText('灵魂变体').locator('..').getByRole('button', { name: /^考据派/ }).click()
  await expect(log.getByText('卢娜·狂野 换上了『考据派』灵魂').first()).toBeVisible()

  // 4) 显式全伞（逐一点名）：两个实例依次出场（经典已换「考据派」先发；禅意分身随后入队发言）
  const zenTurnsBefore = await log.getByText('（吸气）').count()
  await sendMessage(page, '@卢娜·考据派 @卢娜·禅意 你俩都说说。')
  await expect(log.getByText('其一，先搭谱系').first()).toBeVisible()
  // 禅意分身随后出场（风格前缀再次出现 = 第二实例已接手）
  await expect(async () => {
    expect(await log.getByText('（吸气）').count()).toBeGreaterThan(zenTurnsBefore)
  }).toPass({ timeout: 30_000 })
  await expectYourTurn(page)

  // 5) 成员条（输入区上方常驻）：两分身各自一条召唤入口
  await expect(page.getByTitle(/召唤 卢娜·考据派/).first()).toBeVisible()
  await expect(page.getByTitle(/召唤 卢娜·禅意/).first()).toBeVisible()
})

test('同角多魂：会话内追加分身（邀请对话框）与同魂冲突拒绝', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M77-追加-${Date.now()}`
  await createSession(page, { title, scene: '头脑风暴', unpick: ['facilitator', 'challenger', 'refiner'] })

  // 会话内追加分身：成员视图底部「邀请成员」→ 卢娜卡「追加分身」→ 禅意 → 邀请 1 位
  await page.getByRole('tab', { name: '成员' }).click()
  await page.getByRole('button', { name: '邀请成员' }).click()
  const inviteDialog = page.getByRole('dialog')
  await expect(inviteDialog.getByText('邀请成员')).toBeVisible()
  await inviteDialog.getByRole('button', { name: '追加分身', exact: true }).click()
  // 分身菜单走 Portal（挂 body，不在 dialog 作用域内）
  const personaMenu = page.getByText('以其他性格入编').locator('..')
  await personaMenu.getByRole('button', { name: /^禅意/ }).click()
  await inviteDialog.getByRole('button', { name: /邀请 1 位/ }).click()
  await expect(inviteDialog).toBeHidden()

  // 双分身同台：成员卡两张 + 事件条
  const log = page.locator('[role="log"]')
  await expect(log.getByText('卢娜·禅意 加入协作').first()).toBeVisible()
  await expect(page.locator('[title="查看 卢娜·狂野 的档案"]')).toBeVisible()
  await expect(page.locator('[title="查看 卢娜·禅意 的档案"]')).toBeVisible()

  // 经典实例换到禅意 → 与分身冲突：toast 报错，事件条不落
  const wildCard = page.locator('[title="查看 卢娜·狂野 的档案"]')
  await wildCard.getByRole('button', { name: '狂野', exact: true }).click()
  // 灵魂菜单走 Portal（挂 body，不在卡片作用域内）；禅意正被分身占用 → toast 冲突
  await page.getByText('灵魂变体').locator('..').getByRole('button', { name: /^禅意/ }).click()
  await expect(page.getByText(/已被同角色的其他实例占用/)).toBeVisible()
  await expect(log.getByText(/换上了『禅意』灵魂/)).toHaveCount(0)
})
