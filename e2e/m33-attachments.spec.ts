/**
 * E2E · M33 附件链路：文件选择 → 附件托盘（缩略图 / 上传完成）→ 发送（纯附件消息）
 * → 消息内图片原生渲染（网格）→ Lightbox（左右切换 / Esc）→ 交付件面板可见 uploads/。
 */
import { expect, test } from '@playwright/test'
import { createSession, openApp, openWorkspace } from './helpers'

/** 真实 1×1 透明 PNG（浏览器可渲染；服务端读 IHDR 得 1×1 尺寸） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('M33 附件：上传托盘 → 发送 → 消息内图片原生渲染 → Lightbox 切换', async ({ page }) => {
  await openApp(page)
  await createSession(page, { title: `E2E-M33-${Date.now()}` })

  // 1) 选择两张图片 → 托盘即时出现缩略（上传中 → 完成）
  const input = page.locator('input[type="file"]')
  await input.setInputFiles([
    { name: '界面-1.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: '界面-2.png', mimeType: 'image/png', buffer: PNG_1X1 },
  ])
  const tray = page.getByRole('list', { name: '待发送附件' })
  await expect(tray).toBeVisible()
  await expect(tray.getByTitle('界面-1.png（点击预览）')).toBeVisible()
  await expect(tray.getByTitle('界面-2.png（点击预览）')).toBeVisible()

  // 2) 上传完成（发送按钮解除禁用）→ 发送纯附件消息
  const send = page.getByRole('button', { name: '发送' })
  await expect(send).toBeEnabled()
  await send.click()

  // 3) 托盘清空；消息内原生渲染图片网格（不做 Markdown 降级）
  await expect(tray).toBeHidden()
  const chat = page.locator('[role="log"]')
  const first = chat.getByTitle('界面-1.png（点击放大）')
  await expect(first).toBeVisible()
  await expect(chat.getByTitle('界面-2.png（点击放大）')).toBeVisible()

  // 4) 点击放大 → Lightbox；「下一张」切换；Esc 关闭
  await first.click()
  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('界面-1.png')).toBeVisible()
  await dialog.getByRole('button', { name: '下一张' }).click()
  await expect(dialog.getByText('界面-2.png')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  // 5) 交付件深度工作台：上传文件成为普通交付件（uploads/ 下可见）
  await openWorkspace(page, '交付件')
  await expect(page.getByText(/界面-1\.png/).first()).toBeVisible()
})
