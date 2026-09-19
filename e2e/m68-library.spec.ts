/**
 * E2E · M68 用户素材库（独立菜单管理页面）——
 * 1) 管理页面：ActivityRail「素材库」进入 → 上传（隐藏 input）→ 网格卡片 → 类型筛选 → 删除（confirm）；
 * 2) 放入画布：素材 to-canvas 入仓（copy-on-use）→ sendArtifact 落节点 → 画布出现图片节点（artifact 含 library/ref-）。
 *
 * 隔离说明：与 main 链路共享数据目录 e2e-ux（隔离配置 8795）；素材按 owner 隔离（兼容模式 'local'），
 * 用例自清理（删除自建素材），幂等可重跑。
 */
import { expect, test, type Page } from '@playwright/test'
import { createSession, openApp, switchMainTab } from './helpers'

/** 1x1 PNG（上传夹具） */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 进入素材库管理页（ActivityRail 入口） */
async function openMaterials(page: Page): Promise<void> {
  await page.getByLabel('素材库').click()
  await expect(page.getByText('素材库', { exact: true })).toBeVisible({ timeout: 10_000 })
}

/** 上传一张 PNG（隐藏 input 直投）；返回素材名 */
async function uploadPng(page: Page, name: string): Promise<string> {
  const file = `${name}.png`
  await page.setInputFiles('input[type="file"]', { name: file, mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText(file)).toBeVisible({ timeout: 15_000 })
  return file
}

/** 悬停卡片使 hover 操作条（放入画布 / 下载 / 删除）显现 */
async function hoverCard(page: Page, fileName: string): Promise<void> {
  await page.getByText(fileName).first().hover()
}

test('素材库 · 管理页面：上传 → 网格卡片 → 类型筛选 → 删除', async ({ page }) => {
  await openApp(page)
  await openMaterials(page)

  // 1) 上传（raw ≤200MB → 服务端白名单 → 落盘 + 建行）
  const name = `E2E素材-${Date.now()}`
  const file = await uploadPng(page, name)

  // 2) 类型筛选：图片命中保留；视频无匹配 → 空文案
  await page.getByRole('button', { name: '视频' }).click()
  await expect(page.getByText(/没有匹配的素材/)).toBeVisible({ timeout: 10_000 })
  await page.getByRole('button', { name: '图片' }).click()
  await expect(page.getByText(file)).toBeVisible({ timeout: 10_000 })

  // 3) 删除（confirm 确认 → 行 + 文件双清；操作条需先悬停卡片）
  page.once('dialog', (d) => void d.accept())
  await hoverCard(page, file)
  await page.getByTitle(/删除（不可恢复）/).first().click()
  await expect(page.getByText(file)).toHaveCount(0, { timeout: 10_000 })
})

test('素材库 · 放入画布：to-canvas 入仓（copy-on-use）→ 画布落图片节点', async ({ page }) => {
  await openApp(page)
  const title = `E2E-M68-入画布-${Date.now()}`
  await createSession(page, { title }) // 进入工作台（画布 Tab 可在其后使用）

  // 1) 素材库上传
  await openMaterials(page)
  const file = await uploadPng(page, `E2E入布-${Date.now()}`)

  // 2) 放入当前会话画布（入仓 + sendArtifact 落节点；操作条需先悬停卡片）
  await hoverCard(page, file)
  await page.getByTitle(/放入当前会话画布/).first().click()
  await expect(page.getByText(/已放入画布/)).toBeVisible({ timeout: 15_000 })

  // 3) 回到工作台画布 Tab：节点出现且 artifact 指向会话工作区入仓副本
  await page.getByLabel('工作台').click()
  await switchMainTab(page, '画布')
  const img = page.locator('.react-flow__node-image').first()
  await expect(img).toBeVisible({ timeout: 15_000 })

  const list = (await (await page.request.get('/api/sessions')).json()) as { sessions: { id: string; title: string }[] }
  const sid = list.sessions.find((s) => s.title === title)?.id
  expect(sid).toBeTruthy()
  // 文档落盘经 autosave 防抖（debounce + PUT）：轮询 REST 直到入仓副本节点出现
  await expect
    .poll(
      async () => {
        const doc = (await (await page.request.get(`/api/sessions/${sid}/canvas`)).json()) as {
          doc: { nodes: Array<{ type: string; data: { artifact?: string } }> }
        }
        return doc.doc.nodes.some((n) => n.type === 'image' && n.data.artifact?.includes('library/ref-'))
      },
      { timeout: 15_000 },
    )
    .toBe(true)

  // 4) 清理：删除素材（画布副本保留在会话工作区——属正常 copy-on-use 语义）
  page.once('dialog', (d) => void d.accept())
  await openMaterials(page)
  await hoverCard(page, file)
  await page.getByTitle(/删除（不可恢复）/).first().click()
  await expect(page.getByText(file)).toHaveCount(0, { timeout: 10_000 })
})
