/**
 * E2E · M80 表情回应（auth 实例，默认 8790 / data/e2e-auth；隔离运行见 playwright.config 注释；幂等可重跑）：
 * 1) 私聊双人互挂：admin 挂 👍 → bob 不刷新实时「👍 1」；bob 点聚合条同挂 → 聚合「👍 2」；
 * 2) 摘除（toggle）：bob 再点自己已挂的聚合条 → 回落「👍 1」（admin 侧实时）；
 * 3) 「更多」完整面板：搜索「火箭」挂 🚀；随后 admin 摘净本条全部回应（防跨轮残留）。
 * 前置（好友 / 私聊）经既有 UI / API 幂等确保（本文件不重复覆盖 M79 社交链路断言）；
 * 消息文本逐轮唯一——断言不受历史消息影响。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/** 输入框定位（M79-J：chat 形态 placeholder 与 team 不同——用双态正则兼容） */
const composerInput = (page: Page) => page.getByPlaceholder(/发消息…（@ 可点名|输入消息，@ 召唤成员/)
/** 消息行（气泡容器；限定避免命中会话预览 / toast 同文） */
const messageRow = (page: Page, text: string) => page.locator('[id^="msg-"]', { hasText: text }).first()
/** 会话行定位（左栏列表；标题精确匹配） */
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

/** 私聊会话幂等确保（API 创建 / 复用） */
async function ensureDirectSession(page: Page): Promise<void> {
  const users = (await (await page.request.get('/api/users')).json()) as {
    users: Array<{ id: string; username: string }>
  }
  const bob = users.users.find((u) => u.username === BOB.username)
  expect(bob).toBeTruthy()
  const res = await page.request.post('/api/chats/direct', { data: { userId: bob!.id } })
  expect(res.ok()).toBeTruthy()
}

/** 打开私聊（筛选「聊天」→ 点行 → 激活态确认，currentId 已提交的确定性信号） */
async function openDirectChat(page: Page, title: string): Promise<void> {
  await page.getByRole('button', { name: '聊天', exact: true }).click()
  const row = sessionRow(page, title)
  await expect(row).toBeVisible({ timeout: 10_000 })
  await row.click()
  await expect(row).toHaveClass(/border-primary/, { timeout: 10_000 })
}

test('M80：双人互挂 / 实时聚合 / 摘除 / 更多面板', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  try {
    await ensureFriendship(page, bobPage)
    await ensureDirectSession(page)
    await page.reload()
    await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await openDirectChat(page, BOB_NAME)

    // ---------- 1. admin 发消息并挂 👍（悬停工具条 → 快捷条） ----------
    const text = `M80-表情-${Date.now()}`
    await sendOn(page, text)
    const row = messageRow(page, text)
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.hover()
    await row.getByRole('button', { name: '表情回应', exact: true }).click()
    await row.getByRole('button', { name: '👍', exact: true }).click()
    await expect(row.getByRole('button', { name: /👍 1 人/ })).toBeVisible()

    // ---------- 2. bob 不刷新实时可见（notify:reaction 会话主题帧） ----------
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click()
    const bobSession = sessionRow(bobPage, ADMIN_NAME)
    await expect(bobSession).toBeVisible({ timeout: 10_000 })
    await bobSession.click()
    const bobRow = messageRow(bobPage, text)
    await expect(bobRow).toBeVisible({ timeout: 10_000 })
    await expect(bobRow.getByRole('button', { name: /👍 1 人/ })).toBeVisible({ timeout: 15_000 })

    // ---------- 3. bob 点聚合条同挂 → 聚合 2（admin 侧实时） ----------
    await bobRow.getByRole('button', { name: /👍 1 人/ }).click()
    await expect(bobRow.getByRole('button', { name: /👍 2 人/ })).toBeVisible()
    await expect(row.getByRole('button', { name: /👍 2 人/ })).toBeVisible({ timeout: 15_000 })

    // ---------- 4. bob 再点（toggle 摘除）→ 回落 1 ----------
    await bobRow.getByRole('button', { name: /👍 2 人/ }).click()
    await expect(row.getByRole('button', { name: /👍 1 人/ })).toBeVisible({ timeout: 15_000 })

    // ---------- 5. 「更多」完整面板：搜索「火箭」Enter 插入 🚀（键盘路径；面板向上展开时应避开视口外点击） ----------
    await row.hover()
    await row.getByRole('button', { name: '表情回应', exact: true }).click()
    await row.getByRole('button', { name: '更多表情', exact: true }).click()
    const panel = page.getByRole('dialog', { name: '表情选择' })
    await expect(panel).toBeVisible()
    const search = panel.getByPlaceholder('搜索表情（中文 / 英文 / 拼音）')
    await search.fill('火箭')
    await expect(panel.getByRole('button', { name: '火箭', exact: true })).toBeVisible()
    await search.press('Enter') // 键盘插入（§5.2：↑↓←→ 导航 / Enter 插入）
    await expect(row.getByRole('button', { name: /🚀 1 人/ })).toBeVisible()

    // ---------- 6. 清理：admin 摘净本条回应（防跨轮残留；消息文本逐轮唯一） ----------
    await row.getByRole('button', { name: /👍 1 人/ }).click()
    await expect(row.locator('button[aria-label^="👍"]')).toHaveCount(0)
    await row.getByRole('button', { name: /🚀 1 人/ }).click()
    await expect(row.locator('button[aria-label^="🚀"]')).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})
