/**
 * E2E · M80 已读回执与对等隐身（auth 实例；幂等可重跑）：
 * 1) 私聊已读：admin 发 m1 → admin 侧「未读」；bob 打开 DM 读到 → admin 侧实时「已读」（notify:read-receipt）；
 * 2) 基线对照：bob 发 m2 → admin REST 强制读到 → bob 侧「已读」（全链路可见基线真实）；
 * 3) 对等隐身：bob 关「向他人展示我的已读状态」→ 双方均不可见——
 *    admin 侧看不到 bob 的已读（投影过滤）；bob 侧也看不到 admin 的已读（请求者空投影 + 客户端门）；
 * 4) 复开恢复：重新开启后徽章回归。
 * 前置（好友 / 私聊）经 UI / API 幂等确保；消息文本逐轮唯一。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const composerInput = (page: Page) => page.getByPlaceholder(/发消息…（@ 可点名|输入消息，@ 召唤成员/)
const messageRow = (page: Page, text: string) => page.locator('[id^="msg-"]', { hasText: text }).first()
const sessionRow = (page: Page, title: string) =>
  page.locator('.group').filter({ has: page.getByText(title, { exact: true }) }).first()

const ADMIN = { username: 'e2e-admin', password: 'E2eAdmin1!x' }
const BOB = { username: 'e2e-bob', password: 'E2eBobPass2!x' }
const BOB_NAME = 'E2E Bob'
const ADMIN_NAME = 'e2e-admin'

/** 首启（首次运行）或登录（后续运行）→ admin 进入应用（幂等） */
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

/** 确保 bob 存在且拿到一次性初始密码（创建失败 = 已存在 → 重置；幂等） */
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

/** bob 独立上下文登录（含强制改密；幂等） */
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

const openContacts = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /联系人/ }).click()
}
const openSessions = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '会话', exact: true }).click()
}

/** 发送（带「值已落位」断言；避免与切会话的输入重置竞态） */
async function sendOn(page: Page, text: string): Promise<void> {
  const input = composerInput(page)
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/** 好友关系幂等确保（m79-social 同款首跑路径；已为好友直接通过） */
async function ensureFriendship(page: Page, bobPage: Page): Promise<void> {
  const friends = (await (await page.request.get('/api/friends')).json()) as {
    friends: Array<{ username: string }>
  }
  if (friends.friends.some((f) => f.username === BOB.username)) return
  const reqs = (await (await page.request.get('/api/friends/requests')).json()) as {
    outgoing: Array<{ user: { username: string } }>
  }
  if (!reqs.outgoing.some((r) => r.user.username === BOB.username)) {
    await openContacts(page)
    await page.getByPlaceholder('搜索用户（用户名 / 昵称）').fill(BOB.username)
    await page.getByRole('button', { name: /加好友/ }).first().click()
    await expect(page.getByText(`已向「${BOB_NAME}」发送好友申请`)).toBeVisible({ timeout: 10_000 })
    await page.getByRole('button', { name: '清空搜索' }).click()
  }
  await openContacts(bobPage)
  await bobPage.getByRole('button', { name: '接受' }).first().click()
  await openSessions(bobPage)
}

/** 私聊会话幂等确保（API 创建 / 复用）；返回会话 id */
async function ensureDirectSession(page: Page): Promise<string> {
  const users = (await (await page.request.get('/api/users')).json()) as {
    users: Array<{ id: string; username: string }>
  }
  const bob = users.users.find((u) => u.username === BOB.username)
  expect(bob).toBeTruthy()
  const res = await page.request.post('/api/chats/direct', { data: { userId: bob!.id } })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { session: { id: string } }).session.id
}

/** 打开私聊（筛选「聊天」→ 点行 → 激活态确认） */
async function openDirectChat(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  const row = sessionRow(page, title)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(row).toHaveClass(/border-primary/, { timeout: 10_000 })
}

/** 重载并回到工作台主视图（列表行交互前提） */
async function reloadToWorkspace(page: Page): Promise<void> {
  await page.reload()
  await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: '工作台' }).click()
}

