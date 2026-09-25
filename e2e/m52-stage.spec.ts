/**
 * E2E · M52-A/B/C 场景工作区体系（mock 模式）：
 * 1) M52-A · 传统数术（dock + chartboard）：M58 无数据不渲染工作区（有数据后出现）；
 *    「切回纯列表」开关回退 stream，再点恢复；
 * 2) M52-A · 窄屏（<900px）：M58 无数据不渲染（含抽屉）；有产出后底部抽屉出现（默认收起），展开后面板可见；
 * 3) M52-B · 四形态点亮走查：roundtable（议题圆桌）/ arena（谈判桌，含回合轴推进）/
 *    dock·board（创作工作室）/ dock·coach（职业发展）；
 * 4) M52-B · arena 窄屏降级：单流 + 席位横条（左右席栏与中轴席位不渲染）；
 * 5) M52-C · 既有场景接入逐场景走查：C1 研讨域（头脑风暴 / 深度研究 / 商业战略，roundtable·pool）/
 *    C2 工作域（站点可靠性·市场增长·销售客户·商业智能·融资资本 console + 投资研究 versus）/
 *    C3 生活域（健康生活 / 学习成长 / 出行旅行 / 财富管理 / 个人管理，coach）；
 * 6) M52-C · roundtable 窄屏降级：席位横条 + M58 无产物不渲染汇聚板抽屉；
 * 7) M52-D · arena 席位发言流：左右席下栏投影（空态 → 该席发言条目 + 轮次徽标）；
 * 8) M58 · 面板无数据不展示：六面板就绪判定接入宿主（无数据零工作区结构）；标题合行
 *    （折叠 / 关闭钮收口进面板标题行）+ 折叠 / 关闭 / 恢复交互全链；
 * 9) 批九 · dock 右区宽度：拖拽到最宽 = 容器一半（半屏上限）；双击复位回自适应。
 */
import { expect, test } from '@playwright/test'
import { COMPOSER_PLACEHOLDER, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

test('M52-A · dock 工作区：无数据不渲染（标题合行与开关）', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '传统数术', title: `E2E-M52-数术-${Date.now()}` })

  // M58：无盘面数据 → 工作区整体不渲染（右区 / 面板标题 / 空态均无，消息流直通）
  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.locator('.scene-dock-aside')).toHaveCount(0)
  await expect(page.getByText('盘面面板')).toHaveCount(0)
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 「切回纯列表」开关仍在标题栏（与面板数据无关）：切换态翻转
  await page.getByTitle('切回纯列表（对话与消息不变）').click()
  await expect(page.getByTitle('恢复场景工作区视图')).toBeVisible()
  await page.getByTitle('恢复场景工作区视图').click()
  await expect(page.getByTitle('切回纯列表（对话与消息不变）')).toBeVisible()
})

test('M52-A · 窄屏：无数据不渲染；有产出后底部抽屉出现（默认收起，可展开）', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await openApp(page)

  // 窄屏（<1024px）：左栏折叠为会话抽屉，从抽屉内发起新建（嵌套 Dialog）
  await page.getByTitle('会话列表').click()
  const sessDrawer = page.getByRole('dialog', { name: '会话列表' })
  await expect(sessDrawer).toBeVisible()
  await sessDrawer.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await dialog.getByRole('button', { name: '组队来源：站点可靠性' }).click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M52-窄屏-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // M58：无产出 → 工作区与抽屉均不渲染
  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.locator('.scene-drawer')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)

  // 发消息 → 成员产出（mock 首次发言 write_file）→ 看板面板就绪 → 抽屉出现（默认收起）
  await sendMessage(page, '请盘一遍本周的线上稳定性巡检与告警收敛，产出落工作区。')
  await expectYourTurn(page)
  await expect(page.locator('.scene-drawer')).toBeVisible()
  const drawerBar = page.locator('.scene-drawer-bar')
  await expect(drawerBar).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByText('看板面板')).toHaveCount(0)

  // 展开抽屉 → 面板可见（有数据：空态文案不出现）
  await drawerBar.click()
  await expect(drawerBar).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('看板面板')).toBeVisible()
  await expect(page.getByText('活动与产出将在这里显示')).toHaveCount(0)
})

// ---------- M52-B：四形态点亮走查 ----------

