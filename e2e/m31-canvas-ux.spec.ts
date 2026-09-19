/**
 * E2E · M31 修订：画布专业手感与能力门控——
 * 1) 能力门控（未配置即不出现）：无媒体连接时工具栏无「媒体生成」、空画布无「创作台 / 分镜台」、
 *    图片节点右键无生成段、空态文案降级；REST 创建媒体连接后（重载）生成入口出现，删除后恢复；
 * 2) 缩放指示器：100% 常驻 / 步进放大缩小 / 菜单「缩放到 100%」/ ⇧0 复位 / ⇧1 适应视野 / 缩放到选区启用态；
 * 3) 导航手感：滚轮=平移（scale 不变 translate 变）/ H 手型拖拽平移且不框选 / V 回到选择工具。
 *
 * 隔离说明：main 实例数据目录 e2e-main 无媒体连接；本 spec 自建连接用后即删（幂等可重跑）。
 */
import { expect, test, type Page } from '@playwright/test'
import { createSession, openApp, switchMainTab } from './helpers'

/** 删除全部媒体连接（前置清场 + 自建后清理，保证幂等） */
async function removeMediaConnections(page: Page): Promise<void> {
  const res = await page.request.get('/api/connections')
  const body = (await res.json()) as { connections: Array<{ id: string; kind: string }> }
  for (const c of body.connections.filter((x) => x.kind === 'media')) {
    await page.request.delete(`/api/connections/${c.id}`)
  }
}

/** REST 预置画布文档（图片节点：带 artifact 引用（文件不存在→节点内走空态兜底）；无 prompt） */
async function seedCanvas(page: Page, title: string): Promise<void> {
  const list = (await (await page.request.get('/api/sessions')).json()) as { sessions: { id: string; title: string }[] }
  const sid = list.sessions.find((s) => s.title === title)?.id
  expect(sid).toBeTruthy()
  const cur = (await (await page.request.get(`/api/sessions/${sid}/canvas`)).json()) as { doc: { version: number } }
  await page.request.put(`/api/sessions/${sid}/canvas`, {
    data: {
      baseVersion: cur.doc.version,
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: 'probe-img',
          type: 'image',
          position: { x: 120, y: 120 },
          width: 280,
          height: 200,
          // artifact 必填：右键生成段以「有图」为前置（无 artifact 时任何能力下都不渲染生成段）
          data: { artifact: 'canvas/media/probe.png', source: 'upload' },
        },
      ],
      edges: [],
    },
  })
}

/** viewport 当前变换（translate / scale；从 .react-flow__viewport 计算样式解析） */
async function viewportOf(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const vp = document.querySelector('.react-flow__viewport') as HTMLElement
    const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform)
    return { x: Math.round(m.e), y: Math.round(m.f), zoom: Number(m.a.toFixed(3)) }
  })
}

/** 画布空白点（elementFromPoint 搜索确实命中 pane 的坐标；避开节点与浮层） */
async function paneBlankPoint(page: Page): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate(() => {
    const pane = document.querySelector('.react-flow__pane') as HTMLElement | null
    if (!pane) return null
    const r = pane.getBoundingClientRect()
    for (let y = r.top + 40; y < r.bottom - 60; y += 40) {
      for (let x = r.left + 40; x < r.right - 40; x += 40) {
        const el = document.elementFromPoint(x, y)
        if (el && el.classList.contains('react-flow__pane')) return { x: Math.round(x), y: Math.round(y) }
      }
    }
    return null
  })
  expect(pt).toBeTruthy()
  return pt!
}

test('能力门控：未配置媒体连接时生成入口全部不出现（工具栏 / 模板 / 右键 / 节点文案）', async ({ page }) => {
  await openApp(page)
  await removeMediaConnections(page) // 清场：保证「未配置」前置（自愈重跑）

  const title = `E2E-M31UX-门控-${Date.now()}`
  await createSession(page, { title })
  await switchMainTab(page, '画布')

  // 1) 工具栏：无媒体生成钮；空画布：创作台 / 分镜台不出现，脑图工坊 / 素材墙恒显
  await expect(page.locator('.react-flow__pane')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByLabel('媒体生成（文生图 / 视频）')).toHaveCount(0)
  await expect(page.getByText('脑图工坊')).toBeVisible()
  await expect(page.getByText('素材墙')).toBeVisible()
  await expect(page.getByText('创作台')).toHaveCount(0)
  await expect(page.getByText('分镜台')).toHaveCount(0)

  // 2) REST 预置空态图片节点 → 重载（同会话已有文档时 store load 会跳过重拉，reload 强制走加载路径）
  await seedCanvas(page, title)
  await page.reload()
  await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })
  await switchMainTab(page, '画布')
  const img = page.locator('.react-flow__node[data-id="probe-img"]')
  await expect(img).toBeVisible({ timeout: 15_000 })

  // 3) 空态文案降级（不再引导生成）
  await expect(img.getByText('拖入图片，或从交付件送上画布')).toBeVisible()

  // 4) 右键菜单：无生成段（用作生成输入 / 生成变体 / 首尾帧），菜单本体仍在
  await img.click({ button: 'right' })
  await expect(page.getByText('创建副本')).toBeVisible()
  await expect(page.getByText('用作生成输入')).toHaveCount(0)
  await expect(page.getByText('生成变体')).toHaveCount(0)
  await expect(page.getByText('设为首帧（视频）')).toHaveCount(0)
  await page.keyboard.press('Escape')
})

