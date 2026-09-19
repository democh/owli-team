/**
 * E2E · 交付件多格式预览（M24，mock 模式）：
 * 通过 uploads API 注入 html / csv / docx / mermaid 四种交付件 →
 * 逐一点击验证分派：html 沙箱 iframe 直出、csv 表格、docx 服务端解析 HTML、
 * mermaid 渲染 SVG；Office 交付件收起源码 / Diff 切换。
 */
import { expect, test, type Page } from '@playwright/test'
import { ALL_AGENTS, createSession, openApp, openWorkspace } from './helpers'

const UNPICK = ALL_AGENTS.filter((id) => id !== 'backend')

// ---------- 最小 zip（stored）构造器：docx 为 zip 容器 ----------

function buildZip(files: Array<[string, string]>): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0
  for (const [name, text] of files) {
    const nameBuf = Buffer.from(name, 'utf8')
    const data = Buffer.from(text, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    localParts.push(local, nameBuf, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, nameBuf)
    offset += local.length + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centralParts)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(files.length, 8)
  eocd.writeUInt16LE(files.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, cd, eocd])
}

function docxBytes(): Buffer {
  const doc = [
    '<w:document><w:body>',
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>季度小结</w:t></w:r></w:p>',
    '<w:p><w:r><w:t>营收保持增长，重点：</w:t></w:r></w:p>',
    '<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>扩充南方渠道</w:t></w:r></w:p>',
    '</w:body></w:document>',
  ].join('')
  return buildZip([['word/document.xml', doc]])
}

/** 上传到会话工作区 uploads/（服务端 base64 直传；落盘 path 形如 uploads/<ts>-<name>） */
async function upload(page: Page, sessionId: string, name: string, data: Buffer): Promise<void> {
  const res = await page.request.post(`/api/sessions/${sessionId}/uploads`, {
    data: { name, dataBase64: data.toString('base64') },
  })
  expect(res.ok()).toBeTruthy()
}

async function sessionIdByTitle(page: Page, title: string): Promise<string> {
  const res = await page.request.get('/api/sessions')
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { sessions: Array<{ id: string; title: string }> }
  const hit = body.sessions.find((s) => s.title === title)
  expect(hit, `未找到会话：${title}`).toBeTruthy()
  return hit!.id
}

test('交付件多格式预览：html / csv / docx / mermaid 分派', async ({ page }) => {
  await openApp(page)
  const title = `E2E-Preview-${Date.now()}`
  await createSession(page, { title, unpick: UNPICK })
  const sid = await sessionIdByTitle(page, title)

  await upload(
    page,
    sid,
    '报表.html',
    Buffer.from('<!doctype html><html><body><h1>季度报表</h1><p>HTML 直出预览</p></body></html>'),
  )
  await upload(page, sid, '订单.csv', Buffer.from('区域,营收,同比\n华东,120,12%\n华南,80,8%\n'))
  await upload(page, sid, '季度小结.docx', docxBytes())
  await upload(page, sid, '流程.mmd', Buffer.from('graph TD\n  A[提交需求] --> B[联调验收]\n'))

  await openWorkspace(page, '交付件')
  await expect(page.getByText(/工作区 · 4 个文件/)).toBeVisible()

  // html → 沙箱 iframe（raw 原文流）直出；源码 / Diff 可用
  await page.locator('button[title*="报表.html"]').click()
  await expect(page.locator('iframe')).toBeVisible()
  await expect(page.frameLocator('iframe').locator('h1')).toHaveText('季度报表')
  await expect(page.getByRole('button', { name: '源码' })).toBeVisible()

  // csv → 表格预览 + 行列信息条
  await page.locator('button[title*="订单.csv"]').click()
  await expect(page.getByText(/2 行 × 3 列/)).toBeVisible()
  await expect(page.getByRole('columnheader', { name: '区域' })).toBeVisible()

  // docx → 服务端解析（iframe 卸载；源码 / Diff 收起）
  await page.locator('button[title*="季度小结.docx"]').click()
  await expect(page.locator('.off-doc h1')).toHaveText('季度小结')
  await expect(page.locator('.off-doc li')).toHaveText('扩充南方渠道')
  await expect(page.locator('iframe')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '源码' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Diff' })).toHaveCount(0)

  // mermaid → 懒加载 chunk（本地 bundle）渲染 SVG
  await page.locator('button[title*="流程.mmd"]').click()
  await expect(page.locator('.md-mermaid-canvas svg').first()).toBeVisible({ timeout: 20_000 })
})