test('M52-B · roundtable（议题圆桌）：席位环 + 议程条 + 无产物不渲染汇聚板', async ({ page }) => {
  await openApp(page)

  // 注：预设 issue-roundtable 与场景 society 同名（「议题圆桌」唯一重名对，M52-B 实测）——
  // 组队台两区（快速组队 / 按场景组队）同名两按钮，按场景行独有文案（∥ 并行协作）精确定位。
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  await dialog.locator('button').filter({ hasText: '议题圆桌' }).filter({ hasText: '并行协作' }).click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M52B-圆桌-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 形态：席位环（3 位成员逐一在环上）+ 议程条（4 条 agenda）
  await expect(page.locator('.scene-rt')).toBeVisible()
  const ring = page.locator('.scene-seat-ring')
  await expect(ring).toBeVisible()
  for (const name of ['齐观', '方衡', '允中']) {
    await expect(ring.getByText(name)).toBeVisible()
  }
  const agenda = page.locator('.scene-agenda')
  await expect(agenda).toBeVisible()
  await expect(agenda.getByText('组织议题研讨')).toBeVisible()

  // M58：无产物 → 汇聚板不渲染（无数据不展示）
  await expect(page.locator('.scene-rt-aside')).toHaveCount(0)
  await expect(page.getByText('研讨产物将汇聚在这里')).toHaveCount(0)
})

test('M52-B · arena（谈判桌）：计分板 + 左右席 + 发消息后回合轴推进', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '谈判桌', title: `E2E-M52B-谈判-${Date.now()}` })

  // 静态结构：左右席栏 + 中轴（教练席位）；谈判桌未配计分板部件（scoreboard 为辩论专属，随场景下线）
  await expect(page.locator('.scene-arena')).toBeVisible()
  await expect(page.locator('.scene-arena-left')).toBeVisible()
  await expect(page.locator('.scene-arena-right')).toBeVisible()
  const center = page.locator('.scene-arena-center')
  await expect(center).toBeVisible()
  await expect(center.getByText('苏纵')).toBeVisible()

  // M52-D：左右席发言流已挂载（空态提示，两侧留白不再空白）
  await expect(page.locator('.scene-arena-left .scene-side-empty')).toHaveText('该席发言将显示在这里')
  await expect(page.locator('.scene-arena-right .scene-side-empty')).toHaveText('该席发言将显示在这里')

  // 发消息 → 回合推进 → 回合轴出现 → 全链收束
  await sendMessage(page, '@谭成 @祁弈 就这单采购谈一轮：先各自出价，再逐轮让步看能否成交。')
  await expect(page.locator('.scene-arena-track')).toBeVisible({ timeout: 60_000 })
  // M60（§81）：live 通道——run 收束前侧栏条目已实时入流（流式描边 data-streaming）
  await expect(
    page
      .locator('.scene-arena-left .scene-side-item[data-streaming="true"], .scene-arena-right .scene-side-item[data-streaming="true"]')
      .first(),
  ).toBeVisible()
  await expectYourTurn(page)

  // M52-D：该席发言投影进侧栏（左谭成 / 右祁弈，含轮次徽标）
  const leftItem = page.locator('.scene-arena-left .scene-side-item').first()
  const rightItem = page.locator('.scene-arena-right .scene-side-item').first()
  await expect(leftItem).toBeVisible()
  await expect(rightItem).toBeVisible()
  await expect(page.locator('.scene-arena-left .scene-side-turn').first()).toContainText(/第 \d+ 轮/)
  // 空态已被条目替换
  await expect(page.locator('.scene-arena-left .scene-side-empty')).toHaveCount(0)

  // M60（§81）· 续修订三轮：侧栏宽度自适应——clamp(164px, 宿主 22%, 340px)，全屏 / 大屏不再固定 164 窄条
  const bodyBox = (await page.locator('.scene-arena-body').boundingBox())!
  const leftBox = (await page.locator('.scene-arena-left').boundingBox())!
  const rightBox = (await page.locator('.scene-arena-right').boundingBox())!
  expect(Math.abs(leftBox.width - Math.max(164, Math.min(340, bodyBox.width * 0.22)))).toBeLessThan(2)
  // 左右两栏同口径等宽（同一 clamp 公式 + 同一包含块 .scene-arena-body）
  expect(
    Math.abs(leftBox.width - rightBox.width),
    `left=${leftBox.width} right=${rightBox.width}`,
  ).toBeLessThan(2)
  // 续修订二轮：滚动条占位一致性——两侧恒预留 gutter（scrollbar-gutter: stable），
  // 经典滚动条（鼠标模式）仅占溢出一侧曾令左右内容区标尺差 ~15px（观感「宽度不一致」）
  const gutterLeft = await page.locator('.scene-arena-left').evaluate((el) => getComputedStyle(el).scrollbarGutter)
  const gutterRight = await page.locator('.scene-arena-right').evaluate((el) => getComputedStyle(el).scrollbarGutter)
  expect(gutterLeft).toBe('stable')
  expect(gutterRight).toBe('stable')
  // 两侧内容区宽度（clientWidth）严格一致
  const clientWs = await page.locator('.scene-arena-side').evaluateAll((els) => els.map((el) => el.clientWidth))
  expect(clientWs).toHaveLength(2)
  expect(Math.abs((clientWs[0] ?? 0) - (clientWs[1] ?? 0))).toBeLessThan(1)
  // 视口放宽 → 侧栏随宿主变宽（比例跟随，非固定值）
  await page.setViewportSize({ width: 1728, height: 1000 })
  const wideLeft = (await page.locator('.scene-arena-left').boundingBox())!
  const wideRight = (await page.locator('.scene-arena-right').boundingBox())!
  expect(wideLeft.width).toBeGreaterThan(leftBox.width)
  expect(
    Math.abs(wideLeft.width - wideRight.width),
    `left=${wideLeft.width} right=${wideRight.width}`,
  ).toBeLessThan(2)
})