test('能力门控：创建媒体连接后生成入口出现，删除后恢复（设置 → providers → 画布同步）', async ({ page }) => {
  await openApp(page)
  let connectionId: string | undefined
  try {
    const res = await page.request.post('/api/connections', {
      data: {
        name: `E2E 媒体连接-${Date.now()}`,
        kind: 'media',
        enabled: true,
        config: {
          provider: 'comfyui',
          baseUrl: 'http://127.0.0.1:8188',
          capabilities: ['text2image', 'image2image', 'text2video', 'image2video', 'firstlast2video'],
        },
      },
    })
    expect(res.ok()).toBeTruthy()
    connectionId = ((await res.json()) as { connection: { id: string } }).connection.id

    // 重载让 providers 重新拉取（画布挂载 ensureProviders）
    await page.reload()
    const title = `E2E-M31UX-已配置-${Date.now()}`
    await createSession(page, { title })
    await switchMainTab(page, '画布')

    // 工具栏生成钮 + 全能力模板齐备（创作台 / 分镜台出现）
    await expect(page.getByLabel('媒体生成（文生图 / 视频）')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('创作台')).toBeVisible()
    await expect(page.getByText('分镜台')).toBeVisible()

    // 右键图片节点的生成段（预置空态图片节点；reload 强制重拉文档）
    await seedCanvas(page, title)
    await page.reload()
    await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })
    await switchMainTab(page, '画布')
    const img = page.locator('.react-flow__node[data-id="probe-img"]')
    await expect(img).toBeVisible({ timeout: 15_000 })
    await img.click({ button: 'right' })
    await expect(page.getByText('用作生成输入')).toBeVisible()
    await expect(page.getByText('设为首帧（视频）')).toBeVisible()
    await page.keyboard.press('Escape')
  } finally {
    // 用后即删：恢复「未配置」现场（幂等重跑）
    if (connectionId) await page.request.delete(`/api/connections/${connectionId}`)
  }
})

test('缩放指示器与快捷键：百分比常驻 / 步进 / 菜单 / ⇧0·⇧1 / 缩放到选区', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M31UX-缩放-${Date.now()}`
  await createSession(page, { title })
  await seedCanvas(page, title)
  await switchMainTab(page, '画布')
  await expect(page.locator('.react-flow__node[data-id="probe-img"]')).toBeVisible({ timeout: 15_000 })

  const pill = page.locator('[aria-label^="当前缩放"]')
  await expect(pill).toHaveText('100%')

  // 1) Controls 内置步进：缩小 → <100%；回 100% 后放大 ×2 → >100%
  await page.locator('.react-flow__controls-zoomout').click()
  await expect.poll(async () => parseInt((await pill.textContent()) ?? '0', 10), { timeout: 5_000 }).toBeLessThan(100)
  await page.locator('.react-flow__controls-zoomin').click()
  await page.waitForTimeout(350) // 步进动画（duration 200）完成后再点，避免动画中点击被合流
  await page.locator('.react-flow__controls-zoomin').click()
  await expect.poll(async () => parseInt((await pill.textContent()) ?? '0', 10), { timeout: 5_000 }).toBeGreaterThan(100)

  // 2) ⇧0 → 缩放到 100%（浏览器保留键 ⌘0 的 Figma 范式替代）
  await page.keyboard.press('Shift+Digit0')
  await expect(pill).toHaveText('100%', { timeout: 5_000 })

  // 3) 放大后 ⇧1 → 适应视野（fitView 上限 1，回落到 ≤100%）
  await page.locator('.react-flow__controls-zoomin').click()
  await page.waitForTimeout(350)
  await page.locator('.react-flow__controls-zoomin').click()
  await expect.poll(async () => parseInt((await pill.textContent()) ?? '0', 10), { timeout: 5_000 }).toBeGreaterThan(100)
  await page.keyboard.press('Shift+Digit1')
  await expect.poll(async () => parseInt((await pill.textContent()) ?? '0', 10), { timeout: 5_000 }).toBeLessThanOrEqual(100)

  // 4) 缩放到选区：无选区禁用；选中便签后可点（不破坏缩放上限）
  await page.keyboard.press('Shift+Digit0')
  await expect(pill).toHaveText('100%', { timeout: 5_000 })
  await pill.click()
  const fitSelection = page.getByText('缩放到选区')
  await expect(fitSelection).toBeVisible()
  await expect(fitSelection.locator('xpath=ancestor::button')).toBeDisabled()
  await page.keyboard.press('Escape')

  const img = page.locator('.react-flow__node[data-id="probe-img"]')
  await img.click()
  await expect(img).toHaveClass(/selected/)
  await pill.click()
  await expect(page.getByText('缩放到选区').locator('xpath=ancestor::button')).toBeEnabled()
  await page.getByText('缩放到选区').click()
  await expect.poll(async () => parseInt((await pill.textContent()) ?? '0', 10), { timeout: 5_000 }).toBeLessThanOrEqual(100)
})

test('导航手感：滚轮=平移（scale 不变）/ H 手型拖拽平移不框选 / V 回选择', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M31UX-手感-${Date.now()}`
  await createSession(page, { title })
  await seedCanvas(page, title)
  await switchMainTab(page, '画布')
  await expect(page.locator('.react-flow__node[data-id="probe-img"]')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(500)

  // 1) 滚轮 = 平移：translate 变化、scale 保持（⌘+滚轮缩放为主通道）
  const before = await viewportOf(page)
  const blank = await paneBlankPoint(page)
  await page.mouse.move(blank.x, blank.y)
  await page.mouse.wheel(0, 240)
  await page.waitForTimeout(400) // d3 平移有短过渡
  const after = await viewportOf(page)
  expect(after.y).not.toBe(before.y)
  expect(after.zoom).toBe(before.zoom)

  // 2) H → 手型：按钮态与 title 反馈；拖拽空白 → translate 变化且无框选
  const handBtn = page.getByLabel(/手型工具（H）/)
  await page.keyboard.press('h')
  await expect(handBtn).toHaveAttribute('title', /拖动平移画布/)
  const b2 = await viewportOf(page)
  const p2 = await paneBlankPoint(page)
  await page.mouse.move(p2.x, p2.y)
  await page.mouse.down()
  await page.mouse.move(p2.x + 80, p2.y + 40, { steps: 5 })
  await page.mouse.up()
  await page.waitForTimeout(400)
  const a2 = await viewportOf(page)
  expect(a2.x).not.toBe(b2.x)
  expect(a2.zoom).toBe(b2.zoom)
  await expect(page.locator('.react-flow__selection')).toHaveCount(0) // 手型拖拽不产生框选

  // 3) V → 回到选择工具（title 反馈）
  await page.keyboard.press('v')
  await expect(handBtn).toHaveAttribute('title', /当前为选择工具/)
})

