/**
 * E2E · M43 多方 PK 范式（§72，mock 模式）：
 * 1) 辩论场（arena + 关闭串行）：@立言 @砺锋 同波对决 → 对决组二栏（PK-1：分侧 / 阶段徽章 /
 *    计分板）→ 主张卡与缺陷-修补配对卡（PK-2）→ @昭实 按编号回补 → 「已响应」由后续提及
 *    推导点亮（3/3）→ @明断 终局裁决 → arena 中轴裁决流 chip（§72.5）；
 *    M63（批一）：交锋看板（CrossFire）/ 轮次判定（ruling 色点与轮次分）/ 终局结论条 /
 *    对抗参与条（倾向回填草稿不发送）；
 * 2) 谈判桌：@谭成 @祁弈 首轮出价 / 还价 → 报价卡（价格键高亮）+ 中轴报价流面板
 *    （相邻出价差 ↓30 万，is-down 色标）；M63：报价折线（双方点位）+ 三桩基准线 + 让步刻度。
 * 注：场景工作区流式期间冻结（M52-A 口径），收束后断言；流中卡片先滚顶让虚拟窗口渲染
 * （M52-D 同口径——第 0 波组滚出渲染窗口即被剪枝）。
 */
import { expect, test } from '@playwright/test'
import { composer, createSession, disableSerial, expectRunSettled, openApp, sendMessage } from './helpers'