test('M52-B · dock·board（创作工作室）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '创作工作室', title: `E2E-M52B-写作-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('工序面板')).toHaveCount(0)
})

test('M52-B · dock·coach（职业发展）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '职业发展', title: `E2E-M52B-求职-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-B · arena 窄屏：单流 + 席位横条（左右席栏 / 中轴席位不渲染）', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await openApp(page)

  // 窄屏（<1024px）：左栏折叠为会话抽屉，从抽屉内发起新建（嵌套 Dialog）
  await page.getByTitle('会话列表').click()
  const sessDrawer = page.getByRole('dialog', { name: '会话列表' })
  await expect(sessDrawer).toBeVisible()
  await sessDrawer.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await dialog.getByRole('button', { name: '组队来源：谈判桌' }).click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M52B-窄屏-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 降级：席位横条 + 单流；左右席栏与中轴席位不渲染
  await expect(page.locator('.scene-arena')).toBeVisible()
  await expect(page.locator('.scene-seat-strip')).toBeVisible()
  await expect(page.locator('.scene-arena-left')).toHaveCount(0)
  await expect(page.locator('.scene-arena-right')).toHaveCount(0)
  await expect(page.locator('.scene-arena-center')).toHaveCount(0)
  await expect(page.locator('.scene-arena-main')).toBeVisible()
})

// ---------- M52-C：既有场景接入逐场景走查（C1 研讨域 / C2 工作域 / C3 生活域） ----------

test('M52-C1 · 头脑风暴（roundtable·pool）：席位环 4 席 + 议程 + 无产物不渲染汇聚板', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '头脑风暴', title: `E2E-M52C-风暴-${Date.now()}` })

  await expect(page.locator('.scene-rt')).toBeVisible()
  const ring = page.locator('.scene-seat-ring')
  await expect(ring).toBeVisible()
  for (const name of ['梅森', '卢娜', '维克多', '索菲']) {
    await expect(ring.getByText(name)).toBeVisible()
  }
  await expect(page.locator('.scene-agenda').getByText('快速发散')).toBeVisible()
  // M58：无产物 → 汇聚板不渲染
  await expect(page.locator('.scene-rt-aside')).toHaveCount(0)
  await expect(page.getByText('研讨产物将汇聚在这里')).toHaveCount(0)
})

test('M52-C1 · 深度研究（roundtable·pool）：席位环 4 席 + 无产物不渲染汇聚板', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '深度研究', title: `E2E-M52C-研究-${Date.now()}` })

  await expect(page.locator('.scene-rt')).toBeVisible()
  const ring = page.locator('.scene-seat-ring')
  for (const name of ['雷蒙', '切斯特', '安娜', '薇拉']) {
    await expect(ring.getByText(name)).toBeVisible()
  }
  await expect(page.locator('.scene-agenda').getByText('快速调研')).toBeVisible()
  await expect(page.locator('.scene-rt-aside')).toHaveCount(0)
})

