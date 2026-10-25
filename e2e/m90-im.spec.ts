/**
 * E2E · M90 IM 交互（auth 实例，默认 8790 / data/e2e-auth；双浏览器 + 同账号双标签页；幂等可重跑）：
 * T1 私聊：结构化引用回复（服务端权威快照 / 点击回跳）→ 撤回联动（「原消息已撤回」墓碑）→
 *   编辑留痕（「已编辑」实时同步）→ 仅自己删除（本端消失 / 对端无感）→ typing 临时帧（消息到达即清除）。
 * T2 群聊 + admin 双标签页：置顶 / 免打扰 / 标记未读（读到自动解除）/ 归档视图（偏好帧多端同步）→
 *   群主转让（Crown 二次确认 / 徽章互换 / 治理按钮消失 / 系统事件条）。
 * T3 群聊：搜索筛选（我发的 / 含附件 / 时间范围）→ 命中直达（打开会话 + 定位到命中的那条）→ 撤回消息搜索不可见。
 * 前置好友 / 私聊经 API 幂等确保；群聊逐轮唯一命名并在文末清理（转让回 admin 后删除）；
 * 消息文本逐轮唯一（Date.now 关键字），搜索断言不受历史数据影响。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

const ADMIN = { username: 'e2e-admin', password: 'E2eAdmin1!x' }
const BOB = { username: 'e2e-bob', password: 'E2eBobPass2!x' }
const BOB_NAME = 'E2E Bob'
const ADMIN_NAME = 'e2e-admin'

/** 输入框（chat / team 双形态 placeholder 兼容，M79-J 先例） */
const composerInput = (page: Page) => page.getByPlaceholder(/发消息…（@ 可点名|输入消息，@ 召唤成员/)
/** 消息行（气泡容器；限定避免命中会话预览 / toast 同文） */
const messageRow = (page: Page, text: string) => page.locator('[id^="msg-"]', { hasText: text }).first()
/** 会话行（左栏列表；标题精确匹配）——限定含行首「私聊 / 群聊」类型图标，排除聊天区
 *  当前会话头部 / 消息行（同为 .group 且含对端昵称文本）的干扰（如 DM 打开后标题重现于头部）。 */
const sessionRow = (page: Page, title: string) =>
  page
    .locator('.group:has([aria-label="私聊"], [aria-label="群聊"])')
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()

async function sendOn(page: Page, text: string): Promise<void> {
  const input = composerInput(page)
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/** 打开某条消息的操作菜单（悬停工具条 → ⋯） */
async function openMsgMenu(page: Page, row: ReturnType<typeof messageRow>): Promise<void> {
  await row.hover()
  await row.getByRole('button', { name: '消息操作' }).click()
}

const openContacts = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: /联系人/ }).click()
}
const openSessions = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '会话', exact: true }).click()
}
const chatFilter = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '聊天', exact: true }).click()
}

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

/** 好友关系幂等确保（m80 同款；已为好友直接通过） */
async function ensureFriendship(adminPage: Page, bobPage: Page): Promise<void> {
  const friends = (await (await adminPage.request.get('/api/friends')).json()) as {
    friends: Array<{ username: string }>
  }
  if (friends.friends.some((f) => f.username === BOB.username)) return
  const reqs = (await (await adminPage.request.get('/api/friends/requests')).json()) as {
    outgoing: Array<{ user: { username: string } }>
  }
  if (!reqs.outgoing.some((r) => r.user.username === BOB.username)) {
    await openContacts(adminPage)
    await adminPage.getByPlaceholder('搜索用户（用户名 / 昵称）').fill(BOB.username)
    await adminPage.getByRole('button', { name: /加好友/ }).first().click()
    await expect(adminPage.getByText(`已向「${BOB_NAME}」发送好友申请`)).toBeVisible({ timeout: 10_000 })
    await adminPage.getByRole('button', { name: '清空搜索' }).click()
  }
  await openContacts(bobPage)
  await bobPage.getByRole('button', { name: '接受' }).first().click()
  await openSessions(bobPage)
}

