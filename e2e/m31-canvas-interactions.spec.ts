/**
 * E2E · M31 画布交互（ADR 93 修订验收）：
 * 1) 点击容差：触摸板 / 鼠标微移（≤4px）点击即选中，不再被 d3 吞 click（旧默认 nodeClickDistance=0）；
 * 2) 双击编辑：标准双击与带微移双击（系统计数 1→2）均进入便签编辑；
 * 3) 选中保持：拖动（>4px 阈值）结束回写文档触发受控重建后，选中态不丢（mergeNodes 转抄 selected）；
 * 4) 图表区手势：K 线图表内拖动平移行情不动节点（nodrag）；标题栏拖动节点仍有效；
 * 5) 回归：节点内按钮（nodrag）微移点击有效；点击空白清空选中。
 * 行情数据经 page.route mock（不依赖真实网关）；节点与画布文档经 REST 预置。
 */
import { expect, test } from '@playwright/test'
import { createSession, openApp } from './helpers'

function mockBars(): unknown[] {
  const bars: unknown[] = []
  let base = 1400
  for (let i = 0; i < 48; i++) {
    base += Math.sin(i / 3) * 14 + 5
    const open = base
    const close = base + Math.sin(i / 1.7) * 12
    const high = Math.max(open, close) + 8
    const low = Math.min(open, close) - 8
    bars.push({
      timestamp: 1785513600000 + i * 86400000,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: 20000 + i * 400,
    })
  }
  return bars
}