test('M52-C1 · 商业战略（roundtable·pool）：席位环 3 席 + 无产物不渲染汇聚板', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '商业战略', title: `E2E-M52C-战略-${Date.now()}` })

  await expect(page.locator('.scene-rt')).toBeVisible()
  const ring = page.locator('.scene-seat-ring')
  for (const name of ['柏川', '顾远', '赛琳']) {
    await expect(ring.getByText(name)).toBeVisible()
  }
  await expect(page.locator('.scene-agenda').getByText('经营简报')).toBeVisible()
  await expect(page.locator('.scene-rt-aside')).toHaveCount(0)
})

test('M52-C2 · 站点可靠性（dock·console）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '站点可靠性', title: `E2E-M52C-SRE-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)
})

test('M52-C2 · 市场增长（dock·console）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '市场增长', title: `E2E-M52C-营销-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)
})

test('M52-C2 · 销售客户（dock·console）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '销售客户', title: `E2E-M52C-销售-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)
})

test('M52-C2 · 商业智能（dock·console）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '商业智能', title: `E2E-M52C-BI-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)
})

test('M52-C2 · 融资资本（dock·console）：有产出后出现 + 折叠 / 关闭 / 恢复全链', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '融资资本', title: `E2E-M52C-融资-${Date.now()}` })

  // M58：无数据不渲染（右区 / 面板标题 / 空态均无）
  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.locator('.scene-dock-aside')).toHaveCount(0)
  await expect(page.getByText('看板面板')).toHaveCount(0)

  // 发消息 → 成员产出就绪 → 工作区自动出现（标题合行：折叠 / 关闭钮在标题行）
  await sendMessage(page, '请梳理本轮融资的关键节点与材料清单，产出落工作区。')
  await expectYourTurn(page)
  await expect(page.locator('.scene-dock-aside')).toBeVisible()
  await expect(page.getByText('看板面板')).toBeVisible()
  const head = page.locator('.scene-dock-aside .scene-panel-head')
  await expect(head.getByText('看板面板')).toBeVisible()
  await expect(head.getByTitle('折叠工作区')).toBeVisible()
  await expect(head.getByTitle('关闭工作区')).toBeVisible()
  await expect(page.locator('.scene-console-item').first()).toBeVisible()
  await expect(page.getByText('活动与产出将在这里显示')).toHaveCount(0)

  // 折叠 → 竖条；展开恢复
  await head.getByTitle('折叠工作区').click()
  await expect(page.locator('.scene-dock-aside.scene-dock-collapsed')).toBeVisible()
  await expect(page.getByText('看板面板')).toHaveCount(0)
  await page.getByTitle('展开工作区').click()
  await expect(page.locator('.scene-dock-aside:not(.scene-dock-collapsed)')).toBeVisible()
  await expect(page.getByText('看板面板')).toBeVisible()

  // 关闭 → 主区「工作区」按钮；点击恢复
  await page.getByTitle('关闭工作区').click()
  await expect(page.locator('.scene-dock-aside')).toHaveCount(0)
  await page.getByTitle('显示工作区').click()
  await expect(page.locator('.scene-dock-aside')).toBeVisible()
  await expect(page.getByText('看板面板')).toBeVisible()
})

