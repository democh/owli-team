/**
 * E2E · M65 家装设计工作室（mock 模式）：
 * 1) 容器族：布局走查 → layout 卡（房间表 + 方案源 + 打开按钮）；
 * 2) 3D 工作台：layout 卡「在 3D 工作台打开」→ studio 面板加载预置场景 → 懒加载面 + canvas；
 * 3) 平面视图切换（SVG 平面图）；
 * 4) 风格走查 → styleboard 卡（色块）+「按此板调整方案」回填草稿；
 * 5) 出图走查 → render 卡（元信息）+「再生成一版」回填草稿（seed 提取）。
 */
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { composer, createSession, expectYourTurn, openApp, sendMessage } from './helpers'

/**
 * 回到最新：打开工作台 / 视口变化后消息区可能不再自动贴底（M12 上滑不打断语义）——
 * 虚拟列表只挂载视口内元素，需主动点「N 条新消息 / 回到最新」浮标才能看见底部新卡。
 */
async function jumpToLatest(page: Page): Promise<void> {
  const pill = page.getByRole('button', { name: /条新消息|回到最新/ }).first()
  if (await pill.isVisible().catch(() => false)) {
    await pill.click().catch(() => {})
    await page.waitForTimeout(200)
    return
  }
  // M85：浮标仅在「有未读新消息」时渲染——无未读时直接程序化回底（贴底跟随随后接管）
  await page
    .locator('[role="log"]')
    .evaluate((el) => {
      el.scrollTop = el.scrollHeight
      el.dispatchEvent(new Event('scroll'))
    })
    .catch(() => {})
  await page.waitForTimeout(200)
}

test('M65 · 设计容器族 + 3D 工作台全链（layout → 打开 → 平面 → 回填）', async ({ page }) => {
  // 三个 run 全链（布局 / 风格 / 出图走查）+ 工作台懒加载：放宽总时长
  test.setTimeout(300_000)
  const title = `E2E-M65-设计-${Date.now()}`
  await openApp(page)
  await createSession(page, { scene: '家装设计工作室', title })

  // 预置场景文件（layout 卡的「方案源」指向 design/plan-demo.scene.json；与 mock 触发块一致）
  const list = await page.request.get('/api/sessions')
  const body = (await list.json()) as { sessions: Array<{ id: string; title?: string }> }
  const session = body.sessions.find((s) => s.title === title)
  expect(session, '会话应已创建（按标题反查）').toBeTruthy()
  const scene = {
    version: 1,
    name: 'E2E 方案',
    unit: 'mm',
    rooms: [
      {
        id: 'r1',
        name: '客厅',
        polygon: [
          [0, 0],
          [4200, 0],
          [4200, 3600],
          [0, 3600],
        ],
        height: 2800,
        floor: '地板',
        wall: '墙面',
      },
    ],
    openings: [],
    furniture: [{ id: 'f1', kind: 'sofa', x: 1200, y: 1000, rotation: 0 }],
    materials: { 地板: { color: '#e7ddcd', roughness: 0.75 }, 墙面: { color: '#f2efe9', roughness: 0.9 } },
    lights: { sunAzimuth: 210, sunElevation: 45, intensity: 1.4, ambient: 0.55 },
  }
  const put = await page.request.put(`/api/sessions/${session!.id}/design-scenes`, {
    data: { path: 'design/plan-demo.scene.json', data: scene },
  })
  expect(put.ok(), `预置场景应保存成功（HTTP ${put.status()}）`).toBeTruthy()

  // 1) 布局走查（@规方 直接触发 → mock 触发块产出 layout 容器）
  await sendMessage(page, '@规方 布局走查：三室两厅方案请出布局')
  await expectYourTurn(page)
  const layout = page.locator('[data-layout]').first()
  await expect(layout).toBeVisible()
  await expect(layout.getByText('客厅')).toBeVisible()
  await expect(layout.getByText('22.5㎡')).toBeVisible()
  await expect(layout.getByText('design/plan-demo.scene.json')).toBeVisible()

  // 2) 「在 3D 工作台打开」→ 面板就绪 + 3D 懒加载面 / canvas
  await layout.getByRole('button', { name: /在 3D 工作台打开/ }).click()
  await expect(page.locator('[data-studio-panel]')).toBeVisible()
  await expect(page.locator('[data-studio-pick]')).toHaveValue('design/plan-demo.scene.json')
  await expect(page.locator('[data-studio-surface]')).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('[data-studio-canvas]')).toBeVisible()

  // 3) 平面视图切换（SVG 平面图）
  await page.locator('[data-studio-view-toggle]').click()
  await expect(page.locator('[data-studio-plan]')).toBeVisible()
  await page.locator('[data-studio-view-toggle]').click()

  // 4) 风格走查 → styleboard 卡 + 回填草稿（轮询等待：期间保持贴底，虚拟列表才挂载底部新卡）
  await sendMessage(page, '@成竹 风格走查：定个基调')
  await expect(async () => {
    await jumpToLatest(page)
    expect(await page.locator('[data-styleboard]').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  const board = page.locator('[data-styleboard]').first()
  await expect(board.getByText('原木日式 · 基调')).toBeVisible()
  await expect(board.getByText('#E8E0D4')).toBeVisible()
  await board.getByRole('button', { name: '按此板调整方案' }).click()
  await expect(composer(page)).toHaveValue(/按「原木日式 · 基调」风格板调整方案/)
  // 等团队收束（发送按钮回归空闲名）后再发下一条
  await expect(page.getByRole('button', { name: '发送' })).toBeVisible({ timeout: 90_000 })

  // 5) 出图走查 → render 卡 + 再生成回填（seed 提取）
  await sendMessage(page, '@塑光 出图走查：出一版效果图')
  await expect(async () => {
    await jumpToLatest(page)
    expect(await page.locator('[data-render]').count()).toBeGreaterThan(0)
  }).toPass({ timeout: 90_000, intervals: [2_000] })
  const render = page.locator('[data-render]').first()
  await expect(render.getByText(/seed 20260919/)).toBeVisible()
  await render.getByRole('button', { name: '再生成一版' }).click()
  await expect(composer(page)).toHaveValue(/再生成一版「客餐厅效果图/)
})