/** 通过 id 查账号（用户名） */
async function userIdOf(page: Page, username: string): Promise<string> {
  const list = (await (await page.request.get('/api/users')).json()) as {
    users: Array<{ id: string; username: string }>
  }
  const u = list.users.find((x) => x.username === username)
  expect(u).toBeTruthy()
  return u!.id
}

/** 私聊会话幂等确保（API 创建 / 复用）→ 返回会话 id（供消息级 API 操作定位） */
async function ensureDirectSession(page: Page): Promise<string> {
  const bob = await userIdOf(page, BOB.username)
  const res = await page.request.post('/api/chats/direct', { data: { userId: bob } })
  expect(res.ok()).toBeTruthy()
  const { session } = (await res.json()) as { session: { id: string } }
  // 偏好复位（幂等）：上一轮 T2 若在「归档私聊」后中断，本端 DM 会残留归档 / 置顶 / 免打扰，
  // 导致后续 openChat 在聊天筛选列表找不到行；统一归零保证可重跑。
  await page.request.patch(`/api/sessions/${session.id}/prefs`, {
    data: { pinned: false, muted: false, archived: false, markedUnread: false },
  })
  return session.id
}

/** 按正文查消息 id（会话详情全量投影；m90 消息文本逐轮唯一，精确匹配安全） */
async function messageIdOf(page: Page, sessionId: string, content: string): Promise<string> {
  const data = (await (await page.request.get(`/api/sessions/${sessionId}`)).json()) as {
    messages: Array<{ id: string; content: string }>
  }
  const m = data.messages.find((x) => x.content === content)
  expect(m, `消息「${content}」不存在`).toBeTruthy()
  return m!.id
}

/** 打开会话（会话页→聊天筛选→点行→激活态确认） */
async function openChat(page: Page, title: string): Promise<void> {
  await openSessions(page)
  await chatFilter(page)
  const row = sessionRow(page, title)
  await expect(row).toBeVisible({ timeout: 15_000 })
  // 点行首图标区（左侧）触发 onSelect：带未读徽标 / 预览的两行会话行，其几何中心落在右侧
  // 悬停操作按钮条（置顶 / 免打扰… 均 e.stopPropagation）内，row.click() 中心点击会被拦截而
  // 不切换选中；固定点左侧图标区稳定冒泡到行 onClick。
  await row.click({ position: { x: 8, y: 8 } })
  await expect(row).toHaveClass(/border-primary/, { timeout: 10_000 })
}

