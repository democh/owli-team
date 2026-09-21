/**
 * E2E · M79 实时通道（auth 实例；幂等可重跑）：
 * 多端未读同步——同账号两页（同上下文 cookie）：
 * 1) bob 发私聊消息 → 两个页面（均不在该会话）**不刷新**出现未读徽章（WS 实时）；
 * 2) 页 2 打开该会话（已读上报）→ 页 1 徽章**不刷新**消失（notify:read-state → 服务端权威对账）；
 * 3) 清理填充会话（好友与私聊幂等复用）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const ADMIN = { username: 'e2e-admin', password: 'E2eAdmin1!x' }
const BOB = { username: 'e2e-bob', password: 'E2eBobPass2!x' }
const BOB_NAME = 'E2E Bob'

async function loginOrSetup(page: Page): Promise<void> {
  await page.goto('/')
  const status = (await (await page.request.get('/api/auth/status')).json()) as { needsSetup: boolean }
  if (status.needsSetup) {
    await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 30_000 })
    await page.getByTitle('账号（修改密码 / 退出登录）').click()
    await page.getByRole('button', { name: /创建管理员并启用多用户/ }).click()
    await page.getByLabel('用户名（登录名）').fill(ADMIN.username)
    await page.getByLabel('密码（至少 10 位，含两类字符）').fill(ADMIN.password)
    await page.getByLabel('确认密码').fill(ADMIN.password)
    await page.getByRole('button', { name: /创建并进入/ }).click()
  } else {
    await page.getByLabel('用户名').fill(ADMIN.username)
    await page.getByLabel('密码').fill(ADMIN.password)
    await page.getByRole('button', { name: '登录' }).click()
  }
  await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
}

async function ensureBobInitialPassword(page: Page): Promise<string> {
  const create = await page.request.post('/api/users', {
    data: { username: BOB.username, displayName: BOB_NAME, role: 'member' },
  })
  if (create.ok()) return ((await create.json()) as { initialPassword: string }).initialPassword
  const list = (await (await page.request.get('/api/users')).json()) as {
    users: Array<{ id: string; username: string }>
  }
  const bob = list.users.find((u) => u.username === BOB.username)
  expect(bob).toBeTruthy()
  const reset = await page.request.post(`/api/users/${bob!.id}/password`)
  expect(reset.ok()).toBeTruthy()
  return ((await reset.json()) as { initialPassword: string }).initialPassword
}

async function loginBob(ctx: BrowserContext, initialPassword: string): Promise<Page> {
  const bobPage = await ctx.newPage()
  await bobPage.goto('/')
  await bobPage.getByLabel('用户名').fill(BOB.username)
  await bobPage.getByLabel('密码').fill(initialPassword)
  await bobPage.getByRole('button', { name: '登录' }).click()
  await bobPage.getByLabel('当前密码（初始密码）').fill(initialPassword)
  await bobPage.getByLabel('新密码（至少 10 位，含两类字符）').fill(BOB.password)
  await bobPage.getByLabel('确认新密码').fill(BOB.password)
  await bobPage.getByRole('button', { name: /修改密码并进入/ }).click()
  await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
  return bobPage
}

/** 会话行定位（标题元素精确匹配——避免命中其他行预览里的同名字符串） */
const sessionRow = (page: Page, title: string) =>
  page.locator('.group').filter({ has: page.getByText(title, { exact: true }) }).first()

test('M79：多端未读同步——实时增量与 read-state 对账', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  try {
    // ---------- 0. 幂等准备：好友（API）→ 私聊（复用）→ 填充会话（避免停留私聊） ----------
    const bobId = ((await (await page.request.get('/api/users')).json()) as {
      users: Array<{ id: string; username: string }>
    }).users.find((u) => u.username === BOB.username)!.id
    const rel = (await (await page.request.get('/api/friends')).json()) as { friends: Array<{ userId: string }> }
    if (!rel.friends.some((f) => f.userId === bobId)) {
      const reqs = (await (await page.request.get('/api/friends/requests')).json()) as {
        outgoing: Array<{ id: string }>
      }
      if (reqs.outgoing.length === 0) {
        const created = await page.request.post('/api/friends/requests', { data: { username: BOB.username } })
        expect(created.ok()).toBeTruthy()
      }
      const incoming = (await (await bobPage.request.get('/api/friends/requests')).json()) as {
        incoming: Array<{ id: string }>
      }
      expect(incoming.incoming.length).toBeGreaterThan(0)
      const accepted = await bobPage.request.post(`/api/friends/requests/${incoming.incoming[0]!.id}/accept`)
      expect(accepted.ok()).toBeTruthy()
    }
    const dm = await page.request.post('/api/chats/direct', { data: { userId: bobId } })
    expect(dm.ok()).toBeTruthy()
    const dmId = ((await dm.json()) as { session: { id: string } }).session.id
    const fillerTitle = `E2E-M79-RT-填充-${Date.now()}`
    const filler = await page.request.post('/api/sessions', { data: { participantIds: [], title: fillerTitle } })
    expect(filler.ok()).toBeTruthy()
    const fillerId = ((await filler.json()) as { session: { id: string } }).session.id

    // ---------- 1. 同账号两页（同上下文 cookie）；均刷新一次纳入私聊与填充会话 ----------
    const page2 = await page.context().newPage()
    await page2.goto('/')
    await page.reload()
    await page2.reload()
    await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await expect(page2.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    // M79-F 修订：筛选 chip 默认「团队」——私聊行需切「聊天」筛选才可见
    await page2.getByRole('button', { name: '聊天', exact: true }).click()
    await expect(sessionRow(page2, BOB_NAME)).toBeVisible({ timeout: 20_000 })
    // 页 1：先打开私聊（已读清零）→ 切到填充会话（离开私聊，徽章可观察）
    await page.getByRole('button', { name: '聊天', exact: true }).click()
    await sessionRow(page, BOB_NAME).click()
    await expect(page.getByText('E2E Bob').first()).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '聊天', exact: true }).click() // 取消筛选 → 恢复全部（填充会话可见）
    await sessionRow(page, fillerTitle).click()

    // ---------- 2. bob 发消息 → 两页实时出现未读徽章（不刷新） ----------
    const sent = await bobPage.request.post(`/api/sessions/${dmId}/messages`, {
      data: { content: '实时未读联调消息' },
    })
    expect(sent.ok()).toBeTruthy()
    await expect(sessionRow(page, BOB_NAME).locator('.badge-pop')).toBeVisible({ timeout: 15_000 })
    await expect(sessionRow(page2, BOB_NAME).locator('.badge-pop')).toBeVisible({ timeout: 15_000 })

    // ---------- 3. 页 2 打开私聊（已读上报）→ 页 1 徽章实时消失（read-state 对账） ----------
    await sessionRow(page2, BOB_NAME).click()
    // 限定消息气泡（会话预览 / 通知 toast 同文会触发严格模式冲突）
    await expect(page2.locator('[id^="msg-"]', { hasText: '实时未读联调消息' }).first()).toBeVisible({
      timeout: 10_000,
    })
    await expect(sessionRow(page, BOB_NAME).locator('.badge-pop')).toHaveCount(0, { timeout: 15_000 })

    // ---------- 4. 清理 ----------
    await page2.close()
    await page.request.delete(`/api/sessions/${fillerId}?deleteWorkspace=false`)
  } finally {
    await ctx.close()
  }
})
