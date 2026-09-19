/**
 * E2E · M34 投研场景（mock 模式）：
 * 1) 快速组队「投研快评」：preset 建会 → 开场指令预填草稿 → @ 两路并行（技术面 / 舆情面）
 *    → 投研主管独立成波收口 → 交还用户 → 3 份交付件；
 * 2) 「策略研究」：@ 三路并行（基本面 / 技术面 / 量化）→ 主管收口 → 4 份交付件；
 * 3) 「多空对弈」：@ 三路交锋并行（多空立论 + 证据弹药）→ 量化走子 → 终局裁决（verdict 卡）→ 5 份交付件；
 *    M52-E：局势面板局面头（胜负 + 置信度）随裁决上移；M52-F：信号按语义分侧（ 核心依据归多方 / 翻盘条件归空方）；
 *    M63（批一）：四路走查 → 四路观点卡（视角 / 倾向 / 分歧提示）+ 博弈走子板（模型 / 种子 / 推演声明）。
 * 与 eval invest-quick-review / invest-strategy-research / bull-bear-duel 任务同构（确定性链路断言）。
 * M46-2：串行执行默认开启 → 本 spec 三例均验证并行波 → 建会后先显式关闭串行。
 */
import { expect, test } from '@playwright/test'
import { backToChat, composer, createSessionByPreset, disableSerial, expectYourTurn, openApp, openWorkspace, sendMessage } from './helpers'

test('M34 · 投研快评：preset 建会 → 两路并行独立产出 → 主管收口与交付件', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M34-快评-${Date.now()}`
  await createSessionByPreset(page, '投研快评', { title })
  await disableSerial(page, title)

  // 开场指令已预填为 Composer 草稿（可直接编辑后发送）
  await expect(composer(page)).toHaveValue(/出一份投研快评/)
  await page.getByRole('button', { name: '发送' }).click()

  const log = page.locator('[role="log"]')
  // 首波：@ 两路 → 技术面 / 舆情面 并行独立产出（并行协作组）
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('雷动、闻笛')).toBeVisible()
  await expect(log.getByText('先看结构')).toBeVisible()
  await expect(log.getByText('舆情时间线理出来了')).toBeVisible()

  // 收敛波：投研主管收口（议题拆解 + 收口规则）
  await expect(log.getByText('议题拆好了')).toBeVisible()
  await expect(log.getByText('收口规则')).toBeVisible()

  // Run 正常收束（全波交还 → 你的回合）
  await expectYourTurn(page)

  // 交付件：3 位成员各 1 份（eval 同构断言）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 3 个文件/)).toBeVisible()
  for (const path of ['docs/技术面分析-增长.md', 'docs/舆情简报-增长.md', 'docs/投研报告-增长.md']) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})

test('M34 · 策略研究：三路并行 → 主管收口 → 4 份交付件', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M34-策略-${Date.now()}`
  await createSessionByPreset(page, '策略研究', { title })
  await disableSerial(page, title)

  await expect(composer(page)).toHaveValue(/启动一轮策略研究/)
  await page.getByRole('button', { name: '发送' }).click()

  const log = page.locator('[role="log"]')
  // 首波：@ 三路 → 基本面 / 技术面 / 量化 并行独立产出
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('秦砚、雷动、方程')).toBeVisible()
  await expect(log.getByText('三表过了一遍')).toBeVisible()
  await expect(log.getByText('先看结构')).toBeVisible()
  await expect(log.getByText('策略规格先对齐')).toBeVisible()

  // 收敛波：主管收口
  await expect(log.getByText('议题拆好了')).toBeVisible()
  await expect(log.getByText('收口规则')).toBeVisible()

  await expectYourTurn(page)

  // 交付件：4 位成员各 1 份
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 4 个文件/)).toBeVisible()
  for (const path of [
    'docs/基本面分析-增长.md',
    'docs/技术面分析-增长.md',
    'docs/策略方案-增长.md',
    'docs/投研报告-增长.md',
  ]) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }
})