/** UI 建群（好友多选 1 人）→ 群打开（系统事件条门控） */
async function createGroup(page: Page, title: string): Promise<void> {
  await openContacts(page)
  await page.getByRole('button', { name: /新建群聊/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByPlaceholder('群聊名称（留空 = 自动命名）').fill(title)
  await dialog.getByRole('button', { name: new RegExp(BOB_NAME) }).click()
  await dialog.getByRole('button', { name: /创建（1 人）/ }).click()
  await expect(page.getByText('创建了群聊')).toBeVisible({ timeout: 10_000 })
}

/** 会话 id（按标题从列表查） */
async function sessionIdOf(page: Page, title: string): Promise<string> {
  const list = (await (await page.request.get('/api/sessions')).json()) as {
    sessions: Array<{ id: string; title: string }>
  }
  const s = list.sessions.find((x) => x.title === title)
  expect(s, `会话「${title}」不存在`).toBeTruthy()
  return s!.id
}

/** 幂等清理：转让回 admin（仅当 bob 为 owner）→ admin 删除会话 + 偏好复位 */
async function cleanupGroup(adminPage: Page, bobPage: Page, title: string, id?: string): Promise<void> {
  const sessionId = id ?? await sessionIdOf(adminPage, title)
  // adminId 必须用 adminPage 查（/api/users 仅 admin 可访问；bobPage 是 member）
  const adminId = await userIdOf(adminPage, ADMIN.username)
  // 转让给 admin：T2 场景 bob 为 owner → 成功；T3 场景 admin 本就是 owner → 400（容错忽略）
  await bobPage.request.post(`/api/sessions/${sessionId}/transfer`, { data: { userId: adminId } })
  await adminPage.request.patch(`/api/sessions/${sessionId}/prefs`, {
    data: { pinned: false, muted: false, archived: false, markedUnread: false },
  })
  const del = await adminPage.request.delete(`/api/sessions/${sessionId}?deleteWorkspace=false`)
  expect(del.ok()).toBeTruthy()
}

// ==========================================================================
// T1 · 私聊：引用回复 → 撤回联动 → 编辑留痕 → 仅自己删除 → typing
// ==========================================================================
test('M90-T1：引用回复 / 撤回墓碑 / 编辑留痕 / 仅自己删除 / typing 临时帧', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  try {
    await ensureFriendship(page, bobPage)
    const dmId = await ensureDirectSession(page)
    await page.reload()
    await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await openChat(page, BOB_NAME)
    await openChat(bobPage, ADMIN_NAME) // bob 先开私聊（msg 行仅渲染当前会话）

    // ---------- 1. bob 引用 admin 消息并回复（服务端权威快照，双端实时） ----------
    const origin = `M90-引用原句-${Date.now()}`
    await sendOn(page, origin)
    const originRow = messageRow(bobPage, origin) // bob 实时收到（会话订阅）
    await expect(originRow).toBeVisible({ timeout: 15_000 })
    await openMsgMenu(bobPage, originRow)
    await bobPage.getByRole('menuitem', { name: '回复', exact: true }).click()
    // 引用回复条（Composer）：字面「回复 X」（作者名由服务端投影，不钉死名字）
    const replyBar = bobPage.getByText(/回复\s/)
    await expect(replyBar).toBeVisible()
    await bobPage.getByRole('button', { name: '取消引用回复' }).click() // 验证取消入口
    await openMsgMenu(bobPage, originRow)
    await bobPage.getByRole('menuitem', { name: '回复', exact: true }).click()
    const replyText = `M90-引用回复-${Date.now()}`
    await sendOn(bobPage, replyText)
    await expect(bobPage.getByRole('button', { name: '取消引用回复' })).toHaveCount(0) // 发送后引用条清除
    const replyRowBob = messageRow(bobPage, replyText)
    await expect(replyRowBob.getByText(origin)).toBeVisible() // 引用快照：原文摘要
    await expect(replyRowBob.locator('button[title="跳到原消息"]')).toBeVisible() // 引用可回跳原消息
    // admin 侧不刷新实时看到引用回复
    const replyRowAdmin = messageRow(page, replyText)
    await expect(replyRowAdmin.getByText(origin)).toBeVisible({ timeout: 15_000 })

    // ---------- 2. 撤回原消息 → 占位 + 引用联动「原消息已撤回」 ----------
    // m79-X 先例：撤回 / 编辑 / 自删走 REST（绕开虚拟列表非末行 hover 弹层菜单不稳定），断言双端 UI 投影
    const originId = await messageIdOf(page, dmId, origin)
    const recall = await page.request.post(`/api/sessions/${dmId}/messages/${originId}/recall`)
    expect(recall.ok()).toBeTruthy()
    await expect(messageRow(page, '撤回了一条消息')).toBeVisible()
    await expect(messageRow(bobPage, '撤回了一条消息')).toBeVisible({ timeout: 15_000 })
    await expect(messageRow(bobPage, replyText).getByText('原消息已撤回')).toBeVisible()

    // ---------- 3. 编辑留痕：bob 编辑自己的回复 → admin 实时「已编辑」 ----------
    const replyId = await messageIdOf(bobPage, dmId, replyText)
    const editedText = `${replyText}-已编辑`
    const edit = await bobPage.request.patch(`/api/sessions/${dmId}/messages/${replyId}`, { data: { content: editedText } })
    expect(edit.ok()).toBeTruthy()
    await expect(messageRow(page, editedText)).toBeVisible({ timeout: 15_000 })
    await expect(messageRow(page, editedText).getByText('已编辑')).toBeVisible()

    // ---------- 4. 仅自己删除：bob 删 admin 新消息 → 本端消失 / admin 无感 / 刷新仍不可见 ----------
    const victim = `M90-仅自己删除-${Date.now()}`
    await sendOn(page, victim)
    const victimRowBob = messageRow(bobPage, victim)
    await expect(victimRowBob).toBeVisible({ timeout: 10_000 })
    const victimId = await messageIdOf(bobPage, dmId, victim)
    const hide = await bobPage.request.delete(`/api/sessions/${dmId}/messages/${victimId}?scope=self`)
    expect(hide.ok()).toBeTruthy()
    await expect(bobPage.locator('[id^="msg-"]', { hasText: victim })).toHaveCount(0, { timeout: 10_000 }) // bob 本端消失
    await expect(messageRow(page, victim)).toBeVisible() // admin 侧无感仍在
    await bobPage.reload()
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await openChat(bobPage, ADMIN_NAME)
    await expect(bobPage.locator('[id^="msg-"]', { hasText: victim })).toHaveCount(0) // 服务端持久隐藏

    // ---------- 5. typing：bob 输入 → admin 头部「E2E Bob 正在输入」→ 发消息即清除 ----------
    await sendOn(page, `M90-typing前缀-${Date.now()}`) // 确保 bob 停在私聊（boot 自动选中最近会话）
    await openChat(bobPage, ADMIN_NAME)
    // typing 走 WS：连接未 open 时 sendTyping 静默丢弃——先确认 bob 实时通道就绪
    await expect(bobPage.getByText('通知已连接')).toBeVisible({ timeout: 15_000 })
    // 指示器为 role="status" 但 aria-live 区域名计算不定，改用 [role="status"] 文本定位（ADR 0232）
    const typingBar = page.locator('[role="status"]', { hasText: '正在输入' })
    const typed = `M90-typing-${Date.now()}`
    // 慢速逐键：跨客户端 3s 节流产生多帧，指示在断言窗口内持续可见
    await composerInput(bobPage).pressSequentially(typed, { delay: 180 })
    await expect(typingBar).toContainText('正在输入', { timeout: 10_000 })
    await sendOn(bobPage, typed)
    await expect(messageRow(page, typed)).toBeVisible({ timeout: 10_000 })
    await expect(typingBar).toHaveCount(0) // turn-end 即清除
  } finally {
    await ctx.close()
  }
})

// ==========================================================================
// T2 · 偏好四字段多端同步（admin 双标签页）+ 群主转让
// ==========================================================================
test('M90-T2：置顶 / 免打扰 / 标记未读 / 归档（双标签同步）→ 群主转让', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  const groupTitle = `E2E-M90-群-${Date.now()}`
  let groupId = ''
  try {
    await ensureFriendship(page, bobPage)
    await ensureDirectSession(page)
    await page.reload()
    await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    // 先给双方建立并打开私聊（fresh 数据下保证 bob 有 chat 会话与筛选条，再建群）
    await openChat(bobPage, ADMIN_NAME)
    await createGroup(page, groupTitle)
    await openSessions(bobPage)
    await chatFilter(bobPage) // 群聊行需「聊天」筛选才可见（默认「团队」）
    await expect(sessionRow(bobPage, groupTitle)).toBeVisible({ timeout: 15_000 }) // bob 实时收到群邀请

    // admin 第二个标签页（同账号 = 「多端」）
    const tabB = await page.context().newPage()
    await tabB.goto('/')
    await expect(tabB.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })

    // ---------- 1. 置顶 + 免打扰（A 端开 → B 端偏好帧同步） ----------
    await openSessions(page)
    await chatFilter(page)
    const grpRowA = sessionRow(page, groupTitle)
    await grpRowA.hover()
    await grpRowA.getByRole('button', { name: '置顶会话' }).click()
    await expect(grpRowA.getByLabel('已置顶')).toBeVisible()
    await chatFilter(tabB)
    await expect(sessionRow(tabB, groupTitle).getByLabel('已置顶')).toBeVisible({ timeout: 10_000 })
    await grpRowA.hover()
    await grpRowA.getByRole('button', { name: '免打扰' }).click()
    await expect(grpRowA.getByLabel('免打扰', { exact: true })).toBeVisible()
    await expect(sessionRow(tabB, groupTitle).getByLabel('免打扰', { exact: true })).toBeVisible({ timeout: 10_000 })

    // ---------- 2. 真实未读 + 标记未读 + 读到自动解除 ----------
    // 双标签页都切到私聊（群会话保持关闭）；bob 打开群 → admin 双端群行出现红点
    await openChat(page, BOB_NAME)
    await openChat(tabB, BOB_NAME)
    await openChat(bobPage, groupTitle)
    await sendOn(bobPage, `M90-群未读-${Date.now()}`)
    await expect(grpRowA.locator('.badge-pop')).toBeVisible({ timeout: 15_000 })
    await expect(sessionRow(tabB, groupTitle).locator('.badge-pop')).toBeVisible({ timeout: 10_000 })
    // A 端「标记未读」（当前徽章可能已因读到清除，抬升语义以 B 端点击前的帧同步为准）
    const grpRowAB = sessionRow(page, groupTitle)
    await grpRowAB.hover()
    await grpRowAB.getByRole('button', { name: '标记未读' }).click()
    await expect(sessionRow(tabB, groupTitle).locator('.badge-pop')).toBeVisible({ timeout: 10_000 })
    // B 端点进群 → 真实阅读上报 → markedUnread 服务端自动解除 → 双端徽章清零
    // （点左侧图标区避开未读徽标行右侧操作按钮条拦截，同 openChat）
    await sessionRow(tabB, groupTitle).click({ position: { x: 8, y: 8 } })
    await expect(tabB.locator('[id^="msg-"]').last()).toBeVisible()
    await expect(sessionRow(tabB, groupTitle).locator('.badge-pop')).toHaveCount(0, { timeout: 15_000 })
    await expect(grpRowAB.locator('.badge-pop')).toHaveCount(0, { timeout: 15_000 })
    // 偏好接口确认 markedUnread 已解除（服务端权威）
    groupId = await sessionIdOf(page, groupTitle)
    await expect
      .poll(async () => {
        const l = (await (await page.request.get('/api/sessions')).json()) as {
          sessions: Array<{ id: string; prefs?: { markedUnread?: boolean } }>
        }
        return !!l.sessions.find((s) => s.id === groupId)?.prefs?.markedUnread
      }, { timeout: 10_000 })
      .toBe(false)

    // ---------- 3. 归档视图（私聊）：A 端归档 → B 端主列表消失 → 归档视图取消 ----------
    const dmRowA = sessionRow(page, BOB_NAME)
    await dmRowA.hover()
    await dmRowA.getByRole('button', { name: '归档会话' }).click()
    await expect(sessionRow(page, BOB_NAME)).toHaveCount(0, { timeout: 10_000 })
    await expect(sessionRow(tabB, BOB_NAME)).toHaveCount(0, { timeout: 10_000 })
    await tabB.getByTitle('查看归档会话').click()
    await expect(sessionRow(tabB, BOB_NAME)).toBeVisible({ timeout: 10_000 })
    const archivedDm = sessionRow(tabB, BOB_NAME)
    await archivedDm.hover()
    await archivedDm.getByRole('button', { name: '取消归档' }).click()
    await expect(sessionRow(page, BOB_NAME)).toBeVisible({ timeout: 10_000 }) // A 端未操作也复现
    await tabB.getByTitle('返回未归档会话').click()

    // ---------- 4. 群主转让（A 端 UI：Crown → 二次确认 → 徽章互换 / 治理按钮消失） ----------
    await openChat(page, groupTitle)
    await page.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    const membersDialog = page.getByRole('dialog')
    // 转让按钮仅渲染于非拥有者成员行（本群唯一可转让成员 = bob）→ 直接按 title 定位；
    // 不用 locator('div', hasText).last() 包裹（会命中不含按钮的叶子文本 div → click 空等至超时）
    await membersDialog.getByTitle('转让群主（旧群主保留可协作）').click()
    await membersDialog.getByRole('button', { name: '确认转让' }).click()
    await expect(page.getByText(new RegExp(`已将群主转让给「${BOB_NAME}」`))).toBeVisible({ timeout: 10_000 })
    // 弹窗重载：bob 升为群主段，admin 落入成员行且治理按钮消失
    await expect(membersDialog.locator('[title="转让群主（旧群主保留可协作）"]')).toHaveCount(0)
    await expect(membersDialog.locator('[title="移出成员"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    // 群内系统事件条（双端实时）
    await expect(messageRow(page, '将群主转让给')).toBeVisible({ timeout: 10_000 })
    await expect(messageRow(bobPage, '将群主转让给')).toBeVisible({ timeout: 15_000 })
    // bob 侧成员弹窗：bob 为群主（徽章投影）
    await openChat(bobPage, groupTitle)
    await bobPage.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    await expect(bobPage.getByRole('dialog').getByText('群主', { exact: true }).first()).toBeVisible({ timeout: 10_000 })
    await bobPage.keyboard.press('Escape')
    // 转让后面板：admin 视角 bob 行不再有「转让群主」（非 owner）
    await page.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    await expect(page.getByRole('dialog').locator('[title="转让群主（旧群主保留可协作）"]')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await tabB.close()
  } finally {
    // 幂等清理：转让回 admin → admin 删除群（bob 已是新 owner，先转回；未建群则跳过）
    try {
      if (groupId) await cleanupGroup(page, bobPage, groupTitle, groupId)
    } finally {
      await ctx.close()
    }
  }
})

// ==========================================================================
// T3 · 搜索筛选（我发的 / 含附件 / 时间范围）+ 命中直达 + 撤回不可见
// ==========================================================================
test('M90-T3：搜索筛选 / 命中直达 / 撤回消息搜索排除', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  const groupTitle = `E2E-M90-搜索-${Date.now()}`
  try {
    await ensureFriendship(page, bobPage)
    await ensureDirectSession(page)
    await page.reload()
    await expect(page.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await openChat(bobPage, ADMIN_NAME) // 先给 bob 建立并打开私聊（保证 chat 筛选条存在）
    await createGroup(page, groupTitle)
    await openSessions(bobPage)
    await chatFilter(bobPage) // 群聊行需「聊天」筛选才可见
    await expect(sessionRow(bobPage, groupTitle)).toBeVisible({ timeout: 15_000 })

    const kw = `M90检索${Date.now()}`
    // admin 文本消息
    await openChat(page, groupTitle)
    await sendOn(page, `${kw} admin纯文本`)
    // bob 带附件消息（附件列非空 → hasAttachment 命中）
    await openChat(bobPage, groupTitle)
    await bobPage.locator('input[type="file"]').setInputFiles([
      { name: `e90-${Date.now()}.txt`, mimeType: 'text/plain', buffer: Buffer.from('m90 e2e attachment') },
    ])
    const tray = bobPage.getByRole('list', { name: '待发送附件' })
    await expect(tray).toBeVisible()
    const inputBob = composerInput(bobPage)
    await inputBob.fill(`${kw} bob附件条`)
    await expect(inputBob).toHaveValue(`${kw} bob附件条`)
    const sendBtnBob = bobPage.getByRole('button', { name: '发送' })
    await expect(sendBtnBob).toBeEnabled({ timeout: 15_000 }) // 上传完成后发送解除禁用（m33 先例）
    await sendBtnBob.click()
    await expect(tray).toBeHidden()
    // admin 撤回消息（搜索应排除）
    const recalledKw = `${kw} 被撤回段`
    await sendOn(page, recalledKw)
    await openMsgMenu(page, messageRow(page, recalledKw))
    await page.getByRole('menuitem', { name: '撤回' }).click()
    await page.getByRole('menuitem', { name: '确认撤回？' }).click()
    await expect(messageRow(page, '撤回了一条消息')).toBeVisible()

    // ---------- 搜索：关键词命中双方 ----------
    await openSessions(page)
    const search = page.getByPlaceholder('搜索全部会话消息…')
    await search.fill(kw)
    const hits = page.getByRole('button').filter({ hasText: kw })
    await expect(hits.filter({ hasText: 'admin纯文本' })).toBeVisible({ timeout: 15_000 })
    await expect(hits.filter({ hasText: 'bob附件条' })).toBeVisible({ timeout: 10_000 })
    await expect(hits.filter({ hasText: '被撤回段' })).toHaveCount(0) // 撤回消息搜索不可见（ADR 0233）

    // ---------- 「我发的」：排除 bob 命中 ----------
    const filterBar = page.getByRole('button', { name: '我发的', exact: true })
    await filterBar.click()
    await expect(filterBar).toHaveAttribute('aria-pressed', 'true')
    await expect(hits.filter({ hasText: 'admin纯文本' })).toBeVisible({ timeout: 10_000 })
    await expect(hits.filter({ hasText: 'bob附件条' })).toHaveCount(0)

    // ---------- 「含附件」：只剩 bob 的附件条（admin 视角仍可见他人消息） ----------
    await filterBar.click() // 取消我发的
    await page.getByRole('button', { name: '含附件', exact: true }).click()
    await expect(hits.filter({ hasText: 'bob附件条' })).toBeVisible({ timeout: 10_000 })
    await expect(hits.filter({ hasText: 'admin纯文本' })).toHaveCount(0)
    await page.getByRole('button', { name: '重置' }).click()
    // bob 附件条在「含附件」下被 mine 排除、重置后复现——作为刷新完成信号（避免旧结果竞态）
    await expect(hits.filter({ hasText: 'bob附件条' })).toBeVisible({ timeout: 10_000 })
    await expect(hits.filter({ hasText: 'admin纯文本' })).toBeVisible()

    // ---------- 时间范围：今天（本地 0 点起）命中在列 ----------
    await page.getByTitle('时间范围').selectOption('today')
    await expect(hits.filter({ hasText: 'admin纯文本' })).toBeVisible({ timeout: 10_000 })
    await page.getByTitle('时间范围').selectOption('all')

    // ---------- 命中直达：点命中→打开群 + 定位到该条消息（跨页 historyMode「回到最新」由 store 层单测覆盖） ----------
    await hits.filter({ hasText: 'admin纯文本' }).click()
    await expect(sessionRow(page, groupTitle)).toHaveClass(/border-primary/, { timeout: 10_000 })
    await expect(messageRow(page, `${kw} admin纯文本`)).toBeVisible({ timeout: 10_000 })
  } finally {
    try {
      const existing = (await (await page.request.get('/api/sessions')).json()) as {
        sessions: Array<{ title: string }>
      }
      if (existing.sessions.some((s) => s.title === groupTitle)) await cleanupGroup(page, bobPage, groupTitle)
    } finally {
      await ctx.close()
    }
  }
})