test('M31 · 画布交互：点击容差 / 选中保持 / 图表区手势', async ({ page, request }) => {
  let apiHits = 0
  await page.route('**/api/finance/kline**', async (route) => {
    apiHits++
    const url = new URL(route.request().url())
    const period = url.searchParams.get('period') ?? 'day'
    const adjust = url.searchParams.get('adjust') ?? 'qfq'
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        kline: { kind: 'kline', symbol: 'sh600519', name: '贵州茅台', period, adjust, bars: mockBars() },
      }),
    })
  })

  await openApp(page)
  const title = `E2E-M31-画布交互-${Date.now()}`
  await createSession(page, { title })

  // 经 REST 预置画布文档：便签 + K 线节点（bars 直出，ready 态）
  const list = (await (await request.get('/api/sessions')).json()) as { sessions: { id: string; title: string }[] }
  const sid = list.sessions.find((s) => s.title === title)?.id
  expect(sid).toBeTruthy()
  const cur = (await (await request.get(`/api/sessions/${sid}/canvas`)).json()) as { doc: { version: number } }
  await request.put(`/api/sessions/${sid}/canvas`, {
    data: {
      baseVersion: cur.doc.version,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        { id: 'probe-note', type: 'note', position: { x: 80, y: 100 }, width: 240, height: 150, data: { text: '探测便签', accent: 'amber' } },
        {
          id: 'probe-kline',
          type: 'kline',
          position: { x: 420, y: 80 },
          width: 620,
          height: 420,
          data: { symbol: 'sh600519', name: '贵州茅台', period: 'day', adjust: 'qfq', bars: mockBars(), indicators: ['MA', 'VOL'] },
        },
      ],
      edges: [],
    },
  })

  await page.getByRole('tab', { name: /画布/ }).click()
  const note = page.locator('.react-flow__node[data-id="probe-note"]')
  const kline = page.locator('.react-flow__node[data-id="probe-kline"]')
  await expect(note).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-id="probe-kline"] .md-kline-canvas[data-state="ready"]')).toBeVisible({ timeout: 20_000 })
  await page.waitForTimeout(700)

  const noteArea = page.locator('[data-id="probe-note"] textarea')
  /** 空白 pane 点：elementFromPoint 校验确实命中 .react-flow__pane（避免点在侧边栏 / 浮层上） */
  const paneClick = async (): Promise<void> => {
    const pt = await page.evaluate(() => {
      const pane = document.querySelector('.react-flow__pane') as HTMLElement | null
      if (!pane) return null
      const r = pane.getBoundingClientRect()
      for (let y = r.top + 30; y < r.bottom - 30; y += 30) {
        for (let x = r.left + 30; x < r.right - 30; x += 30) {
          const el = document.elementFromPoint(x, y)
          if (el && el.classList.contains('react-flow__pane')) return { x: Math.round(x), y: Math.round(y) }
        }
      }
      return null
    })
    expect(pt).toBeTruthy()
    await page.mouse.click(pt!.x, pt!.y)
    await page.waitForTimeout(300)
  }
  const microClick = async (x: number, y: number, dx: number, dy: number): Promise<void> => {
    await page.mouse.move(x, y)
    await page.mouse.down()
    if (dx !== 0 || dy !== 0) {
      await page.mouse.move(x + dx, y + dy)
      await page.waitForTimeout(40)
    }
    await page.mouse.up()
    await page.waitForTimeout(350)
  }

  const nb = await note.boundingBox()
  const kb = await kline.boundingBox()
  expect(nb).toBeTruthy()
  expect(kb).toBeTruthy()
  const nx = nb!.x + nb!.width / 2
  const ny = nb!.y + nb!.height / 2
  const cx = kb!.x + kb!.width / 2
  const cy = kb!.y + kb!.height / 2

  // 1) 微移动（2px）点击便签 → 选中（旧默认下 click 被 d3 吞掉，不选中）
  await paneClick()
  await microClick(nx, ny, 2, 0)
  await expect(note).toHaveClass(/selected/)

  // 2) 微移动（2px）点击 K 线图表 → 选中
  await paneClick()
  await microClick(cx, cy, 2, 0)
  await expect(kline).toHaveClass(/selected/)

  // 3) 标准双击便签 → 进入编辑
  await paneClick()
  await page.mouse.dblclick(nx, ny)
  await expect(noteArea).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(noteArea).toBeHidden()

  // 4) 双击带微移（每击 1~2px，第二击 clickCount:2 模拟系统双击计数）→ 仍进入编辑
  await paneClick()
  await page.mouse.move(nx, ny)
  await page.mouse.down({ clickCount: 1 })
  await page.mouse.move(nx + 1, ny)
  await page.mouse.up({ clickCount: 1 })
  await page.waitForTimeout(70)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.move(nx + 2, ny)
  await page.mouse.up({ clickCount: 2 })
  await expect(noteArea).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(noteArea).toBeHidden()

  // 5) 拖动便签（逐帧 >4px 阈值）→ 节点位移且松手后保持选中（文档回写重建不抹 selected）
  await paneClick()
  await page.mouse.move(nx, ny)
  await page.mouse.down()
  await page.mouse.move(nx + 6, ny)
  await page.waitForTimeout(120)
  await page.mouse.move(nx + 12, ny)
  await page.waitForTimeout(120)
  await page.mouse.move(nx + 18, ny)
  await page.waitForTimeout(120)
  await page.mouse.up()
  await expect(note).toHaveClass(/selected/)
  await expect
    .poll(async () => (await note.boundingBox())?.x ?? nb!.x, { timeout: 3_000 })
    .toBeGreaterThan(nb!.x + 8)

  // 6) 拖动 K 线图表中心（nodrag）→ 图表手势，节点不移动
  await paneClick()
  const kbA = (await kline.boundingBox())!
  const kcx = kbA.x + kbA.width / 2
  const kcy = kbA.y + kbA.height / 2
  await page.mouse.move(kcx, kcy)
  await page.mouse.down()
  await page.mouse.move(kcx + 40, kcy + 20, { steps: 4 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(600)
  const kbB = (await kline.boundingBox())!
  expect(Math.abs(kbB.x - kbA.x)).toBeLessThan(1)
  expect(Math.abs(kbB.y - kbA.y)).toBeLessThan(1)

  // 7) 拖动 K 线标题栏 → 节点移动（拖动把手仍在）
  const tbx = kbB.x + 40
  const tby = kbB.y + 12
  await page.mouse.move(tbx, tby)
  await page.mouse.down()
  await page.mouse.move(tbx + 30, tby, { steps: 3 })
  await page.waitForTimeout(120)
  await page.mouse.up()
  await page.waitForTimeout(600)
  const kbC = (await kline.boundingBox())!
  expect(kbC.x).toBeGreaterThan(kbB.x + 8)

  // 8) 微移动点击「周K」按钮（nodrag）→ 行情网关请求 +1 且按钮激活（点击不被吞）
  const hits0 = apiHits
  const wb = (await kline.locator('button', { hasText: /^周K$/ }).first().boundingBox())!
  expect(wb).toBeTruthy()
  await microClick(wb.x + wb.width / 2, wb.y + wb.height / 2, 2, 0)
  await expect.poll(() => apiHits, { timeout: 5_000 }).toBe(hits0 + 1)
  await expect(kline.locator('button', { hasText: /^周K$/ }).first()).toHaveClass(/font-medium/)

  // 9) 点击空白 pane → 选中清空
  await paneClick()
  await expect(note).not.toHaveClass(/selected/)
  await expect(kline).not.toHaveClass(/selected/)
})