test('M43 · 辩论场：对决组 → 配对卡已响应 → 裁决流', async ({ page }) => {
  test.setTimeout(150_000) // M66：新增交锋走查段（共享环境负载下链路更长）
  await openApp(page)
  const title = `E2E-M43-辩论-${Date.now()}`
  await createSession(page, { scene: '辩论场', title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  // @ 正反双方触发首波 2 人并行（parallelMax 2）→ 同波对决组
  await sendMessage(page, '@立言 @砺锋 辩一辩：远程办公利大于弊吗？正反双方逐轮交锋。')
  await expectRunSettled(page)

  // 收束后滚顶：第 0 波对决组与两张卡进入虚拟渲染窗口
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })

  // PK-1：对决组（arena 席位分侧）二栏 + 阶段徽章 + 计分板
  const duel = log.locator('[data-wave-group="duel"]').first()
  await expect(duel).toBeVisible()
  await expect(duel.locator('[data-duel-phase]')).toHaveText('立论')
  await expect(duel.locator('[data-duel-meter]')).toContainText('vs')
  const left = duel.locator('[data-side="left"]')
  const right = duel.locator('[data-side="right"]')
  await expect(left).toContainText('立言')
  await expect(left).toContainText('正方立论（第 1 轮）')
  await expect(right).toContainText('砺锋')
  await expect(right).toContainText('反方立论（第 1 轮）')

  // PK-2：主张卡（论据挂证据）与缺陷-修补配对卡（3 行）
  const claim = log.locator('.md-claim').first()
  await expect(claim).toBeVisible()
  await expect(claim.locator('.scene-claim-title')).toHaveText('正方核心主张：净收益为正，且风险可被流程对冲')
  const findings = log.locator('.md-findings').first()
  await expect(findings).toBeVisible()
  await expect(findings.locator('.md-findings-title')).toHaveText('反方挑刺：正方立论的三处薄弱环节')
  await expect(findings.locator('.md-findings-row')).toHaveCount(3)

  // 已响应推导：@昭实 按编号回补 → 缺陷 1/2/3 均被后续提及 → 全行点亮
  await sendMessage(page, '@昭实 请按编号逐条回补反方挑出的缺陷，给出证据口径与缺口清单。')
  await expectRunSettled(page)
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(findings.locator('.md-findings-count')).toHaveText('3/3 已响应')
  await expect(findings.locator('.md-findings-row[data-responded="true"]')).toHaveCount(3)

  // §72.5 裁决流：@明断 终局裁决 → arena 中轴 verdict 时间线 chip（状态色 + 点击定位）
  await sendMessage(page, '@明断 请给出终局裁决与复盘。')
  await expectRunSettled(page)
  const flow = page.locator('[data-verdict-flow]')
  await expect(flow).toBeVisible()
  const chip = flow.locator('.scene-verdict-chip').first()
  await expect(chip).toHaveAttribute('data-status', 'long')
  await expect(chip).toContainText('辩论裁决（3 轮制）')

  // M63（A4/A2/A6/A5）：交锋走查 → 轮次判定（回合轴色点 + 轮次分）→ 交锋看板 → 结论条 → 参与条
  await sendMessage(page, '@明断 @立言 交锋走查：给出轮次判定与带等级证据的补充主张。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectRunSettled(page)
  await expect(page.locator('.scene-rt-mark.is-long')).toBeVisible()
  await expect(page.locator('.scene-sb-note')).toHaveText('共 1 轮')
  const board = page.locator('[data-insight="cross-fire"]')
  await expect(board).toBeVisible()
  await expect(board.locator('.scene-cf-item')).toHaveCount(3)
  await expect(board.locator('.scene-cf-item[data-responded="true"]')).toHaveCount(3)
  const concl = page.locator('[data-conclusion]')
  await expect(concl).toBeVisible()
  await expect(concl).toContainText('立言 胜')
  await expect(concl).toContainText('置信度 中高')
  await expect(concl).toContainText('翻盘条件')
  // 参与条：倾向表态只回填草稿（不自动发送）
  await page.locator('[data-aa="lean-left"]').click()
  await expect(composer(page)).toHaveValue(/我的观感倾向：立言/)
  await composer(page).fill('')
})

test('M43 · 谈判桌：报价卡与报价流（让步差值色标）', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M43-谈判-${Date.now()}`
  await createSession(page, { scene: '谈判桌', title })
  await disableSerial(page, title)
  const log = page.locator('[role="log"]')

  await sendMessage(page, '@谭成 @祁弈 就这单采购谈一轮：先各自出价，再逐轮让步看能否成交。')
  await expectRunSettled(page)

  // 中轴报价流面板：首轮出价 98 万 → 对手还价 68 万（↓30 万，is-down 色标）
  const panel = page.locator('[data-insight="offers"]')
  await expect(panel).toBeVisible()
  const items = panel.locator('.scene-offer-item')
  await expect(items.nth(0)).toContainText('98 万')
  await expect(items.nth(1)).toContainText('68 万')
  await expect(panel.locator('.scene-offer-delta.is-down').first()).toContainText('↓30 万')

  // 报价卡（消息内）：标题 / 价格类键高亮（报价行为唯一 is-price 行）
  await log.evaluate((el) => {
    el.scrollTop = 0
    el.dispatchEvent(new Event('scroll'))
  })
  const offer = log.locator('.md-offer').first()
  await expect(offer).toBeVisible()
  await expect(offer.locator('.md-offer-kind')).toHaveText('报价')
  await expect(offer.locator('.md-offer-title')).toHaveText(/首轮出价|对手还价/)
  await expect(offer.locator('.md-offer-row.is-price')).toHaveCount(1)

  // M63（G1/G2）：报价走查 → 报价折线（双方点位）+ 三桩基准线 + 让步刻度
  await sendMessage(page, '@谭成 @祁弈 报价走查：出价带齐三桩字段与让步理由。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectRunSettled(page)
  const chart = panel.locator('[data-offer-chart]')
  await expect(chart).toBeVisible()
  // 点数随对话轮次浮动（串行谈判可能多轮交换）——断言下限而非定值
  await expect.poll(async () => chart.locator('.scene-oc-point').count()).toBeGreaterThanOrEqual(4)
  await expect.poll(async () => chart.locator('.scene-oc-base').count()).toBeGreaterThanOrEqual(2)
  await expect(chart.locator('.scene-oc-corridor')).toBeVisible()
  await expect(panel.locator('.scene-conc-item').first()).toBeVisible()
})