test('批九 · dock 右区宽度：默认自适应 · 拖到最宽 = 容器一半 · 双击复位回自适应', async ({ page }) => {
  await page.setViewportSize({ width: 1680, height: 900 })
  await openApp(page)
  await createSession(page, { scene: '融资资本', title: `E2E-M52-宽度-${Date.now()}` })

  // 发消息 → 工作区就绪
  await sendMessage(page, '请梳理本轮融资的关键节点与材料清单，产出落工作区。')
  await expectYourTurn(page)
  const aside = page.locator('.scene-dock-aside')
  await expect(aside).toBeVisible()

  // 默认自适应：容器 1/3（clamp 380–600），且不越「最多一半」上限
  const dockBox = (await page.locator('.scene-dock').boundingBox())!
  const initialW = (await aside.boundingBox())!.width
  expect(initialW).toBeGreaterThanOrEqual(379)
  expect(initialW).toBeLessThanOrEqual(Math.min(600, Math.floor(dockBox.width / 2)) + 1)

  // 拖拽把手到容器最左缘 → 收敛到「最多一半」
  const grip = page.locator('.scene-dock-grip')
  const gripBox = (await grip.boundingBox())!
  const gripY = gripBox.y + gripBox.height / 2
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripY)
  await page.mouse.down()
  await page.mouse.move(dockBox.x + 2, gripY, { steps: 8 })
  await page.mouse.up()
  await expect(async () => {
    const w = (await aside.boundingBox())!.width
    expect(Math.abs(w - dockBox.width / 2)).toBeLessThanOrEqual(2)
  }).toPass()

  // 双击把手 → 复位回自适应宽（与初始一致）
  await grip.dblclick()
  await expect(async () => {
    const w = (await aside.boundingBox())!.width
    expect(Math.abs(w - initialW)).toBeLessThanOrEqual(1)
  }).toPass()

  // 窗口变宽 → 自适应宽跟随（1/3 口径生效：跨宽带梯度到 600 封顶）
  await page.setViewportSize({ width: 2400, height: 900 })
  const grownBox = (await page.locator('.scene-dock').boundingBox())!
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeGreaterThan(initialW + 20)
  expect((await aside.boundingBox())!.width).toBeLessThanOrEqual(Math.min(600, Math.floor(grownBox.width / 2)) + 1)
})

test('M52-C2 · 投资研究（dock·versus）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '投资研究', title: `E2E-M52C-投资-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('局势面板')).toHaveCount(0)
})

test('M52-C3 · 健康生活（dock·coach）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '健康生活', title: `E2E-M52C-健康-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-C3 · 学习成长（dock·coach）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)

  // 注：预设「学习成长季」含场景名「学习成长」子串（getByRole 子串匹配歧义，M52-C 实测）——
  // 用 aria-label 精确选择器定位场景行。
  await page.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('新建会话')).toBeVisible()
  await dialog.locator('button[aria-label="组队来源：学习成长"]').click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M52C-学习-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-C3 · 出行旅行（dock·coach）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '出行旅行', title: `E2E-M52C-旅行-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-C3 · 财富管理（dock·coach）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '财富管理', title: `E2E-M52C-财富-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-C3 · 个人管理（dock·coach）：无数据不渲染工作区', async ({ page }) => {
  await openApp(page)
  await createSession(page, { scene: '个人管理', title: `E2E-M52C-个人-${Date.now()}` })

  await expect(page.locator('.scene-dock')).toHaveCount(0)
  await expect(page.getByText('陪跑面板')).toHaveCount(0)
})

test('M52-C · roundtable 窄屏：席位横条 + 无产物不渲染汇聚板抽屉', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 900 })
  await openApp(page)

  // 窄屏（<1024px）：左栏折叠为会话抽屉，从抽屉内发起新建（嵌套 Dialog）
  await page.getByTitle('会话列表').click()
  const sessDrawer = page.getByRole('dialog', { name: '会话列表' })
  await expect(sessDrawer).toBeVisible()
  await sessDrawer.getByTitle('新建会话').click()
  const dialog = page.getByRole('dialog', { name: '新建会话' })
  await dialog.getByRole('button', { name: '组队来源：头脑风暴' }).click()
  await expect(dialog.getByText(/已选 \d+ 位/)).toBeVisible()
  await dialog.getByPlaceholder('会话标题（可选，默认自动生成）').fill(`E2E-M52C-窄屏-${Date.now()}`)
  await dialog.getByRole('button', { name: '创建并进入' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByPlaceholder(COMPOSER_PLACEHOLDER)).toBeVisible()

  // 降级：席位环换席位横条；M58 无产物 → 汇聚板与抽屉均不渲染（工作区不展示）
  await expect(page.locator('.scene-seat-strip')).toBeVisible()
  await expect(page.locator('.scene-seat-ring')).toHaveCount(0)
  await expect(page.locator('.scene-rt-aside')).toHaveCount(0)
  await expect(page.locator('.scene-drawer')).toHaveCount(0)
  await expect(page.getByText('研讨产物将汇聚在这里')).toHaveCount(0)
})