/** 打开设置页并切换「向他人展示我的已读状态」（返回后回工作台） */
async function toggleReadReceipts(page: Page, expectChecked: boolean): Promise<void> {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const toggle = page.getByRole('switch', { name: '向他人展示我的已读状态' })
  await expect(toggle).toBeVisible({ timeout: 10_000 })
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', String(expectChecked))
  await page.getByRole('button', { name: '工作台' }).click()
}

test('M80：私聊已读实时到位 + 关闭开关对等隐身', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  let bobPage = await loginBob(ctx, initialPassword)
  try {
    await ensureFriendship(page, bobPage)
    const sid = await ensureDirectSession(page)
    // 前置：让 bob 离线——避免「孤立数据目录里 DM 是唯一会话、登录自动选中并自动已读」干扰「未读」基线
    await bobPage.close()

    await reloadToWorkspace(page)
    await openDirectChat(page, BOB_NAME)

    // ---------- 1. admin 发 m1 → 「未读」（bob 离线，未读到） ----------
    const m1 = `M80-已读-${Date.now()}`
    await sendOn(page, m1)
    const row1 = messageRow(page, m1)
    await expect(row1).toBeVisible({ timeout: 10_000 })
    await expect(row1.getByText('未读', { exact: true })).toBeVisible()

    // ---------- 2. bob 上线打开 DM 读到 → admin 侧实时「已读」 ----------
    bobPage = await ctx.newPage()
    await bobPage.goto('/')
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click()
    const bobSession = sessionRow(bobPage, ADMIN_NAME)
    await expect(bobSession).toBeVisible({ timeout: 10_000 })
    await bobSession.click()
    await expect(messageRow(bobPage, m1)).toBeVisible({ timeout: 10_000 })
    await expect(row1.getByText('已读', { exact: true })).toBeVisible({ timeout: 15_000 })

    // ---------- 3. 基线对照：bob 发 m2 → admin REST 强制读到 → bob 侧「已读」 ----------
    const m2 = `M80-隐身-${Date.now()}`
    await sendOn(bobPage, m2)
    await expect(messageRow(bobPage, m2)).toBeVisible({ timeout: 10_000 })
    const detail = (await (await page.request.get(`/api/sessions/${sid}`)).json()) as {
      messages: Array<{ seq?: number; content: string }>
    }
    const m2seq = detail.messages.find((m) => m.content.includes(m2))?.seq ?? 0
    expect(m2seq).toBeGreaterThan(0)
    const read = await page.request.post(`/api/sessions/${sid}/read`, { data: { seq: m2seq } })
    expect(read.ok()).toBeTruthy()
    await expect(messageRow(bobPage, m2).getByText('已读', { exact: true })).toBeVisible({ timeout: 15_000 })

    // ---------- 4. bob 关开关（设置页 UI）→ 双向隐身 ----------
    await toggleReadReceipts(bobPage, false)

    // 4a. admin 侧：重进 DM 后 m1 徽章消失（bob 不再投影；others 为空 → 徽章不渲染）
    await reloadToWorkspace(page)
    await openDirectChat(page, BOB_NAME)
    const row1b = messageRow(page, m1)
    await expect(row1b).toBeVisible({ timeout: 10_000 })
    await expect(row1b.getByText('已读', { exact: true })).toHaveCount(0)
    await expect(row1b.getByText('未读', { exact: true })).toHaveCount(0)

    // 4b. bob 侧：也看不到 admin 的已读（m2 徽章消失；请求者空投影 + 客户端门）
    await reloadToWorkspace(bobPage)
    await openDirectChat(bobPage, ADMIN_NAME)
    const bobRow2 = messageRow(bobPage, m2)
    await expect(bobRow2).toBeVisible({ timeout: 10_000 })
    await expect(bobRow2.getByText('已读', { exact: true })).toHaveCount(0)

    // ---------- 5. 复开恢复：admin 侧「已读」回归 ----------
    await toggleReadReceipts(bobPage, true)
    await reloadToWorkspace(bobPage)
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click()
    await sessionRow(bobPage, ADMIN_NAME).click() // 重读触发水位上报（幂等）
    await reloadToWorkspace(page)
    await openDirectChat(page, BOB_NAME)
    await expect(messageRow(page, m1).getByText('已读', { exact: true })).toBeVisible({ timeout: 10_000 })
  } finally {
    await ctx.close()
  }
})
