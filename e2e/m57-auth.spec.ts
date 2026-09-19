/**
 * E2E · M57 多用户（独立实例 8790，持久数据目录 data/e2e-auth；用例幂等可重跑）：
 * 1) 首启向导（首次运行）或登录（后续运行）→ admin 进入应用，管理面入口可见；
 * 2) admin 建一个隔离标记会话；创建 / 重置成员 bob → 独立浏览器上下文登录 → 强制改密页 → 进入应用；
 * 3) 成员侧断言：管理面入口不可见；admin 会话在侧栏与 API 列表均不可见；直取他人会话 → 404；管理面 API → 403。
 * 4) P2 共享 UI 全链路（第二个用例）：邀请（弹窗）→ 成员侧徽章 → 转只读 → 只读横幅与锁 → 移除。
 */
import { expect, test, type Page } from '@playwright/test'

const ADMIN = { username: 'e2e-admin', password: 'E2eAdmin1!x' }
const BOB = { username: 'e2e-bob', password: 'E2eBobPass2!x' }

test('M57：首启 / 登录 / 强制改密 / 跨用户隔离', async ({ page, browser }) => {
  // ---------- 1. 首启或登录（幂等） ----------
  await page.goto('/')
  const status = (await (await page.request.get('/api/auth/status')).json()) as { needsSetup: boolean }
  if (status.needsSetup) {
    // 兼容模式（无账号）直达应用 → 账号弹窗发起首启初始化 → 向导创建管理员
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
  // 登录 / 首启成功后整页 reload → 应用挂载（工作台 rail 可见，非停留在认证页）
  await expect(page.getByText('Owli Team').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: '工作台' })).toBeVisible()
  // admin：管理面入口可见
  await expect(page.getByRole('button', { name: '连接管理' })).toBeVisible()

  // ---------- 2. admin 建隔离标记会话 ----------
  const adminTitle = `E2E-AUTH-隔离-${Date.now()}`
  const created = await page.request.post('/api/sessions', { data: { participantIds: [], title: adminTitle } })
  expect(created.ok()).toBeTruthy()
  const adminSessionId = ((await created.json()) as { session: { id: string } }).session.id
  await page.reload()
  await expect(page.getByText(adminTitle).first()).toBeVisible()

  // ---------- 3. 建 / 重置 bob（保证拿到一次性初始密码 → 强制改密链路） ----------
  const createBob = await page.request.post('/api/users', {
    data: { username: BOB.username, displayName: 'E2E Bob', role: 'member' },
  })
  let initialPassword: string
  if (createBob.ok()) {
    initialPassword = ((await createBob.json()) as { initialPassword: string }).initialPassword
  } else {
    const list = (await (await page.request.get('/api/users')).json()) as {
      users: Array<{ id: string; username: string }>
    }
    const bob = list.users.find((u) => u.username === BOB.username)
    expect(bob).toBeTruthy()
    const reset = await page.request.post(`/api/users/${bob!.id}/password`)
    expect(reset.ok()).toBeTruthy()
    initialPassword = ((await reset.json()) as { initialPassword: string }).initialPassword
  }

  // ---------- 4. bob 独立上下文：登录 → 强制改密 → 进入应用 ----------
  const ctx = await browser.newContext()
  const bobPage = await ctx.newPage()
  try {
    await bobPage.goto('/')
    await bobPage.getByLabel('用户名').fill(BOB.username)
    await bobPage.getByLabel('密码').fill(initialPassword)
    await bobPage.getByRole('button', { name: '登录' }).click()

    // 首登强制改密
    await bobPage.getByLabel('当前密码（初始密码）').fill(initialPassword)
    await bobPage.getByLabel('新密码（至少 10 位，含两类字符）').fill(BOB.password)
    await bobPage.getByLabel('确认新密码').fill(BOB.password)
    await bobPage.getByRole('button', { name: /修改密码并进入/ }).click()
    await expect(bobPage.getByText('Owli Team').first()).toBeVisible({ timeout: 30_000 })
    // 确认已离开认证页（工作台 rail 可见）
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible()

    // 4.1 管理面入口不可见（rail 隐藏 + 命令面板隐藏）
    await expect(bobPage.getByRole('button', { name: '连接管理' })).toHaveCount(0)
    await expect(bobPage.getByRole('button', { name: '用户管理' })).toHaveCount(0)

    // 4.2 会话隔离：侧栏不含 admin 会话；API 列表不含；直取 → 404
    await expect(bobPage.getByText(adminTitle)).toHaveCount(0)
    const listRes = (await (await bobPage.request.get('/api/sessions')).json()) as {
      sessions: Array<{ id: string }>
    }
    expect(listRes.sessions.some((s) => s.id === adminSessionId)).toBe(false)
    const direct = await bobPage.request.get(`/api/sessions/${adminSessionId}`)
    expect(direct.status()).toBe(404)

    // 4.3 管理面 API → 403（成员越权）
    expect((await bobPage.request.get('/api/users')).status()).toBe(403)
    expect((await bobPage.request.get('/api/audit')).status()).toBe(403)

    // 4.4 个人设置可用（成员视角）
    await bobPage.getByRole('button', { name: '设置' }).click()
    await expect(bobPage.getByText('个人偏好与账号')).toBeVisible()
  } finally {
    await ctx.close()
  }
})