test('画布内查找（M31 修订）：「/」唤起 → 匹配 → Enter 定位（居中 + 选中 + 闪环）', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M31UX-查找-${Date.now()}`
  await createSession(page, { title })
  await seedCanvas(page, title)
  await switchMainTab(page, '画布')
  const img = page.locator('.react-flow__node[data-id="probe-img"]')
  await expect(img).toBeVisible({ timeout: 15_000 })

  // 1) 「/」唤起查找面板（工具栏按钮同源）
  await page.keyboard.press('/')
  const box = page.getByLabel('画布查找')
  await expect(box).toBeVisible({ timeout: 5_000 })

  // 2) 输入即匹配（probe 命中图片节点的 artifact 路径）；回车定位
  await box.fill('probe')
  await expect(page.getByText(/图片 · /)).toBeVisible()
  await box.press('Enter')

  // 3) 定位：节点选中 + 闪环
  await expect(img).toHaveClass(/selected/, { timeout: 5_000 })
  await expect(page.locator('.canvas-agent-flash').first()).toBeVisible({ timeout: 5_000 })

  // 4) 无匹配提示；Esc 关闭
  await box.fill('不存在的内容')
  await expect(page.getByText('没有匹配的节点')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(box).toHaveCount(0)
})

test('大画布性能档（M31 修订）：>150 节点自动视口裁剪（渲染数 < 全量）+ 交互仍可用', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M31UX-大画布-${Date.now()}`
  await createSession(page, { title })
  const list = (await (await page.request.get('/api/sessions')).json()) as { sessions: { id: string; title: string }[] }
  const sid = list.sessions.find((s) => s.title === title)?.id
  expect(sid).toBeTruthy()
  const cur = (await (await page.request.get(`/api/sessions/${sid}/canvas`)).json()) as { doc: { version: number } }
  await page.request.put(`/api/sessions/${sid}/canvas`, {
    data: {
      baseVersion: cur.doc.version,
      // 非默认视口（避开 fitView 全览：全览会让 160 节点全部落入视口，裁剪无从体现）
      viewport: { x: 40, y: 40, zoom: 1 },
      nodes: Array.from({ length: 160 }, (_, i) => ({
        id: `nd_${i}`,
        type: 'note',
        position: { x: (i % 10) * 240, y: Math.floor(i / 10) * 180 },
        width: 220,
        height: 140,
        data: { text: `节点 ${i}`, accent: 'amber' },
      })),
      edges: [],
    },
  })
  await page.reload()
  await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 15_000 })
  await switchMainTab(page, '画布')
  await expect(page.locator('.react-flow__pane')).toBeVisible({ timeout: 15_000 })
  await page.waitForTimeout(800) // 渲染稳定

  const rendered = await page.locator('.react-flow__node').count()
  expect(rendered).toBeGreaterThan(0)
  expect(rendered).toBeLessThan(160) // 视口裁剪生效

  // 交互仍可用：点选一个可见节点
  await page.locator('.react-flow__node').first().click()
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(1, { timeout: 5_000 })
})
