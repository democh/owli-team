/**
 * E2E · M79 社交协作（auth 实例，默认 8790 / data/e2e-auth；幂等可重跑）：
 * 1) 好友全链（UI）：联系人页签搜索加好友 → 对方请求区「接受」→ 双方好友列表实时到位（无需刷新）；
 * 2) 私聊（UI）：好友行「发起私聊」→ 对端命名会话 → 发消息 → 对端列表实时出现 + 未读徽章；
 * 3) 群聊（UI）：新建群聊（好友多选）→ 群会话发消息 → 对端实时（不刷新）；
 * 4) 邀请实时化（M57 缺口修复）：共享弹窗邀请 → 被邀请人不刷新即见会话；@真人提及 chips；
 * 5) 触发策略：切「仅点名唤起」→ 无 @ 消息零引擎（消息数仅 +1，无 agent 回合追加）。
 * 5b) M79-O：新建会话直接拉真人（好友多选一步邀请 → 纯真人自动「仅点名唤起」→ 对方不刷新实时收到）。
 * 清理：群聊 / 团队会话删除（deleteWorkspace=false）；好友与私聊幂等复用。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'

/** 输入框定位（M79-J：chat 形态 placeholder 与 team 不同——用双态正则兼容） */
const composerInput = (page: Page) => page.getByPlaceholder(/发消息…（@ 可点名|输入消息，@ 召唤成员/)

/** 发送（带「值已落位」断言；避免与切会话的输入重置竞态） */
async function sendOn(page: Page, text: string): Promise<void> {
  const input = composerInput(page)
  await input.fill(text)
  await expect(input).toHaveValue(text)
  await page.getByRole('button', { name: '发送' }).click()
}

/** 聊天区消息断言（限定消息气泡；避免与会话预览 / 通知 toast 的同文命中） */
const messageBubble = (page: Page, text: string) => page.locator('[id^="msg-"]', { hasText: text }).first()

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

/** 切回「会话」页签（联系人面板与会话列表互斥渲染） */
const openSessions = async (page: Page): Promise<void> => {
  await page.getByRole('button', { name: '会话', exact: true }).click()
}

/** 会话行定位（左栏会话列表；标题元素精确匹配——避免命中其他行预览里的同名字符串） */
const sessionRow = (page: Page, title: string) =>
  page.locator('.group').filter({ has: page.getByText(title, { exact: true }) }).first()