/** 确保 bob 存在且拿到一次性初始密码（创建失败 = 已存在 → 重置） */
async function ensureBobInitialPassword(page: Page): Promise<string> {
  const create = await page.request.post('/api/users', {
    data: { username: BOB.username, displayName: 'E2E Bob', role: 'member' },
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

test('M57 P2：会话共享（邀请 → 协作徽章 → 转只读锁 → 移除）', async ({ page, browser }) => {
  // ---------- 1. admin 进入（首启或登录，幂等） ----------
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

  // ---------- 2. bob 入场（重置密码 → 强制改密，幂等） ----------
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await ctx.newPage()
  try {
    await bobPage.goto('/')
    await bobPage.getByLabel('用户名').fill(BOB.username)
    await bobPage.getByLabel('密码').fill(initialPassword)
    await bobPage.getByRole('button', { name: '登录' }).click()
    await bobPage.getByLabel('当前密码（初始密码）').fill(initialPassword)
    await bobPage.getByLabel('新密码（至少 10 位，含两类字符）').fill(BOB.password)
    await bobPage.getByLabel('确认新密码').fill(BOB.password)
    await bobPage.getByRole('button', { name: /修改密码并进入/ }).click()
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })

    // ---------- 3. admin 建会话并在弹窗中邀请 bob（UI） ----------
    const title = `E2E-SHARE-${Date.now()}`
    const created = await page.request.post('/api/sessions', { data: { participantIds: [], title } })
    expect(created.ok()).toBeTruthy()
    await page.reload()
    await page.getByText(title).first().click()
    await page.getByRole('button', { name: '共享', exact: true }).click()
    await page.getByPlaceholder('用户名（由管理员在「用户管理」创建）').fill(BOB.username)
    await page.getByRole('button', { name: '邀请' }).click()
    await expect(page.getByText(`@${BOB.username}`)).toBeVisible()

    // ---------- 4. bob 侧：列表可见 + 协作徽章 + 头部态（可写） ----------
    await bobPage.reload()
    await expect(bobPage.getByText(title).first()).toBeVisible()
    await expect(bobPage.getByTitle('与我共享：可协作（读写）')).toBeVisible()
    await bobPage.getByText(title).first().click()
    await expect(bobPage.getByRole('button', { name: '已共享 · 可协作' })).toBeVisible()

    // ---------- 5. admin 改为只读 → bob 侧：只读徽章 + 横幅 + Composer 锁定 ----------
    await page.getByRole('button', { name: '改为只读' }).click()
    // 等待服务端提交生效（按钮翻转为「改为可协作」）后再观察 bob
    await expect(page.getByRole('button', { name: '改为可协作' })).toBeVisible()
    await bobPage.reload()
    await expect(bobPage.getByTitle('与我共享：只读')).toBeVisible()
    await bobPage.getByText(title).first().click()
    await expect(bobPage.getByText(/只读共享（viewer）：可查看消息与交付件/)).toBeVisible()
    await expect(bobPage.getByPlaceholder(/只读共享（viewer）：无写权限/)).toBeVisible()

    // ---------- 6. admin 移出 → bob 侧会话消失（重载兜底） ----------
    await page.getByTitle('移出共享').click()
    await expect(page.getByText(`@${BOB.username}`)).toHaveCount(0) // 等待移除生效
    await bobPage.reload()
    await expect(bobPage.getByText(title)).toHaveCount(0)
  } finally {
    await ctx.close()
  }
})

test('M57 P3：配额闸门与个人资源卡片（幂等自清理）', async ({ page, browser }) => {
  // ---------- 1. admin 进入（首启或登录，幂等） ----------
  await page.goto('/')
  const status = (await (await page.request.get('/api/auth/status')).json()) as { needsSetup: boolean }
  if (status.needsSetup) {
    await expect(page.getByText('Owli Agent Team').first()).toBeVisible({ timeout: 30_000 })
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

  // ---------- 2. bob 入场（幂等） ----------
  const initialPassword = await ensureBobInitialPassword(page)
  const list = (await (await page.request.get('/api/users')).json()) as { users: Array<{ id: string; username: string }> }
  const bobId = list.users.find((u) => u.username === BOB.username)!.id

  // ---------- 3. admin 清空 bob 配额（幂等起点） ----------
  const clearQuota = async (): Promise<void> => {
    const res = await page.request.put(`/api/users/${bobId}/quota`, {
      data: { maxConcurrentRuns: null, dailyTokens: null, monthlyCostUsd: null, maxSessions: null, maxStorageMb: null },
    })
    expect(res.ok()).toBeTruthy()
  }
  await clearQuota()

  const ctx = await browser.newContext()
  const bobPage = await ctx.newPage()
  try {
    await bobPage.goto('/')
    await bobPage.getByLabel('用户名').fill(BOB.username)
    await bobPage.getByLabel('密码').fill(initialPassword)
    await bobPage.getByRole('button', { name: '登录' }).click()
    await bobPage.getByLabel('当前密码（初始密码）').fill(initialPassword)
    await bobPage.getByLabel('新密码（至少 10 位，含两类字符）').fill(BOB.password)
    await bobPage.getByLabel('确认新密码').fill(BOB.password)
    await bobPage.getByRole('button', { name: /修改密码并进入/ }).click()
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })

    // ---------- 4. bob 清理自有会话（幂等起点） ----------
    const before = (await (await bobPage.request.get('/api/sessions')).json()) as { sessions: Array<{ id: string }> }
    for (const s of before.sessions) {
      const del = await bobPage.request.delete(`/api/sessions/${s.id}?deleteWorkspace=false`)
      expect(del.ok()).toBeTruthy()
    }

    // ---------- 5. admin 设 maxSessions=1 → bob 第 2 个会话被拒（403 + 文案） ----------
    const setQuota = await page.request.put(`/api/users/${bobId}/quota`, { data: { maxSessions: 1 } })
    expect(setQuota.ok()).toBeTruthy()
    const first = await bobPage.request.post('/api/sessions', { data: { participantIds: [], title: `E2E-P3-${Date.now()}` } })
    expect(first.ok()).toBeTruthy()
    const createdSessionId = ((await first.json()) as { session: { id: string } }).session.id
    const second = await bobPage.request.post('/api/sessions', { data: { participantIds: [] } })
    expect(second.status()).toBe(403)
    expect(((await second.json()) as { error: string }).error).toContain('会话数已达上限')

    // ---------- 6. bob UI：我的用量 卡 + P3 卡片在位；配额证据以 API 为准（避免文案匹配抖动） ----------
    const usage = (await (await bobPage.request.get('/api/usage/me')).json()) as {
      summary: { sessions: number; limits: { maxSessions?: number } }
    }
    expect(usage.summary.sessions).toBe(1)
    expect(usage.summary.limits.maxSessions).toBe(1)
    await bobPage.getByRole('button', { name: '设置' }).click()
    await expect(bobPage.getByText('我的用量')).toBeVisible({ timeout: 10_000 })
    await expect(bobPage.getByText(/会话数：/)).toBeVisible({ timeout: 10_000 })
    await expect(bobPage.getByText('我的连接')).toBeVisible({ timeout: 10_000 })
    await expect(bobPage.getByText('模型直连（BYOK）')).toBeVisible({ timeout: 10_000 })

    // ---------- 7. 清理（幂等）：删会话 + 清配额 ----------
    const cleanup = await bobPage.request.delete(`/api/sessions/${createdSessionId}?deleteWorkspace=false`)
    expect(cleanup.ok()).toBeTruthy()
    await clearQuota()
  } finally {
    await ctx.close()
  }
})