test('M34 · 多空对弈：三路交锋并行 → 量化走子 → 终局裁决与 5 份交付件', async ({ page }) => {
  test.setTimeout(150_000) // M66：新增四路走查段（共享环境负载下链路更长）
  await openApp(page)
  const title = `E2E-M34-对弈-${Date.now()}`
  await createSessionByPreset(page, '多空对弈', { title })
  await disableSerial(page, title)

  await expect(composer(page)).toHaveValue(/组织一轮多空对弈/)
  await page.getByRole('button', { name: '发送' }).click()

  const log = page.locator('[role="log"]')
  // 首波：@ 三路 → 多空立论 + 证据弹药 并行交锋（并行协作组）
  // 断言取台词特有短语：开场指令含「持多方立论 / 持空方立论 / 汇拢双方证据弹药」，裸词会命中用户消息
  await expect(log.getByText('并行协作')).toBeVisible()
  await expect(log.getByText('秦砚、雷动、闻笛')).toBeVisible()
  await expect(log.getByText('多方立论（第 1 轮）')).toBeVisible()
  await expect(log.getByText('空方立论（第 1 轮）')).toBeVisible()
  await expect(log.getByText('证据弹药按双方归堆')).toBeVisible()

  // 中继：方程量化走子（对抗矩阵 + 序贯逆向归纳）
  await expect(log.getByText('走子完成')).toBeVisible()

  // 终局：主管裁决（verdict 容器）+ 翻盘条件（断言取条目内容短语，裸词「翻盘条件」会命中开场指令）
  await expect(log.getByText('多空对弈裁决')).toBeVisible()
  await expect(log.getByText('裁决翻转空方')).toBeVisible()

  // M52-E：局势面板局面头——最新裁决的胜负与置信度上移（mock 裁决：多方 / 置信度 中）
  await expect(page.locator('.scene-vs-headline')).toHaveText('多方领先')
  await expect(page.locator('.scene-vs-conf')).toHaveText('置信度 中')

  // M52-F：信号按语义分侧——核心依据归多方（胜方）、翻盘条件归空方（败方）
  await expect(page.locator('.scene-vs-long .scene-vs-signal')).toHaveCount(1)
  await expect(page.locator('.scene-vs-short .scene-vs-signal')).toHaveCount(1)

  await expectYourTurn(page)

  // 交付件：5 位成员各 1 份（含博弈推演文档）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 5 个文件/)).toBeVisible()
  for (const path of [
    'docs/基本面分析-增长.md',
    'docs/技术面分析-增长.md',
    'docs/舆情简报-增长.md',
    'docs/博弈推演-增长.md',
    'docs/投研报告-增长.md',
  ]) {
    await expect(page.locator(`button[title="${path}"]`)).toBeVisible()
  }

  // M63（N1/G4）：四路走查 → 四路观点卡（视角 / 倾向 / 分歧提示）+ 博弈走子板（种子与推演声明）
  await backToChat(page) // 交付件视图无 Composer——先返回对话
  await sendMessage(page, '@秦砚 @雷动 @方程 四路走查：把四路观点与走子结论沉淀到面板。')
  await expect(composer(page)).toHaveValue('') // 发送落地确认（防共享环境点击丢失）
  await expectYourTurn(page)
  await expect(page.locator('.scene-view-card[data-perspective="基本面"]')).toBeVisible()
  await expect(page.locator('.scene-view-card[data-perspective="技术面"]')).toBeVisible()
  await expect(page.locator('.scene-view-card[data-perspective="量化"]')).toBeVisible()
  await expect(page.locator('.scene-views-split')).toBeVisible()
  const move = page.locator('[data-move-board] .scene-move').first()
  await expect(move).toBeVisible()
  await expect(move.locator('.scene-move-model')).toHaveText('静态矩阵博弈')
  await expect(move.locator('.scene-move-seed')).toContainText('20260918')
  await expect(page.locator('.scene-moves-note')).toContainText('模型推演，非预测')
})