test('M79：好友 → 私聊 → 群聊 → 邀请实时化 → 触发策略', async ({ page, browser }) => {
  await loginOrSetup(page)
  const initialPassword = await ensureBobInitialPassword(page)
  const ctx = await browser.newContext()
  const bobPage = await loginBob(ctx, initialPassword)
  try {
    // ---------- 1. 好友全链（UI 发起 + UI 接受；实时到位） ----------
    const friends = (await (await page.request.get('/api/friends')).json()) as { friends: Array<{ username: string }> }
    const alreadyFriends = friends.friends.some((f) => f.username === BOB.username)
    if (!alreadyFriends) {
      const reqs = (await (await page.request.get('/api/friends/requests')).json()) as {
        outgoing: Array<{ user: { username: string } }>
      }
      if (!reqs.outgoing.some((r) => r.user.username === BOB.username)) {
        // admin：联系人页签 → 搜索 → 「加好友」（核心流程走 UI）
        await openContacts(page)
        await page.getByPlaceholder('搜索用户（用户名 / 昵称）').fill(BOB.username)
        await page.getByRole('button', { name: /加好友/ }).first().click()
        await expect(page.getByText(`已向「${BOB_NAME}」发送好友申请`)).toBeVisible({ timeout: 10_000 })
        // 首跑路径修复：清空搜索词，恢复好友列表视图（残留搜索词会使搜索结果视图遮蔽好友行，
        // 后续「好友列表出现 BOB」断言落空）
        await page.getByRole('button', { name: '清空搜索' }).click()
      }
      // bob：联系人页签 → 请求区「接受」
      await openContacts(bobPage)
      await bobPage.getByRole('button', { name: '接受' }).first().click()
    }
    // admin 侧实时：好友列表出现 BOB（friends-changed → load；不刷新）
    await openContacts(page)
    await expect(sessionRow(page, BOB_NAME)).toBeVisible({ timeout: 10_000 })
    // bob 侧好友列表同样到位；随后切回会话页签（后续断言基于会话列表）
    await openContacts(bobPage)
    await expect(sessionRow(bobPage, ADMIN_NAME)).toBeVisible({ timeout: 10_000 })
    await openSessions(bobPage)

    // ---------- 1b. M79-I：通知中心（持久收件箱可复看 + 点击即读 + 跳转） ----------
    await page.getByTitle(/通知中心/).click()
    // 首跑路径修复：接受事件实时到达时，「已同意」toast 与面板条目同文本并存——限定面板条目（role=button）
    const inboxItem = page.getByRole('button', { name: new RegExp(`${BOB_NAME} 已同意你的好友申请`) })
    await expect(inboxItem).toBeVisible({ timeout: 10_000 })
    await inboxItem.click()
    // 点击后：面板关闭（单项已读上报由用例外的服务端持久化保证）
    await expect(page.getByText('全部已读')).toHaveCount(0)

    // ---------- 2. 私聊（UI）：好友行发起 → 对端命名 → 消息实时 + 未读徽章 ----------
    const bobRow = sessionRow(page, BOB_NAME)
    await bobRow.hover()
    await page.getByTitle('发起私聊').first().click()
    // 回会话页签（DM 行在列表可见）→ 行激活态（border-primary）= currentId 已提交到 DM 的确定性信号
    // （此前用会话头部副标题 / 系统事件条作门控均不足：副标题任一会话都可命中，事件条会因历史翻页不在首屏）
    await openSessions(page)
    // M79-F 修订：筛选默认「团队」——私聊行需切「聊天」筛选才可见
    await page.getByRole('button', { name: '聊天', exact: true }).click()
    await expect(sessionRow(page, BOB_NAME)).toHaveClass(/border-primary/, { timeout: 10_000 })
    // M79-P：纯人聊天隐藏 AI 状态条（范式 chips）；随后团队会话处有保留正例
    await expect(page.getByRole('button', { name: '执行', exact: true })).toHaveCount(0)
    // M79-S：右栏对纯人聊天隐藏（显隐入口一并消失）
    await expect(page.getByTitle(/右栏（⌘B）/)).toHaveCount(0)
    // M79-AA：纯人聊天隐藏「资源」入口（资源绑定服务于 Agent 工具）
    await expect(page.getByRole('button', { name: '资源', exact: true })).toHaveCount(0)
    await sendOn(page, '嗨，这是私聊联调消息')
    // 对端实时：DM 行在列表（首跑经 inbox 实时到达；重跑幂等复用）+ bob 应用不刷新打开后消息可见。
    // 未读徽章与多端 read-state 对账由 m79-realtime.spec.ts 专项覆盖（避免「开机自动选中最近会话」干扰）。
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click() // 私聊行需「聊天」筛选可见
    await expect(sessionRow(bobPage, ADMIN_NAME)).toBeVisible({ timeout: 10_000 })
    await sessionRow(bobPage, ADMIN_NAME).click()
    await expect(messageBubble(bobPage, '嗨，这是私聊联调消息')).toBeVisible({ timeout: 10_000 })

    // ---------- 3. 群聊（UI）：新建（好友多选）→ 群消息实时 ----------
    const groupTitle = `E2E-M79-群-${Date.now()}`
    await openContacts(page)
    await page.getByRole('button', { name: /新建群聊/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByPlaceholder('群聊名称（留空 = 自动命名）').fill(groupTitle)
    await dialog.getByRole('button', { name: new RegExp(BOB_NAME) }).click()
    await dialog.getByRole('button', { name: /创建（1 人）/ }).click()
    await expect(page.getByText(groupTitle).first()).toBeVisible({ timeout: 10_000 })
    // 聊天区系统事件条为「群会话已打开」门控
    await expect(page.getByText('创建了群聊')).toBeVisible({ timeout: 10_000 })
    await sendOn(page, '群里同步一下进度')
    // 对端实时（不刷新）：群会话出现（inbox session-invite → 列表刷新）
    await expect(sessionRow(bobPage, groupTitle)).toBeVisible({ timeout: 10_000 })

    // ---------- 3b. M79-F/G：群「成员」弹窗 + 同会话在线点 ----------
    // bob 重连（引用计数归零后重连 → 确定性 presence online 事件；可见域 = 好友 ∪ 同会话成员）
    await bobPage.reload()
    await expect(bobPage.getByRole('button', { name: '工作台' })).toBeVisible({ timeout: 30_000 })
    await page.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    const membersDialog = page.getByRole('dialog')
    await expect(membersDialog.getByText(ADMIN_NAME, { exact: true })).toBeVisible()
    await expect(membersDialog.getByText(BOB_NAME, { exact: true }).first()).toBeVisible()
    await expect(membersDialog.locator('[aria-label="在线"]').first()).toBeVisible({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    // M79-AA：纯人群聊（无 agent 编制）隐藏「资源」入口（与私聊同口径；team 会话处有保留正例）
    await expect(page.getByRole('button', { name: '资源', exact: true })).toHaveCount(0)

    // ---------- 4. 邀请实时化 + @真人提及 ----------
    const teamTitle = `E2E-M79-团队-${Date.now()}`
    const created = await page.request.post('/api/sessions', { data: { participantIds: [], title: teamTitle } })
    expect(created.ok()).toBeTruthy()
    const teamId = ((await created.json()) as { session: { id: string } }).session.id
    await page.reload()
    await page.getByText(teamTitle).first().click()
    await page.getByRole('button', { name: '共享', exact: true }).click()
    await page.getByPlaceholder('用户名（由管理员在「用户管理」创建）').fill(BOB.username)
    await page.getByRole('button', { name: '邀请' }).click()
    await expect(page.getByText(`@${BOB.username}`)).toBeVisible()
    await page.keyboard.press('Escape')
    // 被邀请人不刷新即见会话（M57「刷新才发现」缺口修复）
    await expect(sessionRow(bobPage, teamTitle)).toBeVisible({ timeout: 10_000 })
    // @真人：提及 chips + 内容可见（人类定向 → 零引擎，不触发 PRS）
    await sendOn(page, `@${BOB_NAME} 请帮忙确认这个方案`)
    await sessionRow(bobPage, teamTitle).click()
    await expect(messageBubble(bobPage, '请帮忙确认这个方案')).toBeVisible({ timeout: 10_000 })
    await expect(bobPage.getByText('提及')).toBeVisible()

    // ---------- 4b. M79-F：会话筛选 chip（默认第一个「团队」；点「聊天」过滤；再点同类取消恢复全部） ----------
    // 本步前 admin 已 reload → 默认「团队」选中：团队行可见、群聊行被过滤
    await expect(sessionRow(page, teamTitle)).toBeVisible()
    await expect(sessionRow(page, groupTitle)).toHaveCount(0)
    await page.getByRole('button', { name: '聊天', exact: true }).click()
    await expect(sessionRow(page, groupTitle)).toBeVisible()
    await expect(sessionRow(page, teamTitle)).toHaveCount(0)
    await page.getByRole('button', { name: '聊天', exact: true }).click()
    await expect(sessionRow(page, teamTitle)).toBeVisible()

    // ---------- 4c. M79-K：@agent → 收尾交还真人（waiting 闭环：持球徽章 → 点名提示 → 回复清除） ----------
    // 团队会话加一名 agent（owner 编制权限 ✓）+ 剧本标记驱动 mock 行首 @E2E Bob（指定交还）
    const addAgent = await page.request.post(`/api/sessions/${teamId}/members`, { data: { agentIds: ['pm'] } })
    expect(addAgent.ok()).toBeTruthy()
    await page.reload()
    await sessionRow(page, teamTitle).click()
    await expect(sessionRow(page, teamTitle)).toHaveClass(/border-primary/, { timeout: 10_000 })
    // M79-P 正例：team 会话保留 AI 状态条（范式 chips）；M79-S 正例：右栏入口在位；
    // M79-AA 正例：team 会话保留「资源」入口（非人物会话，AI 语义面完整）
    await expect(page.getByRole('button', { name: '执行', exact: true })).toBeVisible()
    await expect(page.getByTitle(/右栏（⌘B）/)).toBeVisible()
    await expect(page.getByRole('button', { name: '资源', exact: true })).toBeVisible()
    await sendOn(page, `@费利 请推进方案并交回 [[handoff:${BOB_NAME}]]`)
    // 运行收束 → waiting_on=[bob]：admin 头部持球徽章
    await expect(page.getByText(`等待 ${BOB_NAME} 回复`)).toBeVisible({ timeout: 30_000 })
    // M79-AA：交接条显示具体真人（不再是泛称「你的回合」）
    await expect(page.locator('[data-handoff-targets]').last()).toContainText(BOB_NAME)
    // bob 侧：打开会话 → 被点名提示条 → 回复 → 徽章清除（集合差）+ 本轮 agent 回合收束
    await sessionRow(bobPage, teamTitle).click()
    await expect(sessionRow(bobPage, teamTitle)).toHaveClass(/border-primary/, { timeout: 10_000 })
    await expect(bobPage.getByText('你在本会话被点名')).toBeVisible({ timeout: 15_000 })
    await sendOn(bobPage, '按 B 口径推进')
    await expect(page.getByText(`等待 ${BOB_NAME} 回复`)).toHaveCount(0, { timeout: 15_000 })
    // 等待 bob 回复触发的 agent 回合完全收束（「停止」出现 → 消失双段；「你的回合」历史胶囊会立即命中，不可用）
    await expect(bobPage.getByRole('button', { name: '停止' })).toBeVisible({ timeout: 15_000 })
    await expect(bobPage.getByRole('button', { name: '停止' })).toHaveCount(0, { timeout: 90_000 })
    // M79-U：bob 触发的回合收尾经 WS 补投到 admin（同会话 upsert；此前需刷新才可见）
    await expect(messageBubble(page, '我这边告一段落')).toBeVisible({ timeout: 15_000 })
    // M79-AA 补漏：正文 @用户 泛称 chip 就地展开为具体定向人（与交接条同源 humanMentions）
    const closeoutBubble = page.locator('[id^="msg-"]', { hasText: '我这边告一段落' }).last()
    await expect(closeoutBubble.locator('[data-mention="用户"]')).toContainText(BOB_NAME)

    // ---------- 4d. M79-V：run 流断流自愈（拦截一次 → 自动重连/刷新兜底，无需刷新） ----------
    let streamHits = 0
    await page.route('**/api/runs/*/stream', (route) => {
      streamHits++
      return streamHits === 1 ? route.abort('failed') : route.continue()
    })
    await sendOn(page, '@费利 断流自愈验证')
    // 首次流被中止 → 3s 退避重附着（run 已结束则 404 刷新兜底）——两种路径均以消息补齐收束。
    // 收束判据（对话框为虚拟列表：DOM 只挂载视口 ± overscan 行，「+2 计数」不成立，改锚点断言）：
    // ① 用户气泡在列（内容锚点）；② 列表尾行 = 断流后补齐的 agent 回复（位置锚点）
    await expect(messageBubble(page, '断流自愈验证')).toBeVisible({ timeout: 90_000 })
    await expect(page.locator('[id^="msg-"]').last()).toContainText('我这边告一段落', { timeout: 90_000 })
    expect(streamHits).toBeGreaterThanOrEqual(1) // 中止确实发生
    await expect(page.getByText('已停止重连')).toHaveCount(0) // 自愈成功：无打扰提示
    await page.unroute('**/api/runs/*/stream')

    // ---------- 4e. M79-W：群聊式全同步（触发型消息广播 + 双向实时 + 跨会话未读） ----------
    // admin 发触发消息 → bob 实时看到 admin 气泡（此前触发型人类消息只走 SSE 单播，需刷新）
    await sendOn(page, '@费利 同步验证一')
    await expect(messageBubble(bobPage, '同步验证一')).toBeVisible({ timeout: 15_000 })
    // bob 侧尾行 = 补齐的 agent 回复（虚拟列表计数不可用，位置锚点；前置：上一步气泡已挂载）
    await expect(bobPage.locator('[id^="msg-"]').last()).toContainText('我这边告一段落', { timeout: 90_000 })
    // bob 发触发消息 → admin 实时看到 bob 气泡 + agent 回复（此前 B 触发的回合 A 需刷新）
    await sendOn(bobPage, '@费利 同步验证二')
    await expect(messageBubble(page, '同步验证二')).toBeVisible({ timeout: 15_000 })
    // admin 侧尾行 = 补齐的 agent 回复（虚拟列表计数不可用，位置锚点；前置：上一步气泡已挂载）
    await expect(page.locator('[id^="msg-"]').last()).toContainText('我这边告一段落', { timeout: 90_000 })
    // 跨会话未读：admin 切到群聊 → bob 发消息 → 团队会话行未读徽标 + 轻提示（不刷新）
    await page.getByRole('button', { name: '聊天', exact: true }).click() // 群聊行需「聊天」筛选可见
    await sessionRow(page, groupTitle).click()
    await expect(sessionRow(page, groupTitle)).toHaveClass(/border-primary/, { timeout: 10_000 })
    await sendOn(bobPage, '跨会话同步验证')
    await page.getByRole('button', { name: '团队', exact: true }).click() // 切回「团队」观察团队行未读徽标
    await expect(sessionRow(page, teamTitle).locator('.badge-pop')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/：跨会话同步验证/).first()).toBeVisible({ timeout: 15_000 })
    // 切回团队会话：消息可查、徽标清零（无需刷新浏览器）
    await sessionRow(page, teamTitle).click()
    await expect(messageBubble(page, '跨会话同步验证')).toBeVisible({ timeout: 15_000 })
    await expect(sessionRow(page, teamTitle).locator('.badge-pop')).toHaveCount(0)
    // 等待本步骤触发的 run 全部收束（服务端权威；避免迟到消息污染 step 5 的零引擎计数）
    await expect
      .poll(
        async () => {
          const res = (await (await page.request.get('/api/runs/active')).json()) as {
            runs: Array<{ sessionId: string }>
          }
          return res.runs.some((r) => r.sessionId === teamId)
        },
        { timeout: 90_000 },
      )
      .toBe(false)

    // ---------- 4f. M79-X：消息编辑 / 删除全同步（不刷新） ----------
    const teamMsgs = ((await (await page.request.get(`/api/sessions/${teamId}`)).json()) as {
      messages: Array<{ id: string; role: string; content: string }>
    }).messages
    const editTarget = [...teamMsgs].reverse().find((m) => m.role === 'user' && m.content.includes('同步验证二'))
    expect(editTarget, '未找到目标消息').toBeTruthy()
    const edited = await bobPage.request.patch(`/api/sessions/${teamId}/messages/${editTarget!.id}`, {
      data: { content: '同步验证二（已编辑）' },
    })
    expect(edited.ok()).toBeTruthy()
    await expect(messageBubble(page, '同步验证二（已编辑）')).toBeVisible({ timeout: 15_000 })
    // bob 删除该消息 → admin 侧气泡实时消失
    const removed = await bobPage.request.delete(`/api/sessions/${teamId}/messages/${editTarget!.id}`)
    expect(removed.ok()).toBeTruthy()
    await expect(page.locator('[id^="msg-"]', { hasText: '同步验证二' })).toHaveCount(0, { timeout: 15_000 })

    // ---------- 4g. M79-AA 群管理补全：成员退群（留痕）→ 群主解散（列表即时移除） ----------
    // bob（成员）打开群聊 → 头部「成员」→ 退出群聊（二次确认）→ 列表即时移除
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click() // 群聊行需「聊天」筛选可见
    await sessionRow(bobPage, groupTitle).click()
    await expect(bobPage.getByText('创建了群聊')).toBeVisible({ timeout: 10_000 })
    await bobPage.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    const bobMembersDialog = bobPage.getByRole('dialog')
    await bobMembersDialog.getByRole('button', { name: '退出群聊' }).click()
    await bobMembersDialog.getByRole('button', { name: '确认退出' }).click()
    await expect(sessionRow(bobPage, groupTitle)).toHaveCount(0, { timeout: 15_000 })
    await bobPage.getByRole('button', { name: '聊天', exact: true }).click() // 取消筛选 → 恢复全部（后续团队行断言）
    // 群内留痕：admin 侧实时可见系统事件条（turn-end 广播，不刷新；限定消息区避免命中列表预览）
    await page.getByRole('button', { name: '聊天', exact: true }).click() // 群聊行需「聊天」筛选可见
    await sessionRow(page, groupTitle).click()
    await expect(page.locator('[id^="msg-"]', { hasText: `${BOB_NAME} 退出了群聊` })).toBeVisible({ timeout: 15_000 })
    // 群主解散（二次确认）→ 本端列表即时移除
    await page.getByTitle('会话成员：名单查看（群主可移出成员 / 邀请好友）').click()
    const adminMembersDialog = page.getByRole('dialog')
    await adminMembersDialog.getByRole('button', { name: '解散群聊' }).click()
    await adminMembersDialog.getByRole('button', { name: '确认解散' }).click()
    await expect(sessionRow(page, groupTitle)).toHaveCount(0, { timeout: 15_000 })
    // 回到团队会话（步骤 5 的触发策略断言基于 team 上下文；先切回「团队」筛选）
    await page.getByRole('button', { name: '团队', exact: true }).click()
    await sessionRow(page, teamTitle).click()
    await expect(sessionRow(page, teamTitle)).toHaveClass(/border-primary/, { timeout: 10_000 })

    // ---------- 5. 触发策略：切「仅点名唤起」→ 无 @ 消息零引擎 ----------
    await page.getByRole('button', { name: /AI 自动应答/ }).click()
    await expect(page.getByRole('button', { name: /仅点名唤起/ })).toBeVisible()
    const before = ((await (await page.request.get(`/api/sessions/${teamId}`)).json()) as {
      messages: unknown[]
    }).messages.length
    await sendOn(page, '这条是静默协作消息（无 @）')
    await page.waitForTimeout(4000) // mock 引擎触发会在 ~4.8s 内追加 agent 消息；零引擎则仅 +1
    const after = ((await (await page.request.get(`/api/sessions/${teamId}`)).json()) as {
      messages: unknown[]
    }).messages.length
    expect(after).toBe(before + 1)

    // ---------- 5b. M79-O：新建会话直接拉真人（一步邀请 + 纯真人自动静默） ----------
    const coTitle = `E2E-M79-真人共建-${Date.now()}`
    await page.getByTitle('新建会话').click()
    const builder = page.getByRole('dialog')
    await builder.getByTitle(`邀请 ${BOB_NAME} 加入`).click()
    await expect(builder.getByText('已选 1 位')).toBeVisible()
    await builder.getByPlaceholder('会话标题（可选，默认自动生成）').fill(coTitle)
    await builder.getByRole('button', { name: /创建并进入（1 位成员）/ }).click()
    // 创建即进入：纯真人组合自动置「仅点名唤起」（防未 @ 消息触发 AI）
    await expect(page.getByRole('button', { name: /仅点名唤起/ })).toBeVisible({ timeout: 10_000 })
    // bob 侧不刷新实时收到邀请（inbox → 列表）
    await expect(sessionRow(bobPage, coTitle)).toBeVisible({ timeout: 10_000 })

    // ---------- 5c. M79-Q：图片头像（bob 上传 → 预览生效 → admin 联系人跨用户可见） ----------
    await bobPage.getByRole('button', { name: '设置' }).click()
    await bobPage.getByRole('button', { name: '图片', exact: true }).click()
    await bobPage
      .locator('input[type="file"][accept*="image/png"]')
      .setInputFiles({
        name: 'avatar.png',
        mimeType: 'image/png',
        // 1×1 透明 PNG（真实魔数；服务端按魔数校验）
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
          'base64',
        ),
      })
    // 预览行出现服务端头像 URL（裁剪上传成功）
    await expect(bobPage.locator('img[src*="/api/avatars/"]').first()).toBeVisible({ timeout: 15_000 })
    // admin 侧：联系人列表出现 bob 图片头像（跨用户投影）
    await openContacts(page)
    await expect(page.locator('img[src*="/api/avatars/"]').first()).toBeVisible({ timeout: 10_000 })

    // ---------- 6. 清理（幂等）：删除团队 / 共建 / 群聊会话 ----------
    // M79-X：会话删除全同步——admin 删除团队会话 → bob 侧列表实时移除（不刷新）
    await bobPage.getByRole('button', { name: '工作台' }).click() // 5c 后 bob 停留在设置页，先回工作台（侧栏可见）
    await expect(sessionRow(bobPage, teamTitle)).toBeVisible({ timeout: 10_000 })
    await page.request.delete(`/api/sessions/${teamId}?deleteWorkspace=false`)
    await expect(sessionRow(bobPage, teamTitle)).toHaveCount(0, { timeout: 15_000 })
    const list = (await (await page.request.get('/api/sessions')).json()) as {
      sessions: Array<{ id: string; title: string }>
    }
    const group = list.sessions.find((s) => s.title === groupTitle)
    if (group) await page.request.delete(`/api/sessions/${group.id}?deleteWorkspace=false`)
    const co = list.sessions.find((s) => s.title === coTitle)
    if (co) await page.request.delete(`/api/sessions/${co.id}?deleteWorkspace=false`)
  } finally {
    await ctx.close()
  }
})
